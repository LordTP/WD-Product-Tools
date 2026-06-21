// Size Map helpers — bridges the editable `size_codes` table to the converter's
// SizeMap shape. Used by the Products (Style Arcade) tool.

import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { sizeCodes } from "@/db/schema";
import type { SizeCode } from "@/db/schema";
import type { SizeMap } from "@/lib/sizes";

export async function listSizeCodes(): Promise<SizeCode[]> {
  return db.select().from(sizeCodes).orderBy(asc(sizeCodes.sortOrder), asc(sizeCodes.label));
}

/** Build the converter's SizeMap (label→code + canonical order) from the DB. */
export async function getSizeMap(): Promise<SizeMap> {
  const rows = await listSizeCodes();
  const codes: Record<string, string> = {};
  for (const r of rows) codes[r.label.toUpperCase()] = r.code;
  const order = rows
    .filter((r) => r.inOrder)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((r) => r.label.toUpperCase());
  return { codes, order };
}

export async function upsertSizeCode(input: {
  label: string;
  code: string;
  inOrder: boolean;
  sortOrder: number;
}): Promise<void> {
  const label = input.label.trim().toUpperCase();
  await db
    .insert(sizeCodes)
    .values({ label, code: input.code.trim(), inOrder: input.inOrder, sortOrder: input.sortOrder })
    .onConflictDoUpdate({
      target: sizeCodes.label,
      set: { code: input.code.trim(), inOrder: input.inOrder, sortOrder: input.sortOrder },
    });
}

export async function deleteSizeCode(id: number): Promise<void> {
  await db.delete(sizeCodes).where(eq(sizeCodes.id, id));
}
