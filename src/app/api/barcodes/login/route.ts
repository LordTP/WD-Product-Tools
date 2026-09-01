import { NextResponse } from "next/server";
import { BARCODES_COOKIE, barcodesToken, isBarcodesAuthEnabled, verifyBarcodesPassword } from "@/lib/barcodes-auth";

export const dynamic = "force-dynamic";

// POST /api/barcodes/login { password } — the Label Press's own gate.
// Long-lived cookie (Chrome's 400-day cap) so the warehouse PC stays in.
export async function POST(req: Request) {
  if (!isBarcodesAuthEnabled()) {
    return NextResponse.json({ error: "Barcodes auth is not configured (BARCODES_PASSWORD unset)." }, { status: 400 });
  }
  const body = await req.json().catch(() => ({}));
  if (!verifyBarcodesPassword(String(body?.password ?? ""))) {
    return NextResponse.json({ error: "Incorrect password." }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(BARCODES_COOKIE, barcodesToken(), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 400,
  });
  return res;
}
