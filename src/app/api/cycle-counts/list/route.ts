import { getCycleCounts } from "@/lib/cycle-counts-log";

export const dynamic = "force-dynamic";

// GET /api/cycle-counts/list — the counts we've submitted, from the local log
// (instant, no API credits). Live status is refreshed via /refresh.
export async function GET() {
  try {
    const { rows, lastSyncedAt } = await getCycleCounts();
    return Response.json({ rows, lastSyncedAt });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to load." }, { status: 500 });
  }
}
