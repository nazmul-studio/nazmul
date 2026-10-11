// Canonical Book → Pages → Elements model. Pure data, isomorphic, JSON-serializable.
// The public tome, the Studio Book Editor, Preview and the published site all read this shape.

export const BOOK_SCHEMA_VERSION = 1 as const;

/** Authoring units: every page is laid out in a fixed logical coordinate space (px). */
export const DEFAULT_PAGE_SIZE = { width: 768, height: 1024 } as const;

export type PageSize = { width: number; height: number };

export type PageBackground = {
  color: string;
  /** Procedural paper grain used by the original tome pages. */
  texture: 'none' | 'paper-grain';
  /** Optional background image (reference only, never binary). */
  image?: ImageRef;
};

/** Pointer to an image held by an ImageStore (R2 later). Never raw bytes. */
export type ImageRef = {
  /** Store key, e.g. "media:<name>" (uploaded) or "url:https://..." (external) */
  key: string;
  /** Resolved public URL cache; renderers prefer ImageStore.resolve(key). */
  url?: string;
  width?: number;
  height?: number;
  alt?: string;
};

export type ElementBase = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Degrees, clockwise, around the element's center. */
  rotation: number;
  scale: number;
  opacity: number;
  zIndex: number;
  visible: boolean;
  locked?: boolean;
  /** Free-form semantic label, e.g. "title", "contact.email". Used by migrations/editor. */
  role?: string;
};

export type TextAlign = 'left' | 'center' | 'right' | 'justify';
export type TextTransform = 'none' | 'uppercase' | 'lowercase' | 'capitalize';

export type TextStyle = {
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  italic: boolean;
  color: string;
  align: TextAlign;
  lineHeight: number; // px
  letterSpacing: number; // px
  textTransform: TextTransform;
};

export type TextElement = ElementBase & {
  type: 'text';
  text: string;
  style: TextStyle;
  /** Makes the text a link (contact page). Must be http(s) or mailto:. */
  href?: string;
};

export type ImageFit = 'cover' | 'contain' | 'fill';
export type ImageElement = ElementBase & {
  type: 'image';
  src: ImageRef;
  fit: ImageFit;
  /** Object position in percent (0–100). */
  objectPosition: { x: number; y: number };
  /** Crop rectangle as fractions (0–1) of the source image. */
  crop: { x: number; y: number; width: number; height: number };
  borderRadius: number;
};

export type ShapeKind = 'rectangle' | 'rounded-rectangle' | 'ellipse' | 'line';
export type ShapeElement = ElementBase & {
  type: 'shape';
  shape: ShapeKind;
  fill: string; // 'transparent' allowed
  stroke: string;
  strokeWidth: number;
  cornerRadius: number;
};

export type BookElement = TextElement | ImageElement | ShapeElement;
export type ElementType = BookElement['type'];

export type PageKind = 'content' | 'contact';
export type BookPage = {
  id: string;
  kind: PageKind;
  size: PageSize;
  background: PageBackground;
  elements: BookElement[];
};

export type Book = {
  schemaVersion: typeof BOOK_SCHEMA_VERSION;
  title: string;
  /** Ordered pages. Index = page order; pages pair into leaves (front = even, back = odd). */
  pages: BookPage[];
};

// ---------- factories ----------

let counter = 0;
/** Short, collision-resistant id. Deterministic ids are passed explicitly by migrations. */
export function newId(prefix = 'el'): string {
  counter = (counter + 1) % 1_000_000;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${rand}`;
}

export const PAPER: PageBackground = { color: '#dfe7e0', texture: 'paper-grain' };

export const defaultTextStyle = (): TextStyle => ({
  fontFamily: 'Onest, sans-serif',
  fontSize: 32,
  fontWeight: 400,
  italic: false,
  color: '#293e41',
  align: 'left',
  lineHeight: 42,
  letterSpacing: 0,
  textTransform: 'none',
});

const base = (id: string, rest: Partial<ElementBase> = {}): ElementBase => ({
  id,
  x: 0,
  y: 0,
  width: 200,
  height: 60,
  rotation: 0,
  scale: 1,
  opacity: 1,
  zIndex: 0,
  visible: true,
  ...rest,
});

export function createText(
  init: Partial<Omit<TextElement, 'type' | 'style'>> & { style?: Partial<TextStyle> } = {},
): TextElement {
  const { style, ...rest } = init;
  return { ...base(rest.id ?? newId('txt'), rest), type: 'text', text: rest.text ?? '', ...(rest.href ? { href: rest.href } : {}), style: { ...defaultTextStyle(), ...style } };
}

export function createImage(init: Partial<Omit<ImageElement, 'type'>> & { src: ImageRef }): ImageElement {
  return {
    ...base(init.id ?? newId('img'), { width: 320, height: 240, ...init }),
    type: 'image',
    src: init.src,
    fit: init.fit ?? 'cover',
    objectPosition: init.objectPosition ?? { x: 50, y: 50 },
    crop: init.crop ?? { x: 0, y: 0, width: 1, height: 1 },
    borderRadius: init.borderRadius ?? 0,
  };
}

export function createShape(init: Partial<Omit<ShapeElement, 'type'>> = {}): ShapeElement {
  return {
    ...base(init.id ?? newId('shp'), init),
    type: 'shape',
    shape: init.shape ?? 'rectangle',
    fill: init.fill ?? 'transparent',
    stroke: init.stroke ?? '#9d894e',
    strokeWidth: init.strokeWidth ?? 3,
    cornerRadius: init.cornerRadius ?? 0,
  };
}

export function createPage(init: Partial<BookPage> = {}): BookPage {
  return {
    id: init.id ?? newId('pg'),
    kind: init.kind ?? 'content',
    size: init.size ?? { ...DEFAULT_PAGE_SIZE },
    background: init.background ?? { ...PAPER },
    elements: init.elements ?? [],
  };
}

/** Elements sorted for painting (lowest zIndex first, stable by array order). */
export function paintOrder(elements: readonly BookElement[]): BookElement[] {
  return elements
    .map((e, i) => [e, i] as const)
    .sort((a, b) => a[0].zIndex - b[0].zIndex || a[1] - b[1])
    .map(([e]) => e);
}

/** Only http(s) and mailto: links are allowed. */
export function safeLink(v: string): string {
  const s = v.trim();
  if (/^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(s)) return s;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? s : '';
  } catch {
    return '';
  }
}
