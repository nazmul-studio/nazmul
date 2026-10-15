// Server-only: the admin API behind /api/studio/*. Plain Request -> Response, called from
// src/server.ts before the framework handler, so it does not depend on router generation.
import { initialContent } from "@/lib/content-model";
import { LIMITS, MAX_CONTENT_BYTES, cleanNote, isRecord, parseContent } from "@/lib/content-schema";
import { MAX_UPLOAD_BYTES, isMediaName, mediaUsage } from "@/lib/media";
import {
  clearSessionCookie,
  clientIp,
  isSameOrigin,
  isSecureRequest,
  issueSession,
  loadSecrets,
  passwordMatches,
  readSessionData,
} from "./auth";
import { readBytesLimited } from "./body";
import { deleteMedia, getMediaStores, listMedia, migrateToR2, storeImage } from "./media";
import { clearVisits, listVisits } from "./visits";
import {
  FAILURE_WINDOW,
  MAX_FAILURES,
  clearFailures,
  countFailures,
  getStorage,
  isSessionRevoked,
  readRecord,
  readRevisions,
  recordFailure,
  revokeAllSessions,
  revokeSession,
  writeContent,
} from "./store";

const PREFIX = "/api/studio/";
const MAX_LOGIN_BODY = 4096; // a password and nothing else; read before anyone is authenticated

function json(body: unknown, status = 200, extra?: HeadersInit): Response {
  const headers = new Headers(extra);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  return new Response(JSON.stringify(body), { status, headers });
}

const notAllowed = (allow: string) => json({ error: "method_not_allowed" }, 405, { allow });
const forbidden = () => json({ error: "forbidden" }, 403);

async function readTextLimited(request: Request, max: number): Promise<string | null> {
  const bytes = await readBytesLimited(request, max);
  return bytes === null ? null : new TextDecoder().decode(bytes);
}

async function readJsonBody(
  request: Request,
  max = MAX_CONTENT_BYTES, // books with many pages; images are references, never bytes
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
    return { ok: false, response: json({ error: "unsupported_media_type" }, 415) };
  }
  const text = await readTextLimited(request, max);
  if (text === null) return { ok: false, response: json({ error: "too_large" }, 413) };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, response: json({ error: "bad_json" }, 400) };
  }
}

/** The signed-in session, or null: a genuine cookie that has not been revoked by a sign-out. */
async function currentSession(request: Request, sessionSecret: string, kv: Awaited<ReturnType<typeof getStorage>>) {
  const data = await readSessionData(request, sessionSecret);
  if (!data) return null;
  if (!kv) return null; // cannot confirm the session is still valid, so do not trust it
  return (await isSessionRevoked(kv, data)) ? null : data;
}

/** Returns a response when the caller may not proceed, or null when they are signed in. */
async function authorize(request: Request): Promise<Response | null> {
  const secrets = await loadSecrets();
  if (!secrets.ready) return json({ error: "not_configured", missing: secrets.missing, hints: secrets.hints }, 503);
  const kv = await getStorage();
  if (!kv) return json({ error: "not_configured", missing: ["CONTENT (KV namespace binding)"] }, 503);
  if (!(await currentSession(request, secrets.sessionSecret, kv))) return json({ error: "unauthorized" }, 401);
  return null;
}

async function session(request: Request): Promise<Response> {
  const secrets = await loadSecrets();
  const storage = await getStorage();
  if (!secrets.ready || !storage) {
    const missing = secrets.ready ? [] : [...secrets.missing];
    if (!storage) missing.push("CONTENT (KV namespace binding)");
    return json({ authenticated: false, configured: false, missing, hints: secrets.ready ? [] : secrets.hints });
  }
  const current = await currentSession(request, secrets.sessionSecret, storage);
  return json({ authenticated: current !== null, configured: true });
}

async function login(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return forbidden();
  const secrets = await loadSecrets();
  const kv = await getStorage();
  if (!secrets.ready || !kv) {
    const missing = secrets.ready ? [] : [...secrets.missing];
    if (!kv) missing.push("CONTENT (KV namespace binding)");
    return json({ error: "not_configured", missing, hints: secrets.ready ? [] : secrets.hints }, 503);
  }
  const ip = clientIp(request);
  if ((await countFailures(kv, ip)) >= MAX_FAILURES) {
    return json({ error: "rate_limited" }, 429, { "retry-after": String(FAILURE_WINDOW) });
  }
  const body = await readJsonBody(request, MAX_LOGIN_BODY);
  if (!body.ok) return body.response;
  const password = isRecord(body.value) && typeof body.value["password"] === "string" ? body.value["password"] : "";
  if (!(await passwordMatches(password, secrets.password))) {
    const failures = await recordFailure(kv, ip);
    return json({ error: "invalid_credentials", attemptsLeft: Math.max(0, MAX_FAILURES - failures) }, 401);
  }
  await clearFailures(kv, ip);
  const headers = new Headers();
  headers.append("set-cookie", await issueSession(secrets.sessionSecret, isSecureRequest(request)));
  return json({ ok: true }, 200, headers);
}

/**
 * Signs this browser out and, when it can, revokes the session on the server too, so a copy of the cookie
 * (stolen, or left on another machine) stops working. `revoked` tells the caller whether that part worked;
 * the cookie is cleared either way.
 */
async function logout(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return forbidden();
  let revoked = false;
  try {
    const secrets = await loadSecrets();
    const kv = await getStorage();
    if (secrets.ready && kv) {
      const data = await readSessionData(request, secrets.sessionSecret);
      if (data) {
        await revokeSession(kv, data);
        revoked = true;
      }
    }
  } catch (error) {
    console.error("could not revoke session", error);
  }
  const headers = new Headers();
  headers.append("set-cookie", clearSessionCookie(isSecureRequest(request)));
  return json({ ok: true, revoked }, 200, headers);
}

/** Signs out every device: all sessions issued up to now stop working. Requires a valid session itself. */
async function logoutAll(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return forbidden();
  const denied = await authorize(request);
  if (denied) return denied;
  const kv = await getStorage();
  if (!kv) return json({ error: "not_configured" }, 503);
  await revokeAllSessions(kv);
  const headers = new Headers();
  headers.append("set-cookie", clearSessionCookie(isSecureRequest(request)));
  return json({ ok: true }, 200, headers);
}

async function getContent(request: Request): Promise<Response> {
  const denied = await authorize(request);
  if (denied) return denied;
  const kv = await getStorage();
  if (!kv) return json({ error: "storage_unavailable" }, 503);
  const record = await readRecord(kv);
  return json(record ?? { version: 0, updatedAt: null, note: "", content: initialContent });
}

async function putContent(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return forbidden();
  const denied = await authorize(request);
  if (denied) return denied;
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const value = body.value;
  if (!isRecord(value) || typeof value["baseVersion"] !== "number" || !Number.isInteger(value["baseVersion"])) {
    return json({ error: "bad_request" }, 400);
  }
  const parsed = parseContent(value["content"]);
  if (parsed.issues.length > 0) return json({ error: "validation", issues: parsed.issues.slice(0, 50) }, 422);
  const note = cleanNote(value["note"]);
  if (note === null) {
    return json({ error: "validation", issues: [{ path: "note", message: `must be text of at most ${LIMITS.note} characters` }] }, 422);
  }
  const kv = await getStorage();
  if (!kv) return json({ error: "storage_unavailable" }, 503);
  const current = await readRecord(kv);
  if (value["baseVersion"] !== (current?.version ?? 0)) {
    return json({ error: "conflict", current: current ?? { version: 0, updatedAt: null, note: "", content: initialContent } }, 409);
  }
  return json(await writeContent(kv, current, parsed.content, note));
}

async function revisions(request: Request): Promise<Response> {
  const denied = await authorize(request);
  if (denied) return denied;
  const kv = await getStorage();
  if (!kv) return json({ error: "storage_unavailable" }, 503);
  return json({ revisions: await readRevisions(kv) });
}

// --- visitor log (written by the public page through ./visit-api.ts, read here) ---

async function visits(request: Request): Promise<Response> {
  const denied = await authorize(request);
  if (denied) return denied;
  const kv = await getStorage();
  if (!kv) return json({ error: "storage_unavailable" }, 503);
  const cursor = new URL(request.url).searchParams.get("cursor") ?? undefined;
  return json(await listVisits(kv, cursor && cursor.length <= 512 ? cursor : undefined));
}

/** POST /api/studio/visits/clear: deletes one batch of the log. Call again until `done`. */
async function clearVisitLog(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return forbidden();
  const denied = await authorize(request);
  if (denied) return denied;
  const kv = await getStorage();
  if (!kv) return json({ error: "storage_unavailable" }, 503);
  return json(await clearVisits(kv));
}

// --- images (R2 first, KV as the fallback; see ./media.ts) ---

const MEDIA_NOT_CONFIGURED = { error: "media_not_configured" } as const;

/**
 * POST /api/studio/upload: the raw image bytes as the body. The bytes, not the headers, decide what it is. If R2 is
 * missing or fails the image is kept in KV instead and the response says so (storage: "kv"), so the Studio can tell
 * the owner while the image still shows up in the book.
 */
async function uploadImage(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return forbidden();
  const denied = await authorize(request);
  if (denied) return denied;
  const stores = await getMediaStores();
  if (!stores.r2 && !stores.kv) return json(MEDIA_NOT_CONFIGURED, 503);
  const bytes = await readBytesLimited(request, MAX_UPLOAD_BYTES);
  if (bytes === null) return json({ error: "too_large", max: MAX_UPLOAD_BYTES }, 413);
  const result = await storeImage(stores, bytes);
  if (!result.ok) {
    const status = result.error === "unsupported_image" ? 415 : result.error === "empty" ? 400 : result.error === "storage_failed" ? 502 : 422;
    return json({ error: result.error }, status);
  }
  const { ok: _ok, ...body } = result;
  return json(body, body.existing ? 200 : 201);
}

async function listImages(request: Request): Promise<Response> {
  const denied = await authorize(request);
  if (denied) return denied;
  const stores = await getMediaStores();
  if (!stores.r2 && !stores.kv) return json(MEDIA_NOT_CONFIGURED, 503);
  return json(await listMedia(stores));
}

/** POST /api/studio/media/migrate: moves a batch of images from the KV fallback into R2. Call until remaining is 0. */
async function moveImagesToR2(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return forbidden();
  const denied = await authorize(request);
  if (denied) return denied;
  const stores = await getMediaStores();
  if (!stores.r2) return json({ error: "r2_not_connected" }, 503);
  return json(await migrateToR2(stores));
}

/**
 * DELETE /api/studio/media/<name>. Refused while the published site uses the image. (Versions kept in the history
 * are not checked: restoring an old version after deleting its image shows that image missing.)
 */
async function deleteImage(request: Request, name: string): Promise<Response> {
  if (!isSameOrigin(request)) return forbidden();
  const denied = await authorize(request);
  if (denied) return denied;
  if (!isMediaName(name)) return json({ error: "not_found" }, 404);
  const stores = await getMediaStores();
  if (!stores.r2 && !stores.kv) return json(MEDIA_NOT_CONFIGURED, 503);
  const record = stores.kv ? await readRecord(stores.kv) : null;
  const uses = record ? mediaUsage(record.content).get(name) : undefined;
  if (uses && uses.size > 0) return json({ error: "in_use", usedBy: [...uses] }, 409);
  return (await deleteMedia(stores, name)) ? json({ ok: true }) : json({ error: "not_found" }, 404);
}

/** Handles /api/studio/* requests; returns null for anything else. */
export async function handleStudioApi(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(PREFIX)) return null;
  const route = url.pathname.slice(PREFIX.length).replace(/\/+$/, "");
  const method = request.method.toUpperCase();
  try {
    switch (route) {
      case "session":
        return method === "GET" ? await session(request) : notAllowed("GET");
      case "login":
        return method === "POST" ? await login(request) : notAllowed("POST");
      case "logout":
        return method === "POST" ? await logout(request) : notAllowed("POST");
      case "logout-all":
        return method === "POST" ? await logoutAll(request) : notAllowed("POST");
      case "content":
        if (method === "GET") return await getContent(request);
        if (method === "PUT") return await putContent(request);
        return notAllowed("GET, PUT");
      case "revisions":
        return method === "GET" ? await revisions(request) : notAllowed("GET");
      case "upload":
        return method === "POST" ? await uploadImage(request) : notAllowed("POST");
      case "visits":
        return method === "GET" ? await visits(request) : notAllowed("GET");
      case "visits/clear":
        return method === "POST" ? await clearVisitLog(request) : notAllowed("POST");
      case "media":
        return method === "GET" ? await listImages(request) : notAllowed("GET");
      case "media/migrate":
        return method === "POST" ? await moveImagesToR2(request) : notAllowed("POST");
      default:
        if (route.startsWith("media/")) {
          if (method !== "DELETE") return notAllowed("DELETE");
          let name = "";
          try {
            name = decodeURIComponent(route.slice("media/".length));
          } catch {
            /* falls through to not_found */
          }
          return await deleteImage(request, name);
        }
        return json({ error: "not_found" }, 404);
    }
  } catch (error) {
    console.error("studio api error", error);
    return json({ error: "server_error" }, 500);
  }
}
