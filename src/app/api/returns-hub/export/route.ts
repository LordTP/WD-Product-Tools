import { buildReturnsExport } from "@/lib/returns-export";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

// POST /api/returns-hub/export { from, to, includeLegacy } -> styled .xlsx.
// Reads the local cache only — 0 ShipHero credits.
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const from = DAY.test(body.from) ? body.from : "2026-07-14";
    const to = DAY.test(body.to) ? body.to : new Date().toISOString().slice(0, 10);
    const includeLegacy = body.includeLegacy !== false;
    const { buffer, filename } = await buildReturnsExport({ from, to, includeLegacy });
    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Export failed." },
      { status: 500 },
    );
  }
}
