import { describe, expect, it } from "vitest";
import { fixtureBytes as bytes } from "../test/image-fixtures";
import {
  MAX_DIMENSION,
  MAX_PIXELS,
  imageInfo,
  isMediaName,
  mediaNameOfKey,
  mediaUsage,
  mediaKey,
  mergeUsage,
  withinDimensionLimits,
} from "./media";

const text = (s: string) => new TextEncoder().encode(s);

describe("imageInfo", () => {
  it.each([
    ["png_40x30", "png", "png", 40, 30],
    ["jpeg_64x48", "jpeg", "jpg", 64, 48],
    ["jpeg_progressive_50x20", "jpeg", "jpg", 50, 20],
    ["gif_20x10", "gif", "gif", 20, 10],
    ["webp_lossy_33x17", "webp", "webp", 33, 17],
    ["webp_lossless_21x9", "webp", "webp", 21, 9],
    ["webp_alpha_16x12", "webp", "webp", 16, 12],
  ] as const)("reads kind and pixel size from the bytes of %s", (name, kind, ext, width, height) => {
    expect(imageInfo(bytes(name))).toEqual({ kind, ext, mime: `image/${kind}`, width, height });
  });

  it("refuses anything that is not one of the four raster formats, whatever it claims to be", () => {
    const svg = text('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect width="10" height="10"/></svg>');
    expect(imageInfo(svg)).toBeNull();
    expect(imageInfo(text("<!doctype html><script>alert(1)</script>"))).toBeNull();
    expect(imageInfo(text("MZ\u0090\u0000 an executable"))).toBeNull();
    expect(imageInfo(new Uint8Array(0))).toBeNull();
    expect(imageInfo(text("GIF"))).toBeNull();
  });

  it("refuses files whose header is cut off or lies about being an image", () => {
    const png = bytes("png_40x30");
    expect(imageInfo(png.slice(0, 10))).toBeNull();
    expect(imageInfo(png.slice(0, 20))).toBeNull();
    const jpeg = bytes("jpeg_64x48");
    expect(imageInfo(jpeg.slice(0, 6))).toBeNull();
    expect(imageInfo(Uint8Array.of(0xff, 0xd8, 0xff, 0xd9))).toBeNull(); // JPEG that ends before any frame header
    const webp = bytes("webp_lossy_33x17");
    expect(imageInfo(webp.slice(0, 20))).toBeNull();
    const riffNotWebp = Uint8Array.from(webp);
    riffNotWebp.set(text("WAVE"), 8);
    expect(imageInfo(riffNotWebp)).toBeNull();
  });

  it("reports a zero-sized image as unreadable rather than as a valid empty picture", () => {
    const png = Uint8Array.from(bytes("png_40x30"));
    png.set([0, 0, 0, 0], 16);
    expect(imageInfo(png)).toBeNull();
  });
});

describe("withinDimensionLimits", () => {
  it("allows normal images and refuses decompression-bomb dimensions", () => {
    expect(withinDimensionLimits({ width: 4000, height: 3000 })).toBe(true);
    expect(withinDimensionLimits({ width: MAX_DIMENSION, height: 1 })).toBe(true);
    expect(withinDimensionLimits({ width: MAX_DIMENSION + 1, height: 1 })).toBe(false);
    expect(withinDimensionLimits({ width: 9000, height: 9000 })).toBe(false); // 81 MP > limit
    expect(MAX_PIXELS).toBe(50_000_000);
  });

  it("is enforced on a real file once its header is edited to claim a huge size", () => {
    const png = Uint8Array.from(bytes("png_40x30"));
    png.set([0, 0, 0x4e, 0x20], 16); // width 20000
    const info = imageInfo(png);
    expect(info?.width).toBe(20000);
    expect(withinDimensionLimits(info!)).toBe(false);
  });
});

describe("media names and keys", () => {
  const name = "0123456789abcdef0123456789abcdef.png";

  it("accepts only content-hash names, so a name can never be a path", () => {
    expect(isMediaName(name)).toBe(true);
    for (const bad of [
      "../etc/passwd",
      "0123456789abcdef0123456789abcdef.svg",
      "0123456789abcdef0123456789abcdef.PNG",
      "0123456789ABCDEF0123456789abcdef.png",
      "0123456789abcdef0123456789abcde.png",
      "img/0123456789abcdef0123456789abcdef.png",
      `${name}/`,
      `${name}%2f..`,
      "",
      null,
      42,
    ]) expect(isMediaName(bad)).toBe(false);
  });

  it("round-trips a key and refuses other schemes and malformed keys", () => {
    expect(mediaNameOfKey(mediaKey(name))).toBe(name);
    expect(mediaNameOfKey(`url:https://x.test/${name}`)).toBeNull();
    expect(mediaNameOfKey("media:../x.png")).toBeNull();
    expect(mediaNameOfKey("media:")).toBeNull();
    expect(mediaNameOfKey(undefined)).toBeNull();
  });
});

describe("mediaUsage", () => {
  const a = "a".repeat(32) + ".jpg";
  const b = "b".repeat(32) + ".png";
  const c = "c".repeat(32) + ".webp";
  const content = {
    book: { pages: [
      { elements: [{ type: "image", src: { key: mediaKey(a) } }, { type: "text" }, { type: "image", src: { key: "url:https://x.test/a.png" } }] },
      { elements: [{ type: "image", src: { key: mediaKey(a) } }] },
    ] },
    site: { coverImage: mediaKey(b), ogImage: mediaKey(a) },
  };

  it("lists where each uploaded image is used and ignores external links and non-images", () => {
    const usage = mediaUsage(content);
    expect([...usage.keys()].sort()).toEqual([a, b]);
    expect([...usage.get(a)!].sort()).toEqual(["book", "share image"]);
    expect([...usage.get(b)!]).toEqual(["cover"]);
  });

  it("copes with no book, an empty site, and merges several maps", () => {
    expect(mediaUsage({ site: {} }).size).toBe(0);
    const other = mediaUsage({ site: { coverImage: mediaKey(c) } });
    const merged = mergeUsage(mediaUsage(content), other);
    expect([...merged.keys()].sort()).toEqual([a, b, c]);
  });
});
