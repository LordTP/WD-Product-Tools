// Sheet-date normalisation for the PO upload. Merchandising sheets are UK-format
// (DD/MM/YYYY); xlsx date cells can also arrive as JS Dates (stringified) or raw
// Excel serial numbers. Everything normalises to YYYY-MM-DD or null.

const pad = (n: number) => String(n).padStart(2, "0");

export function normalizeSheetDate(raw: string | number | null | undefined): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;

  // Already ISO (possibly with a time part).
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  // UK D/M/YYYY (the sheet's native format). Two-digit years -> 20xx.
  const uk = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (uk) {
    const [, d, m, y] = uk;
    const year = y.length === 2 ? 2000 + Number(y) : Number(y);
    const day = Number(d), month = Number(m);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return `${year}-${pad(month)}-${pad(day)}`;
  }

  // Excel serial number (days since 1899-12-30). ~2009→2064 range guard.
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const serial = Number(s);
    if (serial > 40000 && serial < 60000) {
      const ms = (serial - 25569) * 86_400_000; // 25569 = days 1899-12-30 → 1970-01-01
      const d = new Date(ms);
      return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    }
  }

  // Stringified JS Date ("Wed Apr 29 2026 …") or anything else parseable.
  if (/[A-Za-z]/.test(s)) {
    const t = Date.parse(s);
    if (!Number.isNaN(t)) {
      const d = new Date(t);
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }
  }
  return null;
}

/** YYYY-MM-DD -> DD/MM/YYYY for display + the ShipHero PO note. */
export function ukDate(isoDay: string | null | undefined): string {
  if (!isoDay) return "";
  const m = isoDay.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : isoDay;
}

/** The auto-generated PO-note line carrying the dates ShipHero can't hold as fields. */
export function poDatesNote(dates: {
  orderSent?: string | null;
  exFactory?: string | null;
  delivery?: string | null;
}): string {
  const parts: string[] = [];
  if (dates.orderSent) parts.push(`Order sent ${ukDate(dates.orderSent)}`);
  if (dates.exFactory) parts.push(`Ex-factory ${ukDate(dates.exFactory)}`);
  if (dates.delivery) parts.push(`Delivery due ${ukDate(dates.delivery)}`);
  return parts.join(" · ");
}
