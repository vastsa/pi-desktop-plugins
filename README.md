# PI-Desktop Plugins

Official plugin marketplace repository for [PI-Desktop](https://github.com/vastsa/PI-Desktop).

PI-Desktop 是一个现代化、AI 驱动的桌面环境，本仓库是其**官方插件市场仓库**，包含插件源码、可安装的 `.piplug` 包以及市场目录索引。

## 📦 仓库内容

| 路径 | 说明 |
|------|------|
| `catalog.json` | 市场目录索引，由 PI-Desktop 客户端读取，展示可安装的插件列表 |
| `packages/*.piplug` | 打包好的插件安装包，用户安装时下载的就是这些文件 |
| `plugins/<id>/` | 插件源码目录，每个插件一个文件夹 |
| `scripts/` | 开发辅助脚本（打包、重建目录等） |

## 🎯 可用插件

### 官方插件（PI-Desktop 团队维护）

| 插件 | 说明 | 作者 |
|------|------|------|
| **pi.todo** | 小清新待办：四象限矩阵 + 简单列表双布局，支持到期提醒与 AI 工具集成 | PI-Desktop |
| **pi.token-insights** | Token 用量分析仪表盘：追踪 PI-Desktop、Claude Code、Codex 等工具的 Token 消耗 | PI-Desktop |
| **pi.ssh-manager** | 本地优先的 SSH 主机管理与 AI 远程命令工具，支持面板临时密码且不持久化凭据 | PI-Desktop |

### 社区插件

| 插件 | 说明 | 作者 |
|------|------|------|
| **pi.scratch-calc** | 草稿计算器：多行演算、历史记录、百分比/乘方/π/e 支持，暗色模式 | Tioit-Wang |
| **pi.super-domain-man** | 超级域名侠：多平台 DNS 记录管理与 SSL 证书监控/申请工具 | Tioit-Wang |

### 示例插件（学习参考）

| 插件 | 说明 |
|------|------|
| **demo.hello** | 最小示例：面板 + 命令 + 工具注册 |
| **demo.workspace-summary** | 实用模板：扫描工作区并生成摘要 |
| **demo.workspace-notes** | 高风险能力演示：文件读写 + 网络请求 |

## 🚀 安装插件

1. 打开 PI-Desktop → **插件**
2. 进入 **市场** 页面
3. 点击 **从仓库刷新** 加载最新目录
4. 浏览并安装插件

## 🛠️ 开发自己的插件

### 快速开始

```bash
# 1) Fork + 克隆仓库
git clone https://github.com/<you>/pi-desktop-plugins.git
cd pi-desktop-plugins

# 2) 复制模板开始开发
cp -R plugins/demo.workspace-summary plugins/my.plugin-id

# 3) 修改插件内容
#    - 更新 manifest.json 中的 id/name/version/description
#    - 实现 main.js 逻辑
#    - 创建 renderer/index.html（可选，用于面板 UI）

# 4) 打包插件
python3 scripts/pack_plugin.py plugins/my.plugin-id

# 5) 重建市场目录
python3 scripts/rebuild_catalog.py

# 6) 在 PI-Desktop 中测试
#    - 使用「加载开发插件」功能
#    - 或直接安装生成的 .piplug 文件
```

### 目录结构

```
plugins/<id>/
├── manifest.json      # 必需：插件元信息
├── main.js            # 必需：插件入口
├── renderer/          # 可选：面板 UI
│   ├── index.html
│   ├── style.css
│   └── script.js
├── README.md          # 推荐：插件说明文档
└── skills/            # 可选：AI Agent 工具定义
```

### manifest.json 关键字段

```json
{
  "schemaVersion": 1,
  "id": "my.plugin-id",
  "name": "My Plugin",
  "version": "0.1.0",
  "description": "插件功能描述",
  "author": "your-name",
  "main": "main.js",
  "categories": ["productivity"],
  "permissions": ["ui.panel"],
  "engines": { "piDesktop": ">=0.2.0" }
}
```

### 常用权限

| 权限 | 用途 |
|------|------|
| `ui.panel` | 打开隔离面板 |
| `fs.read.workspace` | 读取工作区文件 |
| `fs.write.workspace` | 修改工作区文件 |
| `clipboard.read` / `clipboard.write` | 剪贴板读写 |
| `notify` | 本地通知 |
| `net.fetch` | 外部网络请求 |
| `shell.openExternal` | 打开外部链接 |
| `agent.tool.register` | 注册 AI Agent 工具 |

> **提示**：只申请所需的最小权限集。高风险权限会在安装时提示用户确认。

## 📋 贡献流程

1. Fork 本仓库
2. 从示例模板创建你的插件
3. 在 PI-Desktop 中充分测试
4. 提交 Pull Request（确保 `id` 唯一、使用语义化版本号、文档清晰）

详见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 📦 打包约束

- 包根目录必须包含 `manifest.json`
- 不允许符号链接或路径穿越
- 使用 store-compressed zip 格式打包为 `.piplug`
- 最大包体积 50MB
- 不要期望宿主端 `npm install`，请自行打包依赖

## 📄 License

MIT
