// Client-safe types + helpers for the Warehouse Activity (Operations) page.
// No DB/server imports. A "day" is pulled from ShipHero once, cached in the DB,
// then served/filtered locally — so this file is shared by the pull, the cache,
// and the component.

export type EventType =
  | "received"
  | "putaway"
  | "replenish"
  | "consolidation"
  | "return-slotted"
  | "picked"
  | "shipped"
  | "to-qc"
  | "qc-release"
  | "pick-reorg"
  | "move"
  | "adjust";

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
  receivedPOs: { po: string; vendor: string; units: number }[];
  putAwayUnits: number;
  pickedItems: number;
  shippedOrders: number;
  shippedUnits: number;
  shippedByService: Counted[];
  movedUnits: number;
  moveCount: number;
  returnsUnits: number;
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
  if (n.includes("TOTE")) return "TOTE";
  if (n === "SHIPPED") return "SHIPPED";
  if (n.startsWith("BULK") || n.startsWith("STORE")) return "STORAGE";
  if (n.startsWith("PICK-00")) return "RETURN BIN";
  if (n.startsWith("PICK")) return "PICK FACE";
  if (n.startsWith("RET")) return "RETURNS";
  if (n.includes("RECEIV")) return "RECEIVING";
  if (n.includes("AQL")) return "QC";
  if (n.includes("QC FAIL")) return "QC FAIL";
  return "OTHER";
}

export const TYPE_META: Record<EventType, { label: string; color: string }> = {
  received: { label: "Received", color: "#059669" },
  putaway: { label: "Put away", color: "#0d9488" },
  replenish: { label: "Replenishment", color: "#4f46e5" },
  consolidation: { label: "Consolidation (to storage)", color: "#d97706" },
  "return-slotted": { label: "Returns slotted", color: "#0284c7" },
  picked: { label: "Picked (into tote)", color: "#7c3aed" },
  shipped: { label: "Shipped", color: "#4338ca" },
  "to-qc": { label: "Sent to QC", color: "#db2777" },
  "qc-release": { label: "QC released", color: "#0891b2" },
  "pick-reorg": { label: "Pick-face reorg", color: "#65a30d" },
  move: { label: "Other move", color: "#64748b" },
  adjust: { label: "Adjustment", color: "#e11d48" },
};

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

export function timeHM(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Local YYYY-MM-DD for a Date (defaults to today). */
export function ymd(d: Date = new Date()): string {
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mo}-${da}`;
}
