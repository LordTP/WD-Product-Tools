// Next.js 16 proxy (formerly "middleware") — runs on the nodejs runtime. Gates the
// whole app behind the shared password: any request without a valid auth cookie is
// redirected to /login. The login page + auth API are always allowed.

import { NextResponse, type NextRequest } from "next/server";
import { COOKIE_NAME, isAuthEnabled, isValidToken } from "@/lib/auth";

export function proxy(req: NextRequest) {
  // Gate is off entirely when no APP_PASSWORD is configured (local dev).
  if (!isAuthEnabled()) return NextResponse.next();

  const { pathname } = req.nextUrl;
  // Always-public: the login page and the auth endpoints.
  if (pathname === "/login" || pathname.startsWith("/api/auth/")) {
    return NextResponse.next();
  }

  if (isValidToken(req.cookies.get(COOKIE_NAME)?.value)) {
    return NextResponse.next();
  }

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = pathname && pathname !== "/" ? `?from=${encodeURIComponent(pathname)}` : "";
  return NextResponse.redirect(url);
}

// Run on everything except Next internals and static asset files.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp|woff|woff2|ttf)$).*)"],
};
