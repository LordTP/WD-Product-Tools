import { hasShipheroCredential, ShipheroError } from "@/lib/shiphero/client";
import { liveCheck } from "@/lib/shiphero/po-book-in";
import { getDraft } from "@/lib/po-drafts";

export const dynamic = "force-dynamic";

// GET /api/po-scanner/drafts/[id]/live — READ-ONLY: fetch the PO as ShipHero
// holds it right now + the diff against the draft, for the Book-in modal.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!hasShipheroCredential()) {
    return Response.json({ error: "ShipHero isn't connected." }, { status: 400 });
  }
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Bad draft id." }, { status: 400 });
  try {
    const draft = await getDraft(id);
    if (!draft) return Response.json({ error: "Draft not found." }, { status: 404 });
    const check = await liveCheck(draft);
    return Response.json({ check });
  } catch (err) {
    if (err instanceof ShipheroError) {
      const status = err.kind === "throttled" ? 429 : 502;
      return Response.json({ error: err.message, kind: err.kind }, { status });
    }
    return Response.json({ error: err instanceof Error ? err.message : "Live check failed." }, { status: 500 });
  }
}
