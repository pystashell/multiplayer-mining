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

  assert.match(layout, /同雷共苦｜双人在线扫雷/);
  assert.match(app, /一块雷区/);
  assert.match(app, /创建房间/);
  assert.match(app, /加入朋友/);
  assert.match(app, /onDoubleClick/);
  assert.match(app, /onMouseDown/);
  assert.match(app, /beginClassicChord/);
  assert.match(app, /finishClassicChord/);
  assert.match(app, /onContextMenu/);
  assert.match(app, /左右键齐按/);
  assert.match(css, /\.mine-board/);
  assert.match(css, /\.mine-cell\.chord-preview/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.doesNotMatch(layout + app, /codex-preview|Your site is taking shape/i);
  await assert.rejects(access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)));
});
