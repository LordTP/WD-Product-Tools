import { getCachedSummaries, getCachedLinesByPo } from "@/lib/po-cache";
import { getSizeMap } from "@/lib/size-codes";
import { Calendar } from "@/components/calendar";

export const dynamic = "force-dynamic";

export default async function CalendarPage() {
  const [{ pos }, linesByPo, sizeMap] = await Promise.all([
    getCachedSummaries(),
    getCachedLinesByPo(),
    getSizeMap(),
  ]);
  // Lightweight per-PO search string: number + products + vendor + every SKU,
  // so "469", "azura" and a SKU fragment all match.
  const searchIndex: Record<string, string> = {};
  for (const p of pos) {
    const skus = (linesByPo[p.poNumber] ?? []).map((l) => l.sku).join(" ");
    searchIndex[p.poNumber] = `${p.poNumber} ${p.products.join(" ")} ${p.vendorName ?? ""} ${skus}`.toLowerCase();
  }
  return <Calendar pos={pos} searchIndex={searchIndex} sizeMap={sizeMap} />;
}
