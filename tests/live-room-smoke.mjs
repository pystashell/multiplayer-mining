import assert from "node:assert/strict";
import { MINE_PROTOCOL_VERSION as protocolVersion } from "../shared/mine-protocol.ts";

const baseUrl = (process.env.MINEFIELD_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
const socketBase = baseUrl.replace(/^http/, "ws");

function endpoint(pathname) {
  return `${baseUrl}${pathname}`;
}

async function readResponse(response, expectedStatuses) {
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Expected JSON from ${response.url}, received: ${text.slice(0, 300)}`);
  }

  if (!expectedStatuses.includes(response.status)) {
    throw new Error(
      `Request failed (${response.status}) at ${response.url}: ${JSON.stringify(payload)}`,
    );
  }
  return payload;
}

async function createRoom(name) {
  const response = await fetch(endpoint("/api/rooms"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      v: protocolVersion,
      name,
      difficulty: "beginner",
    }),
  });
  return readResponse(response, [201]);
}

async function joinRoom(roomCode, name) {
  const response = await fetch(endpoint(`/api/rooms/${roomCode}`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      v: protocolVersion,
      name,
      role: "player",
    }),
  });
  return readResponse(response, [200, 201]);
}

class RoomClient {
  constructor(roomCode, session, { sequence = 0 } = {}) {
    this.roomCode = roomCode;
    this.session = session;
    this.sequence = sequence;
    this.messages = [];
    this.waiters = [];
    this.socket = null;
    this.closeEvent = null;
    this.closeWaiters = [];
  }

  cursor() {
    return this.messages.length;
  }

  async connect({ timeoutMs = 10_000 } = {}) {
    const socketUrl = `${socketBase}/api/rooms/${this.roomCode}/socket`;
    this.socket = new WebSocket(socketUrl);
    this.socket.addEventListener("message", (event) => {
      let message;
      try {
        const rawMessage = String(event.data);
        message = rawMessage === "pong" ? { type: "heartbeat" } : JSON.parse(rawMessage);
      } catch (error) {
        for (const waiter of this.waiters.splice(0)) {
          clearTimeout(waiter.timer);
          waiter.reject(new Error(`Server sent invalid JSON: ${String(event.data)}`, { cause: error }));
        }
        return;
      }

      const index = this.messages.push(message) - 1;
      if (message.snapshot) {
        this.room = message.snapshot.room;
        this.serverOffset = message.snapshot.serverTime - Date.now();
      }
      for (const waiter of [...this.waiters]) {
        if (index < waiter.startIndex || !waiter.predicate(message)) continue;
        this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    });
    this.socket.addEventListener("close", (event) => {
      this.closeEvent = event;
      for (const waiter of this.closeWaiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.resolve(event);
      }
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WebSocket open timed out")), timeoutMs);
      this.socket.addEventListener("open", () => {
        clearTimeout(timer);
        this.socket.send(JSON.stringify({
          v: protocolVersion,
          type: "join",
          session: this.session,
        }));
        resolve();
      }, { once: true });
      this.socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`WebSocket connection failed at ${socketUrl}`));
      }, { once: true });
    });

    const outcome = await this.waitFor(
      (message) => message.type === "welcome" || message.type === "error",
      { timeoutMs },
    );
    if (outcome.type === "error") {
      throw new Error(`Room join failed (${outcome.code}): ${outcome.message}`);
    }

    assert.equal(outcome.identity.code, this.session.code);
    assert.equal(outcome.identity.playerId, this.session.playerId);
    this.session = { ...this.session, ...outcome.identity, token: this.session.token };
    this.sequence = Math.max(this.sequence, outcome.lastAcceptedSequence);
    return outcome;
  }

  send(command, { id = crypto.randomUUID(), sequence } = {}) {
    if (command.op === "action") command = { ...command, roundId: this.room.roundId, observedGameRevision: this.room.game.revision };
    const nextSequence = sequence ?? this.sequence + 1;
    this.sequence = Math.max(this.sequence, nextSequence);
    const message = {
      v: protocolVersion,
      type: "command",
      id,
      sequence: nextSequence,
      expiresAt: Date.now() + (this.serverOffset ?? 0) + 30_000,
      command,
    };
    this.sendRaw(message);
    return message;
  }

  sendRaw(message) {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      throw new Error("Cannot send because the room socket is not open");
    }
    this.socket.send(JSON.stringify(message));
  }

  waitFor(predicate, { timeoutMs = 15_000, startIndex = 0 } = {}) {
    for (let index = startIndex; index < this.messages.length; index += 1) {
      const message = this.messages[index];
      if (predicate(message)) return Promise.resolve(message);
    }

    return new Promise((resolve, reject) => {
      const waiter = { predicate, startIndex, resolve, reject, timer: 0 };
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
        reject(new Error(`Timed out waiting for room message; recent=${JSON.stringify(this.messages.slice(-5))}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  waitForClose(timeoutMs = 5_000) {
    if (this.closeEvent) return Promise.resolve(this.closeEvent);
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: 0 };
      waiter.timer = setTimeout(() => {
        this.closeWaiters = this.closeWaiters.filter((candidate) => candidate !== waiter);
        reject(new Error("Timed out waiting for room socket to close"));
      }, timeoutMs);
      this.closeWaiters.push(waiter);
    });
  }

  async disconnect(code = 4001, reason = "smoke reconnect") {
    if (!this.socket || this.socket.readyState >= WebSocket.CLOSING) return this.closeEvent;
    const closed = this.waitForClose();
    this.socket.close(code, reason);
    return closed;
  }

  close() {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.close(1000, "smoke test complete");
    }
  }
}

const suffix = crypto.randomUUID().slice(0, 6);
const hostName = `Host-${suffix}`;
const guestName = `Guest-${suffix}`;
const created = await createRoom(hostName);
const roomCode = created.roomCode;

assert.match(roomCode, /^[A-HJ-NP-Z2-9]{6}$/);
assert.equal(created.session.code, roomCode);
assert.equal(created.session.role, "player");
assert.equal(created.session.playerName, hostName);
assert.ok(created.session.token);

const joined = await joinRoom(roomCode, guestName);
assert.equal(joined.session.code, roomCode);
assert.equal(joined.session.role, "player");
assert.equal(joined.session.playerName, guestName);
assert.ok(joined.session.token);

const host = new RoomClient(roomCode, created.session);
const guest = new RoomClient(roomCode, joined.session);
let reconnectedHost = null;

try {
  const hostWelcome = await host.connect();
  const guestWelcome = await guest.connect();
  const hostPlayerId = hostWelcome.identity.playerId;
  const guestPlayerId = guestWelcome.identity.playerId;

  assert.equal(hostWelcome.snapshot.room.code, roomCode);
  assert.equal(guestWelcome.snapshot.room.code, roomCode);
  assert.equal("token" in hostWelcome.identity, false);
  assert.equal("token" in guestWelcome.identity, false);
  assert.notEqual(hostPlayerId, guestPlayerId);
  assert.equal(guestWelcome.snapshot.room.players.length, 2);
  assert.equal(
    guestWelcome.snapshot.room.players.find((player) => player.id === hostPlayerId)?.name,
    hostName,
  );
  assert.equal(
    guestWelcome.snapshot.room.players.find((player) => player.id === guestPlayerId)?.name,
    guestName,
  );

  const hostCursor = host.cursor();
  const guestCursor = guest.cursor();
  const revealStartedAt = performance.now();
  const reveal = host.send({ op: "action", action: { type: "reveal", index: 0 } });
  const [revealAck, hostReveal, guestReveal] = await Promise.all([
    host.waitFor(
      (message) => message.type === "ack" && message.id === reveal.id,
      { startIndex: hostCursor },
    ),
    host.waitFor(
      (message) => message.type === "snapshot"
        && message.snapshot.room.game.cells[0]?.state === "revealed",
      { startIndex: hostCursor },
    ),
    guest.waitFor(
      (message) => message.type === "snapshot"
        && message.snapshot.room.game.cells[0]?.state === "revealed",
      { startIndex: guestCursor },
    ),
  ]);
  const pushLatencyMs = Math.round(performance.now() - revealStartedAt);

  assert.equal(hostReveal.snapshot.room.version, revealAck.revision);
  assert.equal(guestReveal.snapshot.room.version, revealAck.revision);
  assert.ok(hostReveal.snapshot.room.game.cells.every((cell) => cell.mine === undefined));
  assert.ok(guestReveal.snapshot.room.game.cells.every((cell) => cell.mine === undefined));

  const chatText = `duplicate-sequence-${crypto.randomUUID()}`;
  const chatCursor = guest.cursor();
  const hostChatCursor = host.cursor();
  const chat = guest.send({ op: "chat", content: chatText });
  const [chatAck, hostChat] = await Promise.all([
    guest.waitFor(
      (message) => message.type === "ack" && message.id === chat.id,
      { startIndex: chatCursor },
    ),
    host.waitFor(
      (message) => message.type === "snapshot"
        && message.snapshot.room.chat.some((entry) => entry.content === chatText),
      { startIndex: hostChatCursor },
    ),
  ]);

  assert.equal(
    hostChat.snapshot.room.chat.filter((entry) => entry.content === chatText).length,
    1,
  );

  const duplicateCursor = guest.cursor();
  guest.sendRaw(chat);
  const duplicateAck = await guest.waitFor(
    (message) => message.type === "ack"
      && message.id === chat.id
      && message.sequence === chat.sequence,
    { startIndex: duplicateCursor },
  );
  assert.equal(duplicateAck.revision, chatAck.revision);

  const syncCursor = guest.cursor();
  const sync = guest.send({ op: "sync" });
  const [syncAck, synced] = await Promise.all([
    guest.waitFor(
      (message) => message.type === "ack" && message.id === sync.id,
      { startIndex: syncCursor },
    ),
    guest.waitFor(
      (message) => message.type === "snapshot"
        && message.snapshot.room.chat.some((entry) => entry.content === chatText),
      { startIndex: syncCursor },
    ),
  ]);
  assert.equal(syncAck.revision, chatAck.revision);
  assert.equal(
    synced.snapshot.room.chat.filter((entry) => entry.content === chatText).length,
    1,
  );

  const delayed = {
    v: protocolVersion, type: "command", id: crypto.randomUUID(), sequence: ++guest.sequence,
    expiresAt: Date.now() + 30_000,
    command: { op: "action", action: { type: "mark", index: 0, state: "flagged" }, roundId: guest.room.roundId },
  };
  const restartHostCursor = host.cursor();
  const restartGuestCursor = guest.cursor();
  const restartRound = host.send({ op: "action", action: { type: "restart" } });
  await Promise.all([
    host.waitFor((message) => message.type === "ack" && message.id === restartRound.id, { startIndex: restartHostCursor }),
    host.waitFor((message) => message.type === "snapshot" && message.snapshot.room.roundId !== delayed.command.roundId, { startIndex: restartHostCursor }),
    guest.waitFor((message) => message.type === "snapshot" && message.snapshot.room.roundId !== delayed.command.roundId, { startIndex: restartGuestCursor }),
  ]);
  const delayedCursor = guest.cursor();
  guest.sendRaw(delayed);
  const rejectedRound = await guest.waitFor((message) => message.type === "error" && message.id === delayed.id, { startIndex: delayedCursor });
  assert.equal(rejectedRound.code, "STALE_ROUND");
  assert.equal(guest.room.game.status, "ready");
  assert.equal(guest.room.game.flags, 0);

  const guestOfflineCursor = guest.cursor();
  await host.disconnect();
  await guest.waitFor(
    (message) => message.type === "snapshot"
      && message.snapshot.room.players.some(
        (player) => player.id === hostPlayerId && player.online === false,
      ),
    { startIndex: guestOfflineCursor },
  );

  const guestOnlineCursor = guest.cursor();
  reconnectedHost = new RoomClient(roomCode, host.session);
  const reconnectWelcome = await reconnectedHost.connect();
  assert.equal(reconnectWelcome.identity.playerId, hostPlayerId);
  assert.ok(reconnectWelcome.lastAcceptedSequence >= host.sequence);
  assert.equal(
    reconnectWelcome.snapshot.room.players.find((player) => player.id === hostPlayerId)?.online,
    true,
  );
  await guest.waitFor(
    (message) => message.type === "snapshot"
      && message.snapshot.room.players.some(
        (player) => player.id === hostPlayerId && player.online === true,
      ),
    { startIndex: guestOnlineCursor },
  );

  const reconnectCursor = reconnectedHost.cursor();
  const reconnectSync = reconnectedHost.send({ op: "sync" });
  const [reconnectAck, reconnectSnapshot] = await Promise.all([
    reconnectedHost.waitFor(
      (message) => message.type === "ack" && message.id === reconnectSync.id,
      { startIndex: reconnectCursor },
    ),
    reconnectedHost.waitFor(
      (message) => message.type === "snapshot" && message.snapshot.room.code === roomCode,
      { startIndex: reconnectCursor },
    ),
  ]);
  assert.equal(reconnectSnapshot.snapshot.room.version, reconnectAck.revision);
  assert.equal(
    reconnectSnapshot.snapshot.room.chat.filter((entry) => entry.content === chatText).length,
    1,
  );

  const heartbeatCursor = reconnectedHost.cursor();
  reconnectedHost.socket.send("ping");
  await reconnectedHost.waitFor(
    (message) => message.type === "heartbeat",
    { startIndex: heartbeatCursor },
  );

  let activeRoom = reconnectSnapshot.snapshot.room;
  let incidentRoom = null;
  for (let attempt = 0; attempt < 200 && !incidentRoom; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 75));
    if (activeRoom.game.status === "won" || activeRoom.game.status === "lost") {
      const restartCursor = reconnectedHost.cursor();
      const restart = reconnectedHost.send({ op: "action", action: { type: "restart" } });
      const restarted = await reconnectedHost.waitFor(
        (message) => message.type === "snapshot" && message.snapshot.room.version > activeRoom.version,
        { startIndex: restartCursor },
      );
      await reconnectedHost.waitFor(
        (message) => message.type === "ack" && message.id === restart.id,
        { startIndex: restartCursor },
      );
      activeRoom = restarted.snapshot.room;
    }

    const candidate = activeRoom.game.cells.find((cell) => cell.state !== "revealed" && cell.state !== "flagged");
    if (!candidate) continue;
    const actionCursor = reconnectedHost.cursor();
    const action = reconnectedHost.send({ op: "action", action: { type: "reveal", index: candidate.index } });
    const [actionAck, actionSnapshot] = await Promise.all([
      reconnectedHost.waitFor(
        (message) => message.type === "ack" && message.id === action.id,
        { startIndex: actionCursor },
      ),
      reconnectedHost.waitFor(
        (message) => message.type === "snapshot" && message.snapshot.room.version >= activeRoom.version,
        { startIndex: actionCursor },
      ),
    ]);
    assert.equal(actionSnapshot.snapshot.room.version, actionAck.revision);
    activeRoom = actionSnapshot.snapshot.room;
    if (activeRoom.revival?.phase === "prompt") incidentRoom = activeRoom;
  }
  assert.ok(incidentRoom, "Expected to hit a mine while exercising the real alarm path");

  const adCursor = reconnectedHost.cursor();
  const guestAlarmCursor = guest.cursor();
  const watchAd = reconnectedHost.send({ op: "action", action: { type: "watchAd" } });
  const [adAck, adSnapshot] = await Promise.all([
    reconnectedHost.waitFor(
      (message) => message.type === "ack" && message.id === watchAd.id,
      { startIndex: adCursor },
    ),
    reconnectedHost.waitFor(
      (message) => message.type === "snapshot" && message.snapshot.room.revival?.phase === "ad",
      { startIndex: adCursor },
    ),
  ]);
  assert.equal(adSnapshot.snapshot.room.version, adAck.revision);
  const alarmStartedAt = performance.now();
  const alarmSnapshot = await guest.waitFor(
    (message) => message.type === "snapshot"
      && message.snapshot.room.version > adSnapshot.snapshot.room.version
      && message.snapshot.room.revival === null,
    { startIndex: guestAlarmCursor, timeoutMs: 20_000 },
  );
  const alarmRevivalMs = Math.round(performance.now() - alarmStartedAt);
  assert.equal(alarmSnapshot.snapshot.room.game.status, "playing");

  const leaveCursor = guest.cursor();
  const hostLeaveCursor = reconnectedHost.cursor();
  const leave = guest.send({ op: "leaveMembership" });
  const [leaveAck, membershipClose, memberRemoved] = await Promise.all([
    guest.waitFor(
      (message) => message.type === "ack" && message.id === leave.id,
      { startIndex: leaveCursor },
    ),
    guest.waitForClose(),
    reconnectedHost.waitFor(
      (message) => message.type === "snapshot"
        && !message.snapshot.room.players.some((player) => player.id === guestPlayerId),
      { startIndex: hostLeaveCursor },
    ),
  ]);
  assert.equal(leaveAck.sequence, leave.sequence);
  assert.equal(membershipClose.code, 1000);
  assert.equal(membershipClose.reason, "Membership left");
  assert.equal(memberRemoved.snapshot.room.players.length, 1);

  console.log(JSON.stringify({
    ok: true,
    roomCode,
    hostPlayerId,
    guestPlayerId,
    pushedRevealWithoutPolling: true,
    pushLatencyMs,
    chatBroadcastToPeer: true,
    duplicateSequenceWasIdempotent: true,
    reconnectedToSamePlayer: true,
    sequenceRecoveredFromServer: true,
    crossPlayerOldRoundRejected: true,
    hibernationHeartbeatAutoResponse: true,
    alarmRevivalWithoutPolling: true,
    alarmRevivalMs,
    membershipLeaveClosedSocket: true,
    synchronizedRevision: reconnectSnapshot.snapshot.room.version,
  }, null, 2));
} finally {
  host.close();
  guest.close();
  reconnectedHost?.close();
}
