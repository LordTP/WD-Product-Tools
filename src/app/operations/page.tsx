import { hasShipheroCredential } from "@/lib/shiphero/client";
import { WarehouseActivity } from "@/components/warehouse-activity";

export const dynamic = "force-dynamic";

// "Operations" — the warehouse activity log (what's been received / moved /
// shipped and who did it). Reads a cached day; Generate pulls a day from ShipHero.
export default function OperationsPage() {
  return <WarehouseActivity shipheroConnected={hasShipheroCredential()} />;
}
