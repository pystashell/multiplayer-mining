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
npm ci
npm run cf:typegen
npm run dev
```

完整 Cloudflare 运行时预览：

```bash
npm run preview
```

## 验证

```bash
npm run cf:typegen
npm run typecheck
npm run lint
npm test
```

`test:unit` 独立运行棋盘、房间规则与翻译测试，无需构建。`test:regression` 执行真实业务模块和真实 React/DOM 行为测试；`test:contracts` 检查源码与构建配置约定，须先 build。GitHub Actions 按同样顺序执行，并启动本地 workerd 运行双 WebSocket 测试。

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

协议版本为 **2**。客户端使用带 `id`、`sequence` 和 `expiresAt` 的命令信封。所有棋盘动作携带 `roundId`，重开和改难度另带 `observedGameRevision`；聊天及成员上线不会使棋盘版本前置条件失效。升级后旧页面需要刷新，已保存的房间凭据仍可使用。

认证 welcome 和 `STALE_SEQUENCE` 错误提供本成员的 `lastAcceptedSequence`。客户端只提升新命令的计数，未确认命令保留原 id/sequence；超过 30 秒的命令不会重发，服务端也拒绝到期的未执行命令。

新建和加入产生 60 秒预约，首次合法 WebSocket join 后才激活。预约到期由 Alarm 回收；已激活玩家暂停或断线仍保留席位。加入请求支持随机 32 字节 `idempotencyKey`，同一次网络失败重试复用同一预约；该 key 属于秘密凭据，不能记录到日志或放入 URL。历史存储无法区分旧预约与正式暂停成员，因此迁移时保守保留旧成员。

## 2026-10-01 评审修复

| 项目 | 修复与回归覆盖 |
| --- | --- |
| F01 恢复一致性 | 连接恢复不推进业务时间；事件入口显式推进、落盘、广播。覆盖 0/1/多连接、广告截止前/当时/之后及重复 Alarm。 |
| F02 预约回收 | 预约期限、HTTP 加入重试幂等、认证超时、正式成员暂停保留。 |
| F03 流控 | 入队前连接/成员各 30 次突发、每秒补充 15 次；房间 120 次突发、每秒补充 60 次；队列上限 64；每成员同步每秒 1 次。无变化操作只写回执与序列分区，不广播棋盘；广播复用一次序列化。 |
| F04 跨局命令 | 持久化局次与棋盘版本校验；包括两名玩家跨局延迟操作的真实 workerd 验证。 |
| F05 超时重放 | 重发前检查 deadline 与 pending map；已超时/已 ACK 不重发，未超时保留原信封。 |
| F06 HTTP 异常 | 所有异步分支纳入 await/catch，JSON 错误、超限和下游异常返回受控响应。 |
| F07 失联检测 | 25 秒心跳、10 秒 pong 和 welcome 期限；联网/可见性恢复时检查，忽略旧连接迟到事件。 |
| F08 序列恢复 | welcome/stale 水位校准，丢失本地计数后首个新命令可以执行。 |
| F09 无玩家事故 | 最后一名玩家明确退出时结束事故并结算失败，观众可接管和重开；仅暂停不结束事故。 |
| F10 存储异常 | 仅 hook 负责安全保存会话，页面直接使用其会话/快照/连接状态；覆盖存储方法/getter 抛错、损坏 JSON 和实际建房表单。 |
| F11 请求上限 | 按字节流式读取，超过 2 KiB 立即 cancel，支持分块 UTF-8。 |

另补齐类型生成和 CI；恢复失败保留原始存储并返回 503；倒计时使用服务端校准时间；清理成员时同步清理聊天限流与回执；难度校验拒绝继承属性。

测试边界：房间重建组合在真实适配器加可观察存储/连接桩中验证，客户端通过真实 React 与 jsdom 驱动；`test:live` 使用真实本地 workerd、WebSocket 和 Alarm。上述测试不等同于生产环境强制休眠或浏览器视觉验收。未做框架大版本升级；依赖审计应独立跟进。
