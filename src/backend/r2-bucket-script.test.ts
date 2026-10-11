import { describe, expect, it } from "vitest";
import { interpretBucketCreate } from "../../scripts/r2-bucket.mjs";

describe("deploy script: reading the result of `wrangler r2 bucket create`", () => {
  it("treats success as created and an existing bucket as fine", () => {
    expect(interpretBucketCreate({ status: 0, output: "Created bucket 'media'" })).toEqual({ ok: true, created: true });
    for (const output of [
      "✘ [ERROR] The bucket you tried to create already exists, and you own it. [code: 10004]",
      "A bucket with this name already exists",
      "[code: 10004]",
    ]) expect(interpretBucketCreate({ status: 1, output })).toEqual({ ok: true, created: false });
  });

  it("explains how to switch R2 on when the account has not enabled it", () => {
    const r = interpretBucketCreate({ status: 1, output: "✘ [ERROR] Please enable R2 through the Cloudflare Dashboard. [code: 10042]" });
    expect(r.ok).toBe(false);
    expect(r.hint).toContain("dashboard");
    expect(r.hint).toContain("R2");
  });

  it("explains a token without R2 permission", () => {
    for (const output of ["Authentication error [code: 10000]", "403 Forbidden: insufficient permissions", "You are not logged in"]) {
      const r = interpretBucketCreate({ status: 1, output });
      expect(r.ok).toBe(false);
      expect(r.hint).toContain("R2 Storage: Edit");
    }
  });

  it("never blocks a deploy: any other failure is reported with its first line and not treated as success", () => {
    const r = interpretBucketCreate({ status: 1, output: "\n  \nsomething unexpected happened\nmore detail" });
    expect(r).toEqual({ ok: false, created: false, hint: "something unexpected happened" });
    expect(interpretBucketCreate({ status: null, output: "" }).hint).toContain("unknown");
  });
});
