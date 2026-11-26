CREATE TABLE `umeda_work_items` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`status` text NOT NULL,
	`data` text NOT NULL,
	`revision` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `umeda_work_kind_idx` ON `umeda_work_items` (`kind`,`id`);--> statement-breakpoint
CREATE TABLE `umeda_work_record_items` (
	`request_id` text NOT NULL,
	`item_id` text NOT NULL,
	PRIMARY KEY(`request_id`, `item_id`),
	FOREIGN KEY (`request_id`) REFERENCES `umeda_work_records`(`request_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`item_id`) REFERENCES `umeda_work_items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `umeda_work_record_item_idx` ON `umeda_work_record_items` (`item_id`);--> statement-breakpoint
CREATE TABLE `umeda_work_records` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`request_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`data` text NOT NULL,
	`result` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `umeda_work_records_request_id_unique` ON `umeda_work_records` (`request_id`);