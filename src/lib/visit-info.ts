/**
 * Shared by the browser (what it reports about itself) and the server (what it stores and the Studio shows).
 * No imports, so it runs anywhere and is easy to test.
 */

/** How long a visit stays in the log before it deletes itself. */
export const VISIT_TTL_DAYS = 30;
export const VISIT_TTL_SECONDS = VISIT_TTL_DAYS * 24 * 60 * 60;
export const MAX_VISIT_BODY = 4096;

/**
 * How the visit went for the 3D scene.
 *  started  the page opened and the scene began; no result ever arrived (left early, or the tab died)
 *  ready    the scene drew its first frame
 *  healthy  it then ran smoothly for a few seconds
 *  gave_up  it stopped and the page fell back to light mode
 *  light    this device never got the scene (light mode from the start)
 */
export type Outcome = 'started' | 'ready' | 'healthy' | 'gave_up' | 'light';
const RANK: Record<Outcome, number> = { started: 0, light: 1, ready: 2, healthy: 3, gave_up: 3 };
export const isOutcome = (v: unknown): v is Outcome => typeof v === 'string' && v in RANK;
export const outcomeRank = (o: Outcome) => RANK[o];

export const OUTCOME_LABEL: Record<Outcome, string> = {
  started: 'No result (left early, or the tab crashed)',
  ready: '3D started',
  healthy: '3D ran smoothly',
  gave_up: '3D gave up, light mode',
  light: 'Light mode from the start',
};

/** What the browser tells us about itself. Every field is clamped by `sanitizeReport`. */
export type VisitReport = {
  tier: string;
  reason: string;
  outcome: Outcome;
  /** Exact model from User-Agent Client Hints (Chromium on Android only). */
  model: string;
  /** e.g. "Android 13", "Windows 11", "macOS 14". */
  platform: string;
  gpu: string;
  memory?: number;
  cores?: number;
  dpr: number;
  /** "390x844" */
  screen: string;
  viewport: string;
  net: string;
  lang: string;
  bootMs?: number;
};

/** What the Studio shows for one visit. */
export type VisitRow = {
  key: string;
  time: string;
  ip: string;
  country: string;
  os: string;
  browser: string;
  model: string;
  /** A best guess when the browser will not say (iPhones); empty when there is none. */
  modelGuess: string;
  tier: string;
  reason: string;
  outcome: Outcome;
  gpu: string;
  memory?: number;
  cores?: number;
  dpr: number;
  screen: string;
  viewport: string;
  net: string;
  lang: string;
  bootMs?: number;
};

/** The same data under short names, because a KV key's metadata may hold only 1 KB. */
export type StoredVisit = {
  t: string; ip: string; cc: string; os: string; br: string; mo: string; mg: string;
  ti: string; re: string; oc: Outcome; gp: string; me?: number; co?: number; dp: number;
  sc: string; vp: string; nt: string; lg: string; bt?: number;
};

// ---------------------------------------------------------------- cleaning what the browser sends

const clean = (v: unknown, max: number) =>
  typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
const num = (v: unknown, min: number, max: number) =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? Math.round(v * 100) / 100 : undefined;
const size = (v: unknown) => (typeof v === 'string' && /^\d{2,5}x\d{2,5}$/.test(v) ? v : '');

/** Accepts only what a real browser would send; anything else is dropped or clamped. Null if it is not a report at all. */
export function sanitizeReport(raw: unknown): VisitReport | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  return {
    tier: ['high', 'mid', 'low', 'lite'].includes(r['tier'] as string) ? (r['tier'] as string) : '',
    reason: clean(r['reason'], 80),
    outcome: isOutcome(r['outcome']) ? r['outcome'] : 'started',
    model: clean(r['model'], 48),
    platform: clean(r['platform'], 32),
    gpu: clean(r['gpu'], 90),
    memory: num(r['memory'], 0.25, 512),
    cores: num(r['cores'], 1, 512),
    dpr: num(r['dpr'], 0.5, 8) ?? 1,
    screen: size(r['screen']),
    viewport: size(r['viewport']),
    net: clean(r['net'], 10),
    lang: clean(r['lang'], 16),
    bootMs: num(r['bootMs'], 0, 600_000),
  };
}

// ---------------------------------------------------------------- reading the user agent

/** Operating system and browser from the User-Agent header. Chrome freezes parts of it, so a client hint wins when sent. */
export function describeUa(ua: string): { os: string; browser: string } {
  const u = ua || '';
  let os = 'Unknown OS';
  let m: RegExpExecArray | null;
  if ((m = /Android (\d+(?:\.\d+)?)/.exec(u))) os = `Android ${m[1]}`;
  else if (/iPhone|iPad|iPod/.test(u)) {
    m = /OS (\d+)[_.](\d+)/.exec(u);
    os = m ? `iOS ${m[1]}.${m[2]}` : 'iOS';
  } else if ((m = /Windows NT (\d+\.\d+)/.exec(u))) {
    const names: Record<string, string> = { '10.0': 'Windows 10/11', '6.3': 'Windows 8.1', '6.2': 'Windows 8', '6.1': 'Windows 7' };
    os = names[m[1] as string] ?? `Windows NT ${m[1]}`;
  } else if (/CrOS/.test(u)) os = 'ChromeOS';
  else if (/Mac OS X/.test(u)) os = 'macOS';
  else if (/Linux/.test(u)) os = 'Linux';

  const pick = (re: RegExp, name: string) => { const x = re.exec(u); return x ? `${name} ${x[1]}` : null; };
  const browser =
    pick(/Edg(?:A|iOS)?\/(\d+)/, 'Edge') ?? pick(/OPR\/(\d+)/, 'Opera') ?? pick(/SamsungBrowser\/(\d+)/, 'Samsung Internet') ??
    pick(/CriOS\/(\d+)/, 'Chrome (iOS)') ?? pick(/FxiOS\/(\d+)/, 'Firefox (iOS)') ?? pick(/Firefox\/(\d+)/, 'Firefox') ??
    pick(/(?:Chrome|Chromium)\/(\d+)/, 'Chrome') ?? (/Safari\//.test(u) ? pick(/Version\/(\d+)/, 'Safari') ?? 'Safari' : 'Unknown browser');
  return { os, browser };
}

/**
 * iPhones never reveal their model to a web page. Screen size plus pixel density narrows it to a family, which is
 * the most that can be said honestly; the result says "likely" and lists the candidates.
 */
const IPHONES: Record<string, string> = {
  '320x568@2': 'iPhone 5 / 5s / SE (1st gen)',
  '375x667@2': 'iPhone 6 / 7 / 8 / SE (2nd or 3rd gen)',
  '414x736@3': 'iPhone 6 Plus / 7 Plus / 8 Plus',
  '375x812@3': 'iPhone X / XS / 11 Pro / 12 mini / 13 mini',
  '414x896@2': 'iPhone XR / 11',
  '414x896@3': 'iPhone XS Max / 11 Pro Max',
  '390x844@3': 'iPhone 12 / 12 Pro / 13 / 13 Pro / 14',
  '428x926@3': 'iPhone 12 Pro Max / 13 Pro Max / 14 Plus',
  '393x852@3': 'iPhone 14 Pro / 15 / 15 Pro / 16',
  '430x932@3': 'iPhone 14 Pro Max / 15 Plus / 15 Pro Max / 16 Plus',
  '402x874@3': 'iPhone 16 Pro',
  '440x956@3': 'iPhone 16 Pro Max',
};
export function iphoneGuess(screen: string, dpr: number, ua: string): string {
  if (!/iPhone/.test(ua)) return '';
  const m = /^(\d+)x(\d+)$/.exec(screen);
  if (!m) return '';
  const w = Math.min(Number(m[1]), Number(m[2]));
  const h = Math.max(Number(m[1]), Number(m[2]));
  const hit = IPHONES[`${w}x${h}@${Math.round(dpr)}`];
  return hit ? `likely ${hit}` : '';
}

// ---------------------------------------------------------------- the stored form

const byteLength = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;

/** KV metadata is capped at 1024 bytes; shorten the long free-text fields until the record fits with room to spare. */
export function fitMetadata(visit: StoredVisit): StoredVisit {
  const out: StoredVisit = { ...visit };
  const order: (keyof StoredVisit)[] = ['gp', 're', 'mo', 'mg', 'br', 'os'];
  for (let pass = 0; pass < 6 && byteLength(out) > 900; pass++) {
    for (const k of order) {
      const v = out[k];
      if (typeof v === 'string' && v.length > 12) (out as Record<string, unknown>)[k] = v.slice(0, Math.max(12, Math.floor(v.length * 0.7)));
      if (byteLength(out) <= 900) break;
    }
  }
  return out;
}

export function toRow(key: string, s: StoredVisit): VisitRow {
  return {
    key, time: s.t, ip: s.ip, country: s.cc, os: s.os, browser: s.br, model: s.mo, modelGuess: s.mg, tier: s.ti,
    reason: s.re, outcome: s.oc, gpu: s.gp, memory: s.me, cores: s.co, dpr: s.dp, screen: s.sc, viewport: s.vp,
    net: s.nt, lang: s.lg, bootMs: s.bt,
  };
}
