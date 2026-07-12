import { hasShipheroCredential, ShipheroError } from "@/lib/shiphero/client";
import { fetchReturns } from "@/lib/shiphero/returns-pull";
import { getReturnsSettings } from "@/lib/returns";

export const dynamic = "force-dynamic";

// GET /api/returns/list?from=ISO&to=ISO — read-only live pull of ShipHero returns
// created in the window. Filtering by status / date-to is done client-side so the
// page can show everything in range and highlight what will be exported.
export async function GET(req: Request) {
  if (!hasShipheroCredential()) {
    return Response.json({ error: "ShipHero isn't connected." }, { status: 400 });
  }
  try {
    const url = new URL(req.url);
    const from = url.searchParams.get("from") || new Date(Date.now() - 7 * 86_400_000).toISOString();
    const to = url.searchParams.get("to"); // optional upper bound on created_at

    let records = await fetchReturns(from);
    if (to) records = records.filter((r) => !r.createdAt || r.createdAt <= to);

    const settings = await getReturnsSettings();
    // Distinct statuses seen (for the status-filter dropdown).
    const statuses = [...new Set(records.map((r) => r.status).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b),
    );
    return Response.json({ returns: records, settings, statuses });
  } catch (err) {
    if (err instanceof ShipheroError) {
      const status = err.kind === "throttled" ? 429 : 502;
      return Response.json({ error: err.message, kind: err.kind }, { status });
    }
    return Response.json({ error: err instanceof Error ? err.message : "Failed to load returns." }, { status: 500 });
  }
}
