// Client-safe types + helpers for Apps → Inventory. No DB/server imports.

export interface InventoryBin {
  name: string;
  qty: number;
  sellable: boolean;
}

/** One SKU as the Inventory explorer shows it: catalogue identity + totals + bins. */
export interface InventoryItem {
  sku: string;
  title: string; // from the barcode catalogue ("TIFFANY DRESS | BABY BLUE"); sku fallback
  size: string;
  barcode: string;
  onHand: number;
  allocated: number;
  available: number;
  nonSellable: number;
  bins: InventoryBin[];
}

export interface InventoryPayload {
  items: InventoryItem[];
  syncedAt: string | null;
}

export type SearchScope = "all" | "sku" | "product" | "location" | "barcode";

// Zone ranking mirrors Will's app: BULK shelves first, then STORE, then the
// pick floor / everything else — each zone numeric-aware A→Z.
const zoneRank = (bin: string): number => {
  const b = bin.toUpperCase();
  if (b.startsWith("BULK")) return 0;
  if (b.startsWith("STORE")) return 1;
  return 2;
};

export function sortBins(bins: InventoryBin[]): InventoryBin[] {
  return bins
    .slice()
    .sort((a, b) => zoneRank(a.name) - zoneRank(b.name) || a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** Does this item match the query under the chosen scope? Tokenised like the
 *  Label Press search: every word must appear somewhere in the scoped text, so
 *  "blythe navy" finds "BLYTHE WIDE LEG TROUSER | NAVY". */
export function matchesQuery(item: InventoryItem, query: string, scope: SearchScope): boolean {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  const bins = item.bins.map((b) => b.name).join(" ");
  const hay = (
    scope === "sku" ? item.sku
    : scope === "product" ? `${item.title} ${item.size}`
    : scope === "location" ? bins
    : scope === "barcode" ? item.barcode
    : `${item.sku} ${item.title} ${item.size} ${item.barcode} ${bins}`
  ).toLowerCase();
  return tokens.every((t) => hay.includes(t));
}
