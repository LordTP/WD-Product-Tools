import type { Metadata } from "next";
import { BarcodePress } from "@/components/barcode-press";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Wander Doll · Label Press" };

// Standalone Barcode Label Press (replaces the Vercel wanderdoll-barcode-app):
// its own URL, its own password (BARCODES_PASSWORD), no product-tool chrome.
export default function BarcodesPage() {
  return <BarcodePress />;
}
