import { ukDay, ukYmd } from "./uk-time";
// Client-safe types + derivation for the Returns page. No server imports —
// shared by the pull, the cache, and the component. Rows are cached in SQLite
// and all filtering/aggregation happens client-side on the selected window.

export interface ReturnItem {
  sku: string;
  productName: string;
  quantity: number;
  received: number;
  restock: boolean;
  condition: string | null;
  reason: string | null;
  /** Unit price NET of promotion discount, still inc tax (ex-tax applied via
   *  the row's exVatFactor at aggregation). Rows cached before Aug 2026 carry
   *  the gross price. */
  price: number;
}

export interface ReturnEvent {
  at: string; // ISO
  userId: string | null;
  user: string | null; // resolved name (null = system/Swap)
  body: string;
}

export interface ReturnRow {
  id: string;
  legacyId: number;
  orderNumber: string;
  createdAt: string; // ISO
  status: string; // pending | complete | ...
  reason: string | null;
  carrier: string | null;
  costToCustomer: number;
  isV2: boolean; // Swap v2 RMA (processed in ShipHero); v1 = legacy, frozen
  expected: number;
  received: number;
  restocked: number;
  /** (total_price − total_tax) / total_price from the ORDER — UK ≈ 0.833,
   *  zero-rated international = 1. Missing on rows cached before Aug 2026. */
  exVatFactor?: number;
  value: number; // Σ item price × qty expected, ex tax (Shopify basis)
  exchangeOrders: string[]; // order numbers of linked exchange orders
  items: ReturnItem[];
  history: ReturnEvent[];
}

export interface Counted {
  key: string;
  units: number;
  count?: number;
}

export interface PersonStats {
  name: string;
  initials: string;
  returnsTouched: number;
  returnIds: string[]; // for click-to-filter the feed
  actions: number;
  activeHours: number; // distinct clock-hours with ≥1 event in the window
  perHour: number; // actions / activeHours
  byHour: number[]; // 24 buckets, event counts (tempo strip)
  byDay: Record<string, number>; // YYYY-MM-DD → actions (league table)
}

export interface TrendDay {
  day: string; // YYYY-MM-DD
  opened: number;
  processed: number;
}

export interface ReturnsSummary {
  total: number;
  unitsExpected: number;
  /** Processed in the window (by EVENT time, not return-creation time). */
  processedReturns: number;
  unitsReceived: number;
  unitsRestocked: number;
  restockRate: number; // restocked / received
  valueProcessed: number; // retail value of goods received in window
  valueOpen: number; // retail value still in the post (open returns opened in window)
  exchanges: number;
  faulty: number;
  avgTurnaroundDays: number | null; // created → first receive-ish event (event in window)
  reasons: Counted[];
  outcomes: Counted[]; // Exchange vs Refund/credit (Swap doesn't split credit)
  pipeline: { bucket: string; count: number; value: number }[]; // ALL open returns by age (window-independent), value = ex-VAT still to receive
  /** Every open v2 return RIGHT NOW (window-independent): counts + ex-VAT value
   *  still to receive, split "at the desk" (some units scanned in) vs "in the
   *  post" (nothing scanned yet — ShipHero has no carrier transit/delivered). */
  openNow: { count: number; units: number; value: number; atDesk: number; atDeskValue: number; inPost: number; inPostValue: number };
  topProducts: Counted[];
  /** Products with faulty units in the window: units faulty + total returned
   *  (any reason) so concentration is visible. */
  faultyProducts: { key: string; units: number; totalReturned: number }[];
  people: PersonStats[];
  trend: TrendDay[]; // per-day opened vs processed across the window
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

const RECEIVE_RE = /receiv|restock|complete|process/i;
const FAULTY_RE = /fault|damag/i;

/** Item-level faulty test: customer reason OR desk-assessed condition. */
export function isFaultyItem(it: ReturnItem, rowReason: string | null): boolean {
  return FAULTY_RE.test(it.reason || rowReason || "") || FAULTY_RE.test(it.condition || "");
}

/** Row-level: any faulty item, or the return sits in a damaged-type status. */
export function isFaultyRow(r: ReturnRow): boolean {
  return FAULTY_RE.test(r.status || "") || r.items.some((it) => isFaultyItem(it, r.reason));
}

const OPEN_STATUSES = new Set(["pending"]);

export function isOpen(r: ReturnRow): boolean {
  return OPEN_STATUSES.has((r.status || "").toLowerCase());
}

const SIZE_TAIL = /\s+[-–]?\s*(XXS|XS|S|M|L|XL|XXL|S-M|M-L|L-XL|XS-S|UK \d+|ONE SIZE)$/i;

/** Strip the size suffix off a product name so sizes group ("… | LEMON XS" → "… | LEMON"). */
export function productKey(name: string): string {
  return name.replace(SIZE_TAIL, "").replace(/\s+[-–]$/, "").trim();
}

/** The size the product name carries ("… | LEMON XS" → "XS"), or "?" */
export function sizeOf(name: string): string {
  const m = name.match(SIZE_TAIL);
  return m ? m[1].toUpperCase() : "?";
}

/**
 * Derive the page summary.
 * - `rows` is the FULL (legacy-filtered) set, not pre-windowed.
 * - "Opened" metrics (counts, reasons, products, value coming back) use the
 *   return's createdAt inside [fromIso, toIso].
 * - Processing metrics (people, units received, turnaround, value processed)
 *   use EVENT timestamps inside the window — so work done this week on a
 *   return opened last month still counts this week.
 * - Pipeline (open by age) is window-independent: all open returns right now.
 */
export function deriveSummary(rows: ReturnRow[], fromIso: string, toIso: string, nowIso: string): ReturnsSummary {
  const now = new Date(nowIso).getTime();
  const from = fromIso, to = toIso; // ISO strings compare lexicographically
  const inWindow = (at: string) => at >= from && at <= to;

  let total = 0, unitsExpected = 0, exchanges = 0, faulty = 0, valueOpen = 0;
  let processedReturns = 0, unitsReceived = 0, unitsRestocked = 0, valueProcessed = 0;
  const reasons = new Map<string, number>();
  const products = new Map<string, number>();
  const faultyByProduct = new Map<string, number>();
  const turnarounds: number[] = [];
  const pipeline = { "0–7 days": { count: 0, value: 0 }, "7–14 days": { count: 0, value: 0 }, "14+ days": { count: 0, value: 0 } };
  const openNow = { count: 0, units: 0, value: 0, atDesk: 0, atDeskValue: 0, inPost: 0, inPostValue: 0 };
  const people = new Map<string, { returns: Set<string>; events: { at: string }[] }>();
  const openedByDay = new Map<string, number>();
  const processedByDay = new Map<string, number>();

  for (const r of rows) {
    const openedInWindow = inWindow(r.createdAt);

    if (openedInWindow) {
      total++;
      unitsExpected += r.expected;
      openedByDay.set(ukYmd(r.createdAt), (openedByDay.get(ukYmd(r.createdAt)) ?? 0) + 1);
      if (r.exchangeOrders.length) exchanges++;
      if (isOpen(r)) {
        const f = r.exVatFactor ?? 1 / 1.2; // pre-Aug-2026 cached rows: assume UK VAT
        valueOpen += r.items.reduce((a, it) => a + Math.max(0, it.quantity - it.received) * it.price, 0) * f;
      }
      for (const it of r.items) {
        const reason = (it.reason || r.reason || "Other").trim() || "Other";
        reasons.set(reason, (reasons.get(reason) ?? 0) + it.quantity);
        const key = productKey(it.productName || it.sku);
        products.set(key, (products.get(key) ?? 0) + it.quantity);
        if (isFaultyItem(it, r.reason)) {
          faulty += it.quantity;
          faultyByProduct.set(key, (faultyByProduct.get(key) ?? 0) + it.quantity);
        }
      }
    }

    // Pipeline: every open v2 return, whenever it was opened. v1 legacy rows
    // are permanently "pending" (never processed in ShipHero) — they're not
    // really in the post, so they never belong here even when unhidden.
    if (isOpen(r) && r.isV2) {
      const ageDays = (now - new Date(r.createdAt).getTime()) / 86_400_000;
      const openValue = r.items.reduce((a, it) => a + Math.max(0, it.quantity - it.received) * it.price, 0) * (r.exVatFactor ?? 1 / 1.2);
      const bucket = ageDays <= 7 ? "0–7 days" : ageDays <= 14 ? "7–14 days" : "14+ days";
      pipeline[bucket].count++;
      pipeline[bucket].value += openValue;
      openNow.count++;
      openNow.units += Math.max(0, r.expected - r.received);
      openNow.value += openValue;
      if (r.received > 0) { openNow.atDesk++; openNow.atDeskValue += openValue; }
      else { openNow.inPost++; openNow.inPostValue += openValue; }
    }

    // Processing: keyed off event time.
    const firstReceive = r.history.find((h) => RECEIVE_RE.test(h.body));
    if (firstReceive && inWindow(firstReceive.at)) {
      processedReturns++;
      unitsReceived += r.received;
      unitsRestocked += r.restocked;
      valueProcessed += r.items.reduce((a, it) => a + it.received * it.price, 0) * (r.exVatFactor ?? 1 / 1.2);
      turnarounds.push((new Date(firstReceive.at).getTime() - new Date(r.createdAt).getTime()) / 86_400_000);
      processedByDay.set(ukYmd(firstReceive.at), (processedByDay.get(ukYmd(firstReceive.at)) ?? 0) + 1);
    }
    for (const h of r.history) {
      if (!h.user || !inWindow(h.at)) continue;
      // Swap's integration user generates RMAs — that's automation, not a person.
      if (/swap|shiphero api|integration/i.test(h.user) || /by swap/i.test(h.body)) continue;
      const p = people.get(h.user) ?? { returns: new Set<string>(), events: [] };
      p.returns.add(r.id);
      p.events.push({ at: h.at });
      people.set(h.user, p);
    }
  }

  const personStats: PersonStats[] = [...people.entries()]
    .map(([name, p]) => {
      const byHour = Array.from({ length: 24 }, () => 0);
      const byDay: Record<string, number> = {};
      const hourKeys = new Set<string>();
      for (const e of p.events) {
        const d = new Date(e.at);
        byHour[d.getHours()]++;
        const day = ukYmd(e.at);
        byDay[day] = (byDay[day] ?? 0) + 1;
        hourKeys.add(`${day}T${String(d.getHours()).padStart(2, "0")}`);
      }
      const activeHours = hourKeys.size;
      return {
        name,
        initials: initialsOf(name),
        returnsTouched: p.returns.size,
        returnIds: [...p.returns],
        actions: p.events.length,
        activeHours,
        perHour: activeHours ? p.events.length / activeHours : 0,
        byHour,
        byDay,
      };
    })
    .sort((a, b) => b.actions - a.actions);

  // Daily trend across the window (clamped to today; opened + processed merged).
  const trend: TrendDay[] = [];
  {
    const start = new Date(`${ukYmd(from)}T00:00:00`);
    const endStr = ukYmd(to) < ukYmd(nowIso) ? ukYmd(to) : ukYmd(nowIso);
    for (let d = new Date(start); ; d.setDate(d.getDate() + 1)) {
      const mo = String(d.getMonth() + 1).padStart(2, "0");
      const da = String(d.getDate()).padStart(2, "0");
      const day = `${d.getFullYear()}-${mo}-${da}`;
      if (day > endStr) break;
      trend.push({ day, opened: openedByDay.get(day) ?? 0, processed: processedByDay.get(day) ?? 0 });
      if (trend.length > 370) break; // safety on absurd custom ranges
    }
  }

  const sortCounted = (m: Map<string, number>): Counted[] =>
    [...m.entries()].map(([key, units]) => ({ key, units })).sort((a, b) => b.units - a.units);

  return {
    total,
    unitsExpected,
    processedReturns,
    unitsReceived,
    unitsRestocked,
    restockRate: unitsReceived > 0 ? unitsRestocked / unitsReceived : 0,
    valueProcessed,
    valueOpen,
    exchanges,
    faulty,
    avgTurnaroundDays: turnarounds.length
      ? turnarounds.reduce((a, b) => a + b, 0) / turnarounds.length
      : null,
    reasons: sortCounted(reasons),
    outcomes: [
      { key: "Refund / credit", units: total - exchanges },
      { key: "Exchange", units: exchanges },
    ],
    pipeline: Object.entries(pipeline).map(([bucket, v]) => ({ bucket, count: v.count, value: Math.round(v.value) })),
    openNow: { ...openNow, value: Math.round(openNow.value), atDeskValue: Math.round(openNow.atDeskValue), inPostValue: Math.round(openNow.inPostValue) },
    topProducts: sortCounted(products).slice(0, 8),
    faultyProducts: [...faultyByProduct.entries()]
      .map(([key, units]) => ({ key, units, totalReturned: products.get(key) ?? units }))
      .sort((a, b) => b.units - a.units)
      .slice(0, 12),
    people: personStats,
    trend,
  };
}

export function fmtMoney(n: number): string {
  return "£" + n.toLocaleString("en-GB", { maximumFractionDigits: 0 });
}

export function timeHM(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// London-day label for a ShipHero naive-UTC timestamp.
export function dayLabel(iso: string): string {
  return ukDay(iso);
}
