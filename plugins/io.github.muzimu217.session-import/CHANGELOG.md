# Changelog — Universal Session Import

All notable changes to this plugin are documented here. Versions follow
semver; the plugin id is `io.github.muzimu217.session-import`.

## 0.4.7 — 2026-09-11（可扩展来源）

- **新增声明式格式驱动层**：`jsonl-transcript` / `sqlite-session` / `json-tree`
  三个 driver 覆盖三类磁盘格式（一行一条 JSON 的 transcript、`session → message → part`
  的 SQLite、单文件即一会话的 JSON 树）。新增一个来源从"写一个 .js 适配器"变成"写一份配置"。
- **用户可自定义来源**：工作区 `docs/session-import-sources.json`（`docs/**` 已在插件
  `fs.read` 范围内，无需新增权限），面板「自定义来源 → 重新加载」热加载，带 `自定义` 标签。
  - **安全边界**：配置只接受**纯数据**。任意层级出现 `eval` / `code` / `require` /
    `transform` / `script` 等键即拒绝；数据根目录拒绝 `/` 与整个 home。插件对用户主目录有
    读权限，允许配置携带代码等同于任意代码执行，因此这里**永不执行**配置里的任何代码。
  - 字段说明与三个可直接复制的示例见 `docs/CUSTOM-SOURCES.md`。
- **驱动层已用真实数据逐条比对校验**（`tools/validate-drivers-real.cjs`）：
  同一份本机数据上，声明式 spec 与手写适配器并行跑，比对完整消息序列。
  **1693 个会话逐字节一致** —— Claude 61/61、Codex 774/774、WorkBuddy 159/159、
  ZCode 70/70、OpenCode 629/629。
  - 校验中修掉 7 个合成 fixture 测不出的缺陷：两阶段工具调用的三种形状（条目级
    `function_call`→`function_call_result`、块级 `tool_use`→`tool_result` 按 id 配对）、
    ZCode 的 `sequence` 排序列、Codex 条目 id 顶替会话 id、事件信封解包、注入文本剥离、
    外部化输出回读、结果字段的 trim / 序列化口径。
  - 有意保留的差异：超出读取预算（默认单文件 32 MB / 20000 行）的文件，以及一条可导入
    消息都没有的 transcript。
- 包含 **0.4.6 健壮性加固**（看门狗超时、按 `externalId` 去重并标记 `oversized`、契约截断
  显式回传 `truncated`）与 **0.4.5**（OpenCode v1.x SQLite 存储修复）。

## 0.4.4 — 2026-09-10

- **修复：`导入失败：toolResult exceeds 256 KiB`（整批被拒）**。
  根因是**字节口径不一致**：宿主校验的是
  `TextEncoder().encode(JSON.stringify(field)).byteLength`（**序列化后**字节），
  而插件此前全部按**原始字符串**字节截断。JSON 转义会让引号/换行/反斜杠
  密集的文本膨胀最多约 **44%**（实测 250000 原始字节 → 361113 序列化字节），
  因此一条按 256 KiB 原始截断的字段序列化后仍可达 ~365 KiB，单条超限
  即导致**整批**被拒绝。
  - 真实数据命中：某 WorkBuddy 会话的 `toolResult`（一段 grep 输出）
    原始 406 KB，按旧逻辑截断后仍有 289 KB，依旧超限。
  - 修法：新增 `serializedBytes()` / `truncateToSerializedBytes()`，
    `content`（512 KiB）与 `toolArgs` / `toolResult`（256 KiB）一律按
    **序列化后**字节做预算；另加 `enforceContractLimits()` 兜底，在发出前
    按宿主的口径逐字段复测并硬夹紧——**一条脏数据绝不能让用户丢掉整批**。
  - 新增回归测试（引号/换行密集的超限样例）：旧代码报
    `content ... got 747522`，新代码通过。真机复测：此前必失败的
    652 条消息 WorkBuddy 会话现产出 5.3 MB 载荷、**0 项契约违规**；
    四来源 80 条会话全部通过，最差字段恰好落在 255 KiB / 406 KiB。

- **性能：扫描阶段大幅提速**（此前面板首屏等待 20s+，实测瓶颈不在导入
  而在扫描）：
  - **Codex**：`~/.codex/sessions` 常有数百个多 MB 的 rollout
    （实测 864 文件 / 2.6 GB / 58.3 万行），旧逻辑对每个文件
    `readFile` + 全行 `JSON.parse`。现改为**流式读取 + 提前中止**，
    只读到「会话 id + cwd + 首条真实用户消息」即停（55 MB 的文件只读
    约 0.2% 字节）；并新增 `scanFast()` 快速首屏（近 14 天窗口，
    0.43 s 出结果），全量扫描在后台补齐。
  - **WorkBuddy**：`summarizeFile()` 流式替代 `readFile` + `split`
    （列表行需要文件尾部的 ai-title 与最后时间戳，无法提前中止，
    收益体现在内存与分配开销），并改为跨文件并发。
  - **Claude Code**：流式扫描（上一提交已落地）。
  - 后台全量扫描改为**排队**，只在所有前台扫描结束后启动——实测若并发，
    Codex 的 2.6 GB 后台扫描会把同时进行的 WorkBuddy 扫描从 1.7 s
    拖慢到 9.5 s。
  - 效果：六来源并行首屏 **2.6 s** 全部就绪；Codex 首屏 **0.43 s**，
    后台约 10 s 补齐全量 776 条。

## 0.4.3 — 2026-09-10

- **修复：导入的会话在左侧项目列表不可见**。宿主侧栏语义（对照 v0.14.1 与
  最新 main 逐字一致）：侧栏项目组只由「用户打开过的项目 tab +
  当前工作区」创建；绑定了 projectId 的会话若其项目没有打开的 tab，
  则**在侧栏任何位置都不可见**（只能去「项目」索引页找）。上一版
  （0.4.2 引入的自动 project.create 绑定）因此把导入会话"藏"了起来。
  现在：
  - **默认归组到项目**（勾选项记忆用户选择）：按 projectPath 调
    `project.create` 幂等解析 projectId 并随会话传入；配合宿主侧补丁
    （dev 仓 feat/plugin-import-project-tabs 分支，源自当年
    feat/zcode-session-import 的 c34c7927 移植到官方 importBatch 通道）
    导入完成后宿主自动把接收项目加入侧栏项目 tab 并展开——会话即时
    出现在左侧「项目」列表；
  - 取消勾选则导入到独立会话列表（无需宿主补丁，立即可见）；
  - 导入完成提示按两种落点分别说明在哪里查看。
- **补报 `notify` 权限**：manifest 此前未声明 `notify`，导入完成的
  原生通知实际一直在报 `PERMISSION_DENIED`（面板静默吞掉）。已补
  声明，需要用户在宿主中重新授权一次。
- 隔离数据目录实例（`PI_DESKTOP_DATA_DIR` + 9224 CDP）真机验证：
  归组导入 3 条 → `project_id` 绑定 `~/Work/club-web` + 侧栏「项目」
  板块自动出现 club-web 组并展开（截图 docs/）；独立导入 4 条 →
  `project_id` 为空 + 侧栏「会话」列表即时显示。

## 0.4.2（未发布）— 2026-09-10

- **适配官方 `pi.session.importBatch` 正式版**（vastsa/PI-Desktop #169，提交
  a7e466fa / 8b9532cf / 15f1a440 已推 origin/main，宿主 schema v14）：
  - 修正工具载荷深度护栏：官方校验器对**整个 batch 输入**计 JSON 深度
    （≤8），`toolArgs` / `toolResult` 在输入中已嵌套 5 层，自身深度预算仅 3。
    超深对象现在降级为字符串，一条脏数据不再污染整批（此前真实数据触发
    `session JSON depth exceeds 8` 整批拒绝）。
  - 逐条预检官方硬校验（title 非空 / externalId 非空），坏条目计为
    unreadable 跳过而非令整批失败；消息数按官方上限 2000 截断。
  - 导入统一走 `import.commit` 单一入口：官方 `importBatch` 优先，运行时
    检测到宿主未接线（`host api not available` / `UNSUPPORTED` / 
    `unknown channel`）自动回退旧 `session.import` 桥接（dev 宿主分支
    feat/zcode-session-import），两者都不可用时给出明确中文指引。
  - `lib/forge.js` 适配官方 `session.list` 的 `{ items }` 返回形状
    （`sessionId` 投影到 `id`，兼容旧 `{ sessions }` 与裸数组）。
- **真实 UI 端到端验证通过**（官方 origin/main 构建宿主 + CDP 驱动真实
  交互）：六来源扫描（ZCode 68 / WorkBuddy 151 / Claude Code 62 / Codex
  700+）→ 勾选 2 条 ZCode 会话 → `importBatch` 导入成功 →
  `session_import_origins` 幂等键落库 → 侧栏即时刷新可见 → 点开会话完整
  渲染；重复导入幂等跳过（已导入 0，跳过 2 重复）。证据截图
  `docs/e2e-v04-*.png`。
- 修复 dev 注册表权限滞后问题：宿主启动恢复插件沿用 registry 记录的权限
  而非 manifest，需同步更新（`session.import` 等新权限方能放行）。

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
