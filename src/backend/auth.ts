// Server-only: password check and signed, stateless session cookies (WebCrypto only).
import { getSecret, similarBindingNames } from "./env";

export const SESSION_TTL = 7 * 24 * 60 * 60; // seconds
export const MIN_PASSWORD = 12;
export const MIN_SESSION_SECRET = 32;

const enc = new TextEncoder();

export type SecretsState =
  | { ready: true; password: string; sessionSecret: string }
  | { ready: false; missing: string[]; hints: string[] };

/** Both secrets must be present and long enough, otherwise the admin stays locked. */
export async function loadSecrets(): Promise<SecretsState> {
  const password = await getSecret("ADMIN_PASSWORD");
  const sessionSecret = await getSecret("SESSION_SECRET");
  if (password && password.length >= MIN_PASSWORD && sessionSecret && sessionSecret.length >= MIN_SESSION_SECRET) {
    return { ready: true, password, sessionSecret };
  }
  const missing: string[] = [];
  if (!password || password.length < MIN_PASSWORD) missing.push(`ADMIN_PASSWORD (at least ${MIN_PASSWORD} characters)`);
  if (!sessionSecret || sessionSecret.length < MIN_SESSION_SECRET)
    missing.push(`SESSION_SECRET (at least ${MIN_SESSION_SECRET} characters)`);
  return { ready: false, missing, hints: await secretHints([["ADMIN_PASSWORD", MIN_PASSWORD, password], ["SESSION_SECRET", MIN_SESSION_SECRET, sessionSecret]]) };
}

/**
 * Plain-language reasons for each secret that is not usable, so a typo or a missing deploy is obvious. Only for secrets
 * that are NOT usable (a working one is never mentioned), and only names and lengths: never a value. These reach the
 * browser only while the Studio is locked, when nobody can sign in anyway.
 */
async function secretHints(secrets: Array<[string, number, string | undefined]>): Promise<string[]> {
  const hints: string[] = [];
  for (const [name, min, value] of secrets) {
    if (value && value.length >= min) continue;
    if (value) {
      hints.push(`${name} reached the server but is only ${value.length} characters long; it needs at least ${min}.`);
      continue;
    }
    const similar = await similarBindingNames(name);
    hints.push(
      similar.length > 0
        ? `No variable named exactly ${name} reached the server. It did receive: ${similar.join(", ")}. Rename that one to ${name}.`
        : `No variable named ${name} reached the server. If you just added it, deploy that change and reload; otherwise check the name.`,
    );
  }
  return hints;
}

function toB64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** Constant-time comparison (both sides are hashed first so lengths never leak). */
export async function passwordMatches(input: string, expected: string): Promise<boolean> {
  if (input.length === 0 || input.length > 512) return false;
  return equalBytes(await sha256(input), await sha256(expected));
}

function hmacKey(secret: string) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export const cookieName = (secure: boolean) => (secure ? "__Host-studio" : "studio");

function cookieAttrs(secure: boolean, maxAge: number): string {
  return `Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

/** The Set-Cookie header value for a fresh session. */
export async function issueSession(secret: string, secure: boolean): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const nonce = toB64url(crypto.getRandomValues(new Uint8Array(12)));
  const payload = toB64url(enc.encode(JSON.stringify({ v: 1, iat: now, exp: now + SESSION_TTL, n: nonce })));
  const signature = toB64url(new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(payload))));
  return `${cookieName(secure)}=${payload}.${signature}; ${cookieAttrs(secure, SESSION_TTL)}`;
}

export function clearSessionCookie(secure: boolean): string {
  return `${cookieName(secure)}=; ${cookieAttrs(secure, 0)}`;
}

function getCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

export const isSecureRequest = (request: Request) => new URL(request.url).protocol === "https:";

export type SessionData = { nonce: string; iat: number; exp: number };

/**
 * The session inside a valid, unexpired cookie signed with `secret`, or null. This only proves the cookie is
 * genuine: whether it has since been revoked (sign-out) is checked against storage by the caller.
 */
export async function readSessionData(request: Request, secret: string): Promise<SessionData | null> {
  const value = getCookie(request.headers.get("cookie"), cookieName(isSecureRequest(request)));
  if (!value) return null;
  const dot = value.indexOf(".");
  if (dot <= 0) return null;
  const payload = value.slice(0, dot);
  try {
    const valid = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      fromB64url(value.slice(dot + 1)),
      enc.encode(payload),
    );
    if (!valid) return null;
    const data = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as { v?: unknown; iat?: unknown; exp?: unknown; n?: unknown };
    const now = Math.floor(Date.now() / 1000);
    if (data.v !== 1 || typeof data.exp !== "number" || typeof data.iat !== "number" || typeof data.n !== "string" || data.n === "") return null;
    if (data.exp <= now || data.iat > now + 60) return null;
    return { nonce: data.n, iat: data.iat, exp: data.exp };
  } catch {
    return null;
  }
}

/** True when the cookie is genuine and unexpired (signature only; see readSessionData). */
export async function readSession(request: Request, secret: string): Promise<boolean> {
  return (await readSessionData(request, secret)) !== null;
}

/** CSRF defence for state-changing requests: the browser must say they came from our own origin. */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin) return origin === new URL(request.url).origin;
  return request.headers.get("sec-fetch-site") === "same-origin";
}

export function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "unknown";
}
