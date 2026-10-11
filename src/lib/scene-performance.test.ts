import { describe, expect, it } from 'vitest';
import { chapterProgress, scenePixelRatio } from './scene-performance';

describe('scene performance policies', () => {
  it('caps mobile rendering at the requested 1.5 DPR', () => {
    expect(scenePixelRatio(3, true)).toBe(1.5);
    expect(scenePixelRatio(1, true)).toBe(1);
    expect(scenePixelRatio(3, false)).toBe(2);
  });
  it('maps cached chapter positions continuously in either scroll direction', () => {
    const tops = [0, 800, 1800, 2600, 3500];
    expect(chapterProgress(2200, tops)).toBe(2.5);
    expect(chapterProgress(1300, tops)).toBe(1.5);
    expect(chapterProgress(-10, tops)).toBe(0);
    expect(chapterProgress(5000, tops)).toBe(4);
  });
});