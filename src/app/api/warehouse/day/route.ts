import { getCachedDay } from "@/lib/warehouse-cache";

export const dynamic = "force-dynamic";

// GET /api/warehouse/day?date=YYYY-MM-DD — the cached day (instant, no credits).
// Returns { day: null } if that date hasn't been generated yet.
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const date = url.searchParams.get("date") || "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return Response.json({ error: "Give a date as YYYY-MM-DD." }, { status: 400 });
    }
    const day = await getCachedDay(date);
    return Response.json({ day });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to load." }, { status: 500 });
  }
}
