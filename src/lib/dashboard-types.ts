// Client-safe types for the Dashboard (morning briefing). Shared by the
// aggregation route (/api/dashboard) and the component. No server imports.

import type { PoSummary } from "@/lib/shiphero/po-pull";

/** First row — the day so far. Ops fields are null when no snapshot is cached yet. */
export interface TodayStrip {
  shippedOrders: number | null;
  shippedUnits: number;
  shippedByHour: number[]; // London hours 0–23
  totalOpen: number;
  readyTotal: number;
  waitingTotal: number;
  dueDhl: number;
  dueRm: number;
  oldestReady: { orderNumber: string; ageDays: number; lane: string } | null;
  returnsProcessedToday: number;
  /** Retail value (ex VAT) of return units received today. */
  returnsProcessedTodayValue: number;
  returnsOpenedToday: number;
  returnsOpenedWeek: number;
  returnsProcessedWeek: number;
}

/** Second row — the PO position (each tile deep-links into PO History). */
export interface PoPosition {
  valueOnOrder: number;
  openCount: number;
  vendorCount: number;
  unitsToCome: number;
  datedCount: number;
  landing14Units: number;
  landing14Pos: number;
  overdueCount: number;
  overdueUnits: number;
  overdueWorstDays: number;
  missingCount: number;
}

export interface WeekRow {
  label: string; // "w/c 7 Sep" | "Overdue"
  sub: string; // "this week" | "before today" | ""
  units: number;
  pos: number;
  late: boolean;
  href: string;
}

export interface RecvRow {
  po: PoSummary; // full summary so the breakdown modal can open in place
  pct: number;
  state: "over" | "part" | "awaiting" | "complete";
}

export interface AttnRow {
  sev: "bad" | "warn" | "info";
  strong: string; // bold lead ("PO544" / "9 POs")
  text: string;
  href: string;
  cta: string;
}

export interface ReasonRow {
  key: string;
  units: number;
  pct: number; // of the week's returned units
}

export interface ReturnsWeek {
  opened: number;
  processed: number;
  valueOpen: number; // ex-VAT, still in the post
  faultyUnits: number;
  faultyPct: number;
  reasons: ReasonRow[];
}

export interface MonthBar {
  ym: string; // YYYY-MM
  value: number;
  pos: number;
  current: boolean;
}

export interface JobStampLite {
  key: string;
  label: string;
  at: string | null;
  ok: boolean;
  running: boolean;
  error?: string;
}

export interface DashboardData {
  today: TodayStrip;
  poPosition: PoPosition;
  weeks: WeekRow[];
  receiving: RecvRow[];
  attention: AttnRow[];
  returnsWeek: ReturnsWeek;
  months: MonthBar[];
  jobs: JobStampLite[];
  generatedAt: string;
}
