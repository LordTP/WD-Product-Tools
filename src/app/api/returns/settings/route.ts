import { getReturnsSettings, saveReturnsSettings, markReturnsExported } from "@/lib/returns";

export const dynamic = "force-dynamic";

// GET /api/returns/settings — current settings.
export async function GET() {
  return Response.json({ settings: await getReturnsSettings() });
}

// POST /api/returns/settings — update settings, or stamp last-export time.
// Body: { exportStatuses?, sellableLabel?, damagedLabel? } or { markExported: true }.
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    if (body.markExported === true) {
      await markReturnsExported(new Date().toISOString());
      return Response.json({ settings: await getReturnsSettings() });
    }
    const patch: Record<string, unknown> = {};
    if (Array.isArray(body.exportStatuses)) patch.exportStatuses = body.exportStatuses.map(String);
    if (typeof body.sellableLabel === "string") patch.sellableLabel = body.sellableLabel;
    if (typeof body.damagedLabel === "string") patch.damagedLabel = body.damagedLabel;
    const settings = await saveReturnsSettings(patch);
    return Response.json({ settings });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to save." }, { status: 500 });
  }
}
