import { hasShipheroCredential, ShipheroError } from "@/lib/shiphero/client";
import { applyUnreceive, type UnreceiveLine } from "@/lib/shiphero/po-unreceive";
import { db } from "@/db";
import { poUnreceiveLog } from "@/db/schema";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// POST /api/po/unreceive/apply { poId, poNumber, lines } — WRITES to ShipHero.
// Only ever called from the user's explicit Confirm on the Un-receive page.
export async function POST(req: Request) {
  if (!hasShipheroCredential()) return Response.json({ error: "ShipHero isn't connected." }, { status: 400 });
  try {
    const body = await req.json();
    const poId = String(body.poId ?? "");
    const poNumber = String(body.poNumber ?? "");
    const lines = (Array.isArray(body.lines) ? body.lines : []) as UnreceiveLine[];
    const clean = lines
      .map((l) => ({
        sku: String(l.sku ?? ""),
        unreceive: Math.max(0, Math.floor(Number(l.unreceive ?? 0))),
        stock: (Array.isArray(l.stock) ? l.stock : [])
          .map((s) => ({ locationId: String(s.locationId ?? ""), locationName: String(s.locationName ?? ""), qty: Math.max(0, Math.floor(Number(s.qty ?? 0))) }))
          .filter((s) => s.locationId && s.qty > 0),
      }))
      .filter((l) => l.sku && (l.unreceive > 0 || l.stock.length > 0));
    if (!poId || !clean.length) return Response.json({ error: "Nothing to apply." }, { status: 400 });
    if (clean.length > 100) return Response.json({ error: "Too many lines." }, { status: 400 });

    const results = await applyUnreceive(poId, poNumber, clean);
    const at = new Date().toISOString();
    for (const r of results) {
      const l = clean.find((x) => x.sku === r.sku);
      await db.insert(poUnreceiveLog).values({
        poNumber, sku: r.sku, unreceived: l?.unreceive ?? 0,
        stockRemoved: JSON.stringify(l?.stock ?? []), ok: r.ok ? 1 : 0, result: JSON.stringify(r), createdAt: at,
      });
    }
    return Response.json({ ok: results.every((r) => r.ok), results });
  } catch (err) {
    if (err instanceof ShipheroError) return Response.json({ error: err.message }, { status: err.kind === "throttled" ? 429 : 502 });
    return Response.json({ error: err instanceof Error ? err.message : "Apply failed." }, { status: 500 });
  }
}
