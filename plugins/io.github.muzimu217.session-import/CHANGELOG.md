# Changelog — Universal Session Import

All notable changes to this plugin are documented here. Versions follow
semver; the plugin id is `io.github.muzimu217.session-import`.

## 0.4.1 — 2026-09-09

- 补齐市场元数据以符合官方仓 CONTRIBUTING 的推荐字段：新增 `i18n`（en / zh-CN 双语的
  name、description、safetyNotes）、`categories`、`changelog`、`safetyNotes`。
- `engines.piDesktop` 由 `>=0.14.0` 上调为 `>=0.14.3`，与官方仓内同类社区插件一致
  （宿主实测版本 0.14.6-rc.3）。
- 无功能变更。

## 0.4.0 — 2026-09-09

- 新增**会话熔炉**（`views/forge.html`，工作面板视图 `session-forge`）：
  读回本插件导入过的会话，用宿主 `pi.agent.complete` 把它们蒸馏成项目约定、
  已验证做法、反复出现的坑，一键写入工作区（默认 `AGENTS.md`）。
- 新增 `lib/forge.js`：语料预算裁剪（均摊 + 单会话 200k 字符上限保护）、
  ADR 0174 限速保护（8 次 / 60 秒滚动窗口）、补全返回形状兼容。
- 新增宿主能力自检 `forge.capabilities`，缺能力时给出明确提示而非静默失败。
- **`contributes.sessionSources` 修正为对象数组**：此前写的字符串数组被
  `pi-plugin check` 拒绝。正确形状为 `{ id, label? }`，`id` 须匹配
  `^[a-zA-Z][a-zA-Z0-9._-]{0,63}$`（见 `packages/plugin-sdk/src/index.ts`）。
- 权限收敛：移除未使用的 `fs.read`，仅保留蒸馏落盘需要的 `fs.write`
  （范围 `AGENTS.md`、`*.md`、`docs/**`、`.agents/skills/**`）。
- 架构备注：熔炉必须长在本插件内。`plugin_sessions::list` 的 SQL 为
  `WHERE oi.plugin_id = ?1`，任何插件只能读到自己导入的行，独立插件无法
  读回宿主原生会话。

## 0.1.0 — 2026-09-09

- 首个版本：一体化来源检测与导入。
- 「扫描本机工具」并行探测六个来源并显示各自会话数：
  ZCode / WorkBuddy / Claude Code / Codex / OpenCode / Pi。
- 选择来源后按项目分组列出会话，支持搜索、整组全选、会话预览
  （用户 / 助手 / 工具调用，含参数与结果，错误标红）。
- 「导入为会话」经宿主 `session.import` 桥接把勾选会话写入 PI-Desktop
  会话库：按会话原始工作目录自动建项目、左侧即刻展开可见、
  幂等 id（`import-<source>-<externalId>`）重复导入自动跳过。
- 来源实现来源：ZCode / WorkBuddy 适配器沿用本仓库两个单体插件的已验证逻辑；
  Claude Code / Codex / OpenCode / Pi 移植自 PI-Desktop 内置导入器。
- 官方 `pi-plugin check` 通过。

## 0.2.0 — 2026-09-09

- 来源会话列表新增**可折叠手风琴**：点击项目标题栏（箭头 + 项目名 + 会话数）
  展开或收起该项目下的会话；「全选该项目」按钮阻止事件冒泡，不会触发展开/收起。
- 动效：箭头展开时顺时针平滑旋转 90°；列表区域以高度 + 透明度过渡展开收起
  （CSS grid-template-rows 过渡，Chromium 原生支持，无额外依赖）。
- 默认全部展开；用户的展开/折叠偏好通过面板 localStorage 持久化，
  重开面板后保持。

## 0.3.0 — 2026-09-09（待官方 a7e466fa 推送后实测发布）

- **适配官方会话 API（[PI-Desktop#169](https://github.com/vastsa/PI-Desktop/issues/169) P0/P1）**：
  导入路径改为双通道——
  - 宿主提供 `pi.session.importBatch` 时走**官方契约**：
    manifest 声明 `contributes.sessionSources`（六来源）与 `session.import` 权限；
    批量导入（契约上限 100 会话/批自动分批、mode: skip）、幂等键
    `(pluginId, source, externalId)`、host 生成 id。
  - 旧宿主回退到本地 dev 构建的 `session.import` 桥接（行为与 0.2.0 相同）。
- **契约校验护栏**（转换输出 → `PluginSessionMessage`）：
  严格 RFC3339 时间戳；`createdAt ≤ updatedAt`；消息时间单调不减（越界钳制）；
  title ≤ 200 字符、externalId ≤ 256 字符；单条 content ≤ 512 KiB；
  toolArgs/toolResult 序列化 ≤ 256 KiB、JSON 深度 ≤ 8（超深自动降级为字符串）。
- 导入结果反馈细化：imported / skipped / failed 分开统计并逐条展示失败原因。
- 注：官方契约中导入会话默认不绑定项目/provider/model（`project_id` NULL，
  历史值存 origin 侧车）；侧栏呈现方案见我们在 #169 的反馈建议。

## 0.3.0-real-UI 验证记录（2026-09-09）

在宿主 `feat/zcode-session-import` 分支（含 c34c7927 桥接补丁）上通过 CDP 真实鼠标交互完成端到端验证（截图见 docs/e2e-*.png）：

- 面板扫描：ZCode 66 / WorkBuddy 126 / Claude Code 62 / Codex 767
- 幂等跳过：重复导入已导入会话 → “已导入 0 个（跳过 1 个重复/不可读）”
- 新导入：ZCode《MCP跨平台打包工具项目评估》→ “已导入 1 个会话（跳过 0）”
- **侧栏即时可见**：`sessionsChanged` 桥接生效，侧栏立即出现 ForgeKit 项目分组与新会话（对照：在无桥接的分支上导入成功但侧栏不刷新）
- 点开会话：消息完整渲染（markdown / 代码段正常）
