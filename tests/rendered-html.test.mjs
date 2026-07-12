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
  assert.match(app, /作为旁观者加入/);
  assert.match(app, /旁观不占玩家席位/);
  assert.match(app, /JSON\.stringify\(\{ op: "chat", (?:message|content: message) \}\)/);
  assert.match(app, /maxLength=\{240\}/);
  assert.match(app, /session\.role === "spectator"/);
  assert.match(app, /disabled=\{isSpectator/);
  assert.match(app, /room\.spectators/);
  assert.match(app, /room\.chat/);
  assert.match(css, /\.spectator-list/);
  assert.match(css, /\.chat-list/);
});

test("places settings and accident history below the minefield instead of in the side panel", async () => {
  const [app, css] = await Promise.all([
    readFile(new URL("../app/MinefieldApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  const boardStart = app.indexOf('<div className="board-column">');
  const lowerPanels = app.indexOf('<div className="board-lower-panels">', boardStart);
  const settings = app.indexOf('board-settings-section', lowerPanels);
  const activity = app.indexOf('board-activity-section', settings);
  const boardEnd = app.indexOf('</div>\n\n        <aside className="side-panel">', activity);
  const sideStart = app.indexOf('<aside className="side-panel">', boardEnd);
  const sideEnd = app.indexOf('</aside>', sideStart);

  assert.ok(boardStart >= 0 && lowerPanels > boardStart);
  assert.ok(settings > lowerPanels && activity > settings && boardEnd > activity);
  assert.ok(sideStart > boardEnd && sideEnd > sideStart);
  const sidePanelSource = app.slice(sideStart, sideEnd);
  assert.doesNotMatch(sidePanelSource, /settings-section|activity-section|本局设置|事故记录/);
  assert.match(css, /\.board-lower-panels/);
  assert.match(css, /\.settings-controls/);
  assert.match(css, /\.board-activity-section \.activity-list/);
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

test("keeps a mine accident private while the shared ad-revival decision is pending", async () => {
  const migrationsDirectory = new URL("../drizzle/", import.meta.url);
  const migrationNames = (await readdir(migrationsDirectory)).filter((name) => name.endsWith(".sql"));
  const migrationSources = await Promise.all(
    migrationNames.map((name) => readFile(new URL(name, migrationsDirectory), "utf8")),
  );
  const [rooms, schema] = await Promise.all([
    readFile(new URL("../lib/rooms.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
  ]);

  const publicRevivalStart = rooms.indexOf("function publicRevival");
  const publicGameStart = rooms.indexOf("function publicGame", publicRevivalStart);
  const toPublicRoomStart = rooms.indexOf("async function toPublicRoom", publicGameStart);
  const actionStart = rooms.indexOf("export async function applyRoomAction");
  assert.ok(publicRevivalStart >= 0 && publicGameStart > publicRevivalStart);
  assert.ok(toPublicRoomStart > publicGameStart && actionStart >= 0);

  const publicRevivalSource = rooms.slice(publicRevivalStart, publicGameStart);
  const publicGameSource = rooms.slice(publicGameStart, toPublicRoomStart);
  const actionSource = rooms.slice(actionStart);
  const accidentStart = actionSource.indexOf('if (before.status !== "lost" && after.status === "lost")');
  const normalCommitStart = actionSource.indexOf("const activityType = actionActivity", accidentStart);
  assert.ok(accidentStart >= 0 && normalCommitStart > accidentStart);
  const accidentSource = actionSource.slice(accidentStart, normalCommitStart);

  assert.match(rooms, /const REVIVAL_AD_MS = 10_000/);
  assert.match(rooms, /type RoomIncident = \{[\s\S]{0,500}action: LosingWireAction/);
  assert.match(schema, /incidentJson: text\("incident_json"\)/);
  assert.ok(
    migrationSources.some((source) => /ALTER TABLE [`"]rooms[`"] ADD [`"]incident_json[`"] TEXT/i.test(source)),
    "expected a migration that persists the private incident",
  );

  // The saved reveal/chord is intentionally server-only. The public DTO exposes
  // who caused the pause and its deadline, but never the action/index.
  assert.match(publicRevivalSource, /phase: incident\.phase/);
  assert.match(publicRevivalSource, /adEndsAt: incident\.adEndsAt/);
  assert.doesNotMatch(publicRevivalSource, /\baction\b|\bindex\b/);
  assert.match(publicGameSource, /const terminal = game\.status === "won" \|\| game\.status === "lost"/);
  assert.match(publicGameSource, /if \(terminal && cell\.isMine\) dto\.mine = true/);

  // Detecting a loss records only the incident. Omitting game_json from this
  // compare-and-swap is what leaves every client on the exact pre-mine board.
  assert.match(accidentSource, /phase: "prompt"/);
  assert.match(accidentSource, /action: \{ type: wireAction\.type, index: wireAction\.index \}/);
  assert.match(accidentSource, /newActivity\(player, "incident", "踩雷了，等待场上玩家选择"\)/);
  assert.doesNotMatch(accidentSource, /等待全员选择/);
  assert.match(accidentSource, /incident_json = \?1/);
  assert.doesNotMatch(accidentSource, /game_json\s*=/);
});

test("enforces the ten-second all-player ad and resolves it atomically", async () => {
  const rooms = await readFile(new URL("../lib/rooms.ts", import.meta.url), "utf8");
  const settleStart = rooms.indexOf("async function settleExpiredIncident");
  const settleEnd = rooms.indexOf("function validateIndex", settleStart);
  const actionStart = rooms.indexOf("export async function applyRoomAction");
  assert.ok(settleStart >= 0 && settleEnd > settleStart && actionStart >= 0);
  const settleSource = rooms.slice(settleStart, settleEnd);
  const actionSource = rooms.slice(actionStart);
  const spectatorGuard = actionSource.indexOf('identity.role === "spectator"');
  const incidentRead = actionSource.indexOf("const incident = parseIncident(row)");

  assert.ok(spectatorGuard >= 0 && incidentRead > spectatorGuard, "spectators must be rejected before any revival branch");
  assert.match(actionSource, /identity\.role === "spectator"[\s\S]{0,180}403/);
  assert.match(actionSource, /newActivity\(player, "ad", "所有参赛玩家观看 10 秒广告"\)/);
  assert.doesNotMatch(actionSource, /newActivity\(player, "ad", "(?:全员|全房间)/);
  assert.match(actionSource, /row = await settleExpiredIncident\(row, requestedAt\)/);
  assert.match(actionSource, /wireAction\.type === "watchAd"[\s\S]{0,900}phase: "ad"[\s\S]{0,160}adEndsAt: now \+ REVIVAL_AD_MS/);
  assert.match(actionSource, /if \(incident\.phase === "ad"\)[\s\S]{0,180}409/);
  assert.match(actionSource, /translateAction\(incident\.action, before\)/);
  assert.match(actionSource, /after\.status !== "lost"/);
  assert.match(actionSource, /game_json = \?1, incident_json = NULL/);
  assert.match(actionSource, /throw new RoomError\([\s\S]{0,180}409\);[\s\S]{0,120}if \(wireAction\.type === "watchAd" \|\| wireAction\.type === "endGame"\)/);

  assert.match(settleSource, /incident\.phase !== "ad"/);
  assert.match(settleSource, /requestedAt < incident\.adEndsAt/);
  assert.match(settleSource, /shiftStartedAtForPause\(parseGame\(row\), incident, now\)/);
  assert.match(settleSource, /revision: pausedGame\.revision \+ 1/);
  assert.match(settleSource, /game_json = \?1, incident_json = NULL/);
  assert.match(settleSource, /WHERE code = \?5 AND version = \?6 AND incident_json = \?7/);
});

test("renders the shared revival prompt, player-only ad, spectator countdown, and board lock", async () => {
  const [app, css] = await Promise.all([
    readFile(new URL("../app/MinefieldApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(app, /\{ type: "watchAd" \}/);
  assert.match(app, /\{ type: "endGame" \}/);
  assert.match(app, /const isRevivalLocked = Boolean\(revival\)/);
  assert.match(app, /disabled=\{isSpectator \|\| isRevivalLocked \|\| room\.game\.status === "won" \|\| room\.game\.status === "lost"\}/);
  assert.match(app, /className=\{`revival-overlay revival-\$\{revival\.phase\}`\}/);
  assert.match(app, /submitRevivalDecision\("watchAd"\)/);
  assert.match(app, /submitRevivalDecision\("endGame"\)/);
  assert.match(app, /看广告复活/);
  assert.match(app, /结束游戏/);
  assert.match(app, /广告播放中/);
  assert.match(app, /广告位招租中/);
  assert.match(app, /所有参赛玩家就得一起看/);
  assert.match(app, /所有参赛玩家被迫观看/);
  assert.match(app, /旁观席免广告/);
  assert.match(app, /场上玩家正在看广告；旁观者免广告，可继续聊天围观。/);
  assert.doesNotMatch(app, /全房间就得一起看|全房间被迫观看|全房同步/);
  assert.match(app, /Math\.ceil\(\(revival\.adEndsAt - now\) \/ 1000\)/);
  assert.match(app, /Math\.min\(10,/);
  assert.match(app, /if \(isSpectator \|\| room\?\.revival\?\.phase !== "prompt" \|\| revivalDecision\) return/);

  const spectatorPromptStart = app.indexOf('<div className="revival-spectator-wait">');
  const playerPromptStart = app.indexOf('<div className="revival-actions">', spectatorPromptStart);
  const spectatorAdStart = app.indexOf("<span>GAME PAUSED</span>", playerPromptStart);
  const playerAdStart = app.indexOf("<span>AD BREAK</span>", spectatorAdStart);
  assert.ok(
    spectatorPromptStart >= 0
      && playerPromptStart > spectatorPromptStart
      && spectatorAdStart > playerPromptStart
      && playerAdStart > spectatorAdStart,
    "expected separate spectator/player prompt and ad branches",
  );
  const spectatorPromptSource = app.slice(spectatorPromptStart, playerPromptStart);
  const spectatorAdSource = app.slice(spectatorAdStart, playerAdStart);
  assert.doesNotMatch(spectatorPromptSource, /<button|watchAd|endGame/);
  assert.match(spectatorAdSource, /revival-countdown spectator-countdown/);
  assert.doesNotMatch(spectatorAdSource, /revival-watch-button|revival-end-button|ad-rental|YOUR AD HERE/);
  assert.match(css, /\.revival-overlay/);
  assert.match(css, /\.revival-countdown/);
  assert.match(css, /\.revival-watch-button/);
  assert.match(css, /\.revival-end-button/);
});
