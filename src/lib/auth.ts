// Simple single-password gate for the internal tool. One shared password set via
// APP_PASSWORD. On success we set an httpOnly cookie holding a salted hash of the
// password (never the password itself); the proxy checks that hash on every request.
//
// Auth is ENABLED only when APP_PASSWORD is set. With it unset (local dev) the gate
// is off and everything is open — so production MUST set APP_PASSWORD.

import { createHash, timingSafeEqual } from "node:crypto";

export const COOKIE_NAME = "wd_auth";
const SALT = "wanderdoll-product-tools-v1"; // ties the cookie hash to this app

function configuredPassword(): string {
  return process.env.APP_PASSWORD ?? "";
}

/** Gate is active only when a password is configured. */
export function isAuthEnabled(): boolean {
  return configuredPassword().length > 0;
}

/** The value stored in the auth cookie: a salted SHA-256 of the password. */
export function expectedToken(): string {
  return createHash("sha256").update(`${SALT}:${configuredPassword()}`).digest("hex");
}

/** Constant-time-ish check of a submitted password against APP_PASSWORD. */
export function verifyPassword(input: string): boolean {
  const pw = configuredPassword();
  if (!pw) return false;
  const a = Buffer.from(input);
  const b = Buffer.from(pw);
  if (a.length !== b.length) return false; // length isn't secret for a shared password
  return timingSafeEqual(a, b);
}

/** Is this cookie value a valid session token? */
export function isValidToken(token: string | undefined): boolean {
  if (!token) return false;
  const expected = expectedToken();
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
