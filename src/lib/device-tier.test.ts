import { describe, expect, it } from 'vitest';
import { atMost, pickTier, pixelRatioFor, planFor, tierFromSearch, type Signals } from './device-tier';

const gpu = (renderer: string, over: Partial<Signals['gpu']> = {}): Signals['gpu'] => ({ webgl: 2, halfFloatTarget: true, maxTexture: 8192, renderer, ...over });
const device = (over: Partial<Signals> = {}): Signals => ({ dpr: 2, width: 390, height: 844, saveData: false, gpu: gpu('Apple GPU'), ...over });

describe('device tier', () => {
  it('gives a recent iPhone the full scene', () => {
    expect(pickTier(device({ cores: 6, dpr: 3, width: 375, height: 812 })).tier).toBe('high');
  });
  it('gives a 2 GB budget Android the low tier', () => {
    const phone = device({ memory: 2, cores: 8, gpu: gpu('ANGLE (ARM, Mali-G52 MC2, OpenGL ES 3.2)') });
    expect(pickTier(phone).tier).toBe('low');
  });
  it('gives a 4 GB mid-range Android the mid tier', () => {
    const phone = device({ memory: 4, cores: 8, gpu: gpu('Adreno (TM) 618') });
    expect(pickTier(phone).tier).toBe('mid');
  });
  it('gives a desktop with a discrete GPU the high tier, even on a big hi-dpi screen', () => {
    const desktop = device({ memory: 8, cores: 8, dpr: 2, width: 1920, height: 1080, gpu: gpu('NVIDIA GeForce RTX 3060') });
    expect(pickTier(desktop).tier).toBe('high');
  });
  it('goes straight to light mode when the scene cannot run at all', () => {
    expect(pickTier(device({ gpu: gpu('', { webgl: 0 }) }))).toMatchObject({ tier: 'lite', retry: false });
    expect(pickTier(device({ gpu: gpu('Mali-G52', { halfFloatTarget: false }) }))).toMatchObject({ tier: 'lite', retry: false });
    expect(pickTier(device({ gpu: gpu('Mali-G52', { maxTexture: 1024 }) })).tier).toBe('lite');
  });
  it('goes to light mode on old or software GPUs, but not on current budget ones', () => {
    expect(pickTier(device({ gpu: gpu('Mali-400 MP') })).tier).toBe('lite');
    expect(pickTier(device({ gpu: gpu('Adreno (TM) 306') })).tier).toBe('lite');
    expect(pickTier(device({ gpu: gpu('Google SwiftShader') })).tier).toBe('lite');
    expect(pickTier(device({ memory: 4, cores: 8, gpu: gpu('Adreno (TM) 610') })).tier).not.toBe('lite');
  });
  it('goes to light mode for data saver, slow networks, very old Chromium and 1 GB devices', () => {
    expect(pickTier(device({ saveData: true })).tier).toBe('lite');
    expect(pickTier(device({ effectiveType: '2g' })).tier).toBe('lite');
    expect(pickTier(device({ chrome: 90 })).tier).toBe('lite');
    expect(pickTier(device({ memory: 1 })).tier).toBe('lite');
  });
  it('treats missing signals (Safari, Firefox) as a decent device rather than a weak one', () => {
    expect(pickTier(device({ memory: undefined, cores: undefined })).tier).not.toBe('low');
  });
});

describe('quality plans', () => {
  it('caps resolution by tier and by pixel budget', () => {
    expect(pixelRatioFor(planFor('high', ''), 3, 375, 812)).toBe(2);
    expect(pixelRatioFor(planFor('low', ''), 3, 360, 760)).toBe(1);
    expect(pixelRatioFor(planFor('mid', ''), 2, 1440, 900)).toBeCloseTo(1.36, 2);
    expect(pixelRatioFor(planFor('high', ''), Number.NaN, 390, 844)).toBe(1);
  });
  it('only the light plan skips the scene, and only capped tiers limit the frame rate', () => {
    expect(planFor('lite', '').scene).toBe(false);
    expect(planFor('low', '').maxFps).toBe(30);
    expect(planFor('high', '').maxFps).toBe(0);
    expect(planFor('low', '').retry).toBe(false);
    expect(planFor('lite', '', true).retry).toBe(true);
  });
  it('numbers each attempt so a fresh canvas can be mounted', () => {
    expect(planFor('low', '').gen).toBeLessThan(planFor('low', '').gen);
  });
  it('reads ?tier= and lowers a tier without ever raising it', () => {
    expect(tierFromSearch('?tier=lite')).toBe('lite');
    expect(tierFromSearch('?tier=ultra')).toBeNull();
    expect(tierFromSearch('')).toBeNull();
    expect(atMost('high', 'low')).toBe('low');
    expect(atMost('lite', 'low')).toBe('lite');
  });
});
