import { getSizeMap } from "@/lib/size-codes";
import { ProductConverter } from "@/components/product-converter";

export const dynamic = "force-dynamic";

export default async function ProductsPage() {
  const sizeMap = await getSizeMap();
  return <ProductConverter sizeMap={sizeMap} />;
}
