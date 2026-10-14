/**
 * Device tiering for the 3D sanctuary.
 *
 * Cheap, static signals pick a starting tier in about a millisecond, before any heavy code is
 * downloaded. The frame-time governor inside the scene then corrects it in both directions while
 * it runs, so the numbers below only need to be a sensible first guess, not a benchmark.
 *
 *   high  full resolution (up to 2x), 60 fps
 *   mid   up to 1.5x, 60 fps
 *   low   1x, 30 fps cap, smallest pixel budget
 *   lite  no WebGL scene at all: a CSS night-sky poster and a flat 2D book, instant on any device
 */
export type Tier = 'high' | 'mid' | 'low' | 'lite';

export type GpuInfo = {
  webgl: 0 | 1 | 2;
  /** Can render into RGBA16F targets; the bloom chain cannot run without it. */
  halfFloatTarget: boolean;
  maxTexture: number;
  renderer: string;
};

export type Signals = {
  /** navigator.deviceMemory (GB, Chromium only). */
  memory?: number;
  cores?: number;
  dpr: number;
  /** Layout viewport in CSS px. */
  width: number;
  height: number;
  saveData: boolean;
  effectiveType?: string;
  /** Chromium major version, when the user agent is Chromium. */
  chrome?: number;
  gpu: GpuInfo;
};

export type QualityPlan = {
  tier: Tier;
  /** false = never start the WebGL scene. */
  scene: boolean;
  dprCap: number;
  /** Most pixels the renderer may draw per frame (width x height x ratio^2). */
  pixelBudget: number;
  /** Resolution multiplier the governor starts from, and the lowest it may go. */
  startScale: number;
  minScale: number;
  /** 0 = follow the display. */
  maxFps: number;
  aniso: number;
  /** Give up on the scene if building it takes longer than this. 0 = no limit. */
  bootBudgetMs: number;
  /** A failed build step abandons the scene instead of carrying on half-built. */
  strict: boolean;
  /** Whether offering a "try 3D anyway" button makes sense. */
  retry: boolean;
  reason: string;
  /** Changes every time a new attempt starts, so a fresh canvas can be mounted. */
  gen: number;
};

type PlanBase = Omit<QualityPlan, 'tier' | 'reason' | 'retry' | 'gen'>;

const PLANS: Record<Tier, PlanBase> = {
  high: { scene: true, dprCap: 2, pixelBudget: 5_000_000, startScale: 1, minScale: 0.7, maxFps: 0, aniso: 8, bootBudgetMs: 0, strict: false },
  mid: { scene: true, dprCap: 1.5, pixelBudget: 2_400_000, startScale: 1, minScale: 0.6, maxFps: 0, aniso: 4, bootBudgetMs: 20_000, strict: true },
  low: { scene: true, dprCap: 1, pixelBudget: 900_000, startScale: 0.85, minScale: 0.5, maxFps: 30, aniso: 1, bootBudgetMs: 9_000, strict: true },
  lite: { scene: false, dprCap: 1, pixelBudget: 0, startScale: 1, minScale: 1, maxFps: 0, aniso: 1, bootBudgetMs: 0, strict: true },
};

let generation = 0;

export function planFor(tier: Tier, reason: string, retry = true): QualityPlan {
  return { ...PLANS[tier], tier, reason, retry: tier === 'lite' ? retry : false, gen: ++generation };
}

/** GPUs old or slow enough that the scene would never hold a usable frame rate. */
const WEAK_GPU = /mali-(4|t6|t7)\d{2}|adreno[^0-9]*(2|3|4)\d{2}\b|powervr (sgx|gx6)|vivante|videocore|swiftshader|llvmpipe|software/i;
/** GPUs that comfortably run it at full resolution. */
const STRONG_GPU = /apple (gpu|m\d)|adreno[^0-9]*(6[5-9]\d|[7-9]\d{2})\b|mali-g(7|8|9)\d|immortalis|nvidia|geforce|radeon|intel.*(iris|arc|xe)/i;

export function pickTier(s: Signals): { tier: Tier; reason: string; retry: boolean } {
  const lite = (reason: string, retry = true) => ({ tier: 'lite' as const, reason, retry });
  if (s.gpu.webgl === 0) return lite('no WebGL', false);
  if (!s.gpu.halfFloatTarget) return lite('GPU cannot render the bloom buffers', false);
  if (s.gpu.maxTexture < 2048) return lite('GPU texture limit too small', false);
  if (WEAK_GPU.test(s.gpu.renderer)) return lite('weak or software GPU');
  if (s.saveData || s.effectiveType === 'slow-2g' || s.effectiveType === '2g') return lite('data saver or slow network');
  if (s.chrome !== undefined && s.chrome < 100) return lite('old browser engine');
  if (s.memory !== undefined && s.memory <= 1) return lite('very little memory');

  let score = 0;
  // Memory: unknown (Safari, Firefox) is treated as decent; Chromium rounds to 0.25 … 8.
  score += s.memory === undefined ? 2 : s.memory >= 8 ? 3 : s.memory >= 4 ? 2 : 0;
  // Cores are a weak signal (cheap phones are octa-core too), so they count for little.
  const c = s.cores ?? 4;
  score += c <= 2 ? 0 : c <= 4 ? 1 : 2;
  score += STRONG_GPU.test(s.gpu.renderer) ? 3 : 1;
  // A huge hi-dpi canvas is harder to drive than a small one.
  if (s.width * s.height * s.dpr * s.dpr >= 6_000_000) score -= 1;
  if (s.chrome !== undefined && s.chrome < 110) score -= 1;

  const tier: Tier = score >= 7 ? 'high' : score >= 4 ? 'mid' : 'low';
  return { tier, reason: `score ${score}`, retry: true };
}

/** Resolution multiplier for a plan: the display ratio, capped by tier and by the pixel budget. */
export function pixelRatioFor(plan: Pick<QualityPlan, 'dprCap' | 'pixelBudget'>, dpr: number, width: number, height: number): number {
  const device = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const budget = plan.pixelBudget > 0 ? Math.sqrt(plan.pixelBudget / Math.max(1, width * height)) : Infinity;
  return Math.max(0.5, Math.min(device, plan.dprCap, budget));
}

/** `?tier=high|mid|low|lite` lets the owner try any tier on any device. */
export function tierFromSearch(search: string): Tier | null {
  const value = new URLSearchParams(search).get('tier');
  return value === 'high' || value === 'mid' || value === 'low' || value === 'lite' ? value : null;
}

const ORDER: Tier[] = ['high', 'mid', 'low', 'lite'];
/** The lighter of two tiers. */
export function atMost(tier: Tier, cap: Tier): Tier {
  return ORDER[Math.max(ORDER.indexOf(tier), ORDER.indexOf(cap))] as Tier;
}

// ---------------------------------------------------------------- browser-only probes

/**
 * Creates a throwaway WebGL context and checks the exact things the scene depends on, including a
 * real framebuffer-completeness test for half-float targets. Takes a millisecond or two, and the
 * context is released straight away.
 */
export function probeGpu(): GpuInfo {
  const none: GpuInfo = { webgl: 0, halfFloatTarget: false, maxTexture: 0, renderer: '' };
  if (typeof document === 'undefined') return none;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 4;
    const gl2 = canvas.getContext('webgl2') as WebGL2RenderingContext | null;
    const gl = gl2 ?? ((canvas.getContext('webgl') ?? canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null);
    if (!gl) return none;
    const version: 1 | 2 = gl2 ? 2 : 1;
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = String((info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) ?? '');
    const maxTexture = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 0;
    const halfFloatTarget = canRenderHalfFloat(gl, version);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return { webgl: version, halfFloatTarget, maxTexture, renderer };
  } catch {
    return none;
  }
}

function canRenderHalfFloat(gl: WebGLRenderingContext | WebGL2RenderingContext, version: 1 | 2): boolean {
  try {
    let internal: number, type: number;
    if (version === 2) {
      const g = gl as WebGL2RenderingContext;
      if (!g.getExtension('EXT_color_buffer_float') && !g.getExtension('EXT_color_buffer_half_float')) return false;
      internal = g.RGBA16F; type = g.HALF_FLOAT;
    } else {
      const half = gl.getExtension('OES_texture_half_float');
      // The bloom targets use linear filtering, which WebGL 1 only allows with this extension.
      if (!half || !gl.getExtension('OES_texture_half_float_linear') || !gl.getExtension('EXT_color_buffer_half_float')) return false;
      internal = gl.RGBA; type = half.HALF_FLOAT_OES;
    }
    const texture = gl.createTexture();
    const buffer = gl.createFramebuffer();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, 4, 4, 0, gl.RGBA, type, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, buffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE && gl.getError() === gl.NO_ERROR;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(buffer);
    gl.deleteTexture(texture);
    return complete;
  } catch {
    return false;
  }
}

export function readSignals(): Signals {
  const nav = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean; effectiveType?: string } };
  // iPhone's "CriOS" is Chrome's shell around Safari's engine and does not match: only real Chromium counts.
  const chrome = /\b(?:Chrome|Chromium)\/(\d+)/.exec(nav.userAgent);
  return {
    memory: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : undefined,
    cores: typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : undefined,
    dpr: window.devicePixelRatio || 1,
    width: document.documentElement.clientWidth || window.innerWidth,
    height: document.documentElement.clientHeight || window.innerHeight,
    saveData: nav.connection?.saveData === true,
    effectiveType: nav.connection?.effectiveType,
    chrome: chrome ? Number(chrome[1]) : undefined,
    gpu: probeGpu(),
  };
}
