import { hasShipheroCredential, ShipheroError } from "@/lib/shiphero/client";
import { searchPo } from "@/lib/shiphero/po-unreceive";

export const dynamic = "force-dynamic";

// GET /api/po/unreceive/search?po=PO510 — live ShipHero lookup (read-only).
// Returns every PO with that number so duplicates can be told apart.
export async function GET(req: Request) {
  if (!hasShipheroCredential()) return Response.json({ error: "ShipHero isn't connected." }, { status: 400 });
  const po = new URL(req.url).searchParams.get("po")?.trim() ?? "";
  if (!po) return Response.json({ error: "Enter a PO number." }, { status: 400 });
  try {
    return Response.json({ matches: await searchPo(po) });
  } catch (err) {
    if (err instanceof ShipheroError) return Response.json({ error: err.message }, { status: err.kind === "throttled" ? 429 : 502 });
    return Response.json({ error: err instanceof Error ? err.message : "Search failed." }, { status: 500 });
  }
}
