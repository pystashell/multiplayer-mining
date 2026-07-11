import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

export const rateLimits = sqliteTable("rate_limits", {
  bucket: text("bucket").primaryKey().notNull(),
  count: integer("count").notNull(),
  resetAt: integer("reset_at").notNull(),
});
