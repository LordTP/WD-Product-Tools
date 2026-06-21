import type { SizeMap } from "@/lib/sizes";

// Shared types for the ShipHero PO converter.
// The converter is a pure function (no web/IO) so it can be unit-tested and
// reused by the future ShipHero GraphQL push (Phase 3).

/** A single normalized source row (one per size/variant), post column-mapping. */
export interface SourceRow {
  poNumber: string;
  productSku: string; // parent/style SKU (informational; never written to output)
  title: string; // dropped from output; ShipHero shows it from the product record
  size: string;
  supplier: string; // alias, e.g. "SANDRA" — translated via the vendor map
  variantSku: string; // the stockable per-size unit — this is what ShipHero receives
  quantity: string | number;
  factoryCost: string | number;
  status?: string; // optional PO status column (matched against known statuses)
  /** 1-based row number in the source sheet, for error references. */
  sourceRow: number;
}

/** alias (UPPERCASE, trimmed) -> resolved ShipHero vendor. */
export type VendorMap = Record<
  string,
  { shipheroName: string; vendorId?: string | number | null }
>;

export interface ConvertOptions {
  /** Per-PO Sell Ahead flag. Missing key = false (0). */
  sellAheadByPo?: Record<string, boolean>;
  /** Valid ShipHero status names — typed statuses are matched against these. */
  knownStatuses?: string[];
  /** Per-PO status override chosen by the user (always a valid known status). */
  statusByPo?: Record<string, string>;
  /** Size map for deriving a size label from a SKU when there's no Size column. */
  sizeMap?: SizeMap;
  /** Overridable output defaults (spec §2.2 / §4.4). */
  defaults?: Partial<typeof DEFAULTS>;
}

export const DEFAULTS = {
  status: "pending",
  shippingPrice: "0",
  discount: "0",
  tax: "0",
  sellAhead: "0",
};

export type IssueKind =
  | "unmapped_vendor"
  | "missing_sku"
  | "missing_quantity"
  | "missing_price"
  | "non_numeric_quantity"
  | "non_numeric_price"
  | "duplicate_line"
  | "comma_quoted";

export interface ValidationIssue {
  kind: IssueKind;
  /** true = blocks conversion/download; false = informational warning. */
  blocking: boolean;
  message: string;
  /** Source rows involved (1-based). */
  rows: number[];
  /** For unmapped_vendor issues, the offending alias. */
  alias?: string;
}

/** One output line in ShipHero PO bulk-upload format. */
export interface OutputLine {
  poNumber: string;
  vendor: string;
  sku: string;
  vendorSku: string;
  quantity: string;
  sellAhead: string;
  price: string;
  sourceRow: number;
  /** The PO's resolved fulfillment status (written to the CSV Status column). */
  poStatus: string;
  /** Preview-only display fields (NOT written to the ShipHero CSV). */
  size: string;
  title: string;
  /** Row resolution status for the preview grid. */
  status: "ok" | "blocked";
  blockReason?: string;
}

/** A PO grouped for preview (header + its lines). */
export interface PoGroup {
  poNumber: string;
  vendor: string; // resolved name, or the raw alias if unmapped
  vendorResolved: boolean;
  vendorId: string | number | null; // ShipHero vendor id, for push
  alias: string;
  totalUnits: number;
  sellAhead: boolean;
  /** Resolved fulfillment status, or "" if a typed status didn't match. */
  status: string;
  statusResolved: boolean;
  /** What the merchandiser typed (for the "doesn't match" hint). */
  statusSource: string;
  /** Common product title across the PO, or null if it has multiple products. */
  title: string | null;
  productCount: number;
  lines: OutputLine[];
}

export interface ConvertSummary {
  poCount: number;
  lineCount: number;
  totalUnits: number;
  /** poNumber -> total units */
  perPo: Record<string, number>;
}

export interface ConvertResult {
  pos: PoGroup[];
  lines: OutputLine[];
  /** Distinct unmapped aliases (UPPERCASE), for the resolve banner. */
  unmappedAliases: string[];
  errors: ValidationIssue[]; // blocking
  warnings: ValidationIssue[];
  summary: ConvertSummary;
  /** ShipHero-ready CSV string. Empty when there are blocking errors. */
  csv: string;
  /** true when csv was produced (no blocking errors). */
  ready: boolean;
}
