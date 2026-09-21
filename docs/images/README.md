# README 界面图片

采集日期：2026-09-21。图片均为隔离预览的实际渲染，不连接真实 Gateway、不使用真实任务或账号，也没有通过图像生成模型制作界面。

| 文件 | 画面 | 来源 |
| --- | --- | --- |
| mobile-conversation.png | 模拟任务的流式对话 | 浏览器，393×852 CSS px，2× 像素密度。 |
| mobile-projects.png | 项目与任务抽屉 | 同一浏览器预览，正常控件操作。 |
| mobile-reasoning.png | 推理强度菜单 | 同一浏览器预览，正常控件操作。 |
| mobile-permissions.png | 访问权限菜单 | 同一浏览器预览，正常控件操作。 |
| mobile-devices.png | 分层连接状态 | 本地模拟管理数据。 |
| windows-waiting.png | 等待启动 | 原生 WPF 预览视图，2× 渲染。 |
| windows-ready.png | 服务就绪 | 原生 WPF 预览视图，模拟状态。 |
| windows-pairing.png | 展开的连接手机区域 | 仅 8 个占位圆点，不生成真实配对码。 |

手机入口为 `pnpm mobile-ui:preview`。Windows 入口为 `scripts/windows-ui-preview.ps1`，原生视图自身提供 `RenderTargetBitmap` 渲染，未采集用户桌面或其他窗口。捕获静态画面时可稳定动画相位；图像不能用来证明真实帧率、连接延迟或部署健康。

所有示例任务、设备、模型菜单和 48 ms 状态值均属于预览数据。画面保留现阶段 Codex Plus 过渡名称，不代表已经发布通用安装包。
