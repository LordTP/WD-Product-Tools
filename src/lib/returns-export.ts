// Returns roll-up Excel export. Aggregates the cached RMAs for a date range
// into a styled workbook: a Summary sheet (one row per product) and a Detail
// sheet (per-product matrix of size rows × reason columns). Server-only
// (ExcelJS); values are on the Shopify basis (net of discounts, ex tax).

import ExcelJS from "exceljs";
import { listCachedReturns } from "@/lib/returns-cache";
import { productKey, sizeOf, isFaultyItem } from "@/lib/returns-types";
import { ukDate } from "@/lib/shiphero/dates";

const SIZE_ORDER = ["XXS", "XS", "S", "M", "L", "XL", "XXL", "XS-S", "S-M", "M-L", "L-XL", "ONE SIZE", "?"];
const INDIGO = "FF4F46E5";
const SLATE_100 = "FFF1F5F9";
const SLATE_200 = "FFE2E8F0";
const ROSE = "FFE11D48";

interface ProductAgg {
  key: string;
  returns: Set<string>;
  units: number;
  faulty: number;
  value: number;
  reasons: Map<string, number>;
  // size -> reason -> units (+ per-size totals/faulty)
  matrix: Map<string, { total: number; faulty: number; byReason: Map<string, number> }>;
}

export async function buildReturnsExport(opts: {
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
  includeLegacy: boolean;
}): Promise<{ buffer: Buffer; filename: string }> {
  const rows = await listCachedReturns();
  const fromIso = `${opts.from}T00:00:00`;
  const toIso = `${opts.to}T23:59:59`;
  const inRange = rows.filter(
    (r) => r.createdAt >= fromIso && r.createdAt <= toIso && (opts.includeLegacy || r.isV2),
  );

  const products = new Map<string, ProductAgg>();
  const globalReasons = new Map<string, number>();
  for (const r of inRange) {
    const factor = r.exVatFactor ?? 1 / 1.2;
    for (const it of r.items) {
      const key = productKey(it.productName || it.sku);
      const p = products.get(key) ?? {
        key, returns: new Set<string>(), units: 0, faulty: 0, value: 0,
        reasons: new Map(), matrix: new Map(),
      };
      const reason = (it.reason || r.reason || "Other").trim() || "Other";
      const size = sizeOf(it.productName || "");
      const faulty = isFaultyItem(it, r.reason);
      p.returns.add(r.id);
      p.units += it.quantity;
      p.value += it.quantity * it.price * factor;
      if (faulty) p.faulty += it.quantity;
      p.reasons.set(reason, (p.reasons.get(reason) ?? 0) + it.quantity);
      const m = p.matrix.get(size) ?? { total: 0, faulty: 0, byReason: new Map<string, number>() };
      m.total += it.quantity;
      if (faulty) m.faulty += it.quantity;
      m.byReason.set(reason, (m.byReason.get(reason) ?? 0) + it.quantity);
      p.matrix.set(size, m);
      products.set(key, p);
      globalReasons.set(reason, (globalReasons.get(reason) ?? 0) + it.quantity);
    }
  }

  const sorted = [...products.values()].sort((a, b) => b.units - a.units);
  // Reason columns: global order by volume, capped for readability.
  const reasonCols = [...globalReasons.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k).slice(0, 8);

  const wb = new ExcelJS.Workbook();
  wb.creator = "Wander Doll Product Tools";

  const thin = { style: "thin" as const, color: { argb: SLATE_200 } };
  const border = { top: thin, bottom: thin, left: thin, right: thin };
  const headerFill: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: INDIGO } };
  const bandFill: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: SLATE_100 } };

  // ---------- Summary sheet ----------
  const sum = wb.addWorksheet("Summary", { views: [{ state: "frozen", ySplit: 4 }] });
  sum.columns = [
    { width: 52 }, { width: 10 }, { width: 9 }, { width: 9 }, { width: 10 }, { width: 12 }, { width: 30 },
  ];
  sum.getCell("A1").value = "Returns roll-up";
  sum.getCell("A1").font = { bold: true, size: 16 };
  sum.getCell("A2").value = `${ukDate(opts.from)} → ${ukDate(opts.to)} · ${inRange.length} returns · values ex tax, net of discounts${opts.includeLegacy ? " · includes pre-Swap-v2 returns" : ""}`;
  sum.getCell("A2").font = { color: { argb: "FF64748B" }, size: 10 };
  const head = sum.getRow(4);
  head.values = ["Product", "Returns", "Units", "Faulty", "Faulty %", "Value £", "Top reason"];
  head.eachCell((c) => {
    c.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 10 };
    c.fill = headerFill;
    c.border = border;
    c.alignment = { vertical: "middle" };
  });
  sorted.forEach((p, i) => {
    const top = [...p.reasons.entries()].sort((a, b) => b[1] - a[1])[0];
    const row = sum.addRow([
      p.key, p.returns.size, p.units, p.faulty || "", p.units ? p.faulty / p.units : 0,
      Math.round(p.value), top ? `${top[0]} (${top[1]})` : "",
    ]);
    row.eachCell((c) => { c.border = border; c.font = { size: 10 }; });
    if (i % 2 === 1) row.eachCell((c) => { c.fill = bandFill; });
    row.getCell(5).numFmt = "0%";
    row.getCell(6).numFmt = "#,##0";
    if (p.faulty > 0) row.getCell(4).font = { size: 10, bold: true, color: { argb: ROSE } };
    if (p.units >= 5 && p.faulty / p.units >= 0.5) row.getCell(5).font = { size: 10, bold: true, color: { argb: ROSE } };
  });
  sum.autoFilter = { from: "A4", to: "G4" };

  // ---------- Detail sheet ----------
  const det = wb.addWorksheet("By product & size");
  det.columns = [{ width: 44 }, ...reasonCols.map(() => ({ width: 13 })), { width: 9 }, { width: 9 }, { width: 11 }];
  const lastCol = 1 + reasonCols.length + 3;
  det.getCell("A1").value = "Returns by product, size and reason";
  det.getCell("A1").font = { bold: true, size: 14 };
  det.getCell("A2").value = `${ukDate(opts.from)} → ${ukDate(opts.to)} — each block is one product; rows are sizes, columns are the customer's return reason.`;
  det.getCell("A2").font = { color: { argb: "FF64748B" }, size: 10 };

  let rowIdx = 4;
  for (const p of sorted) {
    // product band
    det.mergeCells(rowIdx, 1, rowIdx, lastCol);
    const band = det.getCell(rowIdx, 1);
    band.value = `${p.key}   —   ${p.units} units · ${p.returns.size} returns · £${Math.round(p.value).toLocaleString("en-GB")}${p.faulty ? ` · ${p.faulty} FAULTY` : ""}`;
    band.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
    band.fill = headerFill;
    band.alignment = { vertical: "middle" };
    det.getRow(rowIdx).height = 20;
    rowIdx++;

    // column headings
    const h = det.getRow(rowIdx);
    h.values = ["Size", ...reasonCols, "Total", "Faulty", "Value £"];
    h.eachCell((c) => {
      c.font = { bold: true, size: 9, color: { argb: "FF475569" } };
      c.fill = bandFill;
      c.border = border;
      c.alignment = { horizontal: "center" };
    });
    h.getCell(1).alignment = { horizontal: "left" };
    rowIdx++;

    const sizes = [...p.matrix.entries()].sort(
      (a, b) => SIZE_ORDER.indexOf(a[0]) - SIZE_ORDER.indexOf(b[0]),
    );
    for (const [size, m] of sizes) {
      const sizeValue = 0; // per-size value omitted; keep the sheet scannable
      void sizeValue;
      const r = det.getRow(rowIdx);
      r.values = [
        size,
        ...reasonCols.map((rc) => m.byReason.get(rc) || ""),
        m.total,
        m.faulty || "",
        "",
      ];
      r.eachCell((c) => { c.border = border; c.font = { size: 10 }; c.alignment = { horizontal: "center" }; });
      r.getCell(1).alignment = { horizontal: "left" };
      r.getCell(1).font = { size: 10, bold: true };
      if (m.faulty > 0) r.getCell(2 + reasonCols.length + 1).font = { size: 10, bold: true, color: { argb: ROSE } };
      rowIdx++;
    }
    // totals row
    const t = det.getRow(rowIdx);
    t.values = [
      "All sizes",
      ...reasonCols.map((rc) => p.reasons.get(rc) || ""),
      p.units,
      p.faulty || "",
      Math.round(p.value),
    ];
    t.eachCell((c) => {
      c.border = border;
      c.font = { size: 10, bold: true };
      c.alignment = { horizontal: "center" };
      c.fill = bandFill;
    });
    t.getCell(1).alignment = { horizontal: "left" };
    t.getCell(1 + reasonCols.length + 3).numFmt = "#,##0";
    rowIdx += 2; // blank spacer row between products
  }

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return { buffer, filename: `returns-rollup_${opts.from}_to_${opts.to}.xlsx` };
}
