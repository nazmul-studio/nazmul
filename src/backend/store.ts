// Server-only: persistence for published content, revisions and login rate limiting (KV).
import { initialContent, type PortfolioContent } from "@/lib/content-model";
import { cleanNote, parseContent } from "@/lib/content-schema";
import { SESSION_TTL, type SessionData } from "./auth";
import { getKV, type KVLike } from "./env";

/** `note` is the owner's one-line description of what that version changed (empty if none was given). */
export type ContentRecord = { version: number; updatedAt: string; note: string; content: PortfolioContent };
export type Revision = ContentRecord;

const CONTENT_KEY = "content:v1";
const REVISIONS_KEY = "content:revisions";
export const MAX_REVISIONS = 10;
export const MAX_FAILURES = 5;
export const FAILURE_WINDOW = 900; // seconds

/** An in-memory KV for local development. Mirrors the namespace API the app uses, including binary values. */
export function createMemoryKV(): KVLike {
  type Entry = { v: string | Uint8Array; exp: number; metadata?: unknown };
  const m = new Map<string, Entry>();
  const live = (key: string): Entry | null => {
    const e = m.get(key);
    if (!e) return null;
    if (e.exp && e.exp < Date.now()) {
      m.delete(key);
      return null;
    }
    return e;
  };
  const bytesOf = (v: string | Uint8Array) => (typeof v === "string" ? new TextEncoder().encode(v) : v);
  const read = (e: Entry, type: string | undefined): unknown => {
    if (type === "stream") return new Blob([bytesOf(e.v) as unknown as BlobPart]).stream();
    if (type === "arrayBuffer") return bytesOf(e.v).slice().buffer;
    const text = typeof e.v === "string" ? e.v : new TextDecoder().decode(e.v);
    return type === "json" ? JSON.parse(text) : text;
  };
  return {
    async get(key, type) {
      const e = live(key);
      return e ? read(e, type) : null;
    },
    async put(key, value, options) {
      const v = typeof value === "string" ? value : value instanceof Uint8Array ? value : new Uint8Array(value);
      m.set(key, { v, exp: options?.expirationTtl ? Date.now() + options.expirationTtl * 1000 : 0, metadata: options?.metadata });
    },
    async delete(key) {
      m.delete(key);
    },
    async getWithMetadata(key, type) {
      const e = live(key);
      return { value: e ? read(e, type) : null, metadata: e?.metadata ?? null };
    },
    async list(options) {
      const keys = [...m.keys()]
        .filter((k) => k.startsWith(options?.prefix ?? "") && live(k))
        .sort()
        .map((name) => ({ name, metadata: m.get(name)?.metadata }));
      return { keys: keys.slice(0, options?.limit ?? 1000), list_complete: true };
    },
  };
}

export const IS_DEV = (import.meta as unknown as { env?: Record<string, unknown> }).env?.["DEV"] === true && (import.meta as unknown as { env?: Record<string, unknown> }).env?.["MODE"] !== "test";
const devKey = "__studio_dev_kv__";

/**
 * The CONTENT KV namespace. Only in local development (vite dev) do we fall back to an
 * in-memory store; in production a missing binding is reported, never silently faked.
 */
export async function getStorage(): Promise<KVLike | null> {
  const kv = await getKV();
  if (kv) return kv;
  if (!IS_DEV) return null;
  const g = globalThis as unknown as Record<string, KVLike | undefined>;
  return (g[devKey] ??= createMemoryKV());
}

async function readJson(kv: KVLike, key: string): Promise<unknown> {
  const raw = await kv.get(key, "text");
  if (typeof raw !== "string" || raw === "") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * The wordmark used to be stored as "NAZMUL" and the 3D scene silently drew "NAZMUL HASAN" for that one value.
 * The scene now draws exactly what is stored, so content saved under the old convention is upgraded on read to
 * keep the live site looking the same (the Studio then shows the truth, and publishing persists it).
 */
const LEGACY_WORDMARK = "NAZMUL";
function upgradeLegacy(content: PortfolioContent): PortfolioContent {
  return content.wordmark.trim() === LEGACY_WORDMARK ? { ...content, wordmark: initialContent.wordmark } : content;
}

function toRecord(value: unknown): ContentRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const r = value as { version?: unknown; updatedAt?: unknown; note?: unknown; content?: unknown };
  if (typeof r.version !== "number" || !Number.isInteger(r.version) || r.version < 0) return null;
  return {
    version: r.version,
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : "",
    note: cleanNote(r.note) ?? "", // records saved before notes existed (or a damaged note) read as no note
    content: upgradeLegacy(parseContent(r.content).content),
  };
}

export async function readRecord(kv: KVLike): Promise<ContentRecord | null> {
  return toRecord(await readJson(kv, CONTENT_KEY));
}

export async function readRevisions(kv: KVLike): Promise<Revision[]> {
  const list = await readJson(kv, REVISIONS_KEY);
  if (!Array.isArray(list)) return [];
  return list.map(toRecord).filter((r): r is Revision => r !== null);
}

/** Saves new content as the next version and keeps the version it replaces as a revision. */
export async function writeContent(
  kv: KVLike,
  current: ContentRecord | null,
  content: PortfolioContent,
  note = "",
): Promise<ContentRecord> {
  const next: ContentRecord = {
    version: (current?.version ?? 0) + 1,
    updatedAt: new Date().toISOString(),
    note,
    content,
  };
  if (current) {
    // Drop an earlier copy of the same version: a previous publish may have stored the revision and then failed
    // before storing the content, and the list must never show one version twice.
    const earlier = (await readRevisions(kv)).filter((r) => r.version !== current.version);
    const revisions = [current, ...earlier].slice(0, MAX_REVISIONS);
    await kv.put(REVISIONS_KEY, JSON.stringify(revisions));
  }
  await kv.put(CONTENT_KEY, JSON.stringify(next));
  return next;
}

/** What the public site renders: the published version, or the built-in defaults. */
export async function loadPublishedContent(): Promise<{ version: number; content: PortfolioContent }> {
  try {
    const kv = await getStorage();
    if (kv) {
      const record = await readRecord(kv);
      if (record) return { version: record.version, content: record.content };
    }
  } catch (error) {
    console.error("Could not load published content", error);
  }
  return { version: 0, content: initialContent };
}

// --- login rate limiting (best effort: KV is eventually consistent) ---

const failureKey = (ip: string) => `rl:login:${ip}`;

export async function countFailures(kv: KVLike, ip: string): Promise<number> {
  const raw = await kv.get(failureKey(ip), "text");
  const n = typeof raw === "string" ? Number.parseInt(raw, 10) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export async function recordFailure(kv: KVLike, ip: string): Promise<number> {
  const n = (await countFailures(kv, ip)) + 1;
  await kv.put(failureKey(ip), String(n), { expirationTtl: FAILURE_WINDOW });
  return n;
}

export async function clearFailures(kv: KVLike, ip: string): Promise<void> {
  await kv.delete(failureKey(ip));
}

// --- session revocation (sessions are stateless signed cookies; sign-out is recorded here) ---
//
// KV is eventually consistent, so a revocation reaches every Cloudflare location within about a minute.

const revokedKey = (nonce: string) => `auth:revoked:${nonce}`;
const REVOKED_BEFORE_KEY = "auth:revoked-before";
const KV_MIN_TTL = 60; // Cloudflare KV refuses a shorter expirationTtl

/** Invalidates one session (its cookie keeps verifying, but is refused) until it would have expired anyway. */
export async function revokeSession(kv: KVLike, session: Pick<SessionData, "nonce" | "exp">): Promise<void> {
  const ttl = Math.max(KV_MIN_TTL, session.exp - Math.floor(Date.now() / 1000) + 1);
  await kv.put(revokedKey(session.nonce), "1", { expirationTtl: ttl });
}

/** Invalidates every session issued up to now, on every device. Sessions issued after this call are unaffected. */
export async function revokeAllSessions(kv: KVLike): Promise<void> {
  // Any session older than SESSION_TTL has expired by itself, so the marker can expire too.
  await kv.put(REVOKED_BEFORE_KEY, String(Math.floor(Date.now() / 1000)), { expirationTtl: SESSION_TTL + KV_MIN_TTL });
}

export async function isSessionRevoked(kv: KVLike, session: Pick<SessionData, "nonce" | "iat">): Promise<boolean> {
  if ((await kv.get(revokedKey(session.nonce), "text")) !== null) return true;
  const raw = await kv.get(REVOKED_BEFORE_KEY, "text");
  const before = typeof raw === "string" ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(before) && session.iat <= before;
}
