// Vendor helpers. ShipHero vendors are the canonical reference list; aliases map
// short merch names onto them. Bridges both to the converter's VendorMap.

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { shipheroVendors, vendorAliases, poStatuses } from "@/db/schema";
import type { ShipheroVendor, PoStatus } from "@/db/schema";
import type { VendorMap } from "@/lib/shiphero/types";

export async function listPoStatuses(): Promise<PoStatus[]> {
  return db.select().from(poStatuses).where(eq(poStatuses.active, true)).orderBy(poStatuses.sortOrder);
}

export const normalizeAlias = (v: string): string => v.trim().toUpperCase();

/** An alias joined with the ShipHero vendor it points at. */
export interface AliasRow {
  id: number;
  alias: string;
  vendorId: number;
  name: string;
  shipheroId: string | null;
}

export async function listShipheroVendors(): Promise<ShipheroVendor[]> {
  return db.select().from(shipheroVendors).orderBy(shipheroVendors.name);
}

export async function listAliases(): Promise<AliasRow[]> {
  const rows = await db
    .select({
      id: vendorAliases.id,
      alias: vendorAliases.alias,
      vendorId: vendorAliases.vendorId,
      name: shipheroVendors.name,
      shipheroId: shipheroVendors.shipheroId,
    })
    .from(vendorAliases)
    .innerJoin(shipheroVendors, eq(vendorAliases.vendorId, shipheroVendors.id))
    .orderBy(vendorAliases.alias);
  return rows;
}

/** Build the converter's alias→vendor map. */
export async function getVendorMap(): Promise<VendorMap> {
  const rows = await listAliases();
  const map: VendorMap = {};
  for (const r of rows) {
    map[normalizeAlias(r.alias)] = { shipheroName: r.name, vendorId: r.shipheroId };
  }
  return map;
}

/** Create a ShipHero vendor (when not in the synced list yet). Returns its id. */
export async function addShipheroVendor(input: {
  name: string;
  shipheroId?: string | null;
  fobGbp?: boolean;
}): Promise<number> {
  const name = input.name.trim();
  const existing = await db
    .select()
    .from(shipheroVendors)
    .where(eq(shipheroVendors.name, name));
  if (existing[0]) return existing[0].id;
  const [created] = await db
    .insert(shipheroVendors)
    .values({ name, shipheroId: input.shipheroId?.trim() || null, fobGbp: input.fobGbp ?? false })
    .returning({ id: shipheroVendors.id });
  return created.id;
}

export async function setShipheroVendorFob(id: number, fobGbp: boolean): Promise<void> {
  await db.update(shipheroVendors).set({ fobGbp }).where(eq(shipheroVendors.id, id));
}

/** Map an alias onto a ShipHero vendor (insert or update). */
export async function upsertAlias(input: { alias: string; vendorId: number }): Promise<void> {
  const alias = normalizeAlias(input.alias);
  await db
    .insert(vendorAliases)
    .values({ alias, vendorId: input.vendorId })
    .onConflictDoUpdate({ target: vendorAliases.alias, set: { vendorId: input.vendorId } });
}

export async function deleteAlias(id: number): Promise<void> {
  await db.delete(vendorAliases).where(eq(vendorAliases.id, id));
}
