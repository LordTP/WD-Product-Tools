import { listShipheroVendors, listAliases } from "@/lib/vendors";
import { hasShipheroCredential } from "@/lib/shiphero/client";
import { VendorManager } from "@/components/vendor-manager";

export const dynamic = "force-dynamic";

export default async function VendorsPage() {
  const [shipheroVendors, aliases] = await Promise.all([
    listShipheroVendors(),
    listAliases(),
  ]);
  return (
    <VendorManager
      initialShipheroVendors={shipheroVendors}
      initialAliases={aliases}
      shipheroConnected={hasShipheroCredential()}
    />
  );
}
