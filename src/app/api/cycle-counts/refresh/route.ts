import { hasShipheroCredential, ShipheroError } from "@/lib/shiphero/client";
import { refreshCycleCounts } from "@/lib/cycle-counts-log";

export const dynamic = "force-dynamic";

// POST /api/cycle-counts/refresh — re-pull live status for every submitted
// count from ShipHero and update the local log.
export async function POST() {
  if (!hasShipheroCredential()) {
    return Response.json({ error: "ShipHero isn't connected." }, { status: 400 });
  }
  try {
    const { rows, syncedAt } = await refreshCycleCounts();
    return Response.json({ ok: true, rows, syncedAt });
  } catch (err) {
    if (err instanceof ShipheroError) {
      const status = err.kind === "throttled" ? 429 : 502;
      return Response.json({ error: err.message, kind: err.kind }, { status });
    }
    return Response.json({ error: err instanceof Error ? err.message : "Refresh failed." }, { status: 500 });
  }
}
