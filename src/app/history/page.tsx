import { hasShipheroCredential } from "@/lib/shiphero/client";
import { listPoStatuses } from "@/lib/vendors";
import { getSizeMap } from "@/lib/size-codes";
import { PoHistory, type PoHistoryFilters } from "@/components/po-history";

export const dynamic = "force-dynamic";

const FILTER_KEYS = ["q", "view", "status", "late", "vendor", "win", "family", "missing", "over", "group", "sort"] as const;

// Purchase Orders home. Filters arrive in the query string so Back / shared
// links reopen the same view (see PoHistory for the keys).
export default async function HistoryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [statuses, sizeMap, sp] = await Promise.all([listPoStatuses(), getSizeMap(), searchParams]);
  const initialFilters: PoHistoryFilters = {};
  for (const k of FILTER_KEYS) { const v = sp[k]; if (typeof v === "string" && v) initialFilters[k] = v; }
  return <PoHistory shipheroConnected={hasShipheroCredential()} statuses={statuses.map((s) => s.name)} sizeMap={sizeMap} initialFilters={initialFilters} />;
}
