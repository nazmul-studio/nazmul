// Public origin of the deployed site, e.g. "https://nazmul.example.com" (no trailing slash).
// Set VITE_SITE_URL at build time. Social-preview tags need an absolute URL, so the
// og:image / og:url tags are only emitted when this is set.
const raw = import.meta.env["VITE_SITE_URL"];

export const SITE_URL: string = typeof raw === "string" ? raw.trim().replace(/\/+$/, "") : "";
