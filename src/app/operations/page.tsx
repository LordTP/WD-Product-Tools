import { hasShipheroCredential } from "@/lib/shiphero/client";
import { getOpsStats } from "@/lib/ops-cache";
import { OperationsDashboard } from "@/components/operations-dashboard";

export const dynamic = "force-dynamic";

export default async function OperationsPage() {
  const stats = await getOpsStats();
  return <OperationsDashboard shipheroConnected={hasShipheroCredential()} initialStats={stats} />;
}
