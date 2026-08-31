import { hasShipheroCredential } from "@/lib/shiphero/client";
import { getOpsStats } from "@/lib/ops-cache";
import { OrderWell } from "@/components/order-well";

export const dynamic = "force-dynamic";

// "Order Well" — the fulfilment picture. ?tv=1 opens straight into the dark
// wallboard mode for the warehouse TV (keeps its own data warm).
export default async function OrderWellPage({ searchParams }: { searchParams: Promise<{ tv?: string }> }) {
  const [{ tv }, stats] = await Promise.all([searchParams, getOpsStats()]);
  return <OrderWell shipheroConnected={hasShipheroCredential()} initialStats={stats} initialTv={tv === "1"} />;
}
