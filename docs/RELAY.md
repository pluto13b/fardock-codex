# Relay R2 设计与验收基线

> 状态：R2 localhost-only spike 的实现基线。它不是公网服务，也不表示配对、E2EE 或 Codex 已接通。

## 1. 目标与硬边界

R2 只验证“两个已知测试设备能经一个不读取正文的 Relay 交换 R1 `RoutedEnvelope`”。服务提供 `/healthz` 与 `/api/ws`，不提供任意 RPC、文件 API、任务 API、管理后台或模型入口。

- 只允许显式绑定 `127.0.0.1` 或 `::1`；没有允许公网监听的开关，也不提供部署入口。
- 此阶段不连接 Codex、不解密 `ciphertext`、不保存信封、不排队离线消息，也不持久化任何明文 credential；只为“注册已关闭”和 host resume 保存严格、最小的 credential 摘要状态。
- R2 测试凭据只用于本进程 loopback 测试。R3 的二维码配对、长期授权、撤销和 E2EE 完成前，任何真实浏览器或公网调用都保持禁用。
- Relay receipt 只表示 `relayed | unavailable | rejected`，绝不产生 `ActionReceipt.accepted`。
- Relay WebSocket 连接编号与 R1 `connectionGeneration` 无关。后者仍是端到端已认证密钥 epoch，Relay 不分配、递增或自动采纳它。

## 2. 服务表面

```text
GET /healthz  -> 200 {"status":"ok","mode":"r2-local-test","insecure":true}
WS  /api/ws   -> strict Relay hello，随后只接受 canonical RoutedEnvelope
其他 HTTP/upgrade path -> 404
```

`/healthz` 明示这是不安全的本地测试模式，但不返回 host、device、连接数、版本、路径或配置。服务工厂必须由调用方显式传入 `mode="r2-local-test"`、32-byte bootstrap credential 和状态文件路径；测试状态只能放在工作区 `.tmp`/`.data`。禁止从环境变量全集、Codex Home 或认证文件推断配置。R2 不增加会被误当成生产入口的默认 CLI。

可选 `Origin` 必须完全匹配调用方的 allowlist；错误的已提供 Origin 在 upgrade 前拒绝。无 `Origin` 只为本机原生测试 Host 保留，不能替代设备认证。

## 3. Relay 控制帧

控制帧使用 UTF-8 canonical JSON、strict schema、无未知字段，最大 4 KiB。所有 credential 都是 32-byte、无 padding 的 base64url。

### 3.1 hello

```text
protocolVersion = 1
relayType = "hello"
role = "host" | "client"
hostId
deviceId
authMode = "bootstrap" | "resume"
credential
sessionCredential?  // 仅 bootstrap；由 Host 预先生成
```

`bootstrap` 只允许 `host`，且必须同时携带由 Host 预先生成并本地保留的 `sessionCredential`。第一个合法 bootstrap 在回复 welcome 前用 exclusive-create + flush 原子写入最小状态文件；文件只含版本、关闭标志、host/device ID 和 session credential SHA-256 摘要。这样即使 welcome 丢失，Host 仍能用自己保存的 credential 做 resume。bootstrap、host session 与每个预置 client credential 必须两两不同，host/client identity 也不得冲突。已存在、部分写入、损坏或不可读的状态都不得重新开放注册。并发或后续 bootstrap 统一按 `not-authenticated` 失败，不能区分 host/device 是否存在。`client` 在 R2 只能通过服务构造参数预置测试 credential，网络上没有客户端注册接口。

### 3.2 welcome

```text
protocolVersion = 1
relayType = "welcome"
role
hostId
deviceId
authMode
registrationState = "closed"
heartbeatIntervalMs
maxFrameBytes
```

Relay 只保存 credential 的 SHA-256 摘要并用常量时间比较；日志、错误、health 和 receipt 均不得包含 credential。高熵 token 的摘要不是密码派生。重启可读取严格状态并保持注册关闭/host resume；R3 再由带授权 epoch、撤销和轮换的正式设备存储替换。

### 3.3 失败

认证前 malformed hello、超时、错误 credential、重复 bootstrap 和未知设备都发送同一个固定帧 `{"protocolVersion":1,"relayType":"error","code":"not-authenticated"}`（若连接仍可安全写入）并以 `4001/not-authenticated` 关闭。错误不回显输入、Zod detail、host/device、credential、ciphertext 或路径。

R2 应用 close code 固定为：`4001 not-authenticated`、`4002 protocol-violation`、`4008 rate-limited`、`4009 replaced`、`4010 heartbeat-timeout`；服务主动停止使用标准 `1012 service-restart`。reason 只能是这些固定短语。

心跳使用 WebSocket ping/pong control frame，不占用 R1 envelope `seq`。一个完整 heartbeat 周期未收到 pong 即终止连接。

## 4. 在线注册表与重连

在线注册表键为 `(hostId, deviceId)`，每个设备只能有一个活动 socket。合法 resume 建立新连接后，旧 socket 以固定 `replaced` close code 关闭；Relay 不把 WebSocket 重连解释成新 generation。

Relay 不保存离线信封。发送端保留有界未确认的原始 canonical envelope；重连后只能重发完全相同的信封。测试双端分别使用 `EnvelopeSequenceGuard` 验证 `seq/ack`：Relay 只检查可见路由和严格 wire schema，不代替端到端时序、AEAD 或幂等 authority。

## 5. 路由规则

已认证连接收到的每个数据帧必须：

1. 是 text frame，且不超过 `MAX_FRAME_BYTES`；
2. 通过 R1 canonical `decodeEnvelope` 与时效验证；
3. `fromDeviceId`、`hostId` 与认证身份完全一致；
4. `toDeviceId` 属于同一 host，且目标 role 与发送方相反；
5. 目标当前在线且未超过背压门限。

Relay 将原始 UTF-8 字节逐字转发，不能 parse 后重写。进入目标 socket 的 `send` 后向发送方返回非权威 `relayed` receipt；目标离线统一返回 `unavailable/host-unavailable`。身份或 canonical schema错误关闭连接，不返回可用于枚举的 route detail。

## 6. 资源边界

- hello deadline：5 秒；到期未认证即关闭。
- 每连接固定窗口同时限制 envelope 数和接收字节；超限返回 `rejected/rate-limited`，持续违规关闭。
- `target.bufferedAmount + frameBytes` 超过配置门限时不转发，返回 `rejected/backpressure`。
- frame、控制帧、连接数、速率窗口和 heartbeat 间隔都有显式有限值；测试可收紧数值，但不能关闭边界。
- 任一应用 close code 发出后最多保留 1 秒握手窗口，随后强制终止 socket，避免恶意 peer 长期占用连接额度。
- 关闭服务必须停止 timer、拒绝新 upgrade 并终止现有 socket，避免测试或部署残留监听器。

## 7. 日志白名单

日志事件只允许：`relay.started`、`relay.stopped`、`connection.authenticated`、`connection.closed`、`route.relayed`、`route.unavailable`、`route.rate_limited`、`route.backpressure`、`heartbeat.terminated`。

字段只允许固定 event、timestamp、role、outcome、frameBytes、closeCode 和当前连接计数。禁止记录 host/device/request/task ID、IP 完整值、URL query、Origin、credential、frame、ciphertext、明文、代码、命令、绝对路径、环境变量或异常对象。测试必须把日志序列化后用已知诱饵值反查泄漏。

## 8. R2 验收矩阵

- 非 loopback bind 在创建监听器前失败，监听后再次核验实际地址；`/healthz` 明示 `r2-local-test` 且其他 path 不可用。
- strict/canonical hello 生效：未知字段、空白变体、binary、超限、错误版本和错误 Origin 失败关闭。
- 首个 host bootstrap 只有在 Host 提供的 resume credential 摘要落盘后才成功，welcome 不返回秘密；第二次、并发 bootstrap 和错误 credential 均不可枚举；welcome 丢失或 Relay 重启后，注册仍关闭且 Host 可用已保留的 resume credential 重连；损坏状态失败关闭。
- 预置测试 client 可连接；未预置 client 没有公开注册路径。
- Web → Host 与 Host → Web 均逐字路由并得到 `relayed`；离线得到非权威 `unavailable`；跨 host、伪造 from、同 role 路由失败关闭。
- heartbeat 保活正常，并能清理未响应连接。
- 限流和背压分支可重复触发且不会转发被拒绝 frame。
- 同设备重连替换旧 socket，未确认原信封重发后由端点 `seq/ack` 状态机接受一次或拒绝 replay，Relay 不伪造业务成功。
- 采集日志不含 hello credential、ciphertext、诱饵 prompt/code、绝对路径或完整 frame。
- package typecheck、单元/真实 loopback integration tests、根 test/typecheck 和现有正式/preview build gate 全部通过。

## 9. 明确保留给 R3

R2 不实现或声明以下能力：公网 TLS/WSS、二维码 pair session、浏览器密钥存储、ECDH/HKDF/AES-GCM、带授权 epoch 的长期 authorization、撤销、密钥轮换、审批签名、附件或真实 Web adapter。任何一项缺失都意味着 Relay 仍只能用于 loopback 测试。
