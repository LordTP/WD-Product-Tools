import type { NewShipheroVendor } from "./schema";

// Canonical ShipHero vendors (spec §3). This is the dropdown source on the
// vendors page; Phase 2 will sync it from ShipHero's `vendors` query.
export const SHIPHERO_VENDOR_SEED: NewShipheroVendor[] = [
  { name: "Dongguan Jinfeng Apparel Co. Ltd (Sandra)", shipheroId: "1359289" },
  { name: "Dongguan Wenxuan clothing Co.,Ltd (Michael)", shipheroId: "1359290" },
  { name: "SJA Fashion Ltd - CN (Summa)", shipheroId: null, fobGbp: true },
  { name: "Wander Doll", shipheroId: "1309990" },
  { name: "Guangzhou K&C Fashion garment Co.,LTD (Lily)", shipheroId: "1359291" },
  { name: "Dongguan City Shengshi Garment Co.,Ltd (Evelyn)", shipheroId: "1359292" },
  { name: "SUZHOU ST.MARTIN GARMENT CO.,LTD (St Martin)", shipheroId: "1359293" },
  { name: "Guangzhou Weixin Garment Co.,Ltd (Janncy)", shipheroId: "1359294" },
  { name: "TONGXIANG ZEAN IMP. & EXP. TRADING CO.,LTD (Zean)", shipheroId: "1359392" },
  { name: "Dongguan Siyinghong Garment Co., Ltd (Maggie)", shipheroId: "1359399" },
  { name: "Limited Edition", shipheroId: "1363011" },
];

// Confirmed merch aliases (spec §3) → which ShipHero vendor name they point at.
// Other vendors are left unaliased so they show as available options to map to.
export const ALIAS_SEED: { alias: string; vendorName: string }[] = [
  { alias: "SANDRA", vendorName: "Dongguan Jinfeng Apparel Co. Ltd (Sandra)" },
  { alias: "MICHAEL", vendorName: "Dongguan Wenxuan clothing Co.,Ltd (Michael)" },
  { alias: "SUMMA", vendorName: "SJA Fashion Ltd - CN (Summa)" },
];

// Size label → numeric SKU code (spec §5.1). Editable on the Size Map page.
// inOrder=true entries form the canonical small→large range (sortOrder); the
// three brackets (inOrder=false) are valid single sizes but not in the range.
export const SIZE_CODE_SEED: { label: string; code: string; inOrder: boolean; sortOrder: number }[] = [
  { label: "XXXS", code: "99", inOrder: true, sortOrder: 0 },
  { label: "XXS", code: "98", inOrder: true, sortOrder: 1 },
  { label: "XS", code: "97", inOrder: true, sortOrder: 2 },
  { label: "S", code: "96", inOrder: true, sortOrder: 3 },
  { label: "M", code: "95", inOrder: true, sortOrder: 4 },
  { label: "L", code: "94", inOrder: true, sortOrder: 5 },
  { label: "XL", code: "93", inOrder: true, sortOrder: 6 },
  { label: "XXL", code: "92", inOrder: true, sortOrder: 7 },
  { label: "XXXL", code: "91", inOrder: true, sortOrder: 8 },
  { label: "XS-S", code: "90", inOrder: false, sortOrder: 20 },
  { label: "S-M", code: "89", inOrder: false, sortOrder: 21 },
  { label: "L-XL", code: "88", inOrder: false, sortOrder: 22 },
];

// ShipHero PO statuses (from the account's PO Statuses screen — no API to pull).
// Exact casing matters: it's sent verbatim as fulfillment_status.
export const STATUS_SEED: {
  name: string;
  isSystem?: boolean;
  includeInOnOrder?: boolean;
  includeInSellAhead?: boolean;
  sortOrder: number;
}[] = [
  { name: "pending", isSystem: true, sortOrder: 0 },
  { name: "Shipment Being Quoted", includeInOnOrder: true, sortOrder: 1 },
  { name: "Shipment Arranged", includeInOnOrder: true, sortOrder: 2 },
  { name: "On Order", includeInOnOrder: true, sortOrder: 3 },
  { name: "Ready to Ship", includeInOnOrder: true, sortOrder: 4 },
  { name: "In transit", includeInOnOrder: true, sortOrder: 5 },
  { name: "Delivered", includeInSellAhead: true, sortOrder: 6 },
  { name: "closed", isSystem: true, sortOrder: 7 },
  { name: "canceled", isSystem: true, sortOrder: 8 },
];
