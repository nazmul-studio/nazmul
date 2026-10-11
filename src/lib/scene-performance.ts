/** Pure policies shared by scroll integration and the browser-only scene. */
export function chapterProgress(y: number, tops: readonly number[]): number {
  if (tops.length < 2 || y <= (tops[0] ?? 0)) return 0;
  for (let i = 0; i < tops.length - 1; i++) {
    const a = tops[i] ?? 0, b = tops[i + 1] ?? a;
    if (y < b) return i + Math.max(0, Math.min(1, (y - a) / Math.max(1, b - a)));
  }
  return tops.length - 1;
}

export function scenePixelRatio(deviceRatio: number, mobile: boolean): number {
  return Math.min(Number.isFinite(deviceRatio) && deviceRatio > 0 ? deviceRatio : 1, mobile ? 1.5 : 2);
}