// Server-only: access to Cloudflare bindings (the CONTENT KV namespace, the MEDIA R2 bucket) and secrets.
//
// How the Worker `env` reaches application code depends on the runtime and the framework
// build, so we look in several places and take the first source that has the value:
//   1. the env passed to our server entry's fetch()     (registered by src/server.ts)
//   2. request.runtime.cloudflare.env                    (registered by src/server.ts)
//   3. globalThis.__env__                                (set by some Nitro presets)
//   4. the `cloudflare:workers` module                   (Workers runtime only)
//   5. process.env                                       (local dev)

/**
 * The slice of a KV namespace we use (Cloudflare's KVNamespace satisfies it). Text is all the content store needs;
 * the binary methods, metadata and list are used only for the fallback copy of uploaded images (see ./media.ts),
 * and are optional so a minimal stand-in (e.g. in a test) still works for everything else.
 */
export interface KVLike {
  get(key: string, type?: "text" | "json" | "arrayBuffer" | "stream"): Promise<unknown>;
  put(
    key: string,
    value: string | ArrayBuffer | Uint8Array,
    options?: { expirationTtl?: number; metadata?: unknown },
  ): Promise<void>;
  delete(key: string): Promise<void>;
  getWithMetadata?(key: string, type: "stream" | "arrayBuffer"): Promise<{ value: unknown; metadata: unknown }>;
  list?(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    keys: Array<{ name: string; metadata?: unknown }>;
    list_complete: boolean;
    cursor?: string;
  }>;
}

/** The slice of an R2 bucket binding we use (Cloudflare's R2Bucket satisfies it). */
export interface R2ObjectLike {
  key: string;
  size: number;
  httpEtag: string;
  uploaded: Date;
  httpMetadata?: { contentType?: string };
}
export interface R2BodyLike extends R2ObjectLike {
  body: ReadableStream;
}
export interface R2Like {
  put(
    key: string,
    value: ArrayBuffer | Uint8Array,
    options?: { httpMetadata?: { contentType?: string; cacheControl?: string }; customMetadata?: Record<string, string> },
  ): Promise<unknown>;
  get(key: string): Promise<R2BodyLike | null>;
  head(key: string): Promise<R2ObjectLike | null>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{ objects: R2ObjectLike[]; truncated: boolean; cursor?: string }>;
}

type Bag = Record<string, unknown>;
type Slots = { arg?: Bag; request?: Bag };

const g = globalThis as unknown as Record<string, unknown>;
const SLOTS_KEY = "__studio_env_slots__";

function slots(): Slots {
  const existing = g[SLOTS_KEY] as Slots | undefined;
  if (existing) return existing;
  const fresh: Slots = {};
  g[SLOTS_KEY] = fresh;
  return fresh;
}

function asBag(value: unknown): Bag | undefined {
  return typeof value === "object" && value !== null ? (value as Bag) : undefined;
}

/** Call at the start of every request from the server entry. */
export function registerRuntime(request: Request, env: unknown): void {
  const s = slots();
  const arg = asBag(env);
  if (arg) s.arg = arg;
  const runtime = asBag((request as unknown as { runtime?: unknown }).runtime);
  const requestEnv = asBag(asBag(runtime?.["cloudflare"])?.["env"]);
  if (requestEnv) s.request = requestEnv;
}

let workersEnv: Promise<Bag | undefined> | undefined;
function loadWorkersEnv(): Promise<Bag | undefined> {
  workersEnv ??= (async () => {
    try {
      // Built at runtime so bundlers leave it alone; it only resolves inside workerd.
      const specifier = "cloudflare:" + "workers";
      const mod = (await import(/* @vite-ignore */ specifier)) as { env?: unknown };
      return asBag(mod.env);
    } catch {
      return undefined;
    }
  })();
  return workersEnv;
}

async function bags(): Promise<Bag[]> {
  const s = slots();
  const out: Bag[] = [];
  if (s.arg) out.push(s.arg);
  if (s.request) out.push(s.request);
  const nitro = asBag(g["__env__"]);
  if (nitro) out.push(nitro);
  const wk = await loadWorkersEnv();
  if (wk) out.push(wk);
  const proc = asBag(asBag(g["process"])?.["env"]);
  if (proc) out.push(proc);
  return out;
}

async function getBinding(name: string): Promise<unknown> {
  for (const bag of await bags()) {
    const value = bag[name];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function isKV(value: unknown): value is KVLike {
  const v = asBag(value);
  return !!v && typeof v["get"] === "function" && typeof v["put"] === "function" && typeof v["delete"] === "function";
}

export async function getKV(): Promise<KVLike | null> {
  const value = await getBinding("CONTENT");
  return isKV(value) ? value : null;
}

export async function getSecret(name: string): Promise<string | undefined> {
  const value = await getBinding(name);
  return typeof value === "string" ? value : undefined;
}

function isR2(value: unknown): value is R2Like {
  const v = asBag(value);
  return (
    !!v &&
    typeof v["get"] === "function" &&
    typeof v["put"] === "function" &&
    typeof v["head"] === "function" &&
    typeof v["delete"] === "function" &&
    typeof v["list"] === "function"
  );
}

/** The MEDIA R2 bucket binding, or null when this deployment has none. */
export async function getR2(): Promise<R2Like | null> {
  const value = await getBinding("MEDIA");
  return isR2(value) ? value : null;
}
