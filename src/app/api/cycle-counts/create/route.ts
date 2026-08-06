import { hasShipheroCredential, ShipheroError } from "@/lib/shiphero/client";
import { createItemsCycleCount } from "@/lib/shiphero/cycle-counts";
import { logCreatedCount } from "@/lib/cycle-counts-log";
import { endOfTodayISO, dateInputToISO, type LowStockItem } from "@/lib/cycle-counts-derive";

export const dynamic = "force-dynamic";

// POST /api/cycle-counts/create { name, items: LowStockItem[], dueDate?, maxQty? }
// Creates an items cycle count in ShipHero from the chosen SKUs and logs it
// locally. dueDate is a YYYY-MM-DD string; if empty it defaults to today.
export async function POST(req: Request) {
  if (!hasShipheroCredential()) {
    return Response.json({ error: "ShipHero isn't connected." }, { status: 400 });
  }
  try {
    const body = await req.json().catch(() => ({}));
    const items: LowStockItem[] = Array.isArray(body.items) ? body.items : [];
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "";
    const maxQty = Number.isFinite(body.maxQty) ? Number(body.maxQty) : null;

    if (!name) return Response.json({ error: "Give the cycle count a name." }, { status: 400 });
    const skus = [...new Set(items.map((i) => String(i.sku)).filter(Boolean))];
    if (skus.length === 0) return Response.json({ error: "No SKUs selected for the count." }, { status: 400 });

    const dueDate =
      typeof body.dueDate === "string" && body.dueDate.trim()
        ? dateInputToISO(body.dueDate.trim())
        : endOfTodayISO();

    const batch = await createItemsCycleCount({ name, skus, dueDate });
    await logCreatedCount(batch, items, maxQty);

    return Response.json({ ok: true, count: { shipheroId: batch.id, name: batch.name, skuCount: skus.length } });
  } catch (err) {
    if (err instanceof ShipheroError) {
      const status = err.kind === "throttled" ? 429 : 502;
      return Response.json({ error: err.message, kind: err.kind }, { status });
    }
    return Response.json({ error: err instanceof Error ? err.message : "Create failed." }, { status: 500 });
  }
}
