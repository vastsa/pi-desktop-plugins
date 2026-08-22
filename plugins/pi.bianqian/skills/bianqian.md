---
name: bianqian-sticky-notes
description: 便签 (Sticky Notes) 插件 — 管理 Markdown 便签：列出、读取、搜索、创建、更新、软删除与恢复。Manage Markdown sticky notes: list, read, search, create, update, soft-delete and restore.
---

# 便签 (Sticky Notes)

便签是 PI-Desktop 的 Markdown 记事插件。所有工具统一前缀为 `plugin_bianqian_`（例如
`plugin_bianqian_list_notes`）。

## 数据布局

- 便签数据保存在插件自己的 settings 中（`plugins/data/pi.bianqian/settings.json`），
  结构：`{ version, rev, notes: [...] }`。
- 每条便签：`{ id, title, content, color, mode, createdAt, updatedAt, deleted }`。
- `title` 由内容自动派生（首个 `# 标题` 或首行文本，最多 40 字符），不要手动维护。
- `color` 白名单：`yellow` / `pink` / `blue` / `green` / `purple` / `gray`。
- `deleted: true` 表示在回收站（软删除），可用 `restore_note` 恢复；`purge_note` 才永久删除。

## 使用建议

- 新建便签默认无内容。有内容时建议用 `create_note` 直接写入 Markdown；标题交给插件派生。
- 更新便签用 `update_note` 传 `content` / `color` / `mode` 即可，`updatedAt` 会自动刷新。
- 便签支持任务列表（`- [ ]` 勾选）与荧光笔高亮语法 `==颜色:文本==`（颜色同上白名单）。
- 图片以 data URL 内联在内容里，不要单独管理附件。
- 删除是软删除：先 `delete_note`，确认不需要后再 `purge_note`。恢复用 `restore_note`。
- 列表结果里的 `snippet` 是摘要，适合展示；完整内容用 `get_note` 取。
