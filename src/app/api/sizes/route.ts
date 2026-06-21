import { listSizeCodes, upsertSizeCode, deleteSizeCode } from "@/lib/size-codes";

export async function GET() {
  return Response.json({ sizes: await listSizeCodes() });
}

export async function POST(req: Request) {
  try {
    const b = await req.json();
    const label = String(b.label ?? "").trim();
    const code = String(b.code ?? "").trim();
    if (!label || !code) return Response.json({ error: "Label and code are required." }, { status: 400 });
    await upsertSizeCode({
      label,
      code,
      inOrder: Boolean(b.inOrder),
      sortOrder: Number(b.sortOrder) || 0,
    });
    return Response.json({ ok: true, sizes: await listSizeCodes() });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Save failed." }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const id = Number((await req.json()).id);
    if (!id) return Response.json({ error: "Missing id." }, { status: 400 });
    await deleteSizeCode(id);
    return Response.json({ ok: true, sizes: await listSizeCodes() });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Delete failed." }, { status: 500 });
  }
}
