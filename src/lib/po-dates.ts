// App-side store for the PO dates ShipHero can't hold as fields. Delivery also
// lives in ShipHero as po_date ("Expected Date"); this table is the source for
// order-sent + ex-factory and feeds the PO History display / future bulk amend.

import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { poDates } from "@/db/schema";

export interface PoDatesInput {
  poNumber: string;
  orderSent: string | null;
  exFactory: string | null;
  delivery: string | null;
}

export async function savePoDates(entries: PoDatesInput[]): Promise<void> {
  const updatedAt = new Date().toISOString();
  for (const e of entries) {
    if (!e.poNumber || (!e.orderSent && !e.exFactory && !e.delivery)) continue;
    await db
      .insert(poDates)
      .values({ ...e, updatedAt })
      .onConflictDoUpdate({
        target: poDates.poNumber,
        set: { orderSent: e.orderSent, exFactory: e.exFactory, delivery: e.delivery, updatedAt },
      });
  }
}

export async function getPoDates(poNumbers: string[]): Promise<Record<string, PoDatesInput>> {
  if (!poNumbers.length) return {};
  const rows = await db.select().from(poDates).where(inArray(poDates.poNumber, poNumbers));
  const out: Record<string, PoDatesInput> = {};
  for (const r of rows) {
    out[r.poNumber] = {
      poNumber: r.poNumber,
      orderSent: r.orderSent,
      exFactory: r.exFactory,
      delivery: r.delivery,
    };
  }
  return out;
}
