import { hasShipheroCredential, ShipheroError } from "@/lib/shiphero/client";
import { generateDay } from "@/lib/warehouse-cache";

export const dynamic = "force-dynamic";
// Pulls a full day of inventory changes + shipments; give it room.
export const maxDuration = 300;

// POST /api/warehouse/generate { date: "YYYY-MM-DD" }
// Pulls the day from ShipHero and caches it. Read-only against ShipHero.
export async function POST(req: Request) {
  if (!hasShipheroCredential()) {
    return Response.json({ error: "ShipHero isn't connected." }, { status: 400 });
  }
  try {
    const body = await req.json().catch(() => ({}));
    const date = typeof body.date === "string" ? body.date : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return Response.json({ error: "Give a date as YYYY-MM-DD." }, { status: 400 });
    }
    const day = await generateDay(date);
    return Response.json({ ok: true, day });
  } catch (err) {
    if (err instanceof ShipheroError) {
      const status = err.kind === "throttled" ? 429 : 502;
      return Response.json({ error: err.message, kind: err.kind }, { status });
    }
    return Response.json({ error: err instanceof Error ? err.message : "Generate failed." }, { status: 500 });
  }
}
