// Pure, client-safe logic for the Returns Pick Faces page. No DB/server imports,
// so the component can use it directly on cached rows from the API.

// Master switch for the Consolidate (move stock) feature. OFF until the move
// path has been tested end-to-end on live stock. Flip to true (both the button
// and the /api/bins/move route read this) and redeploy to enable it.
export const CONSOLIDATE_ENABLED: boolean = false;

export interface DestCandidate {
  face: string;
  qty: number;
  updatedAt: string | null;
}

export interface BinRow {
  binName: string;
  sku: string;
  productName: string;
  quantity: number;
  landedAt: string | null; // honest "in bin since" (from the movement log)
  destFace: string | null;
  destQty: number | null;
  /** Every pick face this SKU is known to live in, best first. */
  destCandidates?: DestCandidate[];
}

export interface BinsSettings {
  /** A SKU with more than this many units across returns bins is worth collating. */
  collateThreshold: number;
  /** Bin holding more than this many units is over target. */
  binTarget: number;
  /** Age (days) at which stock is "ageing" / "stale". */
  ageWarnDays: number;
  ageStaleDays: number;
}

export const DEFAULT_BINS_SETTINGS: BinsSettings = {
  collateThreshold: 5,
  binTarget: 5,
  ageWarnDays: 8,
  ageStaleDays: 15,
};

/** Whole days since an ISO date. null when we have no landing event. */
export function ageDays(landedAt: string | null, now: number = Date.now()): number | null {
  if (!landedAt) return null;
  const t = new Date(landedAt).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now - t) / 86_400_000));
}

export type AgeBand = "fresh" | "ageing" | "stale" | "unknown";
export function ageBand(days: number | null, s: BinsSettings): AgeBand {
  if (days === null) return "unknown";
  if (days >= s.ageStaleDays) return "stale";
  if (days >= s.ageWarnDays) return "ageing";
  return "fresh";
}

export interface BinSummary {
  binName: string;
  items: BinRow[];
  units: number;
  oldestDays: number | null;
  state: "empty" | "ok" | "over";
}

/** Every bin (including empties) with its contents rolled up. */
export function summariseBins(allBins: string[], rows: BinRow[], s: BinsSettings, now = Date.now()): BinSummary[] {
  const byBin = new Map<string, BinRow[]>();
  for (const r of rows) {
    const list = byBin.get(r.binName) ?? [];
    list.push(r);
    byBin.set(r.binName, list);
  }
  // Include any bin that has stock even if it wasn't in the known-bins list.
  const names = [...new Set([...allBins, ...byBin.keys()])].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
  return names.map((binName) => {
    const items = (byBin.get(binName) ?? []).slice().sort((a, b) => b.quantity - a.quantity);
    const units = items.reduce((a, i) => a + i.quantity, 0);
    const ages = items.map((i) => ageDays(i.landedAt, now)).filter((d): d is number => d !== null);
    return {
      binName,
      items,
      units,
      oldestDays: ages.length ? Math.max(...ages) : null,
      state: units === 0 ? "empty" : units > s.binTarget ? "over" : "ok",
    };
  });
}

export interface ProductRow {
  sku: string;
  productName: string;
  units: number;
  /** Which bins it's in, most-stock first. */
  sources: { binName: string; quantity: number; days: number | null }[];
  binCount: number;
  oldestDays: number | null;
  destFace: string | null;
  destQty: number | null;
  destCandidates: DestCandidate[];
  /** Enough of one SKU to be worth returning to its pick face. */
  isCollate: boolean;
  /** Same SKU fragmented over 2+ bins — worth consolidating even below threshold. */
  isSplit: boolean;
  /** Within 1 unit of the collate threshold. */
  isNear: boolean;
  /** Has stock sitting past the stale age. */
  isStale: boolean;
}

/**
 * EVERY SKU in the returns bins, biggest first — not just the collatable ones.
 * With ~120 SKUs mostly sitting as singles, a ">5 of one SKU" rule almost never
 * fires, so filtering the view down to it leaves an empty screen. Flags let the
 * UI surface what's actionable without hiding the rest.
 */
export function productList(rows: BinRow[], s: BinsSettings, now = Date.now()): ProductRow[] {
  const bySku = new Map<string, BinRow[]>();
  for (const r of rows) {
    const list = bySku.get(r.sku) ?? [];
    list.push(r);
    bySku.set(r.sku, list);
  }
  const out: ProductRow[] = [];
  for (const [sku, list] of bySku) {
    const units = list.reduce((a, r) => a + r.quantity, 0);
    const sources = list
      .map((r) => ({ binName: r.binName, quantity: r.quantity, days: ageDays(r.landedAt, now) }))
      .sort((a, b) => b.quantity - a.quantity);
    const ages = sources.map((x) => x.days).filter((d): d is number => d !== null);
    const oldestDays = ages.length ? Math.max(...ages) : null;
    const withDest = list.find((r) => r.destFace);
    const binCount = new Set(list.map((r) => r.binName)).size;
    const isCollate = units > s.collateThreshold;
    out.push({
      sku,
      productName: list.find((r) => r.productName)?.productName ?? "",
      units,
      sources,
      binCount,
      oldestDays,
      destFace: withDest?.destFace ?? null,
      destQty: withDest?.destQty ?? null,
      destCandidates: list.find((r) => (r.destCandidates?.length ?? 0) > 0)?.destCandidates ?? [],
      isCollate,
      isSplit: binCount > 1,
      isNear: !isCollate && units >= s.collateThreshold,
      isStale: oldestDays !== null && oldestDays >= s.ageStaleDays,
    });
  }
  return out.sort(
    (a, b) =>
      Number(b.isCollate) - Number(a.isCollate) ||
      b.units - a.units ||
      b.binCount - a.binCount ||
      (b.oldestDays ?? -1) - (a.oldestDays ?? -1),
  );
}

/** Just the ones worth a trip right now. */
export const collateList = (rows: BinRow[], s: BinsSettings, now = Date.now()): ProductRow[] =>
  productList(rows, s, now).filter((p) => p.isCollate);

export interface BinsStats {
  units: number;
  skus: number;
  binsTotal: number;
  binsUsed: number;
  binsOver: number;
  collateSkus: number;
  collateUnits: number;
  splitSkus: number;
  staleSkus: number;
  oldestDays: number | null;
  oldestBin: string | null;
}

export function binsStats(bins: BinSummary[], products: ProductRow[]): BinsStats {
  const collate = products.filter((p) => p.isCollate);
  const used = bins.filter((b) => b.units > 0);
  let oldestDays: number | null = null;
  let oldestBin: string | null = null;
  for (const b of used) {
    if (b.oldestDays !== null && (oldestDays === null || b.oldestDays > oldestDays)) {
      oldestDays = b.oldestDays;
      oldestBin = b.binName;
    }
  }
  return {
    units: used.reduce((a, b) => a + b.units, 0),
    skus: new Set(bins.flatMap((b) => b.items.map((i) => i.sku))).size,
    binsTotal: bins.length,
    binsUsed: used.length,
    binsOver: bins.filter((b) => b.state === "over").length,
    collateSkus: collate.length,
    collateUnits: collate.reduce((a, c) => a + c.units, 0),
    splitSkus: products.filter((p) => p.isSplit).length,
    staleSkus: products.filter((p) => p.isStale).length,
    oldestDays,
    oldestBin,
  };
}

/**
 * Lay bins out the way the rack is actually numbered: DOWN each column, six
 * high — bin 1 top-left, bin 6 bottom-left, bin 7 top of the next column.
 * Returns rows of bins for rendering (row-major DOM, column-major numbering).
 */
export function rackGrid<T>(items: T[], rowsPerColumn = 6): (T | null)[][] {
  const cols = Math.max(1, Math.ceil(items.length / rowsPerColumn));
  const grid: (T | null)[][] = [];
  for (let r = 0; r < rowsPerColumn; r++) {
    const row: (T | null)[] = [];
    for (let c = 0; c < cols; c++) row.push(items[c * rowsPerColumn + r] ?? null);
    grid.push(row);
  }
  return grid;
}

/** "PICK-00-01-A-07" -> "A-07" for the compact wall tiles. */
export const shortBin = (name: string): string => {
  const m = name.match(/([A-Z]-\d+)$/i);
  return m ? m[1] : name.replace(/^PICK-00-?/i, "");
};

/** The bay letter of a bin, e.g. "PICK-00-01-A-07" -> "A". */
export const binBay = (name: string): string => {
  const m = name.match(/-([A-Za-z]+)-\d+$/);
  return m ? m[1].toUpperCase() : "?";
};

/** Group bins into their physical bays (A, B, …), each keeping bin order. */
export function groupByBay(bins: BinSummary[]): { bay: string; bins: BinSummary[] }[] {
  const map = new Map<string, BinSummary[]>();
  for (const b of bins) {
    const bay = binBay(b.binName);
    const list = map.get(bay) ?? [];
    list.push(b);
    map.set(bay, list);
  }
  return [...map.entries()]
    .map(([bay, bs]) => ({ bay, bins: bs }))
    .sort((a, b) => a.bay.localeCompare(b.bay));
}
