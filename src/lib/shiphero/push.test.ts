import { describe, it, expect } from "vitest";
import { convertRows } from "./convert";
import { buildPurchaseOrderInputs, isPushable } from "./push-builder";
import { stripSizeSuffix } from "@/lib/sizes";
import type { SourceRow, VendorMap } from "./types";

const VENDOR_MAP: VendorMap = {
  SANDRA: { shipheroName: "Dongguan Jinfeng Apparel Co. Ltd (Sandra)", vendorId: "1359289" },
  MICHAEL: { shipheroName: "Dongguan Wenxuan clothing Co.,Ltd (Michael)", vendorId: "1359290" },
};
const KNOWN_STATUSES = ["pending", "On Order", "In transit", "Ready to Ship", "closed", "canceled"];

function row(over: Partial<SourceRow>): SourceRow {
  return {
    poNumber: "PO1", productSku: "WD-1", title: "ATHENA TOP", size: "M",
    supplier: "SANDRA", variantSku: "WD-1-95", quantity: 10, factoryCost: 8, sourceRow: 2, ...over,
  };
}

describe("status matching", () => {
  it("defaults to 'pending' when there is no status column", () => {
    const r = convertRows([row({})], VENDOR_MAP, { knownStatuses: KNOWN_STATUSES });
    expect(r.pos[0].status).toBe("pending");
    expect(r.pos[0].statusResolved).toBe(true);
  });

  it("matches a typed status case-insensitively to the canonical name", () => {
    const r = convertRows([row({ status: "on order" })], VENDOR_MAP, { knownStatuses: KNOWN_STATUSES });
    expect(r.pos[0].status).toBe("On Order"); // canonical casing
    expect(r.pos[0].statusResolved).toBe(true);
  });

  it("leaves status blank + unresolved when the typed value has no match", () => {
    const r = convertRows([row({ status: "in the sea" })], VENDOR_MAP, { knownStatuses: KNOWN_STATUSES });
    expect(r.pos[0].status).toBe("");
    expect(r.pos[0].statusResolved).toBe(false);
    expect(r.pos[0].statusSource).toBe("in the sea");
  });

  it("honours a per-PO status override", () => {
    const r = convertRows([row({ status: "garbage" })], VENDOR_MAP, {
      knownStatuses: KNOWN_STATUSES,
      statusByPo: { PO1: "Ready to Ship" },
    });
    expect(r.pos[0].status).toBe("Ready to Ship");
    expect(r.pos[0].statusResolved).toBe(true);
  });

  it("writes the resolved status into the CSV Status column", () => {
    const r = convertRows([row({ status: "in transit" })], VENDOR_MAP, { knownStatuses: KNOWN_STATUSES });
    const dataRow = r.csv.split(/\r?\n/)[1];
    expect(dataRow).toContain("In transit");
  });
});

describe("stripSizeSuffix (dedupe product names across sizes)", () => {
  it("strips the trailing size, keeping the colour", () => {
    const base = "ATHENA CREW NECK RACER JERSEY BODYSUIT | BABY PINK";
    expect(stripSizeSuffix(`${base} XXS`)).toBe(base);
    expect(stripSizeSuffix(`${base} XS`)).toBe(base);
    expect(stripSizeSuffix(`${base} M`)).toBe(base);
    expect(stripSizeSuffix(`${base} XL`)).toBe(base);
  });
  it("collapses all sizes of one product to a single name", () => {
    const base = "HERA WRAP MINI DRESS | BLACK";
    const names = ["XXS", "XS", "S", "M", "L", "XL"].map((s) => stripSizeSuffix(`${base} ${s}`));
    expect([...new Set(names)]).toEqual([base]);
  });
  it("leaves a name with no trailing size untouched", () => {
    expect(stripSizeSuffix("SELENE TOP | CHOCOLATE")).toBe("SELENE TOP | CHOCOLATE");
  });
});

describe("size fallback from variant SKU", () => {
  it("uses the Size column when present", () => {
    const r = convertRows([row({ size: "M", variantSku: "WD-1-95" })], VENDOR_MAP);
    expect(r.pos[0].lines[0].size).toBe("M");
  });
  it("derives size from the SKU's numeric suffix when no Size column", () => {
    const r = convertRows([row({ size: "", variantSku: "WD-000543-196-98" })], VENDOR_MAP);
    expect(r.pos[0].lines[0].size).toBe("XXS"); // 98 → XXS
  });
  it("leaves size blank when the suffix isn't a known code", () => {
    const r = convertRows([row({ size: "", variantSku: "WD-1-ABC" })], VENDOR_MAP);
    expect(r.pos[0].lines[0].size).toBe("");
  });
});

describe("push-builder", () => {
  const rows = [
    row({ poNumber: "PO1", variantSku: "WD-1-95", quantity: 20, factoryCost: 8, status: "On Order" }),
    row({ poNumber: "PO1", variantSku: "WD-1-94", quantity: 30, factoryCost: 8, status: "On Order" }),
  ];
  const result = convertRows(rows, VENDOR_MAP, { knownStatuses: KNOWN_STATUSES });
  const inputs = buildPurchaseOrderInputs(result.pos, { warehouseId: "WH123", poDate: "2026-06-20" });

  it("produces one input per PO with all required fields", () => {
    expect(inputs).toHaveLength(1);
    const po = inputs[0];
    expect(po.po_number).toBe("PO1");
    expect(po.warehouse_id).toBe("WH123");
    expect(po.vendor_id).toBe("1359289");
    expect(po.fulfillment_status).toBe("On Order");
    expect(po.subtotal).toBe("400.00"); // 20*8 + 30*8
    expect(po.total_price).toBe("400.00");
    expect(po.shipping_price).toBe("0.00");
  });

  it("builds line items with the required weight + int quantity + sell_ahead", () => {
    const li = buildPurchaseOrderInputs(result.pos, { warehouseId: "WH123" })[0].line_items;
    expect(li).toHaveLength(2);
    expect(li[0]).toMatchObject({
      sku: "WD-1-95",
      vendor_sku: "WD-1-95",
      quantity: 20,
      price: "8.00",
      expected_weight_in_lbs: "0",
      sell_ahead: 0,
    });
    expect(typeof li[0].quantity).toBe("number");
  });

  it("isPushable() blocks POs with unresolved status or vendor", () => {
    const bad = convertRows([row({ supplier: "GHOST", status: "On Order" })], VENDOR_MAP, {
      knownStatuses: KNOWN_STATUSES,
    });
    expect(isPushable(bad.pos[0])).toBe(false); // unmapped vendor

    const noStatus = convertRows([row({ status: "nope" })], VENDOR_MAP, { knownStatuses: KNOWN_STATUSES });
    expect(isPushable(noStatus.pos[0])).toBe(false); // unresolved status

    const good = convertRows([row({ status: "On Order" })], VENDOR_MAP, { knownStatuses: KNOWN_STATUSES });
    expect(isPushable(good.pos[0])).toBe(true);
  });
});
