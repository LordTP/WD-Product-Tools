import { listShipheroVendors, listAliases } from "@/lib/vendors";

// Returns both the canonical ShipHero vendor list (dropdown source) and the
// current alias mappings.
export async function GET() {
  const [shipheroVendors, aliases] = await Promise.all([
    listShipheroVendors(),
    listAliases(),
  ]);
  return Response.json({ shipheroVendors, aliases });
}
