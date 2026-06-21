// Style Arcade export → Wander Doll Shopify multi-variant bulk-upload CSV (for
// Hextom). Faithful port of convert_style_arcade.py. PURE (no IO) so it's unit-
// tested and runs client-side. One row per size variant; Title + ALL metafields
// on the FIRST row of each product, blank on the size rows beneath (that's how
// Hextom groups variants — see SPEC_style_arcade_converter.md §2.1).

import { expandSizes, DEFAULT_SIZE_MAP, type SizeMap } from "@/lib/sizes";

export const SEASON_SUFFIX = "_NEW"; // spec §6.1 (python ref had _NEW_TRADING)
const SUMMA = "SUMMA"; // FOB / GBP-priced supplier

export type Scenario = "A" | "B";

// Source fields: header-name aliases (matched first) + the known-good column
// index as a fallback (spec §4 — Style Arcade may reorder columns).
export interface FieldDef {
  key: string;
  names: string[];
  index: number;
  required?: boolean;
}
export const FIELDS: FieldDef[] = [
  { key: "product_code", names: ["product code"], index: 1, required: true },
  { key: "title", names: ["product title", "title", "product/title", "product name"], index: 3, required: true },
  { key: "rrp", names: ["rrp"], index: 18, required: true },
  { key: "fcp_usd", names: ["factory cost price ($)", "factory cost price $", "factory cost price usd"], index: 21 },
  { key: "supplier", names: ["supplier"], index: 31, required: true },
  { key: "country", names: ["country of origin", "country"], index: 32 },
  { key: "size_range", names: ["size range"], index: 35, required: true },
  { key: "category", names: ["category"], index: 36 },
  { key: "subcategory", names: ["subcategory"], index: 37 },
  { key: "season", names: ["season"], index: 38 },
  { key: "collection", names: ["collection"], index: 39 },
  { key: "colour_family", names: ["colour family", "color family"], index: 40 },
  { key: "colour_name", names: ["colour name", "color name", "colour"], index: 41 },
  { key: "pattern", names: ["pattern"], index: 42 },
  { key: "fabric_category", names: ["fabric category"], index: 43 },
  { key: "fabric_type", names: ["fabric type"], index: 44 },
  { key: "fabric_composition", names: ["fabric composition"], index: 45 },
  { key: "sleeve_length", names: ["sleeve length"], index: 46 },
  { key: "neckline", names: ["neckline"], index: 47 },
  { key: "length", names: ["length"], index: 48 },
  { key: "fit", names: ["fit"], index: 49 },
  { key: "use", names: ["use"], index: 50 },
  { key: "landed_gbp", names: ["landed cost price calc (£)", "landed cost price"], index: 154 },
  { key: "fcp_gbp_conv", names: ["factory cost price converted (£)", "factory cost price converted"], index: 155 },
];

export type ColumnMap = Record<string, number>;

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9$]+/g, " ").trim();

/** Resolve each field to a column index by header name, falling back to the known
 *  index. Returns the map + any required field whose column couldn't be found.
 *  Matching is tiered so a short, exact header (e.g. "RRP") always beats a longer
 *  one that merely *contains* the word (e.g. "Spend @ RRP ex tax (GBP)"). */
export function resolveColumns(headers: string[]): { cols: ColumnMap; missing: string[] } {
  const normd = headers.map(norm);
  const cols: ColumnMap = {};
  const missing: string[] = [];
  for (const f of FIELDS) {
    let idx = -1;
    for (const name of f.names) {
      const n = norm(name);
      // 1. exact header match.
      idx = normd.findIndex((h) => h === n);
      // 2. header is the field plus a trailing qualifier — "rrp £", "rrp gbp".
      if (idx === -1) idx = normd.findIndex((h) => h.startsWith(n + " "));
      // 3. loose contains — but pick the CLOSEST (shortest) header so we don't
      //    grab a "spend …" / "total …" column that just mentions the word.
      if (idx === -1) {
        let best = -1, bestLen = Infinity;
        normd.forEach((h, i) => {
          if (h.includes(n) || n.includes(h)) {
            if (h.length < bestLen) { best = i; bestLen = h.length; }
          }
        });
        idx = best;
      }
      if (idx !== -1) break;
    }
    if (idx === -1) idx = f.index < headers.length ? f.index : -1; // fall back to known index
    cols[f.key] = idx;
    if (f.required && idx === -1) missing.push(f.key);
  }
  return { cols, missing };
}

// ---- column headers of the OUTPUT (exact, incl. [type] suffix — spec §4.1) ----
const HEADER_BASE = [
  "Title", "Option1 Name", "Option1 Value", "Variant SKU", "Variant Price", "Cost per item",
  "Metafield: custom.collection [single_line_text_field]",
  "Metafield: custom.original_collection [single_line_text_field]",
  "Metafield: custom.season_code [single_line_text_field]",
  "Metafield: custom.original_season_code [single_line_text_field]",
  "Metafield: custom.colour [single_line_text_field]",
  "Metafield: custom.colour_family [single_line_text_field]",
  "Metafield: custom.product_category [single_line_text_field]",
  "Metafield: custom.product_subcategory [single_line_text_field]",
  "Metafield: custom.product_block_sku [single_line_text_field]",
  "Metafield: custom.country_of_origin [single_line_text_field]",
  "Metafield: custom.supplier [single_line_text_field]",
];
const COST_A = ["Metafield: custom.factory_cost_price [number_decimal]"];
const COST_B = [
  "Metafield: custom.factory_cost_price [number_decimal]",
  "Metafield: custom.landed_cost_price [number_decimal]",
];
const HEADER_TAIL = [
  "Metafield: custom.fit [single_line_text_field]",
  "Metafield: custom.pattern [single_line_text_field]",
  "Metafield: custom.neckline [single_line_text_field]",
  "Metafield: custom.sleeve_length [single_line_text_field]",
  "Metafield: custom.use [single_line_text_field]",
  "Metafield: custom.length [single_line_text_field]",
  "Metafield: custom.fabric_category [single_line_text_field]",
  "Metafield: custom.fabric_type [single_line_text_field]",
  "Metafield: custom.fabric_composition [single_line_text_field]",
];

export function headerFor(scenario: Scenario): string[] {
  return [...HEADER_BASE, ...(scenario === "A" ? COST_A : COST_B), ...HEADER_TAIL];
}

// ---- helpers (match the python) ----
const sv = (v: unknown): string => (v == null ? "" : String(v).trim());
function num(v: unknown): string {
  const s = sv(v);
  if (s === "") return "";
  const f = Number(s);
  if (Number.isNaN(f)) return s;
  return Number.isInteger(f) ? String(f) : String(Math.round(f * 100) / 100);
}
export function blockSku(code: string): string {
  const parts = sv(code).split("-");
  return parts.length >= 2 ? parts.slice(0, 2).join("-") : sv(code);
}
/** Factory cost per unit: Converted £ for Summa (FOB/GBP-priced), else the $
 *  value. This single value feeds BOTH the native "Cost per item" column and the
 *  custom.factory_cost_price metafield. */
function factoryCost(row: unknown[], cols: ColumnMap): string {
  const supplier = sv(row[cols.supplier]).toUpperCase();
  return num(supplier === SUMMA ? row[cols.fcp_gbp_conv] : row[cols.fcp_usd]);
}
function costFor(row: unknown[], cols: ColumnMap, scenario: Scenario): string[] {
  const fcp = factoryCost(row, cols);
  return scenario === "A" ? [fcp] : [fcp, num(row[cols.landed_gbp])];
}

const at = (row: unknown[], idx: number): unknown => (idx >= 0 ? row[idx] : "");

/** Build the output rows (header + one row per size variant). */
export function buildScenario(
  dataRows: unknown[][],
  cols: ColumnMap,
  scenario: Scenario,
  seasonSuffix: string = SEASON_SUFFIX,
  sizeMap: SizeMap = DEFAULT_SIZE_MAP,
): string[][] {
  const out: string[][] = [headerFor(scenario)];
  for (const row of dataRows) {
    const code = sv(at(row, cols.product_code));
    if (!code) continue;
    const title = sv(at(row, cols.title));
    const sizes = expandSizes(sv(at(row, cols.size_range)), sizeMap);
    const sizeList = sizes.length ? sizes : [""];
    const season = sv(at(row, cols.season));
    const meta = [
      sv(at(row, cols.collection)),
      sv(at(row, cols.collection)), // original_collection = same
      season ? season + seasonSuffix : "",
      season,
      sv(at(row, cols.colour_name)),
      sv(at(row, cols.colour_family)),
      sv(at(row, cols.category)),
      sv(at(row, cols.subcategory)),
      blockSku(code),
      sv(at(row, cols.country)),
      sv(at(row, cols.supplier)),
      ...costFor(row, cols, scenario),
      sv(at(row, cols.fit)),
      sv(at(row, cols.pattern)),
      sv(at(row, cols.neckline)),
      sv(at(row, cols.sleeve_length)),
      sv(at(row, cols.use)),
      sv(at(row, cols.length)),
      sv(at(row, cols.fabric_category)),
      sv(at(row, cols.fabric_type)),
      sv(at(row, cols.fabric_composition)),
    ];
    const blanks = meta.map(() => "");
    const rrp = num(at(row, cols.rrp));
    const cost = factoryCost(row, cols); // native Cost per item — variant-level, on every size row
    sizeList.forEach((size, i) => {
      const scode = sizeMap.codes[size] ?? "";
      const sku = scode ? `${code}-${scode}` : code;
      out.push([i === 0 ? title : "", "Size", size, sku, rrp, cost, ...(i === 0 ? meta : blanks)]);
    });
  }
  return out;
}

// ---- analysis for the preview (spec §9 / §10) ----
export interface StyleArcadeAnalysis {
  productCount: number;
  variantRows: number;
  duplicateCodes: string[];
  unmappedSizes: string[]; // size-range strings that fell to the literal fallback
  populated: { key: string; label: string; pct: number }[]; // % non-blank per source field
}

export function analyze(
  dataRows: unknown[][],
  cols: ColumnMap,
  sizeMap: SizeMap = DEFAULT_SIZE_MAP,
): StyleArcadeAnalysis {
  const products = dataRows.filter((r) => sv(at(r, cols.product_code)));
  let variantRows = 0;
  const seen = new Set<string>();
  const dups = new Set<string>();
  const unmapped = new Set<string>();
  for (const r of products) {
    const code = sv(at(r, cols.product_code));
    if (seen.has(code)) dups.add(code);
    seen.add(code);
    const range = sv(at(r, cols.size_range));
    const sizes = expandSizes(range, sizeMap);
    variantRows += sizes.length || 1;
    // a single literal size that isn't a known size code = unrecognised range
    if (sizes.length === 1 && !(sizes[0] in sizeMap.codes) && !range.includes("-") && range) {
      unmapped.add(range);
    }
  }
  const popKeys = ["fabric_category", "fabric_type", "fabric_composition", "colour_name", "supplier", "season", "rrp"];
  const populated = popKeys.map((key) => {
    const idx = cols[key];
    const filled = products.filter((r) => sv(at(r, idx)) !== "").length;
    return { key, label: key.replace(/_/g, " "), pct: products.length ? Math.round((filled / products.length) * 100) : 0 };
  });
  return {
    productCount: products.length,
    variantRows,
    duplicateCodes: [...dups],
    unmappedSizes: [...unmapped],
    populated,
  };
}
