import { db } from "@/db";
import { poDateLog } from "@/db/schema";
import { desc, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

// GET /api/po/date-log?po=PO510 — app-side audit trail of date changes for one PO
// (from bulk amend, paste-revisions, upload or the drawer). Local DB only.
export async function GET(req: Request) {
  const po = new URL(req.url).searchParams.get("po")?.trim();
  if (!po) return Response.json({ error: "po is required." }, { status: 400 });
  const rows = await db
    .select()
    .from(poDateLog)
    .where(eq(poDateLog.poNumber, po))
    .orderBy(desc(poDateLog.changedAt))
    .limit(50);
  return Response.json({ log: rows });
}
