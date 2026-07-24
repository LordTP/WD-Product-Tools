import { hasShipheroCredential, ShipheroError } from "@/lib/shiphero/client";
import { getWarehouseId } from "@/lib/bins-cache";
import { resolveLocationByName, getSkuAtLocation, transferInventory } from "@/lib/shiphero/bins-pull";

export const dynamic = "force-dynamic";

interface SourcePlan {
  binName: string;
  locationId: string | null;
  liveQty: number; // current qty of the SKU in that bin, read fresh
}

// POST /api/bins/move
//   { sku, binNames: string[], destFace: string, confirm?: boolean }
// confirm=false (default): PREVIEW — re-reads live quantities + validates the
// destination, returns what WOULD move. No write.
// confirm=true: re-verifies again then runs one atomic inventory_transfer per
// source bin (moving that bin's CURRENT quantity — never a stale number), and
// reports a per-source result.
export async function POST(req: Request) {
  if (!hasShipheroCredential()) {
    return Response.json({ error: "ShipHero isn't connected." }, { status: 400 });
  }
  try {
    const body = await req.json().catch(() => ({}));
    const sku = typeof body.sku === "string" ? body.sku.trim() : "";
    const destFace = typeof body.destFace === "string" ? body.destFace.trim() : "";
    const binNames: string[] = Array.isArray(body.binNames) ? body.binNames.map(String) : [];
    const confirm = body.confirm === true;

    if (!sku) return Response.json({ error: "No SKU given." }, { status: 400 });
    if (!destFace) return Response.json({ error: "Choose a destination location." }, { status: 400 });
    if (binNames.length === 0) return Response.json({ error: "Tick at least one bin to move from." }, { status: 400 });

    // --- destination validation ---
    if (destFace.toUpperCase().startsWith("PICK-00")) {
      return Response.json({ error: "That's a returns bin — pick a proper pick face to consolidate into." }, { status: 400 });
    }
    if (binNames.some((b) => b === destFace)) {
      return Response.json({ error: "Source and destination are the same bin." }, { status: 400 });
    }

    const warehouseId = await getWarehouseId();
    const dest = await resolveLocationByName(warehouseId, destFace);
    if (!dest) return Response.json({ error: `Location "${destFace}" doesn't exist in ShipHero.` }, { status: 400 });
    if (!dest.pickable) return Response.json({ error: `"${destFace}" isn't a pickable location.` }, { status: 400 });

    const destCurrent = await getSkuAtLocation(warehouseId, sku, destFace);
    const destQtyBefore = destCurrent?.quantity ?? 0;

    // --- read each source live ---
    const sources: SourcePlan[] = [];
    for (const binName of binNames) {
      const at = await getSkuAtLocation(warehouseId, sku, binName);
      sources.push({ binName, locationId: at?.locationId ?? null, liveQty: at?.quantity ?? 0 });
    }
    const totalMove = sources.reduce((a, s) => a + Math.max(0, s.liveQty), 0);
    const warnings = sources
      .filter((s) => s.liveQty <= 0)
      .map((s) => `${s.binName} is now empty of this SKU — it'll be skipped.`);

    // --- PREVIEW ---
    if (!confirm) {
      return Response.json({
        preview: true,
        sku,
        dest: { face: dest.name, id: dest.id, currentQty: destQtyBefore, willBe: destQtyBefore + totalMove },
        sources: sources.map((s) => ({ binName: s.binName, liveQty: s.liveQty, movable: s.liveQty > 0 })),
        totalMove,
        warnings,
      });
    }

    // --- EXECUTE ---
    const results: { binName: string; moved: number; ok: boolean; error?: string }[] = [];
    for (const s of sources) {
      if (!s.locationId || s.liveQty <= 0) {
        results.push({ binName: s.binName, moved: 0, ok: false, error: "empty / not found at move time" });
        continue;
      }
      const r = await transferInventory({
        warehouseId,
        sku,
        quantity: s.liveQty,
        fromId: s.locationId,
        toId: dest.id,
        reason: "Returns consolidation · Product App",
      });
      results.push({ binName: s.binName, moved: r.ok ? s.liveQty : 0, ok: r.ok, error: r.error });
    }

    const movedTotal = results.reduce((a, r) => a + r.moved, 0);
    const failed = results.filter((r) => !r.ok);
    return Response.json({
      ok: failed.length === 0,
      sku,
      dest: { face: dest.name, qtyAfter: destQtyBefore + movedTotal },
      movedTotal,
      results,
    });
  } catch (err) {
    if (err instanceof ShipheroError) {
      const status = err.kind === "throttled" ? 429 : 502;
      return Response.json({ error: err.message, kind: err.kind }, { status });
    }
    return Response.json({ error: err instanceof Error ? err.message : "Move failed." }, { status: 500 });
  }
}
