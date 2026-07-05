import { hasShipheroCredential, ShipheroError } from "@/lib/shiphero/client";
import { syncPoCache } from "@/lib/po-cache";

// POST /api/po/sync { since?, full? } — refresh the local PO cache from ShipHero.
// Default is incremental (only POs changed since the last sync — cheap, scales).
// full=true backfills everything from `since` (first run / manual full resync).
export async function POST(req: Request) {
  if (!hasShipheroCredential()) {
    return Response.json({ error: "ShipHero isn't connected." }, { status: 400 });
  }
  try {
    const body = await req.json().catch(() => ({}));
    const since = typeof body.since === "string" ? body.since : "2025-01-01";
    const result = await syncPoCache(since, { full: body.full === true });
    return Response.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof ShipheroError) {
      const status = err.kind === "throttled" ? 429 : 502;
      return Response.json({ error: err.message, kind: err.kind }, { status });
    }
    return Response.json({ error: err instanceof Error ? err.message : "Sync failed." }, { status: 500 });
  }
}
