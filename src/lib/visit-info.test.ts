import { describe, expect, it } from 'vitest';
import { describeUa, fitMetadata, iphoneGuess, sanitizeReport, type StoredVisit } from './visit-info';

const ANDROID = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';

describe('sanitizeReport', () => {
  it('rejects anything that is not a report object', () => {
    expect(sanitizeReport(null)).toBeNull();
    expect(sanitizeReport('x')).toBeNull();
    expect(sanitizeReport([1])).toBeNull();
  });
  it('clamps text, drops unknown values and keeps numbers in range', () => {
    const r = sanitizeReport({ tier: 'ultra', gpu: 'x'.repeat(500), model: 'SM-A135F\n\u0000', outcome: 'hacked', screen: '390x844', viewport: 'big', dpr: 99, memory: 4, cores: -2, bootMs: 1234 })!;
    expect(r.tier).toBe('');
    expect(r.gpu.length).toBe(90);
    expect(r.model).toBe('SM-A135F');
    expect(r.outcome).toBe('started');
    expect(r.screen).toBe('390x844');
    expect(r.viewport).toBe('');
    expect(r.dpr).toBe(1);
    expect(r.memory).toBe(4);
    expect(r.cores).toBeUndefined();
    expect(r.bootMs).toBe(1234);
  });
});

describe('describeUa', () => {
  it('reads Android Chrome, iPhone Safari and common others', () => {
    expect(describeUa(ANDROID)).toEqual({ os: 'Android 10', browser: 'Chrome 120' });
    expect(describeUa(IPHONE)).toEqual({ os: 'iOS 17.4', browser: 'Safari 17' });
    expect(describeUa('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/119.0.0.0 Safari/537.36 Edg/119.0.0.0').browser).toBe('Edge 119');
    expect(describeUa('Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 Chrome/118.0.0.0 Mobile Safari/537.36 SamsungBrowser/23.0').browser).toBe('Samsung Internet 23');
    expect(describeUa('Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/120.0.0.0 Mobile/15E148 Safari/604.1').browser).toBe('Chrome (iOS) 120');
    expect(describeUa('')).toEqual({ os: 'Unknown OS', browser: 'Unknown browser' });
  });
});

describe('iphoneGuess', () => {
  it('names the family for a known screen, in either orientation, and only for iPhones', () => {
    expect(iphoneGuess('375x812', 3, IPHONE)).toContain('iPhone X / XS / 11 Pro');
    expect(iphoneGuess('812x375', 3, IPHONE)).toContain('11 Pro');
    expect(iphoneGuess('375x812', 3, ANDROID)).toBe('');
    expect(iphoneGuess('999x999', 3, IPHONE)).toBe('');
  });
});

describe('fitMetadata', () => {
  it('keeps the worst-case record under the 1 KB KV metadata limit', () => {
    const big = (n: number) => 'é'.repeat(n);
    const visit: StoredVisit = { t: new Date().toISOString(), ip: '2001:0db8:85a3:0000:0000:8a2e:0370:7334', cc: 'BD', os: big(32), br: big(40), mo: big(48), mg: big(80), ti: 'low', re: big(80), oc: 'started', gp: big(90), me: 4, co: 8, dp: 2.75, sc: '1080x2400', vp: '412x915', nt: '4g', lg: 'bn-BD', bt: 12345 };
    expect(new TextEncoder().encode(JSON.stringify(fitMetadata(visit))).length).toBeLessThan(1000);
  });
});
