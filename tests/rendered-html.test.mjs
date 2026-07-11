import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import test from "node:test";

test("ships the cooperative Minesweeper product instead of the starter preview", async () => {
  const [layout, app, css, packageJson] = await Promise.all([
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/MinefieldApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(layout, /同雷共苦｜四人在线扫雷/);
  assert.match(layout, /最多四个人，一块雷区/);
  assert.match(layout, /\/og-v2\.png/);
  assert.match(app, /一块雷区/);
  assert.match(app, /创建房间/);
  assert.match(app, /加入朋友/);
  assert.match(app, /onDoubleClick/);
  assert.match(app, /onMouseDown/);
  assert.match(app, /beginClassicChord/);
  assert.match(app, /finishClassicChord/);
  assert.match(app, /onContextMenu/);
  assert.match(app, /左右键齐按/);
  assert.match(app, /最多四人实时扫雷/);
  assert.match(app, /room\.players\.length\}\/4/);
  assert.match(app, /\[1, 2, 3, 4\] as const/);
  assert.match(css, /\.mine-board/);
  assert.match(css, /\.mine-cell\.chord-preview/);
  assert.match(css, /\.player-4 \.player-avatar/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.doesNotMatch(layout + app, /codex-preview|Your site is taking shape/i);
  await assert.rejects(access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)));
});

test("keeps existing rooms compatible while adding player three and four", async () => {
  const [rooms, schema, migration] = await Promise.all([
    readFile(new URL("../lib/rooms.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0002_rare_squadron_sinister.sql", import.meta.url), "utf8"),
  ]);

  assert.match(rooms, /slot: 1 \| 2 \| 3 \| 4/);
  assert.match(rooms, /JOIN_SLOT_COLUMNS/);
  assert.match(rooms, /WHERE code = \?7 AND version = \?8 AND \$\{columns\.id\} IS NULL/);
  assert.match(schema, /player3Id: text\("player3_id"\)/);
  assert.match(schema, /player4Id: text\("player4_id"\)/);
  assert.equal((migration.match(/ALTER TABLE `rooms` ADD/g) ?? []).length, 8);
});

test("ships a read-only spectator entry and shared room chat", async () => {
  const [app, css] = await Promise.all([
    readFile(new URL("../app/MinefieldApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(app, /enterRoom\("spectate"\)/);
  assert.match(app, /JSON\.stringify\(\{ op: "chat", (?:message|content: message) \}\)/);
  assert.match(app, /maxLength=\{240\}/);
  assert.match(app, /session\.role === "spectator"/);
  assert.match(app, /disabled=\{isSpectator/);
  assert.match(app, /room\.spectators/);
  assert.match(app, /room\.chat/);
  assert.match(css, /\.spectator-list/);
  assert.match(css, /\.chat-list/);
});

test("enforces spectator and chat constraints in the API and D1 schema", async () => {
  const migrationsDirectory = new URL("../drizzle/", import.meta.url);
  const migrationNames = (await readdir(migrationsDirectory)).filter((name) => name.endsWith(".sql"));
  const migrationSources = await Promise.all(
    migrationNames.map((name) => readFile(new URL(name, migrationsDirectory), "utf8")),
  );
  const spectatorMigration = migrationSources.find(
    (source) => source.includes("room_spectators") && source.includes("room_messages"),
  );
  const [rooms, route, schema] = await Promise.all([
    readFile(new URL("../lib/rooms.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/rooms/[code]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
  ]);
  const actionStart = rooms.indexOf("export async function applyRoomAction");
  const nextExport = rooms.indexOf("\nexport async function", actionStart + 1);
  const actionSource = rooms.slice(actionStart, nextExport === -1 ? undefined : nextExport);

  assert.match(route, /payload\.op === "spectate"/);
  assert.match(route, /payload\.op === "chat"/);
  assert.match(route, /payload\.message \?\? payload\.content/);
  assert.match(rooms, /const MAX_SPECTATORS = 20/);
  assert.match(rooms, /const MAX_CHAT_MESSAGES = 100/);
  assert.match(rooms, /const RETURNED_CHAT_MESSAGES = 40/);
  assert.match(rooms, /const CHAT_RATE_LIMIT = 8/);
  assert.match(rooms, /const CHAT_RATE_WINDOW_MS = 30_000/);
  assert.match(rooms, /DELETE FROM rate_limits WHERE reset_at <= \?1/);
  assert.match(rooms, /function normalizeChatContent[\s\S]{0,500}\[\.\.\.content\]\.length > 240/);
  assert.match(actionSource, /(?:role !== "player"|role === "spectator")[\s\S]{0,240}403/);
  assert.match(
    rooms,
    /ORDER BY created_at DESC, id DESC\s+LIMIT \$\{RETURNED_CHAT_MESSAGES\}[\s\S]{0,120}ORDER BY created_at ASC, id ASC/,
  );

  assert.match(schema, /sqliteTable\("room_spectators"/);
  assert.match(schema, /sqliteTable\("room_messages"/);
  assert.match(schema, /onDelete: "cascade"/);
  assert.match(schema, /senderRole.*"sender_role"/);
  assert.match(schema, /index\("rate_limits_reset_idx"\)/);
  assert.ok(spectatorMigration, "expected a migration for spectator and chat tables");
  assert.match(spectatorMigration, /CREATE TABLE [`"]room_spectators[`"]/);
  assert.match(spectatorMigration, /CREATE TABLE [`"]room_messages[`"]/);
  assert.match(spectatorMigration, /ON DELETE cascade/i);
  assert.ok(
    migrationSources.some((source) => /CREATE INDEX [`"]rate_limits_reset_idx[`"]/.test(source)),
    "expected an index for expired rate-limit cleanup",
  );
});
