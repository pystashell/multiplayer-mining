import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAT_RATE_LIMIT,
  MineRoomEngine,
  MineRoomEngineError,
  REVIVAL_AD_MS,
} from "../shared/mine-room-engine.ts";

const HOST_HASH = "a".repeat(64);

function createEngine(now = 1_000) {
  let id = 0;
  let seed = 0x12345678;
  return MineRoomEngine.create({
    code: "ABC234",
    name: "房主",
    difficulty: "beginner",
    playerId: "host",
    tokenHash: HOST_HASH,
    now,
  }, {
    random: () => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed / 0x1_0000_0000;
    },
    createId: () => `id-${++id}`,
  });
}

test("serializes membership, role switches, spectators, and chat", () => {
  const engine = createEngine();
  const guest = engine.join({
    name: "队友",
    role: "player",
    playerId: "guest",
    tokenHash: "b".repeat(64),
    now: 2_000,
  });
  assert.equal(guest.identity.slot, 2);

  const spectator = engine.join({
    name: "观众",
    role: "spectator",
    playerId: "viewer",
    tokenHash: "c".repeat(64),
    now: 3_000,
  });
  assert.equal(spectator.identity.role, "spectator");
  assert.equal(spectator.identity.slot, null);

  assert.throws(
    () => engine.handleAction({ playerId: "viewer", action: { type: "reveal", index: 0 }, now: 4_000 }),
    (error: unknown) => error instanceof MineRoomEngineError && error.status === 403,
  );

  const switched = engine.switchRole({ playerId: "guest", targetRole: "spectator", now: 5_000 });
  assert.equal(switched.identity.role, "spectator");
  assert.equal(switched.identity.slot, null);

  const chat = engine.postChat({ playerId: "viewer", content: "  一起围观  ", now: 6_000 });
  assert.equal(chat.room.chat.at(-1)?.content, "一起围观");
  assert.equal(chat.room.chat.at(-1)?.senderRole, "spectator");

  const sticker = engine.postChat({
    playerId: "viewer",
    content: "客户端不能伪造表情内容",
    stickerId: "boom",
    now: 6_001,
  });
  assert.equal(sticker.room.chat.at(-1)?.content, "💥");
  assert.equal(sticker.room.chat.at(-1)?.stickerId, "boom");
  assert.equal(sticker.room.chat.at(-1)?.senderRole, "spectator");

  const restored = MineRoomEngine.restore(engine.serialize());
  assert.equal(restored.snapshot(6_002).players.length, 1);
  assert.equal(restored.snapshot(6_002).spectators.length, 2);
  assert.equal(restored.snapshot(6_002).chat.length, 2);
  assert.equal(restored.snapshot(6_002).chat.at(-1)?.stickerId, "boom");
});

test("keeps legacy text chat compatible and rejects unknown sticker ids", () => {
  const engine = createEngine();
  engine.postChat({ playerId: "host", content: "旧消息", now: 2_000 });
  const serialized = engine.serialize();
  delete serialized.chat[0]?.stickerId;

  const restored = MineRoomEngine.restore(serialized);
  assert.equal(restored.snapshot(2_001).chat[0]?.content, "旧消息");
  assert.equal(restored.snapshot(2_001).chat[0]?.stickerId, undefined);

  assert.throws(
    () => restored.postChat({
      playerId: "host",
      content: "🤨",
      stickerId: "not-a-sticker",
      now: 2_002,
    }),
    (error: unknown) => (
      error instanceof MineRoomEngineError
      && error.status === 400
      && error.code === "BAD_REQUEST"
    ),
  );
});

test("persists command receipts and rejects stale or duplicate envelopes", () => {
  const engine = createEngine();
  assert.equal(engine.inspectSequence("host", "command-1", 1).kind, "new");
  const receipt = engine.recordSequence({ playerId: "host", id: "command-1", sequence: 1, now: 2_000 });
  assert.equal(receipt.ok, true);
  assert.equal(engine.inspectSequence("host", "command-1", 1).kind, "duplicate");
  assert.equal(engine.inspectSequence("host", "different-command", 1).kind, "stale");

  const restored = MineRoomEngine.restore(engine.serialize());
  assert.equal(restored.inspectSequence("host", "command-1", 1).kind, "duplicate");
});

test("tracks the exact hibernated connection and goes offline immediately on close", () => {
  const engine = createEngine();
  engine.resumeConnection("host", "socket-1", 2_000);
  assert.equal(engine.isConnectionActive("host", "socket-1"), true);
  assert.equal(engine.snapshot(2_001).players[0]?.online, true);

  engine.disconnect({ connectionId: "socket-1", now: 2_002 });
  assert.equal(engine.isConnectionActive("host", "socket-1"), false);
  assert.equal(engine.snapshot(2_002).players[0]?.online, false);
});

test("keeps a mine incident private and revives through the alarm deadline", () => {
  const engine = createEngine();
  const first = engine.handleAction({ playerId: "host", action: { type: "reveal", index: 40 }, now: 2_000 });
  assert.equal(first.room.game.status, "playing");
  const mineIndex = engine.serialize().game.cells.findIndex((cell) => cell.isMine);
  assert.ok(mineIndex >= 0);

  const incident = engine.handleAction({
    playerId: "host",
    action: { type: "reveal", index: mineIndex },
    now: 3_000,
  });
  assert.equal(incident.room.game.status, "playing");
  assert.equal(incident.room.revival?.phase, "prompt");
  assert.equal(incident.room.game.cells.some((cell) => cell.mine || cell.exploded), false);

  const watching = engine.handleAction({ playerId: "host", action: { type: "watchAd" }, now: 4_000 });
  assert.equal(watching.room.revival?.phase, "ad");
  assert.equal(engine.nextDueAt(), 4_000 + REVIVAL_AD_MS);

  const revived = engine.advance(4_000 + REVIVAL_AD_MS);
  assert.equal(revived.changed, true);
  assert.equal(revived.room?.revival, null);
  assert.equal(revived.room?.game.status, "playing");
  assert.equal(revived.room?.game.cells.some((cell) => cell.mine || cell.exploded), false);
});

test("only endGame commits and publishes the losing board", () => {
  const engine = createEngine();
  engine.handleAction({ playerId: "host", action: { type: "reveal", index: 40 }, now: 2_000 });
  const mineIndex = engine.serialize().game.cells.findIndex((cell) => cell.isMine);
  engine.handleAction({ playerId: "host", action: { type: "reveal", index: mineIndex }, now: 3_000 });
  const ended = engine.handleAction({ playerId: "host", action: { type: "endGame" }, now: 4_000 });
  assert.equal(ended.room.game.status, "lost");
  assert.equal(ended.room.revival, null);
  assert.equal(ended.room.game.cells.some((cell) => cell.mine), true);
  assert.equal(ended.room.game.cells[mineIndex]?.exploded, true);
});

test("enforces the per-member chat window", () => {
  const engine = createEngine();
  for (let index = 0; index < CHAT_RATE_LIMIT; index += 1) {
    if (index % 2 === 0) {
      engine.postChat({ playerId: "host", content: `消息 ${index}`, now: 2_000 + index });
    } else {
      engine.postChat({
        playerId: "host",
        content: "客户端回退会被覆盖",
        stickerId: "flag",
        now: 2_000 + index,
      });
    }
  }
  assert.throws(
    () => engine.postChat({ playerId: "host", content: "太快了", now: 2_100 }),
    (error: unknown) => error instanceof MineRoomEngineError && error.status === 429,
  );
});
