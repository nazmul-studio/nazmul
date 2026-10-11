import { beforeEach, describe, expect, it } from "vitest";
import { initialContent } from "@/lib/content-model";
import { registerRuntime, type KVLike } from "./env";
import { handleStudioApi } from "./studio-api";
import { loadPublishedContent } from "./store";

const BASE = "https://site.test";
const PASSWORD = "correct horse battery staple";
const SECRET = "0123456789abcdef0123456789abcdef-secret";

const proc = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process;

function memoryKV(): KVLike {
  const m = new Map<string, string>();
  return {
    async get(key) {
      return m.get(key) ?? null;
    },
    async put(key, value) {
      m.set(key, String(value));
    },
    async delete(key) {
      m.delete(key);
    },
  };
}

type Init = { method?: string; body?: unknown; cookie?: string; origin?: string | null; ip?: string };
function call(path: string, init: Init = {}) {
  const headers = new Headers({ "cf-connecting-ip": init.ip ?? "1.2.3.4" });
  if (init.origin !== null) headers.set("origin", init.origin ?? BASE);
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  const request = new Request(`${BASE}/api/studio/${path}`, {
    method: init.method ?? "GET",
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  return handleStudioApi(request).then((r) => r!);
}

async function signIn(): Promise<string> {
  const res = await call("login", { method: "POST", body: { password: PASSWORD } });
  expect(res.status).toBe(200);
  const header = res.headers.get("set-cookie") ?? "";
  return header.split(";")[0] ?? "";
}

const realNow = Date.now;
/** Moves the clock forward (seconds) without fake timers; undone before every test. */
function advanceClock(seconds: number) {
  const base = realNow();
  Date.now = () => base + seconds * 1000;
}

beforeEach(() => {
  Date.now = realNow;
  proc.env["ADMIN_PASSWORD"] = PASSWORD;
  proc.env["SESSION_SECRET"] = SECRET;
  registerRuntime(new Request(BASE), { CONTENT: memoryKV() });
});

describe("studio api: configuration", () => {
  it("ignores unrelated paths", async () => {
    expect(await handleStudioApi(new Request(`${BASE}/`))).toBeNull();
  });

  it("stays locked when secrets are missing or weak", async () => {
    proc.env["ADMIN_PASSWORD"] = "short";
    const session = await (await call("session")).json();
    expect(session.configured).toBe(false);
    expect(session.missing[0]).toContain("ADMIN_PASSWORD");
    const login = await call("login", { method: "POST", body: { password: "short" } });
    expect(login.status).toBe(503);
  });

  it("reports a missing KV binding", async () => {
    registerRuntime(new Request(BASE), { CONTENT: undefined });
    delete (globalThis as Record<string, unknown>)["__studio_env_slots__"];
    const session = await (await call("session")).json();
    expect(session.configured).toBe(false);
    expect(session.missing.join(" ")).toContain("CONTENT");
  });
});

describe("studio api: authentication", () => {
  it("rejects a wrong password and counts attempts", async () => {
    const res = await call("login", { method: "POST", body: { password: "nope-nope-nope" } });
    expect(res.status).toBe(401);
    expect((await res.json()).attemptsLeft).toBe(4);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("locks out an address after five failures, even for the right password", async () => {
    for (let i = 0; i < 5; i++) await call("login", { method: "POST", body: { password: "wrong-wrong-wrong" }, ip: "9.9.9.9" });
    const res = await call("login", { method: "POST", body: { password: PASSWORD }, ip: "9.9.9.9" });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("900");
    const other = await call("login", { method: "POST", body: { password: PASSWORD }, ip: "8.8.8.8" });
    expect(other.status).toBe(200);
  });

  it("issues a hardened session cookie", async () => {
    const res = await call("login", { method: "POST", body: { password: PASSWORD } });
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie.startsWith("__Host-studio=")).toBe(true);
    for (const flag of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/"]) expect(cookie).toContain(flag);
  });

  it("recognises a valid session and rejects forged or tampered ones", async () => {
    const cookie = await signIn();
    expect((await (await call("session", { cookie })).json()).authenticated).toBe(true);
    expect((await (await call("session")).json()).authenticated).toBe(false);
    const tampered = cookie.slice(0, -3) + (cookie.endsWith("AAA") ? "BBB" : "AAA");
    expect((await call("content", { cookie: tampered })).status).toBe(401);
    const [name, value = ""] = cookie.split("=");
    const [payload = ""] = value.split(".");
    const forged = `${name}=${payload}.${"A".repeat(43)}`;
    expect((await call("content", { cookie: forged })).status).toBe(401);
  });

  it("invalidates sessions when the session secret changes", async () => {
    const cookie = await signIn();
    proc.env["SESSION_SECRET"] = "a-completely-different-secret-value-123456";
    expect((await call("content", { cookie })).status).toBe(401);
  });

  it("refuses login from another origin and logs out cleanly", async () => {
    const res = await call("login", { method: "POST", body: { password: PASSWORD }, origin: "https://evil.test" });
    expect(res.status).toBe(403);
    const out = await call("logout", { method: "POST", body: {} });
    expect(out.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
  });
});

describe("studio api: content", () => {
  it("requires a session", async () => {
    expect((await call("content")).status).toBe(401);
    expect((await call("revisions")).status).toBe(401);
    expect((await call("content", { method: "PUT", body: { baseVersion: 0, content: initialContent } })).status).toBe(401);
  });

  it("starts at version 0 with the built-in content", async () => {
    const cookie = await signIn();
    const body = await (await call("content", { cookie })).json();
    expect(body.version).toBe(0);
    expect(body.content).toEqual(initialContent);
  });

  it("publishes, versions, and keeps revisions", async () => {
    const cookie = await signIn();
    const first = { ...initialContent, headline: "First headline" };
    const res = await call("content", { method: "PUT", cookie, body: { baseVersion: 0, content: first } });
    expect(res.status).toBe(200);
    const saved = await res.json();
    expect(saved.version).toBe(1);
    expect((await loadPublishedContent()).content.headline).toBe("First headline");

    const second = { ...first, headline: "Second headline" };
    const res2 = await call("content", { method: "PUT", cookie, body: { baseVersion: 1, content: second } });
    expect((await res2.json()).version).toBe(2);
    const { revisions } = await (await call("revisions", { cookie })).json();
    expect(revisions).toHaveLength(1);
    expect(revisions[0].content.headline).toBe("First headline");
    expect((await loadPublishedContent()).version).toBe(2);
  });

  it("detects conflicting edits instead of overwriting", async () => {
    const cookie = await signIn();
    await call("content", { method: "PUT", cookie, body: { baseVersion: 0, content: { ...initialContent, headline: "A" } } });
    const stale = await call("content", { method: "PUT", cookie, body: { baseVersion: 0, content: { ...initialContent, headline: "B" } } });
    expect(stale.status).toBe(409);
    expect((await stale.json()).current.content.headline).toBe("A");
  });

  it("validates on the server and refuses unsafe links", async () => {
    const cookie = await signIn();
    const bad = { ...initialContent, github: "javascript:alert(1)" };
    const res = await call("content", { method: "PUT", cookie, body: { baseVersion: 0, content: bad } });
    expect(res.status).toBe(422);
    expect((await res.json()).issues[0].path).toBe("github");
    expect((await loadPublishedContent()).version).toBe(0);
  });

  it("blocks cross-site writes, non-JSON bodies and oversize bodies", async () => {
    const cookie = await signIn();
    const body = { baseVersion: 0, content: initialContent };
    expect((await call("content", { method: "PUT", cookie, body, origin: "https://evil.test" })).status).toBe(403);
    expect((await call("content", { method: "PUT", cookie, body, origin: null })).status).toBe(403);
    const text = await handleStudioApi(
      new Request(`${BASE}/api/studio/content`, { method: "PUT", headers: { cookie, origin: BASE, "content-type": "text/plain" }, body: "x" }),
    );
    expect(text!.status).toBe(415);
    const huge = { baseVersion: 0, content: { ...initialContent, about: "x".repeat(2_100_000) } };
    expect((await call("content", { method: "PUT", cookie, body: huge })).status).toBe(413);
  });

  it("falls back to built-in content when nothing is published", async () => {
    expect(await loadPublishedContent()).toEqual({ version: 0, content: initialContent });
  });
});

describe("studio api: sign-out is enforced on the server", () => {
  it("logout revokes that session, not just the browser's copy of the cookie", async () => {
    const cookie = await signIn();
    expect((await call("content", { cookie })).status).toBe(200);
    const out = await call("logout", { method: "POST", body: {}, cookie });
    expect((await out.json()).revoked).toBe(true);
    // The cookie still verifies cryptographically, but must now be refused.
    expect((await call("content", { cookie })).status).toBe(401);
    expect((await (await call("session", { cookie })).json()).authenticated).toBe(false);
  });

  it("logout without a session still clears the cookie and says nothing was revoked", async () => {
    const out = await call("logout", { method: "POST", body: {} });
    expect(out.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
    expect((await out.json()).revoked).toBe(false);
  });

  it("revoking one session leaves the others alone", async () => {
    const a = await signIn();
    const b = await signIn();
    await call("logout", { method: "POST", body: {}, cookie: a });
    expect((await call("content", { cookie: a })).status).toBe(401);
    expect((await call("content", { cookie: b })).status).toBe(200);
  });

  it("logout-all needs a session and a same-origin request", async () => {
    expect((await call("logout-all", { method: "POST", body: {} })).status).toBe(401);
    const cookie = await signIn();
    expect((await call("logout-all", { method: "POST", body: {}, cookie, origin: "https://evil.test" })).status).toBe(403);
    expect((await call("content", { cookie })).status).toBe(200);
    expect((await call("logout-all", { cookie })).status).toBe(405);
  });

  it("logout-all signs out every device, and a fresh sign-in afterwards works", async () => {
    const laptop = await signIn();
    const phone = await signIn();
    const res = await call("logout-all", { method: "POST", body: {}, cookie: laptop });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
    expect((await call("content", { cookie: laptop })).status).toBe(401);
    expect((await call("content", { cookie: phone })).status).toBe(401);
    advanceClock(5); // sessions are timestamped to the second; a later sign-in is a new session
    const fresh = await signIn();
    expect((await call("content", { cookie: fresh })).status).toBe(200);
  });

  it("refuses to trust a session when it cannot check for revocation", async () => {
    const cookie = await signIn();
    registerRuntime(new Request(BASE), { CONTENT: undefined });
    delete (globalThis as Record<string, unknown>)["__studio_env_slots__"];
    expect((await call("content", { cookie })).status).toBe(503);
  });
});

describe("studio api: request size limits", () => {
  const send = (path: string, method: string, body: string, cookie?: string) =>
    handleStudioApi(
      new Request(`${BASE}/api/studio/${path}`, {
        method,
        // No Content-Length header: the size must be enforced while reading, not trusted from a header.
        headers: { origin: BASE, "content-type": "application/json", "cf-connecting-ip": "9.9.9.9", ...(cookie ? { cookie } : {}) },
        body,
      }),
    ).then((r) => r!);

  it("counts bytes, not characters, even when Content-Length is missing", async () => {
    const cookie = await signIn();
    // 800k Bengali letters is 800k characters but about 2.4 MB on the wire.
    const body = JSON.stringify({ baseVersion: 0, content: { ...initialContent, about: "ক".repeat(800_000) } });
    expect(body.length).toBeLessThan(2_000_000);
    expect((await send("content", "PUT", body, cookie)).status).toBe(413);
  });

  it("rejects an oversized body streamed without a declared length", async () => {
    const cookie = await signIn();
    expect((await send("content", "PUT", "x".repeat(2_100_000), cookie)).status).toBe(413);
  });

  it("caps the unauthenticated login body at a few kilobytes and does not count it as a failed attempt", async () => {
    const big = JSON.stringify({ password: "x", pad: "y".repeat(10_000) });
    expect((await send("login", "POST", big)).status).toBe(413);
    const wrong = await call("login", { method: "POST", body: { password: "nope" }, ip: "9.9.9.9" });
    expect((await wrong.json()).attemptsLeft).toBe(4);
  });
});

describe("studio api: stored content", () => {
  it("does not store a version twice if an earlier publish stored the revision but failed to store the content", async () => {
    const m = new Map<string, string>();
    let failContent = false;
    const kv: KVLike = {
      async get(key) { return m.get(key) ?? null; },
      async put(key, value) {
        if (failContent && key === "content:v1") throw new Error("simulated KV outage");
        m.set(key, String(value));
      },
      async delete(key) { m.delete(key); },
    };
    registerRuntime(new Request(BASE), { CONTENT: kv });
    const cookie = await signIn();
    const put = (version: number, headline: string) =>
      call("content", { method: "PUT", cookie, body: { baseVersion: version, content: { ...initialContent, headline } } });
    expect((await put(0, "one")).status).toBe(200);
    failContent = true;
    expect((await put(1, "two")).status).toBe(500); // revision of v1 written, content not
    failContent = false;
    expect((await put(1, "two")).status).toBe(200); // retry
    const { revisions } = await (await call("revisions", { cookie })).json();
    expect(revisions).toHaveLength(1);
    expect(revisions[0].version).toBe(1);
  });

  it('upgrades the legacy "NAZMUL" wordmark on read so the live site looks unchanged', async () => {
    const cookie = await signIn();
    await call("content", { method: "PUT", cookie, body: { baseVersion: 0, content: { ...initialContent, wordmark: "NAZMUL" } } });
    expect((await loadPublishedContent()).content.wordmark).toBe("NAZMUL HASAN");
    await call("content", { method: "PUT", cookie, body: { baseVersion: 1, content: { ...initialContent, wordmark: "HASAN" } } });
    expect((await loadPublishedContent()).content.wordmark).toBe("HASAN");
  });
});

describe("studio api: version notes", () => {
  const put = (cookie: string, baseVersion: number, headline: string, note?: unknown) =>
    call("content", { method: "PUT", cookie, body: { baseVersion, content: { ...initialContent, headline }, ...(note !== undefined ? { note } : {}) } });

  it("stores a trimmed single-line note with the version and keeps it on the revision when replaced", async () => {
    const cookie = await signIn();
    const first = await (await put(cookie, 0, "one", "  Fixed   the\nintro  ")).json();
    expect(first.note).toBe("Fixed the intro");
    expect((await (await call("content", { cookie })).json()).note).toBe("Fixed the intro");
    await put(cookie, 1, "two", "Second");
    const { revisions } = await (await call("revisions", { cookie })).json();
    expect(revisions[0].version).toBe(1);
    expect(revisions[0].note).toBe("Fixed the intro");
  });

  it("works without a note, and rejects a note that is too long or not text", async () => {
    const cookie = await signIn();
    expect((await (await put(cookie, 0, "one")).json()).note).toBe("");
    const tooLong = await put(cookie, 1, "two", "x".repeat(201));
    expect(tooLong.status).toBe(422);
    expect((await tooLong.json()).issues[0].path).toBe("note");
    expect((await put(cookie, 1, "two", 42)).status).toBe(422);
    expect((await put(cookie, 1, "two", "x".repeat(200))).status).toBe(200);
  });

  it("reads records saved before notes existed as having no note", async () => {
    const m = new Map<string, string>([["content:v1", JSON.stringify({ version: 3, updatedAt: "2025-01-01T00:00:00.000Z", content: initialContent })]]);
    const kv: KVLike = { async get(k) { return m.get(k) ?? null; }, async put(k, v) { m.set(k, String(v)); }, async delete(k) { m.delete(k); } };
    registerRuntime(new Request(BASE), { CONTENT: kv });
    const cookie = await signIn();
    const body = await (await call("content", { cookie })).json();
    expect(body.version).toBe(3);
    expect(body.note).toBe("");
  });
});

