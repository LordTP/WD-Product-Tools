import { listShipheroVendors, listAliases, listPoStatuses } from "@/lib/vendors";
import { getSizeMap } from "@/lib/size-codes";
import { hasShipheroCredential } from "@/lib/shiphero/client";
import { PoConverter } from "@/components/po-converter";

export const dynamic = "force-dynamic";

export default async function PurchaseOrdersPage() {
  const [shipheroVendors, aliases, statuses, sizeMap] = await Promise.all([
    listShipheroVendors(),
    listAliases(),
    listPoStatuses(),
    getSizeMap(),
  ]);
  return (
    <PoConverter
      initialShipheroVendors={shipheroVendors}
      initialAliases={aliases}
      statuses={statuses.map((s) => s.name)}
      sizeMap={sizeMap}
      shipheroConnected={hasShipheroCredential()}
    />
  );
}
