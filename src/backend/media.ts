// Server-only: storing and serving uploaded images in the MEDIA R2 bucket.
//
// Uploads go through the Worker (never straight from the browser to R2), so the same auth, origin check and
// size cap apply as for content, and the bytes are inspected before anything is stored. Images are then served
// by the Worker from the site's own origin at /media/<name>: no public bucket, no extra domain, and no CORS
// problem for the 3D book, which has to read pixels.
//
// R2 is where images belong. If it is not connected, or it fails while storing, the image is NOT lost: it is kept
// in the site's KV namespace under the same name, so the same "media:<name>" reference and /media/<name> address
// work and the book shows it at once. The upload result says so (`storage: "kv"`) and the Studio tells the owner;
// "Move to R2" later transfers such images. Serving tries R2 first, then KV.
import { MEDIA_NAME, MIME_BY_EXT, imageInfo, isMediaName, mediaKey, mediaUrl, withinDimensionLimits, type ImageInfo } from "@/lib/media";
import { getR2, type KVLike, type R2Like, type R2ObjectLike } from "./env";
import { IS_DEV, getStorage } from "./store";

const PREFIX = "img/"; // keys in R2
const KV_PREFIX = "media/"; // keys in the fallback copy in KV
const kvKey = (name: string) => KV_PREFIX + name;
const IMMUTABLE = "public, max-age=31536000, immutable"; // safe: a name is derived from the file's content
const MAX_LISTED = 2000;

// ---- bucket access ----

function createMemoryR2(): R2Like {
  const objects = new Map<string, { bytes: Uint8Array; type: string; uploaded: Date; etag: string }>();
  const meta = (key: string, o: { bytes: Uint8Array; type: string; uploaded: Date; etag: string }): R2ObjectLike => ({
    key, size: o.bytes.byteLength, httpEtag: o.etag, uploaded: o.uploaded, httpMetadata: { contentType: o.type },
  });
  return {
    async put(key, value, options) {
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      objects.set(key, { bytes, type: options?.httpMetadata?.contentType ?? "", uploaded: new Date(), etag: `"${key}-${bytes.byteLength}"` });
    },
    async get(key) {
      const o = objects.get(key);
      if (!o) return null;
      return { ...meta(key, o), body: new Blob([o.bytes as unknown as BlobPart]).stream() };
    },
    async head(key) {
      const o = objects.get(key);
      return o ? meta(key, o) : null;
    },
    async delete(key) {
      objects.delete(key);
    },
    async list(options) {
      const all = [...objects].filter(([k]) => k.startsWith(options?.prefix ?? "")).map(([k, o]) => meta(k, o));
      return { objects: all.slice(0, options?.limit ?? 1000), truncated: false };
    },
  };
}

const devKey = "__studio_dev_r2__";

/** The MEDIA bucket. Like the KV namespace: only local development gets an in-memory stand-in. */
export async function getMediaStorage(): Promise<R2Like | null> {
  const bucket = await getR2();
  if (bucket) return bucket;
  if (!IS_DEV) return null;
  const g = globalThis as unknown as Record<string, R2Like | undefined>;
  return (g[devKey] ??= createMemoryR2());
}

/** Where images can go: R2 when connected, and KV (always present once the Studio works) as the fallback. */
export type MediaStores = { r2: R2Like | null; kv: KVLike | null };

export async function getMediaStores(): Promise<MediaStores> {
  return { r2: await getMediaStorage(), kv: await getStorage() };
}

// ---- storing ----

export type FallbackReason = "r2_not_connected" | "r2_error";
export type StoreResult =
  | {
      ok: true; name: string; key: string; url: string; width: number; height: number; size: number; type: string;
      existing: boolean;
      /** "r2" normally. "kv" means it is NOT in R2 (see `fallback` for why), but it is stored and will be served. */
      storage: "r2" | "kv";
      fallback?: FallbackReason;
    }
  | { ok: false; error: "unsupported_image" | "image_dimensions" | "empty" | "storage_failed" };

type KvMeta = { type: string; size: number; uploaded: string; width: number; height: number };

/** Half of the SHA-256 of the bytes, in hex: 32 characters, the same for the same picture. */
async function contentName(bytes: Uint8Array, ext: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource));
  const hex = Array.from(digest.subarray(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex}.${ext}`;
}

/** Does KV hold this image? KV has no HEAD, so open it as a stream and drop the stream unread. */
async function kvHas(kv: KVLike, name: string): Promise<boolean> {
  if (kv.getWithMetadata) {
    const hit = await kv.getWithMetadata(kvKey(name), "stream");
    const body = hit.value as ReadableStream | null;
    if (!body) return false;
    await body.cancel().catch(() => undefined);
    return true;
  }
  return (await kv.get(kvKey(name), "text")) !== null;
}

/**
 * Checks the bytes really are an acceptable image, then stores them under their content name: in R2, or, if R2 is
 * missing or fails, in KV. Only when neither works is the upload refused.
 */
export async function storeImage(stores: MediaStores, bytes: Uint8Array): Promise<StoreResult> {
  if (bytes.byteLength === 0) return { ok: false, error: "empty" };
  const info: ImageInfo | null = imageInfo(bytes);
  if (!info) return { ok: false, error: "unsupported_image" };
  if (!withinDimensionLimits(info)) return { ok: false, error: "image_dimensions" };
  const name = await contentName(bytes, info.ext);
  const base = { ok: true as const, name, key: mediaKey(name), url: mediaUrl(name), width: info.width, height: info.height, size: bytes.byteLength, type: info.mime };

  let fallback: FallbackReason = "r2_not_connected";
  if (stores.r2) {
    try {
      const existing = (await stores.r2.head(PREFIX + name)) !== null;
      if (!existing) {
        await stores.r2.put(PREFIX + name, bytes, {
          httpMetadata: { contentType: info.mime, cacheControl: IMMUTABLE },
          customMetadata: { width: String(info.width), height: String(info.height) },
        });
      }
      // R2 holds it now, so an earlier fallback copy in KV is redundant: this is how a re-upload "moves" an image.
      if (stores.kv) await stores.kv.delete(kvKey(name)).catch(() => undefined);
      return { ...base, existing, storage: "r2" };
    } catch (error) {
      console.error("R2 store failed; keeping the image in KV instead", error);
      fallback = "r2_error";
    }
  }

  if (!stores.kv) return { ok: false, error: "storage_failed" };
  try {
    const existing = await kvHas(stores.kv, name);
    if (!existing) {
      const metadata: KvMeta = { type: info.mime, size: bytes.byteLength, uploaded: new Date().toISOString(), width: info.width, height: info.height };
      await stores.kv.put(kvKey(name), bytes, { metadata });
    }
    return { ...base, existing, storage: "kv", fallback };
  } catch (error) {
    console.error("KV fallback store failed", error);
    return { ok: false, error: "storage_failed" };
  }
}

// ---- library ----

export type MediaItem = { name: string; size: number; uploaded: string; storage: "r2" | "kv" };

const asMeta = (value: unknown): Partial<KvMeta> => (typeof value === "object" && value !== null ? (value as Partial<KvMeta>) : {});

/** Names (with metadata) of images kept in KV, oldest listing order not guaranteed. */
async function listKvMedia(kv: KVLike): Promise<Array<{ name: string; meta: Partial<KvMeta> }>> {
  const out: Array<{ name: string; meta: Partial<KvMeta> }> = [];
  if (!kv.list) return out;
  let cursor: string | undefined;
  for (;;) {
    const page = await kv.list({ prefix: KV_PREFIX, limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const key of page.keys) {
      const name = key.name.slice(KV_PREFIX.length);
      if (isMediaName(name)) out.push({ name, meta: asMeta(key.metadata) });
    }
    if (page.list_complete || !page.cursor || out.length >= MAX_LISTED) break;
    cursor = page.cursor;
  }
  return out;
}

export async function listMedia(stores: MediaStores): Promise<{ items: MediaItem[]; truncated: boolean; r2Connected: boolean }> {
  const items = new Map<string, MediaItem>();
  let r2Connected = stores.r2 !== null;
  if (stores.r2) {
    try {
      let cursor: string | undefined;
      for (;;) {
        const page = await stores.r2.list({ prefix: PREFIX, limit: 1000, ...(cursor ? { cursor } : {}) });
        for (const o of page.objects) {
          const name = o.key.slice(PREFIX.length);
          if (isMediaName(name)) items.set(name, { name, size: o.size, uploaded: o.uploaded.toISOString(), storage: "r2" });
        }
        if (!page.truncated || !page.cursor || items.size >= MAX_LISTED) break;
        cursor = page.cursor;
      }
    } catch (error) {
      console.error("R2 list failed", error);
      r2Connected = false; // treated as unavailable for now
    }
  }
  if (stores.kv) {
    try {
      for (const { name, meta } of await listKvMedia(stores.kv)) {
        if (items.has(name)) continue; // already in R2: that copy wins
        items.set(name, { name, size: meta.size ?? 0, uploaded: meta.uploaded ?? "", storage: "kv" });
      }
    } catch (error) {
      console.error("KV media list failed", error);
    }
  }
  const sorted = [...items.values()].sort((a, b) => (a.uploaded < b.uploaded ? 1 : a.uploaded > b.uploaded ? -1 : 0)); // newest first
  return { items: sorted.slice(0, MAX_LISTED), truncated: sorted.length > MAX_LISTED, r2Connected };
}

/** Deletes one file from wherever it is kept. Returns false when it exists nowhere. */
export async function deleteMedia(stores: MediaStores, name: string): Promise<boolean> {
  if (!isMediaName(name)) return false;
  let found = false;
  let r2Error: unknown;
  if (stores.r2) {
    try {
      if ((await stores.r2.head(PREFIX + name)) !== null) {
        await stores.r2.delete(PREFIX + name);
        found = true;
      }
    } catch (error) {
      r2Error = error;
    }
  }
  if (stores.kv) {
    try {
      if (await kvHas(stores.kv, name)) {
        await stores.kv.delete(kvKey(name));
        found = true;
      }
    } catch (error) {
      console.error("KV media delete failed", error);
    }
  }
  if (!found && r2Error) throw r2Error; // R2 failing must not look like "not found"
  return found;
}

/** A Worker may make only a few dozen storage calls per request on the free plan, so move a few images at a time. */
export const MIGRATE_BATCH = 8;

/**
 * Moves images that had to be kept in KV into R2 (a batch per call). `remaining` is how many are still in KV, so the
 * caller can ask again until it reaches 0. Each image is re-checked and confirmed in R2 before its KV copy is removed.
 */
export async function migrateToR2(stores: MediaStores): Promise<{ moved: number; failed: number; remaining: number }> {
  const { r2, kv } = stores;
  if (!r2 || !kv) return { moved: 0, failed: 0, remaining: 0 };
  const pending = (await listKvMedia(kv)).map((e) => e.name);
  let moved = 0;
  let failed = 0;
  for (const name of pending.slice(0, MIGRATE_BATCH)) {
    try {
      const buffer = (await kv.get(kvKey(name), "arrayBuffer")) as ArrayBuffer | null;
      if (!buffer) continue;
      const bytes = new Uint8Array(buffer);
      const info = imageInfo(bytes);
      if (!info || `.${info.ext}` !== name.slice(name.lastIndexOf("."))) {
        failed++;
        continue;
      }
      await r2.put(PREFIX + name, bytes, {
        httpMetadata: { contentType: info.mime, cacheControl: IMMUTABLE },
        customMetadata: { width: String(info.width), height: String(info.height) },
      });
      if ((await r2.head(PREFIX + name)) === null) {
        failed++;
        continue;
      }
      await kv.delete(kvKey(name));
      moved++;
    } catch (error) {
      console.error("moving an image to R2 failed", error);
      failed++;
    }
  }
  return { moved, failed, remaining: pending.length - moved };
}

// ---- serving (public) ----

const notFound = () => new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

/**
 * GET/HEAD /media/<name>. Returns null for any other path so the caller can carry on. Only names that match the
 * content-hash pattern are looked up, and the content type always comes from the extension of a file that was
 * verified at upload (never SVG or HTML), with nosniff, so what is served is inert pixels.
 */
export async function handleMediaRequest(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/media/")) return null;
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  }
  let name: string;
  try {
    name = decodeURIComponent(url.pathname.slice("/media/".length));
  } catch {
    return notFound();
  }
  if (!MEDIA_NAME.test(name)) return notFound();
  const stores = await getMediaStores();
  type Found = { body: ReadableStream; size: number | null; etag: string };
  let object: Found | null = null;
  if (stores.r2) {
    try {
      const hit = await stores.r2.get(PREFIX + name);
      if (hit) object = { body: hit.body, size: hit.size, etag: hit.httpEtag };
    } catch (error) {
      console.error("R2 read failed; trying the KV copy", error);
    }
  }
  if (!object && stores.kv?.getWithMetadata) {
    try {
      const hit = await stores.kv.getWithMetadata(kvKey(name), "stream");
      const body = hit.value as ReadableStream | null;
      // A name is the hash of the content, so it is a perfect strong ETag for a copy KV gives none for.
      if (body) object = { body, size: asMeta(hit.metadata).size ?? null, etag: `"${name}"` };
    } catch (error) {
      console.error("KV media read failed", error);
    }
  }
  if (!object) return notFound();

  const headers = new Headers({
    "content-type": MIME_BY_EXT[name.slice(name.lastIndexOf(".") + 1)] ?? "application/octet-stream",
    "cache-control": IMMUTABLE,
    "x-content-type-options": "nosniff",
    etag: object.etag,
  });
  if (request.headers.get("if-none-match") === object.etag) {
    await object.body.cancel().catch(() => undefined);
    return new Response(null, { status: 304, headers });
  }
  if (object.size) headers.set("content-length", String(object.size));
  if (method === "HEAD") {
    await object.body.cancel().catch(() => undefined);
    return new Response(null, { status: 200, headers });
  }
  return new Response(object.body, { status: 200, headers });
}
