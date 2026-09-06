import { db } from "@/db";
import { shipheroVendors } from "@/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

// GET /api/po-scanner/vendors — pickable vendors (active, with a ShipHero id,
// from the synced vendors table). "Wander Doll" is the scanner default client-side.
export async function GET() {
  try {
    const rows = await db.select().from(shipheroVendors).where(eq(shipheroVendors.active, true));
    const vendors = rows
      .filter((v) => v.shipheroId)
      .map((v) => ({ id: v.shipheroId!, name: v.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return Response.json({ vendors });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to load vendors." }, { status: 500 });
  }
}
