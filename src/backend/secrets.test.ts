import { beforeEach, describe, expect, it } from "vitest";
import { loadSecrets } from "./auth";
import { registerRuntime } from "./env";
import { handleStudioApi } from "./studio-api";
import { createMemoryKV } from "./store";

const BASE = "https://site.test";
const PASSWORD = "correct horse battery staple";
const SECRET = "0123456789abcdef0123456789abcdef-secret";
const proc = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process;

/** Makes the Worker "receive" exactly these variables (plus a KV namespace), and none from process.env. */
function receive(vars: Record<string, string>) {
  delete proc.env["ADMIN_PASSWORD"];
  delete proc.env["SESSION_SECRET"];
  registerRuntime(new Request(BASE), { CONTENT: createMemoryKV(), ...vars });
}
const call = (path: string, init: RequestInit = {}) =>
  handleStudioApi(new Request(`${BASE}/api/studio/${path}`, { ...init, headers: { origin: BASE, "content-type": "application/json", "cf-connecting-ip": "5.6.7.8", ...(init.headers ?? {}) } })).then((r) => r!);

beforeEach(() => receive({ ADMIN_PASSWORD: PASSWORD, SESSION_SECRET: SECRET }));

describe("finding the secrets by name", () => {
  it("is ready with the exact names", async () => {
    expect((await loadSecrets()).ready).toBe(true);
  });

  it("also accepts a name that differs only in case, spaces, dashes or underscores (easy to mistype on a phone)", async () => {
    for (const name of ["Session_Secret", "SESSION-SECRET", "session secret ", "SESSIONSECRET", " SESSION_SECRET"]) {
      receive({ ADMIN_PASSWORD: PASSWORD, [name]: SECRET });
      const secrets = await loadSecrets();
      expect(secrets.ready).toBe(true);
    }
    receive({ "admin-password": PASSWORD, SESSION_SECRET: SECRET });
    expect((await loadSecrets()).ready).toBe(true);
  });

  it("prefers the exact name when both an exact and a look-alike exist", async () => {
    receive({ "Session_Secret": "x".repeat(40), ADMIN_PASSWORD: PASSWORD, SESSION_SECRET: SECRET }); // look-alike listed first
    const secrets = await loadSecrets();
    expect(secrets.ready && secrets.sessionSecret).toBe(SECRET);
  });

  it("signs in through the API with a look-alike name", async () => {
    receive({ ADMIN_PASSWORD: PASSWORD, "Session_Secret": SECRET });
    const res = await call("login", { method: "POST", body: JSON.stringify({ password: PASSWORD }) });
    expect(res.status).toBe(200);
  });
});

describe("telling the owner what is wrong, without giving anything away", () => {
  const hintsOf = async () => {
    const s = await loadSecrets();
    return s.ready ? [] : s.hints;
  };

  it("says no such variable reached the server, and to deploy if it was just added", async () => {
    receive({ ADMIN_PASSWORD: PASSWORD });
    const hints = await hintsOf();
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("No variable named SESSION_SECRET reached the server");
    expect(hints[0]).toContain("deploy");
  });

  it("names a close-but-wrong variable so the typo is obvious, and asks for it to be renamed", async () => {
    for (const typo of ["SESSION_SECERT", "SESION_SECRET", "SESSION_SECRETS", "SESSIONSECRET_1"]) {
      receive({ ADMIN_PASSWORD: PASSWORD, [typo]: SECRET });
      const hints = await hintsOf();
      expect(hints[0]).toContain(typo);
      expect(hints[0]).toContain("Rename that one to SESSION_SECRET");
    }
  });

  it("reports a variable that arrived but is too short, with its length", async () => {
    receive({ ADMIN_PASSWORD: PASSWORD, SESSION_SECRET: "x".repeat(20) });
    expect(await hintsOf()).toEqual(["SESSION_SECRET reached the server but is only 20 characters long; it needs at least 32."]);
    receive({ ADMIN_PASSWORD: "short", SESSION_SECRET: SECRET });
    expect((await hintsOf())[0]).toContain("ADMIN_PASSWORD reached the server but is only 5 characters long");
  });

  it("does the same when the name is a look-alike that was accepted but the value is too short", async () => {
    receive({ ADMIN_PASSWORD: PASSWORD, "Session_Secret": "x".repeat(20) });
    expect((await hintsOf())[0]).toContain("only 20 characters long");
  });

  it("never mentions a secret that works, never repeats any value, and never lists unrelated variables", async () => {
    receive({ ADMIN_PASSWORD: PASSWORD, SESSION_SECRET: "tooshort-value-123", STRIPE_API_KEY: "sk_live_abc", MEDIA_TOKEN: "t0k3n", PATH: "/usr/bin" });
    const all = (await hintsOf()).join("\n");
    expect(all).not.toContain("ADMIN_PASSWORD");
    for (const leak of [PASSWORD, "tooshort-value-123", "sk_live_abc", "t0k3n", "STRIPE_API_KEY", "MEDIA_TOKEN", "PATH"]) expect(all).not.toContain(leak);
    expect(all).toContain("18 characters"); // the length is the only fact about the broken one
  });

  it("is ready with no hints once everything is right", async () => {
    expect(await hintsOf()).toEqual([]);
  });
});

describe("what the Studio gets while it is locked", () => {
  it("includes the hints in the session check, in a failed sign-in and in every guarded request", async () => {
    receive({ ADMIN_PASSWORD: PASSWORD, SESSION_SECERT: SECRET });
    const session = await (await call("session")).json();
    expect(session.configured).toBe(false);
    expect(session.missing).toEqual(["SESSION_SECRET (at least 32 characters)"]);
    expect(session.hints[0]).toContain("SESSION_SECERT");

    const login = await call("login", { method: "POST", body: JSON.stringify({ password: PASSWORD }) });
    expect(login.status).toBe(503);
    expect((await login.json()).hints[0]).toContain("SESSION_SECERT");

    const content = await call("content");
    expect(content.status).toBe(503);
    expect((await content.json()).hints[0]).toContain("SESSION_SECERT");
  });

  it("sends no hints once configured", async () => {
    const session = await (await call("session")).json();
    expect(session).toEqual({ authenticated: false, configured: true });
  });
});
