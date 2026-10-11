import { beforeEach, describe, expect, it } from "vitest";
import { initialContent } from "@/lib/content-model";
import { mediaKey } from "@/lib/media";
import { fixtureBytes } from "../test/image-fixtures";
import { registerRuntime, type KVLike, type R2BodyLike, type R2Like, type R2ObjectLike } from "./env";
import { MIGRATE_BATCH, handleMediaRequest } from "./media";
import { createMemoryKV } from "./store";
import { handleStudioApi } from "./studio-api";

const BASE = "https://site.test";
const PASSWORD = "correct horse battery staple";
const SECRET = "0123456789abcdef0123456789abcdef-secret";
const proc = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process;

/** A stand-in for an R2 bucket that remembers everything it is given, so tests can look inside. */
type Stored = { bytes: Uint8Array; contentType: string; cacheControl: string; uploaded: Date };
function memoryR2() {
  const objects = new Map<string, Stored>();
  let tick = 0;
  const meta = (key: string, o: Stored): R2ObjectLike => ({ key, size: o.bytes.byteLength, httpEtag: `"etag-${key}"`, uploaded: o.uploaded, httpMetadata: { contentType: o.contentType } });
  const bucket: R2Like = {
    async put(key, value, options) {
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      objects.set(key, { bytes, contentType: options?.httpMetadata?.contentType ?? "", cacheControl: options?.httpMetadata?.cacheControl ?? "", uploaded: new Date(1_700_000_000_000 + tick++ * 1000) });
    },
    async get(key): Promise<R2BodyLike | null> {
      const o = objects.get(key);
      return o ? { ...meta(key, o), body: new Blob([o.bytes as unknown as BlobPart]).stream() } : null;
    },
    async head(key) { const o = objects.get(key); return o ? meta(key, o) : null; },
    async delete(key) { objects.delete(key); },
    async list(options) {
      const all = [...objects].filter(([k]) => k.startsWith(options?.prefix ?? "")).map(([k, o]) => meta(k, o));
      return { objects: all, truncated: false };
    },
  };
  return { bucket, objects };
}

type Init = { method?: string; body?: BodyInit; cookie?: string; origin?: string | null; type?: string };
function api(path: string, init: Init = {}) {
  const headers = new Headers({ "cf-connecting-ip": "1.2.3.4" });
  if (init.origin !== null) headers.set("origin", init.origin ?? BASE);
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.type) headers.set("content-type", init.type);
  const request = new Request(`${BASE}/api/studio/${path}`, { method: init.method ?? "GET", headers, ...(init.body !== undefined ? { body: init.body } : {}) });
  return handleStudioApi(request).then((r) => r!);
}
const bodyOf = (u: Uint8Array) => u as unknown as BodyInit;

async function signIn(): Promise<string> {
  const res = await api("login", { method: "POST", type: "application/json", body: JSON.stringify({ password: PASSWORD }) });
  expect(res.status).toBe(200);
  return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

let r2: ReturnType<typeof memoryR2>;
let kv: KVLike;
beforeEach(() => {
  proc.env["ADMIN_PASSWORD"] = PASSWORD;
  proc.env["SESSION_SECRET"] = SECRET;
  r2 = memoryR2();
  kv = createMemoryKV();
  registerRuntime(new Request(BASE), { CONTENT: kv, MEDIA: r2.bucket });
});

const upload = (cookie: string, bytes: Uint8Array | string, type = "image/png") => api("upload", { method: "POST", cookie, type, body: typeof bytes === "string" ? bytes : bodyOf(bytes) });
const get = (path: string, init: RequestInit = {}) => handleMediaRequest(new Request(`${BASE}${path}`, init)).then((r) => r!);

describe("image upload", () => {
  it("needs a signed-in, same-origin request and stores nothing otherwise", async () => {
    const png = fixtureBytes("png_40x30");
    expect((await api("upload", { method: "POST", body: bodyOf(png) })).status).toBe(401);
    const cookie = await signIn();
    expect((await api("upload", { method: "POST", cookie, origin: "https://evil.test", body: bodyOf(png) })).status).toBe(403);
    expect((await api("upload", { cookie })).status).toBe(405);
    expect(r2.objects.size).toBe(0);
  });

  it("stores a real image under its content-hash name with the type read from its bytes", async () => {
    const cookie = await signIn();
    const png = fixtureBytes("png_40x30");
    const res = await upload(cookie, png);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual(expect.objectContaining({ width: 40, height: 30, size: png.byteLength, type: "image/png", existing: false }));
    expect(body.name).toMatch(/^[a-f0-9]{32}\.png$/);
    expect(body.key).toBe(mediaKey(body.name));
    expect(body.url).toBe(`/media/${body.name}`);
    const stored = r2.objects.get(`img/${body.name}`)!;
    expect(stored.contentType).toBe("image/png");
    expect(stored.cacheControl).toContain("immutable");
    expect([...stored.bytes]).toEqual([...png]);
  });

  it("stores the same picture once, and different pictures separately", async () => {
    const cookie = await signIn();
    const first = await (await upload(cookie, fixtureBytes("jpeg_64x48"), "image/jpeg")).json();
    const again = await upload(cookie, fixtureBytes("jpeg_64x48"), "image/jpeg");
    expect(again.status).toBe(200);
    const second = await again.json();
    expect(second.name).toBe(first.name);
    expect(second.existing).toBe(true);
    expect(r2.objects.size).toBe(1);
    await upload(cookie, fixtureBytes("gif_20x10"), "image/gif");
    expect(r2.objects.size).toBe(2);
  });

  it("trusts the bytes, not the header: a PNG sent as image/jpeg is stored as a PNG", async () => {
    const cookie = await signIn();
    const res = await upload(cookie, fixtureBytes("png_40x30"), "image/jpeg");
    expect((await res.json()).name).toMatch(/\.png$/);
  });

  it("accepts all four formats", async () => {
    const cookie = await signIn();
    for (const [name, ext] of [["png_40x30", "png"], ["jpeg_64x48", "jpg"], ["gif_20x10", "gif"], ["webp_lossy_33x17", "webp"], ["webp_lossless_21x9", "webp"], ["webp_alpha_16x12", "webp"]] as const) {
      const body = await (await upload(cookie, fixtureBytes(name))).json();
      expect(body.name.endsWith(`.${ext}`)).toBe(true);
    }
  });

  it("refuses SVG, HTML and plain text, even when they claim to be images", async () => {
    const cookie = await signIn();
    for (const payload of [
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
      "<!doctype html><script>alert(1)</script>",
      "just some text",
    ]) {
      const res = await upload(cookie, payload, "image/png");
      expect(res.status).toBe(415);
      expect((await res.json()).error).toBe("unsupported_image");
    }
    expect(r2.objects.size).toBe(0);
  });

  it("refuses an empty body and an image whose size is absurd", async () => {
    const cookie = await signIn();
    expect((await upload(cookie, new Uint8Array(0))).status).toBe(400);
    const huge = Uint8Array.from(fixtureBytes("png_40x30"));
    huge.set([0, 0, 0x4e, 0x20], 16); // header now claims 20000 px wide
    const res = await upload(cookie, huge);
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("image_dimensions");
    expect(r2.objects.size).toBe(0);
  });

  it("refuses a body over the size limit even when it never declares a length", async () => {
    const cookie = await signIn();
    const res = await upload(cookie, "x".repeat(8_000_001));
    expect(res.status).toBe(413);
    expect(r2.objects.size).toBe(0);
  });
});

describe("serving images at /media/", () => {
  const stored = async () => {
    const cookie = await signIn();
    const png = fixtureBytes("png_40x30");
    const { name } = await (await upload(cookie, png)).json();
    return { cookie, png, name: name as string };
  };

  it("serves the exact bytes to anyone, as an image that can be cached forever and never sniffed", async () => {
    const { png, name } = await stored();
    const res = await get(`/media/${name}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-length")).toBe(String(png.byteLength));
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...png]);
  });

  it("answers HEAD without a body, and a matching ETag with 304", async () => {
    const { name } = await stored();
    const head = await get(`/media/${name}`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const etag = head.headers.get("etag")!;
    const cached = await get(`/media/${name}`, { headers: { "if-none-match": etag } });
    expect(cached.status).toBe(304);
    expect(await cached.text()).toBe("");
  });

  it("only looks up valid content-hash names: no traversal, no other extensions, no other prefixes", async () => {
    const { name } = await stored();
    r2.objects.set("img/evil.svg", { bytes: new TextEncoder().encode("<svg onload=alert(1)/>"), contentType: "image/svg+xml", cacheControl: "", uploaded: new Date() });
    r2.objects.set("secret.txt", { bytes: new TextEncoder().encode("secret"), contentType: "text/plain", cacheControl: "", uploaded: new Date() });
    for (const path of [
      "/media/evil.svg",
      "/media/..%2Fsecret.txt",
      `/media/${name.toUpperCase()}`,
      `/media/${name}.svg`,
      "/media/img/" + name,
      "/media/",
      "/media/%E0%A4%A", // malformed percent-encoding
      `/media/${"0".repeat(32)}.png`, // valid shape, nothing stored
    ]) expect((await get(path)).status).toBe(404);
    // The URL parser itself collapses ".." to /secret.txt, so this never counts as a media request at all.
    expect(await handleMediaRequest(new Request(`${BASE}/media/../secret.txt`))).toBeNull();
  });

  it("serves the type implied by the file name, even if the stored object claims to be something else", async () => {
    // e.g. a file put into the bucket by hand from the dashboard with the wrong content type
    const name = "0123456789abcdef0123456789abcdef.png";
    r2.objects.set(`img/${name}`, { bytes: new TextEncoder().encode("<script>alert(1)</script>"), contentType: "text/html", cacheControl: "", uploaded: new Date() });
    const res = await get(`/media/${name}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("only answers GET and HEAD, ignores other paths, and 404s when there is no bucket", async () => {
    const { name } = await stored();
    expect((await get(`/media/${name}`, { method: "POST" })).status).toBe(405);
    expect(await handleMediaRequest(new Request(`${BASE}/`))).toBeNull();
    expect(await handleMediaRequest(new Request(`${BASE}/api/studio/session`))).toBeNull();
    registerRuntime(new Request(BASE), { CONTENT: kv });
    expect((await get(`/media/${name}`)).status).toBe(404);
  });
});

describe("image library", () => {
  const publish = (cookie: string, baseVersion: number, site: Record<string, string>) =>
    api("content", { method: "PUT", cookie, type: "application/json", body: JSON.stringify({ baseVersion, content: { ...initialContent, site: { ...initialContent.site, ...site } } }) });

  it("lists uploaded images, newest first, to a signed-in user only", async () => {
    const cookie = await signIn();
    const a = await (await upload(cookie, fixtureBytes("png_40x30"))).json();
    const b = await (await upload(cookie, fixtureBytes("gif_20x10"))).json();
    expect((await api("media")).status).toBe(401);
    const list = await (await api("media", { cookie })).json();
    expect(list.items.map((i: { name: string }) => i.name)).toEqual([b.name, a.name]);
    expect(list.items[1]).toEqual(expect.objectContaining({ size: fixtureBytes("png_40x30").byteLength }));
    expect(list.truncated).toBe(false);
  });

  it("deletes an unused image, once, and needs sign-in and a same-origin request", async () => {
    const cookie = await signIn();
    const { name } = await (await upload(cookie, fixtureBytes("png_40x30"))).json();
    expect((await api(`media/${name}`, { method: "DELETE" })).status).toBe(401);
    expect((await api(`media/${name}`, { method: "DELETE", cookie, origin: "https://evil.test" })).status).toBe(403);
    expect(r2.objects.size).toBe(1);
    expect((await api(`media/${name}`, { method: "DELETE", cookie })).status).toBe(200);
    expect(r2.objects.size).toBe(0);
    expect((await api(`media/${name}`, { method: "DELETE", cookie })).status).toBe(404);
    expect((await api(`media/${name}`, { cookie })).status).toBe(405);
  });

  it("refuses to delete an image the published site uses, and says where", async () => {
    const cookie = await signIn();
    const { name } = await (await upload(cookie, fixtureBytes("jpeg_64x48"))).json();
    expect((await publish(cookie, 0, { coverImage: mediaKey(name), ogImage: mediaKey(name) })).status).toBe(200);
    const res = await api(`media/${name}`, { method: "DELETE", cookie });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("in_use");
    expect([...body.usedBy].sort()).toEqual(["cover", "share image"]);
    expect(r2.objects.size).toBe(1);
    // Once a newer version stops using it, it can go.
    expect((await publish(cookie, 1, {})).status).toBe(200);
    expect((await api(`media/${name}`, { method: "DELETE", cookie })).status).toBe(200);
  });

  it("only deletes by exact name", async () => {
    const cookie = await signIn();
    await upload(cookie, fixtureBytes("png_40x30"));
    for (const bad of ["..%2F..%2Fx", "x.png", "%E0%A4%A"]) expect((await api(`media/${bad}`, { method: "DELETE", cookie })).status).toBe(404);
    expect(r2.objects.size).toBe(1);
  });
});

describe("content that refers to uploaded images", () => {
  const publish = async (cookie: string, site: Record<string, string>) =>
    api("content", { method: "PUT", cookie, type: "application/json", body: JSON.stringify({ baseVersion: 0, content: { ...initialContent, site: { ...initialContent.site, ...site } } }) });
  const name = "0123456789abcdef0123456789abcdef.png";

  it("accepts an uploaded cover and share image, and refuses anything else for the cover", async () => {
    const cookie = await signIn();
    expect((await publish(cookie, { coverImage: mediaKey(name), ogImage: mediaKey(name) })).status).toBe(200);
  });

  it("refuses an external link or a malformed key as the cover (the 3D scene must read its pixels)", async () => {
    const cookie = await signIn();
    for (const coverImage of ["https://x.test/cover.jpg", "media:../x.png", "media:", "url:https://x.test/a.png"]) {
      const res = await publish(cookie, { coverImage });
      expect(res.status).toBe(422);
      expect((await res.json()).issues[0].path).toBe("site.coverImage");
    }
  });

  it("accepts an https share image but not a malformed uploaded one or plain http", async () => {
    const cookie = await signIn();
    for (const ogImage of ["media:nope.png", "http://x.test/a.png", "javascript:alert(1)"]) {
      const res = await publish(cookie, { ogImage });
      expect(res.status).toBe(422);
      expect((await res.json()).issues[0].path).toBe("site.ogImage");
    }
    expect((await publish(cookie, { ogImage: "https://x.test/a.png" })).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// When R2 is not connected or fails, the image is kept in KV: it still works, and the response says it is not in R2.
// ---------------------------------------------------------------------------------------------------------------

/** Makes chosen operations of a bucket throw, to simulate an outage or a revoked permission. */
function failing(bucket: R2Like, ops: Partial<Record<"head" | "put" | "get" | "list" | "delete", boolean>>): R2Like {
  const boom = () => Promise.reject(new Error("simulated R2 failure"));
  return {
    put: (...a) => (ops.put ? boom() : bucket.put(...a)),
    get: (...a) => (ops.get ? boom() : bucket.get(...a)),
    head: (...a) => (ops.head ? boom() : bucket.head(...a)),
    delete: (...a) => (ops.delete ? boom() : bucket.delete(...a)),
    list: (...a) => (ops.list ? boom() : bucket.list(...a)),
  };
}
const connect = (bucket: R2Like | undefined) => registerRuntime(new Request(BASE), { CONTENT: kv, ...(bucket ? { MEDIA: bucket } : {}) });
const kvBytes = async (name: string) => {
  const buf = (await kv.get(`media/${name}`, "arrayBuffer")) as ArrayBuffer | null;
  return buf ? new Uint8Array(buf) : null;
};
const quiet = async <T,>(run: () => Promise<T>): Promise<T> => {
  const original = console.error;
  console.error = () => undefined; // the code logs the simulated failures on purpose
  try { return await run(); } finally { console.error = original; }
};

describe("when R2 is not available: the image is kept in KV, still works, and the response says so", () => {
  it("with no R2 bucket connected, stores the image in KV and reports that it is not in R2", async () => {
    const cookie = await signIn();
    connect(undefined);
    const png = fixtureBytes("png_40x30");
    const res = await upload(cookie, png);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual(expect.objectContaining({ storage: "kv", fallback: "r2_not_connected", existing: false, width: 40, height: 30 }));
    expect(body.key).toBe(mediaKey(body.name)); // the very same reference the book would use with R2
    expect([...(await kvBytes(body.name))!]).toEqual([...png]);
    expect(r2.objects.size).toBe(0);
  });

  it("falls back when R2 is connected but fails while storing, whichever call fails", async () => {
    const cookie = await signIn();
    for (const ops of [{ head: true }, { put: true }] as const) {
      kv = createMemoryKV();
      connect(failing(r2.bucket, ops));
      const res = await quiet(() => upload(cookie, fixtureBytes("jpeg_64x48")));
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body).toEqual(expect.objectContaining({ storage: "kv", fallback: "r2_error" }));
      expect(await kvBytes(body.name)).not.toBeNull();
    }
    expect(r2.objects.size).toBe(0);
  });

  it("reports normal R2 storage as such, with no fallback flag", async () => {
    const cookie = await signIn();
    const body = await (await upload(cookie, fixtureBytes("png_40x30"))).json();
    expect(body.storage).toBe("r2");
    expect(body.fallback).toBeUndefined();
    expect(await kvBytes(body.name)).toBeNull();
  });

  it("stores the same picture in KV once, and still checks the bytes first", async () => {
    const cookie = await signIn();
    connect(undefined);
    const first = await (await upload(cookie, fixtureBytes("gif_20x10"))).json();
    const again = await upload(cookie, fixtureBytes("gif_20x10"));
    expect(again.status).toBe(200);
    expect((await again.json()).existing).toBe(true);
    expect((await upload(cookie, '<svg onload="alert(1)"/>')).status).toBe(415);
    expect((await (await api("media", { cookie })).json()).items).toHaveLength(1);
    expect(first.storage).toBe("kv");
  });

  it("refuses the upload only when neither R2 nor KV can store it", async () => {
    const cookie = await signIn();
    const brokenKv: KVLike = { ...kv, put: () => Promise.reject(new Error("simulated KV failure")) };
    registerRuntime(new Request(BASE), { CONTENT: brokenKv, MEDIA: failing(r2.bucket, { head: true }) });
    // the session cookie is checked against the same KV, which still reads fine
    const res = await quiet(() => upload(cookie, fixtureBytes("png_40x30")));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("storage_failed");
  });

  it("serves a KV-kept image at the same /media/ address, as inert pixels that cache forever", async () => {
    const cookie = await signIn();
    connect(undefined);
    const png = fixtureBytes("png_40x30");
    const { name } = await (await upload(cookie, png)).json();
    const res = await get(`/media/${name}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-length")).toBe(String(png.byteLength));
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...png]);
    const etag = res.headers.get("etag")!;
    expect(etag).toBe(`"${name}"`);
    expect((await get(`/media/${name}`, { headers: { "if-none-match": etag } })).status).toBe(304);
    const head = await get(`/media/${name}`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("serves from R2 first, and from KV when R2 lacks the image or fails to read", async () => {
    const name = "0123456789abcdef0123456789abcdef.png";
    const fromR2 = fixtureBytes("png_40x30");
    const fromKv = fixtureBytes("png_40x30").slice().reverse(); // different bytes, so we can tell which store answered
    await kv.put(`media/${name}`, fromKv, { metadata: { size: fromKv.byteLength } });
    expect((await get(`/media/${name}`)).status).toBe(200); // only KV has it
    r2.objects.set(`img/${name}`, { bytes: fromR2, contentType: "image/png", cacheControl: "", uploaded: new Date() });
    expect([...new Uint8Array(await (await get(`/media/${name}`)).arrayBuffer())]).toEqual([...fromR2]); // R2 wins
    connect(failing(r2.bucket, { get: true }));
    const viaKv = await quiet(() => get(`/media/${name}`));
    expect(viaKv.status).toBe(200);
    expect([...new Uint8Array(await viaKv.arrayBuffer())]).toEqual([...fromKv]);
  });

  it("404s when neither store has the image", async () => {
    connect(undefined);
    expect((await get(`/media/${"1".repeat(32)}.png`)).status).toBe(404);
  });

  it("uploading the same image again once R2 works moves it into R2 and removes the KV copy", async () => {
    const cookie = await signIn();
    connect(undefined);
    const png = fixtureBytes("png_40x30");
    const { name } = await (await upload(cookie, png)).json();
    expect(await kvBytes(name)).not.toBeNull();
    connect(r2.bucket);
    const again = await (await upload(cookie, png)).json();
    expect(again).toEqual(expect.objectContaining({ name, storage: "r2", existing: false }));
    expect(await kvBytes(name)).toBeNull();
    expect(r2.objects.has(`img/${name}`)).toBe(true);
  });
});

describe("the library with both stores", () => {
  it("lists images from R2 and KV together, newest first, saying where each one is", async () => {
    const cookie = await signIn();
    const inR2 = await (await upload(cookie, fixtureBytes("png_40x30"))).json();
    connect(undefined);
    const inKv = await (await upload(cookie, fixtureBytes("gif_20x10"))).json();
    connect(r2.bucket);
    const list = await (await api("media", { cookie })).json();
    expect(list.r2Connected).toBe(true);
    const where = Object.fromEntries(list.items.map((i: { name: string; storage: string }) => [i.name, i.storage]));
    expect(where).toEqual({ [inR2.name]: "r2", [inKv.name]: "kv" });
    expect(list.items[0].name).toBe(inKv.name); // uploaded later
    expect(list.items.find((i: { name: string }) => i.name === inKv.name).size).toBe(fixtureBytes("gif_20x10").byteLength);
  });

  it("shows an image in both stores once, as being in R2, and says R2 is not connected when it is not", async () => {
    const cookie = await signIn();
    const { name } = await (await upload(cookie, fixtureBytes("png_40x30"))).json();
    await kv.put(`media/${name}`, fixtureBytes("png_40x30"), { metadata: { size: 1, uploaded: "2020-01-01T00:00:00.000Z" } });
    const both = await (await api("media", { cookie })).json();
    expect(both.items).toHaveLength(1);
    expect(both.items[0].storage).toBe("r2");
    connect(undefined);
    const noR2 = await (await api("media", { cookie })).json();
    expect(noR2.r2Connected).toBe(false);
    expect(noR2.items.map((i: { storage: string }) => i.storage)).toEqual(["kv"]);
  });

  it("still lists the KV images when R2 cannot be listed, and treats R2 as unavailable", async () => {
    const cookie = await signIn();
    connect(undefined);
    const { name } = await (await upload(cookie, fixtureBytes("png_40x30"))).json();
    connect(failing(r2.bucket, { list: true }));
    const list = await quiet(async () => (await api("media", { cookie })).json());
    expect(list.r2Connected).toBe(false);
    expect(list.items.map((i: { name: string }) => i.name)).toEqual([name]);
  });

  it("deletes an image from every store that holds it", async () => {
    const cookie = await signIn();
    const { name } = await (await upload(cookie, fixtureBytes("png_40x30"))).json();
    await kv.put(`media/${name}`, fixtureBytes("png_40x30"), { metadata: {} });
    expect((await api(`media/${name}`, { method: "DELETE", cookie })).status).toBe(200);
    expect(r2.objects.size).toBe(0);
    expect(await kvBytes(name)).toBeNull();
    expect((await api(`media/${name}`, { method: "DELETE", cookie })).status).toBe(404);
  });

  it("deletes a KV-only image, and refuses while the published site uses it", async () => {
    const cookie = await signIn();
    connect(undefined);
    const { name } = await (await upload(cookie, fixtureBytes("png_40x30"))).json();
    const publish = (baseVersion: number, coverImage: string) =>
      api("content", { method: "PUT", cookie, type: "application/json", body: JSON.stringify({ baseVersion, content: { ...initialContent, site: { ...initialContent.site, coverImage } } }) });
    expect((await publish(0, mediaKey(name))).status).toBe(200);
    expect((await api(`media/${name}`, { method: "DELETE", cookie })).status).toBe(409);
    expect(await kvBytes(name)).not.toBeNull();
    expect((await publish(1, "")).status).toBe(200);
    expect((await api(`media/${name}`, { method: "DELETE", cookie })).status).toBe(200);
    expect(await kvBytes(name)).toBeNull();
  });

  it("does not mistake an R2 failure for 'not found' when deleting", async () => {
    const cookie = await signIn();
    connect(failing(r2.bucket, { head: true }));
    const res = await quiet(() => api(`media/${"2".repeat(32)}.png`, { method: "DELETE", cookie }));
    expect(res.status).toBe(500);
  });
});

describe("moving KV-kept images into R2", () => {
  const fakeName = (n: number) => `${String(n).padStart(32, "0")}.png`;
  const seed = async (count: number) => {
    for (let i = 1; i <= count; i++) await kv.put(`media/${fakeName(i)}`, fixtureBytes("png_40x30"), { metadata: { size: 1 } });
  };
  const migrate = (cookie?: string, origin?: string | null) => api("media/migrate", { method: "POST", ...(cookie ? { cookie } : {}), ...(origin !== undefined ? { origin } : {}) });

  it("needs sign-in and a same-origin request, and says so when R2 is not connected", async () => {
    expect((await migrate()).status).toBe(401);
    const cookie = await signIn();
    expect((await migrate(cookie, "https://evil.test")).status).toBe(403);
    expect((await api("media/migrate", { cookie })).status).toBe(405);
    connect(undefined);
    const res = await migrate(cookie);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("r2_not_connected");
  });

  it("moves a batch at a time and reports what is left, until everything is in R2", async () => {
    const cookie = await signIn();
    await seed(MIGRATE_BATCH + 2);
    const first = await (await migrate(cookie)).json();
    expect(first).toEqual({ moved: MIGRATE_BATCH, failed: 0, remaining: 2 });
    expect(r2.objects.size).toBe(MIGRATE_BATCH);
    const second = await (await migrate(cookie)).json();
    expect(second).toEqual({ moved: 2, failed: 0, remaining: 0 });
    expect(r2.objects.size).toBe(MIGRATE_BATCH + 2);
    expect(await kvBytes(fakeName(1))).toBeNull();
    expect((await get(`/media/${fakeName(1)}`)).status).toBe(200); // now answered from R2
    expect(await (await migrate(cookie)).json()).toEqual({ moved: 0, failed: 0, remaining: 0 });
  });

  it("never loses an image: one that is not a real image, or whose R2 write fails, stays in KV and is counted as failed", async () => {
    const cookie = await signIn();
    await seed(2);
    await kv.put(`media/${fakeName(3)}`, new TextEncoder().encode("<svg onload=alert(1)/>"), { metadata: {} });
    const result = await (await migrate(cookie)).json();
    expect(result).toEqual({ moved: 2, failed: 1, remaining: 1 });
    expect(await kvBytes(fakeName(3))).not.toBeNull();
    expect(r2.objects.has(`img/${fakeName(3)}`)).toBe(false);

    // A bucket that says "stored" but does not keep the object must not cost us the only copy.
    await kv.put(`media/${fakeName(7)}`, fixtureBytes("png_40x30"), { metadata: {} }); // not in R2 yet
    connect({ ...r2.bucket, put: async () => undefined });
    const silent = await (await migrate(cookie)).json();
    expect(silent.moved).toBe(0);
    expect(silent.failed).toBe(2); // the SVG impostor from above, and this one
    expect(await kvBytes(fakeName(7))).not.toBeNull(); // still there: R2 never actually got it
    expect(r2.objects.has(`img/${fakeName(7)}`)).toBe(false);

    // A name that promises one format but holds another is not trusted either.
    await kv.put(`media/${"9".repeat(32)}.png`, fixtureBytes("jpeg_64x48"), { metadata: {} });
    connect(r2.bucket);
    const mismatch = await (await migrate(cookie)).json();
    expect(mismatch.failed).toBeGreaterThanOrEqual(1);
    expect(await kvBytes("9".repeat(32) + ".png")).not.toBeNull();
    expect(r2.objects.has(`img/${"9".repeat(32)}.png`)).toBe(false);

    // And when R2 refuses the write outright, the KV copy is simply kept.
    await kv.put(`media/${fakeName(8)}`, fixtureBytes("png_40x30"), { metadata: {} });
    connect(failing(r2.bucket, { put: true }));
    const down = await quiet(async () => (await migrate(cookie)).json());
    expect(down.moved).toBe(0);
    expect(down.failed).toBeGreaterThan(0);
    expect(await kvBytes(fakeName(8))).not.toBeNull();
    expect(r2.objects.has(`img/${fakeName(8)}`)).toBe(false);
  });
});
