// Client-safe types + helpers for the Operations dashboard. No server imports.

export interface LaneCount {
  lane: string;
  count: number;
  units?: number;
}

export interface OpsStats {
  syncedAt: string;
  /** All unfulfilled (open) orders. */
  totalOpen: number;
  /** Fully allocated, nothing on backorder — pickable now. */
  readyTotal: number;
  readyByLane: LaneCount[];
  /** Open but not pickable — waiting on stock (backordered) — totalOpen - readyTotal. */
  waitingTotal: number;
  waitingByLane: LaneCount[];
  /** Shipped so far today. */
  shippedOrders: number;
  shippedUnits: number;
  shippedByService: LaneCount[];
  /** Same shipments, reconstructed into lanes (service + singles/multis). */
  shippedByLane: LaneCount[];
  /** How many open orders we scanned to build this (diagnostic). */
  scannedOrders: number;
  /** Incremental shipped-today accumulator (internal — lets the next sync pull
   *  only shipments newer than the cursor). Shape owned by ops-pull. */
  shipScan?: unknown;
  /** When the heavy open-order scan last ran (shipped-only refreshes reuse it). */
  openScannedAt?: string;
  /** v2 (Order Well redraw) — all derived from the same scan. */
  lanes?: LaneRow[];
  ageBuckets?: AgeBucket[];
  blockedProducts?: BlockedProduct[];
  countries?: CountryRow[];
  shippedByHour?: number[]; // London hours 0–23, today
  shippedByHourCarrier?: Record<"dhl" | "rm", number[]>; // same, split by collecting carrier
  /** Ready orders due today per collecting van (by shipping METHOD, not lane —
   *  dhl_express:domestic parcels leave on the DHL van despite a Standard lane). */
  dueByCarrier?: Record<"dhl" | "rm", number>;
  oldestReady?: { orderNumber: string; ageDays: number; lane: string } | null;
}

export interface LaneRow {
  family: string;
  ready: number;
  singles: number;
  multis: number;
  dueToday: number;
  blocked: number;
  oldestReadyDays: number | null;
}
export interface OrderLite {
  orderNumber: string;
  legacyId: string;
  items: string; // "RAYNE MAXI S ×1 +2 more"
  lane: string;
  ageDays: number;
}
export interface AgeBucket {
  label: string; // "< 1 day"
  count: number;
  orders: OrderLite[]; // oldest first, capped
}
export interface BlockedProduct {
  product: string;
  orders: number;
  incomingPo: string | null;
  incomingDate: string | null; // YYYY-MM-DD expected
  note: string | null; // e.g. "no open PO covers this"
}
export interface CountryRow { country: string; open: number; shipped?: number }

/**
 * Collapse a shipping method/carrier/title into a service bucket. Used for the
 * shipped-today breakdown, since an order's lane is overwritten to "fulfilled"
 * once it ships — the service is the meaningful equivalent.
 */
export function serviceLabel(method?: string | null, carrier?: string | null, title?: string | null): string {
  const m = (method || "").toLowerCase();
  const c = (carrier || "").toLowerCase();
  const t = (title || "").toLowerCase();
  const all = `${m} ${c} ${t}`;
  // Royal Mail international products come through with their full catalogue
  // name ("Royal Mail International Business Parcels Tracked Boxable (Country
  // Pricing) (MPR) - incoterm DDP") — collapse to a readable lane.
  if (/international business parcel|tracked boxable|\bmpr\b/.test(all) || (/royal.?mail/.test(all) && /international/.test(all))) {
    return /\bddp\b/.test(all) ? "International - RM DDP" : /\bdap\b/.test(all) ? "International - RM DAP" : "International - RM";
  }
  if (c.includes("worldwide") || m.includes("worldwide") || m.includes("internationalparcel") || m.includes("dhl express worldwide"))
    return "International";
  if (m.includes("timeslot") || m.includes("specialdelivery") || t.includes("special")) return "Special";
  if (m.includes("tracked_24") || t.includes("next day")) return "Next Day";
  if (m.includes("tracked_48") || m.includes("dhl_express:domestic") || t.includes("standard")) return "Standard";
  if (m.includes("generic")) return "Manual label"; // hand-made labels (e.g. replacements)
  return method ? method : "(none)";
}

/**
 * Reconstruct the original lane for a shipped order: service + Singles/Multis
 * (by line-item count). Approximate — ShipHero overwrites the real lane with
 * "fulfilled" once shipped. International doesn't split by singles/multis; it
 * splits by carrier (DHL vs RM).
 */
export function laneLabel(method?: string | null, carrier?: string | null, title?: string | null, lineCount = 1): string {
  const svc = serviceLabel(method, carrier, title);
  if (svc.startsWith("International -")) return svc; // already a specific RM lane
  if (svc === "International") {
    const c = (carrier || "").toLowerCase();
    const m = (method || "").toLowerCase();
    return /royal_mail/.test(c) || m.includes("internationalparcel") ? "International - RM" : "International - DHL";
  }
  const prefix = svc === "Special" ? "Specials" : svc;
  return `${prefix} - ${lineCount > 1 ? "Multis" : "Singles"}`;
}
