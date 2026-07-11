import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
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
