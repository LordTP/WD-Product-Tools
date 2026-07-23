import { hasShipheroCredential } from "@/lib/shiphero/client";
import { getBinsSettings } from "@/lib/bins-cache";
import { ReturnsPickFaces } from "@/components/returns-pick-faces";

export const dynamic = "force-dynamic";

export default async function ReturnsPickFacesPage() {
  const settings = await getBinsSettings();
  return <ReturnsPickFaces shipheroConnected={hasShipheroCredential()} initialSettings={settings} />;
}
