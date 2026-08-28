import { hasShipheroCredential } from "@/lib/shiphero/client";
import { PoUnreceive } from "@/components/po-unreceive";

export const dynamic = "force-dynamic";

// Purchase Orders → Un-receive: correct an over-received PO (counter + stock).
// Accepts ?po=PO510 (deep link from PO History) to open that PO immediately.
export default async function PoUnreceivePage({ searchParams }: { searchParams: Promise<{ po?: string }> }) {
  const { po } = await searchParams;
  return <PoUnreceive shipheroConnected={hasShipheroCredential()} initialPo={typeof po === "string" ? po : ""} />;
}
