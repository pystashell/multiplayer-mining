import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const rooms = sqliteTable("rooms", {
  code: text("code").primaryKey().notNull(),
  version: integer("version").notNull().default(1),
  gameJson: text("game_json").notNull(),
  activityJson: text("activity_json").notNull().default("[]"),
  hostId: text("host_id").notNull(),
  hostName: text("host_name").notNull(),
  hostTokenHash: text("host_token_hash").notNull(),
  hostSeenAt: integer("host_seen_at").notNull(),
  guestId: text("guest_id"),
  guestName: text("guest_name"),
  guestTokenHash: text("guest_token_hash"),
  guestSeenAt: integer("guest_seen_at"),
  player3Id: text("player3_id"),
  player3Name: text("player3_name"),
  player3TokenHash: text("player3_token_hash"),
  player3SeenAt: integer("player3_seen_at"),
  player4Id: text("player4_id"),
  player4Name: text("player4_name"),
  player4TokenHash: text("player4_token_hash"),
  player4SeenAt: integer("player4_seen_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

export const rateLimits = sqliteTable("rate_limits", {
  bucket: text("bucket").primaryKey().notNull(),
  count: integer("count").notNull(),
  resetAt: integer("reset_at").notNull(),
}, (table) => [
  index("rate_limits_reset_idx").on(table.resetAt),
]);

export const roomSpectators = sqliteTable("room_spectators", {
  id: text("id").primaryKey().notNull(),
  roomCode: text("room_code")
    .notNull()
    .references(() => rooms.code, { onDelete: "cascade" }),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull(),
  seenAt: integer("seen_at").notNull(),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  index("room_spectators_room_idx").on(table.roomCode),
  uniqueIndex("room_spectators_room_token_idx").on(table.roomCode, table.tokenHash),
  index("room_spectators_room_seen_idx").on(table.roomCode, table.seenAt),
]);

export const roomMessages = sqliteTable("room_messages", {
  id: text("id").primaryKey().notNull(),
  roomCode: text("room_code")
    .notNull()
    .references(() => rooms.code, { onDelete: "cascade" }),
  senderId: text("sender_id").notNull(),
  senderName: text("sender_name").notNull(),
  senderRole: text("sender_role").notNull(),
  senderSlot: integer("sender_slot"),
  content: text("content").notNull(),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  check("room_messages_sender_role_check", sql`${table.senderRole} in ('player', 'spectator')`),
  check(
    "room_messages_sender_slot_check",
    sql`(${table.senderRole} = 'player' and ${table.senderSlot} between 1 and 4) or (${table.senderRole} = 'spectator' and ${table.senderSlot} is null)`,
  ),
  index("room_messages_room_created_idx").on(table.roomCode, table.createdAt, table.id),
  index("room_messages_sender_created_idx").on(table.senderId, table.createdAt),
]);
