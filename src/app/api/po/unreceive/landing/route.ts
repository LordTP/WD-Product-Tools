import { desc } from "drizzle-orm";
import { db } from "@/db";
import { poUnreceiveLog } from "@/db/schema";
import { getCachedSummaries } from "@/lib/po-cache";
import { readReceiveEvents } from "@/lib/receive-events";
import { getSizeMap } from "@/lib/size-codes";
import { deriveSizeFromSku } from "@/lib/sizes";

export const dynamic = "force-dynamic";

// GET /api/po/unreceive/landing — everything the Un-receive landing shows:
// recent booked-in POs (from the sync's receive-event log), the app's own
// correction history, and the headline stats. Local cache + log only — never
// calls ShipHero.

const CLOSED = new Set(["closed", "canceled", "cancelled"]);

export async function GET() {
  try {
    const [{ pos, lastSyncedAt }, events, logRows, sizeMap] = await Promise.all([
      getCachedSummaries(),
      readReceiveEvents(),
      db.select().from(poUnreceiveLog).orderBy(desc(poUnreceiveLog.id)).limit(12),
      getSizeMap(),
    ]);
    const byPo = new Map(pos.map((p) => [p.poNumber, p]));

    // Newest receive event per PO, joined to the cached summary.
    const seen = new Set<string>();
    const recent: Array<{ poNumber: string; at: string | null; delta: number | null; product: string; vendor: string | null; received: number; ordered: number }> = [];
    for (const e of events) {
      if (seen.has(e.poNumber)) continue;
      seen.add(e.poNumber);
      const p = byPo.get(e.poNumber);
      if (!p) continue;
      recent.push({ poNumber: e.poNumber, at: e.at, delta: e.delta, product: p.products[0] ?? "", vendor: p.vendorName, received: p.unitsReceived, ordered: p.unitsOrdered });
      if (recent.length >= 8) break;
    }
    // First deploys have no event history yet — pad with received-bearing POs
    // so the landing is never empty (marked at: null → "recently").
    if (recent.length < 5) {
      for (const p of pos) {
        if (recent.length >= 8) break;
        if (seen.has(p.poNumber) || p.unitsReceived <= 0 || CLOSED.has(p.status.trim().toLowerCase())) continue;
        seen.add(p.poNumber);
        recent.push({ poNumber: p.poNumber, at: null, delta: null, product: p.products[0] ?? "", vendor: p.vendorName, received: p.unitsReceived, ordered: p.unitsOrdered });
      }
    }

    const corrections = logRows.map((r) => ({
      poNumber: r.poNumber,
      sku: r.sku,
      size: deriveSizeFromSku(r.sku, sizeMap) || null,
      unreceived: r.unreceived,
      at: r.createdAt,
      ok: !!r.ok,
    }));

    const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const monthAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const weekEvents = events.filter((e) => e.at >= weekAgo);
    const over = pos.filter((p) => p.unitsOrdered > 0 && p.unitsReceived > p.unitsOrdered && !CLOSED.has(p.status.trim().toLowerCase()));
    const fixes30 = corrections.filter((c) => c.ok && c.at >= monthAgo);

    return Response.json({
      recent,
      corrections: corrections.slice(0, 6),
      stats: {
        weekPos: new Set(weekEvents.map((e) => e.poNumber)).size,
        weekUnits: weekEvents.reduce((a, e) => a + e.delta, 0),
        overCount: over.length,
        overUnits: over.reduce((a, p) => a + (p.unitsReceived - p.unitsOrdered), 0),
        fixes30: fixes30.length,
        fixUnits30: fixes30.reduce((a, c) => a + c.unreceived, 0),
        lastFix: corrections.find((c) => c.ok) ?? null,
      },
      lastSyncedAt,
    });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed." }, { status: 500 });
  }
}
