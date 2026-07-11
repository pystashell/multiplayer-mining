CREATE TABLE `room_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`room_code` text NOT NULL,
	`sender_id` text NOT NULL,
	`sender_name` text NOT NULL,
	`sender_role` text NOT NULL,
	`sender_slot` integer,
	`content` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`room_code`) REFERENCES `rooms`(`code`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "room_messages_sender_role_check" CHECK("room_messages"."sender_role" in ('player', 'spectator')),
	CONSTRAINT "room_messages_sender_slot_check" CHECK(("room_messages"."sender_role" = 'player' and "room_messages"."sender_slot" between 1 and 4) or ("room_messages"."sender_role" = 'spectator' and "room_messages"."sender_slot" is null))
);
--> statement-breakpoint
CREATE INDEX `room_messages_room_created_idx` ON `room_messages` (`room_code`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `room_messages_sender_created_idx` ON `room_messages` (`sender_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `room_spectators` (
	`id` text PRIMARY KEY NOT NULL,
	`room_code` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`seen_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`room_code`) REFERENCES `rooms`(`code`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `room_spectators_room_idx` ON `room_spectators` (`room_code`);--> statement-breakpoint
CREATE UNIQUE INDEX `room_spectators_room_token_idx` ON `room_spectators` (`room_code`,`token_hash`);--> statement-breakpoint
CREATE INDEX `room_spectators_room_seen_idx` ON `room_spectators` (`room_code`,`seen_at`);