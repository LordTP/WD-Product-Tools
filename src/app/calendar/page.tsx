import { getCachedSummaries, getCachedLinesByPo } from "@/lib/po-cache";
import { getSizeMap } from "@/lib/size-codes";
import { listAliases } from "@/lib/vendors";
import { Calendar } from "@/components/calendar";

export const dynamic = "force-dynamic";

export default async function CalendarPage() {
  const [{ pos }, linesByPo, sizeMap, aliases] = await Promise.all([
    getCachedSummaries(),
    getCachedLinesByPo(),
    getSizeMap(),
    listAliases(),
  ]);
  // Same visibility rule as PO History / Dashboard: drop zero-value POs and any
  // whose vendor isn't a mapped alias, so the calendar matches what's shown there.
  const mapped = new Set(aliases.map((a) => a.name.toLowerCase()));
  const visible = pos
    .filter((p) => p.totalPrice != null && p.totalPrice !== "" && Number(p.totalPrice) !== 0)
    .filter((p) => p.vendorName && mapped.has(p.vendorName.toLowerCase()));

  // Lightweight per-PO search string: number + products + vendor + every SKU,
  // so "469", "azura" and a SKU fragment all match.
  const searchIndex: Record<string, string> = {};
  for (const p of visible) {
    const skus = (linesByPo[p.poNumber] ?? []).map((l) => l.sku).join(" ");
    searchIndex[p.poNumber] = `${p.poNumber} ${p.products.join(" ")} ${p.vendorName ?? ""} ${skus}`.toLowerCase();
  }
  return <Calendar pos={visible} searchIndex={searchIndex} sizeMap={sizeMap} />;
}
