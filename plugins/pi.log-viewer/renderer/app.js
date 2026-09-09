"use strict";

/* Large log viewer — panel UI. All file reads go through the host fs gateway. */

const bridge = window.pluginBridge;
const $ = (id) => document.getElementById(id);

const OVERSCAN = 10;
const MAX_PINS = 5;
const LEVEL_KEYS = ["error", "warn", "info", "debug"];
const DEFAULT_LEVEL_COLORS = {
  // light / dark defaults as hex; applied as CSS RGB triples
  light: {
    error: { bg: "#c93c42", fg: "#c93c42" },
    warn: { bg: "#b45309", fg: "#b45309" },
    info: { bg: "#3d6b8f", fg: "#2e2c29" },
    debug: { bg: "#9b958a", fg: "#6f6a61" },
  },
  dark: {
    error: { bg: "#e5484d", fg: "#e5484d" },
    warn: { bg: "#f0a030", fg: "#f0a030" },
    info: { bg: "#78a0c8", fg: "#f2f2f2" },
    debug: { bg: "#737373", fg: "#a6a6a6" },
  },
};
const state = {
  tabs: [],
  activeId: null,
  nextTabId: 1,
  fontSize: Number(localStorage.getItem("lv.fontSize")) || 12,
  fontFamily: localStorage.getItem("lv.fontFamily") || "default",
  theme: localStorage.getItem("lv.theme") || null, // null → follow host; "light" 米白 / "dark" 黑夜
  levelColors: loadLevelColors(),
};
let rowH = 20;

const SVG_SUN = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const SVG_MOON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/></svg>';

const scroller = $("scroller");
const spacer = $("spacer");

// ---------- small utils ------------------------------------------------------

function fmtSize(n) {
  if (!Number.isFinite(n)) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtTime(ms) {
  if (!Number.isFinite(ms) || !ms) return "";
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

let toastTimer = null;
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2400);
}

function invoke(channel, payload) {
  return bridge.invoke(channel, payload);
}

// ---------- level colors -----------------------------------------------------

function hexToRgbTriple(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

function loadLevelColors() {
  try {
    const raw = localStorage.getItem("lv.levelColors");
    if (!raw) return { light: null, dark: null };
    const parsed = JSON.parse(raw);
    return {
      light: parsed && parsed.light ? parsed.light : null,
      dark: parsed && parsed.dark ? parsed.dark : null,
    };
  } catch {
    return { light: null, dark: null };
  }
}

function saveLevelColors() {
  localStorage.setItem("lv.levelColors", JSON.stringify(state.levelColors));
}

function resolveLevelColors(themeName) {
  const base = DEFAULT_LEVEL_COLORS[themeName] || DEFAULT_LEVEL_COLORS.light;
  const custom = state.levelColors[themeName] || {};
  const out = {};
  for (const lv of LEVEL_KEYS) {
    out[lv] = {
      bg: (custom[lv] && custom[lv].bg) || base[lv].bg,
      fg: (custom[lv] && custom[lv].fg) || base[lv].fg,
    };
  }
  return out;
}

function applyLevelColors(themeName) {
  const colors = resolveLevelColors(themeName);
  const root = document.documentElement;
  for (const lv of LEVEL_KEYS) {
    const bg = hexToRgbTriple(colors[lv].bg);
    const fg = hexToRgbTriple(colors[lv].fg);
    if (bg) root.style.setProperty(`--lv-${lv}-bg`, bg);
    if (fg) root.style.setProperty(`--lv-${lv}-fg`, fg);
  }
}

function openSettings() {
  const themeName = document.documentElement.dataset.theme === "light" ? "light" : "dark";
  const colors = resolveLevelColors(themeName);
  const map = {
    error: ["clrErrorBg", "clrErrorFg"],
    warn: ["clrWarnBg", "clrWarnFg"],
    info: ["clrInfoBg", "clrInfoFg"],
    debug: ["clrDebugBg", "clrDebugFg"],
  };
  for (const lv of LEVEL_KEYS) {
    const [bgId, fgId] = map[lv];
    $(bgId).value = colors[lv].bg;
    $(fgId).value = colors[lv].fg;
  }
  $("settingsHint").textContent = themeName === "light" ? "当前主题：米白" : "当前主题：黑夜";
  $("settingsOverlay").classList.add("show");
}

function closeSettings() {
  $("settingsOverlay").classList.remove("show");
}

function bindSettingsColorInputs() {
  const map = {
    error: ["clrErrorBg", "clrErrorFg"],
    warn: ["clrWarnBg", "clrWarnFg"],
    info: ["clrInfoBg", "clrInfoFg"],
    debug: ["clrDebugBg", "clrDebugFg"],
  };
  const themeName = () => (document.documentElement.dataset.theme === "light" ? "light" : "dark");
  for (const lv of LEVEL_KEYS) {
    const [bgId, fgId] = map[lv];
    $(bgId).addEventListener("input", () => {
      const t = themeName();
      if (!state.levelColors[t]) state.levelColors[t] = {};
      if (!state.levelColors[t][lv]) state.levelColors[t][lv] = {};
      state.levelColors[t][lv].bg = $(bgId).value;
      saveLevelColors();
      applyLevelColors(t);
      const tab = activeTab();
      if (tab) {
        if (hasViewFilter(tab)) {
          tab._fpaintKey = null;
          renderFilteredViewport(tab);
        } else if (tab.window) {
          paintRows(tab, tab.window.lines, { absolute: true });
        }
      }
    });
    $(fgId).addEventListener("input", () => {
      const t = themeName();
      if (!state.levelColors[t]) state.levelColors[t] = {};
      if (!state.levelColors[t][lv]) state.levelColors[t][lv] = {};
      state.levelColors[t][lv].fg = $(fgId).value;
      saveLevelColors();
      applyLevelColors(t);
      const tab = activeTab();
      if (tab) {
        if (hasViewFilter(tab)) {
          tab._fpaintKey = null;
          renderFilteredViewport(tab);
        } else if (tab.window) {
          paintRows(tab, tab.window.lines, { absolute: true });
        }
      }
    });
  }
  $("settingsReset").addEventListener("click", () => {
    const t = themeName();
    state.levelColors[t] = null;
    saveLevelColors();
    applyLevelColors(t);
    openSettings(); // refresh pickers
    const tab = activeTab();
    if (tab) {
      if (hasViewFilter(tab)) {
        tab._fpaintKey = null;
        renderFilteredViewport(tab);
      } else if (tab.window) {
        paintRows(tab, tab.window.lines, { absolute: true });
      }
    }
  });
  $("settingsDone").addEventListener("click", closeSettings);
  $("settingsClose").addEventListener("click", closeSettings);
  $("settingsOverlay").addEventListener("click", (e) => {
    if (e.target === $("settingsOverlay")) closeSettings();
  });
}

function rememberPreFilterScroll(tab) {
  if (!tab || hasViewFilter(tab)) return;
  tab.preFilterLine = Math.max(1, lineAtScroll());
}

/** Leave filtered feed: rebuild spacer at full height, then paint unfiltered window. */
function exitToUnfilteredView(tab) {
  if (!tab) return;
  const target = Math.max(1, tab.preFilterLine || tab.viewLine || tab.lastLine || 1);
  tab.feedRows = [];
  tab.feedCount = 0;
  tab.feedFrom = 1;
  tab.filterEof = false;
  tab.loadingMore = false;
  tab._fpaintKey = null;
  tab.window = null;
  updateSpacer(tab);
  const maxLine = Math.max(tab.totalLines, 1);
  const line = tab.indexDone ? Math.min(target, maxLine) : Math.max(1, target);
  tab.viewLine = line;
  scroller.scrollTop = Math.max(0, (line - 1) * rowH);
  renderWindow(tab, line);
  updateStatus(tab);
}

function activeTab() {
  return state.tabs.find((t) => t.id === state.activeId) || null;
}

function hasLevelFilter(tab) {
  return Boolean(tab && ((tab.levels && tab.levels.size) || (tab.excludedLevels && tab.excludedLevels.size)));
}

function hasTextFilter(tab) {
  return Boolean(tab && tab.filter && String(tab.filter.query || "").trim());
}

/** Level badges and/or text filter: the sequential "filtered feed" view. */
function hasViewFilter(tab) {
  return hasLevelFilter(tab) || hasTextFilter(tab);
}

function levelFilterPayload(tab) {
  if (!hasLevelFilter(tab)) return null;
  return {
    include: tab.levels ? [...tab.levels] : [],
    exclude: tab.excludedLevels ? [...tab.excludedLevels] : [],
  };
}

function textFilterPayload(tab) {
  if (!hasTextFilter(tab)) return null;
  const f = tab.filter;
  return {
    query: f.query,
    isRegex: Boolean(f.isRegex),
    caseSensitive: Boolean(f.caseSensitive),
    invert: Boolean(f.invert),
  };
}

function pageFilters(tab) {
  return { levels: levelFilterPayload(tab), filter: textFilterPayload(tab) };
}

function badgeState(tab, level) {
  if (tab && tab.levels && tab.levels.has(level)) return "include";
  if (tab && tab.excludedLevels && tab.excludedLevels.has(level)) return "exclude";
  return "neutral";
}

function atBottom() {
  return scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
}

// ---------- adapters ---------------------------------------------------------

/** 首次打开的虚拟引导日志（纯内存，不落盘、不写入会话状态）。 */
const DEMO_LOG_LINES = [
  "# ── 日志查看器 · 使用引导 ──────────────────────────────",
  "# 这是一份虚拟示例日志，不会写入磁盘。打开真实 .log / .txt 后可关闭本页签。",
  "#",
  "# 推荐格式：时间|等级|模块|消息   （与常见 Python / 自研服务日志一致）",
  "# 也支持：[2026-01-01 10:00:00] [ERROR] app - message",
  "#          2026-01-01 10:00:00 ERROR message",
  "#",
  "# 快捷上手：",
  "#   · 点击右侧 ERROR / WARN / INFO / DEBUG 徽章 → 等级过滤（再点循环：包含→排除→取消）",
  "#   · 工具栏放大镜 → 搜索栏：全文高亮，F3 / Shift+F3 跳转（不隐藏其它行）",
  "#   · 工具栏漏斗 → 过滤栏：只显示匹配行，可勾选「隐藏匹配」反向",
  "#   · Ctrl+G 跳转行号；点击行号复制整行；右键复制选中",
  "#   · 「实时跟随」追新写入的增长日志（静态文件无需开启）",
  "# ────────────────────────────────────────────────────────────",
  "",
  "2026-01-08 09:00:01|INFO|bootstrap|service starting, env=prod version=2.4.1",
  "2026-01-08 09:00:01|INFO|bootstrap|config loaded from /etc/app/config.yaml",
  "2026-01-08 09:00:02|DEBUG|bootstrap|feature flags: cache=true, tracing=false",
  "2026-01-08 09:00:02|INFO|db|connecting to postgres host=db-primary:5432",
  "2026-01-08 09:00:02|INFO|db|connection pool ready size=10",
  "2026-01-08 09:00:03|INFO|http|listening on 0.0.0.0:8080",
  "2026-01-08 09:00:10|INFO|http|GET /health 200 2ms",
  "2026-01-08 09:00:12|INFO|http|GET /api/users?page=1 200 18ms",
  "2026-01-08 09:00:15|WARN|cache|redis latency high rtt=120ms threshold=100ms",
  "2026-01-08 09:00:18|INFO|http|POST /api/login 200 45ms user_id=10086",
  "2026-01-08 09:00:22|DEBUG|auth|jwt issued sub=10086 exp=+3600s",
  "2026-01-08 09:00:30|INFO|worker|job queued id=job_9f3a type=email",
  "2026-01-08 09:00:31|INFO|worker|job started id=job_9f3a",
  "2026-01-08 09:00:33|WARN|worker|smtp slow response, retrying attempt=1",
  "2026-01-08 09:00:35|ERROR|worker|job failed id=job_9f3a error=smtp timeout after 3 retries",
  "2026-01-08 09:00:35|DEBUG|worker|stack: TimeoutError: smtp timeout",
  "2026-01-08 09:00:35|DEBUG|worker|    at SmtpClient.send (smtp.js:128)",
  "2026-01-08 09:00:35|DEBUG|worker|    at EmailJob.run (jobs/email.js:56)",
  "2026-01-08 09:00:40|INFO|http|GET /api/orders 200 32ms",
  "2026-01-08 09:00:45|WARN|db|slow query duration=850ms sql=SELECT * FROM orders WHERE status='open'",
  "2026-01-08 09:00:50|INFO|http|GET /metrics 200 5ms",
  "2026-01-08 09:01:00|INFO|scheduler|heartbeat ok, queue_depth=3",
  "2026-01-08 09:01:05|ERROR|http|GET /api/report 500 1200ms error=division by zero",
  "2026-01-08 09:01:05|INFO|http|request_id=req_7c2e marked failed",
  "2026-01-08 09:01:10|INFO|http|GET /api/users?page=2 200 21ms",
  "2026-01-08 09:01:15|DEBUG|cache|hit key=user:10086 ttl_left=280s",
  "2026-01-08 09:01:20|WARN|http|rate limit near threshold ip=10.0.0.12 used=92%",
  "2026-01-08 09:01:25|INFO|db|checkpoint complete wal=000000010000000000000042",
  "2026-01-08 09:01:30|ERROR|db|connection reset by peer host=db-primary:5432",
  "2026-01-08 09:01:30|INFO|db|reconnecting attempt=1",
  "2026-01-08 09:01:31|INFO|db|connection restored",
  "2026-01-08 09:01:40|INFO|http|GET /health 200 1ms",
  "2026-01-08 09:01:45|TRACE|http|upstream call trace_id=abc123 span=db.query",
  "2026-01-08 09:01:50|INFO|worker|job succeeded id=job_a1b2 type=email",
  "2026-01-08 09:01:55|WARN|disk|usage 81% path=/var/log",
  "2026-01-08 09:02:00|INFO|scheduler|heartbeat ok, queue_depth=1",
  "2026-01-08 09:02:05|ERROR|payment|charge declined order=ord_5512 reason=insufficient_funds",
  "2026-01-08 09:02:05|INFO|payment|notified user_id=20001 channel=inapp",
  "2026-01-08 09:02:10|DEBUG|http|query plan: Index Scan using users_pkey",
  "2026-01-08 09:02:15|INFO|http|PUT /api/users/10086 200 28ms",
  "2026-01-08 09:02:20|WARN|cache|evicted 12 keys reason=maxmemory",
  "2026-01-08 09:02:25|INFO|http|GET /api/orders 200 24ms",
  "2026-01-08 09:02:30|FATAL|bootstrap|simulated crash — 在真实日志中 FATAL 会归入 ERROR 等级",
  "2026-01-08 09:02:31|INFO|bootstrap|（示例结束）试着：点 ERROR 徽章只看错误；或在过滤栏输入 timeout / job_",
  "2026-01-08 09:02:32|INFO|bootstrap|搜索栏输入 connection 可高亮命中；F3 循环跳到下一处",
];

function computeDemoStats(lines) {
  const stats = { error: 0, warn: 0, info: 0, debug: 0 };
  for (const line of lines) {
    const lv = LogLevel.levelFromLine(line);
    if (lv && lv !== "other" && stats[lv] != null) stats[lv] += 1;
  }
  return stats;
}

function demoMatchesFilters(line, { levels, filter }) {
  if (levels) {
    const lv = LogLevel.levelFromLine(line);
    const include = new Set(levels.include || []);
    const exclude = new Set(levels.exclude || []);
    if (exclude.has(lv)) return false;
    if (include.size && !include.has(lv)) return false;
  }
  if (filter && filter.query) {
    try {
      const matcher = LogQuery.compileQuery({
        query: filter.query,
        isRegex: Boolean(filter.isRegex),
        caseSensitive: Boolean(filter.caseSensitive),
      });
      const hit = matcher.test(line);
      if (filter.invert ? hit : !hit) return false;
    } catch {
      return true; // 非法查询时不过滤，避免空白
    }
  }
  return true;
}

function createDemoAdapter() {
  const lines = DEMO_LOG_LINES.slice();
  const stats = computeDemoStats(lines);
  const size = lines.reduce((n, l) => n + l.length + 1, 0);
  let jobId = 1;
  const jobs = new Map();
  const snapshot = () => ({
    totalLines: lines.length,
    indexDone: true,
    size,
    stats: { ...stats },
  });

  return {
    mode: "demo",
    page: async (p) => {
      const from = Math.max(1, Math.floor(Number(p.fromLine) || 1));
      const count = Math.min(2000, Math.max(1, Math.floor(Number(p.count) || 500)));
      const filters = { levels: p.levels || null, filter: p.filter || null };
      const out = [];
      let scanned = 0;
      let next = from;
      for (let i = from - 1; i < lines.length && out.length < count; i += 1) {
        scanned += 1;
        next = i + 2;
        const text = lines[i];
        if (demoMatchesFilters(text, filters)) out.push({ no: i + 1, text });
      }
      const eof = next > lines.length;
      return {
        fileId: 0,
        epoch: 1,
        lines: out,
        requested: from,
        eof,
        partial: null,
        scanned,
        scanEndLine: next,
        hasMore: false,
        ...snapshot(),
      };
    },
    poll: async () => ({ fileId: 0, epoch: 1, rotated: false, events: [], missing: false, ...snapshot() }),
    setFollow: async (p) => ({ ok: true, follow: Boolean(p && p.follow) }),
    setEncoding: async (p) => ({ ok: true, encoding: (p && p.encoding) || "utf-8" }),
    stats: async () => ({ fileId: 0, ...snapshot() }),
    searchStart: (p) => {
      const id = jobId++;
      const query = String((p && p.query) || "");
      const isRegex = Boolean(p && p.isRegex);
      const caseSensitive = Boolean(p && p.caseSensitive);
      const matches = [];
      let matchCount = 0;
      let error = null;
      try {
        const matcher = LogQuery.compileQuery({ query, isRegex, caseSensitive });
        lines.forEach((text, idx) => {
          if (matcher.test(text)) {
            matchCount += 1;
            if (matches.length < 5000) {
              matches.push({ line: idx + 1, text: text.length > 300 ? text.slice(0, 300) : text });
            }
          }
        });
      } catch (err) {
        error = err.message || String(err);
      }
      jobs.set(id, { status: error ? "error" : "done", matchCount, matches, error });
      return Promise.resolve({ jobId: id });
    },
    searchStatus: async (p) => {
      const job = jobs.get(Number(p && p.jobId));
      if (!job) return { status: "error", error: "job not found", matchCount: 0, storedMatches: 0 };
      return {
        jobId: Number(p.jobId),
        status: job.status,
        scannedBytes: size,
        fileSize: size,
        matchCount: job.matchCount,
        storedMatches: job.matches.length,
        error: job.error,
      };
    },
    searchMatches: async (p) => {
      const job = jobs.get(Number(p && p.jobId));
      if (!job) return { matches: [], matchCount: 0, stored: 0, status: "error" };
      const offset = Math.max(0, Number(p.offset) || 0);
      const limit = Math.min(500, Math.max(1, Number(p.limit) || 100));
      return {
        jobId: Number(p.jobId),
        matches: job.matches.slice(offset, offset + limit),
        matchCount: job.matchCount,
        stored: job.matches.length,
        status: job.status,
      };
    },
    searchCancel: async (p) => {
      const job = jobs.get(Number(p && p.jobId));
      if (job) job.status = "cancelled";
      return { ok: true, status: job ? job.status : "cancelled" };
    },
    close: async () => ({ ok: true }),
  };
}

function createNativeAdapter() {
  const call = (op, payload) => invoke(`engine.${op}`, payload);
  return {
    mode: "native",
    open: (path) => call("openFile", { path }),
    listDir: (path) => call("listDir", { path }),
    setRoot: (path) => call("setRoot", { path }),
    page: (p) => call("page", p),
    poll: (p) => call("poll", p),
    setFollow: (p) => call("setFollow", p),
    setEncoding: (p) => call("setEncoding", p),
    stats: (p) => call("stats", p),
    searchStart: (p) => call("searchStart", p),
    searchStatus: (p) => call("searchStatus", p),
    searchMatches: (p) => call("searchMatches", p),
    searchCancel: (p) => call("searchCancel", p),
    close: (p) => call("close", p),
  };
}

// ---------- tabs -------------------------------------------------------------

function createTab({ mode, name, path, adapter, saved }) {
  const tab = {
    id: state.nextTabId++,
    mode,
    name: name || "未命名",
    path: path || null,
    size: (saved && saved.size) || 0,
    seenSize: (saved && saved.size) || 0,
    encoding: (saved && saved.encoding) || "utf-8",
    follow: Boolean(saved && saved.follow),
    levels: saved && Array.isArray(saved.levels) && saved.levels.length ? new Set(saved.levels) : null,
    excludedLevels:
      saved && Array.isArray(saved.excludeLevels) && saved.excludeLevels.length ? new Set(saved.excludeLevels) : null,
    filter:
      saved && saved.filterQuery
        ? {
            query: String(saved.filterQuery),
            isRegex: Boolean(saved.filterIsRegex),
            caseSensitive: Boolean(saved.filterCaseSensitive),
            invert: Boolean(saved.filterInvert),
          }
        : null,
    lastLine: (saved && saved.line) || 1,
    /** 浏览位置（视口首行）；lastLine 仅作轮询游标，打开静态文件时两者分离。 */
    viewLine: Math.max(1, (saved && saved.line) || 1),
    totalLines: 0,
    indexDone: false,
    stats: { error: 0, warn: 0, info: 0, debug: 0 },
    search: null,
    adapter,
    renderToken: 0,
    window: null, // { from, to, lines }
    feedFrom: 1,
    feedCount: 0,
    tailSeen: 0,
    error: null,
    pins: [], // [{ no, text }] 最多 MAX_PINS 条
  };
  state.tabs.push(tab);
  renderTabs();
  return tab;
}

function closeTab(id) {
  const idx = state.tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const tab = state.tabs[idx];
  try {
    tab.adapter.close({ fileId: tab.fileId });
  } catch {
    // best effort
  }
  state.tabs.splice(idx, 1);
  if (state.activeId === id) {
    const next = state.tabs[Math.max(0, idx - 1)];
    state.activeId = next ? next.id : null;
  }
  renderTabs();
  activateView();
  scheduleSaveState();
}

function activateTab(id) {
  state.activeId = id;
  renderTabs();
  activateView();
  scheduleSaveState();
}

function renderTabs() {
  const box = $("tabs");
  box.textContent = "";
  for (const tab of state.tabs) {
    const el = document.createElement("div");
    el.className = `tab${tab.id === state.activeId ? " active" : ""}`;
    const name = document.createElement("span");
    name.className = "t-name";
    name.textContent = tab.name;
    name.title = tab.path || tab.name;
    const close = document.createElement("button");
    close.className = "t-close";
    close.textContent = "✕";
    close.title = "关闭";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(tab.id);
    });
    el.append(name, close);
    el.addEventListener("click", () => activateTab(tab.id));
    box.append(el);
  }
  $("emptyState").style.display = state.tabs.length ? "none" : "flex";
  $("filebar").style.display = state.tabs.length ? "flex" : "none";
}

// ---------- view rendering ---------------------------------------------------

function applyFont() {
  document.documentElement.style.setProperty("--row-fs", `${state.fontSize}px`);
  rowH = state.fontSize + 8;
  document.documentElement.style.setProperty("--row-h", `${rowH}px`);
  localStorage.setItem("lv.fontSize", String(state.fontSize));
  document.documentElement.style.setProperty(
    "--log-font",
    state.fontFamily === "default"
      ? '"Cascadia Code", Consolas, "SF Mono", Menlo, "Courier New", monospace'
      : state.fontFamily,
  );
  localStorage.setItem("lv.fontFamily", state.fontFamily);
  const tab = activeTab();
  if (tab) {
    if (hasViewFilter(tab)) renderFilteredViewport(tab);
    else renderWindow(tab, lineAtScroll());
  }
}

function lineAtScroll() {
  return Math.max(1, Math.floor(scroller.scrollTop / rowH) + 1);
}

function visibleCount() {
  return Math.max(1, Math.ceil(scroller.clientHeight / rowH));
}

function spacerHeight(tab) {
  const lines = hasViewFilter(tab) ? tab.feedCount : Math.max(tab.totalLines, 1);
  return Math.max(lines, 1) * rowH;
}

function updateSpacer(tab) {
  spacer.style.height = `${spacerHeight(tab)}px`;
}

function levelClass(line) {
  const level = LogLevel.detectLevel(line);
  return level && level !== "other" ? ` lv-${level}` : "";
}

function buildText(tab, text) {
  // returns a DocumentFragment with <mark> highlights when a search is active
  const frag = document.createDocumentFragment();
  const s = tab && tab.search && tab.search.query ? tab.search : null;
  if (!s) {
    frag.append(text);
    return frag;
  }
  let terms;
  try {
    terms = LogQuery.parseQuery(s.query, { isRegex: s.isRegex }).includeTerms;
  } catch {
    terms = [];
  }
  const ranges = [];
  for (const term of terms) {
    if (s.isRegex) {
      try {
        LogQuery.assertSafeRegex(term);
        const re = new RegExp(term, s.caseSensitive ? "g" : "gi");
        let m;
        while ((m = re.exec(text)) && ranges.length < 200) {
          if (m[0].length === 0) {
            re.lastIndex += 1;
            continue;
          }
          ranges.push([m.index, m.index + m[0].length]);
        }
      } catch {
        // The engine reports invalid expressions; a stale row simply has no mark.
      }
    } else {
      const hay = s.caseSensitive ? text : text.toLowerCase();
      const needle = s.caseSensitive ? term : term.toLowerCase();
      let idx = hay.indexOf(needle);
      while (idx !== -1 && ranges.length < 200) {
        ranges.push([idx, idx + needle.length]);
        idx = hay.indexOf(needle, idx + Math.max(needle.length, 1));
      }
    }
  }
  if (!ranges.length) {
    frag.append(text);
    return frag;
  }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
    else merged.push(range);
  }
  let pos = 0;
  for (const [a, b] of merged) {
    if (a > pos) frag.append(text.slice(pos, a));
    const mark = document.createElement("mark");
    mark.textContent = text.slice(a, b);
    frag.append(mark);
    pos = b;
  }
  if (pos < text.length) frag.append(text.slice(pos));
  return frag;
}

function paintRows(tab, rows, { absolute, offset = 0 }) {
  spacer.textContent = "";
  const currentLine = tab.search && tab.search.current >= 0 && tab.search.currentLine ? tab.search.currentLine : null;
  const frag = document.createDocumentFragment();
  for (let i = 0; i < rows.length; i += 1) {
    const item = rows[i];
    const row = document.createElement("div");
    row.className = `row${levelClass(item.text)}${currentLine === item.no ? " current" : ""}`;
    const top = absolute ? (item.no - 1) * rowH : (offset + i) * rowH;
    row.style.top = `${top}px`;
    const lno = document.createElement("div");
    lno.className = "lno";
    lno.textContent = item.no;
    lno.title = "点击复制整行";
    lno.addEventListener("click", () => copyLine(item.text, item.no));
    const ltxt = document.createElement("div");
    ltxt.className = "ltxt";
    ltxt.append(buildText(tab, item.text));
    ltxt.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openCtxMenu(e, item.text, item.no);
    });
    row.append(lno, ltxt);
    frag.append(row);
  }
  spacer.append(frag);
}

function renderWindow(tab, fromLine) {
  if (hasViewFilter(tab)) {
    loadMoreFiltered(tab);
    renderFilteredViewport(tab);
    return;
  }
  fromLine = Math.max(1, Math.floor(fromLine) || 1);
  const token = (tab.renderToken = (tab.renderToken || 0) + 1);
  const count = visibleCount() + OVERSCAN * 2;
  const from = Math.max(1, fromLine - OVERSCAN);
  tab.adapter
    .page({ fileId: tab.fileId, fromLine: from, count, levels: null, filter: null })
    .then((res) => {
      if (token !== tab.renderToken || state.activeId !== tab.id) return;
      tab.totalLines = res.totalLines;
      tab.indexDone = res.indexDone;
      tab.size = res.size;
      tab.stats = res.stats;
      tab.seenSize = res.size;
      tab.window = { from, lines: res.lines, eof: res.eof, hasMore: res.hasMore };
      updateBadges(tab);
      updateStatus(tab);
      if (hasViewFilter(tab)) {
        // Filter state flipped while the page was in flight — drop the unfiltered window.
        renderFilteredViewport(tab);
      } else {
        updateSpacer(tab);
        paintRows(tab, res.lines, { absolute: true });
        if (res.eof && !res.lines.length && fromLine > 1) {
          // scrolled past EOF (index lag) — pull back to the indexed tail
          scroller.scrollTop = Math.max(0, res.totalLines * rowH - scroller.clientHeight);
        }
      }
      scheduleSaveState();
    })
    .catch((err) => toast(`读取失败: ${err.message || err}`));
}

function dedupeAppend(existing, fresh) {
  if (!existing.length) return fresh.slice();
  const lastNo = existing[existing.length - 1].no;
  return existing.concat(fresh.filter((x) => x.no > lastNo));
}

/** Virtual-scroll paint: only the visible slice of the filtered feed. */
function renderFilteredViewport(tab) {
  const rows = tab.feedRows || [];
  updateSpacer(tab);
  if (!rows.length) {
    spacer.textContent = "";
    tab._fpaintKey = "empty";
    return;
  }
  const start = Math.max(0, Math.floor(scroller.scrollTop / rowH) - OVERSCAN);
  const end = Math.min(rows.length, start + visibleCount() + OVERSCAN * 2);
  const key = `${start}:${end}:${rows.length}:${tab.search ? tab.search.query : ""}:${tab.search && tab.search.currentLine}`;
  if (tab._fpaintKey === key) return;
  tab._fpaintKey = key;
  paintRows(tab, rows.slice(start, end), { absolute: false, offset: start });
}

function renderFilteredReset(tab) {
  tab.feedRows = [];
  tab.feedCount = 0;
  tab.feedFrom = 1;
  tab.paintedFeed = 0;
  tab.filterEof = false;
  tab._fpaintKey = null;
  scroller.scrollTop = 0;
  updateSpacer(tab);
  loadMoreFiltered(tab);
}

/** Load the next batch of matching rows (also continues past empty windows). */
async function loadMoreFiltered(tab) {
  if (!hasViewFilter(tab) || tab.loadingMore || tab.filterEof) return;
  tab.loadingMore = true;
  try {
    for (let guard = 0; guard < 30; guard += 1) {
      const res = await tab.adapter.page({
        fileId: tab.fileId,
        fromLine: tab.feedFrom,
        count: Math.max(visibleCount() * 2, 80),
        ...pageFilters(tab),
      });
      tab.totalLines = res.totalLines;
      tab.indexDone = res.indexDone;
      tab.size = res.size;
      tab.seenSize = res.size;
      tab.stats = res.stats;
      const existing = tab.feedRows || [];
      const merged = dedupeAppend(existing, res.lines);
      const newRows = merged.slice(existing.length);
      tab.feedRows = merged;
      tab.feedCount = merged.length;
      tab.feedFrom = merged.length ? merged[merged.length - 1].no + 1 : res.scanEndLine || tab.feedFrom;
      tab.filterEof = Boolean(res.eof);
      tab._fpaintKey = null;
      updateSpacer(tab);
      renderFilteredViewport(tab);
      updateBadges(tab);
      updateStatus(tab);
      if (res.eof) break;
      if (newRows.length > 0) break; // painted content; wait for the next scroll
      if (!res.scanEndLine || res.scanEndLine <= tab.feedFrom) break; // no progress
      tab.feedFrom = res.scanEndLine; // empty window: keep scanning
    }
  } catch (err) {
    toast(`过滤视图加载失败: ${err.message || err}`);
  } finally {
    tab.loadingMore = false;
  }
}

// follow-mode helpers ---------------------------------------------------------

function scrollToTail(tab, { enableFollow = false } = {}) {
  if (hasViewFilter(tab)) return;
  const target = Math.max(1, tab.totalLines - visibleCount() + 1);
  tab.viewLine = target;
  scroller.scrollTop = (target - 1) * rowH;
  renderWindow(tab, target);
  if (enableFollow && !tab.follow) setFollow(tab, true);
}

async function setFollow(tab, on) {
  tab.follow = Boolean(on);
  try {
    await tab.adapter.setFollow({ fileId: tab.fileId, follow: tab.follow });
  } catch {
    // The host owns the follow handle; a closed file is reported on poll.
  }
  updateFollowState(tab);
  if (tab.follow) scrollToTail(tab);
  scheduleSaveState();
}

function updateFollowState(tab) {
  const el = $("stFollow");
  el.classList.remove("on", "paused");
  if (!tab) {
    el.textContent = "";
    return;
  }
  if (tab.follow) {
    el.classList.add("on");
    el.textContent = "实时跟随中";
    $("btnFollow").classList.add("toggled");
  } else {
    el.textContent = tab.mode === "native" ? "跟随已暂停" : "";
    $("btnFollow").classList.remove("toggled");
  }
}

// ---------- poll loop --------------------------------------------------------

async function tick() {
  for (const tab of state.tabs) {
    if (tab.mode === "native" && tab.fileId) {
      try {
        const res = await tab.adapter.poll({ fileId: tab.fileId, sinceLine: tab.lastLine });
        applyPoll(tab, res);
      } catch (err) {
        if (String(err && err.message).includes("not open")) {
          tab.error = "文件句柄已失效";
        }
      }
    }
  }
  const active = activeTab();
  if (active && active.search && active.search.status === "running") {
    try {
      await pollSearch(active);
    } catch {
      // job pruned
    }
  }
}

function applyPoll(tab, res) {
  if (res.missing) {
    if (tab.error !== "missing") {
      tab.error = "missing";
      if (tab.id === state.activeId) {
        toast(`文件已不存在: ${tab.name}`);
        $("stLines").textContent = "文件已丢失";
      }
    }
    return;
  }
  tab.error = null;
  const prevSize = tab.seenSize != null ? tab.seenSize : tab.size;
  const sizeGrew = res.size > prevSize;
  tab.seenSize = res.size;
  tab.size = res.size;
  tab.totalLines = res.totalLines;
  tab.indexDone = res.indexDone;
  tab.stats = res.stats;
  const rotated = res.rotated || (res.events || []).some((e) => e.type === "rotated");
  if (tab.id !== state.activeId) {
    // Keep bookkeeping only; UI belongs to the active tab.
    for (const ev of res.events || []) {
      if (ev.type === "append" || ev.type === "catchup") {
        tab.lastLine = ev.totalLines;
        tab.totalLines = ev.totalLines;
      } else if (ev.type === "rotated") {
        tab.lastLine = 0;
        tab.search = null;
      }
    }
    return;
  }
  if (rotated) {
    toast(`日志已轮转，重新加载: ${tab.name}`);
    tab.lastLine = 0;
    tab.search = null;
    updateSearchBar(tab);
    if (tab.follow) {
      renderWindow(tab, 1);
      setTimeout(() => scrollToTail(tab), 600);
    } else {
      renderWindow(tab, 1);
    }
    updateBadges(tab);
    updateStatus(tab);
    return;
  }
  for (const ev of res.events || []) {
    if (ev.type === "append") {
      const newCount = ev.totalLines - (tab.tailSeen || tab.lastLine);
      tab.lastLine = ev.totalLines;
      tab.totalLines = ev.totalLines;
      if (tab.follow && atBottom()) {
        if (hasViewFilter(tab)) loadMoreFiltered(tab);
        else {
          updateSpacer(tab);
          renderWindow(tab, Math.max(1, tab.totalLines - visibleCount() + 1));
        }
        scroller.scrollTop = scroller.scrollHeight;
      } else if (!tab.follow && sizeGrew) {
        // Only real file growth counts as "new"; index catch-up on a static file is silent.
        showJumpChip(newCount);
      } else {
        updateSpacer(tab);
      }
    } else if (ev.type === "catchup") {
      tab.lastLine = ev.totalLines;
      if (tab.follow) renderWindow(tab, Math.max(1, tab.totalLines - visibleCount() + 1));
      else if (sizeGrew) showJumpChip(1);
    }
  }
  updateBadges(tab);
  updateStatus(tab);
}

function applyStats(tab, res) {
  tab.stats = res.stats;
  tab.totalLines = res.totalLines;
  tab.indexDone = res.indexDone;
  if (!hasViewFilter(tab)) updateSpacer(tab);
  updateBadges(tab);
  updateStatus(tab);
}

function showJumpChip(newCount) {
  const chip = $("jumpChip");
  chip.style.display = "flex";
  chip.textContent = `↓ ${newCount > 0 ? `${newCount} 行新日志，` : ""}点击回到底部`;
}

function hideJumpChip() {
  $("jumpChip").style.display = "none";
}

// ---------- badges & status --------------------------------------------------

function updateBadges(tab) {
  const map = { error: 0, warn: 0, info: 0, debug: 0 };
  Object.assign(map, tab.stats || {});
  for (const el of $("badges").children) {
    const lv = el.dataset.level;
    el.querySelector("b").textContent = String(map[lv] || 0);
    const stateName = badgeState(tab, lv);
    el.dataset.state = stateName;
    el.classList.toggle("on", stateName === "include");
    el.classList.toggle("exclude", stateName === "exclude");
    el.title = stateName === "include" ? "仅显示此等级（再次点击改为排除）" : stateName === "exclude" ? "排除该等级（再次点击取消）" : "点击仅显示此等级";
  }
  const idx = $("idxProgress");
  if (!tab || !tab.fileId) {
    idx.textContent = "";
    return;
  }
  if (tab.indexDone) idx.textContent = "";
  else idx.textContent = `索引中 L${tab.totalLines}…`;
}

function updateStatus(tab) {
  if (!tab) {
    $("stPos").textContent = "—";
    $("stLines").textContent = "";
    $("stSize").textContent = "";
    $("fName").textContent = "";
    $("fMeta").textContent = "";
    return;
  }
  $("fName").textContent = tab.name || "";
  $("fName").title = tab.path || tab.name || "";
  $("fMeta").textContent = tab.mode === "demo" ? "示例" : tab.mode === "native" ? "本地文件" : "";
  if (hasViewFilter(tab)) {
    const kind = hasTextFilter(tab) ? "过滤" : "等级过滤";
    $("stPos").textContent = `${kind}视图 ${tab.feedCount} 行`;
    $("stLines").textContent = `源文件已索引 L${tab.totalLines}${tab.indexDone ? "" : "+"}`;
  } else {
    const pos = lineAtScroll() + visibleCount() - 1;
    $("stPos").textContent = `L ${lineAtScroll()}–${Math.min(pos, Math.max(tab.totalLines, 1))}`;
    $("stLines").textContent = `共 ${tab.totalLines} 行${tab.indexDone ? "" : "（索引中…）"}`;
  }
  $("stSize").textContent = fmtSize(tab.size);
  $("encodingSel").value = tab.encoding;
  updateFollowState(tab);
}

// ---------- text filter ------------------------------------------------------

function startFilter() {
  const tab = activeTab();
  if (!tab) return;
  const query = $("filterInput").value.trim();
  if (!query) {
    clearTextFilter(tab);
    return;
  }
  rememberPreFilterScroll(tab);
  tab.filter = {
    query,
    isRegex: $("cbFilterRegex").checked,
    caseSensitive: $("cbFilterCase").checked,
    invert: $("cbFilterInvert").checked,
  };
  updateFilterBar(tab);
  renderFilteredReset(tab);
  updateStatus(tab);
  scheduleSaveState();
}

function clearTextFilter(tab) {
  if (!tab) return;
  tab.filter = null;
  $("filterInput").value = "";
  updateFilterBar(tab);
  if (hasViewFilter(tab)) {
    renderFilteredReset(tab);
  } else {
    exitToUnfilteredView(tab);
  }
  updateStatus(tab);
  scheduleSaveState();
}

/** 清空过滤 + 等级筛选，恢复未过滤视图。 */
function clearAllFilters(tab) {
  if (!tab) return;
  tab.filter = null;
  $("filterInput").value = "";
  tab.levels = null;
  tab.excludedLevels = null;
  updateFilterBar(tab);
  updateBadges(tab);
  exitToUnfilteredView(tab);
  scheduleSaveState();
}

function updateFilterBar(tab) {
  const f = tab && tab.filter;
  const el = $("filterState");
  if (!f || !String(f.query || "").trim()) {
    el.textContent = "";
    $("btnFilterClear").disabled = !(tab && hasLevelFilter(tab));
    return;
  }
  const mode = f.invert ? "隐藏匹配" : "仅显示匹配";
  el.innerHTML = "";
  const b = document.createElement("b");
  b.textContent = mode;
  el.append(b, document.createTextNode(` ${f.query}`));
  $("btnFilterClear").disabled = false;
}

function syncFilterInputs(tab) {
  const f = tab && tab.filter;
  $("filterInput").value = f ? f.query : "";
  $("cbFilterRegex").checked = Boolean(f && f.isRegex);
  $("cbFilterCase").checked = Boolean(f && f.caseSensitive);
  $("cbFilterInvert").checked = Boolean(f && f.invert);
  updateFilterBar(tab);
}

// ---------- search -----------------------------------------------------------

function startSearch() {
  const tab = activeTab();
  if (!tab) return;
  const query = $("searchInput").value.trim();
  if (!query) return;
  const isRegex = $("cbRegex").checked;
  const payload = {
    fileId: tab.fileId,
    query,
    isRegex,
    caseSensitive: $("cbCase").checked,
  };
  tab.adapter
    .searchStart(payload)
    .then((res) => {
      tab.search = {
        jobId: res.jobId,
        query,
        isRegex: payload.isRegex,
        caseSensitive: payload.caseSensitive,
        status: "running",
        matchCount: 0,
        stored: 0,
        current: -1,
        currentLine: null,
        cache: null,
      };
      updateSearchBar(tab);
      repaintCurrentWindow(tab);
    })
    .catch((err) => toast(`搜索失败: ${err.message || err}`));
}

async function pollSearch(tab) {
  if (!tab.search || !tab.search.jobId) return;
  try {
    const st = await tab.adapter.searchStatus({ fileId: tab.fileId, jobId: tab.search.jobId });
    tab.search.status = st.status;
    tab.search.matchCount = st.matchCount;
    tab.search.stored = st.storedMatches;
    if (st.error) tab.search.error = st.error;
    updateSearchBar(tab);
    if (st.status !== "running") await jumpMatch(tab, tab.search.current < 0 ? 0 : tab.search.current);
  } catch {
    // job pruned or file closed
  }
}

function updateSearchBar(tab) {
  const s = tab && tab.search;
  const el = $("searchState");
  const prev = $("btnPrevMatch");
  const next = $("btnNextMatch");
  if (!s) {
    el.textContent = "";
    prev.disabled = true;
    next.disabled = true;
    return;
  }
  const navigable = Math.min(s.matchCount, s.stored || 0);
  prev.disabled = navigable === 0;
  next.disabled = navigable === 0;
  if (s.status === "running") {
    el.textContent = `扫描中 · 已命中 ${s.matchCount}`;
  } else if (s.status === "cancelled") {
    el.textContent = "已取消";
  } else if (s.status === "error") {
    el.textContent = s.error || "搜索失败";
  } else {
    const cur = s.current >= 0 ? ` · ${s.current + 1}/${navigable}` : "";
    const capNote = s.stored < s.matchCount ? `（仅定位前 ${s.stored} 处）` : "";
    el.innerHTML = "";
    const b = document.createElement("b");
    b.textContent = `命中 ${s.matchCount}`;
    el.append(b, document.createTextNode(`${cur}${capNote}`));
  }
}

function repaintCurrentWindow(tab) {
  if (hasViewFilter(tab)) {
    tab._fpaintKey = null;
    renderFilteredViewport(tab);
    return;
  }
  if (!tab.window) return;
  paintRows(tab, tab.window.lines, { absolute: true });
}

async function jumpMatch(tab, index) {
  const s = tab.search;
  if (!s || !s.jobId) return;
  if (s.matchCount === 0) {
    updateSearchBar(tab);
    return;
  }
  const stored = s.stored || 0;
  if (stored === 0) return;
  index = ((Math.floor(index) % stored) + stored) % stored;
  const windowStart = Math.max(0, index - 60);
  const res = await tab.adapter.searchMatches({ fileId: tab.fileId, jobId: s.jobId, offset: windowStart, limit: 160 });
  s.cache = { offset: windowStart, items: res.matches };
  const item = res.matches[index - windowStart];
  s.current = index;
  s.currentLine = item ? item.line : null;
  updateSearchBar(tab);
  if (item) {
    if (hasViewFilter(tab)) {
      let visibleIndex = (tab.feedRows || []).findIndex((row) => row.no === item.line);
      for (let guard = 0; visibleIndex < 0 && guard < 100 && !tab.filterEof; guard += 1) {
        const before = tab.feedRows ? tab.feedRows.length : 0;
        await loadMoreFiltered(tab);
        if ((tab.feedRows ? tab.feedRows.length : 0) === before) break;
        visibleIndex = (tab.feedRows || []).findIndex((row) => row.no === item.line);
      }
      if (visibleIndex >= 0) {
        scroller.scrollTop = Math.max(0, visibleIndex * rowH - scroller.clientHeight / 2);
        tab._fpaintKey = null;
        renderFilteredViewport(tab);
      } else {
        toast(`命中位于 L${item.line}，不在当前过滤视图`);
      }
    } else {
      scroller.scrollTop = Math.max(0, (item.line - 1) * rowH - scroller.clientHeight / 2);
      renderWindow(tab, item.line - Math.floor(visibleCount() / 2));
    }
  }
}

function clearSearch(tab) {
  if (!tab || !tab.search) return;
  tab.adapter.searchCancel({ fileId: tab.fileId, jobId: tab.search.jobId }).catch(() => {});
  tab.search = null;
  updateSearchBar(tab);
  repaintCurrentWindow(tab);
}

async function jumpToLine(tab, target) {
  if (!tab || !Number.isInteger(target) || target < 1) return;
  if (!hasViewFilter(tab)) {
    if (tab.indexDone && target > tab.totalLines) {
      toast(`行号超出范围（共 ${tab.totalLines} 行）`);
      return;
    }
    tab.viewLine = target;
    tab.lastLine = target;
    scroller.scrollTop = (target - 1) * rowH;
    renderWindow(tab, Math.max(1, target - Math.floor(visibleCount() / 2)));
    return;
  }
  for (let guard = 0; guard < 100 && !tab.filterEof; guard += 1) {
    const found = (tab.feedRows || []).findIndex((item) => item.no >= target);
    if (found >= 0) {
      scroller.scrollTop = Math.max(0, found * rowH - scroller.clientHeight / 2);
      tab._fpaintKey = null;
      renderFilteredViewport(tab);
      updateStatus(tab);
      return;
    }
    const before = tab.feedRows ? tab.feedRows.length : 0;
    await loadMoreFiltered(tab);
    if ((tab.feedRows ? tab.feedRows.length : 0) === before) break;
  }
  const found = (tab.feedRows || []).findIndex((item) => item.no >= target);
  if (found >= 0) {
    scroller.scrollTop = Math.max(0, found * rowH - scroller.clientHeight / 2);
    tab._fpaintKey = null;
    renderFilteredViewport(tab);
  } else {
    toast(`过滤视图中没有不小于 L${target} 的行`);
  }
}

function promptJumpToLine() {
  const tab = activeTab();
  if (!tab) return;
  const raw = window.prompt("跳转到行号", String(lineAtScroll()));
  if (raw === null) return;
  const target = Number(raw.trim());
  if (!Number.isSafeInteger(target) || target < 1) {
    toast("请输入正整数行号");
    return;
  }
  jumpToLine(tab, target).catch((err) => toast(`跳转失败: ${err.message || err}`));
}

// ---------- tabs activation & view ------------------------------------------

function activateView() {
  const tab = activeTab();
  hideJumpChip();
  $("searchInput").value = tab && tab.search ? tab.search.query : "";
  updateSearchBar(tab);
  syncFilterInputs(tab);
  if (!tab) {
    spacer.textContent = "";
    spacer.style.height = "0px";
    renderPins(null);
    updateStatus(null);
    updateBadges({ stats: {}, levels: null });
    updateFollowState(null);
    return;
  }
  if (hasViewFilter(tab)) {
    if (!tab.feedRows) renderFilteredReset(tab);
    else {
      tab._fpaintKey = null;
      updateSpacer(tab);
      renderFilteredViewport(tab);
    }
  } else {
    // 先对齐滚动位置，再按视口首行取窗口，避免顶部空白、内容错位
    const view = Math.max(1, tab.viewLine || 1);
    tab.viewLine = view;
    scroller.scrollTop = Math.max(0, (view - 1) * rowH);
    renderWindow(tab, view);
    if (tab.follow) setTimeout(() => scrollToTail(tab), 0);
  }
  renderPins(tab);
  updateStatus(tab);
  updateBadges(tab);
}

// ---------- open files -------------------------------------------------------

let dirCtx = { path: null, selected: new Map() };

/** 仅接受常见日志扩展名。 */
function isLogFileName(name) {
  const n = String(name || "").toLowerCase();
  return n.endsWith(".log") || n.endsWith(".txt");
}

function filterLogEntries(entries) {
  return (entries || []).filter((ent) => !ent.isDirectory && isLogFileName(ent.name || ent.path));
}

/**
 * 打开日志：系统文件选择器（仅 .log / .txt），多选。
 * 路径解析复用拖入文件的 grant 通道；不支持时回退为「选目录 → 只列日志」。
 */
async function openFilesFlow() {
  if (typeof bridge.getDroppedFilePath === "function") {
    openViaNativeFilePicker();
    return;
  }
  await openViaDirectoryFallback();
}

function openViaNativeFilePicker() {
  const input = $("filePicker");
  input.accept = ".log,.txt,.LOG,.TXT,text/plain";
  input.multiple = true;
  input.value = "";
  input.onchange = async () => {
    const files = [...(input.files || [])];
    input.value = "";
    if (!files.length) return;
    let opened = 0;
    for (const f of files) {
      if (!isLogFileName(f.name)) {
        toast(`已跳过：${f.name}（仅支持 .log / .txt）`);
        continue;
      }
      const tab = await openPickedOrDroppedFile(f, { source: "picker" });
      if (tab) opened += 1;
    }
    if (!opened) return;
  };
  input.click();
}

/** 宿主无拖入/选文件路径解析时的回退：选目录后只列出 .log / .txt。 */
async function openViaDirectoryFallback() {
  let dir;
  try {
    dir = await bridge.invoke("fs.requestDirectory");
  } catch (err) {
    toast(`选择目录失败: ${err.message || err}`);
    return;
  }
  if (!dir) return;
  try {
    await invoke("engine.setRoot", { path: "" });
  } catch (err) {
    toast(`绑定目录失败: ${err.message || err}`);
    return;
  }
  dirCtx = { path: "", selected: new Map() };
  await loadFileList("");
  $("dirOverlay").classList.add("show");
}

async function loadFileList(path) {
  const res = await invoke("engine.listDir", { path });
  dirCtx.path = res.path;
  dirCtx.selected.clear();
  const list = $("fileList");
  list.textContent = "";
  $("dirPath").textContent = res.path || "当前选择的目录（仅显示 .log / .txt）";
  const entries = filterLogEntries(res.entries);
  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "f-row";
    empty.style.color = "rgb(var(--c-faint))";
    empty.textContent = "该目录下没有 .log / .txt 日志文件";
    list.append(empty);
  }
  for (const ent of entries) {
    const row = document.createElement("div");
    row.className = "f-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    const name = document.createElement("span");
    name.textContent = ent.name;
    name.style.overflow = "hidden";
    name.style.textOverflow = "ellipsis";
    const size = document.createElement("span");
    size.className = "f-size";
    size.textContent = fmtSize(ent.size);
    const time = document.createElement("span");
    time.className = "f-time";
    time.textContent = fmtTime(ent.mtimeMs);
    cb.addEventListener("change", () => {
      if (cb.checked) dirCtx.selected.set(ent.path, ent);
      else dirCtx.selected.delete(ent.path);
      $("dirSelInfo").textContent = dirCtx.selected.size ? `已选择 ${dirCtx.selected.size} 个文件` : "未选择";
      $("dirOpen").disabled = dirCtx.selected.size === 0;
    });
    row.append(cb, name, size, time);
    row.addEventListener("click", (e) => {
      if (e.target !== cb) {
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event("change"));
      }
    });
    list.append(row);
  }
  $("dirSelInfo").textContent = "未选择";
  $("dirOpen").disabled = true;
}

async function openSelectedFiles() {
  const paths = [...dirCtx.selected.keys()];
  $("dirOverlay").classList.remove("show");
  for (const p of paths) {
    await openNativeFile(p);
  }
}

function openDemoLog() {
  const existing = state.tabs.find((t) => t.mode === "demo");
  if (existing) {
    activateTab(existing.id);
    return existing;
  }
  const lines = DEMO_LOG_LINES;
  const size = lines.reduce((n, l) => n + l.length + 1, 0);
  const tab = createTab({ mode: "demo", name: "使用引导（示例日志）", path: null, adapter: createDemoAdapter() });
  tab.fileId = 0;
  tab.demo = true;
  tab.size = size;
  tab.seenSize = size;
  tab.totalLines = lines.length;
  tab.indexDone = true;
  tab.stats = computeDemoStats(lines);
  tab.lastLine = lines.length; // 轮询游标：无新增
  tab.viewLine = 1; // 打开即从第一行看起
  activateTab(tab.id);
  return tab;
}

async function openNativeFile(path) {
  try {
    const res = await invoke("engine.openFile", { path });
    const existing = state.tabs.find((t) => t.mode === "native" && t.path === path);
    if (existing) {
      existing.fileId = res.fileId;
      activateTab(existing.id);
      return existing;
    }
    const tab = createTab({ mode: "native", name: res.name, path, adapter: createNativeAdapter() });
    tab.fileId = res.fileId;
    tab.size = res.size;
    tab.seenSize = res.size;
    tab.totalLines = res.totalLines;
    tab.indexDone = res.indexDone;
    tab.encoding = res.encoding;
    tab.stats = res.stats;
    // Static open: poll cursor at EOF so index catch-up is not "new"; view starts at top.
    tab.lastLine = Math.max(0, res.totalLines || 0);
    tab.viewLine = 1;
    activateTab(tab.id);
    return tab;
  } catch (err) {
    toast(`打开失败: ${err.message || err}`);
    return null;
  }
}

/** 选择器 / 拖入共用：解析本地路径 → 注册 grant → 打开。 */
async function openPickedOrDroppedFile(file, { source = "drop" } = {}) {
  const key = `${file.name}:${file.size}`;
  const existing = state.tabs.find((t) => t.dropKey === key);
  if (existing) {
    activateTab(existing.id);
    return existing;
  }
  if (!isLogFileName(file.name)) {
    toast(`已跳过：${file.name}（仅支持 .log / .txt）`);
    return null;
  }
  if (typeof bridge.getDroppedFilePath !== "function") {
    toast("当前宿主不支持解析文件路径，请使用「打开日志」选择目录");
    return null;
  }
  const path = bridge.getDroppedFilePath(file);
  if (!path) {
    toast(source === "picker" ? "无法解析所选文件路径" : "无法解析拖入文件路径");
    return null;
  }
  let grant;
  try {
    grant = await bridge.invoke("fs.registerDropped", { path });
  } catch (err) {
    toast(`${source === "picker" ? "打开" : "拖入"}文件授权失败: ${err.message || err}`);
    return null;
  }
  const adapter = createNativeAdapter();
  const tab = createTab({ mode: "native", name: file.name, adapter, saved: null });
  tab.dropKey = key;
  try {
    const res = await invoke("engine.openDropped", { path, grantId: grant.grantId });
    tab.fileId = res.fileId;
    tab.path = path; // 记录绝对路径，便于会话内展示
    tab.size = res.size;
    tab.seenSize = res.size;
    tab.totalLines = res.totalLines;
    tab.indexDone = res.indexDone;
    tab.encoding = res.encoding;
    tab.stats = res.stats;
    tab.lastLine = Math.max(0, res.totalLines || 0);
    tab.viewLine = 1;
    activateTab(tab.id);
    toast(source === "picker" ? `已打开: ${file.name}` : `已打开拖入文件: ${file.name}`);
    return tab;
  } catch (err) {
    toast(`打开失败: ${err.message || err}`);
    closeTab(tab.id);
    return null;
  }
}

async function openDroppedFile(file) {
  return openPickedOrDroppedFile(file, { source: "drop" });
}

// ---------- clipboard & context menu ----------------------------------------

async function copyLine(text, no) {
  try {
    await bridge.invoke("clipboard.writeText", { text });
    toast(`已复制 L${no}`);
  } catch (err) {
    toast(`复制失败: ${err.message || err}`);
  }
}

function openCtxMenu(e, lineText, lineNo) {
  const tab = activeTab();
  const menu = $("ctxMenu");
  const no = Number(lineNo) || null;
  const pinned = no != null && tab && (tab.pins || []).some((p) => p.no === no);
  menu.style.left = `${Math.min(e.clientX, window.innerWidth - 220)}px`;
  menu.style.top = `${Math.min(e.clientY, window.innerHeight - 140)}px`;
  menu.classList.add("show");
  $("ctxCopyLine").onclick = () => {
    menu.classList.remove("show");
    copyLine(lineText, no != null ? no : "");
  };
  $("ctxCopySel").onclick = () => {
    menu.classList.remove("show");
    const sel = String(document.getSelection());
    if (sel) bridge.invoke("clipboard.writeText", { text: sel }).then(() => toast("已复制选中内容"));
  };
  const pinBtn = $("ctxPinLine");
  pinBtn.textContent = pinned ? "取消钉住" : "钉住此行";
  pinBtn.style.display = no != null && tab ? "" : "none";
  pinBtn.onclick = () => {
    menu.classList.remove("show");
    if (!tab || no == null) return;
    if (pinned) unpinLine(tab, no);
    else pinLine(tab, no, lineText);
  };
  const jumpBtn = $("ctxClearJump");
  jumpBtn.style.display = tab && hasViewFilter(tab) && no != null ? "" : "none";
  jumpBtn.onclick = () => {
    menu.classList.remove("show");
    if (!tab || no == null) return;
    tab.preFilterLine = no;
    clearAllFilters(tab);
    toast(`已清除筛选并定位 L${no}`);
  };
}

// ---------- 钉住行 -----------------------------------------------------------

function pinLine(tab, no, text) {
  if (!tab || !no) return;
  if (!Array.isArray(tab.pins)) tab.pins = [];
  if (tab.pins.some((p) => p.no === no)) return;
  if (tab.pins.length >= MAX_PINS) {
    toast(`最多钉住 ${MAX_PINS} 行，请先取消一条`);
    return;
  }
  tab.pins.push({ no, text: String(text || "") });
  tab.pins.sort((a, b) => a.no - b.no);
  renderPins(tab);
  toast(`已钉住 L${no}`);
}

function unpinLine(tab, no) {
  if (!tab || !Array.isArray(tab.pins)) return;
  tab.pins = tab.pins.filter((p) => p.no !== no);
  renderPins(tab);
}

function renderPins(tab) {
  const bar = $("pinBar");
  if (!bar) return;
  const pins = tab && Array.isArray(tab.pins) ? tab.pins : [];
  if (!pins.length) {
    bar.textContent = "";
    bar.classList.add("hidden");
    return;
  }
  bar.classList.remove("hidden");
  bar.textContent = "";
  for (const pin of pins) {
    const row = document.createElement("div");
    row.className = "pin-row";
    row.title = "点击跳转到该行";
    const lno = document.createElement("span");
    lno.className = "pin-lno";
    lno.textContent = `L${pin.no}`;
    const tag = document.createElement("span");
    tag.className = "pin-tag";
    tag.textContent = "钉";
    const txt = document.createElement("span");
    txt.className = "pin-txt";
    txt.textContent = pin.text;
    const x = document.createElement("button");
    x.className = "pin-x";
    x.type = "button";
    x.title = "取消钉住";
    x.textContent = "✕";
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      unpinLine(tab, pin.no);
    });
    row.addEventListener("click", () => {
      hideJumpChip();
      jumpToLine(tab, pin.no).catch(() => {});
    });
    row.append(lno, tag, txt, x);
    bar.append(row);
  }
}

// ---------- theme ------------------------------------------------------------

function applyTheme(theme) {
  const next = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  applyLevelColors(next);
  const btn = $("btnTheme");
  if (btn) {
    const isDark = next === "dark";
    btn.innerHTML = isDark ? SVG_SUN : SVG_MOON;
    btn.title = isDark ? "切换到米白主题" : "切换到黑夜主题";
  }
}

function setSearchBarVisible(on, { focus = false } = {}) {
  const bar = $("searchbar");
  const toggle = $("btnToggleSearch");
  if (!bar) return;
  bar.classList.toggle("hidden", !on);
  if (toggle) toggle.classList.toggle("toggled", on);
  if (on && focus) {
    const input = $("searchInput");
    if (input) {
      input.focus();
      input.select();
    }
  }
}

function setFilterBarVisible(on, { focus = false } = {}) {
  const bar = $("filterbar");
  const toggle = $("btnToggleFilter");
  if (!bar) return;
  bar.classList.toggle("hidden", !on);
  if (toggle) toggle.classList.toggle("toggled", on);
  if (on && focus) {
    const input = $("filterInput");
    if (input) {
      input.focus();
      input.select();
    }
  }
}

function isSearchBarVisible() {
  const bar = $("searchbar");
  return Boolean(bar && !bar.classList.contains("hidden"));
}

function isFilterBarVisible() {
  const bar = $("filterbar");
  return Boolean(bar && !bar.classList.contains("hidden"));
}

function currentHostTheme() {
  return document.documentElement.classList.contains("light") ||
    (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches)
    ? "light"
    : "dark";
}

// ---------- events -----------------------------------------------------------

function applyAppearance(appearance) {
  if (state.theme) return;
  const base = appearance && appearance.base;
  if (base === "light" || base === "dark") applyTheme(base);
  else applyTheme(currentHostTheme());
}

function bindEvents() {
  $("btnAdd").addEventListener("click", openFilesFlow);
  $("btnOpenDir").addEventListener("click", openFilesFlow);
  $("btnEmptyOpen").addEventListener("click", openFilesFlow);
  $("dirClose").addEventListener("click", () => $("dirOverlay").classList.remove("show"));
  $("dirCancel").addEventListener("click", () => $("dirOverlay").classList.remove("show"));
  $("dirOpen").addEventListener("click", openSelectedFiles);
  $("btnJumpLine").addEventListener("click", promptJumpToLine);

  $("btnHead").addEventListener("click", () => {
    const tab = activeTab();
    if (!tab) return;
    if (hasViewFilter(tab)) renderFilteredReset(tab);
    else {
      tab.viewLine = 1;
      scroller.scrollTop = 0;
      renderWindow(tab, 1);
    }
  });
  $("btnTail").addEventListener("click", () => {
    const tab = activeTab();
    if (!tab || hasViewFilter(tab)) return;
    scrollToTail(tab);
  });
  $("btnFollow").addEventListener("click", () => {
    const tab = activeTab();
    if (!tab || tab.mode !== "native") return;
    setFollow(tab, !tab.follow);
  });
  $("btnFontDown").addEventListener("click", () => {
    state.fontSize = Math.max(10, state.fontSize - 1);
    applyFont();
  });
  $("btnFontUp").addEventListener("click", () => {
    state.fontSize = Math.min(22, state.fontSize + 1);
    applyFont();
  });
  $("fontFamilySel").value = state.fontFamily;
  $("fontFamilySel").addEventListener("change", () => {
    state.fontFamily = $("fontFamilySel").value;
    applyFont();
  });
  $("btnTheme").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    state.theme = next;
    localStorage.setItem("lv.theme", next);
    applyTheme(next);
    const tab = activeTab();
    if (tab) {
      if (hasViewFilter(tab)) {
        tab._fpaintKey = null;
        renderFilteredViewport(tab);
      } else if (tab.window) {
        paintRows(tab, tab.window.lines, { absolute: true });
      }
    }
  });
  $("btnSettings").addEventListener("click", openSettings);
  bindSettingsColorInputs();
  $("btnToggleSearch").addEventListener("click", () => {
    const opening = !isSearchBarVisible();
    setSearchBarVisible(opening, { focus: opening });
  });
  $("btnToggleFilter").addEventListener("click", () => {
    const opening = !isFilterBarVisible();
    setFilterBarVisible(opening, { focus: opening });
  });

  $("btnSearch").addEventListener("click", startSearch);
  $("btnPrevMatch").addEventListener("click", () => {
    const tab = activeTab();
    if (tab && tab.search) jumpMatch(tab, (tab.search.current < 0 ? tab.search.stored : tab.search.current) - 1);
  });
  $("btnNextMatch").addEventListener("click", () => {
    const tab = activeTab();
    if (tab && tab.search) jumpMatch(tab, (tab.search.current < 0 ? -1 : tab.search.current) + 1);
  });
  $("searchInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") startSearch();
  });
  $("btnSearchClear").addEventListener("click", () => {
    $("searchInput").value = "";
    clearSearch(activeTab());
  });
  $("btnSearchClose").addEventListener("click", () => setSearchBarVisible(false));

  $("btnFilter").addEventListener("click", startFilter);
  $("btnFilterClear").addEventListener("click", () => clearAllFilters(activeTab()));
  $("btnFilterClose").addEventListener("click", () => setFilterBarVisible(false));
  $("filterInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") startFilter();
  });

  for (const el of $("badges").children) {
    el.addEventListener("click", () => {
      const tab = activeTab();
      if (!tab) return;
      rememberPreFilterScroll(tab);
      const lv = el.dataset.level;
      const current = badgeState(tab, lv);
      if (!tab.levels) tab.levels = new Set();
      if (!tab.excludedLevels) tab.excludedLevels = new Set();
      if (current === "neutral") {
        tab.levels.add(lv);
      } else if (current === "include") {
        tab.levels.delete(lv);
        tab.excludedLevels.add(lv);
      } else {
        tab.excludedLevels.delete(lv);
      }
      if (!tab.levels.size) tab.levels = null;
      if (!tab.excludedLevels.size) tab.excludedLevels = null;
      if (hasViewFilter(tab)) renderFilteredReset(tab);
      else exitToUnfilteredView(tab);
      updateBadges(tab);
      updateFilterBar(tab);
      updateStatus(tab);
      scheduleSaveState();
    });
  }

  $("encodingSel").addEventListener("change", () => {
    const tab = activeTab();
    if (!tab) return;
    const enc = $("encodingSel").value;
    tab.adapter
      .setEncoding({ fileId: tab.fileId, encoding: enc })
      .then(() => {
        tab.encoding = enc;
        if (hasViewFilter(tab)) renderFilteredReset(tab);
        else exitToUnfilteredView(tab);
        scheduleSaveState();
      })
      .catch((err) => toast(`切换编码失败: ${err.message || err}`));
  });

  scroller.addEventListener("scroll", () => {
    const tab = activeTab();
    if (!tab) return;
    if (hasViewFilter(tab)) {
      tab._fpaintKey = null;
      renderFilteredViewport(tab);
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 80) {
        loadMoreFiltered(tab);
      }
      updateStatus(tab);
      return;
    }
    if (tab.follow && !atBottom()) {
      setFollow(tab, false);
      showJumpChip(0);
    }
    if (atBottom() && tab.follow) hideJumpChip();
    const from = lineAtScroll();
    tab.viewLine = from;
    if (!tab.window || Math.abs(from - tab.window.from) > Math.floor(visibleCount() / 2)) {
      renderWindow(tab, from);
    }
    updateStatus(tab);
    tab.tailSeen = Math.max(tab.tailSeen || 0, lineAtScroll() + visibleCount());
  });

  $("jumpChip").addEventListener("click", () => {
    const tab = activeTab();
    if (!tab) return;
    hideJumpChip();
    if (tab.mode === "native") setFollow(tab, true);
    else scrollToTail(tab);
  });

  // drag & drop
  let dragDepth = 0;
  document.addEventListener("dragenter", (e) => {
    e.preventDefault();
    dragDepth += 1;
    $("dropMask").style.display = "flex";
  });
  document.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $("dropMask").style.display = "none";
  });
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    dragDepth = 0;
    $("dropMask").style.display = "none";
    const files = [...((e.dataTransfer && e.dataTransfer.files) || [])];
    if (!files.length) return;
    for (const f of files) openDroppedFile(f);
  });

  // context menu dismiss
  document.addEventListener("click", (e) => {
    for (const id of ["ctxMenu"]) {
      const menu = $(id);
      if (menu.classList.contains("show") && !menu.contains(e.target)) menu.classList.remove("show");
    }
  });

  // keyboard
  document.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.shiftKey && e.key.toLowerCase() === "f") {
      e.preventDefault();
      setFilterBarVisible(true, { focus: true });
    } else if (mod && e.key.toLowerCase() === "f") {
      e.preventDefault();
      setSearchBarVisible(true, { focus: true });
    } else if (mod && e.key.toLowerCase() === "g") {
      e.preventDefault();
      promptJumpToLine();
    } else if (e.key === "F3") {
      e.preventDefault();
      const tab = activeTab();
      if (!tab || !tab.search) return;
      jumpMatch(tab, tab.search.current + (e.shiftKey ? -1 : 1));
    } else if (e.key === "Escape") {
      if ($("settingsOverlay").classList.contains("show")) {
        closeSettings();
      } else if ($("dirOverlay").classList.contains("show")) {
        $("dirOverlay").classList.remove("show");
      } else if (document.activeElement === $("searchInput")) {
        $("searchInput").blur();
      } else if (document.activeElement === $("filterInput")) {
        $("filterInput").blur();
      } else if (isSearchBarVisible()) {
        setSearchBarVisible(false);
      } else if (isFilterBarVisible()) {
        setFilterBarVisible(false);
      }
    }
  });

  bridge.on("appearance:changed", (appearance) => {
    applyAppearance(appearance);
  });
}

// ---------- persisted state --------------------------------------------------

let saveTimer = null;
function scheduleSaveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const tabs = state.tabs
      .filter((t) => t.mode !== "demo")
      .map((t) => ({
        mode: t.mode,
        path: t.path,
        name: t.name,
        size: t.size,
        line: Math.max(1, t.viewLine || t.lastLine || 1),
        encoding: t.encoding,
        follow: t.follow,
        levels: t.levels ? [...t.levels] : [],
        excludeLevels: t.excludedLevels ? [...t.excludedLevels] : [],
        filterQuery: t.filter && t.filter.query ? t.filter.query : "",
        filterIsRegex: Boolean(t.filter && t.filter.isRegex),
        filterCaseSensitive: Boolean(t.filter && t.filter.caseSensitive),
        filterInvert: Boolean(t.filter && t.filter.invert),
      }));
    try {
      await invoke("engine.saveState", { tabs, active: state.tabs.findIndex((t) => t.id === state.activeId) });
    } catch {
      // state saving is best-effort
    }
  }, 800);
}

// ---------- boot -------------------------------------------------------------

async function boot() {
  applyTheme(state.theme || currentHostTheme());
  applyFont();
  bindEvents();
  try {
    const appearance = await bridge.invoke("app.getAppearance");
    applyAppearance(appearance);
  } catch {
    // appearance channel unavailable — keep matchMedia default
  }
  try {
    const st = await invoke("engine.restoreState");
    let skipped = 0;
    for (const saved of st.tabs || []) {
      if (saved.restorable && saved.fileId) {
        const tab = createTab({ mode: "native", name: saved.name, path: saved.path, adapter: createNativeAdapter(), saved });
        tab.fileId = saved.fileId;
        tab.size = saved.size || 0;
        tab.encoding = saved.encoding || "utf-8";
        tab.follow = Boolean(saved.follow);
        tab.levels = Array.isArray(saved.levels) && saved.levels.length ? new Set(saved.levels) : null;
        tab.excludedLevels =
          Array.isArray(saved.excludeLevels) && saved.excludeLevels.length ? new Set(saved.excludeLevels) : null;
        tab.lastLine = Math.max(1, saved.line || 1);
        tab.viewLine = Math.max(1, saved.line || 1);
        tab.seenSize = saved.size || 0;
        tab.filter = saved.filterQuery
          ? {
              query: String(saved.filterQuery),
              isRegex: Boolean(saved.filterIsRegex),
              caseSensitive: Boolean(saved.filterCaseSensitive),
              invert: Boolean(saved.filterInvert),
            }
          : null;
      } else {
        skipped += 1;
      }
    }
    if (skipped) toast(`${skipped} 个上次的拖入文件需重新拖入`);
    const active = (st.tabs || [])[st.active] || state.tabs[0];
    if (active && active.id != null && state.tabs.some((t) => t.id === active.id)) {
      state.activeId = active.id;
      renderTabs();
      activateView();
    } else if (state.tabs.length) {
      state.activeId = state.tabs[0].id;
      renderTabs();
      activateView();
    } else {
      // 首次打开（无任何可恢复页签）→ 虚拟引导日志
      renderTabs();
      openDemoLog();
    }
  } catch (err) {
    toast(`恢复浏览状态失败: ${err.message || err}`);
    renderTabs();
    if (!state.tabs.length) openDemoLog();
  }
  setInterval(tick, 400);
}

boot();
