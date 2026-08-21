# Pi Markdown

本地 Markdown 笔记应用（PI-Desktop 插件）。面板由 React + TypeScript + Tailwind 构建，编辑器为 **Milkdown Crepe**（真·所见即所得 Markdown，Typora 风格）。界面语言（中文/English）与主题默认跟随宿主。

## 功能

- **编辑体验**：单栏所见即所得 Markdown 编辑——输入 `# ` 即出标题、`- [ ]` 即出任务、`> ` 即出引用、```` ``` ```` 即出代码块（```` ```mermaid ```` 即出 Mermaid 图表）、`$…$` / `$$…$$` 即出公式；`/` 唤起斜杠菜单（标题/列表/任务/表格/图片/代码块/公式）；编辑区不显示块左侧的添加/拖拽手柄，块级公式与代码块内容左对齐（不居中）；自动保存（800ms 防抖写盘）。
- **语言**：跟随宿主界面语言（`pi.app.getLocale()`，中文 / English）——命令标题、面板标题、菜单、弹窗、状态栏、斜杠菜单等全部文案随语言切换；`manifest.ui.title` 声明双语标题由宿主解析。
- **双主题**：米白 / 黑夜两套主题。**默认跟随宿主主题**（面板读取宿主注入的 `pi-plugin-panel-titlebar[data-theme]`）；状态栏太阳/月亮按钮切换后为手动覆盖（`themeSource: 'manual'`），偏好随 settings.json 持久化。
- **5 级目录**：左侧「笔记」标签为可嵌套文件夹树（层级不限，满足 5 级），「大纲」标签为当前笔记 H1–H5 五级标题，点击跳转、滚动联动高亮。
- **代码 / Todo / 公式 / 图表**：代码块支持 **297 种语言**语法高亮（refractor/Prism 全量语言，随包离线加载）；```` ```mermaid ```` 代码块实时渲染 **Mermaid 图表**（随明暗主题切换，HTML/PNG 导出内嵌 SVG）；任务列表 `- [ ]` / `- [x]` 编辑区直接勾选；KaTeX 公式（行内 `$...$`、块级 `$$...$$`，编辑与导出均渲染）。
- **导出**：Markdown 文件、自包含 HTML 文件（内嵌样式与字体）、PNG 图像（html2canvas）。导出由 Markdown 源码经编辑器 parser/serializer 渲染，块级公式转 KaTeX、Mermaid 图表转内嵌 SVG、代码块重新高亮，不依赖编辑器可视区域。
- **全局搜索**：侧边栏搜索框实时匹配全部笔记的标题与内容（防抖 300ms，标题命中优先，附上下文片段）。
- **侧边栏管理**：文件夹 / 笔记拖拽调整位置（插入线指示，禁止拖入自身后代）；右键菜单：新建笔记 / 新建子文件夹 / 重命名 / 删除 / 导出；顶部标题栏左侧按钮一键收起/展开侧边栏（收起后编辑区占满宽度）。
- **Agent 工具 open_file**：Agent 传入绝对路径即可在面板单文件模式中打开该 Markdown/纯文本文件编辑（隐藏笔记列表、不显示文档列表），编辑经 800ms 防抖自动保存写回原文件（保留原 BOM）。仅支持 `.md/.markdown/.txt`、≤5MB、utf8 文本。

## 存储位置

- 权威数据：插件数据目录 `~/.pi-desktop/plugins/data/local.pi-markdown/settings.json`（`tree` 为笔记树，`theme` + `themeSource` 为主题偏好，图片以 data URL 内嵌于正文，随笔记一并存储与导出）。
- 面板与主进程经宿主限定桥接通道 `skill.setEnabled → onPanelInvoke("note.sync")` 双向同步；无宿主环境（浏览器直接打开 renderer/index.html）自动降级为 localStorage，便于预览调试。
- 首次启动自动创建「欢迎使用 Pi Markdown」示例笔记。

## 外部文件与宿主文件权限网关

`open_file` 的**文件内容读写一律走宿主 `pi.fs` 权限网关**（不再直接使用插件进程 Node fs 读写正文）：

- `manifest.fs` 声明 `read` / `write` 均为 `root: "userSelected"`：首次调用工具时弹出**原生目录选择器**（`pi.fs.requestDirectory()`），用户选定目录后，插件只能读取/写回该目录内的文件。
- 选定的目录仅保存在插件进程内存中（会话级授权，进程退出即失效），下次调用需重新选择。
- 网关负责真实路径/符号链接越界校验、凭据类路径拒绝（`.env`、`.ssh/`、`*.pem` 等）与审计日志；越界/被拒会得到 `INVALID_ARGUMENT` / `PERMISSION_DENIED`。
- 工具内置校验：绝对路径、常规文件、扩展名白名单、≤5MB、utf8 文本（拒绝 NUL 二进制）；写回时按原样还原 BOM。

## 构建

面板源码在 `renderer-src/`（React + TS + Tailwind，**esbuild** 构建——宿主以 `file://` 协议加载面板，module script 会被 Chromium CORS 阻止，故输出 IIFE 单文件 + 静态入口）：

```bash
cd renderer-src
npm install
npm run build     # 生成 src/generated/refractor-imports.ts + 产物 → ../renderer（index.html + assets/app.js + app.css）
npm run typecheck
```

## 开发

1. PI-Desktop → Plugins → Load development plugin，指向本目录（热重载）。
2. 命令面板运行「Pi Markdown：打开笔记」（窗口 1280×800）。
3. 修改 `renderer-src/` 后 `npm run build`；修改 `manifest.json` 权限（如新增 `fs` 作用域）需重新加载插件并重新授予。

## 权限

- `ui.panel`：面板入口
- `agent.prompt.inject`：技能文档索引（`skills/pi-markdown.md`）
- `agent.tool.register`：Agent 工具 `open_file`（高风险，安装时确认）
- `fs.read` / `fs.write`：`open_file` 经宿主文件网关读写用户选定目录（`manifest.fs` 声明 `userSelected` 根，首次调用请用户选定目录）

无网络请求、无工作区文件读写；笔记数据仅存本机插件数据目录；外部文件仅在用户选定目录内经网关访问。
