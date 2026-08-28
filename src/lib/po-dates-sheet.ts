// Turn a pasted block or an uploaded sheet into PO date changes. Client-safe.
//
// Two modes:
//  · columns   — the first row is a header ("PO Number | Order Sent | Ex-factory |
//                Delivery"): each date is read from its named column, blanks are
//                left alone. This is what the downloadable template produces.
//  · positional — no header: PO number followed by 1–3 dates in order
//                (delivery · ex-factory, delivery · order sent, ex-factory,
//                delivery). Blank cells are skipped, as before.

import { normalizeSheetDate } from "./shiphero/dates";

export interface DateRowInput {
  poNumber: string;
  orderSent?: string;
  exFactory?: string;
  delivery?: string;
}

export const TEMPLATE_HEADERS = ["PO Number", "Order Sent", "Ex-factory", "Delivery (Expected)"] as const;

/** Split pasted text (tab / comma / semicolon separated) into a cell grid. */
export function splitPaste(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .map((line) => line.split(/[\t,;]/).map((c) => c.trim()))
    .filter((cells) => cells.some((c) => c !== ""));
}

const looksLikeHeader = (cells: string[]) =>
  /^(po|purchase)/i.test((cells[0] ?? "").trim()) && cells.slice(1).some((c) => /date|sent|factory|deliver|expect|eta/i.test(c));

export function parseDateRows(grid: string[][]): { rows: DateRowInput[]; mode: "columns" | "positional" } {
  const rows: DateRowInput[] = [];
  if (!grid.length) return { rows, mode: "positional" };

  if (looksLikeHeader(grid[0])) {
    const head = grid[0].map((h) => h.toLowerCase());
    const col = (re: RegExp) => head.findIndex((h) => re.test(h));
    const iSent = col(/sent|placed|order date|ordered/);
    const iExf = col(/ex[\s-]*fac|exf/);
    const iDel = col(/deliver|expect|eta|arriv|due/);
    const pick = (cells: string[], i: number) => (i >= 0 && cells[i] ? normalizeSheetDate(cells[i]) : null);
    for (const cells of grid.slice(1)) {
      const poNumber = (cells[0] ?? "").trim();
      if (!poNumber) continue;
      const r: DateRowInput = { poNumber };
      const s = pick(cells, iSent), e = pick(cells, iExf), d = pick(cells, iDel);
      if (s) r.orderSent = s;
      if (e) r.exFactory = e;
      if (d) r.delivery = d;
      if (s || e || d) rows.push(r);
    }
    return { rows, mode: "columns" };
  }

  for (const cells of grid) {
    const trimmed = cells.filter((c) => c !== "");
    if (trimmed.length < 2) continue;
    const poNumber = trimmed[0];
    const dates = trimmed.slice(1).map((c) => normalizeSheetDate(c)).filter((d): d is string => d !== null);
    if (!dates.length) continue;
    const r: DateRowInput = { poNumber };
    if (dates.length === 1) r.delivery = dates[0];
    else if (dates.length === 2) [r.exFactory, r.delivery] = dates;
    else [r.orderSent, r.exFactory, r.delivery] = dates;
    rows.push(r);
  }
  return { rows, mode: "positional" };
}
