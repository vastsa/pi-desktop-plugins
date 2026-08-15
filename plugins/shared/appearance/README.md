# shared/appearance — 外观适配器（规范源）

让插件面板跟随 PI-Desktop app 主体的**语言（locale）**与**颜色模式（theme: light/dark）**，并实时更新。

> 本目录是**规范源，不随插件包发布**。插件是自包含打包、运行时无共享依赖，因此接入时把两个文件**复制**进插件的 `renderer/`。

## 机制

- 宿主通过面板桥提供官方外观通道（PI-Desktop ≥ 0.7.1）：
  - `bridge.invoke("app.getAppearance")` → `{ theme, base, locale, pluginTheme }`
    - `theme`：用户偏好（`light` / `dark` / `system` / `plugin:<pluginId>:<themeId>`）
    - `base`：解析后的亮暗值（`light` / `dark`；`"system"` 仅在无法解析时出现）
    - `locale`：app 语言标签（`zh-CN` / `en` …）
    - `pluginTheme`：当前激活的插件主题 `{ id, base, css }` 或 `null`
  - `bridge.on("appearance:changed", fn)`：app 切换主题/语言时实时推送
- 旧版宿主没有该通道时优雅降级：面板回退到 localStorage 缓存 → 系统偏好（`prefers-color-scheme`）/ 面板自身处理，不报错。

## 文件

| 文件 | 作用 | 加载位置 |
| --- | --- | --- |
| `renderer/appearance-boot.js` | 同步预绘：在首个绘制帧前从 localStorage 回放上次外观（避免闪屏）；无缓存则按系统偏好。设置 `data-theme` / `data-lang` / `lang`，可注入插件主题 CSS。暴露 `window.__appearanceBoot`。 | `<head>` 内、body 之前，**同步** |
| `renderer/appearance.js` | 运行时：`app.getAppearance` 拉取 + `appearance:changed` 订阅，实时重应用，写回 localStorage 缓存。暴露 `window.__appearance`。 | `<body>` 末尾或 `defer`（必须晚于 boot） |

## 接线步骤

1. 复制两个文件到插件 `renderer/`：
   ```bash
   cp plugins/shared/appearance/renderer/appearance-boot.js plugins/<id>/renderer/
   cp plugins/shared/appearance/renderer/appearance.js plugins/<id>/renderer/
   ```
2. `renderer/index.html` 的 `<head>`（其他脚本之前）加：
   ```html
   <script>window.__APPEARANCE_CACHE_KEY = "my.plugin.appearance.v1";</script>
   <script src="./appearance-boot.js"></script>
   ```
   （缓存键可自定义，保持每个插件独立的历史；不设置则用默认 `pi.appearance.v1`。）
3. `<body>` 末尾加载并启动：
   ```html
   <script src="./appearance.js"></script>
   <script>window.__appearance.init(window.pluginBridge);</script>
   ```
4. 面板 CSS 用 `[data-theme="dark"]` / `[data-theme="light"]` 选择器定义双色调色板；文案用 `onLocaleChange` 切换 en/zh 字符串表（或初始化时读 `current().locale`）。

## API（`window.__appearance`）

- `init(bridge)` — 拉取 + 订阅，调用一次
- `current()` — `{ base, locale, raw }`
- `onThemeChange(fn)` — `fn(base)`：`"light"` / `"dark"`
- `onLocaleChange(fn)` — `fn(locale)`：`"zh-CN"` / `"en"` / …
- `setThemeOverride(base|null)` — 面板内手动强制 `"light"`/`"dark"`；传 `null` 恢复跟随 app
- `apply(entry)` — 手动应用一份外观数据（调试用）

## 约定

- 渲染端一律通过 `data-theme`（`light|dark`）与 `lang` 属性反映外观；CSS 选择器用 `[data-theme="dark"]`。
- 主题 override 只在**面板内**生效（`state.themeOverride`），不写回宿主；`setThemeOverride(null)` 后恢复跟随。
- 缓存写入是 best-effort，localStorage 不可用时静默跳过。
- 插件主题 CSS 注入到 `<style id="pi-appearance-theme-css">`，仅在跟随 app 且宿主激活了插件主题时注入。
