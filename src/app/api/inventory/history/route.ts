import { hasShipheroCredential, ShipheroError } from "@/lib/shiphero/client";
import { skuHistory, binHistory } from "@/lib/shiphero/inventory-history";

export const dynamic = "force-dynamic";

// GET /api/inventory/history?sku=… | ?bin=… — live ShipHero inventory_changes
// for the Inventory detail's History tab. Read-only, briefly cached in memory.
export async function GET(req: Request) {
  if (!hasShipheroCredential()) {
    return Response.json({ error: "ShipHero isn't connected." }, { status: 400 });
  }
  const url = new URL(req.url);
  const sku = url.searchParams.get("sku")?.trim();
  const bin = url.searchParams.get("bin")?.trim();
  if (!sku && !bin) return Response.json({ error: "Pass ?sku= or ?bin=." }, { status: 400 });
  try {
    const events = sku ? await skuHistory(sku) : await binHistory(bin!);
    return Response.json({ events });
  } catch (err) {
    if (err instanceof ShipheroError) {
      const status = err.kind === "throttled" ? 429 : 502;
      return Response.json({ error: err.message, kind: err.kind }, { status });
    }
    return Response.json({ error: err instanceof Error ? err.message : "History failed." }, { status: 500 });
  }
}
