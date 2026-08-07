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
  | "pick"
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
  picked: number;
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
  if (n.startsWith("BULK")) return "BULK";
  if (n.startsWith("PICK-00")) return "RETURN BIN";
  if (n.startsWith("PICK")) return "PICK FACE";
  if (n.startsWith("RET")) return "RETURNS";
  if (n.startsWith("STORE")) return "STORE";
  if (n.includes("RECEIV")) return "RECEIVING";
  if (n.includes("AQL")) return "AQL/QC";
  if (n.includes("QC FAIL")) return "QC FAIL";
  if (n.includes("TRANSFER")) return "TRANSFER";
  return "OTHER";
}

export const TYPE_META: Record<EventType, { label: string; color: string }> = {
  received: { label: "Received", color: "#059669" },
  putaway: { label: "Put away", color: "#0d9488" },
  replenish: { label: "Replenishment", color: "#4f46e5" },
  consolidation: { label: "Bulk consolidation", color: "#d97706" },
  "return-slotted": { label: "Returns → bins", color: "#0284c7" },
  pick: { label: "Order picks / ship", color: "#7c3aed" },
  move: { label: "Other moves", color: "#64748b" },
  adjust: { label: "Adjustments", color: "#e11d48" },
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
