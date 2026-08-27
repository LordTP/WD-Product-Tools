import { hasShipheroCredential, ShipheroError } from "@/lib/shiphero/client";
import { poDetail } from "@/lib/shiphero/po-unreceive";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// GET /api/po/unreceive/detail?id=<po id> — lines + live bin locations (read-only).
export async function GET(req: Request) {
  if (!hasShipheroCredential()) return Response.json({ error: "ShipHero isn't connected." }, { status: 400 });
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!id) return Response.json({ error: "Missing id." }, { status: 400 });
  try {
    return Response.json({ detail: await poDetail(id) });
  } catch (err) {
    if (err instanceof ShipheroError) return Response.json({ error: err.message }, { status: err.kind === "throttled" ? 429 : 502 });
    return Response.json({ error: err instanceof Error ? err.message : "Load failed." }, { status: 500 });
  }
}
