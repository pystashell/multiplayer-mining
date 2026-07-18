import {
  DIFFICULTY_PRESETS,
  createGame,
  reduceGameAction,
  type GameAction as EngineGameAction,
  type GameState,
  type RandomSource,
} from "../lib/minesweeper.ts";
import {
  isRoomCode,
  type ChatMessage,
  type Difficulty,
  type PlayerSlot,
  type PublicCell,
  type PublicGame,
  type PublicRoom,
  type RoomActivity,
  type RoomRevival,
  type RoomRole,
  type WireAction,
} from "./mine-protocol.ts";

export const ROOM_TTL_MS = 24 * 60 * 60 * 1_000;
export const SEEN_WRITE_INTERVAL_MS = 8_000;
export const MAX_PLAYERS = 4;
export const MAX_SPECTATORS = 20;
export const SPECTATOR_STALE_MS = 60 * 60 * 1_000;
export const MAX_ACTIVITY = 12;
export const MAX_CHAT_MESSAGES = 100;
export const RETURNED_CHAT_MESSAGES = 40;
export const CHAT_RATE_LIMIT = 8;
export const CHAT_RATE_WINDOW_MS = 30_000;
export const REVIVAL_AD_MS = 10_000;

const SERIALIZED_SCHEMA_VERSION = 1 as const;
const MAX_RECEIPTS = 256;
const TOKEN_HASH_PATTERN = /^[a-f0-9]{64}$/;

type LosingWireAction = Extract<WireAction, { type: "reveal" | "chord" }>;
type BoardWireAction = Exclude<WireAction, { type: "watchAd" | "endGame" }>;

export type PersistedRoomIncident = {
  phase: "prompt" | "ad";
  triggeredById: string;
  triggeredByName: string;
  action: LosingWireAction;
  createdAt: number;
  adEndsAt: number | null;
};

export type PersistedRoomMember = {
  playerId: string;
  name: string;
  tokenHash: string;
  role: RoomRole;
  slot: PlayerSlot | null;
  joinedAt: number;
  lastSeenAt: number;
  lastSequence: number;
};

export type PersistedChatRate = {
  count: number;
  resetAt: number;
};

export type CommandReceipt = {
  playerId: string;
  id: string;
  sequence: number;
  revision: number;
  createdAt: number;
  ok: boolean;
  error?: {
    code: string;
    message: string;
    retryable?: boolean;
  };
};

export type SerializedMineRoomState = {
  schemaVersion: typeof SERIALIZED_SCHEMA_VERSION;
  code: string;
  version: number;
  game: GameState;
  members: PersistedRoomMember[];
  chat: ChatMessage[];
  activity: RoomActivity[];
  incident: PersistedRoomIncident | null;
  chatRates: Record<string, PersistedChatRate>;
  receipts: CommandReceipt[];
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  expiredAt: number | null;
};

export type RoomIdentity = {
  playerId: string;
  playerName: string;
  role: RoomRole;
  slot: PlayerSlot | null;
};

export type EngineMutationResult = {
  changed: boolean;
  revision: number;
  room: PublicRoom;
  nextDueAt: number | null;
};

export type AdvanceResult = {
  changed: boolean;
  expired: boolean;
  revision: number;
  room: PublicRoom | null;
  nextDueAt: number | null;
};

export type SequenceDecision =
  | { kind: "new"; previousSequence: number }
  | { kind: "duplicate"; receipt: CommandReceipt }
  | { kind: "stale"; previousSequence: number };

export type MineRoomEngineOptions = {
  random?: RandomSource;
  createId?: () => string;
};

export type CreateMineRoomInput = {
  code: string;
  name: unknown;
  difficulty: unknown;
  playerId: string;
  tokenHash: string;
  now?: number;
};

export type ReserveMemberInput = {
  name: unknown;
  role: unknown;
  playerId: string;
  tokenHash: string;
  now?: number;
};

export type AuthenticateInput = {
  playerId: string;
  token: string;
  now?: number;
};

export type ConnectInput = AuthenticateInput & {
  connectionId?: string;
};

export type MineRoomErrorCode =
  | "BAD_ROOM_STATE"
  | "ROOM_NOT_FOUND"
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "ROOM_FULL"
  | "SPECTATOR_FULL"
  | "RATE_LIMITED"
  | "CONFLICT";

export class MineRoomEngineError extends Error {
  readonly status: number;
  readonly code: MineRoomErrorCode;
  readonly retryable: boolean;

  constructor(
    message: string,
    status = 400,
    code: MineRoomErrorCode = "BAD_REQUEST",
    retryable = false,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function readNow(value: number | undefined): number {
  const now = value ?? Date.now();
  if (!Number.isFinite(now)) throw new MineRoomEngineError("时间戳无效。", 400, "BAD_REQUEST");
  return now;
}

function normalizeName(input: unknown): string {
  if (typeof input !== "string") throw new MineRoomEngineError("请填写你的名字。", 400, "BAD_REQUEST");
  const name = input.replace(/\s+/g, " ").trim();
  if (!name) throw new MineRoomEngineError("请填写你的名字。", 400, "BAD_REQUEST");
  if ([...name].length > 16) throw new MineRoomEngineError("名字最多 16 个字。", 400, "BAD_REQUEST");
  return name;
}

function normalizeChatContent(input: unknown): string {
  if (typeof input !== "string") throw new MineRoomEngineError("请输入聊天内容。", 400, "BAD_REQUEST");
  const content = input
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "")
    .trim();
  if (!content) throw new MineRoomEngineError("请输入聊天内容。", 400, "BAD_REQUEST");
  if ([...content].length > 240) {
    throw new MineRoomEngineError("聊天内容最多 240 个字。", 400, "BAD_REQUEST");
  }
  return content;
}

function normalizeDifficulty(input: unknown): Difficulty {
  if (typeof input === "string" && input in DIFFICULTY_PRESETS) return input as Difficulty;
  throw new MineRoomEngineError("这个难度不存在。", 400, "BAD_REQUEST");
}

function normalizeRole(input: unknown): RoomRole {
  if (input === "player" || input === "spectator") return input;
  throw new MineRoomEngineError("无法识别房间身份。", 400, "BAD_REQUEST");
}

function normalizePlayerId(input: unknown): string {
  if (typeof input !== "string" || !input || input.length > 128) {
    throw new MineRoomEngineError("房间身份无效。", 400, "BAD_REQUEST");
  }
  return input;
}

function normalizeTokenHash(input: unknown): string {
  if (typeof input !== "string" || !TOKEN_HASH_PATTERN.test(input.toLowerCase())) {
    throw new MineRoomEngineError("房间凭据无效。", 400, "BAD_REQUEST");
  }
  return input.toLowerCase();
}

function normalizeCode(input: unknown): string {
  if (typeof input !== "string" || !isRoomCode(input)) {
    throw new MineRoomEngineError("房间码应为 6 位。", 400, "BAD_REQUEST");
  }
  return input;
}

async function hashToken(token: string): Promise<string> {
  if (!token || token.length > 256) {
    throw new MineRoomEngineError("房间身份已失效，请重新加入。", 401, "UNAUTHORIZED");
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function coordinateLabel(index: number, width: number): string {
  const col = index % width;
  const row = Math.floor(index / width) + 1;
  const column = col < 26 ? String.fromCharCode(65 + col) : `A${String.fromCharCode(65 + col - 26)}`;
  return `${column}${row}`;
}

function shiftStartedAtForPause(game: GameState, incident: PersistedRoomIncident, settledAt: number): GameState {
  if (game.startedAt === null) return game;
  return { ...game, startedAt: game.startedAt + Math.max(0, settledAt - incident.createdAt) };
}

function publicGame(game: GameState): PublicGame {
  const terminal = game.status === "won" || game.status === "lost";
  const difficulty = game.difficulty in DIFFICULTY_PRESETS ? game.difficulty as Difficulty : "beginner";
  const cells = game.cells.map((cell, index): PublicCell => {
    let state: PublicCell["state"] = "hidden";
    if (cell.isExploded) state = "revealed";
    else if (cell.isFlagged) state = "flagged";
    else if (cell.isRevealed) state = "revealed";
    else if (cell.isQuestioned) state = "questioned";

    const result: PublicCell = {
      index,
      row: cell.y,
      col: cell.x,
      state,
      adjacent: cell.isRevealed && !cell.isMine ? cell.adjacentMines : null,
    };
    if (terminal && cell.isMine) result.mine = true;
    if (cell.isExploded) result.exploded = true;
    if (terminal && cell.isFlagged && !cell.isMine) result.wrongFlag = true;
    return result;
  });

  return {
    difficulty,
    width: game.width,
    height: game.height,
    mines: game.mineCount,
    flags: game.flagsPlaced,
    revealed: game.revealedSafeCells,
    status: game.status,
    startedAt: game.startedAt,
    endedAt: game.endedAt,
    cells,
  };
}

function validateIndex(index: unknown, game: GameState): number {
  if (!Number.isSafeInteger(index) || (index as number) < 0 || (index as number) >= game.cells.length) {
    throw new MineRoomEngineError("这个格子不在棋盘里。", 400, "BAD_REQUEST");
  }
  return index as number;
}

function translateAction(action: BoardWireAction, game: GameState): { engine: EngineGameAction; detail?: string } {
  if (!action || typeof action !== "object" || typeof action.type !== "string") {
    throw new MineRoomEngineError("无法识别这一步。", 400, "BAD_REQUEST");
  }
  if (action.type === "restart") return { engine: { type: "restart" } };
  if (action.type === "changeDifficulty") {
    const difficulty = normalizeDifficulty(action.difficulty);
    return { engine: { type: "changeDifficulty", difficulty }, detail: difficulty };
  }
  if (action.type !== "reveal" && action.type !== "mark" && action.type !== "chord") {
    throw new MineRoomEngineError("无法识别这一步。", 400, "BAD_REQUEST");
  }
  const index = validateIndex(action.index, game);
  const x = index % game.width;
  const y = Math.floor(index / game.width);
  if (action.type === "mark") {
    if (action.state !== "hidden" && action.state !== "flagged" && action.state !== "questioned") {
      throw new MineRoomEngineError("无法识别这个标记。", 400, "BAD_REQUEST");
    }
    return {
      engine: { type: "setMark", x, y, mark: action.state },
      detail: coordinateLabel(index, game.width),
    };
  }
  return { engine: { type: action.type, x, y }, detail: coordinateLabel(index, game.width) };
}

function activityForAction(before: GameState, after: GameState, wire: BoardWireAction, detail?: string) {
  if (before.status !== "lost" && after.status === "lost") return { type: "boom", detail };
  if (before.status !== "won" && after.status === "won") return { type: "win", detail };
  if (wire.type === "mark") {
    const cell = after.cells[wire.index];
    if (cell.isFlagged) return { type: "flag", detail };
    if (cell.isQuestioned) return { type: "question", detail };
    return { type: "unmark", detail };
  }
  if (wire.type === "changeDifficulty") {
    return { type: "difficulty", detail: wire.difficulty };
  }
  return { type: wire.type, detail };
}

function validateRestoredState(value: SerializedMineRoomState): void {
  if (
    value.schemaVersion !== SERIALIZED_SCHEMA_VERSION
    || !isRoomCode(value.code)
    || !Number.isSafeInteger(value.version)
    || value.version < 1
    || !Array.isArray(value.members)
    || !Array.isArray(value.chat)
    || !Array.isArray(value.activity)
    || !value.game
  ) {
    throw new MineRoomEngineError("房间持久化状态无效。", 500, "BAD_ROOM_STATE");
  }

  const slots = new Set<number>();
  let players = 0;
  let spectators = 0;
  for (const member of value.members) {
    normalizePlayerId(member.playerId);
    normalizeName(member.name);
    normalizeTokenHash(member.tokenHash);
    if (member.role === "player") {
      players += 1;
      if (![1, 2, 3, 4].includes(member.slot as number) || slots.has(member.slot as number)) {
        throw new MineRoomEngineError("房间玩家席位状态无效。", 500, "BAD_ROOM_STATE");
      }
      slots.add(member.slot as number);
    } else if (member.role === "spectator" && member.slot === null) {
      spectators += 1;
    } else {
      throw new MineRoomEngineError("房间成员状态无效。", 500, "BAD_ROOM_STATE");
    }
  }
  if (players > MAX_PLAYERS || spectators > MAX_SPECTATORS) {
    throw new MineRoomEngineError("房间成员数量无效。", 500, "BAD_ROOM_STATE");
  }
}

export class MineRoomEngine {
  private readonly connections = new Map<string, string>();
  private readonly random?: RandomSource;
  private readonly createId: () => string;
  private state: SerializedMineRoomState;

  private constructor(state: SerializedMineRoomState, options: MineRoomEngineOptions = {}) {
    this.state = state;
    this.random = options.random;
    this.createId = options.createId ?? (() => crypto.randomUUID());
  }

  static create(input: CreateMineRoomInput, options: MineRoomEngineOptions = {}): MineRoomEngine {
    const now = readNow(input.now);
    const code = normalizeCode(input.code);
    const playerId = normalizePlayerId(input.playerId);
    const name = normalizeName(input.name);
    const tokenHash = normalizeTokenHash(input.tokenHash);
    const difficulty = normalizeDifficulty(input.difficulty);
    const createId = options.createId ?? (() => crypto.randomUUID());
    const state: SerializedMineRoomState = {
      schemaVersion: SERIALIZED_SCHEMA_VERSION,
      code,
      version: 1,
      game: createGame(difficulty),
      members: [{
        playerId,
        name,
        tokenHash,
        role: "player",
        slot: 1,
        joinedAt: now,
        lastSeenAt: now,
        lastSequence: 0,
      }],
      chat: [],
      activity: [{
        id: createId(),
        playerId,
        playerName: name,
        type: "create",
        createdAt: now,
      }],
      incident: null,
      chatRates: {},
      receipts: [],
      createdAt: now,
      updatedAt: now,
      expiresAt: now + ROOM_TTL_MS,
      expiredAt: null,
    };
    return new MineRoomEngine(state, options);
  }

  static restore(serialized: SerializedMineRoomState | string, options: MineRoomEngineOptions = {}): MineRoomEngine {
    let state: SerializedMineRoomState;
    try {
      state = typeof serialized === "string" ? JSON.parse(serialized) as SerializedMineRoomState : clone(serialized);
    } catch {
      throw new MineRoomEngineError("房间持久化状态无法读取。", 500, "BAD_ROOM_STATE");
    }
    validateRestoredState(state);
    state.chat = state.chat.slice(-MAX_CHAT_MESSAGES);
    state.activity = state.activity.slice(0, MAX_ACTIVITY);
    state.receipts = (state.receipts ?? []).slice(-MAX_RECEIPTS);
    state.chatRates ??= {};
    for (const member of state.members) member.lastSequence ??= 0;
    return new MineRoomEngine(state, options);
  }

  serialize(): SerializedMineRoomState {
    return clone(this.state);
  }

  snapshot(nowInput?: number): PublicRoom {
    const now = readNow(nowInput);
    this.assertAvailable(now);
    const players = this.state.members
      .filter((member) => member.role === "player")
      .sort((left, right) => (left.slot ?? 0) - (right.slot ?? 0))
      .map((member) => ({
        id: member.playerId,
        name: member.name,
        slot: member.slot as PlayerSlot,
        online: this.isOnline(member),
        lastSeenAt: member.lastSeenAt,
      }));
    const spectators = this.state.members
      .filter((member) => member.role === "spectator")
      .sort((left, right) => left.joinedAt - right.joinedAt || left.playerId.localeCompare(right.playerId))
      .map((member) => ({
        id: member.playerId,
        name: member.name,
        online: this.isOnline(member),
        lastSeenAt: member.lastSeenAt,
      }));
    const revival: RoomRevival | null = this.state.incident
      ? {
          phase: this.state.incident.phase,
          triggeredById: this.state.incident.triggeredById,
          triggeredByName: this.state.incident.triggeredByName,
          createdAt: this.state.incident.createdAt,
          adEndsAt: this.state.incident.adEndsAt,
        }
      : null;
    return {
      code: this.state.code,
      version: this.state.version,
      game: publicGame(this.state.game),
      players,
      spectators,
      chat: clone(this.state.chat.slice(-RETURNED_CHAT_MESSAGES)),
      revival,
      activity: clone(this.state.activity),
      updatedAt: this.state.updatedAt,
    };
  }

  join(input: ReserveMemberInput): EngineMutationResult & { identity: RoomIdentity } {
    const now = readNow(input.now);
    this.prepare(now);
    const playerId = normalizePlayerId(input.playerId);
    const name = normalizeName(input.name);
    const tokenHash = normalizeTokenHash(input.tokenHash);
    const role = normalizeRole(input.role);
    const existing = this.member(playerId);
    if (existing) {
      if (!constantTimeEqual(existing.tokenHash, tokenHash)) {
        throw new MineRoomEngineError("这个身份已经属于其他连接。", 409, "CONFLICT");
      }
      return { ...this.result(false, now), identity: this.identity(existing) };
    }
    if (this.state.members.some((member) => constantTimeEqual(member.tokenHash, tokenHash))) {
      throw new MineRoomEngineError("这个房间凭据已经使用。", 409, "CONFLICT");
    }

    this.pruneStaleSpectators(now);
    let slot: PlayerSlot | null = null;
    if (role === "player") {
      slot = this.nextOpenSlot();
      if (!slot) throw new MineRoomEngineError("这个房间已经有四个人了。", 409, "ROOM_FULL");
    } else if (this.spectatorCount() >= MAX_SPECTATORS) {
      throw new MineRoomEngineError("这个房间已经有 20 位旁观者了。", 409, "SPECTATOR_FULL");
    }

    const member: PersistedRoomMember = {
      playerId,
      name,
      tokenHash,
      role,
      slot,
      joinedAt: now,
      lastSeenAt: now,
      lastSequence: 0,
    };
    this.state.members.push(member);
    if (role === "player") this.pushActivity(member, "join", undefined, now);
    this.commit(now);
    return { ...this.result(true, now), identity: this.identity(member) };
  }

  async authenticate(input: AuthenticateInput): Promise<RoomIdentity> {
    const now = readNow(input.now);
    this.prepare(now);
    const playerId = normalizePlayerId(input.playerId);
    const member = this.requireMember(playerId);
    const suppliedHash = await hashToken(input.token);
    if (!constantTimeEqual(member.tokenHash, suppliedHash)) {
      throw new MineRoomEngineError("房间身份已失效，请重新加入。", 401, "UNAUTHORIZED");
    }
    this.touchMember(member, now);
    return this.identity(member);
  }

  async connect(input: ConnectInput): Promise<EngineMutationResult & { identity: RoomIdentity; connectionId: string }> {
    const identity = await this.authenticate(input);
    const now = readNow(input.now);
    const connectionId = input.connectionId ?? this.createId();
    this.connections.set(connectionId, identity.playerId);
    return { ...this.result(false, now), identity, connectionId };
  }

  resumeConnection(playerIdInput: string, connectionId: string, nowInput?: number): RoomIdentity {
    const now = readNow(nowInput);
    this.prepare(now);
    const playerId = normalizePlayerId(playerIdInput);
    const member = this.requireMember(playerId);
    this.connections.set(connectionId, playerId);
    this.touchMember(member, now);
    return this.identity(member);
  }

  isConnectionActive(playerIdInput: string, connectionId: string): boolean {
    const playerId = normalizePlayerId(playerIdInput);
    return this.connections.get(connectionId) === playerId;
  }

  disconnect(input: { connectionId?: string; playerId?: string; now?: number }): EngineMutationResult {
    const now = readNow(input.now);
    this.prepare(now);
    let playerId = input.playerId;
    if (input.connectionId) {
      playerId ??= this.connections.get(input.connectionId);
      this.connections.delete(input.connectionId);
    } else if (playerId) {
      for (const [connectionId, connectedPlayerId] of this.connections) {
        if (connectedPlayerId === playerId) this.connections.delete(connectionId);
      }
    }
    if (playerId) {
      const member = this.member(playerId);
      if (member) this.touchMember(member, now, true);
    }
    return this.result(false, now);
  }

  touch(playerIdInput: string, nowInput?: number): EngineMutationResult {
    const now = readNow(nowInput);
    this.prepare(now);
    const member = this.requireMember(normalizePlayerId(playerIdInput));
    this.touchMember(member, now);
    return this.result(false, now);
  }

  leave(input: { playerId: string; now?: number }): EngineMutationResult & { left: true } {
    const now = readNow(input.now);
    this.prepare(now);
    const playerId = normalizePlayerId(input.playerId);
    this.requireMember(playerId);
    this.state.members = this.state.members.filter((member) => member.playerId !== playerId);
    delete this.state.chatRates[playerId];
    for (const [connectionId, connectedPlayerId] of this.connections) {
      if (connectedPlayerId === playerId) this.connections.delete(connectionId);
    }
    this.commit(now);
    return { ...this.result(true, now), left: true };
  }

  switchRole(input: { playerId: string; targetRole: unknown; now?: number }): EngineMutationResult & { identity: RoomIdentity } {
    const now = readNow(input.now);
    this.prepare(now);
    const member = this.requireMember(normalizePlayerId(input.playerId));
    const targetRole = normalizeRole(input.targetRole);
    if (member.role === targetRole) {
      this.touchMember(member, now);
      return { ...this.result(false, now), identity: this.identity(member) };
    }
    if (this.state.incident) {
      throw new MineRoomEngineError("踩雷事故处理期间不能切换身份。", 409, "CONFLICT");
    }

    if (targetRole === "spectator") {
      this.pruneStaleSpectators(now);
      if (this.spectatorCount() >= MAX_SPECTATORS) {
        throw new MineRoomEngineError("这个房间已经有 20 位旁观者了。", 409, "SPECTATOR_FULL");
      }
      member.role = "spectator";
      member.slot = null;
    } else {
      const slot = this.nextOpenSlot();
      if (!slot) throw new MineRoomEngineError("这个房间已经有四位玩家了。", 409, "ROOM_FULL");
      member.role = "player";
      member.slot = slot;
    }
    member.lastSeenAt = now;
    this.commit(now);
    return { ...this.result(true, now), identity: this.identity(member) };
  }

  postChat(input: { playerId: string; content: unknown; now?: number }): EngineMutationResult {
    const now = readNow(input.now);
    this.prepare(now);
    const member = this.requireMember(normalizePlayerId(input.playerId));
    const content = normalizeChatContent(input.content);
    const current = this.state.chatRates[member.playerId];
    const rate = !current || current.resetAt <= now
      ? { count: 0, resetAt: now + CHAT_RATE_WINDOW_MS }
      : current;
    if (rate.count >= CHAT_RATE_LIMIT) {
      const seconds = Math.max(1, Math.ceil((rate.resetAt - now) / 1_000));
      throw new MineRoomEngineError(`发得太快了，请 ${seconds} 秒后再试。`, 429, "RATE_LIMITED", true);
    }
    this.state.chatRates[member.playerId] = { count: rate.count + 1, resetAt: rate.resetAt };
    this.state.chat.push({
      id: this.createId(),
      senderId: member.playerId,
      senderName: member.name,
      senderRole: member.role,
      senderSlot: member.slot,
      content,
      createdAt: now,
    });
    this.state.chat = this.state.chat.slice(-MAX_CHAT_MESSAGES);
    this.commit(now);
    return this.result(true, now);
  }

  handleAction(input: {
    playerId: string;
    action: WireAction;
    observedVersion?: number;
    now?: number;
  }): EngineMutationResult {
    const now = readNow(input.now);
    this.prepare(now);
    const member = this.requireMember(normalizePlayerId(input.playerId));
    if (member.role !== "player") {
      throw new MineRoomEngineError("旁观者不能操作雷区。", 403, "FORBIDDEN");
    }
    this.touchMember(member, now);
    const action = input.action;
    if (!action || typeof action !== "object" || typeof action.type !== "string") {
      throw new MineRoomEngineError("无法识别这一步。", 400, "BAD_REQUEST");
    }
    if (action.type === "restart" && input.observedVersion !== undefined && input.observedVersion !== this.state.version) {
      throw new MineRoomEngineError("队友刚好也动了一步，棋盘已刷新，请再点一次。", 409, "CONFLICT", true);
    }

    const incident = this.state.incident;
    if (incident) {
      if (action.type === "watchAd") {
        if (incident.phase === "ad") return this.result(false, now);
        this.state.incident = { ...incident, phase: "ad", adEndsAt: now + REVIVAL_AD_MS };
        this.pushActivity(member, "ad", undefined, now);
        this.commit(now);
        return this.result(true, now);
      }
      if (action.type === "endGame") {
        if (incident.phase === "ad") {
          throw new MineRoomEngineError("广告已经开始了，大家看完就能继续扫雷。", 409, "CONFLICT");
        }
        const before = shiftStartedAtForPause(this.state.game, incident, now);
        const translated = translateAction(incident.action, before);
        const after = reduceGameAction(before, translated.engine, {
          actorId: incident.triggeredById,
          now: () => now,
          ...(this.random ? { random: this.random } : {}),
        });
        if (before.status === "lost" || after.status !== "lost") {
          throw new MineRoomEngineError("这次踩雷已经无法重放，请重新开局。", 409, "CONFLICT");
        }
        this.state.game = after;
        this.state.incident = null;
        this.pushActivity(member, "end", undefined, now);
        this.commit(now);
        return this.result(true, now);
      }
      throw new MineRoomEngineError("有人踩雷了，请先选择看广告复活或结束游戏。", 409, "CONFLICT");
    }

    if (action.type === "watchAd" || action.type === "endGame") {
      throw new MineRoomEngineError("现在没有需要处理的踩雷事故。", 409, "CONFLICT");
    }

    const before = this.state.game;
    const translated = translateAction(action, before);
    const after = reduceGameAction(before, translated.engine, {
      actorId: member.playerId,
      now: () => now,
      ...(this.random ? { random: this.random } : {}),
    });
    if (after === before) return this.result(false, now);

    if (before.status !== "lost" && after.status === "lost") {
      if (action.type !== "reveal" && action.type !== "chord") {
        throw new MineRoomEngineError("无法识别这次踩雷事故。", 500, "BAD_ROOM_STATE");
      }
      this.state.incident = {
        phase: "prompt",
        triggeredById: member.playerId,
        triggeredByName: member.name,
        action: { type: action.type, index: action.index },
        createdAt: now,
        adEndsAt: null,
      };
      // Deliberately do not assign `after`: it contains the private lost board.
      this.pushActivity(member, "incident", undefined, now);
      this.commit(now);
      return this.result(true, now);
    }

    this.state.game = after;
    const activity = activityForAction(before, after, action, translated.detail);
    this.pushActivity(member, activity.type, activity.detail, now);
    this.commit(now);
    return this.result(true, now);
  }

  advance(nowInput?: number): AdvanceResult {
    const now = readNow(nowInput);
    if (this.state.expiredAt !== null) {
      return { changed: false, expired: true, revision: this.state.version, room: null, nextDueAt: null };
    }
    if (now >= this.state.expiresAt) {
      this.state.expiredAt = now;
      this.state.updatedAt = now;
      this.state.version += 1;
      return { changed: true, expired: true, revision: this.state.version, room: null, nextDueAt: null };
    }
    const incident = this.state.incident;
    if (incident?.phase === "ad" && incident.adEndsAt !== null && now >= incident.adEndsAt) {
      const pausedGame = shiftStartedAtForPause(this.state.game, incident, now);
      this.state.game = { ...pausedGame, revision: pausedGame.revision + 1 };
      this.state.incident = null;
      this.pushActivity(
        { playerId: incident.triggeredById, name: incident.triggeredByName },
        "revive",
        undefined,
        now,
      );
      this.commit(now);
      return {
        changed: true,
        expired: false,
        revision: this.state.version,
        room: this.snapshot(now),
        nextDueAt: this.nextDueAt(),
      };
    }
    return {
      changed: false,
      expired: false,
      revision: this.state.version,
      room: this.snapshot(now),
      nextDueAt: this.nextDueAt(),
    };
  }

  nextDueAt(): number | null {
    if (this.state.expiredAt !== null) return null;
    const adEndsAt = this.state.incident?.phase === "ad" ? this.state.incident.adEndsAt : null;
    return adEndsAt === null ? this.state.expiresAt : Math.min(this.state.expiresAt, adEndsAt);
  }

  inspectSequence(playerIdInput: string, id: string, sequence: number): SequenceDecision {
    const playerId = normalizePlayerId(playerIdInput);
    const member = this.requireMember(playerId);
    if (!id || id.length > 128 || !Number.isSafeInteger(sequence) || sequence <= 0) {
      throw new MineRoomEngineError("命令编号无效。", 400, "BAD_REQUEST");
    }
    const receipt = this.state.receipts.find(
      (candidate) => candidate.playerId === playerId && candidate.id === id && candidate.sequence === sequence,
    );
    if (receipt) return { kind: "duplicate", receipt: clone(receipt) };
    if (sequence <= member.lastSequence) return { kind: "stale", previousSequence: member.lastSequence };
    return { kind: "new", previousSequence: member.lastSequence };
  }

  recordSequence(input: {
    playerId: string;
    id: string;
    sequence: number;
    now?: number;
    error?: { code: string; message: string; retryable?: boolean };
  }): CommandReceipt {
    const now = readNow(input.now);
    const decision = this.inspectSequence(input.playerId, input.id, input.sequence);
    if (decision.kind === "duplicate") return decision.receipt;
    if (decision.kind === "stale") {
      throw new MineRoomEngineError("这条命令已经过期。", 409, "CONFLICT");
    }
    const member = this.requireMember(input.playerId);
    member.lastSequence = input.sequence;
    const receipt: CommandReceipt = {
      playerId: member.playerId,
      id: input.id,
      sequence: input.sequence,
      revision: this.state.version,
      createdAt: now,
      ok: input.error === undefined,
      ...(input.error ? { error: clone(input.error) } : {}),
    };
    this.state.receipts.push(receipt);
    this.state.receipts = this.state.receipts.slice(-MAX_RECEIPTS);
    return clone(receipt);
  }

  private prepare(now: number): void {
    const advanced = this.advance(now);
    if (advanced.expired) throw new MineRoomEngineError("没有找到这个房间，可能已经过期了。", 404, "ROOM_NOT_FOUND");
  }

  private assertAvailable(now: number): void {
    if (this.state.expiredAt !== null || now >= this.state.expiresAt) {
      throw new MineRoomEngineError("没有找到这个房间，可能已经过期了。", 404, "ROOM_NOT_FOUND");
    }
  }

  private member(playerId: string): PersistedRoomMember | undefined {
    return this.state.members.find((candidate) => candidate.playerId === playerId);
  }

  private requireMember(playerId: string): PersistedRoomMember {
    const member = this.member(playerId);
    if (!member) throw new MineRoomEngineError("房间身份已失效，请重新加入。", 401, "UNAUTHORIZED");
    return member;
  }

  private identity(member: PersistedRoomMember): RoomIdentity {
    return {
      playerId: member.playerId,
      playerName: member.name,
      role: member.role,
      slot: member.slot,
    };
  }

  private nextOpenSlot(): PlayerSlot | null {
    const occupied = new Set(this.state.members.filter((member) => member.role === "player").map((member) => member.slot));
    for (const slot of [1, 2, 3, 4] as const) if (!occupied.has(slot)) return slot;
    return null;
  }

  private spectatorCount(): number {
    return this.state.members.filter((member) => member.role === "spectator").length;
  }

  private isConnected(playerId: string): boolean {
    for (const connectedPlayerId of this.connections.values()) if (connectedPlayerId === playerId) return true;
    return false;
  }

  private isOnline(member: PersistedRoomMember): boolean {
    // WebSocket attachments are the live presence authority. `lastSeenAt`
    // remains persisted for stale spectator cleanup and audit display, but it
    // must not keep a closed socket looking online for another 30 seconds.
    return this.isConnected(member.playerId);
  }

  private pruneStaleSpectators(now: number): void {
    this.state.members = this.state.members.filter((member) => (
      member.role !== "spectator"
      || this.isConnected(member.playerId)
      || now - member.lastSeenAt < SPECTATOR_STALE_MS
    ));
  }

  private touchMember(member: PersistedRoomMember, now: number, force = false): void {
    if (!force && now - member.lastSeenAt < SEEN_WRITE_INTERVAL_MS) return;
    member.lastSeenAt = now;
    this.state.expiresAt = now + ROOM_TTL_MS;
  }

  private pushActivity(
    actor: Pick<PersistedRoomMember, "playerId" | "name">,
    type: string,
    detail: string | undefined,
    now: number,
  ): void {
    this.state.activity = [{
      id: this.createId(),
      playerId: actor.playerId,
      playerName: actor.name,
      type,
      ...(detail ? { detail } : {}),
      createdAt: now,
    }, ...this.state.activity].slice(0, MAX_ACTIVITY);
  }

  private commit(now: number): void {
    this.state.version += 1;
    this.state.updatedAt = now;
    this.state.expiresAt = now + ROOM_TTL_MS;
  }

  private result(changed: boolean, now: number): EngineMutationResult {
    return {
      changed,
      revision: this.state.version,
      room: this.snapshot(now),
      nextDueAt: this.nextDueAt(),
    };
  }
}

export function createMineRoomEngine(
  input: CreateMineRoomInput,
  options: MineRoomEngineOptions = {},
): MineRoomEngine {
  return MineRoomEngine.create(input, options);
}

export function restoreMineRoomEngine(
  serialized: SerializedMineRoomState | string,
  options: MineRoomEngineOptions = {},
): MineRoomEngine {
  return MineRoomEngine.restore(serialized, options);
}
