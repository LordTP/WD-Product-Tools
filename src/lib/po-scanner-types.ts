// Client-safe types for Apps → PO Scanner. No DB/server imports.

export interface DraftLine {
  sku: string;
  title: string;
  size: string;
  barcode: string;
  qty: number;
}

export type DraftStatus = "draft" | "pushed" | "booked";

export interface PoDraftDto {
  id: number;
  poNumber: string;
  vendorId: string | null;
  vendorName: string;
  lines: DraftLine[];
  status: DraftStatus;
  shipheroId: string | null;
  bookedBin: string | null;
  bookedAt: string | null;
  bookInResult: BookInResult | null;
  pushedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export const draftUnits = (d: Pick<PoDraftDto, "lines">) => d.lines.reduce((a, l) => a + l.qty, 0);

/** The returns wall — v1 books everything into one of these. */
export const RET_BINS = ["RET-01", "RET-02", "RET-03", "RET-04", "RET-05", "RET-06", "RET-07", "RET-08"] as const;

// ---- Book-in ----

/** One line as ShipHero holds it right now (the source of truth for booking in). */
export interface LivePoLine {
  sku: string;
  productName: string;
  ordered: number;
  received: number;
}

export interface LivePoCheck {
  poNumber: string;
  status: string;
  lines: LivePoLine[];
  /** Draft-vs-ShipHero differences the user must acknowledge (empty = clean match). */
  diffs: string[];
}

export interface BookInLineResult {
  sku: string;
  qty: number; // what we set out to book in (remaining = ordered - received)
  ok: boolean;
  receivedBefore?: number;
  receivedAfter?: number;
  binBefore?: number;
  binAfter?: number;
  error?: string;
}

export interface BookInResult {
  bin: string;
  lines: BookInLineResult[];
  closed: boolean;
  closeError?: string;
  at: string;
}
