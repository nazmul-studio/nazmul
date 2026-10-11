// Server-authoritative validation for Book data. Never throws; clamps/drops bad values and
// reports issues. Text is stored as plain strings and is always rendered as text, never HTML.

import { isValidImageKey } from './image-store';
import {
  BOOK_SCHEMA_VERSION,
  DEFAULT_PAGE_SIZE,
  defaultTextStyle,
  safeLink,
  type Book,
  type BookElement,
  type BookPage,
  type ElementBase,
  type ImageRef,
  type ShapeKind,
  type TextAlign,
  type TextTransform,
} from './model';

export type BookIssue = { path: string; message: string };

export const BOOK_LIMITS = {
  pages: 500,
  elementsPerPage: 200,
  text: 5000,
  id: 80,
  title: 300,
  coord: 4000,
  size: 8000,
  fontSize: [4, 400] as const,
  scale: [0.05, 20] as const,
  zIndex: 10000,
} as const;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const COLOR = /^(#[0-9a-fA-F]{3,8}|transparent|rgba?\(\s*[\d.\s,%]+\))$/;
const ID = /^[A-Za-z0-9_\-:.]+$/;

const rec = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function num(v: unknown, path: string, issues: BookIssue[], fallback: number, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    if (v !== undefined) issues.push({ path, message: 'must be a number' });
    return fallback;
  }
  if (v < min || v > max) {
    issues.push({ path, message: `must be between ${min} and ${max}` });
    return Math.min(max, Math.max(min, v));
  }
  return v;
}
function text(v: unknown, path: string, issues: BookIssue[], max: number, fallback = ''): string {
  if (typeof v !== 'string') {
    if (v !== undefined) issues.push({ path, message: 'must be text' });
    return fallback;
  }
  let out = v.replace(CONTROL, '');
  if (out !== v) issues.push({ path, message: 'contains control characters' });
  if (out.length > max) {
    issues.push({ path, message: `must be at most ${max} characters` });
    out = out.slice(0, max);
  }
  return out;
}
function color(v: unknown, path: string, issues: BookIssue[], fallback: string): string {
  if (typeof v === 'string' && COLOR.test(v.trim())) return v.trim();
  if (v !== undefined) issues.push({ path, message: 'must be a color' });
  return fallback;
}
function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T, path: string, issues: BookIssue[]): T {
  if ((allowed as readonly unknown[]).includes(v)) return v as T;
  if (v !== undefined) issues.push({ path, message: `must be one of ${allowed.join(', ')}` });
  return fallback;
}
function id(v: unknown, path: string, issues: BookIssue[], fallback: string): string {
  if (typeof v === 'string' && v.length > 0 && v.length <= BOOK_LIMITS.id && ID.test(v)) return v;
  issues.push({ path, message: 'must be a valid id' });
  return fallback;
}

export { safeLink };

function imageRef(v: unknown, path: string, issues: BookIssue[]): ImageRef | null {
  const r = rec(v);
  const key = typeof r['key'] === 'string' ? r['key'] : '';
  if (!isValidImageKey(key)) {
    issues.push({ path: `${path}.key`, message: 'must be a valid image reference (no inline data)' });
    return null;
  }
  const out: ImageRef = { key };
  if (typeof r['alt'] === 'string') out.alt = text(r['alt'], `${path}.alt`, issues, 300);
  for (const k of ['width', 'height'] as const) if (typeof r[k] === 'number') out[k] = num(r[k], `${path}.${k}`, issues, 0, 0, 20000);
  return out;
}

function element(raw: unknown, path: string, issues: BookIssue[], index: number): BookElement | null {
  const r = rec(raw);
  const L = BOOK_LIMITS;
  const b: ElementBase = {
    id: id(r['id'], `${path}.id`, issues, `el_${index}`),
    x: num(r['x'], `${path}.x`, issues, 0, -L.coord, L.coord),
    y: num(r['y'], `${path}.y`, issues, 0, -L.coord, L.coord),
    width: num(r['width'], `${path}.width`, issues, 100, 0, L.size),
    height: num(r['height'], `${path}.height`, issues, 40, 0, L.size),
    rotation: num(r['rotation'], `${path}.rotation`, issues, 0, -360, 360),
    scale: num(r['scale'], `${path}.scale`, issues, 1, L.scale[0], L.scale[1]),
    opacity: num(r['opacity'], `${path}.opacity`, issues, 1, 0, 1),
    zIndex: Math.round(num(r['zIndex'], `${path}.zIndex`, issues, 0, -L.zIndex, L.zIndex)),
    visible: r['visible'] !== false,
  };
  if (r['locked'] === true) b.locked = true;
  if (typeof r['role'] === 'string') b.role = text(r['role'], `${path}.role`, issues, 60);

  switch (r['type']) {
    case 'text': {
      const s = rec(r['style']);
      const d = defaultTextStyle();
      const el: BookElement = {
        ...b,
        type: 'text',
        text: text(r['text'], `${path}.text`, issues, L.text),
        style: {
          fontFamily: text(s['fontFamily'], `${path}.style.fontFamily`, issues, 120, d.fontFamily).replace(/[;{}<>]/g, ''),
          fontSize: num(s['fontSize'], `${path}.style.fontSize`, issues, d.fontSize, L.fontSize[0], L.fontSize[1]),
          fontWeight: Math.round(num(s['fontWeight'], `${path}.style.fontWeight`, issues, d.fontWeight, 100, 900) / 100) * 100,
          italic: s['italic'] === true,
          color: color(s['color'], `${path}.style.color`, issues, d.color),
          align: oneOf<TextAlign>(s['align'], ['left', 'center', 'right', 'justify'], d.align, `${path}.style.align`, issues),
          lineHeight: num(s['lineHeight'], `${path}.style.lineHeight`, issues, d.lineHeight, 1, 800),
          letterSpacing: num(s['letterSpacing'], `${path}.style.letterSpacing`, issues, 0, -50, 200),
          textTransform: oneOf<TextTransform>(s['textTransform'], ['none', 'uppercase', 'lowercase', 'capitalize'], 'none', `${path}.style.textTransform`, issues),
        },
      };
      if (typeof r['href'] === 'string' && r['href'] !== '') {
        const href = safeLink(r['href']);
        if (href) el.href = href;
        else issues.push({ path: `${path}.href`, message: 'must be an http(s) or mailto: link' });
      }
      return el;
    }
    case 'image': {
      const src = imageRef(r['src'], `${path}.src`, issues);
      if (!src) return null;
      const op = rec(r['objectPosition']);
      const c = rec(r['crop']);
      return {
        ...b,
        type: 'image',
        src,
        fit: oneOf(r['fit'], ['cover', 'contain', 'fill'] as const, 'cover', `${path}.fit`, issues),
        objectPosition: { x: num(op['x'], `${path}.objectPosition.x`, issues, 50, 0, 100), y: num(op['y'], `${path}.objectPosition.y`, issues, 50, 0, 100) },
        crop: {
          x: num(c['x'], `${path}.crop.x`, issues, 0, 0, 1),
          y: num(c['y'], `${path}.crop.y`, issues, 0, 0, 1),
          width: num(c['width'], `${path}.crop.width`, issues, 1, 0.01, 1),
          height: num(c['height'], `${path}.crop.height`, issues, 1, 0.01, 1),
        },
        borderRadius: num(r['borderRadius'], `${path}.borderRadius`, issues, 0, 0, 2000),
      };
    }
    case 'shape':
      return {
        ...b,
        type: 'shape',
        shape: oneOf<ShapeKind>(r['shape'], ['rectangle', 'rounded-rectangle', 'ellipse', 'line'], 'rectangle', `${path}.shape`, issues),
        fill: color(r['fill'], `${path}.fill`, issues, 'transparent'),
        stroke: color(r['stroke'], `${path}.stroke`, issues, '#9d894e'),
        strokeWidth: num(r['strokeWidth'], `${path}.strokeWidth`, issues, 3, 0, 200),
        cornerRadius: num(r['cornerRadius'], `${path}.cornerRadius`, issues, 0, 0, 2000),
      };
    default:
      issues.push({ path: `${path}.type`, message: 'must be text, image or shape' });
      return null;
  }
}

function page(raw: unknown, path: string, issues: BookIssue[], index: number): BookPage {
  const r = rec(raw);
  const size = rec(r['size']);
  const bg = rec(r['background']);
  const rawEls = Array.isArray(r['elements']) ? r['elements'] : [];
  if (!Array.isArray(r['elements'])) issues.push({ path: `${path}.elements`, message: 'must be a list' });
  if (rawEls.length > BOOK_LIMITS.elementsPerPage) issues.push({ path: `${path}.elements`, message: `can have at most ${BOOK_LIMITS.elementsPerPage} elements` });
  const seen = new Set<string>();
  const elements: BookElement[] = [];
  rawEls.slice(0, BOOK_LIMITS.elementsPerPage).forEach((e, i) => {
    const el = element(e, `${path}.elements[${i}]`, issues, i);
    if (!el) return;
    if (seen.has(el.id)) {
      issues.push({ path: `${path}.elements[${i}].id`, message: 'is duplicated' });
      el.id = `${el.id}_${i}`;
    }
    seen.add(el.id);
    elements.push(el);
  });
  const background: BookPage['background'] = {
    color: color(bg['color'], `${path}.background.color`, issues, '#dfe7e0'),
    texture: oneOf(bg['texture'], ['none', 'paper-grain'] as const, 'paper-grain', `${path}.background.texture`, issues),
  };
  if (bg['image'] !== undefined) {
    const img = imageRef(bg['image'], `${path}.background.image`, issues);
    if (img) background.image = img;
  }
  return {
    id: id(r['id'], `${path}.id`, issues, `page_${index}`),
    kind: oneOf(r['kind'], ['content', 'contact'] as const, 'content', `${path}.kind`, issues),
    size: {
      width: num(size['width'], `${path}.size.width`, issues, DEFAULT_PAGE_SIZE.width, 100, 4000),
      height: num(size['height'], `${path}.size.height`, issues, DEFAULT_PAGE_SIZE.height, 100, 4000),
    },
    background,
    elements,
  };
}

export function parseBook(input: unknown, path = 'book'): { book: Book; issues: BookIssue[] } {
  const issues: BookIssue[] = [];
  const r = rec(input);
  if (r['schemaVersion'] !== BOOK_SCHEMA_VERSION) issues.push({ path: `${path}.schemaVersion`, message: `must be ${BOOK_SCHEMA_VERSION}` });
  const raw = Array.isArray(r['pages']) ? r['pages'] : [];
  if (!Array.isArray(r['pages'])) issues.push({ path: `${path}.pages`, message: 'must be a list' });
  if (raw.length > BOOK_LIMITS.pages) issues.push({ path: `${path}.pages`, message: `can have at most ${BOOK_LIMITS.pages} pages` });
  const seen = new Set<string>();
  const pages = raw.slice(0, BOOK_LIMITS.pages).map((p, i) => {
    const pg = page(p, `${path}.pages[${i}]`, issues, i);
    if (seen.has(pg.id)) {
      issues.push({ path: `${path}.pages[${i}].id`, message: 'is duplicated' });
      pg.id = `${pg.id}_${i}`;
    }
    seen.add(pg.id);
    return pg;
  });
  return { book: { schemaVersion: BOOK_SCHEMA_VERSION, title: text(r['title'], `${path}.title`, issues, BOOK_LIMITS.title), pages }, issues };
}
