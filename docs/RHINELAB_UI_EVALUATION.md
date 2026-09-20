# RhineLabUI 采用评估

2026-09-09。参考 [LBEILC/RhineLabUI](https://github.com/LBEILC/RhineLabUI)，查阅时 main 为 5abab02367465d9189f4ae65bcb6f17fdb5938f7。本轮评估可行性，不视为已经决定替换两端 UI。

用户随后确定：只借鉴动效，保留本项目现有配色，暂时只做 Windows 端；先交付预想图。下文关于暖灰配色、安卓适配和三维展示的建议不进入这一轮实施范围。

进一步反馈允许原创的小型 3D 装饰，已增加悬浮核心的概念预览；这不等于采用上游三维档案应用或其模型素材。

该机械核心随后被用户否定。当前采用方向回到界面自身的薄层空间与微交互，重点是断开/扣合的锁链标志，以及用户指定的等待黄色、连接蓝色；不将上一版核心模型作为已批准设计。

隔离预览评审继续扩大到容器形式：用户否定厚重圆角大卡片，允许重组卡片概念。当前设计转译是可分合的原创半透明连接薄片、无外框状态排版与下方抽取信息；只借鉴上游空间构图、细线和信息揭示，不复制其模型。2026-09-09 再次读取当前 DESIGN.md/style.css/README；浏览器在线页和静态图入口仍超时，方案由可读取的设计规范与源码支持，未将其描述为现场视觉或性能验收。

## 结论

可以作为视觉与部分实现的来源。它是原生 DOM / TypeScript + Three.js + Vite 的完整应用，没有现成 React/WPF 组件接口；本项目应适配选定的表现层，并保留真实 CodexServeClient 数据与动作。[依赖声明](https://github.com/LBEILC/RhineLabUI/blob/main/package.json)、[页面实现](https://github.com/LBEILC/RhineLabUI/blob/main/src/main.ts)。

| 本项目平台 | 适合的采用方式 | 接入边界 |
| --- | --- | --- |
| 安卓浏览器 / React | 重做配色、字阶、边框、导航、状态呈现和短过渡；按需移植独立动画代码 | 重新组织为 React 组件，不让原应用的全局 DOM 状态接管任务/消息 |
| Windows / WPF | 用 XAML 样式、模板及原生矢量实现同一视觉语言 | 继续只有本机服务启停、连接手机和必要状态；无需为换肤加入 WebView/Three.js |
| Docker Gateway | 继续分发构建后的 Web 静态资源 | 不增加新的业务服务，不改变 Owner/E2EE/Relay |

## 建议保留的设计价值

- 暖灰白、深色文字、小面积暖金强调，配合细线、编号与明确字阶；也可转译为中性石墨深色主题。沿用用户对顺滑圆角、清晰文字的要求，具体色板仍属于下一次设计选择。[样式](https://github.com/LBEILC/RhineLabUI/blob/main/src/style.css)。
- 过渡支持中途反向和取消，并处理减少动态效果；适合任务切换、抽屉和模型菜单，移植到 React 时须绑定组件生命周期与清理。[过渡实现](https://github.com/LBEILC/RhineLabUI/blob/main/src/ui-transitions.ts)。
- 最新代码包含竖屏/紧凑布局、触控手势、安全区与软键盘可视区域处理，不能依据较早的桌面说明认定它不支持手机；仍需针对聊天长文本和输入框重新验收。[视口算法](https://github.com/LBEILC/RhineLabUI/blob/main/src/viewport-layout.ts)、[响应式样式](https://github.com/LBEILC/RhineLabUI/blob/main/src/responsive.css)。

三维阵列适合作为可选的项目展示或品牌展示；聊天正文、发送和服务启停应直接可达，不要求完成抽取/解密过场。GLB、实时材质和字体会引入额外加载/渲染成本，是否影响具体安卓设备尚未实测。其演示授权画面不能替代本项目真实登录、设备授权或在线状态。

## 许可与发布

作者有权授权的代码和技术文档采用 MIT，复用时保留版权声明与许可证。[LICENSE](https://github.com/LBEILC/RhineLabUI/blob/main/LICENSE)。

仓库另明确区分素材权利：游戏相关名称/标志、模型和图像等未自动获得同样授权，字体、滚动文字依赖及部分音效另有说明。Codex Plus 使用自己的品牌与素材，不能将整个仓库素材包按 MIT 一并发布。[上游许可与资源说明](https://github.com/LBEILC/RhineLabUI#开源许可)。

## 本轮验证

最新用户评审否定当前工业轨道背景实现；该版本不能作为已获认可的风格基线。已撤掉轨道/刻度/扫描点，背景改为大尺度无描边空间层与柔光；继续保留已认可的前景玻璃、开放布局和默认 60 FPS。这是对当前实现的纠正，不推断用户否定所有工业设计。

2026-09-10 风格收敛：用户要求参考明日方舟或终末地。已访问[明日方舟官网](https://ak.hypergryph.com/)及[终末地官网](https://endfield.gryphline.com/en-us)；前者可读取编号/分隔与信息层次，后者本次无可读正文，国内站超时。没有将不可读页面当作已完成视觉分析。结合已读 RhineLabUI 规范，原创实现分段工程轨道、短圆弧、折角、端帽和局部扫描，保留原配色/布局；不使用游戏标志或界面素材。默认动画目标统一为 60 FPS。

背景方案补充（2026-09-09）：GitHub 页面显示 [React Bits](https://github.com/DavidHDev/react-bits) 约 47.0k 星、[Drei](https://github.com/pmndrs/drei) 约 9.9k、[Vanta](https://github.com/tengbao/vanta) 约 7.0k。查看 [Silk](https://github.com/DavidHDev/react-bits/blob/main/src/content/Backgrounds/Silk/Silk.jsx) 的光泽调制、[Waves](https://github.com/tengbao/vanta/blob/master/src/vanta.waves.js) 的动态网格与 [Float](https://github.com/pmndrs/drei/blob/master/src/core/Float.tsx) 的缓慢位移。当前选择原创双层三维光带和轮廓，控制文字后的强度并响应连接状态。只借鉴通用方法，无代码/素材引入；React Bits 标明 MIT + Commons Clause，不能将其与普通 MIT 混同。星数是查阅时页面约数，不作为性能或质量证明。

进一步转译：[decryption.ts](https://github.com/LBEILC/RhineLabUI/blob/main/src/decryption.ts) 用统一阶段和清晰进度控制玻璃，[document-decryption.ts](https://github.com/LBEILC/RhineLabUI/blob/main/src/document-decryption.ts) 随这一进度揭示正文；[archive-lighting.ts](https://github.com/LBEILC/RhineLabUI/blob/main/src/archive-lighting.ts) 统一环境、主/补光与曝光，[scene.ts](https://github.com/LBEILC/RhineLabUI/blob/main/src/scene.ts) 配置粗糙度/透射。当前预览据此改善合成受光、同步扫描和配对时的实体抽取，不复制其数秒长的档案流程、模型或实现代码；WPF 仍只做局部光学近似。

2026-09-09 玻璃细节补充调研：参考 [LiquidGlassKit](https://github.com/DnV1eX/LiquidGlassKit) 的 [Metal 实现](https://github.com/DnV1eX/LiquidGlassKit/blob/master/Sources/LiquidGlassKit/LiquidGlassFragment.metal) 对距离场法线、折射、菲涅耳与定向高光的组合，以及 [OverShifted/LiquidGlass](https://github.com/OverShifted/LiquidGlass) 的 OpenGL 方向。[WPF-Liquid-Glass-Effect](https://github.com/dragosniamtu/WPF-Liquid-Glass-Effect) 使用桌面捕获/像素着色器，当前隔离预览不采用这一取样范围。我们独立实现仅作用于自身合成背板的光学近似，复用已有 WPF Viewport3D；没有复制上述项目代码、材质资源或私有 iOS API。

已核对本项目 React/WPF 边界、上游依赖、许可、主页面、样式、响应式与独立过渡代码。在线演示的浏览器工具读取超时，未完成视觉交互或安卓帧率验收；该工具失败不作为网站性能差的证据。没有克隆上游、安装依赖、导入素材、修改产品代码或启动/替换生产服务。

若进入实施，先按用户确定的平台和视觉方向做一个真实页面的离线预览，再扩展；更新 DSH_UI_ADOPTION 的采用边界与对应构建许可检查，不能让新的视觉层改写链路和授权语义。
