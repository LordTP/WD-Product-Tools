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
  price: number; // order line unit price (retail £) — refund-exposure proxy
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
  value: number; // Σ item price × qty expected
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
  actions: number;
  activeHours: number; // distinct clock-hours with ≥1 event in the window
  perHour: number; // actions / activeHours
  byHour: number[]; // 24 buckets, event counts (tempo strip)
  byDay: Record<string, number>; // YYYY-MM-DD → actions (league table)
}

export interface ReturnsSummary {
  total: number;
  unitsExpected: number;
  unitsReceived: number;
  unitsRestocked: number;
  restockRate: number; // restocked / received
  value: number;
  exchanges: number;
  faulty: number;
  avgTurnaroundDays: number | null; // created → first receive-ish event
  reasons: Counted[];
  outcomes: Counted[]; // Exchange vs Refund/credit (Swap doesn't split credit)
  pipeline: { bucket: string; count: number }[]; // open returns by age
  topProducts: Counted[];
  people: PersonStats[];
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

const RECEIVE_RE = /receiv|restock|complete|process/i;

const OPEN_STATUSES = new Set(["pending"]);

export function isOpen(r: ReturnRow): boolean {
  return OPEN_STATUSES.has((r.status || "").toLowerCase());
}

/** Strip the size suffix off a product name so sizes group ("… | LEMON XS" → "… | LEMON"). */
function productKey(name: string): string {
  return name.replace(/\s+(XXS|XS|S|M|L|XL|UK \d+|ONE SIZE)$/i, "").trim();
}

export function deriveSummary(rows: ReturnRow[], nowIso: string): ReturnsSummary {
  const now = new Date(nowIso).getTime();
  let unitsExpected = 0, unitsReceived = 0, unitsRestocked = 0, value = 0, exchanges = 0, faulty = 0;
  const reasons = new Map<string, number>();
  const products = new Map<string, number>();
  const turnarounds: number[] = [];
  const pipeline = { "0–7 days": 0, "7–14 days": 0, "14+ days": 0 };
  const people = new Map<string, { returns: Set<string>; events: { at: string }[] }>();

  for (const r of rows) {
    unitsExpected += r.expected;
    unitsReceived += r.received;
    unitsRestocked += r.restocked;
    value += r.value;
    if (r.exchangeOrders.length) exchanges++;
    for (const it of r.items) {
      const reason = (it.reason || r.reason || "Other").trim() || "Other";
      reasons.set(reason, (reasons.get(reason) ?? 0) + it.quantity);
      if (/fault|damag/i.test(reason) || /damag/i.test(it.condition || "")) faulty += it.quantity;
      products.set(productKey(it.productName || it.sku), (products.get(productKey(it.productName || it.sku)) ?? 0) + it.quantity);
    }
    if (isOpen(r)) {
      const ageDays = (now - new Date(r.createdAt).getTime()) / 86_400_000;
      if (ageDays <= 7) pipeline["0–7 days"]++;
      else if (ageDays <= 14) pipeline["7–14 days"]++;
      else pipeline["14+ days"]++;
    }
    const firstReceive = r.history.find((h) => h.user && RECEIVE_RE.test(h.body));
    if (firstReceive) {
      turnarounds.push((new Date(firstReceive.at).getTime() - new Date(r.createdAt).getTime()) / 86_400_000);
    }
    for (const h of r.history) {
      if (!h.user) continue;
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
        const day = e.at.slice(0, 10);
        byDay[day] = (byDay[day] ?? 0) + 1;
        hourKeys.add(`${day}T${String(d.getHours()).padStart(2, "0")}`);
      }
      const activeHours = hourKeys.size;
      return {
        name,
        initials: initialsOf(name),
        returnsTouched: p.returns.size,
        actions: p.events.length,
        activeHours,
        perHour: activeHours ? p.events.length / activeHours : 0,
        byHour,
        byDay,
      };
    })
    .sort((a, b) => b.actions - a.actions);

  const sortCounted = (m: Map<string, number>): Counted[] =>
    [...m.entries()].map(([key, units]) => ({ key, units })).sort((a, b) => b.units - a.units);

  const received = unitsReceived;
  return {
    total: rows.length,
    unitsExpected,
    unitsReceived,
    unitsRestocked,
    restockRate: received > 0 ? unitsRestocked / received : 0,
    value,
    exchanges,
    faulty,
    avgTurnaroundDays: turnarounds.length
      ? turnarounds.reduce((a, b) => a + b, 0) / turnarounds.length
      : null,
    reasons: sortCounted(reasons),
    outcomes: [
      { key: "Refund / credit", units: rows.length - exchanges },
      { key: "Exchange", units: exchanges },
    ],
    pipeline: Object.entries(pipeline).map(([bucket, count]) => ({ bucket, count })),
    topProducts: sortCounted(products).slice(0, 8),
    people: personStats,
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

export function dayLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
