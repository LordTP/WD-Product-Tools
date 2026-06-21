import {
  upsertAlias,
  deleteAlias,
  addShipheroVendor,
  listShipheroVendors,
  listAliases,
} from "@/lib/vendors";

async function payload() {
  const [shipheroVendors, aliases] = await Promise.all([
    listShipheroVendors(),
    listAliases(),
  ]);
  return { shipheroVendors, aliases };
}

// Map an alias onto a ShipHero vendor. Accepts either an existing `vendorId`, or
// a new vendor via `newVendorName` (+ optional `newVendorId`), which is created
// first then mapped.
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const alias = String(body.alias ?? "").trim();
    if (!alias) return Response.json({ error: "Alias is required." }, { status: 400 });

    let vendorId = body.vendorId ? Number(body.vendorId) : null;
    if (!vendorId && body.newVendorName) {
      vendorId = await addShipheroVendor({
        name: String(body.newVendorName),
        shipheroId: body.newVendorId ?? null,
      });
    }
    if (!vendorId) {
      return Response.json({ error: "Pick a ShipHero vendor or add a new one." }, { status: 400 });
    }

    await upsertAlias({ alias, vendorId });
    return Response.json({ ok: true, ...(await payload()) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to save mapping.";
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const body = await req.json();
    const id = Number(body.id);
    if (!id) return Response.json({ error: "Missing alias id." }, { status: 400 });
    await deleteAlias(id);
    return Response.json({ ok: true, ...(await payload()) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to delete alias.";
    return Response.json({ error: message }, { status: 500 });
  }
}
