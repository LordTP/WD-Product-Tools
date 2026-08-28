import { describe, expect, it } from "vitest";
import { parseDateRows, splitPaste } from "./po-dates-sheet";

describe("parseDateRows", () => {
  it("matches by column name when a header row is present, leaving blanks alone", () => {
    const grid = splitPaste("PO Number\tOrder Sent\tEx-factory\tDelivery (Expected)\nPO510\t01/07/2026\t\t24/08/2026\nPO511\t\t\t30/08/2026");
    const { rows, mode } = parseDateRows(grid);
    expect(mode).toBe("columns");
    expect(rows).toEqual([
      { poNumber: "PO510", orderSent: "2026-07-01", delivery: "2026-08-24" },
      { poNumber: "PO511", delivery: "2026-08-30" },
    ]);
  });

  it("copes with the template's columns in a different order", () => {
    const grid = [["PO", "Delivery", "Ex-factory"], ["PO512", "2026-09-05", "2026-08-10"]];
    expect(parseDateRows(grid).rows).toEqual([{ poNumber: "PO512", exFactory: "2026-08-10", delivery: "2026-09-05" }]);
  });

  it("falls back to positional dates without a header (unchanged behaviour)", () => {
    const grid = splitPaste("PO471\t10/06/2026\t21/06/2026\nPO472\t05/09/2026\nPO473\t01/05/2026\t10/06/2026\t21/06/2026");
    const { rows, mode } = parseDateRows(grid);
    expect(mode).toBe("positional");
    expect(rows).toEqual([
      { poNumber: "PO471", exFactory: "2026-06-10", delivery: "2026-06-21" },
      { poNumber: "PO472", delivery: "2026-09-05" },
      { poNumber: "PO473", orderSent: "2026-05-01", exFactory: "2026-06-10", delivery: "2026-06-21" },
    ]);
  });

  it("skips rows with no PO number or no usable dates", () => {
    const grid = [["PO Number", "Delivery"], ["", "2026-09-05"], ["PO999", "not a date"], ["PO998", "2026-09-06"]];
    expect(parseDateRows(grid).rows).toEqual([{ poNumber: "PO998", delivery: "2026-09-06" }]);
  });
});
