// Browser-only: tells /api/visit about this visit so the owner can see it in the Studio, and later how the 3D scene went.
// It never blocks or breaks the page: every failure is swallowed. Visitors whose browser sends Do Not Track or the
// Global Privacy Control are not reported at all.
import type { QualityPlan, Signals } from './device-tier';
import { outcomeRank, type Outcome } from './visit-info';

const ENDPOINT = '/api/visit';
/** Share of visits to log, 0 to 1. Lower it if the site gets busy: each logged visit costs two KV writes. */
const SAMPLE_RATE = 1;
type Pending = { outcome: Outcome; reason?: string; bootMs?: number };

let started = false;
let key: string | null = null;
let queued: Pending | null = null;

function optedOut(): boolean {
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean; msDoNotTrack?: string };
  return nav.globalPrivacyControl === true || nav.doNotTrack === '1' || nav.msDoNotTrack === '1' || (window as Window & { doNotTrack?: string }).doNotTrack === '1';
}

type UaData = { platform?: string; getHighEntropyValues?(hints: string[]): Promise<{ model?: string; platformVersion?: string }> };

/** The exact device model and OS version, where the browser shares them (Chromium; on Android this is the real model). */
async function clientHints(): Promise<{ model: string; platform: string }> {
  const data = (navigator as Navigator & { userAgentData?: UaData }).userAgentData;
  if (!data?.getHighEntropyValues) return { model: '', platform: '' };
  try {
    const v = await Promise.race([data.getHighEntropyValues(['model', 'platformVersion']), new Promise<null>((done) => setTimeout(() => done(null), 1000))]);
    const major = parseInt(v?.platformVersion ?? '', 10);
    const name = data.platform ?? '';
    const platform = name === 'Windows' ? (major >= 13 ? 'Windows 11' : 'Windows 10') : name && major > 0 ? `${name} ${major}` : name;
    return { model: v?.model ?? '', platform };
  } catch {
    return { model: '', platform: '' };
  }
}

function post(body: unknown): Promise<Response | undefined> {
  return fetch(ENDPOINT, { method: 'POST', keepalive: true, credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => undefined);
}

/** Once per page load, for the public page only (not the Studio or the login). */
export function startVisitReport(plan: QualityPlan, signals: Signals): void {
  if (started || typeof window === 'undefined' || location.pathname !== '/' || optedOut() || Math.random() >= SAMPLE_RATE) return;
  started = true;
  void (async () => {
    const hints = await clientHints();
    const response = await post({
      tier: plan.tier,
      reason: plan.reason,
      outcome: plan.scene ? 'started' : 'light',
      model: hints.model,
      platform: hints.platform,
      gpu: signals.gpu.renderer,
      memory: signals.memory,
      cores: signals.cores,
      dpr: signals.dpr,
      screen: `${screen.width}x${screen.height}`,
      viewport: `${signals.width}x${signals.height}`,
      net: signals.effectiveType ?? '',
      lang: navigator.language,
    });
    if (response?.ok) {
      try { const data = (await response.json()) as { key?: unknown }; if (typeof data.key === 'string') key = data.key; } catch { /* no body: the visit was not recorded */ }
    }
    if (key && queued) { const pending = queued; queued = null; void post({ key, ...pending }); }
  })();
}

/** How the scene went. Sent right away, or as soon as the visit has its key. */
export function reportOutcome(outcome: Outcome, extra: { reason?: string; bootMs?: number } = {}): void {
  if (!started) return;
  const next: Pending = { outcome, ...extra };
  if (key) { void post({ key, ...next }); return; }
  if (!queued || outcomeRank(outcome) >= outcomeRank(queued.outcome)) queued = { ...queued, ...next };
}
