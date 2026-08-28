// Pure ShipHero PO converter — spec §2.2, §2.3, §4.5.
// No web/IO/DB coupling. Takes normalized rows + a vendor map + options and
// returns a structured result plus the exact ShipHero CSV string.

import Papa from "papaparse";
import { deriveSizeFromSku } from "@/lib/sizes";
import { normalizeSheetDate } from "./dates";
import {
  DEFAULTS,
  type ConvertOptions,
  type ConvertResult,
  type OutputLine,
  type PoGroup,
  type SourceRow,
  type ValidationIssue,
  type VendorMap,
} from "./types";

/** Exact ShipHero PO bulk-upload header, in order (spec §2.2). */
export const SHIPHERO_HEADER = [
  "PO Number",
  "Vendor",
  "Ship Date",
  "PO Date",
  "Status",
  "Shipping Carrier",
  "Shipping Method",
  "Shipping Price",
  "Discount",
  "Tax",
  "Tracking Number",
  "Payment Method",
  "Payment Due By",
  "PO Note",
  "Packer Note",
  "Sku",
  "Vendor Sku",
  "Quantity",
  "Sell Ahead",
  "Price",
] as const;

const trim = (v: unknown): string => (v == null ? "" : String(v).trim());

const normalizeAlias = (v: unknown): string => trim(v).toUpperCase();

/** Numeric format: integers without decimals, else 2dp; passthrough for junk. */
function num(v: unknown): string {
  const s = trim(v);
  if (s === "") return "";
  const f = Number(s);
  if (Number.isNaN(f)) return s;
  return Number.isInteger(f) ? String(f) : String(Math.round(f * 100) / 100);
}

const isNumeric = (v: unknown): boolean => {
  const s = trim(v);
  return s !== "" && !Number.isNaN(Number(s));
};

export function convertRows(
  rows: SourceRow[],
  vendorMap: VendorMap,
  options: ConvertOptions = {},
): ConvertResult {
  const defaults = { ...DEFAULTS, ...(options.defaults ?? {}) };
  const sellAheadByPo = options.sellAheadByPo ?? {};
  const statusByPo = options.statusByPo ?? {};

  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const lines: OutputLine[] = [];
  const unmapped = new Set<string>();

  // --- resolve a fulfillment status per PO (match typed → known status) ---
  // lowercased known status -> canonical name (sent verbatim to ShipHero).
  const statusLookup = new Map<string, string>();
  for (const s of options.knownStatuses ?? []) statusLookup.set(s.trim().toLowerCase(), s);

  // first non-blank typed status per PO
  const typedStatusByPo = new Map<string, string>();
  for (const row of rows) {
    const po = trim(row.poNumber);
    const typed = trim(row.status);
    if (typed && !typedStatusByPo.has(po)) typedStatusByPo.set(po, typed);
  }
  // poNumber -> { status, resolved, source }
  const resolvedStatus = new Map<string, { status: string; resolved: boolean; source: string }>();
  function statusFor(po: string) {
    const cached = resolvedStatus.get(po);
    if (cached) return cached;
    const source = typedStatusByPo.get(po) ?? "";
    let res: { status: string; resolved: boolean; source: string };
    if (statusByPo[po]) {
      res = { status: statusByPo[po], resolved: true, source }; // user override
    } else if (source) {
      const match = statusLookup.get(source.toLowerCase());
      res = match
        ? { status: match, resolved: true, source }
        : { status: "", resolved: false, source }; // typed but no match → edit needed
    } else {
      res = { status: defaults.status, resolved: true, source }; // no status column → default
    }
    resolvedStatus.set(po, res);
    return res;
  }

  // Track duplicate identical lines within a PO: key -> source rows.
  const dupTracker = new Map<string, number[]>();

  for (const row of rows) {
    const poNumber = trim(row.poNumber);
    const alias = normalizeAlias(row.supplier);
    const variantSku = trim(row.variantSku);
    const rn = row.sourceRow;

    const mapped = alias ? vendorMap[alias] : undefined;
    if (alias && !mapped) unmapped.add(alias);

    // --- per-row blocking validation (spec §4.5) ---
    let blocked = false;
    let blockReason: string | undefined;
    const block = (kind: ValidationIssue["kind"], message: string) => {
      blocked = true;
      blockReason ??= message;
      errors.push({ kind, blocking: true, message, rows: [rn] });
    };

    if (!variantSku) block("missing_sku", `Row ${rn}: missing variant SKU.`);
    if (trim(row.quantity) === "")
      block("missing_quantity", `Row ${rn}: missing quantity.`);
    else if (!isNumeric(row.quantity))
      block("non_numeric_quantity", `Row ${rn}: quantity "${trim(row.quantity)}" is not a number.`);
    if (trim(row.factoryCost) === "")
      block("missing_price", `Row ${rn}: missing price.`);
    else if (!isNumeric(row.factoryCost))
      block("non_numeric_price", `Row ${rn}: price "${trim(row.factoryCost)}" is not a number.`);
    if (alias && !mapped)
      block("unmapped_vendor", `Row ${rn}: supplier alias "${alias}" has no ShipHero vendor mapping.`);
    if (!alias)
      block("unmapped_vendor", `Row ${rn}: supplier is blank.`);

    const vendorName = mapped?.shipheroName ?? alias;

    // Flag commas that the CSV writer will auto-quote (spec §4.5 last bullet).
    if (vendorName.includes(",")) {
      warnings.push({
        kind: "comma_quoted",
        blocking: false,
        message: `Vendor "${vendorName}" contains a comma and will be auto-quoted in the CSV.`,
        rows: [rn],
      });
    }

    lines.push({
      poNumber,
      vendor: vendorName,
      sku: variantSku,
      vendorSku: variantSku, // spec §2.2: both columns get the variant SKU
      quantity: num(row.quantity),
      sellAhead: sellAheadByPo[poNumber] ? "1" : defaults.sellAhead,
      price: num(row.factoryCost),
      sourceRow: rn,
      poStatus: statusFor(poNumber).status,
      // size from the sheet, or derived from the variant SKU's numeric suffix
      size: trim(row.size) || deriveSizeFromSku(variantSku, options.sizeMap),
      title: trim(row.title),
      status: blocked ? "blocked" : "ok",
      blockReason,
    });

    // duplicate identical-line detection within a PO (warn + offer merge)
    const dupKey = `${poNumber}|${variantSku}|${num(row.quantity)}|${num(row.factoryCost)}`;
    const seen = dupTracker.get(dupKey);
    if (seen) seen.push(rn);
    else dupTracker.set(dupKey, [rn]);
  }

  for (const [, dupRows] of dupTracker) {
    if (dupRows.length > 1) {
      warnings.push({
        kind: "duplicate_line",
        blocking: false,
        message: `Identical line repeated ${dupRows.length}× within a PO (rows ${dupRows.join(", ")}). Consider merging quantities.`,
        rows: dupRows,
      });
    }
  }

  // --- group into POs for the preview grid ---
  const groups = new Map<string, PoGroup>();
  // First row of a PO with a non-empty value wins for each date (they're
  // PO-level in the sheet, repeated per size row).
  const dateFor = (po: string, field: "orderSent" | "exFactory" | "delivery"): string | null => {
    for (const r of rows) {
      if (trim(r.poNumber) !== po) continue;
      const norm = normalizeSheetDate(r[field]);
      if (norm) return norm;
    }
    return null;
  };
  for (const line of lines) {
    let g = groups.get(line.poNumber);
    if (!g) {
      const alias = normalizeAlias(
        rows.find((r) => trim(r.poNumber) === line.poNumber)?.supplier,
      );
      const st = statusFor(line.poNumber);
      g = {
        poNumber: line.poNumber,
        vendor: line.vendor,
        vendorResolved: Boolean(vendorMap[alias]),
        vendorId: vendorMap[alias]?.vendorId ?? null,
        alias,
        totalUnits: 0,
        sellAhead: Boolean(sellAheadByPo[line.poNumber]),
        status: st.status,
        statusResolved: st.resolved,
        statusSource: st.source,
        title: null,
        productCount: 0,
        orderSent: dateFor(line.poNumber, "orderSent"),
        exFactory: dateFor(line.poNumber, "exFactory"),
        delivery: dateFor(line.poNumber, "delivery"),
        lines: [],
      };
      groups.set(line.poNumber, g);
    }
    g.lines.push(line);
    g.totalUnits += Number(line.quantity) || 0;
  }
  const pos = [...groups.values()];
  // Resolve a common product title per PO (for the group header).
  for (const g of pos) {
    const titles = [...new Set(g.lines.map((l) => l.title).filter(Boolean))];
    g.productCount = titles.length;
    g.title = titles.length === 1 ? titles[0] : null;
  }

  // --- summary ---
  const perPo: Record<string, number> = {};
  for (const g of pos) perPo[g.poNumber] = g.totalUnits;
  const summary = {
    poCount: pos.length,
    lineCount: lines.length,
    totalUnits: lines.reduce((a, l) => a + (Number(l.quantity) || 0), 0),
    perPo,
  };

  // --- CSV (only when nothing blocks) ---
  const ready = errors.length === 0;
  let csv = "";
  if (ready) {
    const data = lines.map((l) => [
      l.poNumber, // PO Number
      l.vendor, // Vendor
      "", // Ship Date
      "", // PO Date
      l.poStatus, // Status (resolved per-PO)
      "", // Shipping Carrier
      "", // Shipping Method
      defaults.shippingPrice, // Shipping Price
      defaults.discount, // Discount
      defaults.tax, // Tax
      "", // Tracking Number
      "", // Payment Method
      "", // Payment Due By
      "", // PO Note
      "", // Packer Note
      l.sku, // Sku
      l.vendorSku, // Vendor Sku
      l.quantity, // Quantity
      l.sellAhead, // Sell Ahead
      l.price, // Price
    ]);
    // papaparse handles minimal quoting (only fields containing comma/quote/newline).
    csv = Papa.unparse({ fields: [...SHIPHERO_HEADER], data });
  }

  return {
    pos,
    lines,
    unmappedAliases: [...unmapped].sort(),
    errors,
    warnings,
    summary,
    csv,
    ready,
  };
}
