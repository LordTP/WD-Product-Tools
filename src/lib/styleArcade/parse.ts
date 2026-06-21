// Parse a Style Arcade .xlsx export. Server-only (exceljs). Sheet "style arcade"
// (lowercase) or the first sheet; row 0 = merchandiser notes (ignored), row 1 =
// headers, row 2+ = data (one row per product/colourway). Spec §2.1.

import ExcelJS from "exceljs";

export interface ParsedStyleArcade {
  sheetName: string;
  headers: string[];
  rows: string[][];
}

function cellToString(cell: unknown): string {
  if (cell == null) return "";
  if (typeof cell === "object") {
    const o = cell as Record<string, unknown>;
    if ("text" in o) return String(o.text ?? "");
    if ("result" in o) return String(o.result ?? "");
    if ("richText" in o && Array.isArray(o.richText)) return o.richText.map((r: { text?: string }) => r.text ?? "").join("");
    if ("hyperlink" in o) return String(o.hyperlink ?? "");
  }
  return String(cell);
}

export async function parseStyleArcade(buffer: Buffer): Promise<ParsedStyleArcade> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const ws = wb.worksheets.find((w) => w.name.trim().toLowerCase() === "style arcade") ?? wb.worksheets[0];
  if (!ws) throw new Error("No worksheet found in the file.");

  const matrix: string[][] = [];
  ws.eachRow({ includeEmpty: true }, (row) => {
    const raw = row.values as unknown[]; // 1-based with leading undefined
    const values: string[] = [];
    for (let i = 1; i < raw.length; i++) values.push(cellToString(raw[i]));
    matrix.push(values);
  });

  if (matrix.length < 2) throw new Error("Sheet has no header/data rows.");
  // row 0 = notes, row 1 = headers, row 2+ = data
  const headers = (matrix[1] ?? []).map((h) => h.trim());
  const rows = matrix.slice(2).filter((r) => r.some((c) => String(c ?? "").trim() !== ""));
  return { sheetName: ws.name, headers, rows };
}
