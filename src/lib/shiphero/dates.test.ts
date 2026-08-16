import { describe, it, expect } from "vitest";
import { normalizeSheetDate, ukDate, poDatesNote } from "./dates";
import { convertRows } from "./convert";
import { buildPurchaseOrderInput } from "./push-builder";
import type { SourceRow, VendorMap } from "./types";

const VENDOR_MAP: VendorMap = {
  SANDRA: { shipheroName: "Dongguan Jinfeng Apparel Co. Ltd (Sandra)", vendorId: "1359289" },
};
const KNOWN_STATUSES = ["pending", "In transit"];

function row(over: Partial<SourceRow>): SourceRow {
  return {
    poNumber: "PO471", productSku: "WD-000543-196", title: "ATHENA BODYSUIT | BABY PINK", size: "M",
    supplier: "SANDRA", variantSku: "WD-000543-196-95", quantity: 50, factoryCost: 8, sourceRow: 2,
    orderSent: "29/04/2026", exFactory: "10/06/2026", delivery: "21/06/2026", ...over,
  };
}

describe("normalizeSheetDate", () => {
  it("parses UK DD/MM/YYYY", () => {
    expect(normalizeSheetDate("29/04/2026")).toBe("2026-04-29");
    expect(normalizeSheetDate("5/6/2026")).toBe("2026-06-05");
  });
  it("passes ISO through (with or without time)", () => {
    expect(normalizeSheetDate("2026-06-21")).toBe("2026-06-21");
    expect(normalizeSheetDate("2026-06-21T00:00:00")).toBe("2026-06-21");
  });
  it("converts Excel serials", () => {
    expect(normalizeSheetDate("46203")).toBe("2026-06-30"); // 30 Jun 2026
  });
  it("rejects garbage without throwing", () => {
    expect(normalizeSheetDate("")).toBeNull();
    expect(normalizeSheetDate("TBC")).toBeNull();
    expect(normalizeSheetDate("31/13/2026")).toBeNull();
  });
  it("round-trips to UK display", () => {
    expect(ukDate("2026-06-21")).toBe("21/06/2026");
  });
});

describe("dates through convert + push", () => {
  it("carries per-PO dates onto the group (first non-empty row wins)", () => {
    const r = convertRows(
      [row({}), row({ variantSku: "WD-000543-196-94", size: "L", sourceRow: 3, orderSent: "", exFactory: "", delivery: "" })],
      VENDOR_MAP,
      { knownStatuses: KNOWN_STATUSES },
    );
    expect(r.pos[0].orderSent).toBe("2026-04-29");
    expect(r.pos[0].exFactory).toBe("2026-06-10");
    expect(r.pos[0].delivery).toBe("2026-06-21");
  });

  it("pushes delivery as po_date and writes the dates note", () => {
    const r = convertRows([row({})], VENDOR_MAP, { knownStatuses: KNOWN_STATUSES });
    const input = buildPurchaseOrderInput(r.pos[0], { warehouseId: "WH1" });
    expect(input.po_date).toBe("2026-06-21");
    expect(input.po_note).toBe("Order sent 29/04/2026 · Ex-factory 10/06/2026 · Delivery due 21/06/2026");
  });

  it("omits po_date/po_note when the sheet has no dates", () => {
    const r = convertRows(
      [row({ orderSent: "", exFactory: "", delivery: "" })],
      VENDOR_MAP,
      { knownStatuses: KNOWN_STATUSES },
    );
    const input = buildPurchaseOrderInput(r.pos[0], { warehouseId: "WH1" });
    expect(input.po_date).toBeUndefined();
    expect(input.po_note).toBeUndefined();
  });

  it("poDatesNote handles partial dates", () => {
    expect(poDatesNote({ delivery: "2026-06-21" })).toBe("Delivery due 21/06/2026");
    expect(poDatesNote({})).toBe("");
  });
});
