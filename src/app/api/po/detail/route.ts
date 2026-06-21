import { hasShipheroCredential, ShipheroError } from "@/lib/shiphero/client";
import { getPoDetailCached } from "@/lib/po-cache";

// GET /api/po/detail?po=PO471&force=1 — cached PO detail (received qty). Fetches
// from ShipHero only on first open (or force refresh), then caches.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const po = url.searchParams.get("po");
  const force = url.searchParams.get("force") === "1";
  if (!po) return Response.json({ error: "Missing ?po=" }, { status: 400 });

  if (force && !hasShipheroCredential()) {
    return Response.json({ error: "ShipHero isn't connected." }, { status: 400 });
  }
  try {
    const detail = await getPoDetailCached(po, force);
    if (!detail) return Response.json({ error: "PO not found (sync first?)." }, { status: 404 });
    return Response.json({ detail });
  } catch (err) {
    if (err instanceof ShipheroError) {
      const status = err.kind === "throttled" ? 429 : 502;
      return Response.json({ error: err.message, kind: err.kind }, { status });
    }
    return Response.json({ error: err instanceof Error ? err.message : "Pull failed." }, { status: 500 });
  }
}
