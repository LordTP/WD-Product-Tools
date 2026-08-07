import { hasShipheroCredential } from "@/lib/shiphero/client";
import { getOpsStats } from "@/lib/ops-cache";
import { OperationsDashboard } from "@/components/operations-dashboard";

export const dynamic = "force-dynamic";

// "Order Well" — the fulfilment snapshot (unfulfilled / ready-to-ship / blocked /
// shipped). Formerly the "Operations" page; renamed so "Operations" now means the
// warehouse activity log at /operations.
export default async function OrderWellPage() {
  const stats = await getOpsStats();
  return <OperationsDashboard shipheroConnected={hasShipheroCredential()} initialStats={stats} />;
}
