# 日志查看器 · Log Viewer

PI-Desktop 插件 `pi.log-viewer`：查看超大本地日志文件。

## 做什么

- GB 级文件流式分页打开（虚拟滚动，内存与文件大小无关）
- 实时跟随增长；文件轮转自动重载
- **搜索**：全文高亮 + F3 跳转，不隐藏其它行
- **过滤**：只显示匹配行，或勾选「隐藏匹配」反向；可与 ERROR/WARN/INFO/DEBUG 等级徽章叠加
- 钉住最多 5 行到顶部对比；右键可「清除筛选并跳转」
- 多页签、编码切换（UTF-8 / GBK / GB18030）、明暗主题与等级配色

## 权限

| 权限 | 用途 |
|---|---|
| `ui.panel` | 插件面板 |
| `fs.read`（root: `userSelected`） | 只读打开用户选定的日志（`stat` / `readRange`） |
| `clipboard.write` | 复制整行 / 选中内容 |

不写入文件、不访问网络。目录/拖入/选文件授权仅存内存，进程退出即失效。

## 使用

1. 命令面板执行「日志查看器：打开」
2. 「打开日志」选择 `.log` / `.txt`，或拖入窗口
3. 首次打开会显示示例引导日志（内存虚拟文件）

快捷键：`Ctrl+F` 搜索、`Ctrl+Shift+F` 过滤、`F3` 下一处、`Ctrl+G` 跳行。

## 开发

```bash
node --check main.js
node --test test/log-viewer.test.js
```

## 源码

上游：https://github.com/Tioit-Wang/pi-plugin-log-viewer
