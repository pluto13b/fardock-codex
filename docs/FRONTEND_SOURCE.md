# 前端上游与采用决策

> 初始决策日期：2026-08-21；前端供体于 2026-08-23 更新。本文保留候选审计历史，当前执行方案以 `docs/DSH_UI_ADOPTION.md` 为准。

## 结论

上一版 `apps/web/` 自制 ChatGPT 风格静态壳已被用户否决，不再作为产品基线。

OpenAI 开源的 Codex Harness 包含 CLI/Core、App Server、协议、SDK 和 Rust 终端 TUI，**不包含 Codex Windows/macOS Desktop App、ChatGPT Remote 或 VS Code 扩展的 React/Web/Electron 图形前端**。因此不存在可以从 `openai/codex` 直接复制的官方桌面聊天页面。

项目当前改用三层上游：

1. **OpenAI Codex 作为唯一 Harness/协议上游**：直接复用 App Server schema、线程/turn/item/审批状态语义、可用的官方 Web Design Token，并以 TUI 快照作为状态覆盖基准。
2. **`deepseek-ai/deepseek-harness` 作为产品 UI 源码供体**：固定采用 `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`（`0.1.1-rc.2`）的 MIT `packages/client/ui-*`，把 Cordis/DSH service hook 改成普通 React props 与 Codex Plus view model。
3. **`anywhere-labs/deepseek-harness-desktop` 作为桌面组合依据**：采用版本 2.0.2 所展示的窗口/列组合；它本身主要是 Electron 外框，真正聊天 UI 仍来自上面的官方 DSH 固定快照。

`slopus/happy` 已经完成的 Expo 客户端暂时保留为移动交互、安全策略与 fixture 回归基线，但不再是最终视觉/产品前端。新产品面采用独立 React DOM/Web/PWA 客户端；验证完成后整体归档旧 Expo UI，避免长期维护两棵界面。

这意味着：不再从空白页面猜官方外观，也不宣称拿到了未开源的 Codex App GUI；直接复用高 Star、MIT 的 DSH UI 源码，同时确保浏览器到模型之间仍只有 Codex Plus Relay → Windows Companion → 官方 `codex app-server` 一条执行链。

## 官方开源边界的证据

本地上游基线：`.upstream/openai-codex` @ `536f86e5cc9ec1ff38457d099bf320b9d08eeeba`。

- 官方 Open Source components 列出 CLI、SDK、App Server、Skills 和 Plugins；IDE 扩展明确不开源，Desktop 图形前端也不在开源列表中。
- `pnpm-workspace.yaml` 只有 CLI、Responses proxy 和 TypeScript SDK，没有 app/web/desktop package。
- 上游仓库没有 `.tsx` / `.jsx` / `.vue` / `.svelte` 生产前端，也没有 Electron `BrowserWindow` / `ipcRenderer` 实现。
- `codex-rs/docs/protocol_v1.md` 把 UI 定义为 Codex 外部的任意客户端。
- `codex-rs/app-server/README.md` 把 App Server 定位为富客户端接口，并明确由 frontend 拥有 UX。
- 完整开源 UI 是 `codex-rs/tui/` 的 Ratatui/Crossterm 终端界面，而不是 Codex App 图形界面。

可以直接采用的官方部分：

- `codex-rs/app-server-protocol/schema/typescript/`：生成的协议类型。
- `codex-rs/app-server-protocol/schema/json/`：协议校验与契约测试。
- `codex-rs/tui/src/inline_visualization/assets/visualize.css`：官方开源的浏览器中性色、字体、圆角、card/button/input/table/badge 等 Token。
- `codex-rs/tui/src/history_cell/`、`exec_cell/`、`diff_render.rs`、`bottom_pane/`、`resume_picker.rs` 及其 `*.snap`：用来定义消息、命令、diff、审批、用户提问和任务列表的正式状态矩阵，但不能原样嵌入 DOM。

## 候选路线

| 路线 | 优点 | 不符合点 | 决定 |
| --- | --- | --- | --- |
| 提取 Codex Desktop 安装包的 renderer | 外观最接近桌面 App | 不是开源 Harness；闭源代码/资源再分发边界不清；每次 App 升级都可能破坏；容易碰安装与运行进程 | 拒绝作为产品路线 |
| 官方 TUI + Windows ConPTY + xterm.js | 真正原样运行开源 Codex UI；Harness 无旁路 | 是终端外观；Android 触控、中文 IME、附件、审批与后台恢复体验差；PTY 转发比结构化协议更难安全收窄 | 仅作调试/应急 fallback，不作手机主界面 |
| `slopus/happy` | Android/iOS/Web 一套 Expo UI；完整消息/工具/diff/审批/附件/离线交互；Codex app-server stdio；E2EE；高 Star | 视觉方向被用户否决；源码深耦合旧 store/wire/商业与社交模块，继续精修成本高 | **保留为迁移期行为/安全回归基线，之后归档** |
| `deepseek-ai/deepseek-harness` | MIT；高 Star；提供完整 React DOM/CSS Modules 的 layout/sidebar/conversation/composer/tool/approval UI | Cordis slots、DSH Host RPC 和 session model 不能进入本项目执行链；原布局不是 360px 手机成品 | **固定源码快照，作为新产品 UI 供体；替换数据层** |
| `anywhere-labs/deepseek-harness-desktop` | MIT；高 Star；把最新 DSH Web UI 组合成用户指定的桌面效果 | 自有前端很薄；整包会启动 DSH Host/Agent、占端口并引入 Electron/更新/凭据/文件权限；手机远控仍未交付 | **只采用桌面组合和少量纯布局，不运行整包** |
| `iOfficeAI/AionUi` | Apache-2.0、约 32.2k Star；已有完整 `MessageAnchorRail`，正是一列用户消息 tick、磁吸 hover 预览和点击跳转 | Electron DOM/CSS 与本项目 Expo `FlatList` 不兼容；其全量历史读取也不能直接进入本项目预览/安全边界 | **采用最小 anchor/geometry 算法，改写为 React Native Web 组件** |
| `MichengAI/dsh-codex-ui` | Apache-2.0；确实是社区 Codex 风格 DSH 插件，覆盖侧栏、workspace tree、对话列与 composer 外观 | 体量与 Star 远低于主 DSH；模型/推理选择仍依赖宿主公开 slot，不提供一套可直接替换本项目数据链的高星独立前端 | 只核对 Codex 风格细节，不整包采用 |
| `Emanuele-web04/remodex` | 约 3.3k Star；Apache-2.0；app-server、E2EE、本机线程同步思路非常接近 | 客户端只有 SwiftUI/iOS；Windows 无后台服务封装；不能直接解决 Android 主端 | 只借鉴本机同步和配对语义 |

Star 是本次基线选型的质量信号，不会变成日常追版本或追数字工作。

## Happy 历史基线的迁移边界

现有 `apps/client` 不直接部署 Happy 公网服务，也不原样开启其全部产品功能。它在新 Web 壳验收完成前继续提供回归依据：

- 保留 MIT LICENSE 和必要归属，改用 Codex Plus 自有名称/素材，不使用 Happy 或 OpenAI 商标冒充官方应用。
- 只复用已经验证的状态语义、移动端返回/键盘/安全区测试和 Codex 权限防线；不再投入桌面视觉重做。
- 复用/对照 `packages/happy-cli/src/codex/` 的 App Server stdio 客户端、消息映射、附件和中断处理，但 schema 以当前安装的官方 Codex 生成结果为准。
- 删除或不编译 Claude、Gemini、朋友/社交、商业购买、Happy 托管、不需要的语音和大量装饰资源。
- 把默认权限改为 on-request/read-only；无 handler、状态归属不明或 schema 不匹配时必须拒绝/只读，不可自动批准。
- 不改写 `CODEX_HOME`，不管理 OpenAI 登录，不读取凭据；仅启动和监督自己的 `codex app-server` 子进程。
- 提示词默认按原文作为 `UserInput.text` 传递；所有额外模式/系统提示注入在 MVP 关闭。
- 输出、缓存、服务器数据和测试文件继续放在工作区的 `.cache/`、`.data/` 和 `.tmp/`。

## 不可回退的验收条件

- 手机和电脑使用同一套 React Web/PWA 产品组件；旧 Expo 只在迁移期并存。
- 所有模型指令只经过官方 `codex app-server`，没有直接 OpenAI API 路径。
- 前端根据结构化 thread/turn/item 状态渲染，不通过 DOM 抓取、窗口注入或屏幕控制 Codex App。
- 可在 Android 真机执行任务选择、原文输入、图片/文件附件、一次性审批、中断、断线恢复。
- 新线程与续聊线程使用正常 Codex 环境，可在 Codex App/VS Code 的共享任务目录中出现。
- 第三方前端基线的许可、修改和未采用功能都在仓库内有记录。

## 官方资料

- [Codex as a platform: build on the open agent harness](https://learn.chatgpt.com/blog/codex-as-a-platform)
- [Open Source components](https://learn.chatgpt.com/docs/open-source)
- [OpenAI Codex repository](https://github.com/openai/codex)
