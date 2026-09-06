import { AppsHub } from "@/components/apps-hub";

export const dynamic = "force-dynamic";

// Warehouse → Apps: launcher hub for the floor tools (Scan, Inventory,
// PO Scanner, Label Press). ?app=scan deep-links straight into an app.
export default async function AppsPage({ searchParams }: { searchParams: Promise<{ app?: string }> }) {
  const { app } = await searchParams;
  return <AppsHub initialApp={typeof app === "string" ? app : ""} />;
}
