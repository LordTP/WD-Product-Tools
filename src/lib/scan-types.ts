// Client-safe types for the scan resolver (/api/scan/[code]).

import type { InventoryItem } from "@/lib/inventory-types";

export interface ScanBinContent {
  sku: string;
  title: string;
  size: string;
  qty: number;
}

export type ScanMatch =
  | { kind: "location"; name: string; productCount: number; units: number; contents: ScanBinContent[] }
  | { kind: "product"; item: InventoryItem };

export interface ScanResponse {
  code: string;
  normalized: string;
  matches: ScanMatch[];
}
