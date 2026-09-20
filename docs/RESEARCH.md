# 调研记录

> 调研快照：2026-08-21。Star 数只作为选择现成代码时的门槛，不做日常工程负担。详细技术落地见 [TECHNOLOGY.md](TECHNOLOGY.md)。

## 1. 最重要的结论

DeepSeek Harness 的“网页 + 内网穿透”证明了浏览器控制 Agent 的交互形态，但它公开的开发服务器并不是远程安全产品：源码明确写明没有 TLS 和身份认证。给端口加一条隧道，只解决可达性，不自动获得设备授权、端到端加密、批准幂等和断线游标。

Codex 的优势不是“原生界面一定比网页快”，而是官方 app-server 已经提供完整 Agent 生命周期、稳定 stdio 和持久 thread。高质量方案应把这些能力留在 Windows 本地，再为手机设计一层很薄但完整的安全/同步协议。

此前仅根据“各客户端持有私有 stdio app-server”推断跨客户端只能只读，这个结论错误。用户已在当前安装版本、当前 thread 连续实测：VS Code Codex 插件与 Codex App 可以交替发送，另一端及时出现新 turn。产品路线据此收缩：Codex Plus 以真实 `clientInfo=codex_plus`、同一正常 Codex 环境加入，不再维护隔离 profile、Desktop Mirror 或显式交接方案。

## 2. OpenAI 官方能力

### Codex Remote

官方 Remote 已支持从 ChatGPT/Codex 手机端连接 Windows/Mac 主机，启动或继续任务、跟进/steer、处理批准并查看输出、diff 和终端；项目、文件、凭据和执行仍在连接的主机。官方要求同一账号/工作区，并建议保持主机唤醒、在线。

这最符合“直接控制现有 Codex 任务”，但依赖 OpenAI 账号、官方服务与开放状态，不满足自托管域名诉求。

来源：[OpenAI Remote Connections](https://learn.chatgpt.com/docs/remote-connections)

### Codex App Server

app-server 是官方富客户端接口，覆盖认证、会话历史、批准和流式 Agent 事件。stdio 是稳定本地路径；WebSocket 仍标记为实验/非生产。官方明确警告，不要把 app-server transport 暴露到公共或共享网络，非本机连接必须有认证和 TLS。

来源：[OpenAI Codex App Server](https://developers.openai.com/codex/app-server)

### 本地上游源码验证

OpenAI Codex 已浅克隆到 `.upstream/openai-codex`，基线为 `536f86e5cc9ec1ff38457d099bf320b9d08eeeba`。

已验证：

- `codex-rs/app-server/README.md`：`thread/read` 可不 resume 读取；分页 history API 可增量取持久内容。
- 同一 paginated thread 只有一个 app-server 进程能持有写权限；其他进程 resume/archive/delete 会失败，read-only 仍可用。
- 只有持有任务的 app-server 进程能给出完整 live status/subscription；跨进程读取通常是 `notLoaded`。
- realtime 临时通知不会通过 `thread/read` / `thread/resume` 重放。
- `codex-rs/thread-store/src/local/mod.rs`：JSONL 是权威持久历史，SQLite 是查询索引；存在跨进程 writer ownership。
- `codex-rs/app-server-daemon`：远程 daemon 仍实验且生命周期偏 Unix，不能当作 Windows 成品服务。
- `initialize.clientInfo.name` 标识当前 app-server 客户端，官方示例中 VS Code 使用 `codex_vscode`；官方说明该身份进入 Compliance Logs。
- `Thread.source` 表示 thread 的创建来源，不等同于每一条 user message 的发送端。
- 当前上游 `ThreadItem.UserMessage.clientId` 是可选的客户端消息标识；官方文档没有把它定义为可信的 App/VS Code 来源字段，不能据此猜测来源。

对本项目的直接影响：

- 主控制面用 Companion 自己托管的 stdio app-server。
- Agent 不设置独立 `CODEX_HOME`，使用当前用户的正常 Codex 任务与认证环境，但项目代码不读取凭据。
- 不写 SQLite/JSONL，不绕过 app-server 状态机，不公开 app-server WebSocket。

## 3. DeepSeek Harness 只读源码审计

位置：`C:\Projects\deepseek-harness`；基线 `47f943859bef60e4160492346772ded9b24f765a`。该目录在工作区外，全程只读。

### 好的设计

- GUI、Host API、客户端和 transport carrier 解耦。
- RPC 消息有运行时 schema、`rpcId`、deadline 和请求/响应分型。
- 浏览器 API 使用 Host/Origin/Fetch Metadata/JSON media type 信任栅栏，防御 CSRF、DNS rebinding 与 confused deputy。
- 下行改用 WebSocket，解决浏览器 HTTP/1.1 长连接槽位问题；连接按 generation 和退避重建。
- 页面可在刷新后重建 Host 状态，体验非常适合远程 Agent。

### 远程暴露风险

源码文档 `docs/subsystems/web-server.md` 和 `packages/host/webserver/README.md` 明确说明：

- 默认绑定 `127.0.0.1`，也可有意绑定 `0.0.0.0`。
- Web Server 本身没有 TLS、认证或 origin policy；部署加固/反向代理不属于 dev-facing v1。
- browser trust fence 不是认证层，真正远程部署认证被明确推迟。
- API 权限可达到执行代码级别，不能因为有 Host/Origin 检查就公开到互联网。

### 连接模型

`2026-08-04-websocket-downlink-carrier.md` 显示：

- 浏览器→Host 的 unary/respond 继续走 HTTP POST。
- Host→浏览器用 mux 和 host 两条独立 WebSocket。
- 两条流无跨流顺序；任意一条关闭都会使整个 generation 退避重建。
- WebSocket 不接收客户端业务消息。

这在本机开发服务器里合理，但经公网 Relay 会增加连接、排序和移动切网复杂度。本项目借鉴协议分层和 generation，不照搬物理 carrier；改为一条全双工 WSS，并加入 seq/ack、快照、重放与 E2EE。

来源：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)

## 4. “无感知 + 当前任务控制”可行性

本机只读检查确认，Codex 桌面端的 app-server 由桌面父进程通过私有 stdio 持有，没有公开 listener。第三方不能像连接普通端口那样加入该 OS 进程；但用户实测证明，App 与 VS Code 无需共享 stdio/PID，也能交替更新同一 thread。因此产品目标是“同一 Codex task 的第三个富客户端”，不是“附着桌面进程”。

因此：

| 目标 | 结果 |
| --- | --- |
| App 与 VS Code 交替发送、及时同步新 turn | **用户当前版本已实测可用** |
| Codex Plus app-server 加入同一 thread | 采用官方 app-server 的 `thread/list/read/resume` 与 `turn/start` 实现 |
| 查看同一任务持久历史 | 可高质量实现 |
| 精确知道另一 app-server 的临时 active/approval 状态 | 不能通过持久历史保证 |
| 给桌面正在运行的 turn steer/approve | 无受支持的旁路接口 |
| Agent 恢复任务后继续发送 | 走官方 `thread/resume`；冲突按 app-server 返回失败关闭 |
| 完整自托管远程控制 | 由 Companion 自己拥有 app-server 可实现 |
| 精确控制现有桌面任务 | 使用官方 Remote |

UI Automation 能模拟用户，但它把任务归属、焦点和高风险批准建立在界面结构上，不能达到和官方协议相同的稳定性/安全性，已从 MVP 主链路移除。

### Codex Harness 不等于 Codex Desktop 前端

2026-08-21 对最新 `openai/codex` 上游做了全仓库盘点：开源内容是 CLI/Core、App Server、协议、SDK 和 Rust TUI，不包含 Codex Desktop、ChatGPT Remote 或 VS Code 的 React/Web/Electron GUI。官方文档也把“界面”定义为 host application 自己负责的部分。

因此：

- 不存在可直接拷贝到 Web 的官方 Codex App 图形前端。
- 可原样复用的官方 UI 只有终端 TUI；通过 ConPTY + xterm.js 远程呈现技术上可行，但移动触控、附件、审批、多任务和断线恢复明显不如结构化客户端，只作调试 fallback。
- 可以直接复用 App Server TypeScript/JSON schema、TUI 状态与 snapshots，以及 `inline_visualization/assets/visualize.css` 的官方开源 Web Token。

完整决策与证据见 [FRONTEND_SOURCE.md](FRONTEND_SOURCE.md)。

## 5. 高 Star 项目筛选

本轮采用 **1,000 Star** 最低门槛，并要求许可清晰、近期维护、直接相关。

| 项目 | Star 快照 | 许可 | 用途/决定 |
| --- | ---: | --- | --- |
| [openai/codex](https://github.com/openai/codex) | 110k+ | Apache-2.0 | 已复制到工作区，作为核心协议与源码依据 |
| [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | 33k+ | MIT | 只读参考 Web GUI/RPC/trust fence，不直接作为远程服务器 |
| [juanfont/headscale](https://github.com/juanfont/headscale) | 42k+ | BSD-3-Clause | 可选自托管私网控制面；Debian 12 支持良好 |
| [slopus/happy](https://github.com/slopus/happy) | 23.4k+ | MIT | **选为 Android/Web 产品基线**；收窄 Expo UI、Codex app-server 适配、E2EE 和自托管部分 |
| [Emanuele-web04/remodex](https://github.com/Emanuele-web04/remodex) | 3.2k+ | Apache-2.0 | 其 app-server/E2EE/本机 thread 同步思路接近；客户端仅 SwiftUI/iOS，不作 Android 基线 |
| [happier-dev/happier](https://github.com/happier-dev/happier) | 1k+ | MIT | 后续定向验证 existing-session 处理，不作主基底 |
| [K9i-0/ccpocket](https://github.com/K9i-0/ccpocket) | 1k+ | MIT | 参考 Bridge/幂等；Flutter 与已选 Expo 基线不一致 |
| [rustdesk/rustdesk](https://github.com/rustdesk/rustdesk) | 121k+ | AGPL-3.0 | 精确控制桌面当前窗口的独立应急通道；不复制进主项目 |
| [novnc/noVNC](https://github.com/novnc/noVNC) | 13k+ | MPL-2.0 | 未来可选浏览器桌面模式；需要另配 Windows VNC Server |
| [apache/guacamole-client](https://github.com/apache/guacamole-client) | 1k+ | Apache-2.0 | 浏览器 RDP/VNC 网关参考；MVP 过重 |

选用 Happy 不意味着原样搬入其全部商品功能和大量素材。实施原则是“保留已验证的移动组件和 Codex 链路，删除非必需功能，修正安全默认”，并记录许可、来源和改动。

远程桌面类项目不作为 Codex 协议实现的一部分。它们解决的是“精确操作现有桌面进程”，可独立部署作为应急入口；主产品仍用结构化 app-server 事件构建网页 Harness。

## 6. 网络调研结论

Tailscale 官方说明，连接优先升级为 UDP 直连；无法直连时回退 Peer Relay 或 DERP。无论直连还是中继，数据面都使用 WireGuard 端到端加密，差异主要是性能。它非常适合个人私有部署，但安卓要安装 Tailscale App。

来源：[Tailscale Connection Types](https://tailscale.com/docs/reference/connection-types)、[Tailscale Encryption](https://tailscale.com/docs/concepts/tailscale-encryption)

Headscale 是高 Star、面向个人/小组织的自托管 Tailscale 控制服务器；官方安装文档支持 Debian 12。它可作为阿里服务器上的私网方案，但会增加运维，且仍需本项目自己的任务同步/幂等协议。

来源：[Headscale GitHub](https://github.com/juanfont/headscale)、[Headscale Debian 安装](https://github.com/juanfont/headscale/blob/main/docs/setup/install/official.md)

最终选择（结合用户实测后修订）：

- 默认且优先实现：阿里出站 WSS Relay + 应用 E2EE。
- 用户实测 Tailscale 手机链路只有约 100 KB/s，而向阿里服务器上传至少约 1 MB/s；测试条件尚未完全对齐，因此只记录为产品决策依据，不冒充严格基准。
- Tailscale/Headscale 降为非默认兼容和可选对照，不进入 MVP 前置链路。
- Phase 0 可临时用反向 SSH/Nginx 验证阿里路径。
- 不直接把 DeepSeek/Codex 开发端口穿透到公网，不把 WebRTC/FRP 作为核心。

## 7. 实现验收项

不再安排 App/VS Code 跨客户端、共享 profile、Desktop Mirror 或消息来源的独立研究实验。后续只做正常编码验收：

1. 当前安装版 app-server 生成 schema 后，TypeScript stdio Agent 能初始化并消费所需事件。
2. `clientInfo=codex_plus` 能 list/read/resume 用户选中的正常 Codex 任务，原文 `turn/start` 的结果由 App/VS Code 正常看到。
3. Agent 只清理自己的 app-server，不影响现有 App/VS Code 启动与进程。
4. 状态冲突、未知批准和 schema 失配都失败关闭。
5. Windows 睡眠、Agent/app-server/Relay 重启后能从快照恢复。
6. 阿里 WSS 的 RTT、抖动、吞吐和切网测试只作后期调优，Tailscale 只作可选对照。
