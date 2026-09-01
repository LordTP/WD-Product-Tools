import { cookies } from "next/headers";
import { BARCODES_COOKIE, isBarcodesAuthEnabled, isValidBarcodesToken } from "@/lib/barcodes-auth";
import { getBarcodeCatalog, syncBarcodeCatalog } from "@/lib/shiphero/barcode-catalog";
import { hasShipheroCredential, ShipheroError } from "@/lib/shiphero/client";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// GET /api/barcodes/products — the Label Press catalogue from the local cache.
// ?sync=1 re-pulls from ShipHero first (incremental; the first ever sync pages
// the whole product list). A missing catalogue triggers a first sync
// automatically so the page works out of the box. Read-only against ShipHero.
export async function GET(req: Request) {
  if (isBarcodesAuthEnabled()) {
    const token = (await cookies()).get(BARCODES_COOKIE)?.value;
    if (!isValidBarcodesToken(token)) return Response.json({ error: "auth" }, { status: 401 });
  }
  const wantSync = new URL(req.url).searchParams.get("sync") === "1";
  try {
    let catalog = wantSync || !(await getBarcodeCatalog()) ? null : await getBarcodeCatalog();
    if (!catalog) {
      if (!hasShipheroCredential()) return Response.json({ error: "ShipHero isn't connected and no catalogue is cached yet." }, { status: 503 });
      catalog = await syncBarcodeCatalog();
    }
    return Response.json({ products: catalog.products, syncedAt: catalog.syncedAt });
  } catch (err) {
    if (err instanceof ShipheroError) return Response.json({ error: err.message }, { status: err.kind === "throttled" ? 429 : 502 });
    return Response.json({ error: err instanceof Error ? err.message : "Couldn't load the catalogue." }, { status: 500 });
  }
}
