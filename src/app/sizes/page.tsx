import { listSizeCodes } from "@/lib/size-codes";
import { SizeManager } from "@/components/size-manager";

export const dynamic = "force-dynamic";

export default async function SizesPage() {
  const sizes = await listSizeCodes();
  return <SizeManager initialSizes={sizes} />;
}
