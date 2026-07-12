"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  MINE_PROTOCOL_VERSION,
  createMessageId,
  isRoomCode,
  isRoomSession,
  isServerMessage,
  sanitizeRoomCode,
  type AckMessage,
  type CommandMessage,
  type CreateRoomRequest,
  type CreateRoomResponse,
  type Difficulty,
  type JoinMessage,
  type JoinRoomRequest,
  type JoinRoomResponse,
  type PublicRoom,
  type RoomCommand,
  type RoomRole,
  type RoomSession,
  type RoomSessionIdentity,
  type RoomSnapshot,
  type ServerMessage,
  type WireAction,
} from "../shared/mine-protocol";

const STORAGE_PREFIX = "shared-minefield.socket.v1";
const LAST_ROOM_KEY = `${STORAGE_PREFIX}.last`;
const LEGACY_SESSION_KEY = "shared-minefield-session-v1";
const RECONNECT_DELAYS = [500, 1_000, 2_000, 4_000, 7_500, 10_000] as const;
const PING_INTERVAL_MS = 60_000;
const COMMAND_TIMEOUT_MS = 30_000;

export type MineRoomConnectionStatus =
  | "idle"
  | "creating"
  | "joining"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "error";

export type MineRoomSocketErrorValue = {
  code: string;
  message: string;
  retryable?: boolean;
};

export class MineRoomSocketError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "MineRoomSocketError";
    this.code = code;
    this.retryable = retryable;
  }
}

export type UseMineRoomSocketOptions = {
  autoResume?: boolean;
  onSnapshot?: (room: PublicRoom, source: "welcome" | "snapshot") => void;
  onSession?: (session: RoomSession) => void;
  onError?: (error: MineRoomSocketErrorValue) => void;
};

type DisconnectOptions = {
  forgetCredentials?: boolean;
};

type PendingCommand = {
  message: CommandMessage;
  expiresAt: number;
  timer: number | null;
  resolve: (ack: AckMessage) => void;
  reject: (error: MineRoomSocketError) => void;
};

type MembershipResponse = Partial<CreateRoomResponse & JoinRoomResponse> & {
  room?: PublicRoom;
  session?: unknown;
  roomCode?: unknown;
};

function sessionStorageKey(roomCode: string): string {
  return `${STORAGE_PREFIX}.${roomCode}`;
}

function sequenceStorageKey(session: RoomSession): string {
  return `${STORAGE_PREFIX}.sequence.${session.code}.${session.playerId}`;
}

function safeReadStorage(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeWriteStorage(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // A live connection remains usable when storage is unavailable.
  }
}

function safeRemoveStorage(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Cleanup is best-effort.
  }
}

function normalizeSession(value: unknown): RoomSession | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<RoomSession> & { role?: unknown };
  const normalized = {
    ...candidate,
    code: typeof candidate.code === "string" ? sanitizeRoomCode(candidate.code) : "",
    // Sessions saved by the polling implementation predate spectator typing.
    role: candidate.role === "spectator" ? "spectator" : "player",
  };
  return isRoomSession(normalized) ? normalized : null;
}

function parseStoredSession(value: string | null): RoomSession | null {
  if (!value) return null;
  try {
    return normalizeSession(JSON.parse(value));
  } catch {
    return null;
  }
}

function readStoredSession(roomCode: string): RoomSession | null {
  return parseStoredSession(safeReadStorage(sessionStorageKey(roomCode)));
}

function readLastStoredSession(): RoomSession | null {
  const roomCode = safeReadStorage(LAST_ROOM_KEY);
  if (roomCode && isRoomCode(roomCode)) {
    const session = readStoredSession(roomCode);
    if (session) return session;
  }
  return parseStoredSession(safeReadStorage(LEGACY_SESSION_KEY));
}

function saveStoredSession(session: RoomSession): void {
  safeWriteStorage(sessionStorageKey(session.code), JSON.stringify(session));
  safeWriteStorage(LAST_ROOM_KEY, session.code);
}

function removeStoredSession(session: RoomSession): void {
  safeRemoveStorage(sessionStorageKey(session.code));
  safeRemoveStorage(sequenceStorageKey(session));
  if (safeReadStorage(LAST_ROOM_KEY) === session.code) safeRemoveStorage(LAST_ROOM_KEY);

  const legacy = parseStoredSession(safeReadStorage(LEGACY_SESSION_KEY));
  if (legacy?.code === session.code && legacy.token === session.token) {
    safeRemoveStorage(LEGACY_SESSION_KEY);
  }
}

function readSequence(session: RoomSession): number {
  const value = Number(safeReadStorage(sequenceStorageKey(session)) ?? "0");
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function saveSequence(session: RoomSession, sequence: number): void {
  safeWriteStorage(sequenceStorageKey(session), String(sequence));
}

function sameIdentity(left: RoomSession | null, right: RoomSession): boolean {
  return Boolean(
    left &&
      left.code === right.code &&
      left.playerId === right.playerId &&
      left.token === right.token,
  );
}

function mergeSessionIdentity(
  session: RoomSession | null,
  identity: RoomSessionIdentity,
): RoomSession | null {
  if (!session || session.code !== identity.code || session.playerId !== identity.playerId) return null;
  return {
    ...session,
    playerName: identity.playerName,
    role: identity.role,
  } as RoomSession;
}

function createSocketUrl(roomCode: string): string {
  const url = new URL(`/api/rooms/${roomCode}/socket`, window.location.href);
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  // Authentication belongs in the first join frame, never in this URL.
  url.search = "";
  url.hash = "";
  return url.toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPublicRoom(value: unknown): value is PublicRoom {
  if (!isRecord(value)) return false;
  return (
    typeof value.code === "string" &&
    isRoomCode(value.code) &&
    Number.isSafeInteger(value.version) &&
    isRecord(value.game) &&
    Array.isArray(value.players) &&
    Array.isArray(value.spectators) &&
    Array.isArray(value.chat) &&
    Array.isArray(value.activity)
  );
}

function isRoomSnapshot(value: unknown): value is RoomSnapshot {
  return (
    isRecord(value) &&
    isPublicRoom(value.room) &&
    typeof value.serverTime === "number" &&
    Number.isFinite(value.serverTime)
  );
}

function responseError(payload: unknown, fallback: string): string {
  if (isRecord(payload)) {
    if (typeof payload.message === "string" && payload.message) return payload.message;
    if (typeof payload.error === "string" && payload.error) return payload.error;
  }
  return fallback;
}

async function readMembershipResponse(
  response: Response,
  fallbackError: string,
): Promise<{ session: RoomSession; room: PublicRoom | null; roomCode: string }> {
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new MineRoomSocketError(
      `HTTP_${response.status}`,
      responseError(payload, fallbackError),
      response.status >= 500,
    );
  }
  if (!isRecord(payload)) {
    throw new MineRoomSocketError("BAD_MEMBERSHIP_RESPONSE", "房间服务返回了无法识别的数据。");
  }

  const membership = payload as MembershipResponse;
  const session = normalizeSession(membership.session);
  const room = isPublicRoom(membership.room) ? membership.room : null;
  const roomCodeValue =
    typeof membership.roomCode === "string" ? membership.roomCode : room?.code ?? session?.code ?? "";
  const roomCode = sanitizeRoomCode(roomCodeValue);
  if (!session || !isRoomCode(roomCode) || session.code !== roomCode) {
    throw new MineRoomSocketError("BAD_MEMBERSHIP_RESPONSE", "房间服务没有返回有效的房间身份。");
  }
  return { session, room, roomCode };
}

export function useMineRoomSocket(options: UseMineRoomSocketOptions = {}) {
  const { autoResume = false } = options;
  const [status, setStatus] = useState<MineRoomConnectionStatus>("idle");
  const [session, setSession] = useState<RoomSession | null>(null);
  const [room, setRoom] = useState<PublicRoom | null>(null);
  const [error, setError] = useState<MineRoomSocketErrorValue | null>(null);
  const [serverTimeOffsetMs, setServerTimeOffsetMs] = useState(0);

  const socketRef = useRef<WebSocket | null>(null);
  const sessionRef = useRef<RoomSession | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const pingTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const connectionGenerationRef = useRef(0);
  const sequenceRef = useRef(0);
  const lastVersionRef = useRef(0);
  const serverTimeOffsetRef = useRef(0);
  const intentionalCloseRef = useRef(false);
  const welcomedRef = useRef(false);
  const mountedRef = useRef(false);
  const needsPostWelcomeSyncRef = useRef(false);
  const syncInFlightRef = useRef(false);
  const pendingCommandsRef = useRef(new Map<string, PendingCommand>());
  const callbacksRef = useRef(options);
  const openSocketRef = useRef<(nextSession: RoomSession, reconnecting: boolean) => void>(() => {});
  const connectRef = useRef<(nextSession: RoomSession) => boolean>(() => false);
  const sendCommandRef = useRef<(command: RoomCommand) => Promise<AckMessage>>(() =>
    Promise.reject(new MineRoomSocketError("NOT_READY", "房间连接尚未准备好。")),
  );
  const requestSyncRef = useRef<() => void>(() => {});

  useEffect(() => {
    callbacksRef.current = options;
  }, [options]);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const clearPingTimer = useCallback(() => {
    if (pingTimerRef.current !== null) {
      window.clearInterval(pingTimerRef.current);
      pingTimerRef.current = null;
    }
  }, []);

  const updateServerTime = useCallback((serverTime: number) => {
    if (!Number.isFinite(serverTime)) return;
    const nextOffset = serverTime - Date.now();
    serverTimeOffsetRef.current = nextOffset;
    setServerTimeOffsetMs(nextOffset);
  }, []);

  const reportError = useCallback((nextError: MineRoomSocketErrorValue, terminal = false) => {
    setError(nextError);
    if (terminal) setStatus("error");
    callbacksRef.current.onError?.(nextError);
  }, []);

  const persistSession = useCallback((nextSession: RoomSession) => {
    sessionRef.current = nextSession;
    saveStoredSession(nextSession);
    setSession(nextSession);
    callbacksRef.current.onSession?.(nextSession);
  }, []);

  const settlePendingWithError = useCallback((id: string, commandError: MineRoomSocketError) => {
    const pending = pendingCommandsRef.current.get(id);
    if (!pending) return false;
    pendingCommandsRef.current.delete(id);
    if (pending.timer !== null) window.clearTimeout(pending.timer);
    pending.reject(commandError);
    return true;
  }, []);

  const rejectAllPending = useCallback((commandError: MineRoomSocketError) => {
    const pending = [...pendingCommandsRef.current.values()];
    pendingCommandsRef.current.clear();
    for (const item of pending) {
      if (item.timer !== null) window.clearTimeout(item.timer);
      item.reject(commandError);
    }
    syncInFlightRef.current = false;
  }, []);

  const resolvePendingLeave = useCallback(() => {
    let resolved = false;
    for (const [id, pending] of pendingCommandsRef.current) {
      if (pending.message.command.op !== "leaveMembership") continue;
      pendingCommandsRef.current.delete(id);
      if (pending.timer !== null) window.clearTimeout(pending.timer);
      pending.resolve({
        v: MINE_PROTOCOL_VERSION,
        type: "ack",
        id: pending.message.id,
        sequence: pending.message.sequence,
        ok: true,
        revision: lastVersionRef.current,
      });
      resolved = true;
    }
    return resolved;
  }, []);

  const clearActiveSession = useCallback((preserveStoredCredentials = false) => {
    const activeSession = sessionRef.current;
    if (activeSession && !preserveStoredCredentials) removeStoredSession(activeSession);
    sessionRef.current = null;
    sequenceRef.current = 0;
    lastVersionRef.current = 0;
    setSession(null);
    setRoom(null);
  }, []);

  const armPendingTimeout = useCallback((pending: PendingCommand) => {
    if (pending.timer !== null) window.clearTimeout(pending.timer);
    const remaining = pending.expiresAt - Date.now();
    if (remaining <= 0) {
      settlePendingWithError(
        pending.message.id,
        new MineRoomSocketError("COMMAND_TIMEOUT", "操作确认超时，已重新同步房间状态。", true),
      );
      needsPostWelcomeSyncRef.current = true;
      if (welcomedRef.current) requestSyncRef.current();
      return;
    }
    pending.timer = window.setTimeout(() => {
      settlePendingWithError(
        pending.message.id,
        new MineRoomSocketError("COMMAND_TIMEOUT", "操作确认超时，已重新同步房间状态。", true),
      );
      needsPostWelcomeSyncRef.current = true;
      if (welcomedRef.current) requestSyncRef.current();
    }, remaining);
  }, [settlePendingWithError]);

  const sendEnvelope = useCallback((message: CommandMessage): boolean => {
    const socket = socketRef.current;
    if (!welcomedRef.current || !socket || socket.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }, []);

  const sendCommand = useCallback((command: RoomCommand): Promise<AckMessage> => {
    const activeSession = sessionRef.current;
    if (!activeSession) {
      return Promise.reject(
        new MineRoomSocketError("NOT_CONNECTED", "尚未加入房间。", true),
      );
    }

    const sequence = sequenceRef.current + 1;
    sequenceRef.current = sequence;
    saveSequence(activeSession, sequence);
    const message: CommandMessage = {
      v: MINE_PROTOCOL_VERSION,
      type: "command",
      id: createMessageId(),
      sequence,
      command,
    };

    return new Promise<AckMessage>((resolve, reject) => {
      const pending: PendingCommand = {
        message,
        expiresAt: Date.now() + COMMAND_TIMEOUT_MS,
        timer: null,
        resolve,
        reject,
      };
      pendingCommandsRef.current.set(message.id, pending);
      armPendingTimeout(pending);
      if (!sendEnvelope(message)) {
        needsPostWelcomeSyncRef.current = true;
        // Keep the exact envelope pending. The welcome handler re-sends it
        // after a connecting or reconnecting socket has authenticated.
      }
    });
  }, [armPendingTimeout, sendEnvelope]);

  useEffect(() => {
    sendCommandRef.current = sendCommand;
  }, [sendCommand]);

  const requestSync = useCallback(() => {
    if (syncInFlightRef.current || !welcomedRef.current) return;
    syncInFlightRef.current = true;
    void sendCommandRef.current({ op: "sync" })
      .then(() => {
        needsPostWelcomeSyncRef.current = false;
      })
      .catch(() => {
        needsPostWelcomeSyncRef.current = true;
      })
      .finally(() => {
        syncInFlightRef.current = false;
      });
  }, []);

  useEffect(() => {
    requestSyncRef.current = requestSync;
  }, [requestSync]);

  const schedulePing = useCallback(() => {
    clearPingTimer();
    pingTimerRef.current = window.setInterval(() => {
      const socket = socketRef.current;
      if (!welcomedRef.current || !socket || socket.readyState !== WebSocket.OPEN) return;
      try {
        // The Durable Object answers this exact frame through an auto-response,
        // so a quiet room can stay hibernated.
        socket.send("ping");
      } catch {
        needsPostWelcomeSyncRef.current = true;
      }
    }, PING_INTERVAL_MS);
  }, [clearPingTimer]);

  const acceptSnapshot = useCallback(
    (snapshot: RoomSnapshot, source: "welcome" | "snapshot") => {
      const activeSession = sessionRef.current;
      if (!activeSession || snapshot.room.code !== activeSession.code) return;
      // Equal revisions are valid (for example, a reconnect or presence-only refresh).
      if (source !== "welcome" && snapshot.room.version < lastVersionRef.current) return;
      lastVersionRef.current = snapshot.room.version;
      updateServerTime(snapshot.serverTime);
      setRoom(snapshot.room);
      callbacksRef.current.onSnapshot?.(snapshot.room, source);
    },
    [updateServerTime],
  );

  const handleMessage = useCallback((message: ServerMessage) => {
    if (message.type === "welcome") {
      if (!isRoomSnapshot(message.snapshot)) {
        reportError({ code: "BAD_SERVER_MESSAGE", message: "房间服务返回了无效快照。" });
        return;
      }
      const previousSession = sessionRef.current;
      const nextSession = mergeSessionIdentity(previousSession, message.identity);
      if (!nextSession) {
        reportError({ code: "BAD_SERVER_IDENTITY", message: "房间服务返回了不匹配的身份。" }, true);
        return;
      }
      persistSession(nextSession);
      welcomedRef.current = true;
      reconnectAttemptRef.current = 0;
      setStatus("connected");
      setError(null);
      acceptSnapshot(message.snapshot, "welcome");
      schedulePing();

      // WebSocket frames are ordered. Re-send the exact same envelopes first,
      // then issue a higher-sequence sync command. Applied duplicates receive
      // an ACK; commands lost before reaching the DO are applied once.
      const pending = [...pendingCommandsRef.current.values()].sort(
        (left, right) => left.message.sequence - right.message.sequence,
      );
      for (const item of pending) {
        armPendingTimeout(item);
        sendEnvelope(item.message);
      }
      if (needsPostWelcomeSyncRef.current || pending.length > 0) {
        needsPostWelcomeSyncRef.current = false;
        requestSyncRef.current();
      }
      return;
    }

    if (message.type === "snapshot") {
      if (!isRoomSnapshot(message.snapshot)) {
        reportError({ code: "BAD_SERVER_MESSAGE", message: "房间服务返回了无效快照。" });
        return;
      }
      acceptSnapshot(message.snapshot, "snapshot");
      return;
    }

    if (message.type === "session") {
      const activeSession = sessionRef.current;
      const nextSession = mergeSessionIdentity(activeSession, message.identity);
      if (!nextSession) {
        reportError({ code: "BAD_SERVER_IDENTITY", message: "房间身份更新不匹配。" }, true);
        return;
      }
      persistSession(nextSession);
      return;
    }

    if (message.type === "ack") {
      const pending = pendingCommandsRef.current.get(message.id);
      if (!pending || pending.message.sequence !== message.sequence) return;
      pendingCommandsRef.current.delete(message.id);
      if (pending.timer !== null) window.clearTimeout(pending.timer);
      pending.resolve(message);
      return;
    }

    if (message.type === "error") {
      const socketError = new MineRoomSocketError(
        message.code,
        message.message,
        message.retryable === true,
      );
      if (message.id) settlePendingWithError(message.id, socketError);
      reportError({
        code: socketError.code,
        message: socketError.message,
        retryable: socketError.retryable,
      });
    }
  }, [
    acceptSnapshot,
    armPendingTimeout,
    persistSession,
    reportError,
    schedulePing,
    sendEnvelope,
    settlePendingWithError,
  ]);

  const openSocket = useCallback((nextSession: RoomSession, reconnecting: boolean) => {
    if (typeof window === "undefined") return;
    clearReconnectTimer();
    clearPingTimer();

    const previousSession = sessionRef.current;
    if (!sameIdentity(previousSession, nextSession)) {
      rejectAllPending(new MineRoomSocketError("SESSION_CHANGED", "房间身份已切换。"));
      sequenceRef.current = readSequence(nextSession);
      lastVersionRef.current = 0;
    } else {
      sequenceRef.current = Math.max(sequenceRef.current, readSequence(nextSession));
    }

    intentionalCloseRef.current = false;
    welcomedRef.current = false;
    const generation = ++connectionGenerationRef.current;
    const previousSocket = socketRef.current;
    socketRef.current = null;
    if (previousSocket && previousSocket.readyState < WebSocket.CLOSING) {
      previousSocket.close(1000, "replaced");
    }

    persistSession(nextSession);
    setStatus(reconnecting ? "reconnecting" : "connecting");
    setError(null);

    let socket: WebSocket;
    try {
      socket = new WebSocket(createSocketUrl(nextSession.code));
    } catch {
      reportError({ code: "SOCKET_CREATE_FAILED", message: "无法建立房间连接。", retryable: true }, true);
      rejectAllPending(new MineRoomSocketError("SOCKET_CREATE_FAILED", "无法建立房间连接。", true));
      return;
    }
    socketRef.current = socket;

    socket.addEventListener("open", () => {
      if (generation !== connectionGenerationRef.current) return;
      const activeSession = sessionRef.current;
      if (!activeSession || activeSession.code !== nextSession.code) return;
      const joinMessage: JoinMessage = {
        v: MINE_PROTOCOL_VERSION,
        type: "join",
        session: activeSession,
      };
      socket.send(JSON.stringify(joinMessage));
    });

    socket.addEventListener("message", (event) => {
      if (generation !== connectionGenerationRef.current) return;
      try {
        const rawMessage = String(event.data);
        if (rawMessage === "pong") return;
        const parsed: unknown = JSON.parse(rawMessage);
        if (!isServerMessage(parsed)) {
          reportError({ code: "BAD_SERVER_MESSAGE", message: "房间服务返回了无法识别的消息。" });
          return;
        }
        handleMessage(parsed);
      } catch {
        reportError({ code: "BAD_SERVER_MESSAGE", message: "房间消息解析失败。" });
      }
    });

    socket.addEventListener("error", () => {
      if (generation !== connectionGenerationRef.current) return;
      reportError({ code: "SOCKET_ERROR", message: "房间连接发生网络错误，正在尝试重连。", retryable: true });
    });

    socket.addEventListener("close", (event) => {
      if (generation !== connectionGenerationRef.current) return;
      socketRef.current = null;
      welcomedRef.current = false;
      clearPingTimer();
      if (!mountedRef.current || intentionalCloseRef.current) return;

      needsPostWelcomeSyncRef.current = true;
      if (event.code === 1000 || event.code === 1008 || (event.code >= 4000 && event.code <= 4999)) {
        const mayConfirmLeave = (event.code === 1000 && event.reason === "Membership left")
          || event.code === 4401
          || event.code === 4403
          || event.code === 4404;
        const leaveCompleted = mayConfirmLeave && resolvePendingLeave();
        const closeError = new MineRoomSocketError(
          `SOCKET_CLOSED_${event.code}`,
          event.reason || "房间连接已关闭。",
          false,
        );
        rejectAllPending(closeError);
        if (leaveCompleted || event.code === 4401 || event.code === 4403 || event.code === 4404) {
          clearActiveSession(false);
        } else if (event.code === 4408) {
          // Another tab now owns this socket identity. Exit the stale UI but
          // leave shared localStorage intact for the replacement tab.
          clearActiveSession(true);
        }
        setStatus(event.code === 1000 ? "disconnected" : "error");
        return;
      }

      setStatus("reconnecting");
      const attempt = reconnectAttemptRef.current;
      reconnectAttemptRef.current += 1;
      const baseDelay = RECONNECT_DELAYS[Math.min(attempt, RECONNECT_DELAYS.length - 1)];
      const delay = Math.round(baseDelay * (0.85 + Math.random() * 0.3));
      reconnectTimerRef.current = window.setTimeout(() => {
        const activeSession = sessionRef.current;
        if (activeSession && mountedRef.current && !intentionalCloseRef.current) {
          openSocketRef.current(activeSession, true);
        }
      }, delay);
    });
  }, [
    clearPingTimer,
    clearReconnectTimer,
    clearActiveSession,
    handleMessage,
    persistSession,
    rejectAllPending,
    reportError,
    resolvePendingLeave,
  ]);

  useEffect(() => {
    openSocketRef.current = openSocket;
  }, [openSocket]);

  const connect = useCallback((value: RoomSession) => {
    const nextSession = normalizeSession(value);
    if (!nextSession) {
      reportError({ code: "INVALID_SESSION", message: "房间身份无效，请重新加入。" }, true);
      return false;
    }
    reconnectAttemptRef.current = 0;
    needsPostWelcomeSyncRef.current = false;
    openSocket(nextSession, false);
    return true;
  }, [openSocket, reportError]);

  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  const stopCurrentConnection = useCallback((nextStatus: MineRoomConnectionStatus) => {
    intentionalCloseRef.current = true;
    ++connectionGenerationRef.current;
    clearReconnectTimer();
    clearPingTimer();
    welcomedRef.current = false;
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "client paused");
    rejectAllPending(new MineRoomSocketError("CONNECTION_CLOSED", "房间连接已暂停。", true));
    setStatus(nextStatus);
  }, [clearPingTimer, clearReconnectTimer, rejectAllPending]);

  const createRoom = useCallback(async (requestedName: string, difficulty: Difficulty) => {
    if (typeof window === "undefined") return null;
    const name = requestedName.trim().slice(0, 64);
    if (!name) {
      reportError({ code: "INVALID_NAME", message: "请先填写你的名字。" }, true);
      return null;
    }

    stopCurrentConnection("creating");
    const requestGeneration = connectionGenerationRef.current;
    setError(null);
    const request: CreateRoomRequest = { v: MINE_PROTOCOL_VERSION, name, difficulty };
    try {
      const response = await fetch("/api/rooms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      const membership = await readMembershipResponse(response, "创建房间失败，请稍后再试。");
      if (!mountedRef.current || connectionGenerationRef.current !== requestGeneration) return null;
      if (membership.room) {
        lastVersionRef.current = membership.room.version;
        setRoom(membership.room);
      }
      openSocket(membership.session, false);
      return membership.session;
    } catch (requestError) {
      if (!mountedRef.current || connectionGenerationRef.current !== requestGeneration) return null;
      const socketError = requestError instanceof MineRoomSocketError
        ? requestError
        : new MineRoomSocketError("CREATE_ROOM_NETWORK", "无法连接到房间服务。", true);
      reportError({ code: socketError.code, message: socketError.message, retryable: socketError.retryable }, true);
      return null;
    }
  }, [openSocket, reportError, stopCurrentConnection]);

  const joinRoom = useCallback(async (
    requestedRoomCode: string,
    requestedName: string,
    role: RoomRole = "player",
  ) => {
    if (typeof window === "undefined") return null;
    const roomCode = sanitizeRoomCode(requestedRoomCode);
    const name = requestedName.trim().slice(0, 64);
    if (!isRoomCode(roomCode)) {
      reportError({ code: "INVALID_ROOM_CODE", message: "房间码应为 6 位字母或数字。" }, true);
      return null;
    }
    if (!name) {
      reportError({ code: "INVALID_NAME", message: "请先填写你的名字。" }, true);
      return null;
    }

    const stored = readStoredSession(roomCode);
    if (stored && stored.playerName === name && stored.role === role) {
      connect(stored);
      return stored;
    }

    stopCurrentConnection("joining");
    const requestGeneration = connectionGenerationRef.current;
    setError(null);
    const request: JoinRoomRequest = { v: MINE_PROTOCOL_VERSION, name, role };
    try {
      const response = await fetch(`/api/rooms/${roomCode}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // `op` keeps the request compatible with the previous HTTP route while
        // `role` is the canonical v1 protocol field.
        body: JSON.stringify({
          ...request,
          op: role === "player" ? "join" : "spectate",
        }),
      });
      const membership = await readMembershipResponse(response, "加入房间失败，请稍后再试。");
      if (!mountedRef.current || connectionGenerationRef.current !== requestGeneration) return null;
      if (membership.room) {
        lastVersionRef.current = membership.room.version;
        setRoom(membership.room);
      }
      openSocket(membership.session, false);
      return membership.session;
    } catch (requestError) {
      if (!mountedRef.current || connectionGenerationRef.current !== requestGeneration) return null;
      const socketError = requestError instanceof MineRoomSocketError
        ? requestError
        : new MineRoomSocketError("JOIN_ROOM_NETWORK", "无法连接到房间服务。", true);
      reportError({ code: socketError.code, message: socketError.message, retryable: socketError.retryable }, true);
      return null;
    }
  }, [connect, openSocket, reportError, stopCurrentConnection]);

  const disconnect = useCallback((disconnectOptions: DisconnectOptions = {}) => {
    const { forgetCredentials = false } = disconnectOptions;
    stopCurrentConnection("disconnected");
    if (forgetCredentials) {
      clearActiveSession(false);
      setError(null);
      setStatus("idle");
    }
  }, [clearActiveSession, stopCurrentConnection]);

  const pause = useCallback(() => disconnect({ forgetCredentials: false }), [disconnect]);

  const resumeLastRoom = useCallback(() => {
    if (typeof window === "undefined") return false;
    const stored = readLastStoredSession();
    return stored ? connect(stored) : false;
  }, [connect]);

  const sendAction = useCallback(
    (action: WireAction) => sendCommand({ op: "action", action }),
    [sendCommand],
  );

  const sendChat = useCallback(
    (content: string) => sendCommand({ op: "chat", content }),
    [sendCommand],
  );

  const switchRole = useCallback(
    (targetRole: RoomRole) => sendCommand({ op: "switchRole", targetRole }),
    [sendCommand],
  );

  const sync = useCallback(() => sendCommand({ op: "sync" }), [sendCommand]);

  const leaveMembership = useCallback(async () => {
    const ack = await sendCommand({ op: "leaveMembership" });
    disconnect({ forgetCredentials: true });
    return ack;
  }, [disconnect, sendCommand]);

  const clearError = useCallback(() => setError(null), []);
  const getServerNow = useCallback(() => Date.now() + serverTimeOffsetRef.current, []);

  useEffect(() => {
    mountedRef.current = true;
    const generationRef = connectionGenerationRef;
    const resumeTimer = autoResume
      ? window.setTimeout(() => {
          const stored = readLastStoredSession();
          if (stored) connectRef.current(stored);
        }, 0)
      : null;
    return () => {
      mountedRef.current = false;
      intentionalCloseRef.current = true;
      generationRef.current += 1;
      if (resumeTimer !== null) window.clearTimeout(resumeTimer);
      clearReconnectTimer();
      clearPingTimer();
      const socket = socketRef.current;
      socketRef.current = null;
      if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "component unmounted");
      rejectAllPending(new MineRoomSocketError("COMPONENT_UNMOUNTED", "房间页面已关闭。"));
    };
  }, [autoResume, clearPingTimer, clearReconnectTimer, rejectAllPending]);

  return {
    status,
    connected: status === "connected",
    roomCode: session?.code ?? null,
    session,
    room,
    error,
    serverTimeOffsetMs,
    connect,
    disconnect,
    pause,
    resumeLastRoom,
    createRoom,
    joinRoom,
    sendCommand,
    sendAction,
    sendChat,
    switchRole,
    leaveMembership,
    sync,
    clearError,
    getServerNow,
  };
}
