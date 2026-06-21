import { hasShipheroCredential } from "@/lib/shiphero/client";
import { Dashboard } from "@/components/dashboard";

export const dynamic = "force-dynamic";

export default function DashboardPage() {
  return <Dashboard shipheroConnected={hasShipheroCredential()} />;
}
