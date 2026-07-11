CREATE TABLE `rooms` (
	`code` text PRIMARY KEY NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`game_json` text NOT NULL,
	`activity_json` text DEFAULT '[]' NOT NULL,
	`host_id` text NOT NULL,
	`host_name` text NOT NULL,
	`host_token_hash` text NOT NULL,
	`host_seen_at` integer NOT NULL,
	`guest_id` text,
	`guest_name` text,
	`guest_token_hash` text,
	`guest_seen_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
