import { syncStatus } from "@/lib/sync-registry";

export const dynamic = "force-dynamic";

// GET /api/sync/status — freshness of every cache in one place (drives the
// dashboard's staleness stamps and any "is a sync running?" UI).
export async function GET() {
  try {
    const jobs = await syncStatus();
    return Response.json({ jobs, scheduler: process.env.SYNC_SCHEDULER === "off" ? "off" : "on" });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed." }, { status: 500 });
  }
}
