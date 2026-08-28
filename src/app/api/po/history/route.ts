import { hasShipheroCredential } from "@/lib/shiphero/client";
import { pullPoHistory, type PoHistoryData } from "@/lib/shiphero/po-history";
import { db } from "@/db";
import { poDateLog, poHistoryCache, poUnreceiveLog } from "@/db/schema";
import { desc, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const STALE_MS = 15 * 60_000;

// GET /api/po/history?id=<global id>&po=PO510[&refresh=1]
// ShipHero receive/correction history (cached 15 min per PO) merged with the
// app's own date-change and un-receive logs. Read-only.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id")?.trim();
  const po = url.searchParams.get("po")?.trim() ?? "";
  const refresh = url.searchParams.get("refresh") === "1";
  if (!id) return Response.json({ error: "id is required." }, { status: 400 });

  const [dateLog, unreceiveLog] = await Promise.all([
    po ? db.select().from(poDateLog).where(eq(poDateLog.poNumber, po)).orderBy(desc(poDateLog.changedAt)).limit(100) : Promise.resolve([]),
    po ? db.select().from(poUnreceiveLog).where(eq(poUnreceiveLog.poNumber, po)).orderBy(desc(poUnreceiveLog.createdAt)).limit(100) : Promise.resolve([]),
  ]);

  let history: PoHistoryData | null = null;
  let cached = false;
  if (!refresh) {
    const row = (await db.select().from(poHistoryCache).where(eq(poHistoryCache.poId, id)).limit(1))[0];
    if (row && Date.now() - new Date(row.fetchedAt).getTime() < STALE_MS) {
      try { history = JSON.parse(row.data) as PoHistoryData; cached = true; } catch { history = null; }
    }
  }
  if (!history) {
    if (!hasShipheroCredential()) return Response.json({ error: "ShipHero isn't connected." }, { status: 400 });
    try {
      history = await pullPoHistory(id, unreceiveLog.map((r) => r.sku));
      await db
        .insert(poHistoryCache)
        .values({ poId: id, data: JSON.stringify(history), fetchedAt: history.fetchedAt })
        .onConflictDoUpdate({ target: poHistoryCache.poId, set: { data: JSON.stringify(history), fetchedAt: history.fetchedAt } });
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : "Couldn't read PO history." }, { status: 502 });
    }
  }
  return Response.json({ history, dateLog, unreceiveLog, cached });
}
