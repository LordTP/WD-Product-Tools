// PO Scanner draft store: CRUD over the po_drafts table + PO numbering.
// Numbers follow the warehouse's established PO-YYYYMMDD-NNNN convention (from
// Will's app); "next free" checks BOTH our drafts and the ShipHero PO cache, so
// we can't collide with numbers the other app minted earlier today.

import { desc, eq, like } from "drizzle-orm";
import { db } from "@/db";
import { poDrafts, shipheroPoCache, type PoDraftRow } from "@/db/schema";
import type { BookInResult, DraftLine, DraftStatus, PoDraftDto } from "@/lib/po-scanner-types";
import { todayUkYmd } from "@/lib/uk-time";

function toDto(r: PoDraftRow): PoDraftDto {
  let lines: DraftLine[] = [];
  try { lines = JSON.parse(r.lines) as DraftLine[]; } catch { /* empty */ }
  let bookInResult: BookInResult | null = null;
  try { bookInResult = r.bookInResult ? (JSON.parse(r.bookInResult) as BookInResult) : null; } catch { /* empty */ }
  return {
    id: r.id,
    poNumber: r.poNumber,
    vendorId: r.vendorId,
    vendorName: r.vendorName ?? "",
    lines,
    status: (r.status as DraftStatus) ?? "draft",
    shipheroId: r.shipheroId,
    bookedBin: r.bookedBin,
    bookedAt: r.bookedAt,
    bookInResult,
    pushedAt: r.pushedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export async function listDrafts(): Promise<PoDraftDto[]> {
  const rows = await db.select().from(poDrafts).orderBy(desc(poDrafts.id));
  return rows.map(toDto);
}

export async function getDraft(id: number): Promise<PoDraftDto | null> {
  const [r] = await db.select().from(poDrafts).where(eq(poDrafts.id, id));
  return r ? toDto(r) : null;
}

/** PO-YYYYMMDD-NNNN — next free for today across drafts AND the ShipHero cache. */
export async function generatePoNumber(): Promise<string> {
  const prefix = `PO-${todayUkYmd().replaceAll("-", "")}-`;
  const [ours, cached] = await Promise.all([
    db.select({ n: poDrafts.poNumber }).from(poDrafts).where(like(poDrafts.poNumber, `${prefix}%`)),
    db.select({ n: shipheroPoCache.poNumber }).from(shipheroPoCache).where(like(shipheroPoCache.poNumber, `${prefix}%`)),
  ]);
  let max = 0;
  for (const { n } of [...ours, ...cached]) {
    const m = n.slice(prefix.length).match(/^(\d{1,6})$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}${String(max + 1).padStart(4, "0")}`;
}

export async function createDraft(input: { vendorId: string | null; vendorName: string }): Promise<PoDraftDto> {
  const now = new Date().toISOString();
  const poNumber = await generatePoNumber();
  const [r] = await db
    .insert(poDrafts)
    .values({
      poNumber,
      vendorId: input.vendorId,
      vendorName: input.vendorName,
      lines: "[]",
      status: "draft",
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return toDto(r);
}

/** Update lines/vendor on a DRAFT (pushed/booked rows are immutable app-side). */
export async function updateDraft(
  id: number,
  patch: { lines?: DraftLine[]; vendorId?: string | null; vendorName?: string },
): Promise<PoDraftDto | null> {
  const existing = await getDraft(id);
  if (!existing) return null;
  if (existing.status !== "draft") throw new Error(`${existing.poNumber} is already ${existing.status} — it can't be edited.`);
  const set: Partial<typeof poDrafts.$inferInsert> = { updatedAt: new Date().toISOString() };
  if (patch.lines) set.lines = JSON.stringify(patch.lines);
  if (patch.vendorId !== undefined) set.vendorId = patch.vendorId;
  if (patch.vendorName !== undefined) set.vendorName = patch.vendorName;
  const [r] = await db.update(poDrafts).set(set).where(eq(poDrafts.id, id)).returning();
  return r ? toDto(r) : null;
}

export async function deleteDraft(id: number): Promise<void> {
  const existing = await getDraft(id);
  if (!existing) return;
  if (existing.status !== "draft") throw new Error(`${existing.poNumber} is already ${existing.status} — it can't be deleted.`);
  await db.delete(poDrafts).where(eq(poDrafts.id, id));
}

export async function markPushed(id: number, shipheroId: string): Promise<PoDraftDto | null> {
  const now = new Date().toISOString();
  const [r] = await db
    .update(poDrafts)
    .set({ status: "pushed", shipheroId, pushedAt: now, updatedAt: now })
    .where(eq(poDrafts.id, id))
    .returning();
  return r ? toDto(r) : null;
}

export async function markBooked(id: number, result: BookInResult): Promise<PoDraftDto | null> {
  const now = new Date().toISOString();
  const [r] = await db
    .update(poDrafts)
    .set({ status: "booked", bookedBin: result.bin, bookedAt: result.at, bookInResult: JSON.stringify(result), updatedAt: now })
    .where(eq(poDrafts.id, id))
    .returning();
  return r ? toDto(r) : null;
}
