import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";

// Canonical ShipHero vendors — the reference list the merch team picks from.
// Seeded from spec §3; Phase 2 will sync this byte-for-byte from ShipHero's
// `vendors` query so names match character-for-character (spec §2.3 rule 4).
export const shipheroVendors = sqliteTable("shiphero_vendors", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // Exact ShipHero vendor name — must match ShipHero character-for-character.
  name: text("name").notNull().unique(),
  // ShipHero's own numeric vendor id, for reference / future API push.
  shipheroId: text("shiphero_id"),
  // Summa-style FOB suppliers price in GBP — used by the Products tool's cost
  // logic. Lives on the vendor since it's a property of the supplier.
  fobGbp: integer("fob_gbp", { mode: "boolean" }).notNull().default(false),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
});

// Short merch aliases ("SANDRA") mapping onto a canonical ShipHero vendor.
export const vendorAliases = sqliteTable("vendor_aliases", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // Canonical alias, stored UPPERCASE & trimmed.
  alias: text("alias").notNull().unique(),
  vendorId: integer("vendor_id")
    .notNull()
    .references(() => shipheroVendors.id, { onDelete: "cascade" }),
  createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
});

export type ShipheroVendor = typeof shipheroVendors.$inferSelect;
export type NewShipheroVendor = typeof shipheroVendors.$inferInsert;
export type VendorAlias = typeof vendorAliases.$inferSelect;

// Valid ShipHero PO statuses. ShipHero has no API to read these, so this is
// seeded from the account's PO Statuses screen and editable in-app. Used to
// match merch-typed statuses on upload and as the per-PO status dropdown.
export const poStatuses = sqliteTable("po_statuses", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // Exact status name as defined in ShipHero (sent verbatim as fulfillment_status).
  name: text("name").notNull().unique(),
  isSystem: integer("is_system", { mode: "boolean" }).notNull().default(false),
  includeInOnOrder: integer("include_in_on_order", { mode: "boolean" }).notNull().default(false),
  includeInSellAhead: integer("include_in_sell_ahead", { mode: "boolean" }).notNull().default(false),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
});

export type PoStatus = typeof poStatuses.$inferSelect;
export type NewPoStatus = typeof poStatuses.$inferInsert;

// Local cache of POs pulled from ShipHero, so the PO History page reads from the
// DB (instant, no API credits) instead of querying ShipHero on every view.
// Headers are synced in bulk (cheap); line items are lazy-cached per PO on first
// open. The Phase 3 webhook will keep quantity_received fresh.
export const shipheroPoCache = sqliteTable("shiphero_po_cache", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  poNumber: text("po_number").notNull().unique(),
  legacyId: text("legacy_id"), // ShipHero numeric id — for the cheap purchase_order(id:) detail query
  globalId: text("global_id"), // ShipHero base64 global id — for mutations (po_id)
  vendorName: text("vendor_name"),
  status: text("status"),
  poDate: text("po_date"),
  totalPrice: text("total_price"),
  products: text("products"), // JSON string[]
  lines: text("lines"), // JSON [{sku,productName,quantity,quantityReceived}] | null
  headerSyncedAt: text("header_synced_at"),
  linesSyncedAt: text("lines_synced_at"),
});

export type ShipheroPoCache = typeof shipheroPoCache.$inferSelect;

// Size label → numeric SKU code (e.g. XXS → 98), editable on the Size Map admin
// page. `inOrder` = part of the canonical small→large range (for expansion);
// brackets (XS-S, S-M, L-XL) are codes but not in the order.
export const sizeCodes = sqliteTable("size_codes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  label: text("label").notNull().unique(),
  code: text("code").notNull(),
  inOrder: integer("in_order", { mode: "boolean" }).notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
});

export type SizeCode = typeof sizeCodes.$inferSelect;

// --- Phase 2 (PO management) tables — defined now so the schema is additive,
// not yet written to by the Phase 1 converter (spec §5). ---
export const purchaseOrders = sqliteTable("purchase_orders", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  poNumber: text("po_number").notNull(),
  vendorId: integer("vendor_id").references(() => shipheroVendors.id),
  status: text("status").notNull().default("pending"),
  shipDate: text("ship_date"),
  poDate: text("po_date"),
  notes: text("notes"),
  createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
});

export const poLines = sqliteTable("po_lines", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  poId: integer("po_id")
    .notNull()
    .references(() => purchaseOrders.id, { onDelete: "cascade" }),
  sku: text("sku").notNull(),
  vendorSku: text("vendor_sku").notNull(),
  qtyOrdered: integer("qty_ordered").notNull(),
  qtyReceived: integer("qty_received").notNull().default(0),
  unitCost: text("unit_cost"),
  sellAhead: integer("sell_ahead", { mode: "boolean" }).notNull().default(false),
});
