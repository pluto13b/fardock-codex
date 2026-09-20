# Lucide 图标

这些 SVG 来自 [Lucide 官方仓库](https://github.com/lucide-icons/lucide/tree/main/icons)，于 2026-09-07 获取，原样保留源几何。许可见同目录 LICENSE（包含 ISC 与所继承 Feather 图形的 MIT 说明）。

`scripts/build-desktop-view.mjs` 将每个 SVG primitive 转换成 WPF Geometry，保留独立 path 的原点与 24px 视口；MainView.xaml 统一控制颜色、线宽与尺寸。生成的 Geometry 嵌入 EXE，许可证复制到 release。图标不涉及用户数据。
