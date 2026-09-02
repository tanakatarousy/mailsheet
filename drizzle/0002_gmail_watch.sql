ALTER TABLE `google_connections` ADD `gmail_history_id` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `google_connections` ADD `gmail_watch_expires_at` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE INDEX `idx_google_connections_email` ON `google_connections` (`google_email`);
