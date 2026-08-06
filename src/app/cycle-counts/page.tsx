import { hasShipheroCredential } from "@/lib/shiphero/client";
import { CycleCounts } from "@/components/cycle-counts";

export const dynamic = "force-dynamic";

export default function CycleCountsPage() {
  return <CycleCounts shipheroConnected={hasShipheroCredential()} />;
}
