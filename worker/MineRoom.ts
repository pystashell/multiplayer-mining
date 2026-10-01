import {
  MINE_PROTOCOL_VERSION,
  MAX_COMMAND_LIFETIME_MS,
  isRoomSession,
  isRoomSessionIdentity,
  type CommandMessage,
  type JoinMessage,
  type PublicRoom,
  type RoomCommand,
  type RoomSessionIdentity,
  type ServerMessage,
} from "../shared/mine-protocol";
import {
  MineRoomEngine,
  MineRoomEngineError,
  type CommandReceipt,
  type EngineMutationResult,
  type RoomIdentity,
  type SerializedMineRoomState,
} from "../shared/mine-room-engine";
import { MessageBudget } from "./message-budget";

const CORE_KEY = "room:core";
const CHAT_KEY = "room:chat";
const RECEIPTS_KEY = "room:receipts";
const memberReceiptsKey = (playerId: string) => `${RECEIPTS_KEY}:${playerId}`;
const SEQUENCES_KEY = "room:sequences";
const MAX_QUEUED_OPERATIONS = 64;
const MAX_SOCKET_CONNECTIONS = 32;
const MAX_PENDING_SOCKET_CONNECTIONS = 8;
const MAX_CLIENT_MESSAGE_BYTES = 4 * 1024;
const JOIN_TIMEOUT_MS = 10_000;

type StoredCore = Omit<SerializedMineRoomState, "chat" | "receipts">;

type SocketAttachment = {
  joined: boolean;
  connectionId: string;
  identity: RoomSessionIdentity | null;
  connectedAt: number;
};

type InternalInitRequest = {
  code?: unknown;
  name?: unknown;
  difficulty?: unknown;
  playerId?: unknown;
  tokenHash?: unknown;
};

type InternalJoinRequest = {
  name?: unknown;
  role?: unknown;
  playerId?: unknown;
  tokenHash?: unknown;
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultAttachment(connectedAt = Date.now()): SocketAttachment {
  return {
    joined: false,
    connectionId: crypto.randomUUID(),
    identity: null,
    connectedAt,
  };
}

function isJoinMessage(value: unknown): value is JoinMessage {
  return isRecord(value)
    && value.v === MINE_PROTOCOL_VERSION
    && value.type === "join"
    && isRoomSession(value.session);
}

function isCommandMessage(value: unknown): value is CommandMessage {
  return isRecord(value)
    && value.v === MINE_PROTOCOL_VERSION
    && value.type === "command"
    && typeof value.id === "string"
    && value.id.length > 0
    && value.id.length <= 128
    && Number.isSafeInteger(value.sequence)
    && Number(value.sequence) > 0
    && typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt)
    && isRecord(value.command)
    && typeof value.command.op === "string";
}

export class MineRoom {
  private readonly ctx: DurableObjectState;
  private engine: MineRoomEngine | null = null;
  private retiring = false;
  private restoreFailed = false;
  private queuedOperations = 0;
  private readonly budget = new MessageBudget();
  private persistedReceiptPlayerIds = new Set<string>();
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Record<string, never>) {
    this.ctx = ctx;
    void env;
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));

    ctx.blockConcurrencyWhile(async () => {
      const [core, chat, receipts, sequences] = await Promise.all([
        ctx.storage.get<StoredCore>(CORE_KEY),
        ctx.storage.get<SerializedMineRoomState["chat"]>(CHAT_KEY),
        ctx.storage.get<SerializedMineRoomState["receipts"]>(RECEIPTS_KEY),
        ctx.storage.get<Record<string, number>>(SEQUENCES_KEY),
      ]);
      if (!core) return;

      try {
        const receiptKeys = core.members.map((member) => memberReceiptsKey(member.playerId));
        const memberReceipts = receiptKeys.length
          ? await ctx.storage.get<CommandReceipt[]>(receiptKeys)
          : new Map<string, CommandReceipt[]>();
        this.persistedReceiptPlayerIds = new Set(core.members.map((member) => member.playerId));
        this.engine = MineRoomEngine.restore({
          ...core,
          members: core.members.map((member) => ({
            ...member, lastSequence: sequences?.[member.playerId] ?? member.lastSequence ?? 0,
          })),
          chat: chat ?? [],
          // Read the old shared partition only when that member has not migrated.
          receipts: core.members.flatMap((member) => memberReceipts.get(memberReceiptsKey(member.playerId))
            ?? (receipts ?? []).filter((receipt) => receipt.playerId === member.playerId)),
        });
      } catch (error) {
        console.error("Unable to restore mine room", error);
        this.engine = null;
        this.restoreFailed = true;
        for (const socket of ctx.getWebSockets()) this.closeSocket(socket, 1011, "Room recovery failed");
        return;
      }

      const now = Date.now();
      for (const socket of ctx.getWebSockets()) {
        const attachment = this.readAttachment(socket);
        if (!attachment.joined || !attachment.identity) continue;
        try {
          this.engine.resumeConnection(
            attachment.identity.playerId,
            attachment.connectionId,
            now,
          );
        } catch {
          this.closeSocket(socket, 4401, "Session expired");
        }
      }

      const advanced = this.engine.advance(now);
      if (advanced.expired) {
        await this.retireRoom("ROOM_EXPIRED", "房间长时间没有活动，已经关闭。", "Room expired");
        return;
      }
      if (advanced.changed) {
        await this.persist();
        if (advanced.room) this.broadcastSnapshot(advanced.room, now);
      }
      await this.scheduleNextAlarm();
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (this.restoreFailed) return jsonResponse({ error: "房间状态恢复失败，原始数据已保留。", code: "RECOVERY_FAILED" }, 503);

    if (request.method === "GET" && url.pathname === "/internal/health") {
      return jsonResponse({ ok: true, service: "mine-room" });
    }
    if (request.method === "POST" && url.pathname === "/internal/init") {
      return this.enqueueResponse(() => this.initialize(request));
    }
    if (request.method === "POST" && url.pathname === "/internal/join") {
      return this.enqueueResponse(() => this.reserveMember(request));
    }
    if (request.method === "GET" && /\/api\/rooms\/[A-HJ-NP-Z2-9]{6}\/socket$/.test(url.pathname)) {
      return this.enqueueResponse(() => this.openSocket(request));
    }
    return jsonResponse({ error: "Not found" }, 404);
  }

  async webSocketMessage(socket: WebSocket, rawMessage: string | ArrayBuffer): Promise<void> {
    if (typeof rawMessage !== "string") {
      this.sendError(socket, "UNSUPPORTED_MESSAGE", "只接受 JSON 文本消息。");
      this.closeSocket(socket, 4400, "JSON text required");
      return;
    }
    if (new TextEncoder().encode(rawMessage).byteLength > MAX_CLIENT_MESSAGE_BYTES) {
      this.sendError(socket, "MESSAGE_TOO_LARGE", "消息超过 4 KiB 限制。");
      this.closeSocket(socket, 4409, "Message too large");
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawMessage);
    } catch {
      this.sendError(socket, "INVALID_JSON", "消息不是有效的 JSON。");
      this.closeSocket(socket, 4400, "Invalid JSON");
      return;
    }

    if (isRecord(parsed) && parsed.v !== MINE_PROTOCOL_VERSION) {
      this.sendError(socket, "PROTOCOL_MISMATCH", "客户端协议版本不兼容，请刷新页面。");
      // Keep credentials: an old tab must not lose its seat merely because
      // the server upgraded while it was disconnected.
      this.closeSocket(socket, 4406, "Please refresh the page");
      return;
    }
    const admitted = this.readAttachment(socket);
    const now = Date.now();
    if (!this.budget.take(`connection:${admitted.connectionId}`, now, 30, 15)
      || (admitted.identity && !this.budget.take(`member:${admitted.identity.playerId}`, now, 30, 15))
      || !this.budget.take("room", now, 120, 60)) {
      this.sendError(socket, "RATE_LIMITED", "操作太频繁，请稍后再试。", isCommandMessage(parsed) ? parsed.id : undefined, true);
      return;
    }

    await this.enqueue(async () => {
      const attachment = this.readAttachment(socket);
      if (!attachment.joined) {
        if (!isJoinMessage(parsed)) {
          this.sendError(socket, "JOIN_REQUIRED", "第一条消息必须是有效的 join 消息。");
          this.closeSocket(socket, 4401, "Join required");
          return;
        }
        await this.joinSocket(socket, attachment, parsed);
        return;
      }

      if (!isCommandMessage(parsed)) {
        this.sendError(socket, "INVALID_COMMAND", "无法识别命令信封。");
        return;
      }
      await this.handleCommand(socket, attachment, parsed);
    }, true).catch((error: unknown) => {
      if (error instanceof MineRoomEngineError) this.sendError(socket, error.code, error.message, isCommandMessage(parsed) ? parsed.id : undefined, true);
      else throw error;
    });
  }

  async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    await this.enqueue(() => this.disconnectSocket(socket));
    // Explicitly finish the close handshake as well as relying on the runtime's
    // auto-reply. This keeps local workerd and older compatibility dates safe.
    try {
      socket.close(code, reason);
    } catch {
      // The peer may already have completed the handshake.
    }
  }

  async webSocketError(socket: WebSocket, error: unknown): Promise<void> {
    console.error("Mine room WebSocket error", error);
    await this.enqueue(() => this.disconnectSocket(socket));
  }

  async alarm(): Promise<void> {
    await this.enqueue(async () => {
      if (this.restoreFailed) return;
      this.closeExpiredPendingSockets(Date.now());
      if (!this.engine) {
        await this.scheduleNextAlarm();
        return;
      }
      const now = Date.now();
      const result = this.engine.advance(now);
      if (result.expired) {
        await this.retireRoom("ROOM_EXPIRED", "房间长时间没有活动，已经关闭。", "Room expired");
        return;
      }
      if (result.changed) {
        await this.persist();
        if (result.room) this.broadcastSnapshot(result.room, now);
      }
      await this.scheduleNextAlarm();
    });
  }

  private async initialize(request: Request): Promise<Response> {
    if (this.engine || this.retiring) return jsonResponse({ error: "房间已经存在。" }, 409);
    try {
      const body = await request.json() as InternalInitRequest;
      if (
        typeof body.code !== "string"
        || typeof body.playerId !== "string"
        || typeof body.tokenHash !== "string"
      ) return jsonResponse({ error: "建房参数不完整。" }, 400);

      this.engine = MineRoomEngine.create({
        code: body.code,
        name: body.name,
        difficulty: body.difficulty,
        playerId: body.playerId,
        tokenHash: body.tokenHash,
      });
      await this.persist();
      await this.scheduleNextAlarm();
      return jsonResponse({ room: this.engine.snapshot() }, 201);
    } catch (error) {
      this.engine = null;
      return this.engineErrorResponse(error);
    }
  }

  private async reserveMember(request: Request): Promise<Response> {
    await this.advanceRoom();
    if (!this.engine || this.retiring) return jsonResponse({ error: "没有找到这个房间。" }, 404);
    try {
      const body = await request.json() as InternalJoinRequest;
      if (typeof body.playerId !== "string" || typeof body.tokenHash !== "string") {
        return jsonResponse({ error: "加入参数不完整。" }, 400);
      }
      const result = this.engine.join({
        name: body.name,
        role: body.role,
        playerId: body.playerId,
        tokenHash: body.tokenHash,
      });
      await this.persist();
      this.broadcastSnapshot(result.room, Date.now());
      await this.scheduleNextAlarm();
      return jsonResponse({ room: result.room }, 201);
    } catch (error) {
      return this.engineErrorResponse(error);
    }
  }

  private async openSocket(request: Request): Promise<Response> {
    await this.advanceRoom();
    if (!this.engine || this.retiring) return jsonResponse({ error: "没有找到这个房间。" }, 404);
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return jsonResponse({ error: "需要 WebSocket upgrade。" }, 426);
    }
    if (this.ctx.getWebSockets().length >= MAX_SOCKET_CONNECTIONS) {
      return jsonResponse({ error: "房间连接已满。" }, 429);
    }
    const pendingConnections = this.ctx.getWebSockets().filter((socket) => {
      const attachment = this.readAttachment(socket);
      return socket.readyState < 2 && !attachment.joined;
    }).length;
    if (pendingConnections >= MAX_PENDING_SOCKET_CONNECTIONS) {
      return jsonResponse({ error: "等待鉴权的连接太多，请稍后再试。" }, 429);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const attachment = defaultAttachment();
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server, ["mine-room"]);
    await this.scheduleNextAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  private async joinSocket(
    socket: WebSocket,
    attachment: SocketAttachment,
    message: JoinMessage,
  ): Promise<void> {
    await this.advanceRoom();
    if (!this.engine || this.retiring) {
      this.sendError(socket, "ROOM_NOT_FOUND", "没有找到这个房间。");
      this.closeSocket(socket, 4404, "Room not found");
      return;
    }
    if (message.session.code !== this.engine.snapshot().code) {
      this.sendError(socket, "ROOM_MISMATCH", "房间身份与连接地址不一致。");
      this.closeSocket(socket, 4401, "Room mismatch");
      return;
    }

    try {
      const connected = await this.engine.connect({
        playerId: message.session.playerId,
        token: message.session.token,
        connectionId: attachment.connectionId,
      });

      for (const existing of this.ctx.getWebSockets()) {
        if (existing === socket) continue;
        const previous = this.readAttachment(existing);
        if (!previous.joined || previous.identity?.playerId !== connected.identity.playerId) continue;
        this.engine.disconnect({ connectionId: previous.connectionId });
        this.sendError(existing, "SESSION_REPLACED", "这个身份已在另一个窗口重连。");
        this.closeSocket(existing, 4408, "Session replaced");
      }

      const identity: RoomSessionIdentity = {
        code: message.session.code,
        playerId: connected.identity.playerId,
        playerName: connected.identity.playerName,
        role: connected.identity.role,
      } as RoomSessionIdentity;
      const nextAttachment: SocketAttachment = {
        ...attachment,
        joined: true,
        identity,
      };
      socket.serializeAttachment(nextAttachment);
      await this.persist();
      const now = Date.now();
      const room = this.engine.snapshot(now);
      this.safeSend(socket, {
        v: MINE_PROTOCOL_VERSION,
        type: "welcome",
        identity,
        lastAcceptedSequence: this.engine.lastAcceptedSequence(identity.playerId),
        snapshot: { room, serverTime: now },
      });
      this.broadcastSnapshot(room, now, socket);
      await this.scheduleNextAlarm();
    } catch (error) {
      const normalized = this.normalizeError(error);
      this.sendError(socket, normalized.code, normalized.message, undefined, normalized.retryable);
      this.closeSocket(socket, normalized.code === "UNAUTHORIZED" ? 4401 : 4403, normalized.code);
    }
  }

  private async handleCommand(
    socket: WebSocket,
    attachment: SocketAttachment,
    message: CommandMessage,
  ): Promise<void> {
    if (!this.engine || !attachment.identity) {
      this.sendError(socket, "ROOM_NOT_FOUND", "没有找到这个房间。", message.id);
      return;
    }

    const playerId = attachment.identity.playerId;
    if (!this.engine.isConnectionActive(playerId, attachment.connectionId)) {
      this.sendError(socket, "SESSION_REPLACED", "这个身份已在另一个窗口重连。", message.id);
      this.closeSocket(socket, 4408, "Session replaced");
      return;
    }
    await this.advanceRoom();
    if (!this.engine) return;
    const now = Date.now();

    if (message.command.op === "sync") {
      if (!this.budget.take(`sync:${playerId}`, now, 1, 1)) {
        this.sendError(socket, "RATE_LIMITED", "同步太频繁，请稍后再试。", message.id, true);
        return;
      }
      const room = this.engine.snapshot(now);
      this.sendSnapshot(socket, room, now);
      this.acknowledge(socket, message, room.version);
      return;
    }

    let decision;
    try {
      decision = this.engine.inspectSequence(playerId, message.id, message.sequence);
    } catch (error) {
      const normalized = this.normalizeError(error);
      this.sendError(socket, normalized.code, normalized.message, message.id, normalized.retryable);
      return;
    }

    if (decision.kind === "duplicate") {
      this.sendReceipt(socket, decision.receipt);
      return;
    }
    if (decision.kind === "stale") {
      this.sendError(socket, "STALE_SEQUENCE", "这条命令已经过期，已同步最新棋盘。", message.id, true, decision.previousSequence);
      this.sendSnapshot(socket, this.engine.snapshot(), Date.now());
      return;
    }

    // Reserve outcome capacity before any mutation. Refusing new work must not
    // consume a sequence or evict an earlier command that can still be retried.
    if (message.command.op !== "leaveMembership") {
      try {
        this.engine.assertReceiptCapacity(playerId, now);
      } catch (error) {
        const normalized = this.normalizeError(error);
        this.sendError(socket, normalized.code, normalized.message, message.id, normalized.retryable);
        return;
      }
    }

    try {
      if (message.expiresAt <= now || message.expiresAt > now + MAX_COMMAND_LIFETIME_MS) {
        throw new MineRoomEngineError("这条命令已经过期。", 409, "COMMAND_EXPIRED");
      }
      const result = this.applyCommand(playerId, message.command);
      if (message.command.op !== "leaveMembership") {
        this.engine.recordSequence({ playerId, id: message.id, sequence: message.sequence });
      }
      await this.persist(!result.changed);

      if (message.command.op === "switchRole" && "identity" in result) {
        const switched = result as EngineMutationResult & { identity: RoomIdentity };
        const identity = {
          ...attachment.identity,
          playerName: switched.identity.playerName,
          role: switched.identity.role,
        } as RoomSessionIdentity;
        socket.serializeAttachment({ ...attachment, identity });
        this.safeSend(socket, { v: MINE_PROTOCOL_VERSION, type: "session", identity });
      }

      if (message.command.op === "leaveMembership") {
        socket.serializeAttachment({ ...attachment, joined: false, identity: null });
      }

      this.acknowledge(socket, message, result.revision);
      if (result.changed) this.broadcastSnapshot(result.room, Date.now());
      await this.scheduleNextAlarm();
      if (message.command.op === "leaveMembership") {
        this.closeSocket(socket, 1000, "Membership left");
      }
    } catch (error) {
      const normalized = this.normalizeError(error);
      try {
        if (message.command.op !== "leaveMembership") {
          this.engine.recordSequence({
            playerId,
            id: message.id,
            sequence: message.sequence,
            error: normalized,
          });
          await this.persist(true);
        }
      } catch (receiptError) {
        console.error("Unable to persist rejected command receipt", receiptError);
      }
      this.sendError(socket, normalized.code, normalized.message, message.id, normalized.retryable);
      if (normalized.code === "STALE_ROUND" || normalized.code === "CONFLICT") {
        this.sendSnapshot(socket, this.engine.snapshot(), Date.now());
      }
    }
  }

  private applyCommand(playerId: string, command: RoomCommand) {
    if (!this.engine) throw new MineRoomEngineError("没有找到这个房间。", 404, "ROOM_NOT_FOUND");
    if (command.op === "action") {
      if (typeof command.roundId !== "string" || !command.roundId
        || !command.action || typeof command.action !== "object"
        || ((command.action.type === "restart" || command.action.type === "changeDifficulty")
          && !Number.isSafeInteger(command.observedGameRevision))) {
        throw new MineRoomEngineError("操作缺少局次或棋盘版本，请刷新页面。", 400, "BAD_REQUEST");
      }
      return this.engine.handleAction({ playerId, action: command.action, roundId: command.roundId, observedGameRevision: command.observedGameRevision });
    }
    if (command.op === "chat") {
      return this.engine.postChat({
        playerId,
        content: command.content,
        stickerId: command.stickerId,
      });
    }
    if (command.op === "switchRole") return this.engine.switchRole({ playerId, targetRole: command.targetRole });
    if (command.op === "leaveMembership") return this.engine.leave({ playerId });
    throw new MineRoomEngineError("无法识别这个命令。", 400, "BAD_REQUEST");
  }

  private async disconnectSocket(socket: WebSocket): Promise<void> {
    await this.advanceRoom();
    if (!this.engine) return;
    const attachment = this.readAttachment(socket);
    if (!attachment.joined || !attachment.identity) return;
    try {
      const result = this.engine.disconnect({ connectionId: attachment.connectionId });
      await this.persist();
      this.broadcastSnapshot(result.room, Date.now(), socket);
      await this.scheduleNextAlarm();
    } catch (error) {
      console.error("Unable to disconnect mine room socket", error);
    }
  }

  private async persist(receiptsOnly = false): Promise<void> {
    if (!this.engine) return;
    const serialized = this.engine.serialize();
    const { chat, receipts, ...core } = serialized;
    const sequences = Object.fromEntries(core.members.map((member) => [member.playerId, member.lastSequence]));
    const receiptPartitions = Object.fromEntries(core.members.map((member) => [
      memberReceiptsKey(member.playerId), receipts.filter((receipt) => receipt.playerId === member.playerId),
    ]));
    const memberIds = new Set(core.members.map((member) => member.playerId));
    const removedKeys = [...this.persistedReceiptPlayerIds]
      .filter((playerId) => !memberIds.has(playerId)).map(memberReceiptsKey);
    // Sequence watermarks and receipts are committed together, including no-ops.
    // Per-member keys keep the retained window below the storage value limit.
    // Issue writes/deletes without an intervening await so storage coalesces
    // them atomically; departing members must not leave unbounded stale keys.
    const writes = [this.ctx.storage.put({
      ...(!receiptsOnly ? { [CORE_KEY]: core, [CHAT_KEY]: chat } : {}),
      [RECEIPTS_KEY]: [],
      ...receiptPartitions,
      [SEQUENCES_KEY]: sequences,
    })];
    if (removedKeys.length) writes.push(this.ctx.storage.delete(removedKeys).then(() => undefined));
    await Promise.all(writes);
    this.persistedReceiptPlayerIds = memberIds;
  }

  private async advanceRoom(): Promise<void> {
    if (!this.engine) return;
    const now = Date.now();
    const result = this.engine.advance(now);
    if (result.expired) {
      await this.retireRoom("ROOM_EXPIRED", "房间长时间没有活动，已经关闭。", "Room expired");
    } else if (result.changed) {
      await this.persist();
      if (result.room) this.broadcastSnapshot(result.room, now);
    }
    await this.scheduleNextAlarm();
  }

  private async scheduleNextAlarm(): Promise<void> {
    const roomDueAt = this.engine?.nextDueAt() ?? Number.POSITIVE_INFINITY;
    const joinDueAt = this.ctx.getWebSockets().reduce((earliest, socket) => {
      if (socket.readyState >= 2) return earliest;
      const attachment = this.readAttachment(socket);
      return attachment.joined
        ? earliest
        : Math.min(earliest, attachment.connectedAt + JOIN_TIMEOUT_MS);
    }, Number.POSITIVE_INFINITY);
    const nextAt = Math.min(roomDueAt, joinDueAt);
    if (!Number.isFinite(nextAt)) {
      if ((await this.ctx.storage.getAlarm()) !== null) await this.ctx.storage.deleteAlarm();
      return;
    }
    const scheduledAt = Math.max(Date.now() + 1, nextAt);
    const current = await this.ctx.storage.getAlarm();
    if (current === null || Math.abs(current - scheduledAt) > 5) {
      await this.ctx.storage.setAlarm(scheduledAt);
    }
  }

  private closeExpiredPendingSockets(now: number): void {
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState >= 2) continue;
      const attachment = this.readAttachment(socket);
      if (!attachment.joined && now >= attachment.connectedAt + JOIN_TIMEOUT_MS) {
        this.sendError(socket, "JOIN_TIMEOUT", "没有及时收到 join 消息。");
        this.closeSocket(socket, 4401, "Join timeout");
      }
    }
  }

  private async retireRoom(code: string, message: string, reason: string): Promise<void> {
    if (this.retiring) return;
    this.retiring = true;
    this.engine = null;
    for (const socket of this.ctx.getWebSockets()) {
      this.sendError(socket, code, message);
      this.closeSocket(socket, 4404, reason);
    }
    try {
      if ((await this.ctx.storage.getAlarm()) !== null) await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
    } finally {
      this.retiring = false;
    }
  }

  private broadcastSnapshot(room: PublicRoom, now: number, excluded?: WebSocket): void {
    const payload = JSON.stringify({ v: MINE_PROTOCOL_VERSION, type: "snapshot", snapshot: { room, serverTime: now } });
    for (const socket of this.joinedSockets(excluded)) this.safeSend(socket, payload);
  }

  private sendSnapshot(socket: WebSocket, room: PublicRoom, serverTime: number): void {
    this.safeSend(socket, {
      v: MINE_PROTOCOL_VERSION,
      type: "snapshot",
      snapshot: { room, serverTime },
    });
  }

  private joinedSockets(excluded?: WebSocket): WebSocket[] {
    return this.ctx.getWebSockets().filter((socket) => {
      if (socket === excluded || socket.readyState !== 1) return false;
      const attachment = this.readAttachment(socket);
      return attachment.joined && attachment.identity !== null;
    });
  }

  private acknowledge(socket: WebSocket, message: CommandMessage, revision: number): void {
    this.safeSend(socket, {
      v: MINE_PROTOCOL_VERSION,
      type: "ack",
      id: message.id,
      sequence: message.sequence,
      ok: true,
      revision,
    });
  }

  private sendReceipt(socket: WebSocket, receipt: CommandReceipt): void {
    if (receipt.ok) {
      this.safeSend(socket, {
        v: MINE_PROTOCOL_VERSION,
        type: "ack",
        id: receipt.id,
        sequence: receipt.sequence,
        ok: true,
        revision: receipt.revision,
      });
      return;
    }
    this.sendError(
      socket,
      receipt.error?.code ?? "COMMAND_REJECTED",
      receipt.error?.message ?? "命令已被拒绝。",
      receipt.id,
      receipt.error?.retryable,
    );
  }

  private sendError(
    socket: WebSocket,
    code: string,
    message: string,
    id?: string,
    retryable?: boolean,
    lastAcceptedSequence?: number,
  ): void {
    const payload: ServerMessage = {
      v: MINE_PROTOCOL_VERSION,
      type: "error",
      code,
      message,
      ...(id ? { id } : {}),
      ...(retryable !== undefined ? { retryable } : {}),
      ...(lastAcceptedSequence !== undefined ? { lastAcceptedSequence } : {}),
    };
    this.safeSend(socket, payload);
  }

  private safeSend(socket: WebSocket, message: ServerMessage | string): void {
    if (socket.readyState !== 1) return;
    try {
      socket.send(typeof message === "string" ? message : JSON.stringify(message));
    } catch (error) {
      console.error("Unable to send mine room message", error);
    }
  }

  private closeSocket(socket: WebSocket, code: number, reason: string): void {
    if (socket.readyState >= 2) return;
    try {
      socket.close(code, reason.slice(0, 120));
    } catch (error) {
      console.error("Unable to close mine room socket", error);
    }
  }

  private readAttachment(socket: WebSocket): SocketAttachment {
    const value = socket.deserializeAttachment();
    if (!isRecord(value)) return defaultAttachment();
    const identity = isRoomSessionIdentity(value.identity) ? value.identity : null;
    return {
      joined: value.joined === true && identity !== null,
      connectionId: typeof value.connectionId === "string" ? value.connectionId : crypto.randomUUID(),
      identity,
      connectedAt: typeof value.connectedAt === "number" && Number.isFinite(value.connectedAt)
        ? value.connectedAt
        : Date.now(),
    };
  }

  private normalizeError(error: unknown) {
    if (error instanceof MineRoomEngineError) {
      return { code: error.code, message: error.message, retryable: error.retryable };
    }
    console.error("Unexpected mine room error", error);
    return { code: "INTERNAL_ERROR", message: "房间服务暂时开小差了。", retryable: true };
  }

  private engineErrorResponse(error: unknown): Response {
    if (error instanceof MineRoomEngineError) {
      return jsonResponse({ error: error.message, code: error.code, retryable: error.retryable }, error.status);
    }
    console.error("Unexpected mine room request error", error);
    return jsonResponse({ error: "房间服务暂时开小差了。" }, 500);
  }

  private enqueue(task: () => Promise<void> | void, bounded = false): Promise<void> {
    if (bounded && this.queuedOperations >= MAX_QUEUED_OPERATIONS) {
      return Promise.reject(new MineRoomEngineError("房间繁忙，请稍后再试。", 503, "RATE_LIMITED", true));
    }
    this.queuedOperations += 1;
    const run = this.operationQueue.then(task, task).finally(() => { this.queuedOperations -= 1; });
    this.operationQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private enqueueResponse(task: () => Promise<Response>): Promise<Response> {
    if (this.queuedOperations >= MAX_QUEUED_OPERATIONS) return Promise.resolve(jsonResponse({ error: "房间繁忙，请稍后再试。" }, 503));
    this.queuedOperations += 1;
    const run = this.operationQueue.then(task, task).finally(() => { this.queuedOperations -= 1; });
    this.operationQueue = run.then(() => undefined, () => undefined);
    return run;
  }
}
