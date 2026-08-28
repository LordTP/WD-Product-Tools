import { hasShipheroCredential, ShipheroError } from "@/lib/shiphero/client";
import { skuBins } from "@/lib/shiphero/po-unreceive";

export const dynamic = "force-dynamic";

// GET /api/po/unreceive/bins?sku=… — bins holding this SKU right now (read-only, 1 call).
export async function GET(req: Request) {
  if (!hasShipheroCredential()) return Response.json({ error: "ShipHero isn't connected." }, { status: 400 });
  const sku = new URL(req.url).searchParams.get("sku")?.trim() ?? "";
  if (!sku) return Response.json({ error: "Missing sku." }, { status: 400 });
  try {
    return Response.json({ bins: await skuBins(sku) });
  } catch (err) {
    if (err instanceof ShipheroError) return Response.json({ error: err.message }, { status: err.kind === "throttled" ? 429 : 502 });
    return Response.json({ error: err instanceof Error ? err.message : "Lookup failed." }, { status: 500 });
  }
}
