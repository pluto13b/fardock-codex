# FarDock — Codex remote companion

从 Android 浏览器查看和继续 Windows 本机的 Codex 任务。Windows 负责本地服务，自托管 Docker Gateway 提供 Owner 登录和加密中转。

**Early source preview / 早期源码预览。** 当前仅发布源码，不提供已经验证适合新用户直接安装的二进制发行包。现有内部包名与软件名称仍使用 Codex Plus；本次不改协议或运行数据格式。

## 三个平台

| 平台 | 职责 |
| --- | --- |
| Windows 笔记本 | 运行官方 Codex app-server 与 Companion，执行任务。 |
| 自托管服务器 | 用 Docker 运行 Gateway，提供网页、Owner 登录与 E2EE 密文中转。 |
| Android 浏览器 | 浏览各项目会话，读取/发送消息、选择模型、处理批准与设备管理。 |

项目不是 OpenAI 官方产品。代码执行与 Codex 凭据留在自己的 Windows 主机；Gateway 不执行任务或保存对话明文。

## 快速查看界面

需要 Node.js 26 与 pnpm 10，在 Windows PowerShell 中运行：

```powershell
git clone https://github.com/pluto13b/fardock-codex.git
cd fardock-codex
pnpm install --frozen-lockfile
pnpm mobile-ui:preview
```

打开本机 `http://127.0.0.1:5182/`。这只运行离线 UI，所有任务、连接和 48 ms 延迟均为模拟数据。浅色主题、流式文字缓冲、弹窗和呼吸效果仍在隔离入口，正式 Web 尚未启用这些实验样式。Windows 新视觉也独立预览，不启动真实服务。

- [手机界面预览](apps/codex-web/mobile-preview/README.md)
- [Windows 界面预览](apps/windows-companion-preview/README.md)

## 自托管与真实连接

需要自己的域名、HTTPS/WSS 反向代理、Docker 服务器，以及已正常登录官方 Codex 的 Windows 用户环境。本仓库不附带作者的服务器地址、账号、设备授权或凭据。

先阅读[部署入口](docs/DEPLOYMENT.md)，再按[Gateway 规范](docs/DOCKER_GATEWAY.md)与[Windows Agent 规范](docs/WINDOWS_AGENT.md)配置。`gateway.example.com` 等均为示例，必须替换成自己的配置。Owner 密码不放进环境变量或 Git；使用 `scripts/create-owner-verifier.ps1` 在本机交互生成 verifier 并私下部署。

Windows 启动脚本要求显式传入自己的 Origin：

```powershell
.\scripts\start-windows-companion.ps1 -Origin https://gateway.example.com
```

该命令要求先按规范准备官方 CLI、Host 身份与 Gateway 授权，不负责绕过初次配置。Windows 打包候选同样要求设置 `CODEX_PLUS_PUBLIC_ORIGIN`；请勿把自己的配置、运行数据或个人打包目录直接上传为公开 release。

账号登录保留；首次连接由 Windows 的“连接手机”生成短期一次性配对码。手机登录 Owner 后输入，后续依靠保存的设备授权恢复。正式流程不扫码、不要求人工核对 SAS。

## 让 Agent 帮你部署

仓库包含 [fardock-deploy Skill](skills/fardock-deploy/SKILL.md)。可以直接把下面的话交给支持本地文件与终端操作的 Agent：

> 阅读 skills/fardock-deploy/SKILL.md，帮我部署 FarDock。先检查我指定的 Windows 工作区和 Docker 服务器，缺少域名或连接信息时问我。不要读取或让我发送密码、SSH 私钥、Codex 凭据；Owner 登录由我在本机完成。

支持 Skill 安装的 Agent 也可安装整个 `skills/fardock-deploy` 文件夹，再使用 `$fardock-deploy`。Skill 引导环境检查、私有配置、镜像构建、首次 bootstrap、配对与验收；已有授权会保留，遇到缺少权限或配置时报告阻塞，不自行清理服务器或绕过认证。

该 Skill 已做结构与源码流程核对，尚未作为独立安装流程在全新生产环境演练；不会承诺零配置或无需用户登录。

## 验证与限制

```powershell
pnpm typecheck
pnpm test
pnpm codex-web:build
pnpm mobile-ui:build
```

源码包含真实链路、幂等动作、授权与只读失败关闭实现，以及合成测试。此前开发记录包含实际 Windows/服务器验收，但本次公开版不提供生产服务在线状态保证。新环境首次部署、Android 真实帧率/后台恢复和不同 Codex 版本的兼容性仍需按环境验证。

外部客户端正在运行的任务按实际 authority 保持只读；项目不会接管、注入或终止 Codex App/VS Code。请只使用自己的账户和主机。

## 文档与代码

- [架构](docs/ARCHITECTURE.md) · [协议](docs/PROTOCOL.md) · [安全](docs/SECURITY.md)
- [当前公开状态](docs/PROGRESS.md) · [手机规范](docs/MOBILE_UI.md) · [Windows 交付](docs/WINDOWS_RELEASE.md)
- [DSH UI 使用边界](docs/DSH_UI_ADOPTION.md) · [第三方 UI 来源](vendor/deepseek-harness-ui/UPSTREAM.md)

## 许可

本项目自行编写部分的许可证尚未确定；目前以源码预览发布，不据此承诺额外的使用/修改/再分发授权。第三方代码继续适用各自已有许可证，相关 LICENSE 与 NOTICE 保留在对应目录中。
