import { getOpsStats, warmOpsStats } from "@/lib/ops-cache";
import { hasShipheroCredential } from "@/lib/shiphero/client";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// GET /api/ops/stats — the last-synced snapshot (instant, no credits).
// GET /api/ops/stats?warm=1 — same, but if the snapshot is older than ~2.5 min
// a background re-scan starts (single-flight); fresh data lands on a later poll.
// Used by TV mode so the wallboard keeps itself current.
export async function GET(req: Request) {
  try {
    const warm = new URL(req.url).searchParams.get("warm") === "1" && hasShipheroCredential();
    const stats = warm ? await warmOpsStats() : await getOpsStats();
    return Response.json({ stats });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to load." }, { status: 500 });
  }
}
