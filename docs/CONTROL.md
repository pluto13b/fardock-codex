# Codex 控制面与进程生命周期

> 决策日期：2026-08-21。本文回答“网页到底控制谁、消息如何进入同一任务，以及为什么不再需要固定端口或桌面映像”。

## 1. 控制对象

Codex Plus 不控制 Codex App 的窗口，也不把手机消息发给一个交互式 CLI/TUI。Windows Agent 启动自己的官方后台进程：

```text
Codex App ─────────────> 私有 app-server A ─┐
VS Code Codex ─────────> 私有 app-server B ─┼─ 当前用户的正常 Codex 环境 / 同一 thread
Android/Web -> Agent ─────> 私有 app-server C ─┘
```

这里的 C 是 `codex.exe app-server`：与 App/VS Code 使用相同的官方 Harness 引擎，但没有终端 UI。Codex Plus 网页是它的富客户端。

用户已经用当前对话确认 App 与 VS Code 能交替发送并及时更新。产品因此把“同一 thread 可由多个客户端继续”作为基线。严格来说这不是三个页面共享同一个 Windows PID，而是三个客户端各走自己的官方连接，共享同一个 Codex 任务。

## 2. 为什么使用 Agent 托管的 stdio

Agent 只负责：

1. 启动并监督自己拥有的 `codex.exe app-server`。
2. 把任务列表、发送、停止、回答和批准映射为官方 JSON-RPC。
3. 校验配对设备、thread、工作区、动作期限和幂等键。
4. 在公网边界加解密，并把 app-server 事件整理成稳定页面事件。
5. 主动连接 Relay，处理游标、快照和断线恢复。

启动命令为：

```text
codex.exe app-server
```

`stdio://` 是默认 transport。stdin/stdout 每行一个 JSON-RPC/JSONL 消息。MVP 不监听 TCP 端口；电脑与手机的多个页面连接由 Agent 复用。

这带来几个明确边界：

- Agent 持有真实子进程句柄，只能管理自己的 C，不能误杀 App/VS Code 的 A/B。
- 不存在旧 listener 占住固定端口、导致新 app-server bind 失败的问题。
- 官方实验 WebSocket 不暴露到家庭网络或公网。
- Agent 退出时关闭自己的 stdin，并只清理自己创建的进程树。

## 3. 正常 Codex 环境

Agent 子进程继承当前 Windows 用户的正常环境：

- 不设置、覆盖或清空 `CODEX_HOME`。
- 不创建 `.data/codex-home` 或第二份 profile。
- 不发起一套独立 device-code 登录。
- 不读取、复制、上传或记录 `auth.json`、token、Cookie 或其他凭据。

认证、配置和任务存储仍由官方 app-server 按 Codex 的正常规则使用。共享 profile 的意义是让 Codex Plus、App 和 VS Code 看见同一任务；它不授权本项目解析或修改 Codex 的底层 SQLite/JSONL。

任务直接使用用户授权的原工作目录，不自动创建 worktree、复制仓库、切分支或施加仓库锁。若不同客户端同时要求 Codex 修改同一目录，界面展示活动状态与风险，但不猜测性拦截正常官方行为。

## 4. 初始化和生命周期

2026-09-07 桌面交付：新增原生 GUI/托盘与包含 Node/production bundle/官方 CLI 的 Windows release，普通用户无需命令行。GUI 通过私有 stdin start/stop 控制同一 production runner；Job 在放行 start 前绑定，只管理 owned 子树，关闭主窗口保留托盘，“退出并停止”正常清理。原有源码 CLI 仍可用于开发；当前数据目录和设备身份不迁移。详细打包和旧任务切换边界见 [WINDOWS_RELEASE.md](WINDOWS_RELEASE.md)。

2026-09-05 兼容性更新：现有 Companion launcher 钉死的桌面附带 CLI 为 0.151.0，而官方 npm 最新为 0.153.4。只在工作区 `.cache/codex-runtime-0.153.4` 安装官方 Windows runtime，并在 `.tmp` 生成 schema 和执行 owned-child model/list/read/send 验证；不修改或重启 Codex App。验证通过后 launcher 明确使用工作区新版 executable；initialize 与 version probe 必须对应同一版本，保留已验证旧版的精确兼容分支，不放宽为任意版本。

隐藏进程不再从一次性工具终端启动：使用已有 `scripts/install-windows-companion-task.ps1` 注册当前用户 limited `CodexPlusCompanion` 登录任务，并由 Windows Task Scheduler 启动，以免 Codex 工具进程回收连带关闭 Host。launcher 等待自己的 Node child，stdout/stderr 写入工作区白名单日志，启动前只滚动同目录上一份日志；任务失败继续使用现有最多五次/一分钟恢复策略。只管理该精确任务及其 owned child，不操作 Codex App。

现场反馈所有任务禁止发送时，必须先区分 runtime binding 降级与任务 authority。生产启动日志只增加固定 binding state/reason，不输出 executable、Codex Home、版本原始输出或异常；在确认原因前不能放宽 write-bound 门禁。

根因已由官方 initialize/default_client 源码确认：没有 Codex App 的内部 originator 覆盖时，userAgent 前缀取 clientInfo.name，即本项目的 codex_plus，版本仍是官方 build version。兼容校验必须接受 codex_plus 的已验证精确版本，不能要求伪装成 Desktop。测试通过仅在测试进程删除已知非秘密 originator 覆盖来复现计划任务环境；不枚举环境、不修改 CODEX_HOME 或正式进程环境。

任务 ownership 只决定 send/steer/interrupt 权限，不改变历史读取预算。生产任务在一次发送被接受后仍使用同一有界 turns 分页，不因成为 Companion-owned 就切回 includeTurns=true 的无界完整历史；否则长任务会在轮询时超过 stdout/frame 上限，造成“消息已发送但看不到回复”。

### 启动

1. Agent 用命名互斥量/单实例锁保证自身只有一个实例，不用 TCP 端口充当锁。
2. 用 `child_process.spawn` 直接启动 app-server，stdin/stdout/stderr 全部管道化，不经 shell。
3. 发送 `initialize`，如实声明：

```json
{
  "clientInfo": {
    "name": "codex_plus",
    "title": "Codex Plus",
    "version": "<build>"
  },
  "capabilities": {
    "experimentalApi": true,
    "requestAttestation": false,
    "mcpServerOpenaiFormElicitation": false,
    "optOutNotificationMethods": []
  }
}
```

4. `experimentalApi:true` 只用于当前 0.151 的 read-only `thread/turns/list` 分页；严格校验 initialize 的 `userAgent`、`codexHome` 和 Windows platform 字段，再发送 `initialized`，这才是 JSONL ready 信号。
5. 写能力还必须通过同一绝对 executable 的有界 `--version` 探针，并绑定当前 child generation；任一版本、schema、路径或平台不兼容都只读降级，不连续快速重启。

### 运行

- 每个请求都有 id、超时、thread 绑定和幂等结果。当前 generic `request()` 只开放 `thread/list`、`thread/read` 与 `thread/turns/list`；所有 write method 即使出现在识别表/构造 allowlist 中也不能从该入口 dispatch。
- stdout 只解析完整 JSONL；stderr 仅做有界排空，不保留、不返回远端，也不进入正常日志。结构化生命周期日志只记录白名单元数据。
- app-server 退出后由 Agent 有界重启，再从官方任务历史重建页面快照。
- Agent 不附着、复用或终止 App/VS Code 创建的 app-server PID。

### 关闭

1. 停止接受新动作。
2. 等待当前写操作到安全边界，关闭子进程 stdin。
3. 等待正常退出；超时只终止 Agent 保存句柄的那个进程树。
4. 后续用 Windows Job Object 确保 Agent 异常退出不留下自己的孤儿进程。

禁止按进程名批量结束 `codex.exe`。

## 5. 固定端口冲突

若运行：

```text
codex app-server --listen ws://127.0.0.1:4500
```

app-server 会绑定 4500。旧进程仍占用端口时，新进程启动失败。当前 Codex App 与 VS Code 默认各用私有 stdio，因此本项目也使用 stdio，完全删除固定端口依赖。即使后期调试 WebSocket，也只能绑定 localhost 的临时端口，不能作为生产主链路。

## 6. 页面动作映射

| 页面动作 | Windows Agent → app-server |
| --- | --- |
| 打开任务列表 | `thread/list` |
| 查看持久历史 | `thread/read` / 分页 history |
| 创建任务 | `thread/start` |
| 恢复现有任务 | `thread/resume` |
| 发送新消息 | `turn/start` |
| 补充当前 turn | `turn/steer` |
| 中断 | `turn/interrupt` |
| 回答/批准 | 回复 app-server 发来的对应 server request |

Agent 不把原始 JSON-RPC 任意透传给浏览器。“新开工作区”只能从 Agent 预先授权的目录列表选择，浏览器不能提交任意本机路径。

## 7. 文本与事件链路

网页输入的 `userText` 在 E2EE 解密后必须逐字符保持，并原样放入：

```text
turn/start.params.input[0] = { type: "text", text: userText, text_elements: [] }
```

Agent 不改写、润色、总结、压缩或加隐藏前后缀。JSON 的 `\n`、`\"` 等只是传输转义，解析后仍是原字符。

图片是同一个 `turn/start.input` 数组里的另一个 item：

```json
"input": [
  { "type": "text", "text": "帮我看这张截图", "text_elements": [] },
  { "type": "localImage", "path": "C:\\Projects\\codex-plus\\.data\\attachments\\...\\shot.png" }
]
```

Android/Web 客户端把首版 bounded 图片字节放入同一 action 的 E2EE attachment sidecar；Agent 只在工作区 `.tmp/remote-runtime-*/attachments/` create-new 落盘并把本机路径交给 app-server。私有图片不经过公网 URL，base64 只存在于 AEAD 明文内部且不进入提示词、任务快照或日志。

普通文件不同：当前公开 app-server schema 没有通用 `file` input。首版 sidecar 通过 MIME/magic/UTF-8 校验后落到 `.tmp`，Agent 生成独立文本 input；底层 text 含 Codex 可读取的绝对路径，`text_elements` 的 byte range/placeholder 将它显示为文件名 chip。原始用户文字保持独立 input，Agent 不调用 OpenAI Files API。

页面发送的是 `attachmentId`，绝不允许网页直接指定 Windows 路径。附件在上传完成、类型/大小/完整性校验通过后才能与消息一起提交；失败时不创建 turn。

`turn/start` 成功响应后才显示“已送达”。Agent 继续读取 `item/started`、`item/completed`、Agent 文本 delta、工具进度、批准/输入请求和 `turn/completed`，再把归一化事件加密发送给页面。

Codex Plus 可以可靠标记自己发出的动作，因为它掌握 `requestId` 和自己的连接身份。`clientInfo` 标识连接，thread 的 `source` 主要描述任务来源；当前没有可靠的通用字段能证明历史中每一条用户消息究竟由 App 还是 VS Code 发出。因此 UI 只标“Codex Plus 发出”或“其他 Codex 客户端”，不臆测 App/VS Code 的逐条来源。

## 8. 失败关闭

- 若 `thread/resume`、`turn/start` 或批准回复返回任务忙/状态冲突，页面显示官方错误并保持只读，不绕过 writer ownership。
- 只有 Agent 当前实时收到且仍 pending 的批准/输入请求才显示操作按钮；D5 live broker 只接受四个固定 server-request method、Companion-owned task/turn 和最长两分钟 authority，其他请求继续固定安全拒绝。
- schema/能力未知时禁用相应写动作；任务历史仍可查看。
- App/VS Code 是否即时刷新由正常 Codex 同步负责；Agent 不操作其窗口来制造“已同步”的假象。

## 9. 当前实现顺序

1. R1–R5 本机纵向已经完成：真实 app-server、E2EE/Relay、durable action、跨进程历史、send/steer、新建任务和附件均已验证。
2. 当前不重做 Windows 控制链；主线转为 [`DOCKER_GATEWAY.md`](DOCKER_GATEWAY.md) 的 D1–D8。
3. D1–D7 已完成 production Gateway、public WSS、跨重启状态、管理/P0、Docker 与实际阿里公网闸门。
4. D8 新增独立 production Companion；它复用本页 supervisor/stdio 边界和现有持久 authority，不扩展 generic RPC。
5. 首个 D8 只接一台已确认手机；远程 task.start 与第二 active device 的跨 runner 重启在对应 durable/router 完成前保持关闭，不由 Demo 内存状态冒充。
6. D8 首次配对必须在可见终端完成；成功后可注册当前用户 `CodexPlusCompanion` 登录任务。计划任务只启动工作区 launcher，失败重启也只作用于 production runner 自己，卸载不查找或终止其他 `codex.exe`。

这是正常实现与验收，不再另做隔离 profile、Desktop Mirror、UI Automation 或来源识别研究。

## 10. 依据

- [OpenAI Codex App Server 文档](https://developers.openai.com/codex/app-server)
- [OpenAI Codex 开源组件清单](https://learn.chatgpt.com/docs/open-source)
- [上游 app-server README](../.upstream/openai-codex/codex-rs/app-server/README.md)
- [默认 stdio transport](../.upstream/openai-codex/codex-rs/app-server-transport/src/transport/mod.rs)
- [stdio EOF/关闭实现](../.upstream/openai-codex/codex-rs/app-server-transport/src/transport/stdio.rs)
