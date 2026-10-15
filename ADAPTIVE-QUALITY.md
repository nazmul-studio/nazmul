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

---

# Visitor log (Studio → Visitors)

Every visit to the public page is listed in the Studio, newest first: time, IP address, country, device model,
OS, browser, the tier the visitor got, how the 3D scene went (and why it gave up, if it did), GPU, RAM, cores,
screen, network type, language and how long the scene took to build.

## How it works
- The page reports to `POST /api/visit` (`src/lib/visit-report.ts` -> `src/backend/visit-api.ts`), once when it opens
  and once more when the scene has run smoothly for 4 seconds or has given up.
- Each visit is one KV entry (`src/backend/visits.ts`) holding the whole record in its metadata, so the Studio lists
  100 visits with a single KV call. Entries delete themselves after 30 days (`VISIT_TTL_DAYS` in `src/lib/visit-info.ts`).
- The Studio reads it through `GET /api/studio/visits` (sign-in required); "Clear log" deletes it.
- A visit with outcome "No result" never reported back: the visitor left early, or the tab crashed. On a device that
  keeps crashing this is the entry to look for.

## What the browser really tells us about the device
- **Chrome on Android**: the exact model (e.g. SM-A135F), through User-Agent Client Hints.
- **iPhone**: never the model. The Studio shows "likely …" and the family that matches the screen size.
- **Safari / Firefox / desktop**: OS, browser and version, GPU name, RAM (Chromium only), cores, screen. No model.

## Privacy choices (all easy to change)
- Visitors whose browser sends Do Not Track or Global Privacy Control are not logged (`optedOut` in `visit-report.ts`,
  and again on the server in `visit-api.ts`).
- A notice in the page footer says what is logged and for how long.
- The IP address is stored as received. To store less, shorten it in `build()` in `src/backend/visits.ts`
  (for example drop the last IPv4 octet). In many places an IP address counts as personal data, so keep the notice
  accurate and check the rules that apply to your visitors.
- Only same-origin posts are accepted, bodies are capped at 4 KB, every field is clamped, and one IP address is limited
  to 40 logged visits an hour per server instance.

## KV write budget
A logged visit costs two KV writes (record + final outcome). As far as I know the free Cloudflare plan allows about
1,000 writes a day across the whole namespace, which would be roughly 500 visits a day; those writes are shared with
publishing from the Studio. If the site gets busy, lower `SAMPLE_RATE` in `src/lib/visit-report.ts` (0.2 logs one visit
in five). Check the limits on your Cloudflare plan.

## Tested / not tested
`visit-info.test.ts` and `visits.test.ts` (parsing, clamping, ordering, update rules, size limit, rate limit, clearing)
were run. The HTTP handler, Studio tab and browser reporter were syntax-checked and read through but not executed:
open the deployed site on a phone, then Studio -> Visitors, to confirm the first entry appears.
