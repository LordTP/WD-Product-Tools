CREATE TABLE `po_statuses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`is_system` integer DEFAULT false NOT NULL,
	`include_in_on_order` integer DEFAULT false NOT NULL,
	`include_in_sell_ahead` integer DEFAULT false NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `po_statuses_name_unique` ON `po_statuses` (`name`);