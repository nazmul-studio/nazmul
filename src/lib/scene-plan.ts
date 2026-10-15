import { useSyncExternalStore } from 'react';
import { atMost, pickTier, planFor, readSignals, tierFromSearch, type QualityPlan } from './device-tier';
import { reportOutcome, startVisitReport } from './visit-report';

/**
 * Which quality plan this visitor's device gets, shared by the scene and the flat fallback book.
 *
 * It also remembers how the last attempts went, so a device that cannot cope stops paying for
 * the 3D scene on every visit:
 *  - a scene that gave up (too slow, context lost, build failed) → light mode for a week
 *  - a scene that never finished loading and never said goodbye (the tab was killed, which is
 *    what an out-of-memory crash looks like) → one such visit caps the tier at `low`,
 *    two in a row switch to light mode
 *  - a scene that ran healthily for a few seconds clears all of it
 */
const KEY = 'kage.scene.v1';
const LITE_MS = 7 * 24 * 60 * 60 * 1000;

type Memory = { pending?: boolean; strikes: number; liteUntil?: number };

function load(): Memory {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Memory | null;
    if (value && typeof value.strikes === 'number') return value;
  } catch { /* storage blocked or corrupt: start fresh */ }
  return { strikes: 0 };
}
function save(memory: Memory) {
  try { localStorage.setItem(KEY, JSON.stringify(memory)); } catch { /* private mode */ }
}

let current: QualityPlan | null = null;
const listeners = new Set<() => void>();
function publish(plan: QualityPlan) {
  current = plan;
  listeners.forEach((listener) => listener());
}

/** Picks the plan once per page load. Safe to call repeatedly; browser only. */
export function detectScenePlan(): QualityPlan {
  if (current) return current;
  const memory = load();
  if (memory.pending) { memory.strikes += 1; memory.pending = false; }
  save(memory);

  const signals = readSignals();
  const picked = pickTier(signals);
  const forced = tierFromSearch(location.search);
  let tier = forced ?? picked.tier;
  let reason = forced ? `forced by ?tier=${forced}` : picked.reason;
  if (!forced) {
    if (memory.liteUntil && memory.liteUntil > Date.now()) { tier = 'lite'; reason = 'the scene gave up on this device recently'; }
    else if (memory.strikes >= 2) { tier = 'lite'; reason = 'the scene did not finish loading on the last two visits'; }
    else if (memory.strikes === 1) { tier = atMost(tier, 'low'); reason += '; the last visit did not finish loading'; }
  }
  const plan = planFor(tier, reason, picked.retry);
  publish(plan);
  startVisitReport(plan, signals);
  return plan;
}

/** Call right before the scene starts building. */
export function beginSceneAttempt() {
  const memory = load();
  memory.pending = true;
  save(memory);
  // A tab that is closed or navigated away is not a crash; only a killed tab skips this.
  addEventListener('pagehide', () => { const m = load(); if (m.pending) { m.pending = false; save(m); } }, { once: true });
}

/** Call once the scene has run smoothly for a few seconds. */
export function sceneAttemptHealthy() {
  save({ strikes: 0 });
  reportOutcome('healthy', { bootMs: lastBootMs });
}

/** The scene drew its first frame, this many milliseconds after it began building. Sent with the "healthy" report, so a visit costs one write to record and one to finish. */
let lastBootMs: number | undefined;
export function sceneReady(bootMs: number) {
  lastBootMs = bootMs;
}

/** The scene could not carry on: switch this visitor to light mode, and remember it. */
export function degradeScene(reason: string) {
  save({ strikes: 0, liteUntil: Date.now() + LITE_MS });
  reportOutcome('gave_up', { reason });
  publish(planFor('lite', reason, true));
}

/** The visitor asked for 3D after all: start gently, from the low tier. */
export function requestScene() {
  save({ strikes: 0 });
  publish(planFor('low', 'requested by the visitor'));
}

export function useScenePlan(): QualityPlan | null {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => current,
    () => null,
  );
}
