import { getInventoryCache } from "@/lib/inventory-cache";
import { getBarcodeCatalog } from "@/lib/shiphero/barcode-catalog";
import { sortBins, type InventoryItem } from "@/lib/inventory-types";
import type { ScanBinContent, ScanMatch, ScanResponse } from "@/lib/scan-types";

export const dynamic = "force-dynamic";

// GET /api/scan/[code] — resolve a scanned barcode / bin label to product(s) or
// location(s), ported from Will's resolver (api/main.py scan_resolve). Tries an
// exact bin-name match, then product barcode (with EAN/UPC leading-zero
// variants), then product SKU. Returns ALL candidates (location first) so the
// UI can disambiguate rather than guessing. Cache-only — never calls ShipHero.

export async function GET(_req: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const s = decodeURIComponent(code ?? "").trim();
  if (!s) return Response.json({ code, normalized: "", matches: [] } satisfies ScanResponse);

  try {
    const [{ rows, totals }, catalog] = await Promise.all([getInventoryCache(), getBarcodeCatalog()]);
    const identity = new Map((catalog?.products ?? []).map((p) => [p.sku, p]));
    const upper = s.toUpperCase();

    // For all-digit scans, also try the common EAN/UPC leading-zero variants so
    // a 12- or 13-digit read still matches a barcode stored with/without a 0.
    const barcodes = [s];
    if (/^\d+$/.test(s)) {
      barcodes.push(s.replace(/^0+/, "") || "0", s.padStart(13, "0"));
      if (s.length === 12) barcodes.push("0" + s);
    }
    const barcodeSet = new Set(barcodes);

    const toItem = (sku: string): InventoryItem => {
      const id = identity.get(sku);
      const t = totals[sku];
      return {
        sku,
        title: id?.title ?? sku,
        size: id?.size ?? "",
        barcode: id?.barcode ?? "",
        onHand: t?.onHand ?? 0,
        allocated: t?.allocated ?? 0,
        available: t?.available ?? 0,
        nonSellable: t?.nonSellable ?? 0,
        bins: sortBins(rows.filter((r) => r.sku === sku).map((r) => ({ name: r.bin, qty: r.qty, sellable: r.sellable }))),
      };
    };

    const matches: ScanMatch[] = [];

    // 1) Location by exact (case-insensitive) bin name.
    const binRows = rows.filter((r) => r.bin.toUpperCase() === upper);
    if (binRows.length) {
      const contents: ScanBinContent[] = binRows
        .map((r) => {
          const id = identity.get(r.sku);
          return { sku: r.sku, title: id?.title ?? r.sku, size: id?.size ?? "", qty: r.qty };
        })
        .sort((a, b) => a.title.localeCompare(b.title));
      matches.push({
        kind: "location",
        name: binRows[0].bin,
        productCount: contents.length,
        units: contents.reduce((a, c) => a + c.qty, 0),
        contents,
      });
    }

    // 2) Product by barcode (any variant), then 3) by exact SKU.
    const seen = new Set<string>();
    for (const p of catalog?.products ?? []) {
      if (p.barcode && barcodeSet.has(p.barcode) && !seen.has(p.sku)) {
        seen.add(p.sku);
        matches.push({ kind: "product", item: toItem(p.sku) });
      }
    }
    const skuHit =
      (identity.has(s) && s) ||
      (catalog?.products ?? []).find((p) => p.sku.toUpperCase() === upper)?.sku ||
      (totals[s] !== undefined && s) ||
      null;
    if (skuHit && !seen.has(skuHit)) {
      seen.add(skuHit);
      matches.push({ kind: "product", item: toItem(skuHit) });
    }

    return Response.json({ code, normalized: s, matches } satisfies ScanResponse);
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Scan lookup failed." }, { status: 500 });
  }
}
