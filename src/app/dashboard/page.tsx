import { hasShipheroCredential } from "@/lib/shiphero/client";
import { getSizeMap } from "@/lib/size-codes";
import { Dashboard } from "@/components/dashboard";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const sizeMap = await getSizeMap();
  return <Dashboard shipheroConnected={hasShipheroCredential()} sizeMap={sizeMap} />;
}
