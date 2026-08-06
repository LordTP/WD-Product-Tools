// Pure, client-safe types + helpers for the Cycle Counts page. No DB/server
// imports, so the component can use them directly.

export interface LowStockLocation {
  name: string;
  qty: number;
}

/** One SKU under the low-stock threshold, straight from a ShipHero inventory snapshot. */
export interface LowStockItem {
  sku: string;
  onHand: number;
  available: number;
  nonSellable: number;
  /** Bins currently holding stock, best (lowest name) first. */
  locations: LowStockLocation[];
  primaryLocation: string | null;
}

/** A cycle count we submitted, with its live ShipHero status (cached, refreshed on demand). */
export interface CycleCountRow {
  shipheroId: string;
  legacyId: string | null;
  name: string;
  countType: string | null;
  items: LowStockItem[];
  skuCount: number;
  maxQty: number | null;
  dueDate: string | null;
  status: string | null;
  queueStatus: string | null;
  progress: number | null;
  counted: number | null;
  uncounted: number | null;
  skusTotal: number | null;
  skusCounted: number | null;
  shStartedAt: string | null;
  shEndedAt: string | null;
  createdAt: string;
  syncedAt: string | null;
}

/**
 * Location name compare, numeric-aware, ASCENDING — so the returns wall and the
 * pick aisles read PICK-00 → PICK-06 (00 first, 06 last), which is how the floor
 * walks the count. Empty locations sort last.
 */
export function compareLocation(a: string | null, b: string | null): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a.localeCompare(b, undefined, { numeric: true });
}

/** Sort low-stock items by their primary location, 00 → 06. */
export function sortByLocation(items: LowStockItem[]): LowStockItem[] {
  return items.slice().sort(
    (a, b) => compareLocation(a.primaryLocation, b.primaryLocation) || a.sku.localeCompare(b.sku),
  );
}

/** ShipHero statuses come through enum-ish ("InventorySnapshotStatus.success", "in_progress"). Tidy them. */
export function prettyStatus(s: string | null | undefined): string {
  if (!s) return "—";
  return s.replace(/^.*\./, "").replace(/[_-]+/g, " ").trim().toLowerCase();
}

/** Colour class for a count's status pill. */
export function statusClass(s: string | null | undefined): string {
  const p = prettyStatus(s);
  if (/complete|success|done|finished|closed/.test(p)) return "bg-emerald-50 text-emerald-700";
  if (/progress|start|counting|open|active/.test(p)) return "bg-amber-50 text-amber-700";
  if (/cancel|abort|fail|error/.test(p)) return "bg-rose-50 text-rose-700";
  return "bg-slate-100 text-slate-500";
}

/** Whole-day-aware "in N days / N days ago / today" for a due date. */
export function dueLabel(iso: string | null, now: number = Date.now()): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const days = Math.round((new Date(iso).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000);
  if (days === 0) return "due today";
  if (days === 1) return "due tomorrow";
  if (days === -1) return "1 day overdue";
  if (days < 0) return `${-days} days overdue`;
  return `in ${days} days`;
}

/** Today at 23:59:59 local, as an ISO string — the default cycle-count due date. */
export function endOfTodayISO(now: Date = new Date()): string {
  const d = new Date(now);
  d.setHours(23, 59, 59, 0);
  return d.toISOString();
}

/** Turn a plain YYYY-MM-DD (from a date input) into an end-of-day ISO string. */
export function dateInputToISO(value: string): string {
  const d = new Date(`${value}T23:59:59`);
  return Number.isNaN(d.getTime()) ? endOfTodayISO() : d.toISOString();
}
