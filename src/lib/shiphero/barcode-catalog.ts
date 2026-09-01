// Barcode catalogue for the Label Press, built from ShipHero instead of the
// Google Sheet (which nobody reliably updates). ShipHero product names carry
// title + colour + size ("TIFFANY BUBBLE HEM MINI DRESS | BABY BLUE XS");
// size is re-derived from the SKU's size code (authoritative), and the PO is
// joined from the local PO cache — the most recent PO containing that SKU.
// Cached as one JSON blob in app_state; sync is incremental via updated_from.
// Read-only against ShipHero.

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { appState } from "@/db/schema";
import { shipheroGraphql } from "./client";
import { getCachedLinesByPo, getCachedSummaries } from "@/lib/po-cache";
import { getSizeMap } from "@/lib/size-codes";
import { deriveSizeFromSku, type SizeMap } from "@/lib/sizes";
import type { LabelProduct } from "@/lib/barcode-labels";

const KEY = "barcode_catalog";
const MAX_PAGES = 200;

export interface BarcodeCatalog {
  products: LabelProduct[];
  syncedAt: string;
}

export async function getBarcodeCatalog(): Promise<BarcodeCatalog | null> {
  const [r] = await db.select().from(appState).where(eq(appState.key, KEY));
  if (!r?.value) return null;
  try {
    return JSON.parse(r.value) as BarcodeCatalog;
  } catch {
    return null;
  }
}

const SIZE_TAIL = /\s+(XXS|XS|S|M|L|XL|XXL|2XL|3XL|UK\s?\d+|ONE SIZE|OS)$/i;

/** "TIFFANY BUBBLE HEM MINI DRESS | BABY BLUE XS" → title/colour/size fields. */
function deriveFields(sku: string, name: string, sizeMap: SizeMap): { title: string; colour: string; size: string } {
  const clean = String(name ?? "").trim();
  let size = deriveSizeFromSku(sku, sizeMap);
  const i = clean.indexOf("|");
  let base = i === -1 ? clean : clean.slice(0, i).trim();
  let colour = i === -1 ? "" : clean.slice(i + 1).trim();
  // The size usually rides on the end of the colour half (or the name itself).
  const tailHost = colour || base;
  const tail = tailHost.match(SIZE_TAIL)?.[1];
  if (tail) {
    if (colour) colour = colour.replace(SIZE_TAIL, "").trim();
    else base = base.replace(SIZE_TAIL, "").trim();
    if (!size) size = tail.toUpperCase();
  }
  const title = colour ? `${base} | ${colour}` : base;
  return { title, colour, size };
}

interface RawProduct { sku?: string; name?: string; barcode?: string | null; virtual?: boolean }

async function pageProducts(updatedFrom: string | null): Promise<RawProduct[]> {
  const out: RawProduct[] = [];
  let after: string | null = null;
  let pages = 0;
  // GraphQL rejects empty parens — omit the argument list entirely on a full pull.
  const filter = updatedFrom ? `(updated_from: "${updatedFrom.replace(/"/g, "")}")` : "";
  do {
    const afterArg: string = after ? `, after: "${after}"` : "";
    const query = `query { products${filter} { data(first: 100${afterArg}) { pageInfo { hasNextPage endCursor }
      edges { node { sku name barcode virtual } } } } }`;
    const { data } = await shipheroGraphql<{
      products?: { data?: { edges?: Array<{ node?: RawProduct }>; pageInfo?: { hasNextPage?: boolean; endCursor?: string } } };
    }>(query);
    const conn = data.products?.data;
    for (const e of conn?.edges ?? []) if (e.node) out.push(e.node);
    after = conn?.pageInfo?.hasNextPage ? (conn.pageInfo.endCursor ?? null) : null;
    pages += 1;
  } while (after && pages < MAX_PAGES);
  return out;
}

/** Latest REAL supplier PO per SKU from the local PO cache. Manual/utility POs
 *  (returns booking-ins, admin fixes — auto-named like "PO-20260619-0001",
 *  vendorless, or zero-value) must never end up on a garment label, so only
 *  vendor POs named like "PO463" count. No match = blank PO on the label. */
async function latestPoBySku(): Promise<Map<string, string>> {
  const [{ pos }, linesByPo] = await Promise.all([getCachedSummaries(), getCachedLinesByPo()]);
  const dated = pos
    .filter((p) => /^PO\d+$/i.test(p.poNumber.trim()) && Boolean(p.vendorName) && Number(p.totalPrice ?? 0) > 0)
    .map((p) => ({ poNumber: p.poNumber, date: p.poDate ?? "" }))
    .sort((a, b) => a.date.localeCompare(b.date)); // oldest → newest so newest overwrites
  const map = new Map<string, string>();
  for (const p of dated) {
    for (const l of linesByPo[p.poNumber] ?? []) map.set(l.sku, p.poNumber);
  }
  return map;
}

/** Pull products from ShipHero (incremental when a catalogue already exists),
 *  re-derive fields, re-join POs, and store. */
export async function syncBarcodeCatalog(): Promise<BarcodeCatalog> {
  const prev = await getBarcodeCatalog();
  // Overlap the incremental window by a day so nothing slips between syncs.
  const updatedFrom = prev?.syncedAt
    ? new Date(new Date(prev.syncedAt).getTime() - 24 * 3600_000).toISOString().slice(0, 10)
    : null;
  const [raw, sizeMap, poBySku] = await Promise.all([pageProducts(updatedFrom), getSizeMap(), latestPoBySku()]);

  const bySku = new Map<string, LabelProduct>((prev?.products ?? []).map((p) => [p.sku, p]));
  for (const r of raw) {
    const sku = String(r.sku ?? "").trim();
    const name = String(r.name ?? "").trim();
    if (!sku || !name || r.virtual) continue;
    const { title, colour, size } = deriveFields(sku, name, sizeMap);
    bySku.set(sku, { sku, title, colour, size, barcode: String(r.barcode ?? "").trim(), po: "" });
  }
  // POs re-applied to the whole set every sync — the PO cache moves independently.
  const products = [...bySku.values()].map((p) => ({ ...p, po: poBySku.get(p.sku) ?? "" }));
  products.sort((a, b) => a.title.localeCompare(b.title) || a.sku.localeCompare(b.sku));

  const catalog: BarcodeCatalog = { products, syncedAt: new Date().toISOString() };
  await db
    .insert(appState)
    .values({ key: KEY, value: JSON.stringify(catalog) })
    .onConflictDoUpdate({ target: appState.key, set: { value: JSON.stringify(catalog) } });
  return catalog;
}
