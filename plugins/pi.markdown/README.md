# Pi Markdown 笔记（pi.markdown）

本地 Markdown 笔记应用（PI-Desktop 插件，id: `pi.markdown`），基于 **Milkdown Crepe** 的真·所见即所得 Markdown 编辑器。

## 功能

- **所见即所得编辑**：输入 `# ` 即出标题、`- [ ]` 即出任务、`> ` 即出引用、```` ``` ```` 即出代码块、`$…$` / `$$…$$` 即出公式（Typora 风格）；`/` 斜杠菜单插入块，块左侧拖拽手柄移动/换型；自动保存（800ms 防抖写盘）
- **公式**：KaTeX 行内 `$...$` 与块级 `$$...$$`，编辑区直接显示渲染结果；HTML/PNG 导出同样渲染
- **代码**：297 种语言 Prism 高亮（refractor 全量，随包离线）；代码块预览即所得，可一键切换到编辑
- **双主题**：米白（默认）/ 黑夜，状态栏一键切换，偏好持久化
- **5 级目录与大纲**：左侧可嵌套文件夹树（层级不限）+ 当前笔记 H1–H5 大纲，滚动联动高亮
- **搜索与导出**：全局搜索（标题+内容）；导出 Markdown / 自包含 HTML / PNG 图像
- **侧边栏管理**：文件夹/笔记拖拽排序（禁止拖入自身后代），右键新建/重命名/删除/导出

## 使用

1. PI-Desktop → Plugins → Marketplace → 安装 `pi.markdown`
2. 命令面板运行 **Pi Markdown：打开笔记**（窗口 1280×800）
3. 首次启动自动创建「欢迎使用 Pi Markdown」示例笔记

## 数据与权限

- 数据仅保存在本机插件数据目录 `~/.pi-desktop/plugins/data/pi.markdown/settings.json`（`tree` 为笔记树，`theme` 为主题偏好，图片以 data URL 内嵌于正文）
- 权限：`ui.panel`（面板入口）、`agent.prompt.inject`（技能索引）
- 无网络请求、无工作区文件读写，完全离线可用
