import { hasShipheroCredential, ShipheroError } from "@/lib/shiphero/client";
import { runJob } from "@/lib/sync-registry";

export const dynamic = "force-dynamic";

// POST /api/inventory/sync — pull a fresh warehouse snapshot into the
// inventory-locations cache. Queued like every other sync.
export async function POST() {
  if (!hasShipheroCredential()) {
    return Response.json({ error: "ShipHero isn't connected." }, { status: 400 });
  }
  try {
    const r = await runJob("inventoryLocations");
    if (!r.ok) throw new Error(r.error ?? "Sync failed.");
    return Response.json({ ok: true, ...(r.result as object) });
  } catch (err) {
    if (err instanceof ShipheroError) {
      const status = err.kind === "throttled" ? 429 : 502;
      return Response.json({ error: err.message, kind: err.kind }, { status });
    }
    return Response.json({ error: err instanceof Error ? err.message : "Sync failed." }, { status: 500 });
  }
}
