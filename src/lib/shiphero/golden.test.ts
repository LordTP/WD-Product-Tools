import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Papa from "papaparse";
import { convertRows } from "./convert";
import type { SourceRow, VendorMap } from "./types";

// Golden file: a REAL ShipHero PO upload that imported successfully (provided by
// Thomas). The converter must reproduce it exactly from reconstructed source rows.
const VENDOR_MAP: VendorMap = {
  SANDRA: { shipheroName: "Dongguan Jinfeng Apparel Co. Ltd (Sandra)" },
  MICHAEL: { shipheroName: "Dongguan Wenxuan clothing Co.,Ltd (Michael)" },
  SUMMA: { shipheroName: "SJA Fashion Ltd - CN (Summa)" },
};
// reverse: resolved ShipHero name -> alias, to rebuild the merchandiser's input.
const NAME_TO_ALIAS = Object.fromEntries(
  Object.entries(VENDOR_MAP).map(([alias, v]) => [v.shipheroName, alias]),
);

const goldenPath = resolve(process.cwd(), "samples/golden_shiphero_po_upload.csv");
const golden = readFileSync(goldenPath, "utf-8");

function reconstructSourceRows(csv: string): SourceRow[] {
  const parsed = Papa.parse<string[]>(csv.trim(), { skipEmptyLines: true });
  const rows = parsed.data.slice(1); // drop header
  return rows.map((r, i) => ({
    poNumber: r[0],
    productSku: "",
    title: "",
    size: "",
    supplier: NAME_TO_ALIAS[r[1]] ?? r[1], // resolved name -> alias
    variantSku: r[15], // Sku column
    quantity: r[17], // Quantity column
    factoryCost: r[19], // Price column
    sourceRow: i + 2,
  }));
}

const norm = (s: string) => s.replace(/\r\n/g, "\n").trimEnd();

describe("golden file — real ShipHero upload round-trips exactly", () => {
  const rows = reconstructSourceRows(golden);
  const result = convertRows(rows, VENDOR_MAP);

  it("converts cleanly with no blocking errors", () => {
    expect(result.ready).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("reproduces the real file's totals (12 POs / 68 lines / 2,400 units)", () => {
    expect(result.summary.poCount).toBe(12);
    expect(result.summary.lineCount).toBe(68);
    expect(result.summary.totalUnits).toBe(2400);
  });

  it("produces output identical to the real working file", () => {
    expect(norm(result.csv)).toBe(norm(golden));
  });

  it("keeps Michael's comma-containing vendor name double-quoted", () => {
    expect(result.csv).toContain('"Dongguan Wenxuan clothing Co.,Ltd (Michael)"');
  });
});
