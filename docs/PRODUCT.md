# 产品需求

## 1. 产品定义

当前产品分为且只分为三个角色：Windows 笔记本运行本机 Codex 服务；阿里服务器在宝塔环境使用 Docker 运行 Gateway；安卓手机使用浏览器操作。Windows 软件只负责让本机服务可用，保留一键启停与必要状态。任务、对话、模型、审批与设备管理属于网页，不继续扩展 Windows 管理界面。

Codex Plus 是一个自托管的 Codex Windows Web Harness。代码、官方 Harness、登录态和工作区都留在 Windows 电脑；安卓手机通过自己的域名查看并继续同一个 Codex 任务。Codex App、VS Code Codex 与 Codex Plus 使用当前用户的正常 Codex 环境，不建立隔离 profile 或第二套历史。

它不是云端 IDE，也不是另一个 Agent 实现。Codex Plus 网页只充当官方 `codex app-server` 的富客户端；项目不直接调用模型 API，不修改桌面客户端，也不绕过 Codex Harness。

## 2. 核心场景

1. 用户在 Codex App 或 VS Code Codex 中打开一个工作区并开始任务。
2. 用户离开电脑，用安卓手机打开自己的长期域名。
3. 手机看到同一个任务、持久历史和本机在线状态；选中任务后继续发送原文提示词。
4. Windows Agent 通过自己启动的官方 app-server 恢复该 thread，并执行消息、中断、回答或批准。
5. App、VS Code 和电脑 Web 可继续查看同一个任务；手机与电脑 Web 还共享 Agent 的实时事件和连接状态。

用户已在当前安装版本和当前对话中确认 App/VS Code 可交替发送并及时更新。这是产品基线，不再设计 Desktop Mirror、显式接管或两套 profile 之间的交接。

## 3. 设计原则

### 3.1 Codex Harness 是唯一执行主体

- 不向目标项目注入 Skill、MCP、AGENTS 指令或隐藏提示词。
- 不修改 Codex 二进制，不 DLL 注入，不拦截 OpenAI 网络请求。
- 不直接写 Codex SQLite、JSONL 或会话索引。
- 不控制 App 窗口像素，不根据界面猜测批准状态。
- 所有提示词、上下文、工具循环、沙箱和模型访问都由本机官方 app-server 处理。

### 3.2 同一任务，不要求同一进程

App、VS Code 和 Codex Plus 可以分别拥有自己的 app-server 进程，同时使用同一正常 Codex 任务。Codex Plus 不附着前两者的私有 stdio；若官方协议返回冲突或未知状态，写操作失败关闭。

### 3.3 手机端是主产品

P0 先完成手机端，电脑网页只是同一 React 应用的宽屏适配。信息架构与主要交互直接参考官方 ChatGPT Remote / Codex 手机体验：侧边任务抽屉、全屏对话、底部输入器、附件面板、审批卡片和主机连接管理。移动端优先保证：一眼看状态、单手输入、审批不误触、断线状态明确。360px 宽度是基础验收尺寸。详细规范见 [手机端界面](MOBILE_UI.md)。

### 3.4 自托管但不把风险搬上云

标准 Docker Gateway 只负责正式页面、`/manage`、连接协调和密文转发。代码执行、工作区访问、Codex 登录态和任务真相都留在 Windows；宝塔、1Panel 或普通 Docker 只是可替换的宿主环境。

## 4. 功能范围

### P0：MVP 必须有

- 主机在线/离线和最后心跳。
- 当前正常 Codex 环境的最近任务列表：标题、工作区、更新时间和状态。
- 用户明确授权的工作区列表，以及在授权目录中创建新任务。
- 任务直接使用授权的原工作目录，不自动创建 worktree、克隆或影子副本。
- 对话时间线：用户/Agent 消息、推理摘要、命令/工具状态、错误和最终结果。
- 实时增量、断线补偿、文本发送、任务中断、问题回答和批准/拒绝。
- 电脑 Web 与 Android 客户端连接同一 Agent，状态、消息、批准和断线恢复一致。
- Codex App/VS Code 能继续同一任务；Agent 不改变它们的进程、端口或安装。
- 输入框文本经公网加密往返后逐字符不变；Agent 不增加、删除、总结或改写。
- 手机相册/文件选择器上传图片和普通文件；附件 E2EE 分块到 Windows，Relay 不保存明文。
- 图片以 app-server `localImage` 结构化输入发送；普通文件由官方 Harness 通过经过授权的本机路径读取，Agent 不预处理正文。
- 二维码/一次性口令配对、设备撤销和 Relay 应用层 E2EE。
- 标准 OCI 镜像与 Compose：同一个 Gateway 可部署到任何支持 Docker 的 Linux 系统，公网只经 HTTPS/WSS 443。
- `/manage` 分层显示 Gateway、Relay、Windows Host、E2EE Session 和 app-server 状态；列出已授权/已撤销设备，支持请求配对、重命名和 Host-first 撤销。
- 同一 DSH-derived React Web/PWA 的 Android 浏览器、电脑 Web、暗色/亮色和手机响应式布局；APK 不阻塞 MVP。
- Relay 与 Windows Agent 的健康检查；验证后再提供当前用户自启动。

### P1：MVP 稳定后

- Git diff 与变更文件摘要。
- 推送通知。
- 多台 Windows 主机。
- 任务搜索、收藏和筛选。
- 更细的跨客户端来源展示；只有协议提供可靠证据时才区分 App 与 VS Code。

### 暂不进入范围

- 单独重写原生 Android/iOS 两套 UI；iOS 发布不阻塞 Android/Web MVP。
- Desktop Mirror、UI Automation、完整远程桌面或远程 Shell。
- 团队、多租户、计费和公开注册。
- 宝塔专用插件、宝塔 API 集成、服务器万能管理员或公开设备管理 REST API。
- 在服务器上启动 Codex 或克隆用户仓库。
- 自动批准。
- 独立 `CODEX_HOME`、第二次 Codex 登录或 profile 交接。

## 5. 状态模型

| 状态 | 含义 | 可用操作 |
| --- | --- | --- |
| `syncing` | 正在读取 thread 快照或补齐事件 | 查看，暂不写入 |
| `running` | Agent 已确认 turn 正在运行 | 查看、补充（支持时）、中断 |
| `waiting_approval` | Agent 的 app-server 有明确 pending approval | 查看详情、一次批准/拒绝 |
| `waiting_input` | Agent 请求用户回答 | 回答、稍后处理 |
| `completed` | 最近 turn 正常完成 | 继续对话 |
| `failed` | 最近动作或 turn 失败 | 查看错误、明确重试 |
| `unknown` | schema、归属或同步证据不足 | 仅查看，禁止高风险控制 |
| `offline` | Windows Agent 心跳超时 | 查看最后快照 |

`unknown` 是安全状态。不能确认 thread/turn/approval 归属时，不得伪装成可写或已完成。

## 6. 关键验收

### 查看与继续

- 正常网络下，任务和新消息应在数秒内出现在手机与电脑 Web；重连后补齐且不重复渲染。
- 发送后依次显示“发送中 / Relay 已转发 / 本机已接受 / 失败”，不能只做乐观成功。
- App 或 VS Code 稍后打开同一 thread 时能看到 Codex Plus 的 turn，并可继续；反向同理。

### 审批

- 卡片显示主机、任务、请求类别、命令/动作摘要、风险与过期时间。
- 只有 Agent 当前仍持有的 pending request 可操作；网络重试不能重复批准。

### 断线

- Windows 离线时保留最后快照并显示时间。
- 输入可保留为手机本地草稿，但 Relay 不静默排队高风险动作。
- Agent、Relay 重启或手机切网后，以 snapshot + cursor 恢复。

### 文本质量

中文、换行、代码块、引号、Emoji 和首尾空格进入 `turn/start.input.text` 后必须与输入框逐字符一致。

### 图片与文件

- 图片与文本必须在同一个 turn 中提交，历史中保持为一条用户消息。
- 上传中断可恢复或明确失败；没有完成校验的附件不能触发 turn。
- 普通文件的路径引用在发送前以附件 chip 对用户可见，不作为隐藏提示词注入。
- Relay 日志、缓存和数据库不出现附件正文；Agent 只将附件写入工作区 `.data/attachments/`。
- App/VS Code 不理解 Codex Plus 的 chip 样式时，至少仍能看到同一消息中的文件路径/名称；不能因此丢失用户原文。

## 7. 前端体验

- 手机是首要验收端：任务抽屉与对话分层；顶部固定主机/任务状态，底部固定 ChatGPT 风格多行输入器。
- 桌面不单独开发第二套页面；同一应用在宽屏固定左侧任务导航，并按需增加详情区。
- 命令、文件变更和工具调用使用折叠卡片，突出结果、运行态和风险。
- 字体、灰阶、间距、圆角和动效接近当前 Codex，但使用自己的设计 Token，不复制闭源资源或冒充官方产品。
- 官方 Remote 的“同一 ChatGPT 账号 + 二维码配对”在 Codex Plus 中对应“同一组自托管设备身份 + 二维码/一次性口令”；Android/Web 客户端不收集或代理 OpenAI 账号、密码或 token。
- 任务列表、时间线、输入器、工具、diff、审批和附件使用已冻结的 DSH-derived React Web/PWA；`slopus/happy` 只保留为迁移期行为与安全回归参考。
- “Codex Plus 发出”的消息可有本地标记；其他历史只标为“其他 Codex 客户端”，除非协议提供逐条可靠来源。

## 8. 成功指标

- 连续完成 10 次“App/VS Code 发起 → 手机续聊 → App/VS Code 继续”，无串线、重复执行或任务丢失。
- 连续完成 20 次批准/拒绝重试，无重复提交。
- 文本不变性样本全部通过。
- 图片 multimodal 输入、已有工作区文件引用和手机文件上传各连续完成 10 次，无串附件或重复 turn。
- Windows Agent、app-server、Relay 重启及手机切网后均能恢复。
- Relay 日志抽查不含对话正文、令牌、代码或完整本机路径。
- 360px 安卓真机可完成查看、输入、批准与断线恢复。
