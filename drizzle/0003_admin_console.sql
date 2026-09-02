CREATE TABLE `app_users` (
	`email` text PRIMARY KEY NOT NULL,
	`role` text DEFAULT 'tester' NOT NULL,
	`status` text DEFAULT 'invited' NOT NULL,
	`invited_by` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_access_at` text DEFAULT '' NOT NULL,
	`access_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_app_users_status` ON `app_users` (`status`,`updated_at`);
--> statement-breakpoint
CREATE TABLE `access_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`email` text NOT NULL,
	`event_type` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_access_events_created` ON `access_events` (`created_at`);
--> statement-breakpoint
CREATE TABLE `system_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text DEFAULT '' NOT NULL,
	`event_type` text NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_system_events_type_created` ON `system_events` (`event_type`,`created_at`);
--> statement-breakpoint
ALTER TABLE `google_connections` ADD `last_gmail_notification_at` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `google_connections` ADD `last_watch_renewed_at` text DEFAULT '' NOT NULL;
