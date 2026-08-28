import ExcelJS from "exceljs";
import { getCachedSummaries } from "@/lib/po-cache";
import { TEMPLATE_HEADERS } from "@/lib/po-dates-sheet";

export const dynamic = "force-dynamic";

// GET /api/po/dates-template → .xlsx the team fills in and uploads / pastes
// into "Amend dates". Example rows use real open PO numbers from the cache so
// it's obvious what goes where. Local cache only — 0 ShipHero credits.
export async function GET() {
  const { pos } = await getCachedSummaries();
  const examples = pos
    .filter((p) => !/close|cancel|deliver/i.test(p.status) && p.poNumber)
    .sort((a, b) => (b.poDate ?? "").localeCompare(a.poDate ?? ""))
    .slice(0, 3);

  const wb = new ExcelJS.Workbook();
  wb.creator = "Wander Doll Product Tools";
  const ws = wb.addWorksheet("PO dates");
  ws.columns = [
    { header: TEMPLATE_HEADERS[0], key: "po", width: 16 },
    { header: TEMPLATE_HEADERS[1], key: "sent", width: 16 },
    { header: TEMPLATE_HEADERS[2], key: "exf", width: 16 },
    { header: TEMPLATE_HEADERS[3], key: "del", width: 22 },
  ];
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: "FFFFFFFF" } };
  head.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF4F46E5" } };
  head.alignment = { vertical: "middle" };
  head.height = 20;

  const today = new Date();
  const plus = (d: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + d);
  const rows = examples.length ? examples : [{ poNumber: "PO471" }, { poNumber: "PO472" }, { poNumber: "PO473" }];
  rows.forEach((p, i) => {
    // Show each of the three ways a row can be filled in.
    const r = ws.addRow(i === 0 ? { po: p.poNumber, sent: plus(-40), exf: plus(10), del: plus(38) } : i === 1 ? { po: p.poNumber, exf: plus(14), del: plus(42) } : { po: p.poNumber, del: plus(21) });
    for (const k of ["sent", "exf", "del"]) r.getCell(k).numFmt = "dd/mm/yyyy";
  });
  for (let i = 0; i < 20; i++) { const r = ws.addRow({}); for (const k of ["sent", "exf", "del"]) r.getCell(k).numFmt = "dd/mm/yyyy"; }
  ws.views = [{ state: "frozen", ySplit: 1 }];

  const how = wb.addWorksheet("How to");
  how.columns = [{ width: 110 }];
  [
    "How to use this sheet",
    "",
    "1. One row per PO. Column A is the PO number exactly as it appears in the app (e.g. PO510).",
    "2. Fill in only the dates that have changed — leave the others blank and they stay as they are.",
    "3. Delivery (Expected) is written to ShipHero's Expected Date. Order Sent and Ex-factory live in the app only.",
    "4. Dates as dd/mm/yyyy (21/06/2026). Excel date cells are fine too.",
    "5. Save, then in the app: Purchase Orders → Amend dates → Upload sheet (or copy the rows and paste).",
    "6. You'll see an old → new preview for every PO before anything is applied. Nothing is written until you confirm.",
    "",
    "Delete the example rows on the first sheet before uploading, or overwrite them with your own.",
  ].forEach((t, i) => { const r = how.addRow([t]); if (i === 0) r.font = { bold: true, size: 13 }; });

  const buffer = await wb.xlsx.writeBuffer();
  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="wander_doll_po_dates_template.xlsx"',
    },
  });
}
