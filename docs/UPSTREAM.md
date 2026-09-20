# 上游源码工作区

为了减少二手理解和版本漂移，本项目把用于调研的上游源码放在工作区内的 `.upstream/`。该目录不进入本仓库 Git：它保留各上游自己的提交历史，便于搜索、对比和更新，同时避免把几十万行第三方源码重新提交到 Codex Plus。

## OpenAI Codex

- 计划位置：`.upstream/openai-codex`
- 来源：`https://github.com/openai/codex.git`
- 获取方式：浅克隆，仅用于阅读、构建验证和协议实验。
- 本轮基线提交：`536f86e5cc9ec1ff38457d099bf320b9d08eeeba`（`Support attaching to existing realtime calls (#39876)`）。
- 重点范围：`codex-rs/app-server*`、`codex-rs/thread-store`、协议 schema、测试客户端与远程控制实现。
- 规则：默认不直接修改上游副本；需要采用代码时，将最小片段移入本项目并记录许可证、原始路径与修改。

## DeepSeek Harness

- 只读位置：`C:\Projects\deepseek-harness`
- 本轮基线提交：`47f943859bef60e4160492346772ded9b24f765a`
- 规则：该目录在工作区外，严格只读；不安装依赖、不运行格式化、不删除现有日志、不改动其未跟踪文件。
- 重点范围：Web Host/Client 分层、HTTP uplink + WebSocket downlink、浏览器信任边界、断线重建和 UI 插件结构。

## Happy

- 只读位置：`.upstream/happy-sparse`
- 来源：`https://github.com/slopus/happy.git`
- 获取方式：`--depth 1 --filter=blob:none --sparse` 浅克隆；按实现需要再拉取必要文件，避免把大量无关装饰资源拉入工作区。
- 本轮基线提交：`eb980a5c9eea25b1c145c06cd6241a0a365c2b6d`。
- 基线选型快照：约 23.4k Star，MIT，Expo Android/iOS/Web + Codex/Claude 客户端。
- 重点范围：`packages/happy-app`、`packages/happy-cli/src/codex`、`packages/happy-wire`、`packages/happy-server-self-host`。
- 规则：上游副本保持只读；采用的最小子集移入本项目后保留 MIT LICENSE/归属并记录改动。不启用 Happy 托管、购买、社交或不符合 fail-closed 的默认权限。
- 已采用：`packages/happy-app` → `apps/client/`，`packages/happy-wire` → `packages/happy-wire/`；原样导入提交 `559fb01`，随后修改单独提交，便于审计第三方基线与本项目差异。

## AionUi

- 来源：`https://github.com/iOfficeAI/AionUi.git`
- 本轮基线提交：`573927d46d3681182bbea36f8b9aa6dbc7296648`。
- 选型快照：约 32.2k Star，Apache-2.0。
- 采用范围：`packages/desktop/src/renderer/pages/conversation/Messages/anchorRail/` 的锚点数据、固定节距 geometry、磁吸 hover 和键盘跳转语义。
- 改动：不复制 Electron/Arco/CSS Modules 或全历史数据库读取；只将最小算法改写为 Expo/React Native Web，并接到现有 inverted `FlatList`。采用文件保留 Apache-2.0 SPDX、原始版权和修改说明。
- 许可副本：`apps/client/LICENSE-AIONUI-APACHE-2.0`；上游仓库没有额外 `NOTICE` 文件。

## 更新原则

- 上游更新不是日常任务；只有兼容验证或实现需要时才更新。
- 研究结论写入 `docs/RESEARCH.md`，架构决定写入 `docs/ARCHITECTURE.md`，工作状态写入 `docs/PROGRESS.md`。
- 不从上游复制登录凭据、构建缓存、`node_modules`、日志或本机配置。
