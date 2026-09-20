# R3 Relay 配对与公钥认证基线

2026-09-07 production 增量：按用户确认增加 Host-only `pair.code.register/registered`，把本机明确点击创建的已开放 invitation 登记到现有 Owner 配对码内存池。该 control 不在 local-test profile 开放；检查当前 Host socket、Host/pairSession/expiry 与 fragment 的一致性，Host 离线/会合关闭时撤掉码。Origin、Owner 兑换、设备签名和 Host-first 授权维持原约束。细节见 PROTOCOL.md 与 DOCKER_GATEWAY.md 最新入口。

> 状态：R3b `r3-local-test` 已实现并通过真实 WebSocket 集成测试，2026-08-24。本文定义并验收配对会合、公钥 socket 认证和授权同步；R3c 端点平台密钥/序号持久化与生产部署仍未完成，因此 Relay 继续保持 loopback 测试级，不能开放公网。

## 1. 边界

R3 Relay 仍是不可信转发层。它可以验证“某个 socket 持有已登记的 signing private key”，但这只授予同一 host 下的路由权，不授予 Codex、workspace、task、审批或 app-server authority。应用 authority 只在 Windows 对当前 authorization epoch、session key-confirm、task snapshot 和动作幂等全部复核后成立。

Relay 可以持久化：Host/client route、P-256 signing public JWK/fingerprint、authorization id/epoch/status、Host 单调 authorization revision。不得持久化或记录 rendezvous secret、pair/session private key、agreement shared secret、AES key、device display name、正文、附件、OpenAI 凭据或 raw frame。

所有 R3 control 都使用 UTF-8 strict canonical JSON、拒绝 BOM/未知字段/二进制帧，单帧最多 16 KiB；未认证失败统一发送固定 `not-authenticated` 并关闭，不区分不存在、撤销、epoch、签名、bootstrap closed 或 malformed。

## 2. 标识不可混用

- Relay 内部 socket epoch 不上 wire，不等于 E2EE `connectionGeneration`。
- `pairSessionId`、`joinId`、`authorizationId`、`challengeId`、`handshakeId`、`keyId` 与 request/action id 都是独立随机标识。
- `authorizationEpoch` 由 Windows 持久授权递增；Relay 只能接受 Host 的单调同步，不能自行复活或降级。
- Relay receipt 仍只证明某帧被路由，绝不产生应用 `accepted`。

## 3. Device challenge

WebSocket 第一帧只有四种合法入口：Host bootstrap `device.hello`、已登记 Host/Client 的 challenge `device.hello`，或未认证配对端的 `pair.join`。第一帧超时、二进制、超限或不属于这些 strict union 时统一失败。

`device.hello` 固定公共字段：

```text
protocolVersion = 1
relayType = "device.hello"
relayOrigin                 必须与 Relay 配置完全相同
role = "host" | "client"
authMode = "bootstrap" | "challenge"
hostId
hostDeviceId
deviceId
```

分支约束：

- Host bootstrap：`role=host`、`authMode=bootstrap`、`deviceId=hostDeviceId`，另含 32-byte `bootstrapCredential`、`hostSigningKey` 和 RFC 7638 `hostSigningFingerprint`。credential 只从进程内配置读取，不进 URL/日志/状态；登记成功后永久关闭。
- Host challenge：`role=host`、`authMode=challenge`、`deviceId=hostDeviceId`；Relay 从持久 Host record 取 signing key。
- Client challenge：`role=client`、`authMode=challenge`，另含 `authorizationId + authorizationEpoch`；route 与 active authorization record 必须完全一致。

Relay 先完成 strict schema、origin、route、epoch/status 与真实 P-256 curve import，再生成：

```text
protocolVersion = 1
relayType = "device.challenge"
role / authMode / hostId / hostDeviceId / deviceId
authorizationId / authorizationEpoch   仅 client 分支
hostSigningFingerprint                 仅 bootstrap 分支
challengeId
challenge                   32 random bytes
issuedAt / expiresAt        最多 15 秒
```

每 socket 同时只能有一个 challenge。`device.proof` 回显 challenge 的 identity、`challengeId`，并带 64-byte raw ECDSA signature。签名输入只能由 `packages/protocol` 编码：

```text
[
  "codex-plus-relay-device-proof-v1",
  protocolVersion,
  relayOrigin,
  role,
  authMode,
  hostId,
  hostDeviceId,
  deviceId,
  authorizationId ?? null,
  authorizationEpoch ?? null,
  hostSigningFingerprint ?? null,
  challengeId,
  challenge,
  issuedAt,
  expiresAt
]
```

proof 只允许一次；time regression、重复 proof、socket replacement、错误签名或持久提交失败都关闭。Host bootstrap 必须先以 `create-exclusive + fsync` 写入 registration-closed Host public record，再发送 `device.welcome`。welcome 只回显已绑定 identity、heartbeat 和 frame 上限，不发 bearer/resume token。

## 4. 授权同步

只有当前已认证 Host socket 可以发送 `authorization.put`。active 分支固定含：

```text
protocolVersion = 1
relayType = "authorization.put"
hostId / hostDeviceId / clientDeviceId
authorizationId
authorizationEpoch
hostAuthorizationRevision
status = "active"
clientSigningKey / clientSigningFingerprint
```

revoked 分支含相同 identity、严格更大的 epoch/revision 和 `status="revoked"`，不接受新 key。规则：

- 新 authorization 只能从 epoch 1 / active 开始；id/device 不复用。
- 同一 canonical 内容可幂等重放；相同 revision 的不同内容失败关闭。
- revision、epoch 不得回退；revoked tombstone 永不变回 active。
- active 写盘成功后才回 `authorization.applied`；revoked 写盘成功后先关闭对应 Client socket，再回 applied。
- Host 重连用本机持久 revision/tombstone reconcile；Relay 不可达不改变 Windows 已撤销事实。

状态文件损坏、过大、部分写或 schema 不明时 Relay 启动失败关闭，不删除坏文件重开 bootstrap。状态更新采用同目录临时文件、文件 fsync、原子 replace，并在支持的平台 fsync 父目录；临时文件必须在工作区 `.data/.tmp`。

## 5. Pair carrier

已认证 Host 发送 strict `pair.open`：

```text
protocolVersion = 1
relayType = "pair.open"
hostId / hostDeviceId / pairSessionId
expiresAt                  不晚于 now + 300 秒
```

Relay 只在内存登记，Host socket 断开、Relay 重启或到期立即失效，不做恢复。成功后回 strict `pair.opened` 原样 identity；同 id 同内容幂等，不同内容关闭。

未认证浏览器把 `packages/protocol` 的 canonical `pair.join` 作为第一帧。Relay 不解密、不检查 secret，也不因收到 ciphertext 自动 claim：

1. 严格解码 pair frame/time/route，查找已打开 session。
2. 单 session 串行转发给当前 Host；最多 5 个 attempt socket，每 socket 只能一个 join。
3. Host 完整验证 AEAD、transcript、client signature 和 agreement PoP 后，发送 `pair.claim`（host/session/join identity）。
4. Relay 原子固定该 join，关闭其他 attempts，并回 `pair.claimed`；不存在/竞态统一 session unavailable。
5. Host 将 canonical opaque `pair.result` 原字节发送到已 claim socket；Relay 不解析 plaintext、不缓存、不重写。
6. Host 发送 `pair.close`，reason 只允许 `approved | denied | expired | attempt-limit | cancelled`；Relay 关闭全部 attempt 并清 session。

无 status/list/poll API。未认证端无法判断 session 是不存在、已 claim、已消费、撤销还是过期。Pair 日志只允许 event、时间、HMAC 化 session/socket 标识、结果、耗时和字节数。

## 6. Session 与 envelope 路由

2026-09-05 增加已认证 client 专用 device.ping/pong：固定 protocolVersion、relayType、随机 nonce，同一 socket 原样回显 nonce；不经过 Windows、不暴露设备目录/Host 状态、不赋予 E2EE 或动作权威。仍执行 owner session、Origin、当前 socket 身份和现有限流。它只检测手机后台恢复后的半开 socket，不能被当作 Host/E2EE healthy。

认证 Client 只能向授权记录绑定的同 host/hostDevice 发送 canonical `session.init`；认证 Host 只能把 matching `session.accept` 发给该 active Client。Relay 校验可见 route/epoch 与 socket identity 后逐字转发，既不验 E2EE 签名也不分配 generation。其他 session frame、跨 host/device/authorization、旧 epoch 或未知 target 关闭。

`session.confirm/ready` 和应用消息已经封装为 `RoutedEnvelope`。Relay 只做 canonical/time/route/当前 active authorization 校验并原字节转发；端点负责 AEAD、seq/ack、key-confirm 和 authority。已授权目标离线可以返回 generic unavailable receipt；未知/撤销/cross-route 不提供枚举 receipt。

## 7. 资源与生命周期

- `r3-local-test` facade 只允许数值 loopback bind，服务模式固定且没有 production 开关；D1 production Gateway 使用独立 factory/profile 复用本核心，不能通过 local facade 获得公网 bind。
- 全部 TCP、upgrade、unauth challenge、pair attempt、authenticated socket、frame/byte rate、outbound buffered bytes 和 state bytes 都有不可关闭的硬上限。
- 已认证 socket 的连续入站帧按 WebSocket 到达顺序进入单连接 FIFO 并串行处理，最多暂存 16 帧且合计不超过 8 MiB；超限以 `rate-limited` 关闭，不建立无界队列。未认证 proof/pair 首帧仍只允许一个在途操作，第二帧立即失败关闭。
- WebSocket compression 关闭；binary 拒绝；native ping/pong 只做连接存活，不混入 E2EE generation。
- 新 socket 认证提交后原子替换同 identity 的旧 socket；旧 handler 每次路由/回执前验证 record identity 仍是 current。
- shutdown 停止新 upgrade，清 challenge/pair secret-free state，关闭 socket，并等待所有在途持久操作有界完成；close 返回后不得继续项目 I/O。

## 8. R3b 验收

- Bootstrap challenge proof 成功一次后重启仍关闭；错误/并发 bootstrap、坏 state、写盘故障不重开。
- Host/Client challenge 的签名、origin、identity、epoch、challenge/time 任一篡改统一失败；challenge replay 和旧 socket 不能路由。
- authorization active/revoke/reconcile 单调、幂等、崩溃安全；revoked Client 立即失权且不能获得更具体错误。
- 垃圾 pair.join 不 claim；首个 Host-validated claim 唯一；五次/过期/断线终止；result 原字节只到 claimed socket。
- session.init/accept 与 envelope 只能在同 authorization route 双向转发，Relay 不修改 generation/seq/ack，不产生应用 accepted。
- 捕获全部日志、错误和 close reason，反查 bootstrap credential、challenge signature、JWK、fingerprint、ciphertext、device name、诱饵提示词与绝对路径为零。持久 state 只允许规范列出的 Host/client public JWK、fingerprint、identity、authorization epoch/status/revision 与 tombstone；反查 credential、signature、private key、pair secret、正文、设备显示名和绝对路径仍必须为零。
- protocol/Relay unit + 真实 WebSocket/fetch 集成、typecheck、根测试和正式前端 gate 全通过；即使全部通过，R3c 端点持久状态完成前仍不批准公网部署。
