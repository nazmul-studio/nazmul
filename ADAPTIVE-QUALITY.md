# Adaptive quality: what changed and how to tune it

The site now judges the visitor's device in about a millisecond and picks one of four tiers.
The 3D scene then keeps correcting itself while it runs.

| Tier | Who gets it (first guess) | Resolution | Frame rate | Scene |
|------|---------------------------|-----------|-----------|-------|
| high | strong GPU, plenty of memory | up to 2x | display rate | full |
| mid  | typical phones and laptops | up to 1.5x | display rate | full, smaller pixel budget |
| low  | weak phones | 1x, starts at 0.85 | capped at 30 | full, lower resolution |
| lite | no WebGL, no half-float targets, old/software GPU, data saver, Chrome < 100, 1 GB RAM | n/a | n/a | none: CSS night-sky poster and a flat 2D book |

## What the visitor sees
1. The CSS poster (moon, ridges, mist) paints with the first frame on every device.
2. Text and navigation work immediately; the 3D scene starts only when the browser is idle.
3. A thin gold line at the top shows the scene being built; the canvas then fades in over the poster.
4. If the device cannot keep up, the scene steps its resolution down (and back up), and if it still
   cannot hold about 14 fps at minimum resolution, or takes too long to build, or loses its WebGL
   context, it stops and the page continues in light mode, with a small "Try the 3D scene" button.

## Crash protection
`src/lib/scene-plan.ts` remembers outcomes in localStorage:
- scene gave up -> light mode for 7 days
- scene never finished loading and the tab never said goodbye (what an out-of-memory crash looks like)
  -> next visit is capped at `low`; twice in a row -> `lite`
- scene ran healthily for 4 seconds -> all of that is cleared

## Testing on any device
Add `?tier=high`, `?tier=mid`, `?tier=low` or `?tier=lite` to the address. The scene's older debug flags
(`?nogl=1`, `?post=0`) still work too.

## Where to tune
- `src/lib/device-tier.ts`: `PLANS` (resolution, pixel budget, fps cap, build time limit per tier),
  `pickTier` (the scoring), `WEAK_GPU` / `STRONG_GPU` (GPU name patterns).
- `src/lib/kage-scene.js`: the governor in `frame()` (search for `PERF`).

## Other fixes in this change
- `.rgb-live` text was transparent on browsers without `oklch()` (Chrome < 111); it now has a hex fallback.
- `@supports not (color: oklch(...))` block restores the colour tokens in hex for those browsers.
- The scene used a fixed 2x resolution cap and its auto-quality governor was switched off (`locked: true`).
  Both are now driven by the tier. The shadow/MSAA preset (`HI = 'low'`) is untouched, so the look is unchanged.

## Not tested here
There was no browser or network in the environment this was written in, so it was checked with
unit tests (`device-tier.test.ts`), type/syntax checks and a read-through, not on real phones.
Thresholds in `PLANS` and `pickTier` are sensible first guesses; real-device testing should adjust them.
Still unfixable from code: Tailwind v4 needs `@layer` (Chrome 99+), so Chrome older than that loses the utility styles.
