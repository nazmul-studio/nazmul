import { describe, expect, it } from 'vitest';
import { MAX_VISITS_PER_IP_PER_HOUR, clearVisits, listVisits, recordVisit, updateVisit } from './visits';
import { sanitizeReport, type VisitReport } from '../lib/visit-info';
import type { KVLike } from './env';

/** A minimal KV with the bits the visitor log uses: metadata and an ascending key list. */
function kvStub(): KVLike & { size(): number; metaBytes(): number } {
  const m = new Map<string, { v: string; metadata?: unknown }>();
  return {
    async get(key, type) { const e = m.get(key); return e ? (type === 'json' ? JSON.parse(e.v) : e.v) : null; },
    async put(key, value, options) { m.set(key, { v: String(value), metadata: options?.metadata }); },
    async delete(key) { m.delete(key); },
    async list(options) {
      const keys = [...m.keys()].filter((k) => k.startsWith(options?.prefix ?? '')).sort().slice(0, options?.limit ?? 1000).map((name) => ({ name, metadata: m.get(name)?.metadata }));
      return { keys, list_complete: true };
    },
    size: () => m.size,
    metaBytes: () => Math.max(0, ...[...m.keys()].filter((k) => k.startsWith('visit:')).map((k) => JSON.stringify(m.get(k)?.metadata).length)),
  };
}

const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const ctx = (ip = '203.0.113.7', ua = ANDROID_UA, country = 'BD') => ({ ip, country, ua });
const report = (over: Record<string, unknown> = {}): VisitReport =>
  sanitizeReport({ tier: 'low', reason: 'score 3', outcome: 'started', model: 'SM-A135F', platform: 'Android 13', gpu: 'Mali-G52', memory: 2, cores: 8, dpr: 2, screen: '360x800', viewport: '360x700', net: '4g', lang: 'bn-BD', ...over })!;

describe('visitor log', () => {
  it('records each visit with the time, IP, model and specs, newest first', async () => {
    const kv = kvStub();
    await recordVisit(kv, ctx('198.51.100.1'), report(), Date.parse('2026-10-14T10:00:00Z'));
    await recordVisit(kv, ctx('198.51.100.2', IPHONE_UA, 'US'), report({ model: '', platform: '', screen: '375x812', dpr: 3, gpu: 'Apple GPU', tier: 'high' }), Date.parse('2026-10-14T11:00:00Z'));
    const { items } = await listVisits(kv);
    expect(items.length).toBe(2);
    expect(items[0]).toMatchObject({ ip: '198.51.100.2', country: 'US', os: 'iOS 17.4', browser: 'Safari 17', model: '', tier: 'high', time: '2026-10-14T11:00:00.000Z' });
    expect(items[0]!.modelGuess).toContain('iPhone X');
    expect(items[1]).toMatchObject({ ip: '198.51.100.1', model: 'SM-A135F', os: 'Android 13', gpu: 'Mali-G52', memory: 2, cores: 8, screen: '360x800' });
  });
  it('ignores a made-up country and keeps the metadata under 1 KB', async () => {
    const kv = kvStub();
    await recordVisit(kv, ctx('2001:0db8:85a3:0000:0000:8a2e:0370:7334', ANDROID_UA, '<script>'), report({ gpu: 'g'.repeat(500), reason: 'r'.repeat(500), model: 'm'.repeat(500) }));
    expect((await listVisits(kv)).items[0]!.country).toBe('');
    expect(kv.metaBytes()).toBeLessThan(1024);
  });
  it('slows down an address that sends too many', async () => {
    const kv = kvStub();
    const busy = ctx('192.0.2.50');
    for (let i = 0; i < MAX_VISITS_PER_IP_PER_HOUR; i++) expect('key' in (await recordVisit(kv, busy, report()))).toBe(true);
    expect(await recordVisit(kv, busy, report())).toEqual({ limited: true });
    expect('key' in (await recordVisit(kv, ctx('203.0.113.99'), report()))).toBe(true);
  });
  it('lets only the same address add the outcome, and never moves it backwards', async () => {
    const kv = kvStub();
    const r = await recordVisit(kv, ctx(), report());
    if (!('key' in r)) throw new Error('expected a key');
    expect(await updateVisit(kv, ctx('203.0.113.200'), r.key, report({ outcome: 'healthy' }))).toBe(false);
    expect(await updateVisit(kv, ctx(), 'visit:../../x', report({ outcome: 'healthy' }))).toBe(false);
    expect(await updateVisit(kv, ctx(), r.key, report({ outcome: 'ready', bootMs: 4200 }))).toBe(true);
    expect(await updateVisit(kv, ctx(), r.key, report({ outcome: 'healthy' }))).toBe(true);
    expect(await updateVisit(kv, ctx(), r.key, report({ outcome: 'ready' }))).toBe(false);
    expect((await listVisits(kv)).items[0]).toMatchObject({ outcome: 'healthy', bootMs: 4200 });
  });
  it('records why the scene gave up', async () => {
    const kv = kvStub();
    const r = await recordVisit(kv, ctx(), report());
    if (!('key' in r)) throw new Error('expected a key');
    await updateVisit(kv, ctx(), r.key, report({ outcome: 'gave_up', reason: 'WebGL context lost' }));
    expect((await listVisits(kv)).items[0]).toMatchObject({ outcome: 'gave_up', reason: 'WebGL context lost', tier: 'low' });
  });
  it('clears the log in batches until it is empty', async () => {
    const kv = kvStub();
    for (let i = 0; i < 95; i++) await recordVisit(kv, ctx(`10.0.${Math.floor(i / 30)}.${i % 30}`), report());
    let rounds = 0, result = await clearVisits(kv);
    while (!result.done && rounds++ < 10) result = await clearVisits(kv);
    expect((await listVisits(kv)).items.length).toBe(0);
  });
});
