import { getInventoryCache } from "@/lib/inventory-cache";
import { getBarcodeCatalog } from "@/lib/shiphero/barcode-catalog";
import { sortBins, type InventoryItem, type InventoryPayload } from "@/lib/inventory-types";

export const dynamic = "force-dynamic";

// GET /api/inventory — the whole warehouse by SKU, from LOCAL CACHES only
// (inventory-locations cache + barcode catalogue). Never calls ShipHero.
export async function GET() {
  try {
    const [{ rows, totals, syncedAt }, catalog] = await Promise.all([getInventoryCache(), getBarcodeCatalog()]);
    const identity = new Map((catalog?.products ?? []).map((p) => [p.sku, p]));

    const bySku = new Map<string, InventoryItem>();
    const ensure = (sku: string): InventoryItem => {
      let item = bySku.get(sku);
      if (!item) {
        const id = identity.get(sku);
        const t = totals[sku];
        item = {
          sku,
          title: id?.title ?? sku,
          size: id?.size ?? "",
          barcode: id?.barcode ?? "",
          onHand: t?.onHand ?? 0,
          allocated: t?.allocated ?? 0,
          available: t?.available ?? 0,
          nonSellable: t?.nonSellable ?? 0,
          bins: [],
        };
        bySku.set(sku, item);
      }
      return item;
    };
    for (const r of rows) ensure(r.sku).bins.push({ name: r.bin, qty: r.qty, sellable: r.sellable });
    // SKUs the snapshot saw with totals but no bins (e.g. all stock allocated
    // out of bins) still get a card, honest about having no location.
    for (const sku of Object.keys(totals)) ensure(sku);

    const items = [...bySku.values()]
      .map((i) => ({ ...i, bins: sortBins(i.bins) }))
      .sort((a, b) => a.title.localeCompare(b.title) || a.sku.localeCompare(b.sku));

    const payload: InventoryPayload = { items, syncedAt };
    return Response.json(payload);
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to load inventory." }, { status: 500 });
  }
}
