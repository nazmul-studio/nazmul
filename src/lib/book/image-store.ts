// Image storage abstraction. Book JSON only ever holds ImageRef keys; bytes live in a store.
// Two kinds of ref: "media:<name>" (an image uploaded in the Studio, stored in Cloudflare R2 and served from this
// site's own /media/ path, so it is same-origin and the 3D book can always read its pixels) and "url:" (an external
// https link; the host must allow CORS, and plain http is refused because it is blocked as mixed content).

import { mediaNameOfKey, mediaUrl } from '../media';
import { describeStorageFallback, studioApi } from '../studio-client';
import type { ImageRef } from './model';

/** `warning` is set when the image was stored but not where it belongs (R2): show it, the image itself works. */
export type StoredImage = { ref: ImageRef; warning?: string };

export interface ImageStore {
  /** Scheme handled by this store, e.g. "url" or "media". */
  readonly scheme: string;
  /** Turns a key into a URL a browser can load (may be signed/CDN for R2). */
  resolve(ref: ImageRef): string;
  /** Uploads bytes and returns a reference. Optional: read-only stores omit it. */
  put?(file: Blob, meta: { filename: string; contentType: string }): Promise<StoredImage>;
  remove?(ref: ImageRef): Promise<void>;
}

const SAFE_URL = /^https:\/\//i;

/** Read-only store for absolute https URLs. The host must also allow cross-origin loading (CORS), or the canvas cannot draw it. */
export const urlImageStore: ImageStore = {
  scheme: 'url',
  resolve(ref) {
    const raw = ref.key.slice('url:'.length);
    return SAFE_URL.test(raw) ? raw : '';
  },
};

/** Uploaded images. resolve() is used everywhere; put() only ever runs in the Studio (it talks to the admin API). */
export const mediaImageStore: ImageStore = {
  scheme: 'media',
  resolve(ref) {
    const name = mediaNameOfKey(ref.key);
    return name ? mediaUrl(name) : '';
  },
  async put(file) {
    const uploaded = await studioApi.upload(file);
    const warning = describeStorageFallback(uploaded, 'the book');
    return { ref: { key: uploaded.key, width: uploaded.width, height: uploaded.height, alt: '' }, ...(warning ? { warning } : {}) };
  },
};

const stores = new Map<string, ImageStore>([
  [urlImageStore.scheme, urlImageStore],
  [mediaImageStore.scheme, mediaImageStore],
]);

export function registerImageStore(store: ImageStore) {
  stores.set(store.scheme, store);
}

export function schemeOf(key: string): string {
  const i = key.indexOf(':');
  return i > 0 ? key.slice(0, i) : '';
}

/** Valid keys: "media:<content-hash name>" or "url:<https link>". Anything else is refused. */
export function isValidImageKey(key: string): boolean {
  if (typeof key !== 'string' || key.length === 0 || key.length > 1024) return false;
  const scheme = schemeOf(key);
  if (scheme === 'url') return SAFE_URL.test(key.slice(4));
  if (scheme === 'media') return mediaNameOfKey(key) !== null;
  return false;
}

export function resolveImage(ref: ImageRef): string {
  if (!isValidImageKey(ref.key)) return '';
  const store = stores.get(schemeOf(ref.key));
  return store ? store.resolve(ref) : ref.url && SAFE_URL.test(ref.url) ? ref.url : '';
}

export const urlRef = (url: string, alt = ''): ImageRef => ({ key: `url:${url}`, alt });

/** The first registered store that can accept uploads, or null. */
export function getUploadStore(): ImageStore | null {
  for (const s of stores.values()) if (typeof s.put === 'function') return s;
  return null;
}
