import { afterEach, describe, expect, it } from "vitest";
import { fixtureBytes } from "../../test/image-fixtures";
import { ApiError, describeStorageFallback, describeUploadError } from "../studio-client";
import { getUploadStore, isValidImageKey, mediaImageStore, resolveImage, urlRef } from "./image-store";

const NAME = "0123456789abcdef0123456789abcdef.webp";
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("image keys", () => {
  it("accepts uploaded images by content-hash name and external https links, and nothing else", () => {
    expect(isValidImageKey(`media:${NAME}`)).toBe(true);
    expect(isValidImageKey("url:https://cdn.example/a.png")).toBe(true);
    for (const bad of [
      "media:../x.png",
      "media:x.png",
      "media:",
      `media:${NAME}/..`,
      "url:http://cdn.example/a.png",
      "url:javascript:alert(1)",
      "url:data:image/png;base64,AAAA",
      "r2:books/old.webp", // the placeholder scheme this replaced
      "ftp:whatever",
      "",
    ]) expect(isValidImageKey(bad)).toBe(false);
  });

  it("turns an uploaded image into a same-origin path and refuses malformed ones", () => {
    expect(resolveImage({ key: `media:${NAME}` })).toBe(`/media/${NAME}`);
    expect(resolveImage({ key: "media:../x.png" })).toBe("");
    expect(resolveImage(urlRef("https://cdn.example/a.png"))).toBe("https://cdn.example/a.png");
    expect(resolveImage({ key: "r2:old.webp", url: "https://cdn.example/a.png" })).toBe("");
  });

  it("offers the media store as the upload target", () => {
    expect(getUploadStore()).toBe(mediaImageStore);
  });
});

describe("uploading from the browser", () => {
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("sends the raw bytes to the upload endpoint with the session cookie and returns a reference", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return reply(201, { key: `media:${NAME}`, name: NAME, url: `/media/${NAME}`, width: 33, height: 17, size: 96, type: "image/webp", existing: false, storage: "r2" });
    }) as typeof fetch;
    const file = new Blob([fixtureBytes("webp_lossy_33x17") as unknown as BlobPart], { type: "image/webp" });
    const { ref } = await mediaImageStore.put!(file, { filename: "ignored.webp", contentType: "image/webp" });
    expect(ref).toEqual({ key: `media:${NAME}`, width: 33, height: 17, alt: "" });
    expect(seen?.url).toBe("/api/studio/upload");
    expect(seen?.init.method).toBe("POST");
    expect(seen?.init.credentials).toBe("same-origin");
    expect(seen?.init.body).toBe(file); // the file itself: not JSON, not a form, and no filename is sent
    expect(new Headers(seen?.init.headers).get("content-type")).toBe("image/webp");
  });

  it("returns no warning when the image went to R2", async () => {
    globalThis.fetch = (async () => reply(201, { key: `media:${NAME}`, name: NAME, url: `/media/${NAME}`, width: 1, height: 1, size: 1, type: "image/webp", existing: false, storage: "r2" })) as typeof fetch;
    const stored = await mediaImageStore.put!(new Blob(["x"]), { filename: "a", contentType: "image/webp" });
    expect("warning" in stored).toBe(false);
  });

  it("returns the reference AND a warning when the image had to be kept outside R2: it still works", async () => {
    globalThis.fetch = (async () => reply(201, { key: `media:${NAME}`, name: NAME, url: `/media/${NAME}`, width: 33, height: 17, size: 96, type: "image/webp", existing: false, storage: "kv", fallback: "r2_not_connected" })) as typeof fetch;
    const stored = await mediaImageStore.put!(new Blob(["x"]), { filename: "a", contentType: "image/webp" });
    expect(stored.ref.key).toBe(`media:${NAME}`); // the same reference an R2-stored image would have
    expect(stored.warning).toContain("Not saved to Cloudflare R2");
    expect(stored.warning).toContain("not connected");
    expect(stored.warning).toContain("already in the book");
  });

  it("surfaces the server's refusal as an ApiError the editor can explain", async () => {
    globalThis.fetch = (async () => reply(503, { error: "media_not_configured" })) as typeof fetch;
    const failure = await mediaImageStore.put!(new Blob(["x"]), { filename: "a", contentType: "image/png" }).catch((e) => e);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure.status).toBe(503);
  });
});

describe("describeUploadError", () => {
  const err = (status: number, code: string) => new ApiError(status, { error: code });

  it("gives an actionable sentence for every refusal the server can send", () => {
    expect(describeUploadError(err(503, "media_not_configured"))).toContain("DEPLOY.md");
    expect(describeUploadError(err(413, "too_large"))).toContain("8 MB");
    expect(describeUploadError(err(415, "unsupported_image"))).toContain("JPEG, PNG, WebP or GIF");
    expect(describeUploadError(err(422, "image_dimensions"))).toContain("10,000");
    expect(describeUploadError(err(422, "image_dimensions"))).toContain("50 megapixels");
    expect(describeUploadError(err(400, "empty"))).toContain("empty");
    expect(describeUploadError(err(401, "unauthorized"))).toContain("Sign in");
  });

  it("has a safe fallback, and a different message when the server cannot be reached at all", () => {
    expect(describeUploadError(err(500, "server_error"))).toContain("could not store");
    // The platform itself gave up (e.g. Cloudflare error 1102 on the free plan): there is no JSON error code.
    expect(describeUploadError(new ApiError(503, {}))).toContain("smaller one");
    expect(describeUploadError(new ApiError(503, {}))).toContain("free plan");
    expect(describeUploadError(new TypeError("Failed to fetch"))).toContain("connection");
  });
});

describe("describeStorageFallback", () => {
  it("says nothing when the image went to R2", () => {
    expect(describeStorageFallback({ storage: "r2" })).toBeNull();
    expect(describeStorageFallback({ storage: "r2" }, "the cover")).toBeNull();
  });

  it("explains that it was NOT saved to R2 but was uploaded, why, and what to do next", () => {
    const notConnected = describeStorageFallback({ storage: "kv", fallback: "r2_not_connected" })!;
    expect(notConnected).toContain("Not saved to Cloudflare R2");
    expect(notConnected).toContain("R2 is not connected");
    expect(notConnected).toContain("was uploaded");
    expect(notConnected).toContain("Move to R2");
    const failed = describeStorageFallback({ storage: "kv", fallback: "r2_error" })!;
    expect(failed).toContain("returned an error");
    expect(failed).not.toContain("not connected");
  });

  it("says where the image is already in use, so the owner knows nothing more is needed to see it", () => {
    const kv = { storage: "kv", fallback: "r2_error" } as const;
    expect(describeStorageFallback(kv, "the book")).toContain("already in the book");
    expect(describeStorageFallback(kv, "the cover")).toContain("already in the cover");
    expect(describeStorageFallback(kv, "the share preview")).toContain("already in the share preview");
    expect(describeStorageFallback(kv)).not.toContain("already in");
  });

  it("explains the case where neither store could keep the image", () => {
    expect(describeUploadError(new ApiError(502, { error: "storage_failed" }))).toContain("neither in Cloudflare R2 nor");
  });
});

