// Pure, client-safe logic for the Returns Pick Faces page. No DB/server imports,
// so the component can use it directly on cached rows from the API.

export interface BinRow {
  binName: string;
  sku: string;
  productName: string;
  quantity: number;
  landedAt: string | null; // honest "in bin since" (from the movement log)
  destFace: string | null;
  destQty: number | null;
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

export interface CollateRow {
  sku: string;
  productName: string;
  units: number;
  /** Which bins to collect from, most-stock first. */
  sources: { binName: string; quantity: number; days: number | null }[];
  oldestDays: number | null;
  destFace: string | null;
  destQty: number | null;
}

/** SKUs worth consolidating back into their pick face, biggest first. */
export function collateList(rows: BinRow[], s: BinsSettings, now = Date.now()): CollateRow[] {
  const bySku = new Map<string, BinRow[]>();
  for (const r of rows) {
    const list = bySku.get(r.sku) ?? [];
    list.push(r);
    bySku.set(r.sku, list);
  }
  const out: CollateRow[] = [];
  for (const [sku, list] of bySku) {
    const units = list.reduce((a, r) => a + r.quantity, 0);
    if (units <= s.collateThreshold) continue;
    const sources = list
      .map((r) => ({ binName: r.binName, quantity: r.quantity, days: ageDays(r.landedAt, now) }))
      .sort((a, b) => b.quantity - a.quantity);
    const ages = sources.map((x) => x.days).filter((d): d is number => d !== null);
    const withDest = list.find((r) => r.destFace);
    out.push({
      sku,
      productName: list.find((r) => r.productName)?.productName ?? "",
      units,
      sources,
      oldestDays: ages.length ? Math.max(...ages) : null,
      destFace: withDest?.destFace ?? null,
      destQty: withDest?.destQty ?? null,
    });
  }
  return out.sort((a, b) => b.units - a.units || (b.oldestDays ?? -1) - (a.oldestDays ?? -1));
}

export interface BinsStats {
  units: number;
  skus: number;
  binsTotal: number;
  binsUsed: number;
  binsOver: number;
  collateSkus: number;
  collateUnits: number;
  oldestDays: number | null;
  oldestBin: string | null;
}

export function binsStats(bins: BinSummary[], collate: CollateRow[]): BinsStats {
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
    oldestDays,
    oldestBin,
  };
}

/** "PICK-00-01-A-07" -> "A-07" for the compact wall tiles. */
export const shortBin = (name: string): string => {
  const m = name.match(/([A-Z]-\d+)$/i);
  return m ? m[1] : name.replace(/^PICK-00-?/i, "");
};
