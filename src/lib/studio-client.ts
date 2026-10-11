// Browser-side client for the admin API (/api/studio/*). Cookies are HttpOnly, so the page
// never sees the session token; it only learns "signed in or not" from the server.
import type { PortfolioContent } from "./content-model";
import type { Issue } from "./content-schema";
import { MAX_DIMENSION, MAX_PIXELS, MAX_UPLOAD_BYTES } from "./media";

export type SessionInfo = { authenticated: boolean; configured: boolean; missing?: string[]; hints?: string[] };
export type AdminContent = { version: number; updatedAt: string | null; note?: string; content: PortfolioContent };
export type Revision = { version: number; updatedAt: string; note?: string; content: PortfolioContent };

export class ApiError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    super(typeof body["error"] === "string" ? body["error"] : `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

async function readResult<T>(response: Response): Promise<T> {
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await response.json();
    if (typeof parsed === "object" && parsed !== null) body = parsed as Record<string, unknown>;
  } catch {
    /* non-JSON response */
  }
  if (!response.ok) throw new ApiError(response.status, body);
  return body as T;
}

async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const hasBody = init.body !== undefined;
  return readResult<T>(
    await fetch(`/api/studio/${path}`, {
      method: init.method ?? "GET",
      cache: "no-store",
      credentials: "same-origin",
      ...(hasBody ? { headers: { "content-type": "application/json" }, body: JSON.stringify(init.body) } : {}),
    }),
  );
}

export type UploadResult = {
  key: string; name: string; url: string; width: number; height: number; size: number; type: string; existing: boolean;
  /** "kv" means the image is NOT in Cloudflare R2 (see `fallback`), but it is stored and already works. */
  storage: "r2" | "kv";
  fallback?: "r2_not_connected" | "r2_error";
};
export type MediaItem = { name: string; size: number; uploaded: string; storage: "r2" | "kv" };
export type MediaList = { items: MediaItem[]; truncated: boolean; r2Connected: boolean };
export type MigrateResult = { moved: number; failed: number; remaining: number };

/**
 * The notice to show when an upload had to be kept outside R2, or null when it went to R2 as normal.
 * `use` says where the image is already in use, so the owner knows nothing more is needed to see it.
 */
export function describeStorageFallback(result: Pick<UploadResult, "storage" | "fallback">, use: "the book" | "the cover" | "the share preview" | null = null): string | null {
  if (result.storage !== "kv") return null;
  const why = result.fallback === "r2_error" ? "Cloudflare R2 returned an error" : "Cloudflare R2 is not connected";
  const where = use ? `, and it is already in ${use}` : "";
  return `Not saved to Cloudflare R2 (${why}), but the image was uploaded${where}. It is kept in the site's own backup storage (KV) for now: open Media and use “Move to R2” once R2 works.`;
}

/** Sends the image's raw bytes; the server decides what it is from the bytes, not from this header. */
async function uploadImage(file: Blob): Promise<UploadResult> {
  return readResult<UploadResult>(
    await fetch("/api/studio/upload", {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: { "content-type": file.type || "application/octet-stream" },
      body: file,
    }),
  );
}

/** A sentence a person can act on, for whatever went wrong while uploading. */
export function describeUploadError(error: unknown): string {
  if (!(error instanceof ApiError)) return "Could not reach the server. Check your connection and try again.";
  switch (error.body["error"]) {
    case "media_not_configured":
      return "Image storage is not set up on this site yet. See DEPLOY.md, “Image uploads (R2)”.";
    case "too_large":
      return `That image is larger than ${MAX_UPLOAD_BYTES / 1_000_000} MB.`;
    case "unsupported_image":
      return "Only JPEG, PNG, WebP or GIF images are accepted.";
    case "image_dimensions":
      return `That image is bigger than ${MAX_DIMENSION.toLocaleString("en-US")} px on a side or ${MAX_PIXELS / 1_000_000} megapixels.`;
    case "empty":
      return "That file is empty.";
    case "storage_failed":
      return "The image could not be stored, neither in Cloudflare R2 nor in the site's backup storage. Try again in a moment.";
    case "unauthorized":
      return "Your session has expired. Sign in again.";
    default:
      // No error code at all means the platform answered, not our code: on Cloudflare's free Workers plan that is
      // what happens when handling a large image uses more than the 10 ms of CPU time a request is allowed.
      if (error.status >= 500 && error.body["error"] === undefined) {
        return "The server stopped while handling the image. If it is large, try a smaller one (about 2 MB or less); Cloudflare's free plan limits processing time per request.";
      }
      return "The server could not store the image. Try again.";
  }
}

export const studioApi = {
  session: () => call<SessionInfo>("session"),
  login: (password: string) => call<{ ok: true }>("login", { method: "POST", body: { password } }),
  logout: () => call<{ ok: true; revoked: boolean }>("logout", { method: "POST", body: {} }),
  /** Signs out every device, not just this browser. */
  logoutAll: () => call<{ ok: true }>("logout-all", { method: "POST", body: {} }),
  content: () => call<AdminContent>("content"),
  save: (baseVersion: number, content: PortfolioContent, note = "") =>
    call<AdminContent>("content", { method: "PUT", body: { baseVersion, content, note } }),
  revisions: () => call<{ revisions: Revision[] }>("revisions"),
  upload: uploadImage,
  listMedia: () => call<MediaList>("media"),
  /** Moves a batch of images from the backup storage into R2; call again while `remaining` is above 0. */
  migrateMedia: () => call<MigrateResult>("media/migrate", { method: "POST", body: {} }),
  deleteMedia: (name: string) => call<{ ok: true }>(`media/${encodeURIComponent(name)}`, { method: "DELETE" }),
};

export function issuesFrom(error: ApiError): Issue[] {
  const list = error.body["issues"];
  return Array.isArray(list)
    ? list.filter((i): i is Issue => typeof i === "object" && i !== null && typeof (i as Issue).message === "string")
    : [];
}

export function conflictFrom(error: ApiError): AdminContent | null {
  const current = error.body["current"];
  return typeof current === "object" && current !== null && typeof (current as AdminContent).version === "number"
    ? (current as AdminContent)
    : null;
}
