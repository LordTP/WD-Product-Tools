CREATE TABLE `size_codes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`label` text NOT NULL,
	`code` text NOT NULL,
	`in_order` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `size_codes_label_unique` ON `size_codes` (`label`);