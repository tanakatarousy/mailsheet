CREATE TABLE `public_visits` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`visitor_id` text NOT NULL,
	`path` text DEFAULT '/' NOT NULL,
	`referrer_host` text DEFAULT '' NOT NULL,
	`device` text DEFAULT 'desktop' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_public_visits_created` ON `public_visits` (`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_public_visits_visitor_path` ON `public_visits` (`visitor_id`,`path`,`created_at`);
--> statement-breakpoint
CREATE TABLE `feedback_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`visitor_id` text DEFAULT '' NOT NULL,
	`category` text NOT NULL,
	`pain` text NOT NULL,
	`current_process` text DEFAULT '' NOT NULL,
	`desired_outcome` text DEFAULT '' NOT NULL,
	`contact_email` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_feedback_requests_created` ON `feedback_requests` (`created_at`);
