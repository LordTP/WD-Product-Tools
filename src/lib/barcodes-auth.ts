// Separate, simpler gate for the Barcode Label Press (/barcodes). Warehouse
// staff get their own shared password (BARCODES_PASSWORD) so they never need
// the main product-tool login. Mirrors lib/auth.ts: the cookie stores a salted
// hash, never the password. Gate is off when BARCODES_PASSWORD is unset (dev).

import { createHash, timingSafeEqual } from "node:crypto";

export const BARCODES_COOKIE = "wd_barcodes";
const SALT = "wanderdoll-barcode-press-v1";

function configuredPassword(): string {
  return process.env.BARCODES_PASSWORD ?? "";
}

export function isBarcodesAuthEnabled(): boolean {
  return configuredPassword().length > 0;
}

export function barcodesToken(): string {
  return createHash("sha256").update(`${SALT}:${configuredPassword()}`).digest("hex");
}

export function verifyBarcodesPassword(input: string): boolean {
  const pw = configuredPassword();
  if (!pw) return false;
  const a = Buffer.from(input);
  const b = Buffer.from(pw);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function isValidBarcodesToken(token: string | undefined): boolean {
  if (!token) return false;
  const expected = barcodesToken();
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
