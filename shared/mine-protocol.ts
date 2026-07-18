export const MINE_PROTOCOL_VERSION = 1 as const;

export type Difficulty = "beginner" | "intermediate" | "expert";
export type CellState = "hidden" | "flagged" | "questioned" | "revealed";
export type GameStatus = "ready" | "playing" | "won" | "lost";
export type RoomRole = "player" | "spectator";
export type PlayerSlot = 1 | 2 | 3 | 4;
export type StickerId = "safe" | "boom" | "flag" | "pressure" | "blame" | "friendship" | "ad" | "sweeper";

export const STICKER_FALLBACKS: Readonly<Record<StickerId, string>> = {
  safe: "😎",
  boom: "💥",
  flag: "🚩",
  pressure: "🤯",
  blame: "👉",
  friendship: "🤝",
  ad: "📺",
  sweeper: "🫡",
};

export const STICKER_IDS = Object.keys(STICKER_FALLBACKS) as StickerId[];

export function isStickerId(value: unknown): value is StickerId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(STICKER_FALLBACKS, value);
}

export type PublicCell = {
  index: number;
  row: number;
  col: number;
  state: CellState;
  adjacent: number | null;
  mine?: boolean;
  exploded?: boolean;
  wrongFlag?: boolean;
};

export type PublicGame = {
  difficulty: Difficulty;
  width: number;
  height: number;
  mines: number;
  flags: number;
  revealed: number;
  status: GameStatus;
  startedAt: number | null;
  endedAt: number | null;
  cells: PublicCell[];
};

export type RoomPlayer = {
  id: string;
  name: string;
  slot: PlayerSlot;
  online: boolean;
  lastSeenAt: number;
};

export type RoomSpectator = {
  id: string;
  name: string;
  online: boolean;
  lastSeenAt: number;
};

export type ChatMessage = {
  id: string;
  senderId: string;
  senderName: string;
  senderRole: RoomRole;
  senderSlot: PlayerSlot | null;
  content: string;
  stickerId?: StickerId;
  createdAt: number;
};

export type RoomActivity = {
  id: string;
  playerId: string;
  playerName: string;
  type: string;
  detail?: string;
  createdAt: number;
};

export type RoomRevival = {
  phase: "prompt" | "ad";
  triggeredById: string;
  triggeredByName: string;
  createdAt: number;
  adEndsAt: number | null;
};

export type PublicRoom = {
  code: string;
  version: number;
  game: PublicGame;
  players: RoomPlayer[];
  spectators: RoomSpectator[];
  chat: ChatMessage[];
  revival: RoomRevival | null;
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

export type RoomSession = PlayerSession | SpectatorSession;

export type PlayerSessionIdentity = Omit<PlayerSession, "token">;
export type SpectatorSessionIdentity = Omit<SpectatorSession, "token">;
export type RoomSessionIdentity = PlayerSessionIdentity | SpectatorSessionIdentity;

export type WireAction =
  | { type: "reveal"; index: number }
  | { type: "mark"; index: number; state: "hidden" | "flagged" | "questioned" }
  | { type: "chord"; index: number }
  | { type: "restart" }
  | { type: "changeDifficulty"; difficulty: Difficulty }
  | { type: "watchAd" }
  | { type: "endGame" };

/** An unauthenticated HTTP request. The server creates the long-lived token. */
export type CreateRoomRequest = {
  v: typeof MINE_PROTOCOL_VERSION;
  name: string;
  difficulty: Difficulty;
};

export type CreateRoomResponse = {
  roomCode: string;
  session: RoomSession;
  room?: PublicRoom;
};

/** An unauthenticated HTTP request for a new player or spectator membership. */
export type JoinRoomRequest = {
  v: typeof MINE_PROTOCOL_VERSION;
  name: string;
  role: RoomRole;
};

export type JoinRoomResponse = {
  session: RoomSession;
  room?: PublicRoom;
};

/**
 * The first client WebSocket message. The token deliberately lives in this
 * JSON body and must never be placed in the WebSocket URL or query string.
 */
export type JoinMessage = {
  v: typeof MINE_PROTOCOL_VERSION;
  type: "join";
  session: RoomSession;
};

export type RoomCommand =
  | { op: "action"; action: WireAction }
  | { op: "chat"; content: string; stickerId?: StickerId }
  | { op: "switchRole"; targetRole: RoomRole }
  | { op: "leaveMembership" }
  | { op: "sync" };

export type CommandMessage = {
  v: typeof MINE_PROTOCOL_VERSION;
  type: "command";
  id: string;
  sequence: number;
  command: RoomCommand;
};

export type ClientMessage = JoinMessage | CommandMessage;

export type RoomSnapshot = {
  room: PublicRoom;
  serverTime: number;
};

export type WelcomeMessage = {
  v: typeof MINE_PROTOCOL_VERSION;
  type: "welcome";
  identity: RoomSessionIdentity;
  snapshot: RoomSnapshot;
};

export type SnapshotMessage = {
  v: typeof MINE_PROTOCOL_VERSION;
  type: "snapshot";
  snapshot: RoomSnapshot;
};

/** Sent whenever a command changes the caller's public membership identity. */
export type SessionMessage = {
  v: typeof MINE_PROTOCOL_VERSION;
  type: "session";
  identity: RoomSessionIdentity;
};

export type AckMessage = {
  v: typeof MINE_PROTOCOL_VERSION;
  type: "ack";
  id: string;
  sequence: number;
  ok: true;
  revision: number;
};

export type ErrorMessage = {
  v: typeof MINE_PROTOCOL_VERSION;
  type: "error";
  id?: string;
  code: string;
  message: string;
  retryable?: boolean;
};

export type ServerMessage =
  | WelcomeMessage
  | SnapshotMessage
  | SessionMessage
  | AckMessage
  | ErrorMessage;

// Compatibility aliases for the existing UI vocabulary.
export type Room = PublicRoom;
export type Session = RoomSession;
export type GameAction = WireAction;
export type Activity = RoomActivity;
export type Revival = RoomRevival;

export function isRoomCode(value: string): boolean {
  return /^[A-HJ-NP-Z2-9]{6}$/.test(value);
}

export function sanitizeRoomCode(value: string): string {
  return value.toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, "").slice(0, 6);
}

export function createMessageId(): string {
  return crypto.randomUUID();
}

export function isRoomRole(value: unknown): value is RoomRole {
  return value === "player" || value === "spectator";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isRoomSession(value: unknown): value is RoomSession {
  if (!isRecord(value)) return false;
  return (
    typeof value.code === "string" &&
    isRoomCode(value.code) &&
    typeof value.token === "string" &&
    value.token.length > 0 &&
    value.token.length <= 256 &&
    typeof value.playerId === "string" &&
    value.playerId.length > 0 &&
    typeof value.playerName === "string" &&
    value.playerName.length > 0 &&
    isRoomRole(value.role)
  );
}

export function isRoomSessionIdentity(value: unknown): value is RoomSessionIdentity {
  if (!isRecord(value)) return false;
  return (
    typeof value.code === "string" &&
    isRoomCode(value.code) &&
    typeof value.playerId === "string" &&
    value.playerId.length > 0 &&
    typeof value.playerName === "string" &&
    value.playerName.length > 0 &&
    isRoomRole(value.role)
  );
}

export function isServerMessage(value: unknown): value is ServerMessage {
  if (!isRecord(value) || value.v !== MINE_PROTOCOL_VERSION || typeof value.type !== "string") {
    return false;
  }

  if (value.type === "welcome") {
    return isRoomSessionIdentity(value.identity) && isRecord(value.snapshot);
  }
  if (value.type === "snapshot") return isRecord(value.snapshot);
  if (value.type === "session") return isRoomSessionIdentity(value.identity);
  if (value.type === "ack") {
    return (
      typeof value.id === "string" &&
      Number.isSafeInteger(value.sequence) &&
      value.ok === true &&
      Number.isSafeInteger(value.revision)
    );
  }
  if (value.type === "error") {
    return (
      (value.id === undefined || typeof value.id === "string") &&
      typeof value.code === "string" &&
      typeof value.message === "string"
    );
  }
  return false;
}
