import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseSheet, autoMapColumns } from "./parse";
import { buildSourceRows } from "./fields";
import { convertRows } from "./convert";
import type { VendorMap } from "./types";

// End-to-end: the REAL raw input the merch team supplied ("PO DATA - SKU LEVEL")
// run through the full pipeline (parse → auto-map → convert) must reproduce the
// REAL ShipHero upload file that imported successfully. This exercises the actual
// column auto-mapping against real-world headers (incl. extra date columns and a
// multi-line quoted header cell).
const VENDOR_MAP: VendorMap = {
  SANDRA: { shipheroName: "Dongguan Jinfeng Apparel Co. Ltd (Sandra)" },
  MICHAEL: { shipheroName: "Dongguan Wenxuan clothing Co.,Ltd (Michael)" },
  SUMMA: { shipheroName: "SJA Fashion Ltd - CN (Summa)" },
};

const inputPath = resolve(process.cwd(), "samples/po_data_sku_level.csv");
const goldenPath = resolve(process.cwd(), "samples/golden_shiphero_po_upload.csv");
const norm = (s: string) => s.replace(/\r\n/g, "\n").trimEnd();

describe("end-to-end — raw merch input reproduces the real ShipHero upload", () => {
  const buffer = readFileSync(inputPath);
  const golden = readFileSync(goldenPath, "utf-8");

  it("auto-maps the real headers correctly", async () => {
    const { headers } = await parseSheet(buffer, "po_data_sku_level.csv");
    const mapping = autoMapColumns(headers);
    // every required field found a column
    expect(mapping.poNumber).not.toBeNull();
    expect(mapping.supplier).not.toBeNull();
    expect(mapping.variantSku).not.toBeNull();
    expect(mapping.quantity).not.toBeNull();
    expect(mapping.factoryCost).not.toBeNull();
    // cost maps to FACTORY COST PRICE, not one of the trailing date columns
    expect(headers[mapping.factoryCost!]).toMatch(/factory cost price/i);
    expect(headers[mapping.quantity!]).toMatch(/quantity/i);
  });

  it("converts the raw input into byte-identical output to the real file", async () => {
    const { headers, rows } = await parseSheet(buffer, "po_data_sku_level.csv");
    const mapping = autoMapColumns(headers);
    const sourceRows = buildSourceRows(rows, mapping);
    const result = convertRows(sourceRows, VENDOR_MAP);

    expect(result.ready).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.summary).toMatchObject({ poCount: 12, lineCount: 68, totalUnits: 2400 });
    expect(norm(result.csv)).toBe(norm(golden));
  });
});
