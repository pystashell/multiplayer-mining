import assert from "node:assert/strict";
import test from "node:test";
import { MineRoomEngine, MAX_RECEIPTS_PER_MEMBER, RESERVATION_TTL_MS, REVIVAL_AD_MS } from "../shared/mine-room-engine.ts";
import { MINE_PROTOCOL_VERSION as v, MAX_COMMAND_LIFETIME_MS } from "../shared/mine-protocol.ts";
import { MineRoom } from "../worker/MineRoom.ts";
import worker from "../worker/index.ts";

globalThis.WebSocketRequestResponsePair = class {};
const token = "host-secret";
const hash = async (value) => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).toString("hex");

async function engineAt(now) {
  let seed = 12345;
  const engine = MineRoomEngine.create({ code: "ABC234", name: "Host", difficulty: "beginner", playerId: "host", tokenHash: await hash(token), now }, {
    random: () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32),
  });
  await engine.connect({ playerId: "host", token, connectionId: "host-connection", now });
  return engine;
}

function socket(playerId = "host", joined = true) {
  return {
    readyState: 1, sent: [], closes: [],
    attachment: { joined, connectionId: `${playerId}-connection`, identity: joined ? { code: "ABC234", playerId, playerName: playerId, role: "player" } : null, connectedAt: Date.now() },
    serializeAttachment(value) { this.attachment = structuredClone(value); },
    deserializeAttachment() { return structuredClone(this.attachment); },
    send(raw) { this.sent.push(JSON.parse(raw)); },
    close(code, reason) { this.closes.push({ code, reason }); this.readyState = 3; },
  };
}

async function adapter(serialized, sockets = []) {
  const { chat, receipts, ...core } = serialized;
  const values = new Map([["room:core", core], ["room:chat", chat], ["room:receipts", receipts]]);
  const writes = [];
  let alarm = null;
  let deleted = 0;
  let ready;
  const ctx = {
    storage: {
      async get(key) {
        return Array.isArray(key)
          ? new Map(key.filter((entry) => values.has(entry)).map((entry) => [entry, structuredClone(values.get(entry))]))
          : structuredClone(values.get(key));
      },
      async put(entries) { writes.push(structuredClone(entries)); for (const [key, value] of Object.entries(entries)) values.set(key, structuredClone(value)); },
      async delete(keys) { return keys.filter((key) => values.delete(key)).length; },
      async getAlarm() { return alarm; }, async setAlarm(value) { alarm = value; }, async deleteAlarm() { alarm = null; },
      async deleteAll() { deleted++; values.clear(); },
    },
    setWebSocketAutoResponse() {}, getWebSockets() { return sockets; },
    blockConcurrencyWhile(fn) { ready = fn(); },
  };
  const room = new MineRoom(ctx, {});
  await ready;
  return { room, ctx, values, writes, deleted: () => deleted, alarm: () => alarm };
}

function command(engine, sequence, action, overrides = {}) {
  const current = engine.snapshot();
  return { v, type: "command", id: `command-${sequence}`, sequence, expiresAt: Date.now() + 30_000,
    command: { op: "action", action, roundId: current.roundId, observedGameRevision: current.game.revision }, ...overrides };
}
const send = (room, ws, message) => room.webSocketMessage(ws, JSON.stringify(message));

function incident(engine, now, ad = true) {
  engine.handleAction({ playerId: "host", action: { type: "reveal", index: 40 }, now });
  const mine = engine.serialize().game.cells.findIndex((cell) => cell.isMine);
  engine.handleAction({ playerId: "host", action: { type: "reveal", index: mine }, now });
  if (ad) engine.handleAction({ playerId: "host", action: { type: "watchAd" }, now });
}

for (const count of [0, 1, 2]) {
  for (const offset of [-1, 0, 100]) {
    test(`F01: rebuild with ${count} sockets at ad deadline ${offset}ms persists revival exactly once`, async (t) => {
      let now = 1_000_000;
      t.mock.method(Date, "now", () => now);
      const engine = await engineAt(now);
      incident(engine, now);
      now += REVIVAL_AD_MS + offset;
      const sockets = Array.from({ length: count }, () => socket());
      const fixture = await adapter(engine.serialize(), sockets);
      if (offset < 0) {
        assert.equal(fixture.writes.length, 0);
        assert.equal(fixture.values.get("room:core").incident.phase, "ad");
        now += 1;
      }
      await fixture.room.alarm();
      await fixture.room.alarm();
      assert.equal(fixture.values.get("room:core").incident, null);
      assert.equal(fixture.writes.length, 1);
      for (const ws of sockets) {
        assert.equal(ws.sent.filter((message) => message.type === "snapshot").length, 1);
        assert.equal(ws.sent[0].snapshot.room.revival, null);
        assert.equal(ws.sent[0].snapshot.room.players[0].online, true);
      }
    });
  }
}

test("F02: abandoned reservations expire, paused activated players retain seats", async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const engine = await engineAt(now);
  for (let n = 1; n <= 3; n++) engine.join({ name: `Guest${n}`, role: "player", playerId: `g${n}`, tokenHash: await hash(`g${n}`), now });
  await engine.connect({ playerId: "g1", token: "g1", now });
  engine.disconnect({ playerId: "g1", now });
  const fixture = await adapter(engine.serialize(), [socket()]);
  assert.equal(fixture.alarm(), now + RESERVATION_TTL_MS);
  now += RESERVATION_TTL_MS;
  await fixture.room.alarm();
  assert.deepEqual(fixture.values.get("room:core").members.map((member) => member.playerId), ["host", "g1"]);
  const response = await fixture.room.fetch(new Request("https://local/internal/join", { method: "POST", body: JSON.stringify({ name: "New", role: "player", playerId: "new", tokenHash: await hash("new") }) }));
  assert.equal(response.status, 201);
});

test("F02: authentication timeout never activates the pending reservation", async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const engine = await engineAt(now);
  engine.join({ name: "Guest", role: "player", playerId: "guest", tokenHash: await hash("guest"), now });
  const pending = socket("guest", false);
  const fixture = await adapter(engine.serialize(), [socket(), pending]);
  now += 10_000;
  await fixture.room.alarm();
  assert.equal(pending.closes[0].code, 4401);
  now += RESERVATION_TTL_MS;
  await fixture.room.alarm();
  assert.equal(fixture.values.get("room:core").members.length, 1);
});

test("F03: sync flood is bounded while another player can still make a move", async () => {
  const engine = await engineAt(Date.now());
  engine.join({ name: "Guest", role: "player", playerId: "guest", tokenHash: await hash("guest") });
  await engine.connect({ playerId: "guest", token: "guest" });
  const host = socket(); const guest = socket("guest");
  const { room } = await adapter(engine.serialize(), [host, guest]);
  const sync = command(engine, 1, null, { command: { op: "sync" } });
  for (let n = 0; n < 100; n++) await send(room, host, sync);
  assert.equal(host.sent.filter((message) => message.type === "snapshot").length, 1);
  assert.ok(host.sent.some((message) => message.code === "RATE_LIMITED"));
  await send(room, guest, command(engine, 1, { type: "reveal", index: 40 }));
  assert.ok(guest.sent.some((message) => message.type === "ack"));
});

test("F03/F08: no-op receipts survive rebuild without board writes or broadcasts", async () => {
  const engine = await engineAt(Date.now());
  engine.handleAction({ playerId: "host", action: { type: "reveal", index: 40 } });
  const host = socket();
  const { room, ctx, writes, values } = await adapter(engine.serialize(), [host]);
  for (let n = 1; n <= 20; n++) await send(room, host, command(engine, n, { type: "reveal", index: 40 }));
  assert.equal(host.sent.filter((message) => message.type === "snapshot").length, 0);
  assert.equal(writes.length, 20);
  assert.ok(writes.every((write) => !("room:core" in write) && !("room:chat" in write)));
  assert.equal(values.get("room:sequences").host, 20);
  let ready;
  ctx.blockConcurrencyWhile = (fn) => { ready = fn(); };
  const rebuilt = new MineRoom(ctx, {});
  await ready;
  const before = writes.length;
  await send(rebuilt, host, command(engine, 20, { type: "reveal", index: 40 }));
  assert.equal(writes.length, before);
  await send(rebuilt, host, command(engine, 1, { type: "reveal", index: 40 }, { id: "lost-counter" }));
  assert.equal(host.sent.findLast((message) => message.code === "STALE_SEQUENCE").lastAcceptedSequence, 20);
});

test("F03: queue admission stays bounded while storage is stalled", async () => {
  const engine = await engineAt(Date.now());
  for (const id of ["g1", "g2", "g3"]) {
    engine.join({ name: id, role: "player", playerId: id, tokenHash: await hash(id) });
    await engine.connect({ playerId: id, token: id });
  }
  const sockets = [socket(), socket("g1"), socket("g2"), socket("g3")];
  const fixture = await adapter(engine.serialize(), sockets);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const put = fixture.ctx.storage.put;
  fixture.ctx.storage.put = async (entries) => { await gate; return put(entries); };
  const work = [];
  for (let n = 1; n <= 100; n++) work.push(send(fixture.room, sockets[n % 4], command(engine, n, { type: "mark", index: 0, state: "flagged" })));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(sockets.flatMap((ws) => ws.sent).some((message) => message.code === "RATE_LIMITED"));
  release();
  await Promise.all(work);
  assert.ok(fixture.writes.length <= 64);
});

test("review: another member cannot evict a receipt inside its retry window", async () => {
  const now = Date.now();
  const engine = await engineAt(now);
  engine.join({ name: "Guest", role: "player", playerId: "guest", tokenHash: await hash("guest"), now });
  const original = engine.recordSequence({ playerId: "host", id: "lost-ack", sequence: 1, now });
  for (let sequence = 1; sequence <= 256; sequence++) {
    engine.recordSequence({ playerId: "guest", id: `guest-${sequence}`, sequence, now: now + sequence * 70 });
  }
  assert.deepEqual(engine.inspectSequence("host", "lost-ack", 1), { kind: "duplicate", receipt: original });
  assert.deepEqual(MineRoomEngine.restore(engine.serialize()).inspectSequence("host", "lost-ack", 1), { kind: "duplicate", receipt: original });
});

test("review: reconnect after peer traffic replays both success and rejection after rebuild", async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const engine = await engineAt(now);
  engine.join({ name: "Guest", role: "player", playerId: "guest", tokenHash: await hash("guest"), now });
  await engine.connect({ playerId: "guest", token: "guest", connectionId: "guest-connection", now });
  engine.handleAction({ playerId: "host", action: { type: "reveal", index: 40 }, now });
  const host = socket(); const guest = socket("guest");
  const sockets = [host, guest];
  const fixture = await adapter(engine.serialize(), sockets);
  const accepted = command(engine, 1, null, { command: { op: "chat", content: "Only once" } });
  const rejected = command(engine, 2, null, { command: { op: "unknown" } });
  for (const message of [accepted, rejected]) await send(fixture.room, host, message);
  const expected = [accepted, rejected].map(({ id }) => host.sent.find((message) => message.id === id));
  assert.equal(expected[0].type, "ack");
  assert.equal(expected[1].code, "BAD_REQUEST");
  await fixture.room.webSocketClose(host, 1000, "Lost acknowledgement");
  sockets.splice(0, 1);
  for (let sequence = 1; sequence <= 256; sequence++) {
    now += 70;
    await send(fixture.room, guest, command(engine, sequence, { type: "reveal", index: 40 }));
  }
  assert.equal(guest.sent.filter((message) => message.type === "ack").length, 256);
  let ready;
  fixture.ctx.blockConcurrencyWhile = (fn) => { ready = fn(); };
  const rebuilt = new MineRoom(fixture.ctx, {});
  await ready;
  const reconnected = socket("host", false);
  sockets.push(reconnected);
  await send(rebuilt, reconnected, { v, type: "join", session: { code: "ABC234", playerId: "host", playerName: "Host", role: "player", token } });
  assert.equal(reconnected.sent.find((message) => message.type === "welcome").lastAcceptedSequence, 2);
  const writesBeforeReplay = fixture.writes.length;
  for (let index = 0; index < 2; index++) {
    const message = [accepted, rejected][index];
    assert.ok(now < message.expiresAt);
    await send(rebuilt, reconnected, message);
    assert.deepEqual(reconnected.sent.findLast((reply) => reply.id === message.id), expected[index]);
  }
  assert.equal(fixture.writes.length, writesBeforeReplay);
  assert.equal(fixture.values.get("room:chat").filter((message) => message.content === "Only once").length, 1);
});

test("review: one member's own allowed traffic preserves earlier rejected outcomes", async () => {
  const now = Date.now();
  const engine = await engineAt(now);
  const original = engine.recordSequence({ playerId: "host", id: "rejected", sequence: 1, now,
    error: { code: "BAD_REQUEST", message: "Original rejection", retryable: false } });
  // 451 commands in 29.25s fit the 30-burst + 15/s admission budget.
  for (let index = 1; index <= 450; index++) {
    engine.recordSequence({ playerId: "host", id: `later-${index}`, sequence: index + 1, now: now + index * 65 });
  }
  assert.deepEqual(MineRoomEngine.restore(engine.serialize()).inspectSequence("host", "rejected", 1), { kind: "duplicate", receipt: original });
});

test("review: full receipt capacity rejects before mutation, isolates peers and frees only expired outcomes", async (t) => {
  const startedAt = 1_000_000;
  let now = startedAt;
  t.mock.method(Date, "now", () => now);
  const engine = await engineAt(now);
  engine.join({ name: "Guest", role: "player", playerId: "guest", tokenHash: await hash("guest"), now });
  await engine.connect({ playerId: "guest", token: "guest", connectionId: "guest-connection", now });
  for (let sequence = 1; sequence <= MAX_RECEIPTS_PER_MEMBER; sequence++) {
    engine.recordSequence({ playerId: "host", id: `retained-${sequence}`, sequence, now });
  }
  assert.throws(() => engine.recordSequence({ playerId: "host", id: "overflow", sequence: MAX_RECEIPTS_PER_MEMBER + 1, now }), { code: "RATE_LIMITED" });
  assert.equal(engine.lastAcceptedSequence("host"), MAX_RECEIPTS_PER_MEMBER);
  const host = socket(); const guest = socket("guest");
  const fixture = await adapter(engine.serialize(), [host, guest]);
  const next = command(engine, MAX_RECEIPTS_PER_MEMBER + 1, null, { command: { op: "chat", content: "After capacity frees" } });
  await send(fixture.room, host, next);
  assert.equal(host.sent.at(-1).code, "RATE_LIMITED");
  assert.equal(fixture.writes.length, 0);
  assert.equal(fixture.values.get("room:chat").length, 0);
  const duplicate = command(engine, 1, null, { id: "retained-1" });
  await send(fixture.room, host, duplicate);
  assert.equal(host.sent.at(-1).type, "ack");
  await send(fixture.room, guest, command(engine, 1, null, { command: { op: "chat", content: "Peer still works" } }));
  assert.equal(guest.sent.findLast((message) => message.id === "command-1").type, "ack");
  assert.equal(fixture.values.get("room:sequences").host, MAX_RECEIPTS_PER_MEMBER);
  assert.equal(fixture.values.get("room:receipts:host").length, MAX_RECEIPTS_PER_MEMBER);
  now = startedAt + MAX_COMMAND_LIFETIME_MS - 1;
  next.expiresAt = now + 30_000;
  await send(fixture.room, host, next);
  assert.equal(host.sent.at(-1).code, "RATE_LIMITED");
  now++;
  await send(fixture.room, host, next);
  assert.equal(host.sent.findLast((message) => message.id === next.id).type, "ack");
  assert.equal(fixture.values.get("room:receipts:host").length, 1);
  assert.equal(fixture.values.get("room:sequences").host, next.sequence);
  await send(fixture.room, host, duplicate);
  assert.equal(host.sent.findLast((message) => message.id === duplicate.id).code, "STALE_SEQUENCE");
  assert.equal(fixture.values.get("room:chat").filter((message) => message.content === "After capacity frees").length, 1);
});

test("review: maximum accepted deadline stays replayable through its last millisecond", async (t) => {
  const startedAt = 1_000_000;
  let now = startedAt;
  t.mock.method(Date, "now", () => now);
  const engine = await engineAt(now);
  const host = socket();
  const fixture = await adapter(engine.serialize(), [host]);
  const original = command(engine, 1, null, { expiresAt: now + MAX_COMMAND_LIFETIME_MS, command: { op: "chat", content: "Long deadline" } });
  await send(fixture.room, host, original);
  const ack = host.sent.find((message) => message.id === original.id);
  now = startedAt + MAX_COMMAND_LIFETIME_MS - 1;
  await send(fixture.room, host, command(engine, 2, null, { command: { op: "chat", content: "Triggers expiry cleanup" } }));
  await send(fixture.room, host, original);
  assert.deepEqual(host.sent.findLast((message) => message.id === original.id), ack);
});

test("review: legacy receipts migrate without loss and departed member partitions are removed", async () => {
  const engine = await engineAt(Date.now());
  const original = engine.recordSequence({ playerId: "host", id: "legacy", sequence: 1 });
  const host = socket();
  const fixture = await adapter(engine.serialize(), [host]);
  await send(fixture.room, host, command(engine, 2, null, { command: { op: "chat", content: "Migrate" } }));
  assert.deepEqual(fixture.values.get("room:receipts"), []);
  assert.deepEqual(fixture.values.get("room:receipts:host")[0], original);
  let ready;
  fixture.ctx.blockConcurrencyWhile = (fn) => { ready = fn(); };
  const rebuilt = new MineRoom(fixture.ctx, {});
  await ready;
  await send(rebuilt, host, command(engine, 1, null, { id: "legacy" }));
  assert.equal(host.sent.at(-1).type, "ack");
  await send(rebuilt, host, command(engine, 3, null, { command: { op: "leaveMembership" } }));
  assert.equal(fixture.values.has("room:receipts:host"), false);
  assert.deepEqual(fixture.values.get("room:sequences"), {});
  fixture.ctx.getWebSockets = () => [];
  const emptyRoom = new MineRoom(fixture.ctx, {});
  await ready;
  const response = await emptyRoom.fetch(new Request("https://local/internal/join", { method: "POST", body: JSON.stringify({ name: "New", role: "player", playerId: "new", tokenHash: await hash("new") }) }));
  assert.equal(response.status, 201);
  assert.equal(fixture.values.has("room:receipts:host"), false);
});

for (const action of [{ type: "reveal", index: 0 }, { type: "mark", index: 0, state: "flagged" }, { type: "chord", index: 0 }, { type: "restart" }]) {
  test(`F04: delayed ${action.type} cannot change the next round`, async () => {
    const engine = await engineAt(Date.now());
    const old = command(engine, 2, action);
    const host = socket(); const { room, values } = await adapter(engine.serialize(), [host]);
    await send(room, host, command(engine, 1, { type: "restart" }));
    const round = values.get("room:core").roundId;
    assert.notEqual(round, old.command.roundId);
    await send(room, host, old);
    assert.ok(host.sent.some((message) => message.id === old.id && message.code === "STALE_ROUND"));
    assert.equal(values.get("room:core").game.status, "ready");
    assert.equal(values.get("room:core").roundId, round);
  });
}

test("F04: control version ignores chat but rejects intervening board changes", async () => {
  const engine = await engineAt(Date.now());
  const snapshot = engine.snapshot();
  engine.postChat({ playerId: "host", content: "hello" });
  engine.handleAction({ playerId: "host", action: { type: "restart" }, roundId: snapshot.roundId, observedGameRevision: snapshot.game.revision });
  const next = engine.snapshot();
  engine.handleAction({ playerId: "host", action: { type: "reveal", index: 40 } });
  assert.throws(() => engine.handleAction({ playerId: "host", action: { type: "restart" }, roundId: next.roundId, observedGameRevision: next.game.revision }), { code: "CONFLICT" });
});

for (const ad of [false, true]) {
  test(`F09: last player leaves ${ad ? "ad" : "prompt"}; spectator can take over`, async () => {
    const engine = await engineAt(Date.now());
    engine.join({ name: "Viewer", role: "spectator", playerId: "viewer", tokenHash: await hash("viewer") });
    await engine.connect({ playerId: "viewer", token: "viewer" });
    incident(engine, Date.now(), ad);
    engine.disconnect({ playerId: "host" });
    assert.ok(engine.snapshot().revival, "pausing must not terminate the incident");
    engine.leave({ playerId: "host" });
    assert.equal(engine.snapshot().revival, null);
    assert.equal(engine.snapshot().game.status, "lost");
    engine.switchRole({ playerId: "viewer", targetRole: "player" });
    engine.handleAction({ playerId: "viewer", action: { type: "restart" } });
    assert.equal(engine.snapshot().game.status, "ready");
  });
}

function environment(room) {
  return { ROOM_CREATE_LIMIT: { limit: async () => ({ success: true }) }, ROOM_JOIN_LIMIT: { limit: async () => ({ success: true }) }, ROOM_SOCKET_LIMIT: { limit: async () => ({ success: true }) }, MINE_ROOMS: { getByName: () => room } };
}
const context = { waitUntil() {}, passThroughOnException() {} };

for (const path of ["/api/rooms", "/api/rooms/ABC234"]) {
  test(`F06/F11: ${path} returns controlled JSON errors and cancels oversized streams early`, async () => {
    const env = environment({ fetch: async () => { throw new Error("downstream failed"); } });
    const invalid = await worker.fetch(new Request(`https://local${path}`, { method: "POST", body: "{" }), env, context);
    assert.equal(invalid.status, 400);
    let pulled = 0; let cancelled = false;
    const stream = new ReadableStream({ pull(controller) { pulled++; controller.enqueue(new Uint8Array(1024)); if (pulled === 64) controller.close(); }, cancel() { cancelled = true; } });
    const oversized = await worker.fetch(new Request(`https://local${path}`, { method: "POST", body: stream, duplex: "half" }), env, context);
    assert.equal(oversized.status, 413);
    assert.equal(cancelled, true);
    assert.ok(pulled < 64);
    const internal = await worker.fetch(new Request(`https://local${path}`, { method: "POST", body: JSON.stringify({ v, name: "小王", role: "player", difficulty: "beginner" }) }), env, context);
    assert.equal(internal.status, 500);
  });
}

test("F02/F11: split UTF-8 JSON and repeated HTTP join share one reservation", async () => {
  const engine = await engineAt(Date.now());
  const fixture = await adapter(engine.serialize(), [socket()]);
  const env = environment(fixture.room);
  const body = new TextEncoder().encode(JSON.stringify({ v, name: "小王", role: "player", idempotencyKey: "a".repeat(64) }));
  const request = () => new Request("https://local/api/rooms/ABC234", { method: "POST", duplex: "half", body: new ReadableStream({ start(controller) { for (const byte of body) controller.enqueue(new Uint8Array([byte])); controller.close(); } }) });
  const first = await (await worker.fetch(request(), env, context)).json();
  const second = await (await worker.fetch(request(), env, context)).json();
  assert.deepEqual(first.session, second.session);
  assert.equal(fixture.values.get("room:core").members.length, 2);
  assert.ok(!JSON.stringify([...fixture.values.values()]).includes(first.session.token));
});

test("F05: server rejects expired new commands but still acknowledges previously applied duplicates", async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const engine = await engineAt(now);
  const host = socket();
  const fixture = await adapter(engine.serialize(), [host]);
  await send(fixture.room, host, command(engine, 1, { type: "mark", index: 0, state: "flagged" }, { expiresAt: now - 1 }));
  assert.equal(host.sent.at(-1).code, "COMMAND_EXPIRED");
  assert.equal(fixture.values.get("room:core").game.flagsPlaced, 0);
  const accepted = command(engine, 2, { type: "mark", index: 0, state: "flagged" });
  await send(fixture.room, host, accepted);
  const writes = fixture.writes.length;
  now += 31_000;
  await send(fixture.room, host, accepted);
  assert.equal(host.sent.at(-1).type, "ack");
  assert.equal(fixture.writes.length, writes);
  assert.equal(fixture.values.get("room:core").game.flagsPlaced, 1);
});

test("migration preserves old paused memberships, watermarks, and a stable round identity", async () => {
  const engine = await engineAt(Date.now());
  const legacy = engine.serialize();
  delete legacy.roundId;
  for (const member of legacy.members) {
    delete member.activatedAt;
    delete member.reservationExpiresAt;
    member.lastSequence = 123;
  }
  const restored = MineRoomEngine.restore(legacy);
  restored.advance(Date.now() + RESERVATION_TTL_MS + 1);
  assert.equal(restored.serialize().members.length, 1);
  assert.equal(restored.lastAcceptedSequence("host"), 123);
  assert.equal(restored.snapshot().roundId, MineRoomEngine.restore(legacy).snapshot().roundId);
});

test("protocol upgrade asks old tabs to refresh without treating their credentials as expired", async () => {
  const engine = await engineAt(Date.now());
  const host = socket();
  const fixture = await adapter(engine.serialize(), [host]);
  await send(fixture.room, host, { ...command(engine, 1, { type: "restart" }), v: 1 });
  assert.equal(host.sent.at(-1).code, "PROTOCOL_MISMATCH");
  assert.equal(host.closes.at(-1).code, 4406);
  assert.equal(fixture.values.get("room:core").members.length, 1);
});

test("G03: unreadable stored state is preserved and initialization fails closed", async () => {
  const engine = await engineAt(Date.now());
  const invalid = { ...engine.serialize(), schemaVersion: 99 };
  const fixture = await adapter(invalid);
  assert.equal(fixture.deleted(), 0);
  assert.equal(fixture.values.get("room:core").schemaVersion, 99);
  const response = await fixture.room.fetch(new Request("https://local/internal/init", { method: "POST", body: "{}" }));
  assert.equal(response.status, 503);
  await fixture.room.alarm();
  assert.equal(fixture.deleted(), 0);
});

test("G05: inherited difficulty names are rejected and spectator cleanup removes rate entries", async () => {
  const engine = await engineAt(Date.now());
  assert.throws(() => engine.handleAction({ playerId: "host", action: { type: "changeDifficulty", difficulty: "toString" } }), { code: "BAD_REQUEST" });
  const state = engine.serialize();
  state.members.push({ ...state.members[0], playerId: "viewer", name: "Viewer", tokenHash: await hash("viewer"), role: "spectator", slot: null, lastSeenAt: Date.now() - 3_600_001 });
  state.chatRates.viewer = { count: 1, resetAt: Date.now() };
  const restored = MineRoomEngine.restore(state);
  restored.advance();
  restored.join({ name: "New", role: "spectator", playerId: "new", tokenHash: await hash("new") });
  assert.equal(restored.serialize().chatRates.viewer, undefined);
});
