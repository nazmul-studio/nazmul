// Rules for uploaded images, shared by the browser and the server. Pure and isomorphic.
//
// The server never trusts a client's claim about a file: what it is, and how big, is read from the bytes
// (imageInfo). Only four raster formats are accepted. SVG and anything else that can carry script is refused,
// so everything served from /media/ is inert pixels.

export const MAX_UPLOAD_BYTES = 8_000_000;
/** Per side, in pixels. Far beyond any screen or GPU texture, but stops decompression-bomb files. */
export const MAX_DIMENSION = 10_000;
export const MAX_PIXELS = 50_000_000;

export type MediaKind = "jpeg" | "png" | "webp" | "gif";
export const MEDIA_TYPES: Record<MediaKind, { ext: string; mime: string }> = {
  jpeg: { ext: "jpg", mime: "image/jpeg" },
  png: { ext: "png", mime: "image/png" },
  webp: { ext: "webp", mime: "image/webp" },
  gif: { ext: "gif", mime: "image/gif" },
};
export const MIME_BY_EXT: Record<string, string> = Object.fromEntries(Object.values(MEDIA_TYPES).map((t) => [t.ext, t.mime]));
/** For <input accept> and for checking a browser File before sending it. */
export const ACCEPT_ATTR = Object.values(MEDIA_TYPES).map((t) => t.mime).join(",");
export const isAcceptedMime = (mime: string) => Object.values(MEDIA_TYPES).some((t) => t.mime === mime);

// A stored file is named after its content: 32 hex characters (half a SHA-256) plus the extension.
// Uploading the same picture twice therefore stores it once, and a name can never contain a path.
export const MEDIA_NAME = /^[a-f0-9]{32}\.(?:jpg|png|webp|gif)$/;
export const isMediaName = (value: unknown): value is string => typeof value === "string" && MEDIA_NAME.test(value);
export const mediaKey = (name: string) => `media:${name}`;
export const mediaUrl = (name: string) => `/media/${name}`;
/** The file name inside a "media:<name>" image key, or null when it is not a valid one. */
export function mediaNameOfKey(key: unknown): string | null {
  if (typeof key !== "string" || !key.startsWith("media:")) return null;
  const name = key.slice("media:".length);
  return isMediaName(name) ? name : null;
}

export type ImageInfo = { kind: MediaKind; ext: string; mime: string; width: number; height: number };

const u16be = (b: Uint8Array, i: number) => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
const u16le = (b: Uint8Array, i: number) => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
const u24le = (b: Uint8Array, i: number) => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16);
const u32be = (b: Uint8Array, i: number) => (((b[i] ?? 0) * 2 ** 24) + ((b[i + 1] ?? 0) << 16) + ((b[i + 2] ?? 0) << 8) + (b[i + 3] ?? 0));
const u32le = (b: Uint8Array, i: number) => (((b[i + 3] ?? 0) * 2 ** 24) + ((b[i + 2] ?? 0) << 16) + ((b[i + 1] ?? 0) << 8) + (b[i] ?? 0));
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...Array.from(b.subarray(i, i + n)));

function pngSize(b: Uint8Array): [number, number] | null {
  // 8-byte signature, then the IHDR chunk: length(4) "IHDR"(4) width(4) height(4)
  if (b.length < 24 || ascii(b, 12, 4) !== "IHDR") return null;
  return [u32be(b, 16), u32be(b, 20)];
}

function gifSize(b: Uint8Array): [number, number] | null {
  return b.length >= 10 ? [u16le(b, 6), u16le(b, 8)] : null;
}

function jpegSize(b: Uint8Array): [number, number] | null {
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return null;
    while (b[i] === 0xff) i++; // fill bytes
    const marker = b[i++] as number;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // no length field
    if (marker === 0xd9 || marker === 0xda) return null; // end of image / start of scan before any frame header
    const length = u16be(b, i);
    if (length < 2) return null;
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) return i + 6 < b.length ? [u16be(b, i + 5), u16be(b, i + 3)] : null; // precision(1) height(2) width(2)
    i += length;
  }
  return null;
}

function webpSize(b: Uint8Array): [number, number] | null {
  if (b.length < 30 || ascii(b, 8, 4) !== "WEBP") return null;
  switch (ascii(b, 12, 4)) {
    case "VP8 ": // lossy: 3-byte frame tag, start code 9d 01 2a, then 14-bit width and height
      return b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a ? [u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff] : null;
    case "VP8L": { // lossless: signature 0x2f, then 14-bit (width-1) and (height-1)
      if (b[20] !== 0x2f) return null;
      const bits = u32le(b, 21);
      return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
    }
    case "VP8X": // extended: 24-bit (canvas width-1) and (canvas height-1)
      return [u24le(b, 24) + 1, u24le(b, 27) + 1];
    default:
      return null;
  }
}

/** What the bytes are and their pixel size, or null if they are not a JPEG, PNG, WebP or GIF with a readable header. */
export function imageInfo(bytes: Uint8Array): ImageInfo | null {
  let kind: MediaKind | null = null;
  let size: [number, number] | null = null;
  const b = bytes;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    kind = "jpeg";
    size = jpegSize(b);
  } else if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 3) === "PNG" && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    kind = "png";
    size = pngSize(b);
  } else if (b.length >= 6 && (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a")) {
    kind = "gif";
    size = gifSize(b);
  } else if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") {
    kind = "webp";
    size = webpSize(b);
  }
  if (!kind || !size || size[0] < 1 || size[1] < 1) return null;
  const { ext, mime } = MEDIA_TYPES[kind];
  return { kind, ext, mime, width: size[0], height: size[1] };
}

/** True when the pixel size is within what the site accepts. */
export const withinDimensionLimits = (info: Pick<ImageInfo, "width" | "height">) =>
  info.width <= MAX_DIMENSION && info.height <= MAX_DIMENSION && info.width * info.height <= MAX_PIXELS;

// ---- where uploaded images are used (so the Studio can show it, and the server can refuse to delete one in use) ----

export type MediaUse = "book" | "cover" | "share image";

type ContentWithMedia = {
  book?: { pages: ReadonlyArray<{ elements: ReadonlyArray<{ type: string; src?: { key: string } }> }> } | undefined;
  site: { coverImage?: string; ogImage?: string };
};

/** File name → where it is used, for every uploaded image the content refers to. */
export function mediaUsage(content: ContentWithMedia): Map<string, Set<MediaUse>> {
  const out = new Map<string, Set<MediaUse>>();
  const add = (key: unknown, use: MediaUse) => {
    const name = mediaNameOfKey(key);
    if (!name) return;
    const set = out.get(name) ?? new Set<MediaUse>();
    set.add(use);
    out.set(name, set);
  };
  for (const page of content.book?.pages ?? []) for (const el of page.elements) if (el.type === "image") add(el.src?.key, "book");
  add(content.site.coverImage, "cover");
  add(content.site.ogImage, "share image");
  return out;
}

/** Combines several usage maps (e.g. the draft and the published version). */
export function mergeUsage(...maps: Array<Map<string, Set<MediaUse>>>): Map<string, Set<MediaUse>> {
  const out = new Map<string, Set<MediaUse>>();
  for (const map of maps) for (const [name, uses] of map) out.set(name, new Set([...(out.get(name) ?? []), ...uses]));
  return out;
}
