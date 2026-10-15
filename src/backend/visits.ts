// Server-only: the visitor log. One KV entry per visit, newest first, each deleting itself after VISIT_TTL_DAYS.
//
// The whole record is also stored as the key's metadata (kept under 1 KB), so the Studio can list a hundred visits
// with a single KV call instead of one read per visit.
import type { KVLike } from "./env";
import {
  VISIT_TTL_SECONDS,
  describeUa,
  fitMetadata,
  iphoneGuess,
  outcomeRank,
  toRow,
  type StoredVisit,
  type VisitReport,
  type VisitRow,
} from "../lib/visit-info";

const PREFIX = "visit:";
export const MAX_VISITS_PER_IP_PER_HOUR = 40;
export const LIST_PAGE = 100;
const CLEAR_BATCH = 40; // stays well inside a Worker's per-request KV operation budget
const KEY_PATTERN = /^visit:\d{13}:[a-z0-9]{10}$/;

/** What the server knows about the request itself, as opposed to what the browser reports. */
export type VisitContext = { ip: string; country: string; ua: string };

function randomId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => (b % 36).toString(36)).join("");
}

/** Newest first: the key counts down, so an ascending KV list returns the latest visit at the top. */
function newKey(now: number): string {
  return `${PREFIX}${String(9_999_999_999_999 - now).padStart(13, "0")}:${randomId()}`;
}

function build(ctx: VisitContext, r: VisitReport, now: number): StoredVisit {
  const ua = describeUa(ctx.ua);
  return fitMetadata({
    t: new Date(now).toISOString(),
    ip: ctx.ip.slice(0, 64),
    cc: /^[A-Z]{2}$/.test(ctx.country) ? ctx.country : "",
    os: r.platform || ua.os,
    br: ua.browser,
    mo: r.model,
    mg: r.model ? "" : iphoneGuess(r.screen, r.dpr, ctx.ua),
    ti: r.tier,
    re: r.reason,
    oc: r.outcome,
    gp: r.gpu,
    me: r.memory,
    co: r.cores,
    dp: r.dpr,
    sc: r.screen,
    vp: r.viewport,
    nt: r.net,
    lg: r.lang,
    bt: r.bootMs,
  });
}

async function write(kv: KVLike, key: string, visit: StoredVisit): Promise<void> {
  await kv.put(key, JSON.stringify(visit), { expirationTtl: VISIT_TTL_SECONDS, metadata: visit });
}

// A brake for a public endpoint, kept in memory rather than in KV: KV allows only so many writes a day (1,000 on the free
// plan, as far as I know), and every one spent counting would be one less for visits and for publishing the site.
// Each Worker instance counts for itself, which is enough to stop one address from flooding the log.
const sent = new Map<string, { n: number; until: number }>();
function allowed(ip: string, now: number): boolean {
  if (sent.size > 5000) for (const [k, v] of sent) if (v.until < now) sent.delete(k);
  const entry = sent.get(ip);
  if (!entry || entry.until < now) { sent.set(ip, { n: 1, until: now + 3_600_000 }); return true; }
  if (entry.n >= MAX_VISITS_PER_IP_PER_HOUR) return false;
  entry.n += 1;
  return true;
}

/** Records a new visit (one KV write). `limited` when this IP address has sent too many in the last hour. */
export async function recordVisit(
  kv: KVLike,
  ctx: VisitContext,
  report: VisitReport,
  now = Date.now(),
): Promise<{ key: string } | { limited: true }> {
  if (!allowed(ctx.ip, now)) return { limited: true };
  const key = newKey(now);
  await write(kv, key, build(ctx, report, now));
  return { key };
}

/**
 * Adds the outcome to a visit the same browser recorded earlier. Only the same IP address may update an entry, and an
 * outcome never goes backwards (a late "ready" cannot overwrite "healthy").
 */
export async function updateVisit(kv: KVLike, ctx: VisitContext, key: string, report: VisitReport): Promise<boolean> {
  if (!KEY_PATTERN.test(key)) return false;
  const existing = (await kv.get(key, "json")) as StoredVisit | null;
  if (!existing || existing.ip !== ctx.ip.slice(0, 64)) return false;
  if (outcomeRank(report.outcome) < outcomeRank(existing.oc)) return false;
  const next: StoredVisit = fitMetadata({
    ...existing,
    oc: report.outcome,
    re: report.reason || existing.re,
    bt: report.bootMs ?? existing.bt,
  });
  await write(kv, key, next);
  return true;
}

const isStored = (v: unknown): v is StoredVisit =>
  typeof v === "object" && v !== null && typeof (v as StoredVisit).t === "string" && typeof (v as StoredVisit).ip === "string";

export type VisitList = { items: VisitRow[]; nextCursor: string | null; supported: boolean };

export async function listVisits(kv: KVLike, cursor?: string, limit = LIST_PAGE): Promise<VisitList> {
  if (!kv.list) return { items: [], nextCursor: null, supported: false };
  const page = await kv.list({ prefix: PREFIX, limit, ...(cursor ? { cursor } : {}) });
  const items = page.keys.filter((k) => KEY_PATTERN.test(k.name) && isStored(k.metadata)).map((k) => toRow(k.name, k.metadata as StoredVisit));
  return { items, nextCursor: page.list_complete ? null : (page.cursor ?? null), supported: true };
}

/** Deletes one batch of the log; call again until `done`. (KV can take up to a minute to stop listing deleted keys.) */
export async function clearVisits(kv: KVLike): Promise<{ deleted: number; done: boolean }> {
  if (!kv.list) return { deleted: 0, done: true };
  const page = await kv.list({ prefix: PREFIX, limit: CLEAR_BATCH });
  await Promise.all(page.keys.map((k) => kv.delete(k.name)));
  return { deleted: page.keys.length, done: page.keys.length < CLEAR_BATCH };
}
