import { createRoom, enforceRateLimit, RoomError } from "../../../lib/rooms";

export const dynamic = "force-dynamic";

function errorResponse(error: unknown) {
  const status = error instanceof RoomError ? error.status : 500;
  const message = error instanceof RoomError ? error.message : "雷区服务暂时开小差了。";
  return Response.json({ error: message }, { status, headers: { "cache-control": "no-store" } });
}

function verifyOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) throw new RoomError("无法验证这次请求。", 403);
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > 4096) throw new RoomError("请求内容太长。", 413);
}

export async function POST(request: Request) {
  try {
    verifyOrigin(request);
    await enforceRateLimit(request, "create-room", 12, 10 * 60 * 1000);
    const payload = await request.json() as { name?: unknown; difficulty?: unknown };
    const result = await createRoom({ name: payload.name, difficulty: payload.difficulty });
    return Response.json(result, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
