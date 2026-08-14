---
name: Pi Markdown
description: Describe when the agent should follow this skill.
---

# Pi Markdown

本地 Markdown 笔记应用（PI-Desktop 插件 `pi.markdown`）。

## When to use

用户提到本插件的笔记、Markdown 编辑、大纲、导出等功能时使用。

## How to use

- 数据：权威数据位于插件数据目录
  `~/.pi-desktop/plugins/data/pi.markdown/settings.json`，
  结构为 `{ tree, activeNoteId, theme, updatedAt }`（`theme` 为 `'light'|'dark'`）。
  `tree` 为混合树：`{ id, type:'folder', name, children[] }` 与
  `{ id, type:'note', title, content, updatedAt }`（图片为 data URL 内嵌）。
- 面板：`renderer/index.html`（esbuild 构建产物）。编辑器为 Milkdown Crepe——
  单栏所见即所得 Markdown：输入 `# `、`- [ ]`、`> `、`$…$` 等语法即时成样式，
  `/` 斜杠菜单插块；图片经 ImageBlock onUpload 转 data URL 内嵌正文。
- 通道：面板 → 主进程走 `pluginBridge.invoke("skill.setEnabled", { id: "note.sync", tree, activeId, theme })`，
  主进程 `onPanelInvoke` 归一化后落盘；`store.path` 返回数据目录。
