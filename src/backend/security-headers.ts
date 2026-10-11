// Baseline hardening applied to every response by src/server.ts. Kept in its own module so it can be tested.

/**
 * - no framing (clickjacking of the admin login), no MIME sniffing, conservative referrer policy
 * - object-src / base-uri / form-action locked down (nothing here uses plugins, <base> or cross-origin forms)
 * - browser features the site never uses are switched off
 * - HSTS, only over https (sending it over http is ignored by browsers and would only confuse local dev)
 *
 * A script-src CSP is deliberately NOT set: the framework inlines hydration scripts, so a strict policy needs
 * per-request nonces and browser testing first.
 */
export const CONTENT_SECURITY_POLICY = "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'";
export const PERMISSIONS_POLICY = "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()";
export const HSTS = "max-age=31536000";

export function withSecurityHeaders(response: Response, secure: boolean): Response {
  const headers = new Headers(response.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("content-security-policy", CONTENT_SECURITY_POLICY);
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  headers.set("permissions-policy", PERMISSIONS_POLICY);
  if (secure) headers.set("strict-transport-security", HSTS);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
