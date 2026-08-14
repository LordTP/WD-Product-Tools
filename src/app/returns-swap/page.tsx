import { hasShipheroCredential } from "@/lib/shiphero/client";
import { getReturnsSettings } from "@/lib/returns";
import { Returns } from "@/components/returns";

export const dynamic = "force-dynamic";

export default async function ReturnsPage() {
  const settings = await getReturnsSettings();
  return <Returns shipheroConnected={hasShipheroCredential()} initialSettings={settings} />;
}
