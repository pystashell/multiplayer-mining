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
const ONLINE_WINDOW_MS = 24_000;
const SEEN_WRITE_INTERVAL_MS = 8_000;
const MAX_ACTIVITY = 12;

const CREATE_ROOMS_SQL = `
  CREATE TABLE IF NOT EXISTS rooms (
    code TEXT PRIMARY KEY NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    game_json TEXT NOT NULL,
    activity_json TEXT NOT NULL DEFAULT '[]',
    host_id TEXT NOT NULL,
    host_name TEXT NOT NULL,
    host_token_hash TEXT NOT NULL,
    host_seen_at INTEGER NOT NULL,
    guest_id TEXT,
    guest_name TEXT,
    guest_token_hash TEXT,
    guest_seen_at INTEGER,
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

type RoomRow = {
  code: string;
  version: number;
  game_json: string;
  activity_json: string;
  host_id: string;
  host_name: string;
  host_token_hash: string;
  host_seen_at: number;
  guest_id: string | null;
  guest_name: string | null;
  guest_token_hash: string | null;
  guest_seen_at: number | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
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
    slot: 1 | 2;
    online: boolean;
    lastSeenAt: number;
  }>;
  activity: RoomActivity[];
  updatedAt: number;
};

export type PlayerSession = {
  code: string;
  token: string;
  playerId: string;
  playerName: string;
};

export type WireAction =
  | { type: "reveal"; index: number }
  | { type: "mark"; index: number; state: "hidden" | "flagged" | "questioned" }
  | { type: "chord"; index: number }
  | { type: "restart" }
  | { type: "changeDifficulty"; difficulty: Difficulty };

type AuthorizedPlayer = {
  id: string;
  name: string;
  slot: 1 | 2;
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

export async function ensureRoomSchema() {
  if (!schemaReady) {
    const db = database();
    schemaReady = db
      .batch([
        db.prepare(CREATE_ROOMS_SQL),
        db.prepare(CREATE_EXPIRES_INDEX_SQL),
        db.prepare(CREATE_RATE_LIMITS_SQL),
      ])
      .then(() => undefined)
      .catch((error: unknown) => {
        schemaReady = null;
        throw error;
      });
  }
  return schemaReady;
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

function toPublicRoom(row: RoomRow, now = Date.now()): PublicRoom {
  const players: PublicRoom["players"] = [
    {
      id: row.host_id,
      name: row.host_name,
      slot: 1,
      online: now - row.host_seen_at <= ONLINE_WINDOW_MS,
      lastSeenAt: row.host_seen_at,
    },
  ];
  if (row.guest_id && row.guest_name && row.guest_seen_at !== null) {
    players.push({
      id: row.guest_id,
      name: row.guest_name,
      slot: 2,
      online: now - row.guest_seen_at <= ONLINE_WINDOW_MS,
      lastSeenAt: row.guest_seen_at,
    });
  }

  return {
    code: row.code,
    version: row.version,
    game: publicGame(parseGame(row)),
    players,
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
  if (hash === row.host_token_hash) return { id: row.host_id, name: row.host_name, slot: 1 } satisfies AuthorizedPlayer;
  if (row.guest_token_hash && hash === row.guest_token_hash && row.guest_id && row.guest_name) {
    return { id: row.guest_id, name: row.guest_name, slot: 2 } satisfies AuthorizedPlayer;
  }
  throw new RoomError("房间身份已失效，请重新加入。", 401);
}

async function touchPresence(row: RoomRow, player: AuthorizedPlayer) {
  const now = Date.now();
  const previous = player.slot === 1 ? row.host_seen_at : row.guest_seen_at ?? 0;
  if (now - previous < SEEN_WRITE_INTERVAL_MS) return row;
  const column = player.slot === 1 ? "host_seen_at" : "guest_seen_at";
  await database().prepare(`UPDATE rooms SET ${column} = ?1, expires_at = ?2 WHERE code = ?3`).bind(now, now + ROOM_TTL_MS, row.code).run();
  if (player.slot === 1) row.host_seen_at = now;
  else row.guest_seen_at = now;
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

function validateIndex(index: unknown, game: GameState) {
  if (!Number.isSafeInteger(index) || (index as number) < 0 || (index as number) >= game.cells.length) {
    throw new RoomError("这个格子不在棋盘里。", 400);
  }
  return index as number;
}

function translateAction(action: WireAction, game: GameState): { engine: GameAction; detail?: string } {
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

function actionActivity(before: GameState, after: GameState, wire: WireAction, detail?: string) {
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
        room: toPublicRoom(row, now),
        session: { code, token, playerId, playerName: name } satisfies PlayerSession,
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

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const row = await readRoom(code);
    if (row.guest_id) throw new RoomError("这个房间已经有两个人了。", 409);
    const now = Date.now();
    const activity = [newActivity({ id: playerId, name }, "join"), ...parseActivity(row)].slice(0, MAX_ACTIVITY);
    const result = await db.prepare(`
      UPDATE rooms SET
        guest_id = ?1, guest_name = ?2, guest_token_hash = ?3, guest_seen_at = ?4,
        activity_json = ?5, version = version + 1, updated_at = ?4, expires_at = ?6
      WHERE code = ?7 AND version = ?8 AND guest_id IS NULL
    `).bind(playerId, name, tokenHash, now, JSON.stringify(activity), now + ROOM_TTL_MS, code, row.version).run();
    if ((result.meta.changes ?? 0) === 1) {
      const latest = await readRoom(code);
      return {
        room: toPublicRoom(latest, now),
        session: { code, token, playerId, playerName: name } satisfies PlayerSession,
      };
    }
  }
  throw new RoomError("有人抢先加入了这个房间。", 409);
}

export async function getRoom(codeInput: string, token: string | null) {
  const row = await readRoom(codeInput);
  const player = await authenticate(row, token);
  await touchPresence(row, player);
  return { room: toPublicRoom(row) };
}

export async function applyRoomAction(codeInput: string, token: string | null, wireAction: WireAction) {
  const db = database();
  const maxAttempts = wireAction.type === "restart" ? 1 : 3;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const row = await readRoom(codeInput);
    const player = await authenticate(row, token);
    const before = parseGame(row);
    const translated = translateAction(wireAction, before);
    const after = reduceGameAction(before, translated.engine, { actorId: player.id });
    await touchPresence(row, player);
    if (after === before) return { room: toPublicRoom(row) };

    const activityType = actionActivity(before, after, wireAction, translated.detail);
    const activity = [newActivity(player, activityType.type, activityType.detail), ...parseActivity(row)].slice(0, MAX_ACTIVITY);
    const now = Date.now();
    const result = await db.prepare(`
      UPDATE rooms SET
        game_json = ?1, activity_json = ?2, version = version + 1,
        updated_at = ?3, expires_at = ?4
      WHERE code = ?5 AND version = ?6
    `).bind(JSON.stringify(after), JSON.stringify(activity), now, now + ROOM_TTL_MS, row.code, row.version).run();

    if ((result.meta.changes ?? 0) === 1) {
      const latest = await readRoom(row.code);
      return { room: toPublicRoom(latest, now) };
    }
  }

  throw new RoomError("队友刚好也动了一步，棋盘已刷新，请再点一次。", 409);
}
