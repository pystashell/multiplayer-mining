/** Cloudflare Worker entry point for the multiplayer minefield. */
import handler from "vinext/server/app-router-entry";
import {
  MINE_PROTOCOL_VERSION,
  isRoomCode,
  isRoomRole,
  type CreateRoomResponse,
  type Difficulty,
  type JoinRoomResponse,
  type RoomRole,
  type RoomSession,
} from "../shared/mine-protocol";
import { MineRoom } from "./MineRoom";

export { MineRoom };

const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_BODY_BYTES = 2 * 1024;
const MAX_ROOM_CODE_ATTEMPTS = 12;
const VALID_DIFFICULTIES = new Set<Difficulty>(["beginner", "intermediate", "expert"]);

interface Env {
  ASSETS: Fetcher;
  MINE_ROOMS: DurableObjectNamespace;
  ROOM_CREATE_LIMIT: RateLimit;
  ROOM_JOIN_LIMIT: RateLimit;
  ROOM_SOCKET_LIMIT: RateLimit;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

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

function hasAllowedOrigin(request: Request) {
  const origin = request.headers.get("Origin");
  return origin === null || origin === new URL(request.url).origin;
}

function normalizeName(value: unknown) {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/\s+/g, " ").slice(0, 16);
  return name.length > 0 ? name : null;
}

function createRoomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (byte) => ROOM_CODE_ALPHABET[byte & 31]).join("");
}

function createToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hashToken(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function enforceRateLimit(
  request: Request,
  limiter: RateLimit,
  scope: "create" | "join" | "socket",
): Promise<Response | null> {
  const clientAddress = request.headers.get("CF-Connecting-IP")
    ?? request.headers.get("X-Forwarded-For")?.split(",", 1)[0]?.trim()
    ?? "local-development";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${scope}:${clientAddress}`));
  const key = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const { success } = await limiter.limit({ key });
  return success ? null : jsonResponse({ error: "请求太频繁，请稍后再试。" }, 429);
}

async function readJsonBody(request: Request) {
  const declaredLength = Number(request.headers.get("Content-Length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new Response(JSON.stringify({ error: "请求内容太长。" }), {
      status: 413,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
    throw new Response(JSON.stringify({ error: "请求内容太长。" }), {
      status: 413,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    throw new Response(JSON.stringify({ error: "请求不是有效的 JSON。" }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
}

async function callRoom(stub: DurableObjectStub, request: Request) {
  const response = await stub.fetch(request);
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    return {
      ok: false as const,
      response: jsonResponse(
        { error: typeof payload?.error === "string" ? payload.error : "房间服务暂时不可用。" },
        response.status,
      ),
    };
  }
  return { ok: true as const, payload };
}

async function createRoom(request: Request, env: Env) {
  const value = await readJsonBody(request);
  if (!isRecord(value)) return jsonResponse({ error: "无法识别建房请求。" }, 400);
  if (value.v !== MINE_PROTOCOL_VERSION) return jsonResponse({ error: "客户端协议版本不兼容，请刷新页面。" }, 400);
  const name = normalizeName(value.name);
  const difficulty = value.difficulty;
  if (!name || typeof difficulty !== "string" || !VALID_DIFFICULTIES.has(difficulty as Difficulty)) {
    return jsonResponse({ error: "名字或难度不正确。" }, 400);
  }

  const token = createToken();
  const playerId = crypto.randomUUID();
  const tokenHash = await hashToken(token);

  for (let attempt = 0; attempt < MAX_ROOM_CODE_ATTEMPTS; attempt += 1) {
    const roomCode = createRoomCode();
    const stub = env.MINE_ROOMS.getByName(roomCode);
    const result = await callRoom(stub, new Request(new URL("/internal/init", request.url), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Room-Code": roomCode },
      body: JSON.stringify({
        v: MINE_PROTOCOL_VERSION,
        code: roomCode,
        name,
        difficulty,
        playerId,
        tokenHash,
      }),
    }));

    if (!result.ok) {
      if (result.response.status === 409) continue;
      return result.response;
    }

    const session: RoomSession = { code: roomCode, token, playerId, playerName: name, role: "player" };
    const body: CreateRoomResponse = {
      roomCode,
      session,
      ...(result.payload?.room ? { room: result.payload.room as CreateRoomResponse["room"] } : {}),
    };
    return jsonResponse(body, 201);
  }

  return jsonResponse({ error: "暂时无法分配房间码，请再试一次。" }, 503);
}

async function joinRoom(request: Request, env: Env, roomCode: string) {
  const value = await readJsonBody(request);
  if (!isRecord(value)) return jsonResponse({ error: "无法识别加入请求。" }, 400);
  if (value.v !== MINE_PROTOCOL_VERSION) return jsonResponse({ error: "客户端协议版本不兼容，请刷新页面。" }, 400);
  const name = normalizeName(value.name);
  const requestedRole = value.role ?? (value.op === "spectate" ? "spectator" : value.op === "join" ? "player" : null);
  if (!name || !isRoomRole(requestedRole)) return jsonResponse({ error: "名字或房间身份不正确。" }, 400);

  const role: RoomRole = requestedRole;
  const token = createToken();
  const playerId = crypto.randomUUID();
  const tokenHash = await hashToken(token);
  const stub = env.MINE_ROOMS.getByName(roomCode);
  const result = await callRoom(stub, new Request(new URL("/internal/join", request.url), {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Room-Code": roomCode },
    body: JSON.stringify({
      v: MINE_PROTOCOL_VERSION,
      name,
      role,
      playerId,
      tokenHash,
    }),
  }));
  if (!result.ok) return result.response;

  const session: RoomSession = { code: roomCode, token, playerId, playerName: name, role } as RoomSession;
  const body: JoinRoomResponse = {
    session,
    ...(result.payload?.room ? { room: result.payload.room as JoinRoomResponse["room"] } : {}),
  };
  return jsonResponse(body, 201);
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/api/rooms/health") {
        if (request.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET" } });
        return env.MINE_ROOMS.getByName("room-health-check").fetch(
          new Request(new URL("/internal/health", request.url)),
        );
      }

      if (url.pathname === "/api/rooms") {
        if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
        if (!hasAllowedOrigin(request)) return jsonResponse({ error: "请求来源不允许。" }, 403);
        const limited = await enforceRateLimit(request, env.ROOM_CREATE_LIMIT, "create");
        if (limited) return limited;
        return createRoom(request, env);
      }

      const socketMatch = /^\/api\/rooms\/([A-HJ-NP-Z2-9]{6})\/socket$/.exec(url.pathname);
      if (socketMatch) {
        const roomCode = socketMatch[1];
        if (!isRoomCode(roomCode)) return jsonResponse({ error: "房间码不正确。" }, 400);
        if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
          return jsonResponse({ error: "需要 WebSocket 连接。" }, 426);
        }
        if (!hasAllowedOrigin(request)) return jsonResponse({ error: "请求来源不允许。" }, 403);
        const limited = await enforceRateLimit(request, env.ROOM_SOCKET_LIMIT, "socket");
        if (limited) return limited;
        return env.MINE_ROOMS.getByName(roomCode).fetch(request);
      }

      const roomMatch = /^\/api\/rooms\/([A-HJ-NP-Z2-9]{6})$/.exec(url.pathname);
      if (roomMatch) {
        const roomCode = roomMatch[1];
        if (!isRoomCode(roomCode)) return jsonResponse({ error: "房间码不正确。" }, 400);
        if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
        if (!hasAllowedOrigin(request)) return jsonResponse({ error: "请求来源不允许。" }, 403);
        const limited = await enforceRateLimit(request, env.ROOM_JOIN_LIMIT, "join");
        if (limited) return limited;
        return joinRoom(request, env, roomCode);
      }

      if (url.pathname === "/api/rooms/" || url.pathname.startsWith("/api/rooms/")) {
        return jsonResponse({ error: "房间地址不正确。" }, 404);
      }

      return handler.fetch(request, env, ctx);
    } catch (error) {
      if (error instanceof Response) return error;
      console.error("Minefield worker request failed", error);
      return jsonResponse({ error: "房间服务暂时开小差了。" }, 500);
    }
  },
};

export default worker;
