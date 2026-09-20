# 安全基线

2026-09-07 已授权全本地会话的投影可包含官方 app-server 返回的盘符/UNC 根目录 cwd；它只标识已有 task 的来源，不成为客户端提交任意路径的入口。显式工作区配置仍不接受根目录，设备路径与无盘符的 rooted 路径仍拒绝，读写/审批继续由既有 taskId、grant、revision 与 owned turn 决定。浏览器恢复期间不得提前提示重新配对或清除私钥。

2026-09-07 已授权的设备恢复补充：用户明确允许 Windows 本机“连接手机”点击创建一次性邀请，解决所有浏览器都未配对时的入口缺失。邀请仍由现有 Host 身份签名，Gateway 仅从当前已认证 Host socket 接受与活动 pairSessionId/Host/expiry 完全匹配的 fragment；新浏览器仍须同源 Owner 登录和一次性码。客户端 socket、未知/关闭/过期/已登记 invitation 不得调用该登记，Host 断线/关闭邀请清除码。配对码经 GUI-owned 进程私有 IPC 返回，仅在窗口内存显示，不进入诊断/日志/文件/剪贴板。该例外不放宽其他 invitation、设备撤销、E2EE 或 Codex 写动作权威。

2026-09-06 会话范围授权：当前单 Owner 已明确授权远程查看和继续当前 Windows 用户在各项目的 Codex 会话。生产任务目录由官方 app-server 的列表/读取结果确定，不再以 Companion 仓库路径过滤；这不把浏览器输入的路径变成 authority。绝对 cwd 只在 Windows 内用于正确投影，Gateway 不保存项目数据，远程仍提交既有 taskId 与 expected state。其他客户端运行中任务的控制归属不变，未知/未确认写动作继续失败关闭。

## 1. 安全目标

这个项目具备“读取开发对话 + 代表用户输入 + 批准本机操作”的能力，安全等级应接近远程开发机控制面，而不是普通聊天网页。

必须保证：

- 未配对设备不能看到任务元数据或发送动作。
- Relay 被攻破时，攻击者不能直接获得 OpenAI 凭据或任意 Shell。
- 网络重放不能造成重复消息、重复批准或重复拒绝。
- app-server/schema 失配不会把动作发给错误任务；未知 thread/turn/approval 状态永远不猜测。
- 日志、崩溃报告和服务端存储不泄露正文与代码。

## 2. 信任边界

| 组件 | 信任级别 | 允许持有 |
| --- | --- | --- |
| Windows Agent | 最高，本机用户权限 | Codex 协议连接、设备私钥；不读取或持有 OpenAI token |
| Android/Web 客户端 | 用户设备 | 配对凭据、解密后的当前视图、草稿 |
| Relay/Nginx | 可运维但按可能泄露设计 | 路由元数据、Host/设备公开身份、授权 epoch/status/revision 与撤销 tombstone、在线/短期连接状态；无正文、私钥或离线队列 |
| 公网 | 不可信 | 仅 TLS 密文 |

即使服务器由用户自己控制，也不把“服务器永不泄露”作为唯一防线。

## 3. 身份与配对

- Windows Agent 首次启动生成高熵设备密钥，不由用户手写固定弱密码。
- 已授权电脑从 `/manage` 发起短时设备邀请，Gateway 只在内存中把 invitation fragment 映射为 8 位 Crockford 配对码；手机登录同一 owner 账户后输入配对码完成首次绑定，不再使用二维码。
- invitation fragment 只在已认证同源 API、Gateway 有界内存和兑换后的浏览器 URL fragment 中短时出现；页面立即清除 fragment，且不得写入 access log、持久状态、历史 API、分析事件或普通日志。
- 配对码最长五分钟、成功兑换即删除，Gateway 同时最多保存 8 条。它只兑换由当前已授权 E2EE 管理会话创建的 invitation；Windows 对该 invitation 的 join 自动批准，未知、错码、过期、重复和并行 join 全部失败。
- 日常 Relay socket 使用 fresh 32-byte challenge + 长期设备 ECDSA proof 建立短期在线身份；断线后重新挑战，不用可重放的长期浏览器 bearer token。长期设备授权可在 Windows/手机端撤销。
- 单用户 MVP 禁止公开注册和匿名访客；首台 Windows 主机以一次性 bootstrap token 注册，成功后关闭主机注册入口。
- D9 只增加一个预配置 owner 账户，不开放公众注册。密码使用随机 salt + scrypt verifier，只通过交互式 helper 写入独立只读文件；禁止明文密码进入环境变量、Compose、CLI 参数、日志或 Git。
- Owner 会话使用随机内存 bearer 与 `Secure/HttpOnly/SameSite=Strict/__Host-` cookie，重启失效、数量/期限/登录尝试有界；所有 auth POST 和浏览器 WSS 必须精确 same-origin。Host WSS 不携带 owner cookie，继续用设备签名挑战。
- Owner 登录本身不能替代 Host-first enrollment或浏览器 E2EE 设备授权；首次新增浏览器还必须持有已授权电脑生成的短时配对码。配对成功后浏览器保存自己的不可导出私钥，后续 owner 登录可直接恢复该设备。`full-access` 仅在owner会话、有效设备授权和当前E2EE会话均有效后映射 Companion-owned app-server 的 `approvalPolicy=never + dangerFullAccess`；仍不提供任意 RPC/Shell/路径接口。
- Host重连可以按本机DPAPI authorization revision幂等补同步Relay缺失的active公开路由记录；同步前重新验证grant/key pair，只导出client signing public JWK/fingerprint。Relay状态冲突、revision倒退或字段不一致必须使Host连接失败关闭，不能把pending本机记录猜成已授权。
- Companion 可以按 authorization id 分别缓存已通过 DPAPI、grant signature 和 key-pair 自检的 active authorization 最小公开 claims，并按每个请求精确比较 authority，避免同一设备同一请求重复解封 DPAPI。缓存不含私钥字节，不能跨进程/authorization/epoch；撤销、重配、identity 变化或重启必须只使对应缓存失效并重新验证。

## 4. 传输与加密

Private/Tailscale 模式至少使用 WireGuard E2EE；公网 Relay 模式必须同时使用受信任 TLS/WSS 与应用层端到端加密，使 Relay 只看到不可读信封。

Relay E2EE：

- 使用 WebCrypto/平台成熟原语，不自创密码算法。
- 配对仍使用 32-byte `rendezvousSecret`、短时 invitation signature与 P-256 ECDH + HKDF-SHA-256 provisional channel；D9 的用户可见入口是 owner 登录后的 8 位配对码，已授权管理会话创建的 invitation 由 Windows 自动批准，不再要求显示或人工核对 SAS。
- 信封使用 AES-GCM；设备授权/批准使用 P-256 ECDSA 签名。
- 消息绑定发送设备、接收设备、递增计数器和 request id。
- 密钥只在 Windows Agent 和已配对手机持有。
- 不用 URL、命令行参数或普通日志传递密钥。
- 日常 E2EE 连接同时使用临时 ECDH 与长期 agreement ECDH，双方长期 signing key 认证握手；Host 先持久预留 generation，key-confirm 前无应用 authority。

## 5. 最小权限

- Relay 没有命令执行 API，不接受任意文件路径。
- 项目协议使用动作白名单，不提供 `run_shell(command)` 这类万能后门。
- Windows Agent 只读取 Codex 兼容层所需目录；工作区文件浏览不进入 MVP。
- 远程批准只对 Windows Agent 自己的 app-server 当前实时收到且仍 pending 的请求开放；其他客户端产生的未知请求保持只读。
- UIA 不进入 MVP；未来实验也禁止按屏幕绝对坐标执行审批。
- Agent 不以管理员身份运行，除非未来出现经文档确认且无法替代的需求。
- Windows Agent 禁止直接请求 OpenAI 模型端点，禁止读取/转发 `auth.json`；只有它启动的官方 `codex.exe app-server` 负责正常 Codex 网络与认证。
- Agent 不设置独立 `CODEX_HOME`，官方 app-server 正常使用当前用户已有的 Codex 环境。项目代码不得打开、复制、导出、上传或记录 Codex/OpenAI 凭据；Relay 永不接触它们。
- Windows Companion 的 Relay token、配对秘密和设备私钥从源头就不得放进普通环境变量；它们只能保存在进程内存或系统安全存储句柄中，因此不会随 app-server 的正常环境继承传播。supervisor 不枚举、复制或记录环境变量全集，也不向 child `env` 注入项目秘密；设备私钥使用系统安全存储而不是普通环境变量。
- 浏览器只能选择 Windows Agent 预先授权的工作区标识，不能把客户端路径直接作为 `cwd`、文件路径或 Shell 参数。

## 6. 审批安全

- 远程批准默认是“一次批准”，不提供“以后都批准”快捷入口。
- 卡片必须包含：主机、thread、动作类别、目标/命令摘要、产生时间和是否已过期。
- Windows Agent 只处理自己 app-server 当前仍 pending 的 approval id；其他客户端产生或归属不明的请求不显示可操作批准按钮。
- 每个动作有幂等键；Relay/客户端重试不会重复执行。
- 任何目标不明确、窗口焦点变化、请求已更新、格式未知的情况都返回失败并保持 pending。

## Docker Gateway 与 `/manage`

生产 Docker Gateway 只承载正式 Web/PWA、E2EE Relay、配对 carrier、受限 presence 和健康检查。它不安装 Codex、不挂载 Windows 工作区、不保存对话/附件明文，也不持有任何能直接执行 Codex 动作的 authority。持久卷只保存 Host/Client 公开身份、authorization epoch/status/revision 与撤销 tombstone；首次 bootstrap credential 只通过只读 secret 文件注入，注册关闭后不得因 secret 丢失或状态损坏而重新开放。

Host bootstrap credential 由 Windows Companion 生成：Host 副本立即进入当前用户 DPAPI/CNG，只另行导出一次性 Gateway 文件并经用户控制的安全通道复制到服务器。两端值不一致只能得到不可枚举认证失败；不能回退弱密码。Linux 初始化 helper 必须先验证固定非 root UID 对 state 的原子写权限和对单一 secret 文件的最小读取权限，不能由容器入口临时以 root 放宽整个目录。

`/manage` 不使用本机 Demo 的 `admin / 123456`，也不创建服务器万能管理员。只有已配对设备才能通过认证 WebSocket 与 E2EE 进入管理视图。设备列表、生成配对和正式撤销由 Windows Companion 返回或执行；Windows 先使本地授权失效，再向 Relay 同步 tombstone。Relay 可以向已认证连接提供窄 presence，但不得开放公开 `/devices`、`/sessions` 或任意状态写 API。宝塔 Basic Auth/IP 限制只能是外层纵深防御，不替代设备签名和端到端 authority。

D2 production Web pairing/client 与 Windows Host carrier 只接受精确 HTTPS origin 对应的 same-origin WSS，并使用平台默认 CA 验证；正式代码没有 `rejectUnauthorized:false`、明文 `ws://` fallback 或跨 origin override。Gateway 只信任显式 IP 白名单中的直连反向代理，并同时复核 `Host`、`X-Forwarded-Proto=https` 和 `X-Forwarded-Host`；`X-Forwarded-For` 不成为身份或动作 authority。local-test 与 production factory 在运行时继续隔离。

D3 长期密钥存储分平台处理：Web private `CryptoKey` 必须 `extractable:false` 并仅经 IndexedDB structured clone 保存；Windows private key 短时导出只存在于 platform adapter，立即交给当前用户 DPAPI 保护并清零，持久文件只保存 DPAPI ciphertext。AES/session/ephemeral key 永不持久化。bootstrap Gateway 明文文件是一次性交付物，必须 create-new、当前用户 ACL、从不打印，并在注册关闭验证后显式删除。

D4 `/manage` 只调用 E2EE `manage.read`：Gateway/Relay 不新增明文管理 API 或设备数据库；Windows 只返回连接层枚举、设备 ID/短标识、签名公钥指纹、authorization id/epoch、active/revoked、配对时间和窄 presence。当前请求设备必须恰好一个 `isCurrent + online`；其他active设备只有在Companion持有对应ready channel时显示`online`，否则显示`unknown`。连接事件由本次快照的固定 category/state 派生，不包含自由文本、任务内容、路径或密文；pairing/rename/revoke 与 P0 动作仍不可执行。

D5 设备写动作仍由 Windows 授权库掌权：rename 只改 DPAPI 内友好名称，revoke 先本地失效再同步 Relay，远程当前设备不得自撤销。批准/问题只来自 Companion 自己持有的 app-server child 和当前 live request；单次批准不能升级为 session-wide，secret question 不远程显示，过期/重复/错 authority 一律拒绝。`turn.interrupt` 只能进入 Companion-owned active turn，不查询或终止其他 Codex 进程。

D8 生产 Companion 在任何写动作前还必须补齐本机持久权威：request fingerprint 的独立 32-byte key 与 Host identity 一起受当前用户 DPAPI 保护；action SQLite 的 `storeId + stateRevision` 使用独立 DPAPI anchor 防止整库回滚。DB 与 anchor 不一致只允许失败关闭，不能静默重建或降级为进程内随机 key。D9 只对“当前已授权设备通过E2EE管理动作创建”的新设备 invitation 自动批准；bootstrap、未知来源或没有对应活动 invitation 的 join 继续走明确批准或失败关闭。

正式站点不再请求相机权限，生产 `Permissions-Policy` 固定 `camera=()`；二维码 scanner、网络 QR 服务和 QR 运行时依赖从正式 Web 删除。

已授权电脑浏览器在 `/manage` 取得的新设备invitation只经owner-authenticated same-origin POST登记为8位一次性配对码。Gateway内存映射最多8条、最长五分钟、重启清空，不进入state/日志/URL/query；兑换同样要求有效owner会话与精确Origin。该简化明确把owner密码+已有设备发起动作作为新增浏览器的授权边界，但Gateway仍不取得浏览器私钥或对话解密密钥。

E2EE 的服务器威胁边界必须准确：Relay 进程、状态文件、日志和被动流量观察者没有内容解密密钥，但同一 Gateway 还负责交付正式 Web JavaScript。能够主动替换 SPA 的攻击者可以在浏览器解密后窃取内容或滥用已配对密钥，因此 E2EE 不抵抗活动 Web-origin 供应链攻击。正式镜像必须使用明确版本标签、无第三方运行时脚本、严格 CSP、现有正式构建门禁和显式更新/回滚；按用户要求首版不另增 digest/资产 hash 核验层。若未来要求抵抗 Gateway 主动投毒，必须改用与 Gateway 独立签名和分发的客户端。

完整容器、端口、卷、配置、管理动作和验收边界见 [`DOCKER_GATEWAY.md`](DOCKER_GATEWAY.md)。

## 本机 Demo 全功能例外

`--local-demo-full-access` 是显式开发模式，不是远程权限升级。它必须同时满足数值 loopback Relay、`--local-demo-login`、固定工作区与本机 owned app-server；否则启动失败。该模式可以列出全部本地 thread 的安全投影，但不返回绝对 cwd、Codex Home、raw tool payload 或凭据。已完成历史任务可由用户明确继续；其他客户端正在运行的 task 只读，只有本 Demo 自己启动的 active turn 才可 steer。`full-access` 映射为官方 `approvalPolicy=never + dangerFullAccess`，UI 必须明确标橙；普通配对和正式部署继续拒绝该值。

跨进程历史读取只使用当前官方 app-server 的 metadata + summary-turn 分页；不读取 Codex SQLite、rollout JSONL、认证文件或环境变量。独立 app-server 无法证明另一进程的实时 ownership，因此这类快照始终 partial/read-only，即使最后一条持久化 turn 看似 completed；它不能恢复 send、steer、interrupt 或 approval authority。

Demo 自有 active shell 只能由同一 runtime 内已成功返回的 `thread/start` 和 `turn/start` 精确回执创建，并绑定 task/turn/action/workspace。它不能从列表、浏览器输入或外部 thread 推断，不能跨 runner 重启恢复；官方 read 一旦成功即替换并清除 shell。

## 7. 数据与日志

禁止传输或记录：

- `.codex/auth.json`、浏览器 Cookie、OAuth token、API key。
- 完整环境变量。
- 未经用户请求的工作区文件全文。
- 上传附件的明文、缩略图或内容摘要（Windows Agent 的受控附件目录除外）。
- 对话正文、推理正文、命令完整输出和补丁内容的服务端日志。

允许的审计字段：时间、哈希化设备 id、request id、动作类别、thread id 的不可逆短标识、结果码、耗时和字节数。

Android/Web 客户端默认只缓存最小界面状态；若未来离线缓存对话，必须提供清除按钮并说明本地风险。Android 私钥使用平台安全存储，Web 私钥使用不可导出 WebCrypto/IndexedDB 路径。

工作区 `.data/` 只保存 Codex Plus 的配对、幂等和最小快照，不保存第二份 Codex profile 或 `auth.json`。当前用户的正常 Codex 数据不得进入 Git、项目备份、诊断包或 Relay。Windows Credential Manager 只用于 Codex Plus 自己的设备私钥时，也不作为普通缓存目录使用。

附件只保存到 `.data/attachments/<threadId>/<attachmentId>/`。上传使用随机不可猜句柄、分块 AEAD、序号、声明大小、实际大小和最终完整性校验；文件名必须净化，禁止路径穿越、设备名和符号链接逃逸。普通文件只给目标 thread 只读权限。未完成的 `.part`、过期孤儿和 thread 删除后的附件由受控清理任务移除，不进入 Git、备份或诊断包。

## 8. 主要威胁与缓解

| 威胁 | 缓解 |
| --- | --- |
| 配对码被截屏/猜测 | 高熵、短过期、一次性、显示设备指纹 |
| Relay 账号或主机泄露 | 无 OpenAI token、无任意 Shell、E2EE 路线、可撤销设备 |
| WebSocket 重放 | request id、计数器、过期时间、Agent 端幂等缓存 |
| 手机丢失 | 系统锁屏、设备撤销、短会话、可选二次验证 |
| Codex 协议升级/任务状态冲突 | schema 能力协商、只读降级、绝不绕过 writer ownership |
| thread 串线 | 主机/thread/turn/approval 四层绑定和发送前复核 |
| 日志泄密 | 正文禁记、结构化白名单、自动日志测试 |
| 恶意附件/路径穿越 | attachmentId 映射、文件名净化、magic/type/大小/数量限制、原子落盘、只读暴露 |
| 凭据误读或日志泄露 | Agent 不实现凭据读取路径；日志字段白名单；Relay 无凭据接口 |
| 供应链风险 | 只采用高 Star、许可清晰且实际审阅过的依赖/代码；Happy 只移入已审计子集，删除托管/购买/社交路径 |

## 9. 发布前安全验证

- 未认证连接无法区分“无此设备”和“设备离线”。
- 过期/重复/乱序审批均不会执行。
- 修改 thread id、action type、payload size 会被拒绝。
- 非 Agent 当前 pending 的批准/输入动作始终被拒绝；状态冲突保持只读。
- Relay 日志扫描无提示词、令牌和常见密钥格式。
- 中断、重放、乱序、超限和伪造类型的附件上传均不会落成可引用文件或触发 turn。
- 工作区不生成或复制 `auth.json`；启动和诊断日志不包含 Codex/OpenAI 凭据。
- 删除手机授权后，旧连接和刷新令牌均失效。
