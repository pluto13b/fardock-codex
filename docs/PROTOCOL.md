# Codex Plus 远程协议 v1

2026-09-07 Windows 本机连接入口增加两个严格的 Host-only Relay control：`pair.code.register` 包含 `protocolVersion / hostId / hostDeviceId / pairSessionId / expiresAt / invitationFragment`；`pair.code.registered` 以相同路由、pairSessionId、expiresAt 返回 8 位 Crockford `code`。单帧仍最多 16 KiB，Host client 只允许一个在途登记，回执必须精确匹配当前请求。Gateway 仅在 production profile、当前认证 Host 与仍开放的 invitation 完全匹配时处理，拒绝重复登记；pair.close、到期、Host socket 断开撤掉对应内存码。它不创建长期设备授权，手机仍必须 Owner 登录并完成既有 signed pairing/E2EE。Windows 私有控制只新增无参数 `pair`，不接受路径、密码、任意命令或远程调用。

> 状态：R1 通用信封/应用协议与 R3 pairing/session/Relay wire 均已实现并通过 canonical/篡改测试。本文固定通用 wire；完整密码学、会合、授权、会话和撤销语义以 [`E2EE.md`](E2EE.md) 为准。实现与文档不一致时必须先更新文档和测试。

## 1. 范围与不变量

协议只承载 `CodexServeClient` 已声明的查询、动作、快照与事件，不提供任意 RPC、Shell、绝对路径或文件读取能力。

- Relay 只路由可见 header 与不透明 `ciphertext`，不解密正文、附件或 Codex 状态。
- 浏览器提交的是 Agent 颁发的 workspace、task、attachment 标识；本机路径永远不是客户端 authority。
- 每个动作使用 `actionId`，每个请求使用 `requestId`；相同 id + 相同内容返回原结果，相同 id + 不同内容失败。
- 未知版本、字段、消息类型、generation、路由、时序、游标、能力或 authority 一律失败关闭。
- R1 不实现密码学和公网服务；它只固定密码学必须认证的字节和可独立测试的状态机。R2/R3 local-test 都只能绑定 localhost；R3c 端点平台持久化与真实网络组合、R6 TLS/部署/日志验收全部完成后才允许公网联调。
- R2 的未加密 Relay 控制面、注册关闭和资源边界以 [`RELAY.md`](RELAY.md) 为准；Relay WebSocket 连接编号不得复用为 `connectionGeneration`。

## 2. 分层

```text
Web / Companion application DTO
        ↓ 严格 JSON schema
E2EE plaintext（request / response / event / snapshot / control）
        ↓ AES-GCM（R3）
RoutedEnvelope v1（固定 header + ciphertext）
        ↓ UTF-8 JSON / 单条 WSS frame
Relay
```

Relay 不得根据 `ciphertext` 猜测动作。可见 `messageType` 只保留流量类别，不暴露具体 Codex 方法。

## 3. 编码与上限

- 线格式为单个 UTF-8 JSON object；禁止 BOM、NaN、Infinity、重复 JSON key 和非最短替代编码。
- encoder 按 schema 声明的固定字段顺序输出无空白 canonical JSON。decoder 先按 UTF-8 字节数拒绝超限，再解析 JSON、用 strict schema 校验并重新 canonical encode；输入字节必须完全一致。这样同时拒绝重复 key、字段乱序、额外空白和替代转义。
- 单个常规 WSS frame 上限 `786432` bytes（768 KiB）；`ciphertext` 的无 padding base64url 文本上限 `699051` characters，对应不超过 512 KiB 密文字节。AES-GCM 固定增加 16-byte tag，因此应用 plaintext 上限是 `524272` bytes，而不是完整 512 KiB。附件后续使用独立有界分块和同步更新的协议版本，不提高控制帧上限。
- 标识符为 1–128 个 ASCII 字符，首字符为字母或数字，其余只允许 `[A-Za-z0-9._~-]`。因此标识符不能伪装成 Windows/Unix 路径、URL 或控制字符。
- `cursor` 为 1–512 个可打印 ASCII 字符；它只是不透明恢复标识，客户端不得解析或构造。
- 时间使用 Unix epoch milliseconds 的非负安全整数；序号与 generation 使用正安全整数，`ack` 可为 0。
- 常规信封最大生存期 120 秒，允许发送时钟最多领先 30 秒。`expiresAt <= sentAt`、已过期、超出生存期或过度未来的消息均拒绝。

## 4. RoutedEnvelope v1

| 字段 | 约束 |
| --- | --- |
| `protocolVersion` | 固定为 `1` |
| `connectionGeneration` | 正安全整数；表示 host-device 已认证密钥会话 epoch，每次重新认证都派生全新双向密钥并递增 |
| `fromDeviceId` / `toDeviceId` | 已授权设备标识 |
| `hostId` | 单用户 MVP 的权威 Windows 主机 |
| `keyId` | 当前方向的已认证会话密钥标识；不能由来包自动采用 |
| `requestId` | 请求/事件关联标识；不得为空 |
| `taskId` | 任务消息必须有；主机/工作区级消息可省略 |
| `seq` | 当前方向、当前 generation 内从 1 开始严格递增 |
| `ack` | 已连续接受的反方向最大 `seq`；尚未接受时为 0 |
| `sentAt` / `expiresAt` | epoch ms；受第 3 节时效约束 |
| `messageType` | `request`、`response`、`event`、`snapshot`、`control`；附件在其 payload/schema 完成后随协议同步扩展 |
| `ciphertext` | 无 padding base64url；R3 后只允许 AES-GCM 输出 |

`taskId` 在 `event`、`snapshot` 以及 task/turn/request-resolution 类应用消息中必须存在，并与加密正文中的 task authority 相同。该规则同时适用于成功与失败 response：`task.read/subscribe/unsubscribe`、`turn.send/steer/interrupt` 和 `request.resolve` 的 response 正文必须显式携带 `taskId`，不得只依赖 `requestId` 猜测归属。Relay 不负责判断这一点；接收端在 AEAD 成功后复核。

### 4.1 AAD 的唯一编码

AES-GCM AAD 是下面固定数组经 ECMAScript `JSON.stringify` 后的 UTF-8 字节；字段顺序不得改变，缺省 `taskId` 编码为 `null`：

```text
[
  "codex-plus-envelope-aad-v1",
  protocolVersion,
  connectionGeneration,
  fromDeviceId,
  toDeviceId,
  hostId,
  keyId,
  requestId,
  taskId ?? null,
  seq,
  ack,
  sentAt,
  expiresAt,
  messageType
]
```

`ciphertext` 不进入 AAD；AES-GCM 已认证 ciphertext 本身。实现必须导出确定性的 `encodeEnvelopeAad`，并用固定字节向量测试。任何可见 header 修改都必须导致解密失败。

### 4.2 R3 的 nonce 与密钥用途

R3 不得直接把一个共享密钥同时用于两个方向。每个已认证 connection generation 通过 HKDF-SHA-256 派生：`client_to_host_key`、`host_to_client_key`、两个 4-byte nonce prefix 和独立的 attachment keys。两个方向各自使用 Host 在已签名 `session.accept` 中随机分配的不同 `keyId`；HKDF `info` 必须包含协议版本、host、两端 device id、authorization epoch、generation、方向 `keyId` 与用途标签。`keyId` 只能由完整认证握手/轮换流程安装；看到未知或更大的 `keyId` 不能自动切换密钥。

AES-GCM IV 固定 12 bytes：4-byte 派生 prefix + `seq` 的 8-byte unsigned big-endian 编码。同一方向、同一 generation、同一 key 下不得复用 `seq`；重发必须重发完全相同的信封与密文，不能在旧 `seq` 下重新加密不同内容。

## 5. 时序与恢复状态机

接收端只在连接认证和 AEAD 验证成功后调用 `acceptAuthenticatedEnvelope`。状态按 `(hostId, localDeviceId, remoteDeviceId, generation, direction)` 隔离。这里的 envelope `seq` 是连接方向级序号；它与 task 级 `TaskEvent.sequence` 是两个独立计数器，不能混用或互相赋值。

校验顺序：

1. strict schema、版本、frame/ciphertext 上限与时效。
2. `hostId`、`fromDeviceId`、`toDeviceId` 和当前 generation 完全匹配。
3. `ack` 不得小于此前 peer ack，也不得大于本方向已经发送的最大 `seq`。
4. `seq <= lastAcceptedSeq` 为 replay；`seq != lastAcceptedSeq + 1` 为 gap/out-of-order。
5. 全部通过后才原子更新 `lastAcceptedSeq` 与 `lastPeerAck`。

WebSocket 本身有序，因此 v1 不缓存乱序帧。gap 使当前增量流失效，客户端停止写动作并请求重传缺失的原信封；若发送端的有界未确认队列已无该信封，则重新认证、派生全新密钥并进入新 generation，再以 snapshot + opaque cursor 恢复。不能在旧 generation 跳过缺口直接应用 snapshot；旧 generation 的帧即使尚未过期也拒绝。

接收状态的提交是两阶段边界：raw frame/header 预检不得改状态；只有 AEAD、plaintext strict schema、header/body authority 交叉校验，以及写动作的幂等预留全部成功后，才原子提交 `seq/ack`。任何失败都不能消费序号。

## 6. 应用消息

2026-09-05：新增不带 task authority 的只读 `model.list`。空 params 经既有 E2EE 认证请求 Windows 从 owned app-server 读取有界模型目录；成功结果最多 128 条，包含唯一 model id、显示名称、默认/支持 effort 和 isDefault，不包含 provider 凭据或路径。effort 为最长 32 字符的标识，而非冻结型号表；具体 model/effort 组合仍由 Host 当前目录在发送前校验。已有 task 快照在官方 0.153.4 提供 model/reasoningEffort 时回显该配置，旧版缺失时才使用当前受信默认值。

加密 plaintext 是 strict JSON object，顶层为下列 union：

- `request`：`manage.read`、`pairing.create`、`device.rename`、`device.revoke`、`workspace.list`、`task.list`、`task.read`、`task.subscribe`、`task.start`、`turn.send`、`turn.steer`、`turn.interrupt`、`request.resolve`。
- `response`：与请求一一对应的成功数据或结构化失败；动作成功沿用 `ActionReceipt` / `StartTaskReceipt`，不能把 Relay 收帧写成 `accepted`。receipt 是严格按 `state` 判别的 union：`queued` 不携带 rejection 或 revision/sequence/cursor/task，`accepted` 禁止 rejection 且只允许显式提交 authority，`rejected` 必须且只能携带 rejection，不得夹带看似已提交的 revision/sequence/cursor/task。
- `event`：单条 `TaskEvent` 增量。
- `snapshot`：权威 `TaskSnapshot`，携带 host generation、revision、sequence、cursor 与 capabilities。
- `control`：snapshot 请求、心跳和安全错误；不包含任意方法名。

R5 composition 不得把官方 app-server 的 `idle`、`notLoaded` 或 `systemError` 伪装成已经完成。`TaskSummary.status` 因此除现有 `running | waiting-approval | completed | offline` 外，还允许 `syncing | failed | unknown`：list projection 的 `notLoaded` 映射为 `syncing`，`systemError` 映射为 `failed`，缺少 turn 证据的 `idle` 映射为 `unknown`；只有完整 read projection 的最近 turn 明确完成时才使用 `completed`。未知状态可以显示，但所有写 capability 必须关闭。官方 item 没有逐项时间时，`TaskMessage.createdAt` 可以为 `null`，不得用 turn 开始时间伪造成逐项时间。

D4 `manage.read` 是无 task authority 的已认证只读请求，成功响应必须把 `hostId + connectionGeneration` 与 envelope 交叉绑定。结果只允许固定六层状态、最多 64 个 Host 授权设备和最多 64 个白名单连接事件；当前设备必须唯一、active 且 online，其他设备不能伪装 online。Relay 不解密或合成结果，`relayed` receipt 仍不能完成该请求。

D5 三个设备动作均无 task authority，但必须携带 `actionId + expected Host`；rename/revoke 还绑定快照中的 device/authorization/epoch。`turn.interrupt` 和 `request.resolve` 保持 task-scoped，后者完整回显 live request authority。所有 D5 response 的 action id 必须与 envelope request id 相同；pairing invitation 只存在于加密 accepted response，Relay receipt 不得携带 fragment 或业务结果。

查询请求也必须有 envelope `requestId`。写请求正文必须携带 `actionId` 与 `expected` host/task state。审批/提问响应必须完整回显 `hostId + generation + taskId + turnId + requestId + requestNonce + issuedAt + expiresAt`。应用 DTO 的 runtime schema 与 TypeScript 类型必须同时由 `packages/protocol` 导出。

## 7. 协议错误

线协议只返回不会泄露设备/任务是否存在的稳定错误码：

```text
invalid-json
frame-too-large
schema-invalid
unsupported-version
unknown-message-type
payload-too-large
expired
future-sent-at
ttl-exceeded
route-mismatch
generation-mismatch
replay
sequence-gap
ack-regression
ack-ahead
not-authenticated
device-revoked
host-unavailable
rate-limited
backpressure
pair-session-unavailable
pair-confirmation-required
action-conflict
capability-denied
stale-authority
internal
```

对未认证连接，`device-revoked`、不存在和离线都对外归一为 `not-authenticated` 或 `host-unavailable`，避免枚举。错误 detail 只允许固定模板，不回显正文、路径、ciphertext、schema payload 或秘密。

Relay 另有一个不具备 Codex authority 的 strict receipt：`protocolVersion + relayType=receipt + connectionGeneration + requestId + seq + state`。`state` 只允许 `relayed | unavailable | rejected`；拒绝码只允许 `host-unavailable | rate-limited | backpressure`。它最多只能驱动 UI 的 `relayed`，绝不能产生 `ActionReceipt.accepted`；`accepted` 只能来自 Companion 的加密响应。

## 8. 配对 invitation DTO 与 R3 边界

二维码入口固定为 `https://<deployment-origin>/pair#<base64url-json>`。fragment payload 使用 strict schema，包含：

```text
protocolVersion = 1
relayOrigin                HTTPS origin；开发时只额外允许 loopback HTTP
hostId
hostDeviceId
pairSessionId
issuedAt
expiresAt                  创建后不超过 300 秒
rendezvousSecret           32 random bytes，base64url，仅存在 fragment/内存
hostEphemeralAgreementKey  P-256 public JWK
hostSigningKey             P-256 ECDSA public JWK
hostKeyFingerprint         SHA-256(RFC 7638 canonical signing JWK)，base64url
invitationSignature        Host signing key 对完整 invitation 固定字节签名
```

手机生成新的 P-256 临时 agreement key、长期 agreement key 与长期 signing key。客户端必须先把 `relayOrigin` 绑定实际受信 origin，复算 fingerprint、用 WebCrypto import 验证曲线点并验证 invitation signature，才可联网或 ECDH。pairing transcript 的唯一编码为下列数组的 UTF-8 JSON；JWK 只允许 `kty/crv/x/y`，按这里的固定字段顺序编码：

```text
[
  "codex-plus-pairing-transcript-v1",
  protocolVersion,
  relayOrigin,
  hostId,
  hostDeviceId,
  pairSessionId,
  issuedAt,
  expiresAt,
  [hostEphemeral.kty, hostEphemeral.crv, hostEphemeral.x, hostEphemeral.y],
  [hostSigning.kty, hostSigning.crv, hostSigning.x, hostSigning.y],
  hostKeyFingerprint,
  invitationSignature,
  [clientEphemeral.kty, clientEphemeral.crv, clientEphemeral.x, clientEphemeral.y]
]
```

host signing-key fingerprint 的输入固定为 UTF-8 `{"crv":"P-256","kty":"EC","x":"<x>","y":"<y>"}`，即 RFC 7638 要求的成员与字典序；输出是 32-byte SHA-256 的无 padding base64url。R3 必须先复算并常量时间比较 fingerprint，再进入任何配对状态。

临时 pairing secret 使用 P-256 ECDH，`rendezvousSecret` 作为 HKDF salt，`SHA-256(transcript)` 进入 HKDF info；再按方向拆分 provisional AES-GCM key/nonce prefix 与 SAS key。`rendezvousSecret`、派生密钥和解密后的设备资料不得发送给 Relay 或写入日志/持久化。

R1 最初只固定了 invitation、P-256 JWK 与 transcript 的结构边界；当前 R3 wire 已升级为 mandatory signed invitation，并已实现 strict `pair.open/join/claim/result/close`、join agreement PoP、Windows 本机确认 capability、长期 authorization、Relay public-key challenge、双 ECDH 日常 session 与 key-confirm/ready。端点平台密钥、generation/seq 与未确认原始密文的跨进程持久化仍须按 [`E2EE.md`](E2EE.md) 的 R3c 边界闭合，完成前不能公开部署。

R3 的 `pair.join` Relay 可见部分只能含版本、host/session/join id、client ephemeral public JWK、时间、固定 seq 和密文。密文中包含受限设备名、长期 agreement/signing public key、随机 challenge、join signature 与 agreement proof。只有 Host 完成 strict schema、AEAD、transcript、签名和 proof 的首个有效 join 才能原子进入 pending confirmation；垃圾密文只计入有界尝试，Relay 不能自行宣称 valid。拒绝、超时、成功或达到尝试上限都会终态消费 session。

确认结果在 provisional 通道中返回，并由 host signing key 对 transcript/join hash、两个 challenge、两端 identity/长期公钥/fingerprint、authorization id/epoch、origin、issuedAt 和固定远程权限上界签名。手机全部复核后才保存长期授权。撤销由 Host 先持久标记并递增 epoch、立即清 session 和阻断 RPC，再向 Relay 幂等同步 tombstone/关闭 socket；Relay 不可达时继续失败关闭，旧 grant/session/generation 不能恢复。跨机不得声称“同时原子失效”。

## 9. R1 验收

- encode/decode 可往返有效信封且不改正文相关字节。
- 超限、非法 UTF-8/JSON、重复 key、未知字段、未知版本/类型和非法标识拒绝。
- 过期、过度未来、TTL 超限、route/generation 错误、replay、gap、ack 回退/超前拒绝，且失败不推进状态。
- pairing invitation fragment/DTO 严格校验 `issuedAt`、五分钟期限、HTTPS/loopback origin、P-256 JWK 与 32-byte secret；R1 不存在可执行 pairing handler。
- 应用 request/response/event/snapshot DTO 能运行时校验，动作 authority 字段不可缺失。
- `CodexServeClient` fixture 仍无 I/O；正式 transport 只有接口/适配骨架，不建立 socket，也不在正式构建中导入 fixture。
