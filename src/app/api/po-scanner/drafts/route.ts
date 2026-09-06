import { createDraft, listDrafts } from "@/lib/po-drafts";

export const dynamic = "force-dynamic";

// GET /api/po-scanner/drafts — all scanner POs, newest first.
export async function GET() {
  try {
    return Response.json({ drafts: await listDrafts() });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to load drafts." }, { status: 500 });
  }
}

// POST /api/po-scanner/drafts { vendorId?, vendorName? } — new draft with an
// auto-generated PO-YYYYMMDD-NNNN number.
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { vendorId?: string; vendorName?: string };
    const draft = await createDraft({
      vendorId: typeof body.vendorId === "string" ? body.vendorId : null,
      vendorName: typeof body.vendorName === "string" ? body.vendorName : "",
    });
    return Response.json({ draft });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to create the draft." }, { status: 500 });
  }
}
