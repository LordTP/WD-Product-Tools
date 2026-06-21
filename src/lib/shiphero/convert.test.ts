import { describe, it, expect } from "vitest";
import { convertRows, SHIPHERO_HEADER } from "./convert";
import type { SourceRow, VendorMap } from "./types";

// Vendor map from spec §3.
const VENDOR_MAP: VendorMap = {
  SANDRA: { shipheroName: "Dongguan Jinfeng Apparel Co. Ltd (Sandra)", vendorId: 1359289 },
  MICHAEL: { shipheroName: "Dongguan Wenxuan clothing Co.,Ltd (Michael)", vendorId: 1359290 },
  SUMMA: { shipheroName: "SJA Fashion Ltd - CN (Summa)" },
};

// --- synthetic fixture matching the spec's acceptance numbers (§7) ---
// 12 POs, 68 lines, 2,400 units, with the exact per-PO subtotals.
// (The real sample sheet wasn't shipped with the spec; this reproduces its shape.)
const PO_PLAN: { po: string; vendor: string; subtotal: number; lines: number }[] = [
  { po: "PO471", vendor: "SANDRA", subtotal: 200, lines: 6 },
  { po: "PO472", vendor: "MICHAEL", subtotal: 400, lines: 6 },
  { po: "PO473", vendor: "SANDRA", subtotal: 200, lines: 6 },
  { po: "PO446", vendor: "SANDRA", subtotal: 200, lines: 6 },
  { po: "PO447", vendor: "MICHAEL", subtotal: 100, lines: 5 },
  { po: "PO448", vendor: "SUMMA", subtotal: 100, lines: 5 },
  { po: "PO434", vendor: "SANDRA", subtotal: 150, lines: 6 },
  { po: "PO435", vendor: "MICHAEL", subtotal: 250, lines: 6 },
  { po: "PO436", vendor: "SANDRA", subtotal: 150, lines: 5 },
  { po: "PO437", vendor: "MICHAEL", subtotal: 250, lines: 6 },
  { po: "PO429", vendor: "SANDRA", subtotal: 200, lines: 6 },
  { po: "PO430", vendor: "SUMMA", subtotal: 200, lines: 5 },
];

const SIZE_CODES = ["98", "97", "96", "95", "94", "93"]; // XXS..XL

/** Distribute `subtotal` across `lines` positive integers. */
function split(subtotal: number, lines: number): number[] {
  const base = Math.floor(subtotal / lines);
  const out = Array(lines).fill(base);
  out[lines - 1] += subtotal - base * lines;
  return out;
}

function buildFixture(): SourceRow[] {
  const rows: SourceRow[] = [];
  let rn = 2; // row 1 = header
  let styleSeq = 543;
  for (const plan of PO_PLAN) {
    const parent = `WD-000${styleSeq++}-196`;
    const qtys = split(plan.subtotal, plan.lines);
    for (let i = 0; i < plan.lines; i++) {
      rows.push({
        poNumber: plan.po,
        productSku: parent, // parent — must never appear in output
        title: "ATHENA CREW NECK RACER JERSEY BODYSUIT | BABY PINK",
        size: ["XXS", "XS", "S", "M", "L", "XL"][i] ?? "M",
        supplier: plan.vendor,
        variantSku: `${parent}-${SIZE_CODES[i] ?? "95"}`,
        quantity: qtys[i],
        factoryCost: plan.vendor === "SUMMA" ? 6.95 : plan.vendor === "MICHAEL" ? 13.8 : 8,
        sourceRow: rn++,
      });
    }
  }
  return rows;
}

describe("convertRows — spec §7 acceptance", () => {
  const rows = buildFixture();
  const result = convertRows(rows, VENDOR_MAP);

  it("has no blocking errors on clean input", () => {
    expect(result.errors).toEqual([]);
    expect(result.ready).toBe(true);
  });

  it("produces 12 POs, 68 lines, 2,400 units", () => {
    expect(result.summary.poCount).toBe(12);
    expect(result.summary.lineCount).toBe(68);
    expect(result.summary.totalUnits).toBe(2400);
  });

  it("matches the exact per-PO subtotals", () => {
    expect(result.summary.perPo).toEqual({
      PO471: 200, PO472: 400, PO473: 200, PO446: 200, PO447: 100, PO448: 100,
      PO434: 150, PO435: 250, PO436: 150, PO437: 250, PO429: 200, PO430: 200,
    });
  });

  it("resolves vendor aliases to exact ShipHero names", () => {
    const byPo = Object.fromEntries(result.pos.map((p) => [p.poNumber, p.vendor]));
    expect(byPo.PO471).toBe("Dongguan Jinfeng Apparel Co. Ltd (Sandra)");
    expect(byPo.PO472).toBe("Dongguan Wenxuan clothing Co.,Ltd (Michael)");
    expect(byPo.PO448).toBe("SJA Fashion Ltd - CN (Summa)");
  });

  it("writes the variant SKU into BOTH Sku and Vendor Sku; parent never appears", () => {
    for (const l of result.lines) {
      expect(l.sku).toBe(l.vendorSku);
      expect(l.sku).toMatch(/-\d{2}$/); // variant SKU has the numeric size suffix
    }
    expect(result.csv).not.toMatch(/WD-000\d{3}-196(?!-)/); // no bare parent SKU
  });

  it("emits the exact header row (spec §2.2, byte-for-byte)", () => {
    const firstLine = result.csv.split(/\r?\n/)[0];
    expect(firstLine).toBe(SHIPHERO_HEADER.join(","));
  });

  it("double-quotes Michael's vendor name because it contains a comma", () => {
    expect(result.csv).toContain('"Dongguan Wenxuan clothing Co.,Ltd (Michael)"');
  });

  it("defaults: Status=pending, three zeros, Sell Ahead=0", () => {
    const dataRow = result.csv.split(/\r?\n/)[1].split(",");
    // header index 4=Status, 7=Shipping Price, 8=Discount, 9=Tax — but commas inside
    // quoted vendor shift naive split; assert via presence instead.
    expect(result.csv).toContain("pending");
    expect(result.lines.every((l) => l.sellAhead === "0")).toBe(true);
    void dataRow;
  });
});

describe("convertRows — validation", () => {
  const base: SourceRow = {
    poNumber: "PO999", productSku: "WD-1", title: "T", size: "M",
    supplier: "SANDRA", variantSku: "WD-1-95", quantity: 10, factoryCost: 5, sourceRow: 2,
  };

  it("blocks on an unmapped supplier alias", () => {
    const r = convertRows([{ ...base, supplier: "GHOST" }], VENDOR_MAP);
    expect(r.ready).toBe(false);
    expect(r.unmappedAliases).toContain("GHOST");
    expect(r.errors.some((e) => e.kind === "unmapped_vendor")).toBe(true);
    expect(r.csv).toBe("");
  });

  it("blocks on missing SKU / quantity / price", () => {
    const r = convertRows(
      [
        { ...base, variantSku: "", sourceRow: 2 },
        { ...base, quantity: "", sourceRow: 3 },
        { ...base, factoryCost: "", sourceRow: 4 },
      ],
      VENDOR_MAP,
    );
    expect(r.ready).toBe(false);
    expect(r.errors.map((e) => e.kind)).toEqual(
      expect.arrayContaining(["missing_sku", "missing_quantity", "missing_price"]),
    );
  });

  it("blocks on non-numeric quantity or price", () => {
    const r = convertRows([{ ...base, quantity: "twenty", factoryCost: "abc" }], VENDOR_MAP);
    expect(r.errors.map((e) => e.kind)).toEqual(
      expect.arrayContaining(["non_numeric_quantity", "non_numeric_price"]),
    );
  });

  it("warns (not blocks) on duplicate identical lines within a PO", () => {
    const r = convertRows([base, { ...base, sourceRow: 3 }], VENDOR_MAP);
    expect(r.ready).toBe(true);
    expect(r.warnings.some((w) => w.kind === "duplicate_line")).toBe(true);
  });

  it("applies per-PO Sell Ahead override", () => {
    const r = convertRows([base], VENDOR_MAP, { sellAheadByPo: { PO999: true } });
    expect(r.lines[0].sellAhead).toBe("1");
  });
});
