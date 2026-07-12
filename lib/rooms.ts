import { env } from "cloudflare:workers";
import {
  DIFFICULTY_PRESETS,
  createGame,
  reduceGameAction,
  type Difficulty,
  type GameAction,
  type GameState,
} from "./minesweeper";

const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
const ONLINE_WINDOW_MS = 30_000;
const SEEN_WRITE_INTERVAL_MS = 8_000;
const MAX_ACTIVITY = 12;
const MAX_SPECTATORS = 20;
const SPECTATOR_STALE_MS = 60 * 60 * 1000;
const MAX_CHAT_MESSAGES = 100;
const RETURNED_CHAT_MESSAGES = 40;
const CHAT_RATE_LIMIT = 8;
const CHAT_RATE_WINDOW_MS = 30_000;
const REVIVAL_AD_MS = 10_000;

const CREATE_ROOMS_SQL = `
  CREATE TABLE IF NOT EXISTS rooms (
    code TEXT PRIMARY KEY NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    game_json TEXT NOT NULL,
    activity_json TEXT NOT NULL DEFAULT '[]',
    incident_json TEXT,
    host_id TEXT NOT NULL,
    host_name TEXT NOT NULL,
    host_token_hash TEXT NOT NULL,
    host_seen_at INTEGER NOT NULL,
    guest_id TEXT,
    guest_name TEXT,
    guest_token_hash TEXT,
    guest_seen_at INTEGER,
    player3_id TEXT,
    player3_name TEXT,
    player3_token_hash TEXT,
    player3_seen_at INTEGER,
    player4_id TEXT,
    player4_name TEXT,
    player4_token_hash TEXT,
    player4_seen_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  ) STRICT
`;

const CREATE_EXPIRES_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS rooms_expires_idx ON rooms (expires_at)
`;

const CREATE_RATE_LIMITS_SQL = `
  CREATE TABLE IF NOT EXISTS rate_limits (
    bucket TEXT PRIMARY KEY NOT NULL,
    count INTEGER NOT NULL,
    reset_at INTEGER NOT NULL
  ) STRICT
`;

const CREATE_RATE_LIMITS_RESET_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS rate_limits_reset_idx ON rate_limits (reset_at)
`;

const CREATE_ROOM_SPECTATORS_SQL = `
  CREATE TABLE IF NOT EXISTS room_spectators (
    id TEXT PRIMARY KEY NOT NULL,
    room_code TEXT NOT NULL,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    seen_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (room_code) REFERENCES rooms(code) ON DELETE CASCADE
  ) STRICT
`;

const CREATE_SPECTATORS_ROOM_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS room_spectators_room_idx ON room_spectators (room_code)
`;

const CREATE_SPECTATORS_TOKEN_INDEX_SQL = `
  CREATE UNIQUE INDEX IF NOT EXISTS room_spectators_room_token_idx
  ON room_spectators (room_code, token_hash)
`;

const CREATE_SPECTATORS_SEEN_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS room_spectators_room_seen_idx
  ON room_spectators (room_code, seen_at)
`;

const CREATE_ROOM_MESSAGES_SQL = `
  CREATE TABLE IF NOT EXISTS room_messages (
    id TEXT PRIMARY KEY NOT NULL,
    room_code TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    sender_name TEXT NOT NULL,
    sender_role TEXT NOT NULL CHECK(sender_role IN ('player', 'spectator')),
    sender_slot INTEGER,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (room_code) REFERENCES rooms(code) ON DELETE CASCADE,
    CHECK(
      (sender_role = 'player' AND sender_slot BETWEEN 1 AND 4)
      OR (sender_role = 'spectator' AND sender_slot IS NULL)
    )
  ) STRICT
`;

const CREATE_MESSAGES_ROOM_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS room_messages_room_created_idx
  ON room_messages (room_code, created_at, id)
`;

const CREATE_MESSAGES_SENDER_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS room_messages_sender_created_idx
  ON room_messages (sender_id, created_at)
`;

const ROOM_COMPATIBILITY_COLUMNS = [
  ["player3_id", "ALTER TABLE rooms ADD COLUMN player3_id TEXT"],
  ["player3_name", "ALTER TABLE rooms ADD COLUMN player3_name TEXT"],
  ["player3_token_hash", "ALTER TABLE rooms ADD COLUMN player3_token_hash TEXT"],
  ["player3_seen_at", "ALTER TABLE rooms ADD COLUMN player3_seen_at INTEGER"],
  ["player4_id", "ALTER TABLE rooms ADD COLUMN player4_id TEXT"],
  ["player4_name", "ALTER TABLE rooms ADD COLUMN player4_name TEXT"],
  ["player4_token_hash", "ALTER TABLE rooms ADD COLUMN player4_token_hash TEXT"],
  ["player4_seen_at", "ALTER TABLE rooms ADD COLUMN player4_seen_at INTEGER"],
  ["incident_json", "ALTER TABLE rooms ADD COLUMN incident_json TEXT"],
] as const;

type RoomRow = {
  code: string;
  version: number;
  game_json: string;
  activity_json: string;
  incident_json: string | null;
  host_id: string;
  host_name: string;
  host_token_hash: string;
  host_seen_at: number;
  guest_id: string | null;
  guest_name: string | null;
  guest_token_hash: string | null;
  guest_seen_at: number | null;
  player3_id: string | null;
  player3_name: string | null;
  player3_token_hash: string | null;
  player3_seen_at: number | null;
  player4_id: string | null;
  player4_name: string | null;
  player4_token_hash: string | null;
  player4_seen_at: number | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
};

type SpectatorRow = {
  id: string;
  room_code: string;
  name: string;
  token_hash: string;
  seen_at: number;
  created_at: number;
};

type MessageRow = {
  id: string;
  room_code: string;
  sender_id: string;
  sender_name: string;
  sender_role: "player" | "spectator";
  sender_slot: number | null;
  content: string;
  created_at: number;
};

export type RoomActivity = {
  id: string;
  playerId: string;
  playerName: string;
  type: string;
  detail?: string;
  createdAt: number;
};

export type PublicCell = {
  index: number;
  row: number;
  col: number;
  state: "hidden" | "flagged" | "questioned" | "revealed";
  adjacent: number | null;
  mine?: boolean;
  exploded?: boolean;
  wrongFlag?: boolean;
};

export type PublicRoom = {
  code: string;
  version: number;
  game: {
    difficulty: Difficulty;
    width: number;
    height: number;
    mines: number;
    flags: number;
    revealed: number;
    status: GameState["status"];
    startedAt: number | null;
    endedAt: number | null;
    cells: PublicCell[];
  };
  players: Array<{
    id: string;
    name: string;
    slot: 1 | 2 | 3 | 4;
    online: boolean;
    lastSeenAt: number;
  }>;
  spectators: Array<{
    id: string;
    name: string;
    online: boolean;
    lastSeenAt: number;
  }>;
  chat: Array<{
    id: string;
    senderId: string;
    senderName: string;
    senderRole: "player" | "spectator";
    senderSlot: 1 | 2 | 3 | 4 | null;
    content: string;
    createdAt: number;
  }>;
  revival: {
    phase: "prompt" | "ad";
    triggeredById: string;
    triggeredByName: string;
    createdAt: number;
    adEndsAt: number | null;
  } | null;
  activity: RoomActivity[];
  updatedAt: number;
};

export type PlayerSession = {
  code: string;
  token: string;
  playerId: string;
  playerName: string;
  role: "player";
};

export type SpectatorSession = {
  code: string;
  token: string;
  playerId: string;
  playerName: string;
  role: "spectator";
};

export type WireAction =
  | { type: "reveal"; index: number }
  | { type: "mark"; index: number; state: "hidden" | "flagged" | "questioned" }
  | { type: "chord"; index: number }
  | { type: "restart" }
  | { type: "changeDifficulty"; difficulty: Difficulty }
  | { type: "watchAd" }
  | { type: "endGame" };

type BoardWireAction = Exclude<WireAction, { type: "watchAd" | "endGame" }>;
type LosingWireAction = Extract<WireAction, { type: "reveal" | "chord" }>;

type RoomIncident = {
  phase: "prompt" | "ad";
  triggeredById: string;
  triggeredByName: string;
  action: LosingWireAction;
  createdAt: number;
  adEndsAt: number | null;
};

type AuthorizedPlayer = {
  id: string;
  name: string;
  slot: 1 | 2 | 3 | 4;
  role: "player";
  seenAt: number;
};

type AuthorizedSpectator = {
  id: string;
  name: string;
  slot: null;
  role: "spectator";
  seenAt: number;
};

type AuthorizedIdentity = AuthorizedPlayer | AuthorizedSpectator;

type PlayerSlot = AuthorizedPlayer["slot"];
type JoinableSlot = Exclude<PlayerSlot, 1>;

type SlotRecord = {
  id: string;
  name: string;
  tokenHash: string;
  seenAt: number;
};

const JOIN_SLOT_COLUMNS = {
  2: { id: "guest_id", name: "guest_name", token: "guest_token_hash", seen: "guest_seen_at" },
  3: { id: "player3_id", name: "player3_name", token: "player3_token_hash", seen: "player3_seen_at" },
  4: { id: "player4_id", name: "player4_name", token: "player4_token_hash", seen: "player4_seen_at" },
} as const;

const PRESENCE_COLUMNS: Record<PlayerSlot, string> = {
  1: "host_seen_at",
  2: "guest_seen_at",
  3: "player3_seen_at",
  4: "player4_seen_at",
};

export class RoomError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

let schemaReady: Promise<void> | null = null;

function database() {
  if (!env.DB) throw new RoomError("在线房间暂时不可用，请稍后再试。", 503);
  return env.DB;
}

async function ensureRoomCapacityColumns(db: D1Database) {
  const current = await db.prepare("PRAGMA table_info(rooms)").run<{ name: string }>();
  const existing = new Set(current.results.map((column) => column.name));
  const missing = ROOM_COMPATIBILITY_COLUMNS.filter(([name]) => !existing.has(name));
  if (missing.length === 0) return;

  try {
    await db.batch(missing.map(([, sql]) => db.prepare(sql)));
  } catch (error) {
    const verified = await db.prepare("PRAGMA table_info(rooms)").run<{ name: string }>();
    const finalColumns = new Set(verified.results.map((column) => column.name));
    if (!ROOM_COMPATIBILITY_COLUMNS.every(([name]) => finalColumns.has(name))) throw error;
  }
}

export async function ensureRoomSchema() {
  if (!schemaReady) {
    const db = database();
    schemaReady = db
      .batch([
        db.prepare(CREATE_ROOMS_SQL),
        db.prepare(CREATE_EXPIRES_INDEX_SQL),
        db.prepare(CREATE_RATE_LIMITS_SQL),
        db.prepare(CREATE_RATE_LIMITS_RESET_INDEX_SQL),
        db.prepare(CREATE_ROOM_SPECTATORS_SQL),
        db.prepare(CREATE_SPECTATORS_ROOM_INDEX_SQL),
        db.prepare(CREATE_SPECTATORS_TOKEN_INDEX_SQL),
        db.prepare(CREATE_SPECTATORS_SEEN_INDEX_SQL),
        db.prepare(CREATE_ROOM_MESSAGES_SQL),
        db.prepare(CREATE_MESSAGES_ROOM_INDEX_SQL),
        db.prepare(CREATE_MESSAGES_SENDER_INDEX_SQL),
      ])
      .then(() => ensureRoomCapacityColumns(db))
      .catch((error: unknown) => {
        schemaReady = null;
        throw error;
      });
  }
  return schemaReady;
}

function slotRecord(row: RoomRow, slot: PlayerSlot): SlotRecord | null {
  if (slot === 1) {
    return {
      id: row.host_id,
      name: row.host_name,
      tokenHash: row.host_token_hash,
      seenAt: row.host_seen_at,
    };
  }

  const values: [string | null, string | null, string | null, number | null] = slot === 2
    ? [row.guest_id, row.guest_name, row.guest_token_hash, row.guest_seen_at]
    : slot === 3
      ? [row.player3_id, row.player3_name, row.player3_token_hash, row.player3_seen_at]
      : [row.player4_id, row.player4_name, row.player4_token_hash, row.player4_seen_at];
  const [id, name, tokenHash, seenAt] = values;
  if (!id || !name || !tokenHash || seenAt === null) return null;
  return { id, name, tokenHash, seenAt };
}

function nextOpenSlot(row: RoomRow): JoinableSlot | null {
  if (!row.guest_id) return 2;
  if (!row.player3_id) return 3;
  if (!row.player4_id) return 4;
  return null;
}

export async function enforceRateLimit(
  request: Request,
  scope: "create-room" | "join-room",
  limit: number,
  windowMs: number,
) {
  await ensureRoomSchema();
  const forwarded = request.headers.get("cf-connecting-ip")
    ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? "local";
  const fingerprint = await hashToken(`${scope}:${forwarded}`);
  const bucket = `${scope}:${fingerprint.slice(0, 32)}`;
  const now = Date.now();
  const result = await database().prepare(`
    INSERT INTO rate_limits (bucket, count, reset_at)
    VALUES (?1, 1, ?2)
    ON CONFLICT(bucket) DO UPDATE SET
      count = CASE WHEN reset_at <= ?3 THEN 1 ELSE count + 1 END,
      reset_at = CASE WHEN reset_at <= ?3 THEN ?2 ELSE reset_at END
    RETURNING count, reset_at
  `).bind(bucket, now + windowMs, now).run<{ count: number; reset_at: number }>();
  const current = result.results[0];
  if (current && current.count > limit) {
    const retrySeconds = Math.max(1, Math.ceil((current.reset_at - now) / 1000));
    throw new RoomError(`操作太频繁了，请 ${retrySeconds} 秒后再试。`, 429);
  }
}

async function enforceChatRateLimit(identityId: string) {
  const now = Date.now();
  const [, result] = await database().batch<{ count: number; reset_at: number }>([
    database().prepare("DELETE FROM rate_limits WHERE reset_at <= ?1").bind(now),
    database().prepare(`
      INSERT INTO rate_limits (bucket, count, reset_at)
      VALUES (?1, 1, ?2)
      ON CONFLICT(bucket) DO UPDATE SET
        count = CASE WHEN reset_at <= ?3 THEN 1 ELSE count + 1 END,
        reset_at = CASE WHEN reset_at <= ?3 THEN ?2 ELSE reset_at END
      RETURNING count, reset_at
    `).bind(`chat:${identityId}`, now + CHAT_RATE_WINDOW_MS, now),
  ]);
  const current = result.results[0];
  if (current && current.count > CHAT_RATE_LIMIT) {
    const retrySeconds = Math.max(1, Math.ceil((current.reset_at - now) / 1000));
    throw new RoomError(`发得太快了，请 ${retrySeconds} 秒后再试。`, 429);
  }
}

function normalizeCode(input: string) {
  const code = input.replace(/[^A-Z0-9]/gi, "").toUpperCase();
  if (code.length !== 6) throw new RoomError("房间码应为 6 位。", 400);
  return code;
}

function normalizeName(input: unknown) {
  if (typeof input !== "string") throw new RoomError("请填写你的名字。", 400);
  const name = input.replace(/\s+/g, " ").trim();
  if (!name) throw new RoomError("请填写你的名字。", 400);
  if ([...name].length > 16) throw new RoomError("名字最多 16 个字。", 400);
  return name;
}

function normalizeChatContent(input: unknown) {
  if (typeof input !== "string") throw new RoomError("请输入聊天内容。", 400);
  const content = input
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "")
    .trim();
  if (!content) throw new RoomError("请输入聊天内容。", 400);
  if ([...content].length > 240) throw new RoomError("聊天内容最多 240 个字。", 400);
  return content;
}

function normalizeDifficulty(input: unknown): Difficulty {
  if (typeof input === "string" && input in DIFFICULTY_PRESETS) return input as Difficulty;
  throw new RoomError("这个难度不存在。", 400);
}

function randomBytes(length: number) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function randomRoomCode() {
  const bytes = randomBytes(6);
  return Array.from(bytes, (byte) => ROOM_ALPHABET[byte % ROOM_ALPHABET.length]).join("");
}

function randomToken() {
  return Array.from(randomBytes(32), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hashToken(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseGame(row: RoomRow) {
  return JSON.parse(row.game_json) as GameState;
}

function parseActivity(row: RoomRow) {
  try {
    return JSON.parse(row.activity_json) as RoomActivity[];
  } catch {
    return [];
  }
}

function parseIncident(row: RoomRow): RoomIncident | null {
  if (!row.incident_json) return null;

  try {
    const value = JSON.parse(row.incident_json) as Partial<RoomIncident>;
    const action = value.action;
    const validAction = action
      && (action.type === "reveal" || action.type === "chord")
      && Number.isSafeInteger(action.index)
      && action.index >= 0;
    const validPhase = value.phase === "prompt" || value.phase === "ad";
    const validAdEnd = value.phase === "prompt"
      ? value.adEndsAt === null
      : typeof value.adEndsAt === "number" && Number.isFinite(value.adEndsAt);

    if (
      !validAction
      || !validPhase
      || !validAdEnd
      || typeof value.triggeredById !== "string"
      || typeof value.triggeredByName !== "string"
      || typeof value.createdAt !== "number"
      || !Number.isFinite(value.createdAt)
    ) {
      throw new Error("Invalid room incident");
    }

    return value as RoomIncident;
  } catch {
    throw new RoomError("房间的复活状态异常，请稍后再试。", 500);
  }
}

function publicRevival(incident: RoomIncident | null): PublicRoom["revival"] {
  if (!incident) return null;
  return {
    phase: incident.phase,
    triggeredById: incident.triggeredById,
    triggeredByName: incident.triggeredByName,
    createdAt: incident.createdAt,
    adEndsAt: incident.adEndsAt,
  };
}

function publicGame(game: GameState): PublicRoom["game"] {
  const terminal = game.status === "won" || game.status === "lost";
  const difficulty = game.difficulty in DIFFICULTY_PRESETS ? game.difficulty as Difficulty : "beginner";
  const cells = game.cells.map((cell, index): PublicCell => {
    let state: PublicCell["state"] = "hidden";
    if (cell.isExploded) state = "revealed";
    else if (cell.isFlagged) state = "flagged";
    else if (cell.isRevealed) state = "revealed";
    else if (cell.isQuestioned) state = "questioned";

    const dto: PublicCell = {
      index,
      row: cell.y,
      col: cell.x,
      state,
      adjacent: cell.isRevealed && !cell.isMine ? cell.adjacentMines : null,
    };

    if (terminal && cell.isMine) dto.mine = true;
    if (cell.isExploded) dto.exploded = true;
    if (terminal && cell.isFlagged && !cell.isMine) dto.wrongFlag = true;
    return dto;
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

async function toPublicRoom(row: RoomRow, now = Date.now()): Promise<PublicRoom> {
  const players: PublicRoom["players"] = [];
  for (const slot of [1, 2, 3, 4] as const) {
    const player = slotRecord(row, slot);
    if (!player) continue;
    players.push({
      id: player.id,
      name: player.name,
      slot,
      online: now - player.seenAt <= ONLINE_WINDOW_MS,
      lastSeenAt: player.seenAt,
    });
  }

  const db = database();
  const [spectatorResult, messageResult] = await Promise.all([
    db.prepare(`
      SELECT id, name, seen_at
      FROM room_spectators
      WHERE room_code = ?1
      ORDER BY created_at ASC, id ASC
    `).bind(row.code).run<Pick<SpectatorRow, "id" | "name" | "seen_at">>(),
    db.prepare(`
      SELECT id, room_code, sender_id, sender_name, sender_role, sender_slot, content, created_at
      FROM (
        SELECT id, room_code, sender_id, sender_name, sender_role, sender_slot, content, created_at
        FROM room_messages
        WHERE room_code = ?1
        ORDER BY created_at DESC, id DESC
        LIMIT ${RETURNED_CHAT_MESSAGES}
      )
      ORDER BY created_at ASC, id ASC
    `).bind(row.code).run<MessageRow>(),
  ]);

  const spectators = spectatorResult.results.map((spectator) => ({
    id: spectator.id,
    name: spectator.name,
    online: now - spectator.seen_at <= ONLINE_WINDOW_MS,
    lastSeenAt: spectator.seen_at,
  }));

  const chat = messageResult.results.map((message): PublicRoom["chat"][number] => ({
    id: message.id,
    senderId: message.sender_id,
    senderName: message.sender_name,
    senderRole: message.sender_role,
    senderSlot: message.sender_slot as 1 | 2 | 3 | 4 | null,
    content: message.content,
    createdAt: message.created_at,
  }));

  return {
    code: row.code,
    version: row.version,
    game: publicGame(parseGame(row)),
    players,
    spectators,
    chat,
    revival: publicRevival(parseIncident(row)),
    activity: parseActivity(row),
    updatedAt: row.updated_at,
  };
}

async function readRoom(codeInput: string) {
  await ensureRoomSchema();
  const code = normalizeCode(codeInput);
  const row = await database().prepare("SELECT * FROM rooms WHERE code = ?1").bind(code).first<RoomRow>();
  if (!row || row.expires_at < Date.now()) throw new RoomError("没有找到这个房间，可能已经过期了。", 404);
  return row;
}

async function authenticate(row: RoomRow, token: string | null) {
  if (!token || token.length > 128) throw new RoomError("房间身份已失效，请重新加入。", 401);
  const hash = await hashToken(token);
  for (const slot of [1, 2, 3, 4] as const) {
    const player = slotRecord(row, slot);
    if (player && hash === player.tokenHash) {
      return {
        id: player.id,
        name: player.name,
        slot,
        role: "player",
        seenAt: player.seenAt,
      } satisfies AuthorizedPlayer;
    }
  }

  const spectator = await database().prepare(`
    SELECT id, name, seen_at
    FROM room_spectators
    WHERE room_code = ?1 AND token_hash = ?2
  `).bind(row.code, hash).first<Pick<SpectatorRow, "id" | "name" | "seen_at">>();
  if (spectator) {
    return {
      id: spectator.id,
      name: spectator.name,
      slot: null,
      role: "spectator",
      seenAt: spectator.seen_at,
    } satisfies AuthorizedSpectator;
  }
  throw new RoomError("房间身份已失效，请重新加入。", 401);
}

async function touchPresence(row: RoomRow, identity: AuthorizedIdentity) {
  const now = Date.now();
  if (now - identity.seenAt < SEEN_WRITE_INTERVAL_MS) return row;
  const db = database();
  if (identity.role === "spectator") {
    await db.batch([
      db.prepare("UPDATE room_spectators SET seen_at = ?1 WHERE room_code = ?2 AND id = ?3")
        .bind(now, row.code, identity.id),
      db.prepare("UPDATE rooms SET expires_at = ?1 WHERE code = ?2")
        .bind(now + ROOM_TTL_MS, row.code),
    ]);
  } else {
    const column = PRESENCE_COLUMNS[identity.slot];
    await db.prepare(`UPDATE rooms SET ${column} = ?1, expires_at = ?2 WHERE code = ?3`)
      .bind(now, now + ROOM_TTL_MS, row.code)
      .run();
    if (identity.slot === 1) row.host_seen_at = now;
    else if (identity.slot === 2) row.guest_seen_at = now;
    else if (identity.slot === 3) row.player3_seen_at = now;
    else row.player4_seen_at = now;
  }
  identity.seenAt = now;
  row.expires_at = now + ROOM_TTL_MS;
  return row;
}

function newActivity(player: { id: string; name: string }, type: string, detail?: string): RoomActivity {
  return {
    id: crypto.randomUUID(),
    playerId: player.id,
    playerName: player.name,
    type,
    ...(detail ? { detail } : {}),
    createdAt: Date.now(),
  };
}

function coordinateLabel(index: number, width: number) {
  const col = index % width;
  const row = Math.floor(index / width) + 1;
  const column = col < 26 ? String.fromCharCode(65 + col) : `A${String.fromCharCode(65 + col - 26)}`;
  return `${column}${row}`;
}

function shiftStartedAtForPause(game: GameState, incident: RoomIncident, settledAt: number) {
  if (game.startedAt === null) return game;
  return {
    ...game,
    startedAt: game.startedAt + Math.max(0, settledAt - incident.createdAt),
  };
}

async function settleExpiredIncident(initialRow: RoomRow, requestedAt = Date.now()) {
  let row = initialRow;

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const incident = parseIncident(row);
    if (
      !incident
      || incident.phase !== "ad"
      || incident.adEndsAt === null
      || requestedAt < incident.adEndsAt
    ) {
      return row;
    }

    const now = Math.max(requestedAt, Date.now());
    const pausedGame = shiftStartedAtForPause(parseGame(row), incident, now);
    const resumedGame = { ...pausedGame, revision: pausedGame.revision + 1 };
    const activity = [
      newActivity(
        { id: incident.triggeredById, name: incident.triggeredByName },
        "revive",
        "广告结束，棋盘已恢复",
      ),
      ...parseActivity(row),
    ].slice(0, MAX_ACTIVITY);
    const result = await database().prepare(`
      UPDATE rooms SET
        game_json = ?1, incident_json = NULL, activity_json = ?2,
        version = version + 1, updated_at = ?3, expires_at = ?4
      WHERE code = ?5 AND version = ?6 AND incident_json = ?7
    `).bind(
      JSON.stringify(resumedGame),
      JSON.stringify(activity),
      now,
      now + ROOM_TTL_MS,
      row.code,
      row.version,
      row.incident_json,
    ).run();

    if ((result.meta.changes ?? 0) === 1) return readRoom(row.code);
    row = await readRoom(row.code);
  }

  throw new RoomError("队友刚好也完成了复活，房间正在刷新，请再试一次。", 409);
}

function validateIndex(index: unknown, game: GameState) {
  if (!Number.isSafeInteger(index) || (index as number) < 0 || (index as number) >= game.cells.length) {
    throw new RoomError("这个格子不在棋盘里。", 400);
  }
  return index as number;
}

function translateAction(action: BoardWireAction, game: GameState): { engine: GameAction; detail?: string } {
  if (!action || typeof action !== "object" || typeof action.type !== "string") throw new RoomError("无法识别这一步。", 400);
  if (action.type === "restart") return { engine: { type: "restart" } };
  if (action.type === "changeDifficulty") {
    const difficulty = normalizeDifficulty(action.difficulty);
    return { engine: { type: "changeDifficulty", difficulty }, detail: difficulty };
  }
  if (action.type !== "reveal" && action.type !== "mark" && action.type !== "chord") throw new RoomError("无法识别这一步。", 400);
  const index = validateIndex(action.index, game);
  const x = index % game.width;
  const y = Math.floor(index / game.width);
  if (action.type === "mark") {
    if (action.state !== "hidden" && action.state !== "flagged" && action.state !== "questioned") {
      throw new RoomError("无法识别这个标记。", 400);
    }
    return { engine: { type: "setMark", x, y, mark: action.state }, detail: coordinateLabel(index, game.width) };
  }
  return { engine: { type: action.type, x, y } as GameAction, detail: coordinateLabel(index, game.width) };
}

function actionActivity(before: GameState, after: GameState, wire: BoardWireAction, detail?: string) {
  if (before.status !== "lost" && after.status === "lost") return { type: "boom", detail };
  if (before.status !== "won" && after.status === "won") return { type: "win", detail };
  if (wire.type === "mark") {
    const index = wire.index;
    const cell = after.cells[index];
    if (cell.isFlagged) return { type: "flag", detail };
    if (cell.isQuestioned) return { type: "question", detail };
    return { type: "unmark", detail };
  }
  if (wire.type === "changeDifficulty") {
    const labels: Record<Difficulty, string> = { beginner: "初级", intermediate: "中级", expert: "专家" };
    return { type: "difficulty", detail: labels[wire.difficulty] };
  }
  return { type: wire.type, detail };
}

export async function createRoom(input: { name: unknown; difficulty: unknown }) {
  await ensureRoomSchema();
  const name = normalizeName(input.name);
  const difficulty = normalizeDifficulty(input.difficulty);
  const db = database();
  const now = Date.now();
  const token = randomToken();
  const tokenHash = await hashToken(token);
  const playerId = crypto.randomUUID();
  const game = createGame(difficulty);
  const activity = [newActivity({ id: playerId, name }, "create")];

  await db.prepare("DELETE FROM rooms WHERE expires_at < ?1").bind(now).run();

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = randomRoomCode();
    try {
      await db.prepare(`
        INSERT INTO rooms (
          code, version, game_json, activity_json,
          host_id, host_name, host_token_hash, host_seen_at,
          created_at, updated_at, expires_at
        ) VALUES (?1, 1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?7, ?8)
      `).bind(code, JSON.stringify(game), JSON.stringify(activity), playerId, name, tokenHash, now, now + ROOM_TTL_MS).run();
      const row = await readRoom(code);
      return {
        room: await toPublicRoom(row, now),
        session: { code, token, playerId, playerName: name, role: "player" } satisfies PlayerSession,
      };
    } catch (error) {
      if (attempt === 7) throw error;
    }
  }
  throw new RoomError("没能生成房间，请再试一次。", 503);
}

export async function joinRoom(codeInput: string, input: { name: unknown }) {
  const code = normalizeCode(codeInput);
  const name = normalizeName(input.name);
  const db = database();
  const token = randomToken();
  const tokenHash = await hashToken(token);
  const playerId = crypto.randomUUID();

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const row = await readRoom(code);
    const slot = nextOpenSlot(row);
    if (!slot) throw new RoomError("这个房间已经有四个人了。", 409);
    const columns = JOIN_SLOT_COLUMNS[slot];
    const now = Date.now();
    const activity = [newActivity({ id: playerId, name }, "join"), ...parseActivity(row)].slice(0, MAX_ACTIVITY);
    const result = await db.prepare(`
      UPDATE rooms SET
        ${columns.id} = ?1, ${columns.name} = ?2, ${columns.token} = ?3, ${columns.seen} = ?4,
        activity_json = ?5, version = version + 1, updated_at = ?4, expires_at = ?6
      WHERE code = ?7 AND version = ?8 AND ${columns.id} IS NULL
    `).bind(playerId, name, tokenHash, now, JSON.stringify(activity), now + ROOM_TTL_MS, code, row.version).run();
    if ((result.meta.changes ?? 0) === 1) {
      const latest = await readRoom(code);
      return {
        room: await toPublicRoom(latest, now),
        session: { code, token, playerId, playerName: name, role: "player" } satisfies PlayerSession,
      };
    }
  }
  throw new RoomError("有人抢先加入了这个房间。", 409);
}

export async function joinAsSpectator(codeInput: string, input: { name: unknown }) {
  const code = normalizeCode(codeInput);
  const name = normalizeName(input.name);
  await readRoom(code);
  const db = database();
  const now = Date.now();
  const token = randomToken();
  const tokenHash = await hashToken(token);
  const playerId = crypto.randomUUID();

  await db.prepare("DELETE FROM room_spectators WHERE room_code = ?1 AND seen_at < ?2")
    .bind(code, now - SPECTATOR_STALE_MS)
    .run();

  const inserted = await db.prepare(`
    INSERT INTO room_spectators (id, room_code, name, token_hash, seen_at, created_at)
    SELECT ?1, ?2, ?3, ?4, ?5, ?5
    WHERE (SELECT COUNT(*) FROM room_spectators WHERE room_code = ?2) < ${MAX_SPECTATORS}
  `).bind(playerId, code, name, tokenHash, now).run();
  if ((inserted.meta.changes ?? 0) !== 1) {
    throw new RoomError("这个房间已经有 20 位旁观者了。", 409);
  }

  await db.prepare(`
    UPDATE rooms
    SET version = version + 1, updated_at = ?1, expires_at = ?2
    WHERE code = ?3
  `)
    .bind(now, now + ROOM_TTL_MS, code)
    .run();
  const latest = await readRoom(code);

  return {
    room: await toPublicRoom(latest, now),
    session: {
      code,
      token,
      playerId,
      playerName: name,
      role: "spectator",
    } satisfies SpectatorSession,
  };
}

export async function getRoom(codeInput: string, token: string | null) {
  let row = await readRoom(codeInput);
  const identity = await authenticate(row, token);
  row = await settleExpiredIncident(row);
  await touchPresence(row, identity);
  return { room: await toPublicRoom(row) };
}

export async function postRoomMessage(codeInput: string, token: string | null, contentInput: unknown) {
  const content = normalizeChatContent(contentInput);
  let row = await readRoom(codeInput);
  const identity = await authenticate(row, token);
  row = await settleExpiredIncident(row);
  await touchPresence(row, identity);
  await enforceChatRateLimit(identity.id);

  const db = database();
  const now = Date.now();
  await db.batch([
    db.prepare(`
      INSERT INTO room_messages (
        id, room_code, sender_id, sender_name, sender_role, sender_slot, content, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
    `).bind(
      crypto.randomUUID(),
      row.code,
      identity.id,
      identity.name,
      identity.role,
      identity.slot,
      content,
      now,
    ),
    db.prepare(`
      DELETE FROM room_messages
      WHERE room_code = ?1
        AND id NOT IN (
          SELECT id
          FROM room_messages
          WHERE room_code = ?1
          ORDER BY created_at DESC, id DESC
          LIMIT ${MAX_CHAT_MESSAGES}
        )
    `).bind(row.code),
    db.prepare(`
      UPDATE rooms
      SET version = version + 1, updated_at = ?1, expires_at = ?2
      WHERE code = ?3
    `).bind(now, now + ROOM_TTL_MS, row.code),
  ]);

  const latest = await readRoom(row.code);
  return { room: await toPublicRoom(latest, now) };
}

export async function applyRoomAction(codeInput: string, token: string | null, wireAction: WireAction) {
  if (!wireAction || typeof wireAction !== "object" || typeof wireAction.type !== "string") {
    throw new RoomError("无法识别这一步。", 400);
  }

  const db = database();
  const maxAttempts = wireAction.type === "restart" ? 1 : 3;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let row = await readRoom(codeInput);
    const identity = await authenticate(row, token);
    if (identity.role === "spectator") throw new RoomError("旁观者不能操作雷区。", 403);
    const player = identity;
    await touchPresence(row, player);

    const requestedAt = Date.now();
    row = await settleExpiredIncident(row, requestedAt);
    const incident = parseIncident(row);

    if (incident) {
      if (wireAction.type === "watchAd") {
        if (incident.phase === "ad") return { room: await toPublicRoom(row, requestedAt) };

        const now = Date.now();
        const watching: RoomIncident = {
          ...incident,
          phase: "ad",
          adEndsAt: now + REVIVAL_AD_MS,
        };
        const activity = [
          newActivity(player, "ad", "所有参赛玩家观看 10 秒广告"),
          ...parseActivity(row),
        ].slice(0, MAX_ACTIVITY);
        const result = await db.prepare(`
          UPDATE rooms SET
            incident_json = ?1, activity_json = ?2, version = version + 1,
            updated_at = ?3, expires_at = ?4
          WHERE code = ?5 AND version = ?6 AND incident_json = ?7
        `).bind(
          JSON.stringify(watching),
          JSON.stringify(activity),
          now,
          now + ROOM_TTL_MS,
          row.code,
          row.version,
          row.incident_json,
        ).run();

        if ((result.meta.changes ?? 0) === 1) {
          const latest = await readRoom(row.code);
          return { room: await toPublicRoom(latest, now) };
        }
        continue;
      }

      if (wireAction.type === "endGame") {
        if (incident.phase === "ad") {
          throw new RoomError("广告已经开始了，大家看完就能继续扫雷。", 409);
        }

        const now = Date.now();
        const before = shiftStartedAtForPause(parseGame(row), incident, now);
        const translated = translateAction(incident.action, before);
        const after = reduceGameAction(before, translated.engine, {
          actorId: incident.triggeredById,
          now: () => now,
        });
        if (before.status === "lost" || after.status !== "lost") {
          throw new RoomError("这次踩雷已经无法重放，请重新开局。", 409);
        }

        const activity = [
          newActivity(player, "end", `${incident.triggeredByName} 踩雷，选择结束游戏`),
          ...parseActivity(row),
        ].slice(0, MAX_ACTIVITY);
        const result = await db.prepare(`
          UPDATE rooms SET
            game_json = ?1, incident_json = NULL, activity_json = ?2,
            version = version + 1, updated_at = ?3, expires_at = ?4
          WHERE code = ?5 AND version = ?6 AND incident_json = ?7
        `).bind(
          JSON.stringify(after),
          JSON.stringify(activity),
          now,
          now + ROOM_TTL_MS,
          row.code,
          row.version,
          row.incident_json,
        ).run();

        if ((result.meta.changes ?? 0) === 1) {
          const latest = await readRoom(row.code);
          return { room: await toPublicRoom(latest, now) };
        }
        continue;
      }

      throw new RoomError("有人踩雷了，请先选择看广告复活或结束游戏。", 409);
    }

    if (wireAction.type === "watchAd" || wireAction.type === "endGame") {
      throw new RoomError("现在没有需要处理的踩雷事故。", 409);
    }

    const before = parseGame(row);
    const translated = translateAction(wireAction, before);
    const now = Date.now();
    const after = reduceGameAction(before, translated.engine, { actorId: player.id, now: () => now });
    if (after === before) return { room: await toPublicRoom(row) };

    if (before.status !== "lost" && after.status === "lost") {
      if (wireAction.type !== "reveal" && wireAction.type !== "chord") {
        throw new RoomError("无法识别这次踩雷事故。", 500);
      }
      const pending: RoomIncident = {
        phase: "prompt",
        triggeredById: player.id,
        triggeredByName: player.name,
        action: { type: wireAction.type, index: wireAction.index },
        createdAt: now,
        adEndsAt: null,
      };
      const activity = [
        newActivity(player, "incident", "踩雷了，等待场上玩家选择"),
        ...parseActivity(row),
      ].slice(0, MAX_ACTIVITY);
      const result = await db.prepare(`
        UPDATE rooms SET
          incident_json = ?1, activity_json = ?2, version = version + 1,
          updated_at = ?3, expires_at = ?4
        WHERE code = ?5 AND version = ?6 AND incident_json IS NULL
      `).bind(
        JSON.stringify(pending),
        JSON.stringify(activity),
        now,
        now + ROOM_TTL_MS,
        row.code,
        row.version,
      ).run();

      if ((result.meta.changes ?? 0) === 1) {
        const latest = await readRoom(row.code);
        return { room: await toPublicRoom(latest, now) };
      }
      continue;
    }

    const activityType = actionActivity(before, after, wireAction, translated.detail);
    const activity = [newActivity(player, activityType.type, activityType.detail), ...parseActivity(row)].slice(0, MAX_ACTIVITY);
    const result = await db.prepare(`
      UPDATE rooms SET
        game_json = ?1, activity_json = ?2, version = version + 1,
        updated_at = ?3, expires_at = ?4
      WHERE code = ?5 AND version = ?6
    `).bind(JSON.stringify(after), JSON.stringify(activity), now, now + ROOM_TTL_MS, row.code, row.version).run();

    if ((result.meta.changes ?? 0) === 1) {
      const latest = await readRoom(row.code);
      return { room: await toPublicRoom(latest, now) };
    }
  }

  throw new RoomError("队友刚好也动了一步，棋盘已刷新，请再点一次。", 409);
}
