import { getOpsStats } from "@/lib/ops-cache";

export const dynamic = "force-dynamic";

// GET /api/ops/stats — the last-synced dashboard snapshot (instant, no credits).
export async function GET() {
  try {
    const stats = await getOpsStats();
    return Response.json({ stats });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to load." }, { status: 500 });
  }
}
