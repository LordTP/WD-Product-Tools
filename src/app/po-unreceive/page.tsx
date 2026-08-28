import { hasShipheroCredential } from "@/lib/shiphero/client";
import { PoUnreceive } from "@/components/po-unreceive";
import { getSizeMap } from "@/lib/size-codes";

export const dynamic = "force-dynamic";

// Purchase Orders → Un-receive: correct an over-received PO (counter + stock).
// Accepts ?po=PO510 (deep link from PO History) to open that PO immediately.
export default async function PoUnreceivePage({ searchParams }: { searchParams: Promise<{ po?: string }> }) {
  const [{ po }, sizeMap] = await Promise.all([searchParams, getSizeMap()]);
  return <PoUnreceive shipheroConnected={hasShipheroCredential()} initialPo={typeof po === "string" ? po : ""} sizeMap={sizeMap} />;
}
