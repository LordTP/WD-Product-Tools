import { hasShipheroCredential, ShipheroError } from "@/lib/shiphero/client";
import { syncReturns } from "@/lib/returns-cache";

export const dynamic = "force-dynamic";
// First sync backfills a month of RMAs with nested history; give it room.
export const maxDuration = 300;

// POST /api/returns-hub/sync — pull open + recent returns from ShipHero into the
// cache. Read-only against ShipHero.
export async function POST() {
  if (!hasShipheroCredential()) {
    return Response.json({ error: "ShipHero isn't connected." }, { status: 400 });
  }
  try {
    const meta = await syncReturns();
    return Response.json({ ok: true, meta });
  } catch (err) {
    if (err instanceof ShipheroError) {
      const status = err.kind === "throttled" ? 429 : 502;
      return Response.json({ error: err.message, kind: err.kind }, { status });
    }
    return Response.json(
      { error: err instanceof Error ? err.message : "Sync failed." },
      { status: 500 },
    );
  }
}
