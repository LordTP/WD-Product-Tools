// PO Scanner Book-in — receive a pushed scanner PO into one RET bin and close
// it. Automates what the desk does by hand (manual PO → receive into RET-0x →
// status Closed). ShipHero is the source of truth throughout:
//  · liveCheck reads the LIVE PO by id and diffs it against the local draft —
//    the modal shows those diffs and books in what ShipHero holds, never the draft.
//  · applyBookIn WRITES: per line `purchase_order_update` quantity_received
//    +remaining (DELTA semantics — same call as Un-receive, positive) and
//    `inventory_add` into the chosen RET bin, each verified by re-read; then
//    the dedicated `purchase_order_close` mutation (introspected 6 Sep — the
//    UI-equivalent close, no line-status cascade). Deltas make a re-run after
//    a partial failure safe — only what's still missing gets added.
// The counter+stock split IS ShipHero's official API receiving workflow: the
// public schema has NO receive-PO-into-location mutation (confirmed by live
// introspection of all 128 mutations + developer.shiphero.com/purchase-orders).
// Only ever invoked from the user's explicit Confirm in the Book-in modal.

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { appState } from "@/db/schema";
import { shipheroGraphql } from "./client";
import { getWarehouseId } from "./warehouse";
import { poDetail } from "./po-unreceive";
import { resolveLocationByName, getSkuAtLocation } from "./bins-pull";
import { RET_BINS, type BookInLineResult, type BookInResult, type LivePoCheck, type PoDraftDto } from "@/lib/po-scanner-types";

const q1 = (s: string) => String(s ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const RET_IDS_KEY = "ret_bin_ids";

/** RET-01…08 name → location_id, resolved once and cached in app_state. */
async function resolveRetBinId(name: string): Promise<string> {
  if (!(RET_BINS as readonly string[]).includes(name)) throw new Error(`${name} isn't a RET bin.`);
  const [row] = await db.select().from(appState).where(eq(appState.key, RET_IDS_KEY));
  let ids: Record<string, string> = {};
  try { ids = row?.value ? (JSON.parse(row.value) as Record<string, string>) : {}; } catch { /* re-resolve */ }
  if (ids[name]) return ids[name];
  const warehouseId = await getWarehouseId();
  const loc = await resolveLocationByName(warehouseId, name);
  if (!loc) throw new Error(`ShipHero has no location named ${name}.`);
  ids[name] = loc.id;
  await db
    .insert(appState)
    .values({ key: RET_IDS_KEY, value: JSON.stringify(ids) })
    .onConflictDoUpdate({ target: appState.key, set: { value: JSON.stringify(ids) } });
  return loc.id;
}

/** READ-ONLY: fetch the live PO and diff it against the draft for the modal. */
export async function liveCheck(draft: PoDraftDto): Promise<LivePoCheck> {
  if (!draft.shipheroId) throw new Error("This PO hasn't been pushed to ShipHero yet.");
  const live = await poDetail(draft.shipheroId);

  const diffs: string[] = [];
  const draftBySku = new Map(draft.lines.map((l) => [l.sku, l]));
  const liveBySku = new Map(live.lines.map((l) => [l.sku, l]));
  for (const l of draft.lines) {
    const lv = liveBySku.get(l.sku);
    if (!lv) diffs.push(`${l.sku} is on your draft but NOT on the ShipHero PO`);
    else if (lv.ordered !== l.qty) diffs.push(`${l.sku}: you submitted ${l.qty}, ShipHero has ${lv.ordered}`);
  }
  for (const l of live.lines) {
    if (!draftBySku.has(l.sku)) diffs.push(`${l.sku} is on the ShipHero PO but wasn't on your draft`);
    if (l.received > 0) diffs.push(`${l.sku} already has ${l.received} received`);
  }
  if (live.status.trim().toLowerCase() === "closed") diffs.push("The PO is already marked Closed");

  return {
    poNumber: live.poNumber,
    status: live.status,
    lines: live.lines.map((l) => ({ sku: l.sku, productName: l.productName, ordered: l.ordered, received: l.received })),
    diffs,
  };
}

/** WRITES: receive everything outstanding into `bin`, verify, then close. */
export async function applyBookIn(draft: PoDraftDto, bin: string): Promise<BookInResult> {
  if (!draft.shipheroId) throw new Error("This PO hasn't been pushed to ShipHero yet.");
  const warehouseId = await getWarehouseId();
  const locationId = await resolveRetBinId(bin);
  const reason = `Booked in from ${draft.poNumber}`;

  // Book in what ShipHero holds RIGHT NOW — never the local draft.
  const live = await poDetail(draft.shipheroId);

  const readLineReceived = async (sku: string): Promise<number> => {
    const fresh = await poDetail(draft.shipheroId!);
    return fresh.lines.find((l) => l.sku === sku)?.received ?? NaN;
  };

  const results: BookInLineResult[] = [];
  let allOk = true;
  for (const line of live.lines) {
    const remaining = Math.max(0, line.ordered - line.received);
    const res: BookInLineResult = { sku: line.sku, qty: remaining, ok: true };
    if (remaining === 0) {
      results.push(res); // nothing outstanding (e.g. re-run after a partial failure)
      continue;
    }
    try {
      // a) receive counter: +remaining (delta)
      res.receivedBefore = line.received;
      await shipheroGraphql(
        `mutation U($data: UpdatePurchaseOrderInput!) { purchase_order_update(data: $data) { request_id } }`,
        { data: { po_id: draft.shipheroId, line_items: [{ sku: line.sku, quantity_received: remaining }] } },
      );
      res.receivedAfter = await readLineReceived(line.sku);
      if (res.receivedAfter !== line.received + remaining) res.ok = false;

      // b) stock into the RET bin
      const before = await getSkuAtLocation(warehouseId, line.sku, bin);
      res.binBefore = before?.quantity ?? 0;
      await shipheroGraphql(
        `mutation { inventory_add(data: { sku: "${q1(line.sku)}", warehouse_id: "${q1(warehouseId)}", quantity: ${Math.floor(remaining)}, location_id: "${q1(locationId)}", reason: "${q1(reason)}" }) { request_id } }`,
      );
      const after = await getSkuAtLocation(warehouseId, line.sku, bin);
      res.binAfter = after?.quantity ?? 0;
      if (res.binAfter !== res.binBefore + remaining) res.ok = false;
    } catch (err) {
      res.ok = false;
      res.error = err instanceof Error ? err.message : "Failed";
    }
    if (!res.ok) allOk = false;
    results.push(res);
  }

  // Close only when every line landed — a partial failure leaves the PO open so
  // Book-in can be re-run for the remainder (deltas make that safe).
  let closed = false;
  let closeError: string | undefined;
  if (allOk) {
    try {
      await shipheroGraphql(
        `mutation C($data: ClosePurchaseOrderInput!) { purchase_order_close(data: $data) { request_id } }`,
        { data: { po_id: draft.shipheroId } },
      );
      const check = await poDetail(draft.shipheroId);
      closed = check.status.trim().toLowerCase() === "closed";
      if (!closed) closeError = `Status is “${check.status}” after the close call.`;
    } catch (err) {
      closeError = err instanceof Error ? err.message : "Close failed.";
    }
  } else {
    closeError = "Not closed — some lines failed. Fix and re-run Book in.";
  }

  return { bin, lines: results, closed, closeError, at: new Date().toISOString() };
}
