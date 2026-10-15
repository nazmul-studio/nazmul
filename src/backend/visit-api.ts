// Server-only: POST /api/visit, the public endpoint the page reports to. Plain Request -> Response, called from
// src/server.ts. It must never get in the way of the site: every problem ends in an empty 204, not an error page.
import { MAX_VISIT_BODY, isOutcome, sanitizeReport } from "@/lib/visit-info";
import { clientIp, isSameOrigin } from "./auth";
import { readBytesLimited } from "./body";
import { getStorage } from "./store";
import { recordVisit, updateVisit } from "./visits";

const HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
const empty = (status = 204) => new Response(null, { status, headers: HEADERS });

/** The browser tells servers that its user does not want to be tracked; honour it, as well as the Global Privacy Control. */
const optedOut = (request: Request) => request.headers.get("sec-gpc") === "1" || request.headers.get("dnt") === "1";

export async function handleVisitRequest(request: Request): Promise<Response | null> {
  if (new URL(request.url).pathname !== "/api/visit") return null;
  if (request.method.toUpperCase() !== "POST") return new Response(null, { status: 405, headers: { ...HEADERS, allow: "POST" } });
  try {
    if (!isSameOrigin(request) || optedOut(request)) return empty();
    const kv = await getStorage();
    if (!kv) return empty();
    const bytes = await readBytesLimited(request, MAX_VISIT_BODY);
    if (bytes === null) return empty(413);
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return empty(400);
    }
    const report = sanitizeReport(raw);
    if (!report) return empty(400);
    const ctx = {
      ip: clientIp(request),
      country: request.headers.get("cf-ipcountry") ?? "",
      ua: (request.headers.get("user-agent") ?? "").slice(0, 400),
    };
    const key = (raw as Record<string, unknown>)["key"];
    if (typeof key === "string" && isOutcome((raw as Record<string, unknown>)["outcome"])) {
      await updateVisit(kv, ctx, key, report);
      return empty();
    }
    const result = await recordVisit(kv, ctx, report);
    if ("limited" in result) return empty(429);
    return new Response(JSON.stringify({ key: result.key }), { status: 200, headers: { ...HEADERS, "content-type": "application/json; charset=utf-8" } });
  } catch (error) {
    console.error("visit log error", error);
    return empty();
  }
}
