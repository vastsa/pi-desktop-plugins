# Parchment Theme / 羊皮纸主题

A warm parchment global theme for PI-Desktop: cream paper background with a faint 22px grid, solid ink user bubbles, soft paper assistant cards, and monospace meta lines. Styling only — no features.

PI-Desktop 全局主题插件：米色纸面背景配淡网格、实心墨色用户气泡、纸色助手卡片、等宽字体元信息行。纯样式，无额外功能。

## What it does / 功能

- One global theme, selectable in **Settings → Theme → search "Parchment" / 设置 → 主题 → 搜索 "Parchment"**.
- Built entirely on the host design tokens (`--ds-*`), so it layers cleanly on top of the light base and never touches dark-mode internals.
- User messages render as solid ink bubbles with paper-colored text; assistant messages as soft paper cards; code blocks, tables and selection tint follow the warm palette.
- Message cards and the composer are width-aligned in both sidebar layouts (tracks the host `--chat-composer-max-width` variable).
- 覆盖宿主设计令牌（`--ds-*`）实现，基于浅色基底叠加，不改动暗色内部；用户消息为实心墨色气泡，助手消息为纸色卡片；代码块、表格、选区同步暖色调；消息卡片与底部输入框在两种侧边栏布局下宽度对齐。

## Reverting / 恢复

Pick Light / Dark / System in the theme picker — the plugin can stay installed without effect. Or uninstall the plugin.

在主题选择器中切回浅色 / 深色 / 系统即可；插件保留也无副作用，或直接卸载。

## Permissions / 权限

| Permission | Why / 原因 |
|---|---|
| `ui.panel` | Small info panel describing the theme / 主题说明面板 |
| `ui.theme` | Contribute the global theme / 贡献全局主题 |

## Safety / 安全

CSS is sanitized by the host on load (size limit, no `@import`, no markup, no scripts, no external URLs). The plugin makes no network requests and stores no data.

CSS 由宿主在加载时净化（字节上限、禁止 `@import`/标记/脚本/外部 URL）。插件不发起任何网络请求，不存储数据。
