import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { MineRoomEngine } from "../shared/mine-room-engine.ts";
import { MINE_PROTOCOL_VERSION as v } from "../shared/mine-protocol.ts";

const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost/", pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
const { useMineRoomSocket } = await import("../app/useMineRoomSocket.ts");
const { MinefieldApp } = await import("../app/MinefieldApp.tsx");
const session = { code: "ABC234", playerId: "host", playerName: "Host", token: "secret", role: "player" };

function clock(t) {
  let now = 1_000_000; let id = 0;
  const timers = new Map();
  t.mock.method(Date, "now", () => now);
  const schedule = (fn, delay = 0, interval = 0) => { const next = ++id; timers.set(next, { fn, at: now + delay, interval }); return next; };
  window.setTimeout = (fn, ms) => schedule(fn, ms);
  window.setInterval = (fn, ms) => schedule(fn, ms, ms);
  window.clearTimeout = window.clearInterval = (timer) => timers.delete(timer);
  return {
    jump(ms) { now += ms; },
    async tick(ms) {
      await act(async () => {
        const end = now + ms;
        for (let n = 0; n < 1000; n++) {
          const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
          if (!next) break;
          const [key, timer] = next;
          now = Math.max(now, timer.at);
          if (timer.interval) timer.at = now + timer.interval;
          else timers.delete(key);
          timer.fn();
          await Promise.resolve();
        }
        now = end;
      });
    },
  };
}

function sockets() {
  const instances = [];
  class Socket extends window.EventTarget {
    static OPEN = 1; static CLOSING = 2;
    readyState = 0; sent = [];
    constructor() { super(); instances.push(this); }
    send(raw) { this.sent.push(raw === "ping" ? raw : JSON.parse(raw)); }
    close(code, reason) { this.readyState = 3; this.closed = { code, reason }; }
    open() { this.readyState = 1; this.dispatchEvent(new window.Event("open")); }
    receive(value) { this.dispatchEvent(new window.MessageEvent("message", { data: typeof value === "string" ? value : JSON.stringify(value) })); }
    networkClose(code = 1006) { this.readyState = 3; this.dispatchEvent(new window.CloseEvent("close", { code })); }
  }
  globalThis.WebSocket = Socket;
  return instances;
}

async function mount(t, options = {}) {
  const time = clock(t);
  const connections = sockets();
  const storage = window.localStorage;
  const storageFaults = [];
  storage.clear();
  if (options.storage === "corrupt") storage.setItem("shared-minefield.socket.v1.last", "ABC234");
  if (options.storage === "corrupt") storage.setItem("shared-minefield.socket.v1.ABC234", "{");
  if (options.storage === "throw") {
    for (const method of ["getItem", "setItem", "removeItem"]) t.mock.method(window.Storage.prototype, method, () => { storageFaults.push(method); throw new window.DOMException("blocked", "SecurityError"); });
  }
  if (options.storage === "getter") Object.defineProperty(window, "localStorage", { configurable: true, get() { storageFaults.push("getter"); throw new window.DOMException("blocked", "SecurityError"); } });
  const engine = MineRoomEngine.create({ code: "ABC234", name: "Host", difficulty: "beginner", playerId: "host", tokenHash: "a".repeat(64), now: Date.now() });
  let api;
  const root = createRoot(document.getElementById("root"));
  function App() { api = useMineRoomSocket(); return createElement("div", null, api.status); }
  await act(async () => root.render(createElement(options.ui ? MinefieldApp : App, options.ui ? { initialLocale: "en" } : {})));
  t.after(async () => {
    await act(async () => root.unmount());
    Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
  });
  const welcome = async (watermark = 0) => {
    const ws = connections.at(-1);
    await act(async () => { ws.open(); ws.receive({ v, type: "welcome", identity: { code: session.code, playerId: session.playerId, playerName: session.playerName, role: session.role }, lastAcceptedSequence: watermark, snapshot: { room: engine.snapshot(), serverTime: Date.now() } }); });
    return ws;
  };
  const connect = async (watermark = 0) => { await act(async () => api.connect(session)); return welcome(watermark); };
  return { time, connections, engine, welcome, connect, storageFaults, api: () => api };
}

test("F05: overdue but unscheduled timeout rejects without replaying the old command", async (t) => {
  const app = await mount(t); const first = await app.connect();
  let result;
  await act(async () => { result = app.api().sendAction({ type: "restart" }).catch((error) => error); });
  const sent = first.sent.find((message) => message.type === "command");
  app.time.jump(31_000);
  const second = await app.connect();
  assert.equal((await result).code, "COMMAND_TIMEOUT");
  assert.ok(!second.sent.some((message) => message.id === sent.id));
});

test("F05: an already-fired timeout is also absent from reconnect replay", async (t) => {
  const app = await mount(t); const first = await app.connect();
  let result;
  await act(async () => { result = app.api().sendChat("expired").catch((error) => error); });
  const original = first.sent.find((message) => message.command?.op === "chat");
  await app.time.tick(25_000);
  await act(async () => first.receive("pong"));
  await app.time.tick(5_001);
  assert.equal((await result).code, "COMMAND_TIMEOUT");
  const second = await app.connect();
  assert.ok(!second.sent.some((message) => message.id === original.id));
});

test("F05/F08: unexpired pending envelopes keep their original identity across high-water recovery", async (t) => {
  const app = await mount(t); const first = await app.connect();
  let pending;
  await act(async () => { pending = app.api().sendChat("hello").catch((error) => error); });
  const original = first.sent.find((message) => message.command?.op === "chat");
  app.time.jump(5_000);
  const second = await app.connect(1000);
  assert.deepEqual(second.sent.find((message) => message.id === original.id), original);
  await act(async () => second.receive({ v, type: "ack", id: original.id, sequence: original.sequence, ok: true, revision: 1 }));
  assert.equal((await pending).ok, true);
  await act(async () => { void app.api().sendChat("new").catch(() => {}); });
  assert.ok(second.sent.findLast((message) => message.command?.op === "chat").sequence > 1000);
});

test("F05: an acknowledged command is absent from reconnect replay", async (t) => {
  const app = await mount(t); const first = await app.connect();
  let pending;
  await act(async () => { pending = app.api().sendChat("hello"); });
  const original = first.sent.find((message) => message.command?.op === "chat");
  await act(async () => first.receive({ v, type: "ack", id: original.id, sequence: original.sequence, ok: true, revision: 1 }));
  await pending;
  const second = await app.connect();
  assert.ok(!second.sent.some((message) => message.id === original.id));
});

test("F08: missing local sequence and stale errors calibrate the first new action", async (t) => {
  const app = await mount(t); const ws = await app.connect(1000);
  await act(async () => { void app.api().sendChat("hello").catch(() => {}); });
  const first = ws.sent.find((message) => message.command?.op === "chat");
  assert.equal(first.sequence, 1001);
  await act(async () => ws.receive({ v, type: "error", id: first.id, code: "STALE_SEQUENCE", message: "stale", lastAcceptedSequence: 2000 }));
  await act(async () => { void app.api().sendChat("new").catch(() => {}); });
  assert.equal(ws.sent.findLast((message) => message.command?.op === "chat").sequence, 2001);
});

test("F07: lost pong reconnects and late close from the old socket is ignored", async (t) => {
  const app = await mount(t); const first = await app.connect();
  await app.time.tick(25_000);
  assert.equal(first.sent.at(-1), "ping");
  await app.time.tick(10_500);
  assert.equal(app.connections.length, 2);
  const second = await app.welcome();
  await act(async () => first.networkClose());
  assert.equal(app.api().status, "connected");
  assert.equal(app.connections.at(-1), second);
});

test("F07: a timely pong prevents reconnect; a late pong cannot resurrect a dead socket", async (t) => {
  const app = await mount(t); const ws = await app.connect();
  await app.time.tick(25_000);
  app.time.jump(5_000);
  await act(async () => ws.receive("pong"));
  await app.time.tick(10_000);
  assert.equal(app.connections.length, 1);
  await app.time.tick(35_000);
  app.time.jump(10_001);
  await act(async () => ws.receive("pong"));
  await app.time.tick(500);
  assert.equal(app.connections.length, 2);
});

test("F07: welcome handshake has its own deadline", async (t) => {
  const app = await mount(t);
  await act(async () => app.api().connect(session));
  await act(async () => app.connections[0].open());
  await app.time.tick(10_500);
  assert.equal(app.connections.length, 2);
  assert.equal(app.api().status, "reconnecting");
});

test("F07: background resume checks overdue pong immediately", async (t) => {
  const app = await mount(t); await app.connect();
  await app.time.tick(25_000);
  app.time.jump(20_000);
  await act(async () => document.dispatchEvent(new window.Event("visibilitychange")));
  assert.equal(app.api().status, "reconnecting");
  await app.time.tick(500);
  assert.equal(app.connections.length, 2);
});

for (const failure of ["throw", "getter", "corrupt", "normal"]) {
  test(`F10: ${failure} storage permits creating and leaving an in-memory session`, async (t) => {
    const app = await mount(t, { storage: failure });
    if (failure === "corrupt") assert.equal(app.api().resumeLastRoom(), false);
    t.mock.method(globalThis, "fetch", async () => Response.json({ roomCode: session.code, session, room: app.engine.snapshot() }, { status: 201 }));
    await act(async () => app.api().createRoom("Host", "beginner"));
    const ws = await app.welcome();
    assert.equal(app.api().session.playerId, "host");
    let leaving;
    await act(async () => { leaving = app.api().leaveMembership(); });
    const message = ws.sent.findLast((item) => item.command?.op === "leaveMembership");
    await act(async () => ws.receive({ v, type: "ack", id: message.id, sequence: message.sequence, ok: true, revision: 2 }));
    await leaving;
    assert.equal(app.api().session, null);
    if (failure === "throw") {
      assert.ok(app.storageFaults.includes("setItem"));
      assert.ok(app.storageFaults.includes("removeItem"));
    }
    if (failure === "getter") assert.ok(app.storageFaults.length > 0);
  });
}

test("F10: real page can submit a create form when the localStorage getter throws", async (t) => {
  const app = await mount(t, { storage: "getter", ui: true });
  t.mock.method(globalThis, "fetch", async () => Response.json({ roomCode: session.code, session, room: app.engine.snapshot() }, { status: 201 }));
  const input = document.querySelector('input');
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, "Host");
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await act(async () => document.querySelector("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
  assert.equal(app.connections.length, 1);
  await app.welcome();
  await app.time.tick(1);
  assert.match(document.body.textContent, /ABC234/);
  await act(async () => document.querySelector(".leave-button").click());
  assert.ok(document.querySelector(".resume-room"));
  assert.equal(document.querySelector(".mine-console"), null);
  await act(async () => document.querySelector(".resume-room").click());
  await app.welcome();
  assert.ok(document.querySelector(".mine-console"));
  await act(async () => document.querySelector(".membership-exit-button").click());
  const ws = app.connections.at(-1);
  const leave = ws.sent.findLast((message) => message.command?.op === "leaveMembership");
  await act(async () => ws.receive({ v, type: "ack", id: leave.id, sequence: leave.sequence, ok: true, revision: 2 }));
  assert.equal(document.querySelector(".mine-console"), null);
  assert.equal(document.querySelector(".resume-room"), null);
});
