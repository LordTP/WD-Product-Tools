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
  // The label sheet is a *published* Google Sheet (public by design), so the
  // link ships as a default; BARCODES_SHEET_CSV_URL overrides it if it moves.
  const DEFAULT_SHEET =
    "https://docs.google.com/spreadsheets/d/e/2PACX-1vTxDoNkHr2g8DE4PWhgt7_bSkdNpo7Gkm2mZ85N6nYUbvDPdrPfQQGe96zIDwr10XpnoYimkxvGKHMJ/pubhtml?gid=457232960&single=true";
  const raw = process.env.BARCODES_SHEET_CSV_URL || process.env.GOOGLE_SHEET_CSV_URL || DEFAULT_SHEET;
  try {
    const res = await fetch(normaliseSheetUrl(raw), { cache: "no-store" });
    if (!res.ok) return Response.json({ error: `Google Sheets returned ${res.status}.` }, { status: 502 });
    const text = await res.text();
    return new Response(text, { headers: { "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Could not reach Google Sheets." }, { status: 502 });
  }
}
