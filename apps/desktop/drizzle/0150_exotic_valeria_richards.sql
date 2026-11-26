CREATE TABLE `umeda_work_confirmed_items` (
	`id` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `umeda_work_outbox` (
	`request_id` text PRIMARY KEY NOT NULL,
	`envelope` text NOT NULL,
	`state` text NOT NULL,
	`local_order` integer NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `umeda_work_outbox_order_idx` ON `umeda_work_outbox` (`state`,`local_order`);--> statement-breakpoint
CREATE TABLE `umeda_work_sync_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
