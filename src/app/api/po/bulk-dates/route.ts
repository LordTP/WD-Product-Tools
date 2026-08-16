import { hasShipheroCredential, ShipheroError } from "@/lib/shiphero/client";
import { editPurchaseOrder } from "@/lib/shiphero/po-edit";
import { getPoMutationId, getPoDetailCached } from "@/lib/po-cache";
import { getPoDates, savePoDates } from "@/lib/po-dates";
import { db } from "@/db";
import { poDateLog } from "@/db/schema";

export const dynamic = "force-dynamic";
// Each delivery change = 1 ShipHero write + 1 re-sync read; allow a big batch.
export const maxDuration = 300;

interface Change {
  poNumber: string;
  delivery?: string | null; // YYYY-MM-DD → ShipHero po_date ("Expected Date")
  exFactory?: string | null; // app-side only
  orderSent?: string | null; // app-side only
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (v: unknown): v is string => typeof v === "string" && DAY.test(v);

// POST /api/po/bulk-dates { changes: Change[] } — WRITES to ShipHero (po_date)
// for delivery changes; ex-factory/order-sent update the app-side store only.
// Every change is logged to po_date_log. Only ever called from the user's
// explicit Apply in the PO History bulk bar.
export async function POST(req: Request) {
  if (!hasShipheroCredential()) {
    return Response.json({ error: "ShipHero isn't connected." }, { status: 400 });
  }
  try {
    const body = await req.json();
    const changes = (Array.isArray(body.changes) ? body.changes : []) as Change[];
    const valid = changes.filter(
      (c) =>
        c.poNumber &&
        (validDay(c.delivery) || validDay(c.exFactory) || validDay(c.orderSent)),
    );
    if (!valid.length) return Response.json({ error: "No valid changes given." }, { status: 400 });
    if (valid.length > 200) return Response.json({ error: "Too many POs in one batch (max 200)." }, { status: 400 });

    const existing = await getPoDates(valid.map((c) => c.poNumber));
    const changedAt = new Date().toISOString();
    const results: Array<{ poNumber: string; ok: boolean; error?: string }> = [];

    for (const c of valid) {
      const prev = existing[c.poNumber] ?? {
        poNumber: c.poNumber,
        orderSent: null,
        exFactory: null,
        delivery: null,
      };
      try {
        // Delivery pushes to ShipHero as po_date, then that PO re-syncs so the
        // cache (and this page) reflect it immediately.
        if (validDay(c.delivery) && c.delivery !== prev.delivery) {
          const poId = await getPoMutationId(c.poNumber);
          if (!poId) throw new Error("PO not found in cache — run a sync first.");
          await editPurchaseOrder(poId, { poDate: c.delivery });
          await getPoDetailCached(c.poNumber, true).catch(() => null); // refresh is best-effort
        }

        const next = {
          poNumber: c.poNumber,
          orderSent: validDay(c.orderSent) ? c.orderSent : prev.orderSent,
          exFactory: validDay(c.exFactory) ? c.exFactory : prev.exFactory,
          delivery: validDay(c.delivery) ? c.delivery : prev.delivery,
        };
        await savePoDates([next]);

        for (const field of ["orderSent", "exFactory", "delivery"] as const) {
          if (next[field] !== prev[field]) {
            await db.insert(poDateLog).values({
              poNumber: c.poNumber,
              field,
              oldValue: prev[field],
              newValue: next[field],
              changedAt,
            });
          }
        }
        results.push({ poNumber: c.poNumber, ok: true });
      } catch (err) {
        results.push({
          poNumber: c.poNumber,
          ok: false,
          error: err instanceof Error ? err.message : "Update failed.",
        });
      }
    }
    return Response.json({
      ok: results.every((r) => r.ok),
      applied: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok),
      results,
    });
  } catch (err) {
    if (err instanceof ShipheroError) {
      const status = err.kind === "throttled" ? 429 : 502;
      return Response.json({ error: err.message, kind: err.kind }, { status });
    }
    return Response.json(
      { error: err instanceof Error ? err.message : "Bulk update failed." },
      { status: 500 },
    );
  }
}
