import { hasShipheroCredential, ShipheroError } from "@/lib/shiphero/client";
import { pushPurchaseOrders } from "@/lib/shiphero/push-api";
import type { PoGroup } from "@/lib/shiphero/types";

// POST /api/po/push { pos, poDate? } — creates POs in ShipHero. This is the only
// endpoint that WRITES. It runs solely from the user's "Confirm & push" action.
export async function POST(req: Request) {
  if (!hasShipheroCredential()) {
    return Response.json({ error: "ShipHero isn't connected." }, { status: 400 });
  }
  try {
    const body = await req.json();
    const pos = (body.pos ?? []) as PoGroup[];
    if (!Array.isArray(pos) || pos.length === 0) {
      return Response.json({ error: "No POs to push." }, { status: 400 });
    }
    const results = await pushPurchaseOrders(pos, { poDate: body.poDate });
    return Response.json({ results });
  } catch (err) {
    if (err instanceof ShipheroError) {
      const status = err.kind === "throttled" ? 429 : 502;
      return Response.json({ error: err.message, kind: err.kind }, { status });
    }
    return Response.json({ error: err instanceof Error ? err.message : "Push failed." }, { status: 500 });
  }
}
