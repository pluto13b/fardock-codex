# R5 Web ready-channel transport

2026-09-09 首字延迟优化范围：用户确认主要是发送后等待很久才开始回复。先测量已授权链路各阶段，不改变模型/推理选择、文字原文或接受回执语义。重点检查串行请求中的历史读取和持久化成本、首个 owned 文本通知到快照的延迟，以及轮询对发送/显示的阻塞；任何调度或缓存优化必须保留 seq/ack 顺序、授权检查、动作幂等和有界资源，不能用缓存状态授予写权限。Gateway 仍只路由密文，不添加明文诊断或独立模型请求。

2026-09-09 用户限定性能范围为 Codex Plus 自有链路；官方 CLI 的上游网络、重试和模型生成不属于本项目优化或性能宣传范围。Web 修正刷新调度：成功请求按“开始到开始”的目标间隔调度，扣除已经花掉的读取时间，保留至少 100 ms 空隙，不在慢请求后再固定空等 500 ms；仍只允许一个在途读取、后台暂停、失败指数退避和旧快照拒绝，不改变协议或增加轮询并发。

2026-09-06 全项目列表：沿用 `task.list(cursor)` 和 `workspace.list`；Host 在官方列表/读取时登记工作区，Web 在读取任务页之后取得对应工作区短名称。首屏只加载一页，“加载更多任务”继续到上游 cursor 结束，取消原先最多十页的静默截断。分页错误可重试，旧 client 的回包不能覆盖新连接；完整重握手后优先读取原选中 taskId，即使它不在第一页，也保留当前任务与草稿。

## 最小边界

2026-09-05 更新：增加只读 `model.list`（模型与可用推理强度取自 owned app-server）。E2EE transport 的终止必须与 carrier 断线共同通知外层，关闭旧 channel 后自动使用已保存授权恢复。FormalBootstrap 保留已挂载 App 与当前任务/草稿；重连期间所有写动作禁用，恢复时只刷新权威状态，不重发消息。后台停止轮询但不主动断 socket，回到前台验证实际存活并在需要时恢复；不能保证操作系统冻结后的 TCP 永久在线。

Web transport 只接收已经完成配对和 E2EE session ready 的 genuine client `EstablishedSessionChannel`，并通过按运行时隔离的 local-test 或 production Relay carrier 收发 raw encrypted envelope。配对与 IndexedDB 平台持久化由外层 paired client 负责，transport 本身不读取私钥或建立不安全内存默认值。

当前只开放十二个 unary operation：

- `manage.read`
- `pairing.create`
- `device.rename`
- `device.revoke`
- `workspace.list`
- `task.list`
- `task.read`
- `task.start`
- `turn.send`（保留 Unicode 与首尾空白）
- `turn.steer`
- `turn.interrupt`
- `request.resolve`

`task.subscribe` 仍固定拒绝。正式 `main.tsx` / `App.tsx` 与 `/manage` 都通过同一个已配对 client 使用该 transport；刷新后由 D3 IndexedDB identity/transport state 完整新握手恢复，不复活旧 session key。

## 状态与安全规则

2026-09-05 增量文本：Windows 消费 owned app-server 的 item/agentMessage/delta 与 agentMessage started/completed 通知，只在内存保留有界文本视图；仅当前已接受的 owned task/turn 可以合入 task.read，不能据增量授予写权限或更改任务终态。页面继续使用现有 500ms 串行刷新，读取生成中的文本，而不是等落盘全文。实时文本版本进入现有 snapshot sequence/cursor；同 revision 的新 sequence 可以更新已裁剪历史窗口，旧 sequence 不得覆盖新文本。正文不进入日志/SQLite，也不采集原始 reasoning。

2026-09-05 手机前台恢复：现场断开码 1006，Host 未断线。foreground 先用已认证 Relay 的 device.ping/pong 验证物理 socket，不用会消费 E2EE 序号的请求探测半开连接。空闲、无 pending/inbound frame、outbound high-water 全已 ack 且本进程 E2EE handle 仍有效时，可在新的 owner-gated signing challenge socket 上复用同一 E2EE session，再以加密 workspace.list 验证 Host 连续性；不重发任何旧 frame/action。任一条件不满足或连续性验证失败都销毁旧 session、从保存的设备身份完整握手。浏览器/Host 进程重启仍不能保留会话密钥。

后台暂停非安全业务/receipt deadline 与新请求；前台恢复先给已到达的缓冲帧处理机会，消息 TTL、签名/nonce/seq/epoch 校验不暂停。UI 将浏览器恢复显示为“手机连接恢复中”，不把它解释为工作电脑离线；保留任务与草稿。预览仍可独立处理页面可见性，正式页由唯一连接生命周期驱动刷新。

1. 每个请求先登记唯一 pending `requestId`，再串行调用 E2EE seal；串行只覆盖 seal/序号持久化，避免首屏并发 `workspace.list` + `task.list` 触发 directional backpressure。
2. 查询请求使用 transport 生成的不透明 request id；`task.start`、`turn.send`、`turn.steer` 必须使用 `actionId` 作为 envelope request id。
3. carrier 的 `sendEnvelope` 只返回 Relay 路由 receipt。`relayed` 仅记录为 carrier 状态，绝不 resolve `CodexServeTransport.request()`；只有 Host 发回并经 `openEstablishedApplication` 验证的 encrypted `ApplicationResponse` 才能完成请求。
4. 响应必须同时匹配 pending request id、operation、task id；`turn.send` 还必须匹配 action id。未知、重复、非 response、错 operation/task/action 或协议错误均使 transport 失败关闭并拒绝全部 pending。
5. authorization 活性检查、outbound sequence/frame persistence 与 inbound seq/ack commit 都是调用方注入的受信平台边界；transport 不提供不安全的内存生产默认值。
6. Relay `unavailable` / `rejected` 或 carrier 发送失败只产生传输失败，不伪造 Codex `accepted`。
7. 收件队列最多 16 帧/8 MiB，最近 Relay receipt 最多记录 128 条；超过边界立即失败关闭，不建立无界 Web 内存队列。
8. 同时 pending 的 unary 请求最多 16 个。请求在取得 seal 串行锁前超时会从队列移除，之后不得 seal 或发送；`turn.send` 一旦进入 seal 阶段，其超时结果只能是 `outcome-unknown` 并关闭 channel，不能伪装成确定未执行的普通超时。只读请求仍可返回 `request-timeout`。
9. `turn.send` 收到持久 accepted/queued 回执后立即清空草稿；官方 turn 仍在运行时，紧随其后的 `task.read` 可能暂时返回不可读，页面只提示“已提交，稍后点击任务刷新”，不得把已经执行的动作误报为发送失败。点击任一任务总是重新读取，不复用旧快照。

## R3 authenticated carrier

`apps/codex-web/src/relay-carrier.ts` 是最小浏览器 Relay carrier，边界固定如下：

- 构造时必须显式传入 `mode: "r3-local-test"`，只接受带端口的数值 loopback `http://127.0.0.1` / `http://[::1]` Relay origin 和对应 `ws://.../api/ws`；没有公网或 TLS 降级开关。
- 只发送 Client `device.hello(authMode=challenge)`。收到的 challenge 与 welcome 必须逐字段匹配 `hostId`、Host/Client device、authorization id/epoch 和 Relay origin；challenge 的规范签名输入交给调用方 `signChallenge`，carrier 不持有或持久化 signing private key。
- ready 后只接受 strict canonical `RoutedEnvelope` 或 `RelayReceipt` 文本帧。入站 envelope 必须是 Host 到当前 Client 的精确 route；其他 control、二进制、未知 receipt、generation/requestId/seq 不匹配或重复 receipt 都失败关闭。
- `sendEnvelope` 先严格解码并验证当前 Client 到 Host route，再按 `connectionGeneration + requestId + seq` 登记最多 128 个 receipt waiter；每个 waiter 有硬超时。Relay receipt 只返回给上层 transport，不等于应用成功。
- 入站 envelope 使用最多 16 帧/8 MiB 的 FIFO，并串行调用唯一订阅者；没有订阅者时也只允许在该边界内短暂排队。handler 失败、溢出、socket 错误或主动 close 都清空队列并拒绝全部 pending。
- 正式路径使用浏览器全局 `WebSocket`；Node `ws` 只通过不进入正式入口的 package-private 测试 factory seam 注入，用于真实 R3 server 集成测试。

## Ready-session 组合边界

Windows Companion 对已完成 ready 的 Host channel 只公开一个固定 `onEnvelope` 高层 handler：浏览器 carrier 发来的 raw envelope 经真实 Relay 到达后，必须直接进入 single-open Host dispatcher；dispatcher 产生并持久化 encrypted response 后，handler 才调用注入的 Host `sendEnvelope` 原路返回。它不公开任意 RPC、预解密路由或业务成功回调。

Host handler 必须重新核对 response envelope 与 Relay receipt 的 `connectionGeneration + requestId + seq` 且 receipt `state` 必须为 `relayed`。receipt 缺失、发送失败、字段不匹配、非 `relayed`，以及 dispatcher 返回 `session-closed` 时，都使 ready channel 永久失败关闭。receipt 仍只证明 Relay 接受路由，不能取代 encrypted application response 或 Codex action receipt。

D3 已接入平台持久 identity/generation/seq/raw-frame；D4/D5 在同一 ready channel 上增加管理读取、设备动作和 P0 authority。AES/session key 仍只存在于当前进程，断线恢复不做旧 generation 明文重放。

## 本阶段验收

- genuine client/host channels + carrier 跑通管理读取、任务查询和已开放动作的固定 operation 映射；
- 真实 R3 server 上已授权 Client 完成 challenge/proof/welcome，并能与 Host 双向逐字转发 raw envelope、取得精确 receipt；
- 未知或 identity/receipt mismatch 使 carrier 失败关闭并拒绝 pending；
- 首屏两个 list 并发可 seal/send；
- `relayed` receipt 不提前完成请求；
- operation/task/action mismatch 失败关闭；
- `turn.send` 中文、换行、Emoji 与首尾空格逐字保持；
- 真实 loopback Relay 上，ready-channel `CodexServeClient` 与 Host 高层 handler 顺序跑通 list/read/text-send/read，且双向 receipt 只作为 transport evidence；
- Web typecheck/test 与 formal build boundary 通过，且正式入口仍未配对。
