import { describe, expect, it } from "vitest";
import { withSecurityHeaders } from "./security-headers";

describe("withSecurityHeaders", () => {
  const base = () => new Response("hello", { status: 201, headers: { "x-custom": "keep", "content-type": "text/plain" } });

  it("adds the baseline hardening headers and keeps the response intact", async () => {
    const res = withSecurityHeaders(base(), true);
    expect(res.status).toBe(201);
    expect(await res.text()).toBe("hello");
    expect(res.headers.get("x-custom")).toBe("keep");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("permissions-policy") ?? "").toContain("camera=()");
  });

  it("locks framing, plugins, <base> and form targets without restricting scripts", () => {
    const csp = withSecurityHeaders(base(), true).headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).not.toContain("script-src");
  });

  it("sends HSTS over https only", () => {
    expect(withSecurityHeaders(base(), true).headers.get("strict-transport-security")).toBe("max-age=31536000");
    expect(withSecurityHeaders(base(), false).headers.get("strict-transport-security")).toBeNull();
  });
});
