// THE canonical Book renderer. Paints one BookPage into a 2D canvas context in the page's
// logical coordinate space. Used by the public 3D tome (page textures), the Studio Book
// Editor canvas, page thumbnails and Preview — so identical JSON gives identical pixels.
// Deterministic: paper grain uses a seeded PRNG derived from the page id.

import { resolveImage } from './image-store';
import { paintOrder, safeLink, type BookElement, type BookPage, type ImageElement, type ShapeElement, type TextElement } from './model';

type Ctx = CanvasRenderingContext2D;

// ---------- images (shared cache; renderers re-paint when an image finishes loading) ----------

const images = new Map<string, HTMLImageElement>();
const listeners = new Set<() => void>();
export function onImageLoaded(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function getImage(url: string): HTMLImageElement | null {
  if (!url || typeof Image === 'undefined') return null;
  let img = images.get(url);
  if (!img) {
    img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => listeners.forEach((l) => l());
    img.src = url;
    images.set(url, img);
  }
  return img.complete && img.naturalWidth > 0 ? img : null;
}

// ---------- deterministic grain ----------

function seedFrom(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- text layout (shared by renderer and editor overlay) ----------

export function transformText(text: string, t: TextElement['style']['textTransform']): string {
  if (t === 'uppercase') return text.toUpperCase();
  if (t === 'lowercase') return text.toLowerCase();
  if (t === 'capitalize') return text.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
  return text;
}
export function fontString(s: TextElement['style']): string {
  return `${s.italic ? 'italic ' : ''}${s.fontWeight} ${s.fontSize}px ${s.fontFamily}`;
}
/** Word-wraps text to `width`, honouring explicit newlines. */
export function wrapLines(ctx: Ctx, text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(next).width > width) {
        out.push(line);
        line = word;
      } else line = next;
    }
    out.push(line);
  }
  return out;
}

// ---------- element painters ----------

function paintText(ctx: Ctx, el: TextElement) {
  const s = el.style;
  ctx.font = fontString(s);
  (ctx as Ctx & { letterSpacing?: string }).letterSpacing = `${s.letterSpacing}px`;
  ctx.fillStyle = s.color;
  ctx.textBaseline = 'alphabetic';
  const lines = wrapLines(ctx, transformText(el.text, s.textTransform), el.width);
  const ascent = s.fontSize * 0.8 + (s.lineHeight - s.fontSize) / 2;
  lines.forEach((line, i) => {
    const y = ascent + i * s.lineHeight;
    if (s.align === 'justify' && i < lines.length - 1 && line.includes(' ')) {
      const words = line.split(' ');
      const total = words.reduce((w, word) => w + ctx.measureText(word).width, 0);
      const gap = (el.width - total) / (words.length - 1);
      let x = 0;
      ctx.textAlign = 'left';
      for (const word of words) {
        ctx.fillText(word, x, y);
        x += ctx.measureText(word).width + gap;
      }
      return;
    }
    const align = s.align === 'justify' ? 'left' : s.align;
    ctx.textAlign = align;
    const x = align === 'center' ? el.width / 2 : align === 'right' ? el.width : 0;
    ctx.fillText(line, x, y);
  });
  if (el.href) {
    // Subtle underline marks links on the page.
    ctx.fillRect(0, Math.min(el.height, lines.length * s.lineHeight) - 2, el.width, 1);
  }
  (ctx as Ctx & { letterSpacing?: string }).letterSpacing = '0px';
}

function roundedPath(ctx: Ctx, w: number, h: number, r: number) {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(radius, 0);
  ctx.arcTo(w, 0, w, h, radius);
  ctx.arcTo(w, h, 0, h, radius);
  ctx.arcTo(0, h, 0, 0, radius);
  ctx.arcTo(0, 0, w, 0, radius);
  ctx.closePath();
}

function paintImage(ctx: Ctx, el: ImageElement) {
  const img = getImage(resolveImage(el.src));
  ctx.save();
  roundedPath(ctx, el.width, el.height, el.borderRadius);
  ctx.clip();
  if (!img) {
    ctx.fillStyle = 'rgba(23,43,52,.12)';
    ctx.fillRect(0, 0, el.width, el.height);
    ctx.restore();
    return;
  }
  const sx = el.crop.x * img.naturalWidth;
  const sy = el.crop.y * img.naturalHeight;
  const sw = Math.max(1, el.crop.width * img.naturalWidth);
  const sh = Math.max(1, el.crop.height * img.naturalHeight);
  let dw = el.width, dh = el.height;
  if (el.fit !== 'fill') {
    const k = el.fit === 'cover' ? Math.max(el.width / sw, el.height / sh) : Math.min(el.width / sw, el.height / sh);
    dw = sw * k;
    dh = sh * k;
  }
  const dx = (el.width - dw) * (el.objectPosition.x / 100);
  const dy = (el.height - dh) * (el.objectPosition.y / 100);
  ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
  ctx.restore();
}

function paintShape(ctx: Ctx, el: ShapeElement) {
  ctx.lineWidth = el.strokeWidth;
  ctx.strokeStyle = el.stroke;
  ctx.fillStyle = el.fill;
  if (el.shape === 'line') {
    ctx.beginPath();
    ctx.moveTo(0, el.height / 2);
    ctx.lineTo(el.width, el.height / 2);
    if (el.strokeWidth > 0) ctx.stroke();
    return;
  }
  if (el.shape === 'ellipse') {
    ctx.beginPath();
    ctx.ellipse(el.width / 2, el.height / 2, el.width / 2, el.height / 2, 0, 0, Math.PI * 2);
  } else roundedPath(ctx, el.width, el.height, el.shape === 'rounded-rectangle' ? el.cornerRadius || 24 : 0);
  if (el.fill !== 'transparent') ctx.fill();
  if (el.strokeWidth > 0) ctx.stroke();
}

export function paintElement(ctx: Ctx, el: BookElement) {
  if (!el.visible || el.opacity <= 0) return;
  ctx.save();
  ctx.globalAlpha = el.opacity;
  const cx = el.x + el.width / 2, cy = el.y + el.height / 2;
  ctx.translate(cx, cy);
  ctx.rotate((el.rotation * Math.PI) / 180);
  ctx.scale(el.scale, el.scale);
  ctx.translate(-el.width / 2, -el.height / 2);
  if (el.type === 'text') paintText(ctx, el);
  else if (el.type === 'image') paintImage(ctx, el);
  else paintShape(ctx, el);
  ctx.restore();
}

export type PaintOptions = {
  /** Element ids to skip (e.g. the text currently being typed in the editor). */
  skip?: ReadonlySet<string>;
};

/** Paints `page` into ctx; ctx must already be scaled so 1 unit = 1 logical page px. */
export function paintPage(ctx: Ctx, page: BookPage | null | undefined, options: PaintOptions = {}) {
  const w = page?.size.width ?? 768, h = page?.size.height ?? 1024;
  ctx.save();
  ctx.fillStyle = page?.background.color ?? '#dfe7e0';
  ctx.fillRect(0, 0, w, h);
  if (page?.background.image) {
    const img = getImage(resolveImage(page.background.image));
    if (img) ctx.drawImage(img, 0, 0, w, h);
  }
  if (!page || page.background.texture === 'paper-grain') {
    const rand = mulberry32(seedFrom(page?.id ?? 'blank'));
    for (let i = 0; i < 4000; i++) {
      ctx.fillStyle = `rgba(48,65,65,${rand() * 0.08})`;
      ctx.fillRect(rand() * w, rand() * h, 2, 2);
    }
  }
  if (page) for (const el of paintOrder(page.elements)) if (!options.skip?.has(el.id)) paintElement(ctx, el);
  ctx.restore();
}

/** Convenience: sizes a canvas for `page` at `pixelRatio` and paints it. */
export function renderPageToCanvas(canvas: HTMLCanvasElement, page: BookPage | null | undefined, pixelRatio = 1, options: PaintOptions = {}) {
  const w = page?.size.width ?? 768, h = page?.size.height ?? 1024;
  const pw = Math.round(w * pixelRatio), ph = Math.round(h * pixelRatio);
  if (canvas.width !== pw) canvas.width = pw;
  if (canvas.height !== ph) canvas.height = ph;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  paintPage(ctx, page, options);
}

/** Pairs ordered pages into physical leaves (front = even index, back = odd index). */
export function leavesOf(pages: readonly BookPage[]): { front: BookPage | null; back: BookPage | null }[] {
  const out: { front: BookPage | null; back: BookPage | null }[] = [];
  for (let i = 0; i < pages.length; i += 2) out.push({ front: pages[i] ?? null, back: pages[i + 1] ?? null });
  return out.length ? out : [{ front: null, back: null }];
}

/** Links placed on a page (text elements with an href), in paint order. Rendered as real <a> elements by the site. */
export type PageLink = { label: string; href: string };
export function pageLinks(page: BookPage | null): PageLink[] {
  if (!page) return [];
  const links: PageLink[] = [];
  for (const e of paintOrder(page.elements)) {
    if (e.type !== 'text' || !e.visible || !e.href) continue;
    const href = safeLink(e.href); // drafts being previewed have not been through the server's validation
    if (href) links.push({ label: e.text.trim() || href, href });
  }
  return links;
}

/** Plain text of a page, for screen readers. */
export function pageText(page: BookPage | null): string {
  if (!page) return '';
  return paintOrder(page.elements).filter((e): e is TextElement => e.type === 'text' && e.visible && e.text.trim() !== '').map((e) => e.text).join(' — ');
}
