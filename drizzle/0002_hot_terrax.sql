CREATE TABLE `shiphero_po_cache` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`po_number` text NOT NULL,
	`legacy_id` text,
	`vendor_name` text,
	`status` text,
	`po_date` text,
	`total_price` text,
	`products` text,
	`lines` text,
	`header_synced_at` text,
	`lines_synced_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shiphero_po_cache_po_number_unique` ON `shiphero_po_cache` (`po_number`);