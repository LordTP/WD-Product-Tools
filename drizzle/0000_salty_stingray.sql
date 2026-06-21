CREATE TABLE `po_lines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`po_id` integer NOT NULL,
	`sku` text NOT NULL,
	`vendor_sku` text NOT NULL,
	`qty_ordered` integer NOT NULL,
	`qty_received` integer DEFAULT 0 NOT NULL,
	`unit_cost` text,
	`sell_ahead` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`po_id`) REFERENCES `purchase_orders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `purchase_orders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`po_number` text NOT NULL,
	`vendor_id` integer,
	`status` text DEFAULT 'pending' NOT NULL,
	`ship_date` text,
	`po_date` text,
	`notes` text,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	FOREIGN KEY (`vendor_id`) REFERENCES `shiphero_vendors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `shiphero_vendors` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`shiphero_id` text,
	`fob_gbp` integer DEFAULT false NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shiphero_vendors_name_unique` ON `shiphero_vendors` (`name`);--> statement-breakpoint
CREATE TABLE `vendor_aliases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`alias` text NOT NULL,
	`vendor_id` integer NOT NULL,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	FOREIGN KEY (`vendor_id`) REFERENCES `shiphero_vendors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vendor_aliases_alias_unique` ON `vendor_aliases` (`alias`);