# 剪贴板历史（Clipboard History）

PI-Desktop 插件：在 PI-Desktop 运行期间持续记录剪贴板文本，保留 30 天历史，一键恢复任意条目。

## 功能

- 面板窗口：通过命令「Clipboard History: Open Panel」打开历史面板
- 后台 watcher 采集：轮询剪贴板，自动记录复制过的文本；同一内容重复复制只刷新时间戳，不产生重复条目
- 按天归档，按日期分组查看历史
- 一键复制恢复任意历史条目（恢复后不会导致该条目时间戳被立即刷新产生抖动）
- 暂停开关：临时停止捕获（面板关闭时自动暂停）
- 轮询间隔可调：1000–10000 ms，默认 2000 ms
- 单条上限 100 KB、单日上限 5 MB，超出自动丢弃最旧条目
- 自动保留最近 30 天，更早的数据在服务启动及跨天时清除

## 隐私与安全

- 数据以**明文 JSONL** 存储在本地磁盘，不经过任何网络传输
- 密码管理器、敏感输入框复制的内容也会被如实记录——请善用**暂停开关**与**单条删除 / 一键清空**来缓解
- 插件只声明 `clipboard.read` / `clipboard.write` 等必要权限；**卸载插件即清除全部数据**

## 存储位置

```
~/.pi-desktop/plugins/data/pi.clipboard-history/history/YYYY-MM-DD.jsonl
```

- 每天一个文件，每行一条记录：`{ id, text, hash, capturedAt, truncated }`
- 卸载插件时数据目录一并删除

## 设置

`settings.json`（`~/.pi-desktop/plugins/data/pi.clipboard-history/settings.json`）：

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `paused` | boolean | `false` | 暂停捕获 |
| `pollIntervalMs` | number | `2000` | 轮询间隔，范围 1000–10000 |

## 构建

```bash
pnpm pi-plugin check .
pnpm pi-plugin pack .
```

## 开发

1. 打开 PI-Desktop 的 **Plugins** 页面
2. 点击 **Load development plugin**，选择本目录
3. 修改 `main.js` / `lib/` 保存后自动重载
4. 通过命令面板（Command Palette）运行「Clipboard History: Open Panel」，或在插件列表中打开面板

## 权限

| 权限 | 用途 |
| --- | --- |
| `ui.panel` | 注册面板窗口与打开命令 |
| `clipboard.read` | 轮询读取剪贴板文本 |
| `clipboard.write` | 一键恢复条目时写回剪贴板 |
| `background.service` | 声明后台 watcher 服务（常驻捕获） |

## 设计说明

- 平台没有剪贴板变更事件，因此采用**轮询 + sha256 哈希去重**
- 重复复制同一内容仅刷新该条目时间戳，不新增记录
- 单条超过 100 KB 截断保存（不切断多字节字符），截断后无法取回全文
- 单日文件超过 5 MB 时丢弃该日最旧条目
- 滚动保留 30 天；历史通过面板窗口查看（命令「Clipboard History: Open Panel」打开），面板关闭时暂停捕获
