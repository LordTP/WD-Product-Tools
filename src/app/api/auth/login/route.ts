import { NextResponse } from "next/server";
import { COOKIE_NAME, expectedToken, isAuthEnabled, verifyPassword } from "@/lib/auth";

// POST /api/auth/login { password } — verify the shared password, set the session cookie.
export async function POST(req: Request) {
  if (!isAuthEnabled()) {
    return NextResponse.json({ error: "Auth is not configured (APP_PASSWORD unset)." }, { status: 400 });
  }
  const body = await req.json().catch(() => ({}));
  if (!verifyPassword(String(body?.password ?? ""))) {
    return NextResponse.json({ error: "Incorrect password." }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE_NAME, expectedToken(), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });
  return res;
}
