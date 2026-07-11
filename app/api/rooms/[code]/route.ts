import {
  applyRoomAction,
  enforceRateLimit,
  getRoom,
  joinAsSpectator,
  joinRoom,
  postRoomMessage,
  RoomError,
  type WireAction,
} from "../../../../lib/rooms";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ code: string }> };

const noStore = { "cache-control": "no-store, max-age=0" };

function tokenFrom(request: Request) {
  return request.headers.get("x-player-token");
}

function errorResponse(error: unknown) {
  const status = error instanceof RoomError ? error.status : 500;
  const message = error instanceof RoomError ? error.message : "雷区服务暂时开小差了。";
  return Response.json({ error: message }, { status, headers: noStore });
}

function verifyOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) throw new RoomError("无法验证这次请求。", 403);
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > 4096) throw new RoomError("请求内容太长。", 413);
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const { code } = await context.params;
    const result = await getRoom(code, tokenFrom(request));
    return Response.json(result, { headers: noStore });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    verifyOrigin(request);
    const { code } = await context.params;
    const payload = await request.json() as {
      op?: string;
      name?: unknown;
      content?: unknown;
      message?: unknown;
      action?: WireAction;
    };
    if (payload.op === "join") {
      await enforceRateLimit(request, "join-room", 30, 10 * 60 * 1000);
      const result = await joinRoom(code, { name: payload.name });
      return Response.json(result, { status: 201, headers: noStore });
    }
    if (payload.op === "spectate") {
      await enforceRateLimit(request, "join-room", 30, 10 * 60 * 1000);
      const result = await joinAsSpectator(code, { name: payload.name });
      return Response.json(result, { status: 201, headers: noStore });
    }
    if (payload.op === "chat") {
      const result = await postRoomMessage(code, tokenFrom(request), payload.message ?? payload.content);
      return Response.json(result, { status: 201, headers: noStore });
    }
    if (payload.op === "action" && payload.action) {
      const result = await applyRoomAction(code, tokenFrom(request), payload.action);
      return Response.json(result, { headers: noStore });
    }
    throw new RoomError("无法识别这次操作。", 400);
  } catch (error) {
    return errorResponse(error);
  }
}
