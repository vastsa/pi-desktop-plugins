/**
 * lib/i18n.js — view-side internationalization for Universal Session Import
 * and Session Forge.
 *
 * Single source of truth for every user-facing string. Works two ways:
 *   - Node:  `const { getMessage } = require("./lib/i18n")` (used by tests)
 *   - Browser: loaded via `<script src="../lib/i18n.js"></script>` in the
 *     work-panel views, which attaches `window.SI18n`.
 *
 * getMessage(locale, key, params) resolves `key` from the `locale` table
 * (falling back to zh-CN, then to the key itself), and interpolates
 * `{name}` placeholders from `params`.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.SI18n = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DICT = {
    en: {
      "app.title": "Universal Session Import",
      "importer.heading": "Universal Session Import",
      "importer.hint": "Scan the coding tools installed on this machine, pick a source, then select sessions to import.",
      "importer.scan": "Scan local tools",
      "importer.filter.placeholder": "Search title or project…",
      "importer.selectAll": "Select all",
      "importer.clearAll": "Clear",
      "importer.listbox.label": "Session list",
      "importer.previewEmpty": "Select a session on the left to preview it.",
      "importer.import": "Import as sessions",
      "importer.count.selected": "Selected {selected} / {total}",
      "importer.status.scanning": "Scanning local tools…",
      "importer.status.scanDone": "Scan complete: click a tool above to choose a source",
      "importer.status.loadingList": "Loading session list…",
      "importer.status.loadFailed": "Failed to load: {error}",
      "importer.source.detecting": "Detecting…",
      "importer.source.notFound": "Not found",
      "importer.count.sessions": "{count} sessions",
      "importer.count.scanningMore": "(still scanning…)",
      "importer.group.noProject": "No project",
      "importer.group.selectAll": "Select all in project",
      "importer.group.deselectAll": "Deselect all",
      "importer.preview.noProject": "No project",
      "importer.preview.unknownModel": "Unknown model",
      "importer.preview.Nmessages": "{count} messages",
      "importer.preview.updatedAt": "Updated {date}",
      "importer.status.loadedMessages": "Loaded {count} messages",
      "importer.importing": "Importing {count} sessions…",
      "importer.imported": "Imported {count} sessions",
      "importer.skipped": "Skipped {count} duplicates/unreadable",
      "importer.failed": "{count} failed",
      "importer.importDone.tail": "— visible in the left list immediately",
      "importer.importDone.timing": "in {total}s (read {convert}s · host write {host}s)",
      "importer.importDone.project": "— grouped by project; open the project or check the Projects page to see them",
      "importer.bindProjects": "Group into projects",
      "importer.bindProjects.hint": "Checked: sessions are grouped under their project (visible on the Projects page or once the project tab is open). Unchecked: sessions land in the left session list immediately.",
      "importer.notify.title": "Import complete",
      "importer.notify.body": "Imported {count} sessions via “{source}”. Open Session Forge on the right to start distilling.",
      "importer.legacy.imported": "Imported {imported} sessions (skipped {skipped} duplicates/unreadable) — visible in the left project list immediately",
      "importer.importFailed": "Import failed: {error}",
      "importer.unreadable": "Skipped {count} unreadable",
      "importer.hostHint": "Host does not expose a session-import API (session.import / importBatch). Run the host from a build that wires the import bridge (branch feat/zcode-session-import), or upgrade to an official pi.session.importBatch host.",
      "importer.source.scanTimeout": "Scan timed out",
      "importer.source.scanFailed": "Scan failed",
      "importer.count.oversized": "{count} may be truncated",
      "importer.truncated": "{count} sessions had content truncated",
      "importer.custom.badge": "custom",
      "importer.custom.title": "Custom sources",
      "importer.custom.hint": "Add your own tool by describing it in {path} (declarative JSON — no code is ever executed).",
      "importer.custom.reload": "Reload",
      "importer.custom.count": "{count} loaded",
      "importer.custom.drivers": "Available formats: {drivers}",
      "importer.custom.errors": "Config problems: {errors}",
      "importer.custom.reloaded": "Reloaded custom sources",
      "importer.custom.reloadFailed": "Reload failed: {error}",

      "forge.title": "Session Forge",
      "forge.sub": "Read back the sessions this plugin imported, then distill them into project conventions and reusable practices using the host's quota.",
      "forge.reload": "Reload sessions",
      "forge.selectAll": "Select all",
      "forge.clear": "Clear",
      "forge.model.default": "Default model",
      "forge.goal.placeholder": "Distillation focus (optional), e.g. only deployment & CI issues",
      "forge.distill": "Distill",
      "forge.save": "Save to workspace",
      "forge.banner": "Just imported {count} sessions via Universal Session Import ({ago}).",
      "forge.status.reading": "Reading imported sessions…",
      "forge.count.total": "Total {count}",
      "forge.status.hasSessions": "Imported {count} sessions — select and distill.",
      "forge.status.noSessions": "No imported sessions yet — import some via Universal Session Import first.",
      "forge.status.readFailed": "Failed to read: {error}",
      "forge.session.untitled": "(untitled)",
      "forge.distill.pickOne": "Select at least one session first.",
      "forge.distill.working": "Distilling {count} sessions… (rate-limited to 8/min)",
      "forge.distill.done": "Done.",
      "forge.distill.unreadable": ", {count} sessions could not be read",
      "forge.distill.failed": "Distillation failed: {error}",
      "forge.distill.rateLimited": " (rate-limited, retry in ~{sec}s)",
      "forge.save.written": "Wrote {path} ({bytes} bytes).",
      "forge.save.failed": "Save failed: {error}",
      "forge.saveMode.label": "Save mode",
      "forge.saveMode.overwrite": "Overwrite",
      "forge.saveMode.append": "Append",
      "forge.saveMode.merge": "Merge (marked section)",
      "forge.history.open": "History",
      "forge.history.title": "Distillation history",
      "forge.history.close": "Close",
      "forge.history.empty": "No distillations yet.",
      "forge.history.count": "{count} runs",
      "forge.caps.missing": "Host is missing capabilities: {list}. Upgrade PI-Desktop or re-authorize.",
      "forge.ago.seconds": "{sec}s ago",
      "forge.ago.minutes": "{min}m ago",
    },
    "zh-CN": {
      "app.title": "一体化会话导入",
      "importer.heading": "一体化会话导入",
      "importer.hint": "扫描本机安装的编程工具，选择来源后勾选会话导入",
      "importer.scan": "扫描本机工具",
      "importer.filter.placeholder": "搜索标题或项目…",
      "importer.selectAll": "全选",
      "importer.clearAll": "清除",
      "importer.listbox.label": "会话列表",
      "importer.previewEmpty": "在左侧选择一个会话进行预览",
      "importer.import": "导入为会话",
      "importer.count.selected": "已选 {selected} / {total}",
      "importer.status.scanning": "正在扫描本机工具…",
      "importer.status.scanDone": "扫描完成：点击上方工具选择来源",
      "importer.status.loadingList": "正在载入会话列表…",
      "importer.status.loadFailed": "载入失败：{error}",
      "importer.source.detecting": "检测中…",
      "importer.source.notFound": "未检测到",
      "importer.count.sessions": "{count} 个会话",
      "importer.count.scanningMore": "（仍在扫描…）",
      "importer.group.noProject": "未关联项目",
      "importer.group.selectAll": "全选该项目",
      "importer.group.deselectAll": "取消全选",
      "importer.preview.noProject": "未关联项目",
      "importer.preview.unknownModel": "未知模型",
      "importer.preview.Nmessages": "{count} 条消息",
      "importer.preview.updatedAt": "更新于 {date}",
      "importer.status.loadedMessages": "已载入 {count} 条消息",
      "importer.importing": "正在导入 {count} 个会话…",
      "importer.imported": "已导入 {count} 个会话",
      "importer.skipped": "跳过 {count} 个重复/不可读",
      "importer.failed": "{count} 个失败",
      "importer.importDone.tail": "——左侧会话列表即刻可见",
      "importer.importDone.timing": "耗时 {total}s（读取 {convert}s · 宿主写入 {host}s）",
      "importer.importDone.project": "——已按项目归组；打开对应项目或在「项目」页查看",
      "importer.bindProjects": "归组到项目",
      "importer.bindProjects.hint": "勾选：会话按项目归组（在「项目」页查看，或打开该项目后可见）。不勾选：导入后立即出现在左侧会话列表。",
      "importer.notify.title": "会话导入完成",
      "importer.notify.body": "已通过「{source}」导入 {count} 个会话。点击右侧「会话熔炉」开始蒸馏。",
      "importer.legacy.imported": "已导入 {imported} 个会话（跳过 {skipped} 个重复/不可读）——左侧项目列表即刻可见",
      "importer.importFailed": "导入失败：{error}",
      "importer.unreadable": "跳过 {count} 个不可读",
      "importer.hostHint": "宿主未暴露会话导入接口（session.import / importBatch）。请使用接入了导入桥接的宿主构建（feat/zcode-session-import 分支），或升级到支持官方 pi.session.importBatch 的宿主版本。",
      "importer.source.scanTimeout": "扫描超时",
      "importer.source.scanFailed": "扫描失败",
      "importer.count.oversized": "{count} 个可能截断",
      "importer.truncated": "{count} 个会话内容因过大被截断",
      "importer.custom.badge": "自定义",
      "importer.custom.title": "自定义来源",
      "importer.custom.hint": "在 {path} 中用声明式 JSON 描述你的工具即可新增来源（只读取数据，绝不执行代码）。",
      "importer.custom.reload": "重新加载",
      "importer.custom.count": "已加载 {count} 个",
      "importer.custom.drivers": "可用格式：{drivers}",
      "importer.custom.errors": "配置问题：{errors}",
      "importer.custom.reloaded": "自定义来源已重新加载",
      "importer.custom.reloadFailed": "重新加载失败：{error}",

      "forge.title": "会话熔炉",
      "forge.sub": "读回本插件导入的会话，用宿主额度蒸馏成项目约定与可复用做法。",
      "forge.reload": "刷新会话",
      "forge.selectAll": "全选",
      "forge.clear": "清空",
      "forge.model.default": "默认模型",
      "forge.goal.placeholder": "本次提炼重点（可选），例如：只关注部署与 CI 问题",
      "forge.distill": "蒸馏",
      "forge.save": "保存到工作区",
      "forge.banner": "刚刚在「一体化会话导入」导入了 {count} 个会话（{ago}）。",
      "forge.status.reading": "读取已导入会话…",
      "forge.count.total": "共 {count} 个",
      "forge.status.hasSessions": "已导入 {count} 个会话，勾选后蒸馏。",
      "forge.status.noSessions": "还没有导入过会话 —— 先用「一体化会话导入」导入一批。",
      "forge.status.readFailed": "读取失败：{error}",
      "forge.session.untitled": "(无标题)",
      "forge.distill.pickOne": "先勾选至少一个会话。",
      "forge.distill.working": "正在蒸馏 {count} 个会话…（限速 8 次/分钟）",
      "forge.distill.done": "完成。",
      "forge.distill.unreadable": "，{count} 个会话读取失败",
      "forge.distill.failed": "蒸馏失败：{error}",
      "forge.distill.rateLimited": "（限速，约 {sec} 秒后重试）",
      "forge.save.written": "已写入 {path}（{bytes} 字节）。",
      "forge.save.failed": "保存失败：{error}",
      "forge.saveMode.label": "保存方式",
      "forge.saveMode.overwrite": "覆盖",
      "forge.saveMode.append": "追加",
      "forge.saveMode.merge": "合并（带标记）",
      "forge.history.open": "蒸馏历史",
      "forge.history.title": "蒸馏历史",
      "forge.history.close": "关闭",
      "forge.history.empty": "暂无蒸馏记录。",
      "forge.history.count": "{count} 次",
      "forge.caps.missing": "当前宿主缺少能力：{list}。请升级 PI-Desktop 或重新授权权限。",
      "forge.ago.seconds": "{sec} 秒前",
      "forge.ago.minutes": "{min} 分钟前",
    },
  };

  const DEFAULT_LOCALE = "zh-CN";
  const LOCALES = Object.keys(DICT);

  /** Resolve a key for a locale, falling back to zh-CN then to the key. */
  function resolve(locale, key) {
    const table = DICT[locale];
    if (table && Object.prototype.hasOwnProperty.call(table, key)) return table[key];
    const fallback = DICT[DEFAULT_LOCALE];
    if (fallback && Object.prototype.hasOwnProperty.call(fallback, key)) return fallback[key];
    return key;
  }

  /**
   * Get a localized message.
   * @param {string} locale one of LOCALES (anything else falls back to zh-CN)
   * @param {string} key dictionary key
   * @param {Record<string, string|number>} [params] `{name}` interpolation
   * @returns {string}
   */
  function getMessage(locale, key, params) {
    let text = resolve(locale, key);
    if (params && typeof text === "string") {
      text = text.replace(/\{(\w+)\}/g, (m, p) =>
        Object.prototype.hasOwnProperty.call(params, p) ? String(params[p]) : m,
      );
    }
    return text;
  }

  /** Best-effort locale from the browser/webview navigator. */
  function detectLocale(nav) {
    let navLang = "";
    try {
      const n = nav || (typeof navigator !== "undefined" ? navigator : null);
      navLang = (n && (n.language || (n.languages && n.languages[0]))) || "";
    } catch {
      navLang = "";
    }
    return /^zh/i.test(navLang) ? "zh-CN" : "en";
  }

  return { DICT, LOCALES, DEFAULT_LOCALE, getMessage, detectLocale };
});
