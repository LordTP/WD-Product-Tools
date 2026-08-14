import { hasShipheroCredential } from "@/lib/shiphero/client";
import { ReturnsDashboard } from "@/components/returns-dashboard";

export const dynamic = "force-dynamic";

// "Returns" — the Swap RMA dashboard (what's coming back, reasons, value, who's
// processing). Reads the local cache; Sync pulls from ShipHero.
// The old Swap QC export tool lives on (hidden) at /returns-swap.
export default function ReturnsPage() {
  return <ReturnsDashboard shipheroConnected={hasShipheroCredential()} />;
}
