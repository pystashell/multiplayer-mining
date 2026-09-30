// These checks inspect source/config contracts; behavior lives in the regression suites.
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

test("ships the bilingual cooperative Minesweeper product instead of the starter preview", async () => {
  const [layout, page, app, i18n, css, packageJson] = await Promise.all([
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/MinefieldApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/i18n.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(i18n, /同雷共苦｜四人在线扫雷/);
  assert.match(i18n, /Mine Together, Blame Together \| Multiplayer Minesweeper/);
  assert.match(i18n, /最多四个人，一块雷区/);
  assert.match(i18n, /Up to four players, one minefield/);
  assert.match(layout, /cookieStore\.get\(LOCALE_COOKIE\)/);
  assert.match(layout, /accept-language/);
  assert.match(layout, /<html lang=\{locale\}>/);
  assert.match(page, /initialLocale=\{initialLocale\}/);
  assert.match(app, /<LanguageSwitch locale=\{locale\}/);
  assert.match(app, /LOCALE_STORAGE_KEY/);
  assert.match(app, /创建房间/);
  assert.match(app, /加入朋友/);
  assert.match(app, /作为旁观者加入/);
  assert.match(app, /onDoubleClick/);
  assert.match(app, /beginClassicChord/);
  assert.match(app, /左右键齐按/);
  assert.match(app, /room\.players\.length\}\/4/);
  assert.match(css, /\.mine-board/);
  assert.match(css, /\.spectator-list/);
  assert.match(css, /\.chat-list/);
  assert.match(css, /\.locale-switch/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.doesNotMatch(layout + page + app, /codex-preview|Your site is taking shape/i);
  await assert.rejects(access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)));
});

test("uses a hibernating Durable Object instead of room polling", async () => {
  const [app, hook, worker, durableObject, wrangler] = await Promise.all([
    readFile(new URL("../app/MinefieldApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/useMineRoomSocket.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/MineRoom.ts", import.meta.url), "utf8"),
    readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
  ]);

  assert.match(app, /useMineRoomSocket\(\{ autoResume: true \}\)/);
  assert.match(app, /roomSocket\.sendAction\(action, observedRoom\)/);
  assert.match(app, /roomSocket\.sendChat\(message\)/);
  assert.doesNotMatch(app, /pollInterval|setTimeout\([\s\S]{0,200}fetchRoom|900|2_000/);
  assert.match(hook, /new WebSocket\(createSocketUrl/);
  assert.match(worker, /MINE_ROOMS\.getByName\(roomCode\)/);
  assert.match(durableObject, /ctx\.acceptWebSocket\(server/);
  assert.match(durableObject, /webSocketMessage/);
  assert.match(durableObject, /async alarm\(\)/);
  assert.match(durableObject, /setWebSocketAutoResponse\(new WebSocketRequestResponsePair\("ping", "pong"\)\)/);
  assert.match(hook, /socket\.send\("ping"\)/);
  assert.doesNotMatch(hook, /sendCommandRef\.current\(\{ op: "ping" \}\)/);
  assert.match(wrangler, /"class_name": "MineRoom"/);
  assert.match(wrangler, /"new_sqlite_classes": \["MineRoom"\]/);
  assert.match(wrangler, /"name": "ROOM_CREATE_LIMIT"/);
  assert.match(wrangler, /"name": "ROOM_SOCKET_LIMIT"/);
});

test("keeps Durable Object bindings in the generated deployment config", async () => {
  const config = JSON.parse(await readFile(new URL("../dist/server/wrangler.json", import.meta.url), "utf8"));
  assert.deepEqual(
    config.durable_objects.bindings.map((binding) => [binding.name, binding.class_name]),
    [["MINE_ROOMS", "MineRoom"]],
  );
  assert.deepEqual(config.migrations, [{
    tag: "v1",
    new_sqlite_classes: ["MineRoom"],
  }]);
  assert.deepEqual(config.ratelimits.map((binding) => binding.name), [
    "ROOM_CREATE_LIMIT",
    "ROOM_JOIN_LIMIT",
    "ROOM_SOCKET_LIMIT",
  ]);
  assert.deepEqual(config.d1_databases, []);
});

test("reliably acknowledges, retries, and deduplicates socket commands", async () => {
  const [hook, protocol, durableObject, engine] = await Promise.all([
    readFile(new URL("../app/useMineRoomSocket.ts", import.meta.url), "utf8"),
    readFile(new URL("../shared/mine-protocol.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/MineRoom.ts", import.meta.url), "utf8"),
    readFile(new URL("../shared/mine-room-engine.ts", import.meta.url), "utf8"),
  ]);

  assert.match(protocol, /type: "command"/);
  assert.match(protocol, /id: string/);
  assert.match(protocol, /sequence: number/);
  assert.match(hook, /pendingCommandsRef/);
  assert.match(hook, /pending\.message\.sequence/);
  assert.match(hook, /sendEnvelope\(item\.message\)/);
  assert.match(hook, /message\.type === "ack"/);
  assert.match(hook, /snapshot\.room\.version < lastVersionRef\.current/);
  assert.match(durableObject, /inspectSequence/);
  assert.match(durableObject, /decision\.kind === "duplicate"/);
  assert.match(engine, /recordSequence/);
  assert.match(engine, /receipts: CommandReceipt\[\]/);
});

test("keeps credentials out of the WebSocket URL and hashes them at rest", async () => {
  const [hook, protocol, worker, durableObject, engine] = await Promise.all([
    readFile(new URL("../app/useMineRoomSocket.ts", import.meta.url), "utf8"),
    readFile(new URL("../shared/mine-protocol.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/MineRoom.ts", import.meta.url), "utf8"),
    readFile(new URL("../shared/mine-room-engine.ts", import.meta.url), "utf8"),
  ]);

  assert.match(hook, /url\.search = ""/);
  assert.match(hook, /url\.hash = ""/);
  assert.match(protocol, /type: "join";[\s\S]{0,100}session: RoomSession/);
  assert.match(worker, /hashToken\(token\)/);
  assert.match(engine, /tokenHash: string/);
  assert.match(engine, /crypto\.subtle\.digest\("SHA-256"/);
  assert.doesNotMatch(engine, /reconnectToken|rawToken/);
  assert.match(durableObject, /identity: RoomSessionIdentity \| null/);
  assert.doesNotMatch(durableObject, /type SocketAttachment[\s\S]{0,180}session: RoomSession/);
  assert.doesNotMatch(durableObject, /serializeAttachment\([\s\S]{0,120}token/);
});

test("preserves player, spectator, chat, and role constraints in the room engine", async () => {
  const [app, hook, protocol, engine, css] = await Promise.all([
    readFile(new URL("../app/MinefieldApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/useMineRoomSocket.ts", import.meta.url), "utf8"),
    readFile(new URL("../shared/mine-protocol.ts", import.meta.url), "utf8"),
    readFile(new URL("../shared/mine-room-engine.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(engine, /MAX_PLAYERS = 4/);
  assert.match(engine, /MAX_SPECTATORS = 20/);
  assert.match(engine, /MAX_CHAT_MESSAGES = 100/);
  assert.match(engine, /RETURNED_CHAT_MESSAGES = 40/);
  assert.match(engine, /CHAT_RATE_LIMIT = 8/);
  assert.match(engine, /CHAT_RATE_WINDOW_MS = 30_000/);
  assert.match(engine, /旁观者不能操作雷区/);
  assert.match(engine, /switchRole/);
  assert.match(engine, /leave\(input/);
  assert.match(app, /roomSocket\.switchRole\(targetRole\)/);
  assert.match(app, /roomSocket\.leaveMembership\(\)/);
  assert.match(app, /maxLength=\{240\}/);
  assert.match(protocol, /\{ op: "chat"; content: string; stickerId\?: StickerId \}/);
  assert.doesNotMatch(protocol, /\{ op: "sticker"/);
  assert.match(hook, /const sendSticker/);
  assert.match(hook, /sendCommand\(\{[\s\S]{0,160}op: "chat",[\s\S]{0,160}stickerId,[\s\S]{0,20}\}\)/);
  assert.match(app, /roomSocket\.sendSticker\(stickerId\)/);
  assert.match(app, /className="sticker-picker"/);
  assert.match(app, /message\.stickerId/);
  assert.match(css, /\.sticker-picker/);
  assert.match(css, /\.chat-sticker/);
});

test("keeps mine incidents private and resolves ads with an alarm-ready deadline", async () => {
  const [app, engine, durableObject] = await Promise.all([
    readFile(new URL("../app/MinefieldApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../shared/mine-room-engine.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/MineRoom.ts", import.meta.url), "utf8"),
  ]);

  assert.match(engine, /REVIVAL_AD_MS = 10_000/);
  assert.match(engine, /Deliberately do not assign `after`/);
  assert.match(engine, /phase: "prompt"/);
  assert.match(engine, /phase: "ad", adEndsAt: now \+ REVIVAL_AD_MS/);
  assert.match(engine, /shiftStartedAtForPause/);
  assert.match(engine, /action\.type === "endGame"/);
  assert.match(durableObject, /this\.engine\.advance\(now\)/);
  assert.match(durableObject, /setAlarm\(scheduledAt\)/);
  assert.match(app, /submitRevivalDecision\("watchAd"\)/);
  assert.match(app, /旁观席免广告/);
});

test("keeps settings and accident history below the minefield", async () => {
  const [app, css] = await Promise.all([
    readFile(new URL("../app/MinefieldApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  const boardStart = app.indexOf('<div className="board-column">');
  const lowerPanels = app.indexOf('<div className="board-lower-panels">', boardStart);
  const settings = app.indexOf("board-settings-section", lowerPanels);
  const activity = app.indexOf("board-activity-section", settings);
  const sideStart = app.indexOf('<aside className="side-panel">', activity);
  assert.ok(boardStart >= 0 && lowerPanels > boardStart);
  assert.ok(settings > lowerPanels && activity > settings && sideStart > activity);
  assert.match(css, /\.board-lower-panels/);
  assert.match(css, /\.board-activity-section \.activity-list/);
});
