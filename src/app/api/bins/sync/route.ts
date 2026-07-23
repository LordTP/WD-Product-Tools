import { hasShipheroCredential, ShipheroError } from "@/lib/shiphero/client";
import { syncBinsCache } from "@/lib/bins-cache";

export const dynamic = "force-dynamic";

// POST /api/bins/sync { full? } — refresh the returns-bin cache from ShipHero.
// Incremental by default: landing dates are only re-derived for bins that moved.
export async function POST(req: Request) {
  if (!hasShipheroCredential()) {
    return Response.json({ error: "ShipHero isn't connected." }, { status: 400 });
  }
  try {
    const body = await req.json().catch(() => ({}));
    const result = await syncBinsCache("PICK-00", "PICK-01", { full: body.full === true });
    return Response.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof ShipheroError) {
      const status = err.kind === "throttled" ? 429 : 502;
      return Response.json({ error: err.message, kind: err.kind }, { status });
    }
    return Response.json({ error: err instanceof Error ? err.message : "Sync failed." }, { status: 500 });
  }
}
