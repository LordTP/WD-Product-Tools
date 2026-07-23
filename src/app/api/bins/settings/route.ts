import { getBinsSettings, saveBinsSettings } from "@/lib/bins-cache";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ settings: await getBinsSettings() });
}

// POST /api/bins/settings { collateThreshold?, binTarget?, ageWarnDays?, ageStaleDays? }
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    const settings = await saveBinsSettings({
      collateThreshold: num(body.collateThreshold),
      binTarget: num(body.binTarget),
      ageWarnDays: num(body.ageWarnDays),
      ageStaleDays: num(body.ageStaleDays),
    });
    return Response.json({ settings });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to save." }, { status: 500 });
  }
}
