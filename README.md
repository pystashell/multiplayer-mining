# 同雷共苦

多人协作扫雷，使用 React、vinext、Cloudflare Workers、Durable Objects 和 Hibernating WebSockets。

## 在线体验

[点击进入多人扫雷](https://multiplayer-mining.pystashell.workers.dev/)

## 架构

- 一个房间对应一个 `MineRoom` Durable Object。
- 浏览器通过同源 WebSocket 与房间保持双向连接，不再轮询。
- Durable Object 串行处理揭格、标记、聊天、角色切换和复活选择。
- 房间状态写入 Durable Object 持久化存储；休眠和重新实例化后可恢复。
- WebSocket 空闲时允许 Durable Object hibernate，连接仍由 Cloudflare 保持。
- 客户端心跳由 WebSocket auto-response 直接回答，不唤醒休眠中的房间对象。
- 广告复活和房间过期由 Durable Object Alarm 驱动。
- 建房、加入和新建 Socket 使用 Cloudflare 原生 Rate Limiting binding 防滥用。

隐藏雷位只存在于服务端原始状态中。进行中的公开快照不会包含未揭开的雷。

## 本地开发

需要 Node.js `>=22.13.0`。

```bash
npm install
npm run dev
```

完整 Cloudflare 运行时预览：

```bash
npm run preview
```

## 验证

```bash
npm run typecheck
npm run lint
npm test
```

真实双 WebSocket 冒烟测试需要先运行 `npm run preview`，然后在另一终端执行：

```bash
npm run test:live
```

可用 `MINEFIELD_URL` 指向已部署环境：

```powershell
$env:MINEFIELD_URL = "https://your-worker.workers.dev"
npm run test:live
```

## 部署到 Cloudflare

```bash
npx wrangler login
npm run deploy:dry
npm run deploy
```

`wrangler.jsonc` 声明 `MINE_ROOMS` binding、`MineRoom` SQLite migration 和三组入口限流。网页、API、WebSocket 和 Durable Object 使用同一 Worker 域名。

## 身份与连接

创建或加入房间时，入口 Worker 生成高熵 token，只把哈希写入房间状态。浏览器建立 WSS 后在首条 `join` 消息中发送 token；token 不进入 URL。

客户端使用带 `id` 和 `sequence` 的命令信封，服务端持久化去重，断线重连后可以安全重发未确认命令。
