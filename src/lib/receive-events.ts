// Rolling log of "units arrived" moments — captured by the PO sync whenever a
// PO's received total increases between syncs. Powers the Un-receive landing's
// "booked in recently" feed. Stored as one JSON blob in app_state; capped and
// aged out so it never grows unbounded.

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { appState } from "@/db/schema";

const KEY = "po_receive_events";
const KEEP = 120;
const MAX_AGE_DAYS = 30;

export interface ReceiveEvent {
  poNumber: string;
  at: string; // ISO — the sync run that noticed the increase
  delta: number; // units newly received since the previous sync
  total: number; // received total after the increase
}

export async function readReceiveEvents(): Promise<ReceiveEvent[]> {
  const [r] = await db.select().from(appState).where(eq(appState.key, KEY));
  if (!r?.value) return [];
  try {
    return JSON.parse(r.value) as ReceiveEvent[];
  } catch {
    return [];
  }
}

/** Prepend new events (newest first), age out anything past 30 days. */
export async function recordReceiveEvents(events: ReceiveEvent[]): Promise<void> {
  if (!events.length) return;
  const cutoff = new Date(Date.now() - MAX_AGE_DAYS * 86_400_000).toISOString();
  const current = (await readReceiveEvents()).filter((e) => e.at >= cutoff);
  const next = [...events, ...current].slice(0, KEEP);
  await db
    .insert(appState)
    .values({ key: KEY, value: JSON.stringify(next) })
    .onConflictDoUpdate({ target: appState.key, set: { value: JSON.stringify(next) } });
}
