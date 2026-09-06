import { hasShipheroCredential, ShipheroError } from "@/lib/shiphero/client";
import { applyBookIn } from "@/lib/shiphero/po-book-in";
import { getDraft, markBooked } from "@/lib/po-drafts";
import { RET_BINS } from "@/lib/po-scanner-types";

export const dynamic = "force-dynamic";

// POST /api/po-scanner/drafts/[id]/book-in { bin } — WRITES: receive everything
// outstanding on the LIVE PO into the chosen RET bin (verified per line), then
// close the PO. Only ever called from the user's explicit final Confirm.
// Re-runnable after a partial failure — deltas mean only what's still missing
// gets received/added.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!hasShipheroCredential()) {
    return Response.json({ error: "ShipHero isn't connected." }, { status: 400 });
  }
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Bad draft id." }, { status: 400 });
  try {
    const body = (await req.json().catch(() => ({}))) as { bin?: string };
    const bin = String(body.bin ?? "").toUpperCase().trim();
    if (!(RET_BINS as readonly string[]).includes(bin)) {
      return Response.json({ error: "Pick a returns bin (RET-01 … RET-08)." }, { status: 400 });
    }
    const draft = await getDraft(id);
    if (!draft) return Response.json({ error: "Draft not found." }, { status: 404 });
    if (draft.status === "draft") return Response.json({ error: "Push the PO to ShipHero first." }, { status: 400 });
    if (draft.status === "booked") return Response.json({ error: `${draft.poNumber} is already booked in.` }, { status: 400 });

    const result = await applyBookIn(draft, bin);
    // Only a fully-landed run marks the draft booked; a partial failure stays
    // "pushed" so Book-in can be re-run for the remainder.
    const updated = result.closed ? await markBooked(id, result) : draft;
    return Response.json({ result, draft: updated });
  } catch (err) {
    if (err instanceof ShipheroError) {
      const status = err.kind === "throttled" ? 429 : 502;
      return Response.json({ error: err.message, kind: err.kind }, { status });
    }
    return Response.json({ error: err instanceof Error ? err.message : "Book-in failed." }, { status: 500 });
  }
}
