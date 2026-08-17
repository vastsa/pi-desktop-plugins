# 便签 · Sticky Notes

Markdown 桌面便签插件：多便签管理、实时预览、任务列表勾选、荧光笔高亮、图片粘贴与回收站。
Sticky notes with live Markdown preview, task checkboxes, text highlights, image paste and a recycle bin.

## 功能

- **多便签管理**：列表卡片（标题/摘要/时间）、搜索、新建、复制
- **Markdown**：预览为主，双击进入编辑，`Esc` / `Ctrl+E` 切换
- **任务列表**：GFM `- [ ]` / `- [x]`，预览中可直接勾选
- **荧光笔高亮**：选中文字右键标记颜色，语法 `==颜色:文本==`，6 色 + 取消
- **图片**：预览/编辑均可 `Ctrl+V` 或拖入；大图自动压缩后以内联 data URL 保存
- **回收站**：删除为软删除，可恢复、单条永久清除或清空

## 使用

1. 安装插件后，在命令面板输入「便签」→ **便签：打开面板**
2. 或直接在 AI 对话中让 Agent 帮你记录：`创建一条便签，内容是……`

## 权限

| 权限 | 用途 |
|------|------|
| `ui.panel` | 打开便签面板 |
| `agent.tool.register` | 向 AI 暴露 8 个便签工具（`plugin_bianqian_*`） |
| `agent.prompt.inject` | 加载便签使用说明技能 |
| `shell.openExternal` | 点击便签内链接时用系统浏览器打开 |

数据仅保存在插件自己的 settings 中，不访问工作区，不发起网络请求。

## 快捷键

| 快捷键 | 作用 |
|--------|------|
| `Ctrl+E` | 编辑 / 预览切换 |
| `Esc` | 编辑 → 预览 |
| `Ctrl+N` | 新建便签 |
| 双击内容区 | 进入编辑 |
| 选中文本右键 | 标记荧光笔颜色 |
| `Ctrl+V` / 拖入 | 插入图片 |

## 开发

```bash
# 1) 构建面板（Vue3 + Vite → renderer/assets/ 单文件 IIFE 包）
cd dev && npm install && npm run build

# 2) 打包 + 重建目录
cd .. && python3 ../scripts/pack_plugin.py plugins/pi.bianqian
python3 ../scripts/rebuild_catalog.py
```

> `dev/` 是构建源（含 node_modules 构建依赖），`renderer/assets/` 是提交入库的产物；
> 打包脚本只排除 `.git/node_modules/.DS_Store`，`dev/` 源码会随包分发但不执行。
