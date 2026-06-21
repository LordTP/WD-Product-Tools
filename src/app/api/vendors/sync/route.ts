import { hasShipheroCredential, ShipheroError } from "@/lib/shiphero/client";
import { syncVendorsFromShiphero } from "@/lib/shiphero/vendor-sync";
import { listShipheroVendors, listAliases } from "@/lib/vendors";

// POST /api/vendors/sync — pull canonical vendor names from ShipHero into our
// reference table, then return the refreshed lists for the UI.
export async function POST() {
  if (!hasShipheroCredential()) {
    return Response.json(
      { error: "ShipHero isn't connected yet. Add SHIPHERO_REFRESH_TOKEN to .env.local." },
      { status: 400 },
    );
  }
  try {
    const summary = await syncVendorsFromShiphero();
    const [shipheroVendors, aliases] = await Promise.all([
      listShipheroVendors(),
      listAliases(),
    ]);
    return Response.json({ ok: true, summary, shipheroVendors, aliases });
  } catch (err) {
    if (err instanceof ShipheroError) {
      const status = err.kind === "throttled" ? 429 : err.kind === "auth_failed" || err.kind === "no_token" ? 401 : 502;
      return Response.json({ error: err.message, kind: err.kind }, { status });
    }
    const message = err instanceof Error ? err.message : "Vendor sync failed.";
    return Response.json({ error: message }, { status: 500 });
  }
}
