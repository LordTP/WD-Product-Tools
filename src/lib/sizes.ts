// Shared size-code map (spec §5.1). The numeric suffix on a variant SKU encodes
// the size: WD-000543-196-98 → "98" → XXS. Used as a fallback to show the size in
// the PO preview when the upload has no Size column, and (later) by the Style
// Arcade → Shopify tool for SKU construction.

export const SIZE_CODE: Record<string, string> = {
  XXXL: "91",
  XXL: "92",
  XL: "93",
  L: "94",
  M: "95",
  S: "96",
  XS: "97",
  XXS: "98",
  XXXS: "99",
  "XS-S": "90",
  "S-M": "89",
  "L-XL": "88",
};

// reverse: code → size label
export const CODE_SIZE: Record<string, string> = Object.fromEntries(
  Object.entries(SIZE_CODE).map(([label, code]) => [code, label]),
);

// canonical small→large ordering, for expanding "A-B" size ranges (spec §5.2)
export const SIZE_ORDER = ["XXXS", "XXS", "XS", "S", "M", "L", "XL", "XXL", "XXXL"];

/** The size map can be overridden from the DB (admin Size Map page); functions
 *  default to the hardcoded values so tests + the PO side keep working. */
export interface SizeMap {
  codes: Record<string, string>; // label → numeric SKU code
  order: string[]; // canonical small→large (excludes brackets)
}
export const DEFAULT_SIZE_MAP: SizeMap = { codes: SIZE_CODE, order: SIZE_ORDER };

/** Expand a size-range string (e.g. "XXS-XL" → [XXS,XS,S,M,L,XL]). Spec §5.3:
 *  a whole bracket size ("XS-S") stays single; "A-B" with both in the canonical
 *  order → inclusive slice; otherwise the whole string is a single literal size. */
export function expandSizes(rng: string, map: SizeMap = DEFAULT_SIZE_MAP): string[] {
  const r = (rng ?? "").toUpperCase().replace(/\s+/g, "");
  if (!r) return [];
  if (r in map.codes && map.order.indexOf(r) === -1) return [r]; // bracket size like "XS-S"
  if (r.includes("-")) {
    const [a, b] = r.split("-", 2);
    const i = map.order.indexOf(a);
    const j = map.order.indexOf(b);
    if (i !== -1 && j !== -1) {
      const [lo, hi] = i <= j ? [i, j] : [j, i];
      return map.order.slice(lo, hi + 1);
    }
  }
  return [r]; // fallback: literal single size (caller may warn)
}

/** Derive a size label from a variant SKU's trailing numeric code, or "" if the
 *  last segment isn't a known size code. Uses the given map (default hardcoded). */
export function deriveSizeFromSku(sku: string, map: SizeMap = DEFAULT_SIZE_MAP): string {
  const last = sku.trim().split("-").pop() ?? "";
  if (map === DEFAULT_SIZE_MAP) return CODE_SIZE[last] ?? "";
  for (const [label, code] of Object.entries(map.codes)) if (code === last) return label;
  return "";
}

// ShipHero appends the size to a variant's product_name (e.g. "ATHENA … | BABY
// PINK XS"). Strip a trailing size token so size variants of one product dedupe
// to a single product name. Regex built from the size labels (longest first so
// XXS matches before XS/S), cached per map.
const escRe = (s: string) => s.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
const stripReCache = new WeakMap<SizeMap, RegExp>();
function stripRe(map: SizeMap): RegExp {
  let re = stripReCache.get(map);
  if (!re) {
    const labels = Object.keys(map.codes).sort((a, b) => b.length - a.length).map(escRe);
    re = new RegExp(`\\s+(${labels.join("|")})\\s*$`, "i");
    stripReCache.set(map, re);
  }
  return re;
}

export function stripSizeSuffix(name: string, map: SizeMap = DEFAULT_SIZE_MAP): string {
  return name.trim().replace(stripRe(map), "").trim();
}
