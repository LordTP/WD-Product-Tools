import { hasShipheroCredential, ShipheroError } from "@/lib/shiphero/client";
import { runPreflight } from "@/lib/shiphero/push-api";
import type { PoGroup } from "@/lib/shiphero/types";

// POST /api/po/preflight { pos } — READ-ONLY checks before a push (warehouse,
// existing PO numbers, vendor/status validity). Does NOT create anything.
export async function POST(req: Request) {
  if (!hasShipheroCredential()) {
    return Response.json({ error: "ShipHero isn't connected." }, { status: 400 });
  }
  try {
    const body = await req.json();
    const pos = (body.pos ?? []) as PoGroup[];
    if (!Array.isArray(pos) || pos.length === 0) {
      return Response.json({ error: "No POs to check." }, { status: 400 });
    }
    const result = await runPreflight(pos);
    return Response.json(result);
  } catch (err) {
    if (err instanceof ShipheroError) {
      const status = err.kind === "throttled" ? 429 : 502;
      return Response.json({ error: err.message, kind: err.kind }, { status });
    }
    return Response.json({ error: err instanceof Error ? err.message : "Pre-flight failed." }, { status: 500 });
  }
}
