import assert from "node:assert/strict";
import test from "node:test";
import { chordCell, createGame, revealCell, setMark, toggleFlag } from "../lib/minesweeper.ts";

test("flags are hard protection and classic question marks remain revealable", () => {
  const blank = createGame("beginner");
  const flagged = toggleFlag(blank, 0, 0, { actorId: "p1" });
  const retriedFlag = setMark(flagged, 0, 0, "flagged", { actorId: "p2" });
  assert.equal(retriedFlag, flagged);
  const blocked = revealCell(flagged, 0, 0, { random: () => 0, now: () => 1000, actorId: "p2" });
  assert.equal(blocked, flagged);
  assert.equal(blocked.status, "ready");
  assert.equal(blocked.startedAt, null);

  const questioned = toggleFlag(flagged, 0, 0, { actorId: "p1" });
  assert.equal(questioned.cells[0].isQuestioned, true);
  const revealed = revealCell(questioned, 0, 0, { random: () => 0, now: () => 1000, actorId: "p2" });
  assert.equal(revealed.cells[0].isRevealed, true);
  assert.equal(revealed.cells[0].isMine, false);
});

test("a correct chord opens neighbors and completes a win", () => {
  const blank = createGame({ width: 3, height: 3, mineCount: 1 });
  const opened = revealCell(blank, 1, 1, { random: () => 0, now: () => 1000, actorId: "p1" });
  assert.equal(opened.cells[0].isMine, true);
  assert.equal(opened.cells[4].adjacentMines, 1);
  const flagged = toggleFlag(opened, 0, 0, { actorId: "p2" });
  const won = chordCell(flagged, 1, 1, { now: () => 2000, actorId: "p1" });
  assert.equal(won.status, "won");
  assert.equal(won.revealedSafeCells, 8);
  assert.equal(won.flagsPlaced, 1);
});

test("an incorrect flag can make a chord detonate the real mine", () => {
  const blank = createGame({ width: 3, height: 3, mineCount: 1 });
  const opened = revealCell(blank, 1, 1, { random: () => 0, now: () => 1000, actorId: "p1" });
  const wrongFlag = toggleFlag(opened, 2, 2, { actorId: "p2" });
  const lost = chordCell(wrongFlag, 1, 1, { now: () => 2000, actorId: "p1" });
  assert.equal(lost.status, "lost");
  assert.equal(lost.cells[0].isExploded, true);
  assert.equal(lost.cells[8].isFlagged, true);
  assert.equal(lost.cells[8].isMine, false);
});

test("zero flood fill skips flagged cells without getting stuck", () => {
  const blank = createGame({ width: 4, height: 4, mineCount: 1 });
  const flaggedSafe = toggleFlag(blank, 1, 0, { actorId: "p1" });
  const flooded = revealCell(flaggedSafe, 0, 0, { random: () => 0.999999, now: () => 1000, actorId: "p2" });
  assert.equal(flooded.cells[1].isFlagged, true);
  assert.equal(flooded.cells[1].isRevealed, false);
  assert.equal(flooded.revealedSafeCells, 14);
  assert.equal(flooded.status, "playing");
});
