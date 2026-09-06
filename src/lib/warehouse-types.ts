import { ukHM } from "./uk-time";
// Client-safe types + helpers for the Warehouse Activity (Operations) page.
// No DB/server imports. A "day" is pulled from ShipHero once, cached in the DB,
// then served/filtered locally — so this file is shared by the pull, the cache,
// and the component.

export type EventType =
  | "received"
  | "putaway"
  | "replenish"
  | "consolidation"
  | "return-received"
  | "return-slotted"
  | "picked"
  | "shipped"
  | "to-qc"
  | "to-faulty"
  | "qc-release"
  | "pick-reorg"
  | "move"
  | "adjust"
  | "cycle-count";

export interface WarehouseEvent {
  at: string;       // ISO
  user: string;     // resolved name
  sku: string;
  qty: number;      // signed
  fromBin: string | null;
  toBin: string | null;
  reason: string;
  type: EventType;
  meta?: string; // e.g. PO number on a received event
}

export interface Counted {
  key: string;
  units: number;
  count?: number;
}

export interface PersonRow {
  name: string;
  initials: string;
  total: number;
  received: number;
  putAway: number;
  moved: number;
  /** RMAs received at the returns desk (Swap v2 processing). */
  returnsReceived: number;
  /** Units slotted into the returns wall bins. */
  returns: number;
  picked: number;
  shipped: number;
}

export interface Flow {
  from: string;
  to: string;
  units: number;
  tag: string;
}

export interface WarehouseSummary {
  date: string;              // YYYY-MM-DD
  generatedAt: string;
  eventCount: number;
  receivedUnits: number;
  receivedPOs: { po: string; vendor: string; product: string; units: number }[];
  putAwayUnits: number;
  pickedItems: number;
  shippedOrders: number;
  shippedUnits: number;
  shippedByService: Counted[];
  movedUnits: number;
  moveCount: number;
  returnsUnits: number;
  /** Swap v2 RMA processing at the desk (units + distinct RMAs). Missing on
   *  days cached before Aug 2026 — treat as 0. */
  returnsReceivedUnits?: number;
  returnsReceivedCount?: number;
  staffActive: number;
  byType: Counted[];
  flows: Flow[];
  byPerson: PersonRow[];
}

export interface WarehouseDay {
  summary: WarehouseSummary;
  events: WarehouseEvent[];
}

/** Which physical area a bin belongs to. */
export function area(bin: string | null | undefined): string {
  const n = (bin || "").toUpperCase();
  if (!n) return "?";
  if (n === "PO") return "PO";
  if (n === "RMA") return "RMA"; // customer return arriving at the desk
  if (n.includes("TOTE")) return "TOTE";
  if (n === "SHIPPED") return "SHIPPED";
  if (n.startsWith("BULK") || n.startsWith("STORE")) return "STORAGE";
  if (n.startsWith("PICK-00")) return "RETURN BIN";
  if (n.startsWith("PICK")) return "PICK FACE";
  if (n.startsWith("RET")) return "RETURNS";
  if (n.includes("RECEIV")) return "RECEIVING";
  if (n.includes("AQL")) return "QC";
  if (n.includes("QC FAIL") || n.includes("FAULT")) return "FAULTY";
  return "OTHER";
}

export const TYPE_META: Record<EventType, { label: string; color: string }> = {
  received: { label: "Received", color: "#059669" },
  putaway: { label: "Put away", color: "#0d9488" },
  replenish: { label: "Replenishment", color: "#4f46e5" },
  consolidation: { label: "Consolidation (to storage)", color: "#d97706" },
  "return-received": { label: "Return received (desk)", color: "#0ea5e9" },
  "return-slotted": { label: "Returns slotted", color: "#0284c7" },
  picked: { label: "Picked (into tote)", color: "#7c3aed" },
  shipped: { label: "Shipped", color: "#4338ca" },
  "to-qc": { label: "Sent to QC", color: "#db2777" },
  "to-faulty": { label: "To faulty bin", color: "#be123c" },
  "qc-release": { label: "QC released", color: "#0891b2" },
  "pick-reorg": { label: "Pick-face reorg", color: "#65a30d" },
  move: { label: "Other move", color: "#64748b" },
  adjust: { label: "Manual adjustment", color: "#e11d48" },
  "cycle-count": { label: "Cycle count", color: "#c026d3" },
};

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

// ShipHero timestamps are naive UTC; show London wall-clock (see lib/uk-time).
export function timeHM(iso: string): string {
  return ukHM(iso);
}

/** Local YYYY-MM-DD for a Date (defaults to today). */
export function ymd(d: Date = new Date()): string {
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mo}-${da}`;
}
