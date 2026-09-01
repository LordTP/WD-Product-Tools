import { cookies } from "next/headers";
import { BARCODES_COOKIE, isBarcodesAuthEnabled, isValidBarcodesToken } from "@/lib/barcodes-auth";

export const dynamic = "force-dynamic";

// GET /api/barcodes/sheet — proxies the published Google Sheet CSV that feeds
// the Label Press (published sheets don't allow direct browser fetches).
// Guarded by the barcodes cookie; a 401 here is what shows the password gate.
function normaliseSheetUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.hostname.includes("docs.google.com")) {
      if (url.pathname.endsWith("/pubhtml")) url.pathname = url.pathname.replace(/\/pubhtml$/, "/pub");
      url.searchParams.set("output", "csv");
    }
    return url.toString();
  } catch {
    return raw;
  }
}

export async function GET() {
  if (isBarcodesAuthEnabled()) {
    const token = (await cookies()).get(BARCODES_COOKIE)?.value;
    if (!isValidBarcodesToken(token)) {
      return Response.json({ error: "auth" }, { status: 401 });
    }
  }
  const raw = process.env.BARCODES_SHEET_CSV_URL || process.env.GOOGLE_SHEET_CSV_URL;
  if (!raw) {
    return Response.json({ error: "BARCODES_SHEET_CSV_URL is not set — add the published Google Sheet CSV link to the environment." }, { status: 503 });
  }
  try {
    const res = await fetch(normaliseSheetUrl(raw), { cache: "no-store" });
    if (!res.ok) return Response.json({ error: `Google Sheets returned ${res.status}.` }, { status: 502 });
    const text = await res.text();
    return new Response(text, { headers: { "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Could not reach Google Sheets." }, { status: 502 });
  }
}
