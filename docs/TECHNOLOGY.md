# 技术选型与质量方案

> 结论快照：2026-08-23。目标是用尽量少的工程复杂度，获得比“把开发服务器端口直接穿透到公网”更安全、更稳定的手机体验。前端路线以 `DSH_UI_ADOPTION.md` 为准。

## 1. 一句话方案

Windows 上用 TypeScript Companion 通过 stdio 托管官方 Codex app-server，并继承当前用户的正常 Codex 环境；Codex App、VS Code 与 Codex Plus 继续同一 thread。Android 浏览器与电脑 Web 共用冻结的 DSH-derived React DOM/Web/PWA；阿里服务器运行正文只转发的 WebSocket Relay，并仅持久化公开身份、授权 epoch/status/revision 与撤销 tombstone 等最小路由状态。

Web 并不天然比原生不安全或慢。DeepSeek Harness 的风险来自它的 v1 Web Server 明确不包含 TLS 和身份认证，以及简单端口穿透没有会话权限、重放和恢复协议；不是浏览器渲染本身的问题。

## 2. DeepSeek Harness 源码审计

只读源码：`C:\Projects\deepseek-harness`，基线提交 `47f943859bef60e4160492346772ded9b24f765a`。

值得借鉴：

- Host、API Client、GUI 和物理传输分层清楚，业务协议不绑死到某一种 carrier。
- RPC 使用窄消息 union、运行时 schema 校验、`rpcId` 关联、deadline 和明确错误。
- 浏览器边界检查 Host、Origin、Fetch Metadata 和 JSON media type，防御 CSRF、DNS rebinding 和 confused deputy。
- 页面刷新后能重建状态并重放待处理请求；两条下行 WebSocket 任一中断会按退避重建连接。
- Web UI 让任何设备快速访问 Harness，是正确的产品形态。

不能照搬：

- 官方文档明确 Web Server 没有 TLS、认证或完整 origin policy；绑定 `0.0.0.0` 就向所在网络暴露。
- 浏览器信任栅栏不是远程认证。源码说明真正远程部署的认证仍被推迟；该 API 实质拥有代码执行级权限。
- HTTP 上行 + 两条 WebSocket 下行适合本机开发服务器，但手机跨公网需要三条连接、两个独立事件流且没有跨流顺序，恢复和路由更复杂。
- v1 断线主要使用“整代连接重建/重新快照”，没有适合弱网的持久 cursor replay。
- 反向代理或隧道只改变“谁能连到端口”，不会自动添加设备身份、细粒度动作、E2EE、幂等批准或安全重放。

采用方式：保留其 schema-first、连接 generation、快照重建、Host/Origin 栅栏和 GUI 分层思路；改成一条全双工 WSS、设备配对、E2EE、seq/ack 和动作幂等。

## 3. OpenAI Codex 源码审计

工作区只读上游：`.upstream/openai-codex`，基线提交 `536f86e5cc9ec1ff38457d099bf320b9d08eeeba`。

关键结论：

- app-server 正是官方富客户端边界，覆盖认证、历史、批准和流式事件；没有必要重写 Codex Harness。
- stdio 是本机稳定路径；官方 WebSocket 传输仍是实验能力，所以 Companion 应管理 stdio 子进程。
- `thread/list/read/resume` 和 `turn/start` 正好覆盖任务发现、历史、恢复与续聊。
- app-server 会明确返回任务状态或写入冲突；Agent 失败关闭，不绕过官方 writer ownership。
- 任务状态在 app-server 进程内才完整。另一个进程读到 `notLoaded` 不代表桌面任务真的空闲，也收不到所有临时 realtime 事件。
- thread store 将 JSONL 作为权威持久历史、SQLite 作为查询索引，并有跨进程 writer ownership；直接修改存储既危险又没有必要。
- app-server daemon 的远程生命周期管理仍实验且偏 Unix，不适合作为 Windows MVP 基底。

用户已经在当前 thread 验证 App 与 VS Code 可交替发送并及时同步。Codex Plus 因此使用自己的 app-server 连接同一正常 Codex 环境，不附着桌面进程，也不再维护 Desktop Mirror/显式接管分支。

## 4. 网络方案比较

| 方案 | 安全 | 稳定/性能 | 手机体验 | 工程量 | 用途 |
| --- | --- | --- | --- | --- | --- |
| 直接端口穿透/FRP 暴露 Web Server | 取决于额外认证；默认危险 | 链路简单，但服务器本身常无恢复语义 | 直接浏览器 | 低 | 只用于临时测试，不进生产 |
| 反向 SSH + Nginx | TLS/认证可控，Windows 无入站 | TCP over TCP；断线要保活 | 直接浏览器 | 低 | Phase 0 快速验证 |
| Tailscale | WireGuard E2EE；设备身份成熟 | 能直连时最低延迟，失败自动中继 | 手机需安装 VPN App | 最低 | 私人日用首选 |
| Headscale + Tailscale 客户端 | 自托管控制面，数据面 WireGuard | 接近 Tailscale；需运维控制面/DERP | 手机需 VPN App | 中 | 追求自托管私网 |
| 自建出站 WSS Relay + 应用 E2EE | 可做到 Relay 不可读 | 所有流量经阿里，但对文本/事件足够快 | Android App 或浏览器 | 中高 | 默认产品形态 |
| WebRTC/WebTransport | 可安全 | NAT/TURN/移动兼容复杂 | 浏览器 | 高 | 没有足够收益，暂不选 |

部署优先级调整为：

1. **Relay 模式（默认）**：Windows Agent 与 Android/Web 客户端都主动连接阿里 WSS Relay；加应用层 E2EE。适合 App 或域名直接使用，也是首个端到端实现目标。
2. **Tailscale（非默认、仅保留兼容）**：不作为日用主链路和 Gate 前置条件。用户实测其手机链路吞吐只有约 100 KB/s，而向阿里服务器上传至少约 1 MB/s；虽然尚未在相同网络和测试方法下完成对照，但真实使用体验足以决定先做阿里 Relay。

Headscale 是高 Star 自托管控制服务器，定位适合个人/小组织；Debian 12 有官方包路径。但它增加运维，并不能替代应用层的任务游标、审批幂等和 UI，因此只保留为参考，不进入当前路线。

带宽判断要分开看：纯文本/token 流通常不需要很高吞吐，100 KB/s 也能交互；但大 diff、命令输出、截图和附件会明显受影响。比峰值带宽更重要的指标还有首包 RTT、WebSocket 抖动、断线率和手机切网恢复时间。因此不以一次测速推算全部性能，但尊重现有实测，直接优先验证阿里链路。

## 5. 语言与框架

### Windows Agent：TypeScript / Node

选择原因：

- app-server 可生成与本机版本匹配的 TypeScript schema，减少手写模型和版本漂移。
- Node 处理 stdio JSONL、WebSocket、文件变更和进程监督足够成熟；网关 CPU 不是性能瓶颈。
- Web、Relay、Agent 共用协议类型和验证器，开发速度最高。

如以后确实需要 UIA、DPAPI 或 Windows Job Object，增加一个很小的 .NET Helper，通过本机命名管道提供窄能力；不把主程序提前拆成 Node/Rust/C# 三套。

### Android/Web 客户端：DSH-derived React Web/PWA

- 产品前端固定为 `apps/codex-web`，直接编译已审计的 DSH UI 视觉源码；DSH Agent、Host、LLM、credentials、filesystem 与 Cordis runtime 不进入产品。
- 所有任务、消息和动作只经 `CodexServeClient`；正式构建只装载 Relay-backed adapter，preview fixture 继续编译隔离。
- Android 首版使用浏览器/PWA，补齐 drawer、bottom sheet、安全区、软键盘和返回键；如以后需要 APK，只做不复制业务状态机的薄壳。
- Web 私钥使用不可导出 WebCrypto/IndexedDB 路径；客户端只保存配对资料、草稿和必要快照。

详细的 UI 源码、生产排除项与许可见 [DSH_UI_ADOPTION.md](DSH_UI_ADOPTION.md)。`apps/client`/Happy 只保留为冻结的行为与安全回归基线。

### Relay：TypeScript + Node HTTP / 原生 ws

- 单用户流量很小，一个进程即可。
- 当前 `r3-local-test` 使用 strict canonical JSON 原子状态文件，只保存 Host/设备公钥、授权 epoch/status/revision 与撤销 tombstone，不保存对话正文或离线队列；生产持久后端仍待部署阶段验证。
- Nginx/宝塔负责 443、证书和静态文件；Relay 只监听 loopback/Docker 内网。

### Schema 与测试

- 协议信封当前使用 Zod strict schema、固定字段顺序 canonical JSON codec 与 TypeScript 类型；重复 key、BOM、非 canonical 编码和未知字段失败关闭。
- 单元/协议测试用 Vitest；浏览器与 360px 安卓视口用 Playwright。
- 每次安装的 Codex 版本在启动/CI 生成 schema，做能力协商；不围绕人工版本号做无意义维护。

## 6. 加密与身份

传输层始终是 HTTPS/WSS。Relay 模式再增加浏览器原生 WebCrypto：

- 配对：Windows 展示一次性二维码，包含 Relay 域名、host id、nonce 和公钥指纹。
- 密钥协商：P-256 ECDH + HKDF-SHA-256。
- 消息加密：AES-GCM，每条消息使用唯一 nonce，并把协议版本、发送/接收设备、seq、request id 作为附加认证数据。
- 动作签名：P-256 ECDSA，批准绑定 host/thread/turn/approval/expiry。
- Web 私钥设为不可导出并保存在 IndexedDB，Android 使用平台安全存储；Windows Agent 的设备私钥使用 DPAPI/Credential Manager 保护。它与 Codex/OpenAI 登录凭据无关。
- Relay 只保存公钥、授权和撤销记录，不保存能解密历史的密钥。

这些都是 WebCrypto/平台现成原语。实现时仍需测试 nonce 唯一性、设备撤销和密钥轮换，不自行发明密码算法。

## 7. 稳定性设计

### 进程

- Agent 等待 app-server 初始化完成再开放控制能力。
- 子进程崩溃使用带抖动指数退避；连续失败进入 degraded/只读，不无限快速重启。
- Windows 睡眠唤醒后视为新 connection generation，重新同步而不是假设旧 socket 有效。

### 网络

- Android/Web 客户端与 Agent 均使用心跳、最大帧、速率限制和有界发送队列。
- 每个 thread 使用 snapshot + seq delta；Relay 重启不丢失真相，因为真相在 Windows Codex store。
- 客户端 ack 最后应用的 seq；窗口外或 gap 无法补齐时请求新快照。
- action 使用 request id 和结果缓存；自动重试不会重复发送提示或批准。

### 附件

- Android/Web 客户端使用与控制消息同一配对密钥体系，把附件拆成有界 AEAD 分块；Relay 只做流式路由，不保存明文或替离线 Agent 排队。
- Agent 先写 `.data/attachments/.../*.part`，完成类型、大小、顺序与完整性校验后原子改名；消息只引用 `attachmentId`。
- 图片在 Windows 映射成 app-server `localImage`；普通文件映射成用户可见路径元素，并只给目标任务读取权限。
- 不把大文件整体塞进 WebSocket JSON、stdio JSONL 或提示词，也不由 Agent 预抽取文档正文。

### UI

- token 流按 25–50 ms 合批，避免每个 token 都触发 React 重渲染。
- 长时间线虚拟化；大工具输出折叠并按需加载。
- 网络状态、数据新鲜度和当前 Agent 能力始终可见，避免把缓存内容伪装成实时状态。

性能上，模型和 OpenAI 网络等待远大于本机 stdio、WSS 和渲染开销。优先优化连接恢复、状态正确性和移动端渲染，不为微秒级网关处理改写 Rust。

## 8. 安全与质量闸门

生产前必须通过：

- 原始 app-server 和 Relay 内部端口均未暴露公网。
- 未认证/已撤销设备无法枚举主机或任务是否存在。
- Host/Origin/Fetch Metadata、JSON media type、CSP 和 WebSocket Origin 都有严格校验。
- 重复、过期、乱序和被篡改批准不会执行。
- Relay 日志中没有提示词、代码、令牌、完整路径和命令输出。
- 手机切网、后台 10 分钟、Windows 睡眠、Relay/Agent/app-server 重启后可恢复。
- app-server 返回状态冲突或请求归属不明时保持只读，不直接碰存储、不用 UIA 猜测。
- Codex schema 不兼容时显示能力降级，不执行未知动作。

## 9. 实施顺序

1. R1（完成）：固定 `docs/PROTOCOL.md`，实现 `packages/protocol` 与 `CodexServeClient` transport adapter 骨架及严格协议测试。
2. R2（完成）：实现只监听 loopback 的 Relay 和测试 Host/Web 双端，验证路由、心跳、限流、背压、重连、seq/ack 与日志脱敏。
3. R3（本地核心完成）：实现二维码配对、设备确认/撤销、E2EE 与 local-test Relay；平台密钥/序号持久化和恢复仍须完成后才允许公网联调。
4. R4a/R4b 与 R4c runtime binding（完成）：`WINDOWS_AGENT.md` 的 Windows Companion generic stdio lifecycle、generated-schema 只读 task list/read projection，以及 strict initialize + fixed version probe + child-generation compatibility binding 已完成；R4c 下一步引入 durable action authority，再依次接原文 turn/stream/interrupt、审批与提问。
5. R5：实现 Relay-backed `CodexServeClient`，只替换正式数据/动作 adapter，不重做 DSH-derived 页面。
6. R6：先在 VMware Debian 12 验证生产同构 Nginx/Relay，再申请 DNS、TLS 和宝塔外部变更权限。
