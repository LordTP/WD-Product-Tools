import { describe, it, expect } from "vitest";
import { FIELDS, buildScenario, headerFor, blockSku, analyze, type ColumnMap } from "./convert";
import { expandSizes } from "@/lib/sizes";

// Build a column map straight from the known indices, and synthesise data rows
// at those indices (we don't have the real 156-col Style Arcade export).
const cols: ColumnMap = Object.fromEntries(FIELDS.map((f) => [f.key, f.index]));
function mkRow(vals: Record<string, unknown>): unknown[] {
  const row = new Array(160).fill("");
  for (const [k, v] of Object.entries(vals)) row[cols[k]] = v;
  return row;
}

const SUMMA = mkRow({
  product_code: "WD-000682-025", title: "ALEX TOP | CHOCOLATE", size_range: "XXS-XL",
  supplier: "SUMMA", season: "AW26", collection: "Drop 1", rrp: 50, cost_gbp: 8.34,
  colour_name: "CHOCOLATE", fcp_usd: 0, fcp_gbp_conv: 6.45, landed_gbp: 8.34, fabric_type: "Jersey",
});
const SANDRA = mkRow({
  product_code: "WD-000600-001", title: "BELLA TOP | WHITE", size_range: "XXS-XL",
  supplier: "SANDRA", season: "AW26", collection: "Drop 1", rrp: 40, cost_gbp: 6,
  colour_name: "WHITE", fcp_usd: 10.8, fcp_gbp_conv: 0, landed_gbp: 5,
});

const idx = (scn: "A" | "B", name: string) => headerFor(scn).indexOf(name);
const FCP = "Metafield: custom.factory_cost_price [number_decimal]";
const LANDED = "Metafield: custom.landed_cost_price [number_decimal]";
const BLOCK = "Metafield: custom.product_block_sku [single_line_text_field]";
const SEASON = "Metafield: custom.season_code [single_line_text_field]";
const ORIG_SEASON = "Metafield: custom.original_season_code [single_line_text_field]";

describe("Style Arcade converter (spec §8 behaviours)", () => {
  const A = buildScenario([SUMMA, SANDRA], cols, "A");

  it("expands XXS-XL to 6 sizes; one product = 1 titled row + N-1 blank rows", () => {
    expect(A[0]).toEqual(headerFor("A")); // header
    expect(A.length).toBe(1 + 12); // header + 2 products × 6 sizes
    expect(A[1][0]).toBe("ALEX TOP | CHOCOLATE"); // first row titled
    expect(A[2][0]).toBe(""); // subsequent size rows blank title
  });

  it("builds numeric SKUs -98..-93 across XXS-XL", () => {
    const skuCol = idx("A", "Variant SKU");
    expect(A.slice(1, 7).map((r) => r[skuCol])).toEqual([
      "WD-000682-025-98", "WD-000682-025-97", "WD-000682-025-96",
      "WD-000682-025-95", "WD-000682-025-94", "WD-000682-025-93",
    ]);
  });

  it("factory_cost_price metafield: Summa uses Converted £ (6.45), non-Summa uses $ (10.8)", () => {
    const c = idx("A", FCP);
    expect(A[1][c]).toBe("6.45"); // Summa first row
    expect(A[7][c]).toBe("10.8"); // Sandra first row
  });

  it("season_code gets _NEW suffix; original kept; product_block_sku trims colour", () => {
    expect(A[1][idx("A", SEASON)]).toBe("AW26_NEW");
    expect(A[1][idx("A", ORIG_SEASON)]).toBe("AW26");
    expect(A[1][idx("A", BLOCK)]).toBe("WD-000682");
  });

  it("Option1 = Colour (per colourway), Option2 = Size; colour repeats across sizes", () => {
    expect(A[1][1]).toBe("Colour");
    expect(A[1][2]).toBe("CHOCOLATE");
    expect(A[1][3]).toBe("Size");
    expect(A[1][4]).toBe("XXS");
    expect(A.slice(1, 7).every((r) => r[2] === "CHOCOLATE")).toBe(true); // Summa, all 6 sizes
    expect(A.slice(7, 13).every((r) => r[2] === "WHITE")).toBe(true);    // Sandra, all 6 sizes
  });

  it("blanks ALL metafields on non-first variant rows, but keeps variant-level options + Price + Cost", () => {
    const row = A[2]; // 2nd size of Summa (XS)
    expect(row[1]).toBe("Colour");
    expect(row[2]).toBe("CHOCOLATE");
    expect(row[3]).toBe("Size");
    expect(row[4]).toBe("XS");
    expect(row[6]).toBe("50");   // Variant Price (RRP) repeats on every variant row
    expect(row[7]).toBe("8.34"); // Cost per item (Cost price GBP) repeats on every variant row
    // everything after the 8 base cols [Title, Opt1 Name/Value, Opt2 Name/Value, SKU, Price, Cost] is blank
    expect(row.slice(8).every((c) => c === "")).toBe(true);
  });

  it("native Cost per item (variant-level) = Cost price (GBP), distinct from factory cost", () => {
    const c = idx("A", "Cost per item");
    expect(c).toBe(7); // after the two option pairs + SKU + Variant Price
    expect(A.slice(1, 7).every((r) => r[c] === "8.34")).toBe(true); // Summa cost_gbp, all 6 sizes
    expect(A.slice(7, 13).every((r) => r[c] === "6")).toBe(true);   // Sandra cost_gbp, all 6 sizes
    // and it is NOT the factory_cost_price metafield value (6.45 for Summa)
    expect(A[1][c]).not.toBe(A[1][idx("A", FCP)]);
  });

  it("Scenario B adds landed_cost_price (8.34 for Summa) after factory_cost_price", () => {
    const B = buildScenario([SUMMA], cols, "B");
    expect(B[1][idx("B", FCP)]).toBe("6.45");
    expect(B[1][idx("B", LANDED)]).toBe("8.34");
  });

  it("analyze reports product + variant counts", () => {
    const a = analyze([SUMMA, SANDRA], cols);
    expect(a.productCount).toBe(2);
    expect(a.variantRows).toBe(12);
    expect(a.duplicateCodes).toEqual([]);
  });
});

describe("helpers", () => {
  it("expandSizes", () => {
    expect(expandSizes("XXS-XL")).toEqual(["XXS", "XS", "S", "M", "L", "XL"]);
    expect(expandSizes("XS-S")).toEqual(["XS-S"]); // bracket size stays single
    expect(expandSizes("M")).toEqual(["M"]);
    expect(expandSizes("")).toEqual([]);
  });
  it("blockSku trims to first two segments", () => {
    expect(blockSku("WD-000682-025")).toBe("WD-000682");
    expect(blockSku("WD-1")).toBe("WD-1");
  });
});
