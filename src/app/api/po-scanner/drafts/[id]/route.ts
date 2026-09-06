import { deleteDraft, getDraft, updateDraft } from "@/lib/po-drafts";
import type { DraftLine } from "@/lib/po-scanner-types";

export const dynamic = "force-dynamic";

const parseId = (s: string) => {
  const n = Number(s);
  return Number.isInteger(n) && n > 0 ? n : null;
};

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = parseId((await params).id);
  if (!id) return Response.json({ error: "Bad draft id." }, { status: 400 });
  const draft = await getDraft(id);
  if (!draft) return Response.json({ error: "Draft not found." }, { status: 404 });
  return Response.json({ draft });
}

// PATCH — autosaves from the builder (lines / vendor). Drafts only.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = parseId((await params).id);
  if (!id) return Response.json({ error: "Bad draft id." }, { status: 400 });
  try {
    const body = (await req.json()) as { lines?: DraftLine[]; vendorId?: string | null; vendorName?: string };
    const lines = Array.isArray(body.lines)
      ? body.lines
          .filter((l) => l && typeof l.sku === "string" && l.sku.trim())
          .map((l) => ({
            sku: String(l.sku).trim(),
            title: String(l.title ?? ""),
            size: String(l.size ?? ""),
            barcode: String(l.barcode ?? ""),
            qty: Math.max(1, Math.floor(Number(l.qty) || 1)),
          }))
      : undefined;
    const draft = await updateDraft(id, {
      lines,
      vendorId: body.vendorId !== undefined ? body.vendorId : undefined,
      vendorName: body.vendorName !== undefined ? String(body.vendorName) : undefined,
    });
    if (!draft) return Response.json({ error: "Draft not found." }, { status: 404 });
    return Response.json({ draft });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to save." }, { status: 400 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = parseId((await params).id);
  if (!id) return Response.json({ error: "Bad draft id." }, { status: 400 });
  try {
    await deleteDraft(id);
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to delete." }, { status: 400 });
  }
}
