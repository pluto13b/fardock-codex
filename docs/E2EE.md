# 配对与端到端加密 R3 基线

> 状态：R3 密码学核心与 signed pairing/session endpoint flow、独立 `r3-local-test` Relay 已分别实现并通过本地纵向测试，2026-08-24；真实 endpoint↔Relay 网络组合尚未完成。端点平台密钥/序号持久化、跨进程恢复和部署仍未完成；这些边界闭合前 Relay 只能路由测试或端到端测试密文，不能公开部署。

## 1. 范围与依据

R3 只建立“已由 Windows 本机用户确认的设备，可以经不可信 Relay 建立新鲜、可撤销的 E2EE channel”。它不连接 Codex app-server、不开放任意 RPC、不实现附件，也不改变已冻结前端结构。

采用浏览器与 Node 共同支持的标准原语：

- P-256 ECDH：临时会合与连接密钥协商。
- HKDF-SHA-256：按协议、身份、epoch、方向和用途拆分密钥。
- AES-256-GCM：固定 128-bit tag；WebCrypto 输出为 `ciphertext || tag`。
- P-256 ECDSA + SHA-256：固定 64-byte raw `r || s` wire encoding，不使用 ASN.1 DER。
- SHA-256 与 RFC 7638：公钥 fingerprint、claims/transcript hash。
- 12-byte GCM IV：4-byte 派生 prefix + 8-byte unsigned big-endian `seq`。

实现只调用 [W3C Web Cryptography API](https://www.w3.org/TR/WebCryptoAPI/)，KDF 语义遵循 [RFC 5869](https://www.rfc-editor.org/rfc/rfc5869)，JWK fingerprint 遵循 [RFC 7638](https://www.rfc-editor.org/rfc/rfc7638)，GCM IV 唯一性遵循 [NIST SP 800-38D](https://csrc.nist.gov/pubs/sp/800/38/d/final)。不导出通用“任意 info 的 HKDF”“任意 JSON 签名”或“任意 key/IV 加密”接口。

## 2. 不变量与状态分层

以下状态不得互相替代：

| 状态 | 含义 | 权威方 |
| --- | --- | --- |
| Relay socket identity | 当前 WebSocket 的短期在线身份 | Relay 挑战验证后的 socket |
| `authorizationEpoch` | 某个长期设备授权的撤销/轮换版本 | Windows Companion 持久授权记录 |
| `connectionGeneration` | 一次端到端重新认证安装的连接代次 | Windows Companion 单调分配并先持久预留 |
| `keyId` | 当前 generation 某个方向的密钥标识 | 已签名 `session.accept`；两个方向分别随机生成 |
| envelope `seq/ack` | 当前 generation、当前方向的传输序号 | 两个端点自己的持久发送/接收状态 |
| task event `sequence` / `cursor` | Codex 任务投影与恢复位置 | Windows Companion 的应用投影 |

- Relay connection id、pair session id、authorization id、generation、key id、request/action id 不能复用或互相推导。
- 看到更大 epoch、generation 或未知 key id 的普通信封时不得自动采用；只有完整验证的授权/握手 transition 能安装。
- Relay 被完全控制时可以观察允许的 route、时间和长度并造成拒绝服务，但不能解密正文、签发设备授权、建立 E2EE authority 或触发 app-server 动作。
- Windows 本机状态不明、用户确认不明确、存储提交失败、密码学验证失败或协议版本不匹配时一律失败关闭。

## 3. 密钥与存储边界

Windows 主机和每个客户端设备各有两对长期 P-256 key：

- agreement private/public：只用于 ECDH；private usage 只有 `deriveBits`。
- signing private/public：只用于 ECDSA；private usage 只有 `sign`，public 只有 `verify`。

每次二维码另生成一对临时 ECDH key、32-byte `rendezvousSecret` 和至少 128-bit 随机 `pairSessionId`；每次日常连接双方再各生成一对临时 ECDH key和 32-byte nonce。所有 id/nonce/secret 只来自 `crypto.getRandomValues`。

`@codex-plus/e2ee` 是零第三方 runtime 依赖的纯 Web Crypto 包。它只接收/返回 `CryptoKey` handle 和协议 DTO，不创建 socket、不访问文件系统/IndexedDB、不读取环境变量，也不伪装提供跨进程持久化。

- Web：长期 private key 必须以 `extractable:false` 生成，并通过 IndexedDB structured clone 保存；不得降级到 private JWK、PKCS#8、localStorage 或普通字符串。清除站点数据后回到未配对。
- Windows：Node WebCrypto 的不可导出 key 不能跨进程保存。R4 平台 adapter 必须使用 DPAPI/Credential Manager/CNG 边界封装 Codex Plus 自己的 private key；纯 E2EE 包不写 PKCS#8。任何短暂可导出字节只能在该 adapter 内立即封装并清零。
- pairing secret、临时 private key、ECDH shared secret、HKDF base 和 AES key 只在内存。Companion 或浏览器重启后未完成 pair session 一律作废，不为恢复而持久化 `rendezvousSecret`。
- 私钥和 Codex Plus/Relay secret 不进入 app-server 子进程环境；这与不得读取 `auth.json` 是两个独立硬边界。

## 4. 二维码 invitation

URL 固定为 `https://<deployment-origin>/pair#<base64url-canonical-json>`。strict invitation 字段顺序为：

```text
protocolVersion = 1
relayOrigin
hostId
hostDeviceId
pairSessionId
issuedAt
expiresAt                  issuedAt 后最多 300 秒
rendezvousSecret           32 random bytes，仅 fragment/内存
hostEphemeralAgreementKey  P-256 public JWK
hostSigningKey             P-256 ECDSA public JWK
hostKeyFingerprint         SHA-256 RFC 7638 thumbprint
invitationSignature        64-byte raw P-256 ECDSA signature
```

签名输入是下面固定数组的 UTF-8 JSON；JWK 一律编码为 `[kty, crv, x, y]`：

```text
[
  "codex-plus-invitation-signature-v1",
  protocolVersion,
  relayOrigin,
  hostId,
  hostDeviceId,
  pairSessionId,
  issuedAt,
  expiresAt,
  rendezvousSecret,
  hostEphemeralJwkTuple,
  hostSigningJwkTuple,
  hostKeyFingerprint
]
```

客户端在任何联网、状态写入或 ECDH 前必须依次完成：strict/canonical/时间校验；`relayOrigin` 与页面受信配置的实际 origin 完全相等；两把 JWK 通过 WebCrypto import 曲线点校验且不是同一公钥；复算并比较 fingerprint；验证 invitation signature。只检查 x/y 长度或 fingerprint 自洽不够。

二维码的完整替换无法由二维码内的自签名解决；信任根仍是用户正在扫描本机 Companion 屏幕。配对 KDF 额外派生 25-bit、5 位 Crockford Base32 SAS，手机与 Windows 同时显示；Windows 只有在用户核对 SAS、设备 signing fingerprint 和设备名称后才能确认。SAS 是第二显示通道，不是可单独完成认证的短码。

Web 解析 fragment 后必须立即用 `history.replaceState` 从地址栏清除；不得放入 history state、Referrer、Service Worker cache、telemetry、console、错误对象或持久存储。此浏览器行为在 R5 接页面时验收，不由纯协议包伪装完成。

## 5. Pairing transcript 与 provisional channel

客户端生成新的临时 agreement key、长期 agreement key、长期 signing key、32-byte `clientChallenge`、随机 `joinId` 和随机 `clientDeviceId`。pairing transcript 固定为：

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
  hostEphemeralJwkTuple,
  hostSigningJwkTuple,
  hostKeyFingerprint,
  invitationSignature,
  clientEphemeralJwkTuple
]
```

双方计算：

```text
pairingTranscriptHash = SHA-256(pairingTranscript)
pairingIkm = P-256 ECDH(hostEphemeral, clientEphemeral)
pairingSalt = rendezvousSecret
```

每个用途独立执行 HKDF-SHA-256；`info` 是下列数组的 UTF-8 JSON：

```text
[
  "codex-plus-pairing-kdf-v1",
  base64url(pairingTranscriptHash),
  purpose
]
```

`purpose` 只允许：`client-to-host-key`、`client-to-host-nonce-prefix`、`host-to-client-key`、`host-to-client-nonce-prefix`、`sas-key`。AES key 取 32 bytes，nonce prefix 取 4 bytes，SAS key 取 32 bytes。最终 SAS 在第 7 节 join claims 验证后，以 `HMAC-SHA-256(sasKey, ["codex-plus-pair-sas-v1", pairingTranscriptHash, joinClaimsHash])` 的前 25 bits 映射为 5 位 Crockford Base32；两个方向不得共用 key/prefix。

## 6. Pair Relay carrier 与状态机

R3 给 Relay 增加独立、受限的配对 carrier；它不属于可执行 Codex `RoutedEnvelope`：

- 已认证 Host 发送 `pair.open`，只注册 `hostId + hostDeviceId + pairSessionId + expiresAt` 的内存路由。
- 未认证浏览器只能把严格 `pair.join` 作为第一条数据帧；不存在/过期/终态 session、错误 route 和超限统一失败，不提供 status/list/枚举 API。
- Relay 为每 session 最多保留 5 个短期 attempt socket；Host 验证一个有效 join 后发送 authenticated `pair.claim(joinId)`，Relay 才固定该 attempt 并拒绝其他 attempt。Relay 收到任意 ciphertext 时不能自行 claim/consume。
- Host 发送 opaque `pair.result` 给已 claim attempt，随后 `pair.close`。Relay 重启、Host 断线或过期都直接使 session 失效；不做离线队列或持久恢复。
- Pairing carrier 与正常设备连接分别限流；Relay 日志只记 session/device 的 HMAC 短标识、结果、耗时和字节数，绝不记 raw frame/JWK/secret/ciphertext/设备名。

Host 本地状态固定为：

```text
waiting
  -> validating        单 session 串行验证一个 attempt
  -> waiting           invalid；累计一次且不公开细节
  -> pending-confirmation  首个 AEAD + schema + transcript + signature 均有效的 join
  -> approved | denied | expired | attempt-limit
  -> consumed          清除 provisional secret/private key；永不重开
```

无效 canonical/AEAD/signature attempt 不得抢占 session；累计 5 次或时间到期后消费。并发有效 join 只有第一个 CAS 进入 `pending-confirmation`，其余统一 unavailable。`PairingSessionStatus` 只能存在 Host 本地或 provisional 密文内，未认证方不能查询。确认动作只来自 Windows 本机 UI；协议不存在远程 `pair.confirm` authority。

## 7. `pair.join` 与 Windows 确认

可见 `pair.join` strict 字段为：

```text
protocolVersion = 1
relayType = "pair.join"
hostId
hostDeviceId
pairSessionId
joinId
clientEphemeralAgreementKey
seq = 1
sentAt
expiresAt
ciphertext
```

`expiresAt` 不得超过 invitation expiry 或 `sentAt + 30s`。AAD 固定为：

```text
[
  "codex-plus-pair-join-aad-v1",
  protocolVersion,
  hostId,
  hostDeviceId,
  pairSessionId,
  joinId,
  clientEphemeralJwkTuple,
  seq,
  sentAt,
  expiresAt
]
```

IV 是 client-to-host prefix + `uint64be(1)`。解密后的 strict payload 为：

```text
pairType = "join-details"
pairingTranscriptHash
clientDeviceId
deviceDisplayName
clientChallenge              32 bytes
clientAgreementKey           长期 P-256 ECDH public JWK
clientSigningKey             长期 P-256 ECDSA public JWK
clientJoinSignature          64-byte raw ECDSA signature
clientAgreementProof         32-byte HMAC-SHA-256
```

设备名是私密、不可信显示文本：1–80 Unicode code units，首尾不得为空白，禁止 C0/C1、换行、bidi override/isolate 和不可见格式控制。它必须转义显示，不能进入 Relay 日志或充当 identity authority。

`clientJoinSignature` 的输入是固定数组：

```text
[
  "codex-plus-pair-join-signature-v1",
  pairingTranscriptHash,
  clientDeviceId,
  deviceDisplayName,
  clientChallenge,
  clientAgreementJwkTuple,
  clientSigningJwkTuple
]
```

`joinClaimsHash` 是上面 signature-input 字节的 SHA-256。client 还必须证明持有长期 agreement private key：

```text
agreementPopShared = ECDH(clientLongTermPrivate, hostEphemeralPublic)
agreementPopKey = HKDF-SHA-256(
  agreementPopShared,
  salt = rendezvousSecret,
  info = ["codex-plus-pair-agreement-pop-v1", pairingTranscriptHash, joinClaimsHash]
)
clientAgreementProof = HMAC-SHA-256(agreementPopKey, joinClaimsHash bytes)
```

Host 用自己的 ephemeral private key 与 payload 中的 client long-term agreement public key 复算。Host 只有在 JWK 曲线校验、AEAD、transcript hash、client signature 和 agreement proof 全部通过后才进入 `pending-confirmation`。Windows 显示转义名称、client signing fingerprint、SAS 和倒计时；在本机确认和第 10 节 session key-confirm 前没有任何 Codex/application authority。

## 8. Grant、denial 与长期 authorization

可见 `pair.result` strict 字段为：

```text
protocolVersion = 1
relayType = "pair.result"
hostId
hostDeviceId
pairSessionId
joinId
seq = 1
sentAt
expiresAt
ciphertext
```

AAD 使用固定标签 `codex-plus-pair-result-aad-v1` 和以上除 ciphertext 外的同序字段；IV 是 host-to-client prefix + `uint64be(1)`。结果明文是 strict union：

- `denied | expired`：只含 `pairType=pair-result`、outcome、pair/session/join identity 与 `decidedAt`。
- `approved`：另含 `grantClaims` 与 `hostGrantSignature`。

授权 claims 固定字段为：

```text
protocolVersion
relayOrigin
hostId / hostDeviceId / clientDeviceId
authorizationId             新的 >=128-bit 随机 id
authorizationEpoch = 1
issuedAt
pairingTranscriptHash
joinClaimsHash
clientChallenge
hostChallenge                  32 bytes，由 Host 在批准时生成
hostAgreementKey / hostSigningKey / hostSigningFingerprint
clientAgreementKey / clientSigningKey / clientSigningFingerprint
remotePermissionModes = ["ask", "read-only"]
approvalDecisions = ["approve-once", "deny"]
```

`joinClaimsHash` 是第 7 节 canonical signature-input 字节的 SHA-256；grant 签名输入是固定标签 `codex-plus-pair-grant-signature-v1` 加上述 claims 的固定数组。client 必须复核 invitation fingerprint/signature、result AEAD、grant signature、两个 challenge、transcript/join hash、全部 id/epoch/key/fingerprint/capability，全部一致后才持久化。claims 中的 permission/approval 列表只是远程协议绝不能越过的上界，不授予 workspace、task 或运行时 capability；实时 Host policy/snapshot 只能进一步收窄。ECDSA signature 不是 authorization id 或幂等键。

`grantClaimsHash` 固定为 `SHA-256(UTF-8(encodeGrantClaims(grantClaims)))`；这里的 `encodeGrantClaims` 是 `packages/protocol` 的 strict canonical object encoder。不得改用 grant signature-input、signature bytes 或对象属性遍历结果。Host/Client 每次从持久状态装载 authorization 时都要复算该 hash 并重新验证 `hostGrantSignature`，随后它才可进入 `session.accept` 签名与 session transcript。

Windows 批准时先持久化本机 authorization，再向 Relay 幂等 upsert 最小公开记录，最后才交付 approved result。本机记录至少包含 claims、状态、`grantClaimsHash` 和已持久预留的 `nextGeneration`；Relay 只保存 host/client route、authorization id/epoch、public signing key、revoked tombstone/revision，不保存 agreement secret、pair secret、E2EE key、设备名或正文。

跨机不存在伪造的原子事务。任一失败点都不得发送“已批准”后再回滚；允许留下不能建立 key-confirm 的 orphan，并由 Windows 本地清理/撤销。Companion 重启使未完成 pair session 失效，不持久化 secret 来恢复。denied、expired、approve 都终态消费，双击确认只能产生一次结果。

## 9. Relay 设备认证

R2 的 bootstrap/resume credential 只属于 loopback spike。R3 生产设备连接使用 public-key challenge，不用可重放的长期 browser bearer token：

1. socket 发送 strict `device.hello`：role、host/device/authorization id 与 epoch。
2. Relay 返回一次 32-byte random challenge、challenge id、issued/expires（最多 15 秒）。
3. device 用授权 signing private key 签固定 transcript，覆盖部署 origin、role、全部 identity/epoch、challenge/id/times。
4. Relay 用授权记录中的 public key 验证，成功后把 identity 绑定到这个 socket；challenge 立即消费，断线后重新挑战。

Host 首次 bootstrap 必须同时登记并证明持有 host signing key；之后也走 challenge。未认证 malformed、未知、撤销、epoch 错误、签名错误和过期继续统一为 `not-authenticated`，不得枚举。Relay socket authentication 只给“路由”权限；没有第 10 节 E2EE key-confirm，Host 仍不得接受应用消息。

## 10. 日常 E2EE session 握手

2026-09-05 传输恢复补充：Relay socket authentication 与 E2EE generation 保持独立。两个端点进程均存活、会话未失效、client 无在途请求且所有 outbound sequence 已获得认证 ack 时，可以在 fresh signing challenge 的新 socket 上继续使用当前内存 E2EE handle，并通过下一条加密只读请求验证双端连续性；seq 继续单调递增，不重发或改写旧 frame。Host 缺失旧 session 时直接拒绝/丢弃其应用帧，不因单客户端恢复而关闭全 Host 路由，client 随即完整重握手。进程重启、状态缺失、未确认动作、seq/epoch/key 不一致仍必须新 generation。

已通过 Relay socket challenge 的 Client 发送 strict `session.init`，字段为：

```text
protocolVersion / relayType="session.init"
relayOrigin
hostId / hostDeviceId / clientDeviceId
authorizationId / authorizationEpoch
handshakeId
clientNonce                    32 bytes
clientEphemeralAgreementKey
issuedAt / expiresAt           最多 30 秒
clientSignature                64 bytes
```

client signature 覆盖固定 `codex-plus-session-init-signature-v1` 数组及除 signature 外全部同序字段。Host 先复核 Relay-bound identity、本机 active authorization/epoch、grant claims、时间、key 曲线、签名和 handshake/nonce replay。

Host 随后在持久事务中先烧掉并预留一个严格递增 `connectionGeneration`；即使后续失败也不回退。再生成 host nonce/临时 agreement key，以及互不相同的随机 `clientToHostKeyId`、`hostToClientKeyId`，返回 strict `session.accept`。在协议允许的时钟偏差内，`session.accept.issuedAt` 取 Host 当前时间与已验签 `session.init.issuedAt` 的较晚值，`expiresAt` 取 Host 本地候选截止时间与 `session.init.expiresAt` 的较早值；只要所得窗口仍非空即可继续，不能因两端几秒时钟偏差把有效握手错误标成 stale。实现边界必须把 generation 事务放在握手 API 内调用受信任的持久化 adapter：adapter 原子复核当前 authorization/epoch、handshake id 与 client nonce 未使用，并烧掉 generation；握手 API 不接受调用方事后回填的“已持久化”普通 DTO。Client 对最高 generation 的 compare-and-install 同样由验签后的握手 API 内部调用 adapter；持久化失败时不派生或安装 session key。Relay socket 身份由 Relay 状态机负责，E2EE 握手包不把调用方可构造的身份对象当作认证能力：

```text
protocolVersion / relayType="session.accept"
relayOrigin
hostId / hostDeviceId / clientDeviceId
authorizationId / authorizationEpoch
handshakeId
connectionGeneration
clientToHostKeyId / hostToClientKeyId
sessionInitHash
hostNonce                      32 bytes
hostEphemeralAgreementKey
issuedAt / expiresAt
hostSignature                  64 bytes
```

host signature 输入以 `codex-plus-session-accept-signature-v1` 开头并覆盖全部 accept 字段、`sessionInitHash` 和授权的 `grantClaimsHash`。Client 只接受 host grant signing key 的有效签名、完全相同的 authority、未重放 handshake，以及严格大于本地最高已安装值的 generation。

双方按固定顺序拼接两段 32-byte IKM：

```text
connectionIkm = ephemeralECDH || longTermAgreementECDH
connectionSalt = SHA-256(canonical session transcript)
```

每个方向和用途独立 HKDF；info 覆盖标签 `codex-plus-session-kdf-v1`、session transcript hash、全部 identity、authorization epoch、generation、方向 key id 与 purpose。用途只允许两个方向的 AES key、nonce prefix 和附件 key。session transcript/hash 的 exact encoder 由 `packages/protocol` 导出，E2EE 包不接受调用方任意 info。

Client 以新的 client-to-host key 发第一个 `RoutedEnvelope` control `session.confirm`（seq=1、ack=0）；Host 验证后以 host-to-client key 发 `session.ready`（seq=1、ack=1）。confirm/ready 明文绑定 session transcript hash、authorization id/epoch、generation 与发送 role。两边确认前保持只读，application envelope 从各方向 seq=2 开始。任一异常销毁临时/AES key；已预留 generation 保持烧掉，重新完整握手。

同一握手状态第一次创建 confirm/ready 时必须同步锁定唯一的 in-flight 结果及其 timing；并发调用共享同一 Promise 和逐字相同的 canonical frame。首次加密失败后该 generation 终止，不得以相同 seq/nonce 和不同 AAD 重试。返回的 frame 是冻结快照，调用方不能修改缓存后影响后续重传。

每个 authorization/role 的未完成握手数量有硬上限；所有带时间的入口都会清扫已过期 pending key，并提供显式 dispose 给 transport 断线/调用方取消。丢弃 JS handle 不能让模块中的 registry 永久强持有 provisional key。

新 generation ready 后旧 generation 立即失效。v1 不做重叠 in-band rekey；进程重启、状态丢失、seq gap、nonce 风险或明确轮换均重新执行完整握手。

运行时 session capability 必须可显式失效，并在同一端激活新 generation 时原子关闭旧 capability。authorization revoke/epoch 变化会关闭该授权的 pending 与 established key handle；每次 application seal/open 都通过受信 Host/Client authority adapter 复核 active epoch，解密后仍需在 app-server RPC 的同一 authority lock 内再次复核。无法证明当前 authority 时失败关闭，不能继续使用缓存的 handle。

## 11. RoutedEnvelope AEAD

`PROTOCOL.md` 的 AAD 是唯一 header 编码。发送端使用当前方向 AES key、`keyId` 和 `IV = noncePrefix || uint64be(seq)`，显式 `tagLength=128`；输出 `ciphertext || tag` 再做无 padding base64url。

密文 byte 上限为 524,288，因此可加密 plaintext 最大为 524,272 bytes；`MAX_APPLICATION_BYTES` 必须同步降低 16 bytes。pair/control payload 使用更小独立上限。

公开的 established-session API 不接受调用方自报 `seq`，也不导出低层任意加密入口。它在加密前调用受信任 persistence adapter，持久、原子预留当前 `(authorizationEpoch, generation, keyId, direction, seq)`；只接受内存状态期待的下一个连续序号，加密后再由同一 adapter 保存完整 canonical raw envelope，成功后才返回冻结 frame。若预留、加密或保存任一步状态不确定，废弃 generation 并重握手。重试走独立的 cached-frame 读取，只能逐字重发已保存 raw frame，不能在同 seq 下修改 ack、时间、AAD 或正文重新加密。

`ack` 也不由调用方填写，固定取本地已 durable 接收的最高连续序号。每方向最多缓存 16 个且最多 8 MiB 未确认 raw frame，达到任一上限即背压，不再预留序号；收到 authenticated ack 时 inbound persistence adapter 在同一事务删除对应 durable raw cache，内存镜像随后同步清理。

接收顺序固定为：

1. strict/canonical frame、大小、time、route、当前 authorization epoch/generation/key id 预检，不改状态。
2. AEAD 验证；失败统一 authentication failure，不回显 WebCrypto/DOMException 细节。
3. strict/canonical plaintext、message type、header/body task/request/authority 交叉校验。
4. 写动作先原子预留 `actionId` 幂等结果。
5. 最后原子提交 `seq/ack` 并应用消息。

公开接收 API 在 AEAD 与 body binding 后再次复核 active authorization，再调用受信任 inbound adapter；adapter 在同一 authority 事务复核 active epoch、原子完成 action idempotency reservation、seq/ack commit 与 acknowledged outbound raw 删除，成功后 API 再复核一次 authority，才推进内存状态并返回 application message。并发同序号、replay、gap、ack 回退和 ack 超过已发送 high-water 都失败关闭；调用方不能绕开 adapter 获得可执行 message。任一失败不消费接收序号、不调用 app-server；持久提交结果不确定时整个 generation 失效。connection `seq` 防重放不能替代跨 generation 的 action 幂等。

## 12. 撤销与轮换

Windows 是授权真相。撤销顺序必须是：

1. 本机持久事务把 authorization 标为 revoked、递增 `authorizationEpoch`/revision，并使全部 pending handshake/session/action authority 失效。
2. 在每次解密后、每个 app-server RPC 前复核 active authorization/epoch；关闭当前本地 channel。
3. 向 Relay 幂等同步 tombstone/revision，并要求关闭 socket。Relay 不可达时保持 `revocation-pending`，绝不回滚或允许旧 epoch 刷新/重连。

Relay 收到新 tombstone 后拒绝旧 challenge/proof 并关闭 socket；revoke 与 reconnect 并发时较高 tombstone revision 胜出。Relay 重启后从 Host 单调 reconcile，不能降低 epoch 或复活记录。相同 device id 重新配对也必须生成新的 authorization id/key/epoch lineage。

密钥轮换必须由当前授权 signing key 与新 key 共同绑定，或要求重新扫码；bearer 值不能替换公钥。MVP 可以直接采用“重新配对”完成长期 key 轮换，不为抽象完美引入复杂 in-band rotation。

## 13. R3 分段验收

### R3a：纯密码学核心

- strict invitation/join/result/session transcript 与签名/AAD encoder 有固定字节向量。
- Node 26 使用真实 P-256 key 完成 fingerprint、invitation signature、ECDH/HKDF、AES-GCM、join/grant/session signature 和双向 channel；合法长度但不在曲线上的 JWK 必须拒绝。
- 两个方向 key/prefix/key id 不同；IV 边界、64-byte signature、524272/524273 plaintext 边界有测试。
- 修改任一 invitation/transcript/header/AAD/ciphertext/tag/claim/key/challenge/epoch/generation 都失败，且不推进 seq/ack。

### R3b：Pair/Relay 状态

- localhost 真实 WebSocket 跑通 pair.open/join/claim/result/close、5 次尝试上限、并发一个有效 claim、过期和 Relay restart 失效。
- 设备 public-key challenge、Host bootstrap key proof、authorization upsert/tombstone/reconcile 和立即关旧 socket通过测试。
- wire/state/log 扫描找不到 secret、private key、设备名、诱饵 prompt/code/path、ciphertext 原文或 `auth.json` 字样的测试值。

### R3c：持久状态与真实密文 Relay

- 浏览器 IndexedDB 可保存不可导出 private CryptoKey，reload 后仍可 sign/derive；清站点数据后未配对。production bundle 无 `node:`、`Buffer`、private JWK 或 fixture。
- Host generation/seq 预留和 crash fault injection 证明不复用 `(key, IV)`；丢失 raw unacked frame 时只能新握手。
- 尚待把端点的真实 AES-GCM channel 与 `r3-local-test` Relay 组合成双向网络测试；恶意 Relay 篡改/replay/reorder 必须无应用动作，receipt 只能到 `relayed`，不能产生 `accepted`。当前 endpoint vertical flow 与 Relay opaque-ciphertext 集成测试是两个独立、已通过的本地边界，不能描述成已完成网络组合。
- Host 先撤销、Relay 同步失败/重启、reconnect/revoke 并发时旧 authorization/grant/generation 都不能恢复。

只有 R3a、R3b、R3c 全部通过，才允许在 localhost/VMware 承载真实测试正文；公网仍需 R6 TLS、部署和日志验收。
