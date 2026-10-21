const COOKIE_NAME = "aegis_admin_session";
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const encoder = new TextEncoder();

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sign(value: string, secret: string) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))));
}

function secureEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function secureCookie() {
  return process.env.APP_ORIGIN?.startsWith("https://") ?? process.env.NODE_ENV === "production";
}

export function authRequired() {
  return process.env.AUTH_REQUIRED === "true" || Boolean(process.env.ADMIN_PASSWORD);
}

export function authConfigurationError() {
  if (!authRequired()) return null;
  if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < 12) return "ADMIN_PASSWORD must contain at least 12 characters.";
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) return "SESSION_SECRET must contain at least 32 characters.";
  return null;
}

export async function createSessionToken(now = Date.now()) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not configured.");
  const payload = String(Math.floor(now / 1000) + SESSION_TTL_SECONDS);
  return `${payload}.${await sign(payload, secret)}`;
}

export async function verifySessionToken(token: string | undefined, now = Date.now()) {
  if (!authRequired()) return true;
  const secret = process.env.SESSION_SECRET;
  if (!token || !secret) return false;
  const [expiresAt, signature, extra] = token.split(".");
  if (!expiresAt || !signature || extra || !/^\d+$/.test(expiresAt)) return false;
  if (Number(expiresAt) <= Math.floor(now / 1000)) return false;
  return secureEqual(signature, await sign(expiresAt, secret));
}

export function verifyAdminPassword(candidate: string) {
  const expected = process.env.ADMIN_PASSWORD;
  return Boolean(expected) && secureEqual(candidate, expected!);
}

export function sessionCookie(token: string) {
  return { name: COOKIE_NAME, value: token, httpOnly: true, sameSite: "strict" as const, secure: secureCookie(), path: "/", maxAge: SESSION_TTL_SECONDS };
}

export function expiredSessionCookie() {
  return { name: COOKIE_NAME, value: "", httpOnly: true, sameSite: "strict" as const, secure: secureCookie(), path: "/", maxAge: 0 };
}

export { COOKIE_NAME };
