CREATE TABLE `extraction_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`sender` text NOT NULL,
	`subject_contains` text NOT NULL,
	`fields_json` text NOT NULL,
	`spreadsheet_id` text DEFAULT '' NOT NULL,
	`spreadsheet_name` text DEFAULT '' NOT NULL,
	`sheet_name` text DEFAULT '' NOT NULL,
	`mappings_json` text DEFAULT '{}' NOT NULL,
	`active` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_extraction_rules_user_updated` ON `extraction_rules` (`user_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `google_connections` (
	`user_id` text PRIMARY KEY NOT NULL,
	`google_email` text NOT NULL,
	`access_token_enc` text NOT NULL,
	`refresh_token_enc` text,
	`expires_at` integer NOT NULL,
	`scopes` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `processed_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`rule_id` integer NOT NULL,
	`gmail_message_id` text NOT NULL,
	`processed_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_processed_messages_owner_rule_message` ON `processed_messages` (`user_id`,`rule_id`,`gmail_message_id`);--> statement-breakpoint
CREATE TABLE `processing_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`rule_id` integer,
	`received_at` text NOT NULL,
	`subject` text NOT NULL,
	`extracted_count` integer DEFAULT 0 NOT NULL,
	`destination` text DEFAULT '' NOT NULL,
	`status` text NOT NULL,
	`error_message` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_processing_history_user_created` ON `processing_history` (`user_id`,`created_at`);