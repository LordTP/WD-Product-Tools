import { hasShipheroCredential } from "@/lib/shiphero/client";
import { PoUnreceive } from "@/components/po-unreceive";

export const dynamic = "force-dynamic";

// Purchase Orders → Un-receive: correct an over-received PO (counter + stock).
export default function PoUnreceivePage() {
  return <PoUnreceive shipheroConnected={hasShipheroCredential()} />;
}
