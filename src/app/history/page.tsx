import { hasShipheroCredential } from "@/lib/shiphero/client";
import { listPoStatuses } from "@/lib/vendors";
import { getSizeMap } from "@/lib/size-codes";
import { PoHistory } from "@/components/po-history";

export const dynamic = "force-dynamic";

export default async function HistoryPage() {
  const [statuses, sizeMap] = await Promise.all([listPoStatuses(), getSizeMap()]);
  return <PoHistory shipheroConnected={hasShipheroCredential()} statuses={statuses.map((s) => s.name)} sizeMap={sizeMap} />;
}
