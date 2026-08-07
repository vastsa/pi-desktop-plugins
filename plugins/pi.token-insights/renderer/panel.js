/**
 * Token Insights panel.
 *
 * A panel window has no `pi` object — it reads plugin settings through
 * window.pluginBridge, which passes the same permission gate the plugin process
 * does. This file is read-only with respect to the host: it renders the fact
 * cube the plugin process published and never writes anything back.
 *
 * Filtering and aggregation are delegated to ../aggregate.js, the same module
 * the agent tool uses, so the screen and the tool cannot disagree.
 */

const bridge = window.pluginBridge;
const A = window.TokenInsightsAggregate;
const boot = window.__tokenInsightsBoot || {
  cacheKey: "tokenInsights.appearance.v1",
  applyAppearance: () => ({ base: "dark", locale: "en" }),
  prefersLight: () => false,
  themeTrail: [],
};

const FILTER_KEY = "tokenInsights.filter.v1";
const OVERRIDE_KEY = "tokenInsights.override.v1";
const SEEN_MILESTONE_KEY = "tokenInsights.milestone.v1";
/**
 * Poll cadence. A panel is its own window: it is very often visible while some
 * other window has focus, so polling follows *visibility*. Tying it to focus is
 * what makes a visible panel sit on stale state — including a "scanning" pill
 * for a scan that finished minutes ago.
 */
const POLL_MS = 1_500;
const POLL_HIDDEN_MS = 6_000;
/** A scan whose progress stopped this long ago is treated as dead, not running. */
const SCAN_STALE_MS = 30_000;
const HEAT_WEEKS = 53;
const SPARK_DAYS = 60;
const RANGES = ["7d", "30d", "90d", "1y", "all", "custom"];
const RANGE_DAYS = { "7d": 7, "30d": 30, "90d": 90, "1y": 365 };

/* --------------------------------------------------------------------- i18n */

const STRINGS = {
  en: {
    title: "Token Insights",
    /* appearance menu */
    appearance: "Appearance",
    theme: "Theme",
    language: "Language",
    followApp: "Follow app",
    light: "Light",
    dark: "Dark",
    english: "English",
    chinese: "中文",
    appearanceFollowing: (source) => `Following PI-Desktop (read from ${source}).`,
    appearanceFollowingTheme: (label) => `Following PI-Desktop theme “${label}”.`,
    appearanceUnavailable: "Could not read the app's appearance, so this panel follows your system and the choices above.",
    appearanceOverridden: "Overridden here. Choose “Follow app” to track PI-Desktop again.",
    refresh: "Reload latest data",
    /* filters */
    range7d: "7D",
    range30d: "30D",
    range90d: "90D",
    range1y: "1Y",
    rangeall: "ALL",
    rangecustom: "Custom",
    rangeLabel: "Time range",
    from: "From",
    to: "To",
    sources: "Tools",
    models: "Models",
    providers: "Providers",
    allOf: (name) => `All ${name.toLowerCase()}`,
    selectedOf: (name, count) => `${name}: ${count}`,
    searchPlaceholder: "Filter by model, provider, tool or session",
    searchModels: "Search models",
    noMatches: "No matches",
    clearFilters: "Clear filters",
    scanningCounting: "Looking for metadata files…",
    scanningFiles: (done, total) => `Reading ${done} of ${total} files…`,
    scanFailed: "Last scan failed",
    rescanHint: "Run “Token Insights: Open” from the command palette to scan again now.",
    removeFilter: (label) => `Remove filter ${label}`,
    chipRange: (label) => `Range: ${label}`,
    chipQuery: (text) => `Search: ${text}`,
    /* hero */
    greetMorning: "Good morning",
    greetAfternoon: "Good afternoon",
    greetEvening: "Good evening",
    greetNight: "Still up",
    heroFirst: "Your first tokens are on the board.",
    heroTotal: (greeting) => `${greeting} — here is what you and your tools have written.`,
    heroSub: (replies, sessions, days) =>
      `tokens · ${replies} replies · ${sessions} sessions · ${days} active ${days === 1 ? "day" : "days"}`,
    heroBest: (date, amount) => `Your best day so far was ${date}, at ${amount} tokens.`,
    heroPeak: (hour) => `You do your loudest thinking around ${hour}.`,
    heroQuiet: "Nothing in this window yet — widen the range and it will fill in.",
    deltaUp: (pct) => `+${pct}% vs previous period`,
    deltaDown: (pct) => `${pct}% vs previous period`,
    deltaFlat: "Same as the previous period",
    streakToday: (days) => `${days}-day streak`,
    streakYesterday: (days) => `${days}-day streak, through yesterday`,
    streakNone: "No streak yet",
    streakBest: (days) => `Longest ${days}`,
    streakTiedBest: "Matching your record",
    milestoneReached: (amount) => `${amount} reached`,
    milestoneOn: (date) => `on ${date}`,
    milestoneNext: (amount) => `Next milestone ${amount}`,
    milestoneRemaining: (amount) => `${amount} to go`,
    milestoneAll: "Every milestone on the board is behind you.",
    /* tiles */
    input: "Input",
    output: "Output",
    cacheRead: "Cache read",
    reasoning: "Reasoning",
    shareOfTotal: (pct) => `${pct}% of total`,
    perReply: (amount) => `${amount} per reply`,
    noneInWindow: "None in this window",
    /* blocks */
    activity: "Activity",
    activityNote: (weeks) => `last ${weeks} weeks`,
    less: "Less",
    more: "More",
    heatCell: (date, tokens) => `${date} · ${tokens} tokens`,
    heatEmpty: (date) => `${date} · no activity`,
    heatOutside: (date) => `${date} · outside the selected range`,
    modelsTitle: "Models",
    modelsNote: (count) => `${count} in this window`,
    rhythm: "Rhythm",
    rhythmNote: (from, to) => `Peak ${from}–${to}`,
    rhythmNoteEmpty: "No activity to read a rhythm from",
    sourcesTitle: "Tools",
    providersNote: (count) => `${count} providers`,
    sessionsTitle: "Busiest sessions",
    sessionsNote: (count) => `${count} sessions`,
    sessionLabel: (short) => `Session ${short}`,
    replies: (count) => `${count} replies`,
    empty: "Nothing here yet",
    /* footer */
    provenance: (files, time) => `Counted from ${files} local metadata files · never leaves this device · updated ${time}`,
    disclaimer:
      "Aggregate counts only — message content, tool arguments and project paths are never read. " +
      "Components are summed from each tool's own fields: cache reads and reasoning are already inside input and output for some tools, so the four cards can add up to more than the total.",
    /* states */
    loadingTitle: "Reading your local usage",
    loadingBody: "The first scan walks your local metadata files. This takes a few seconds.",
    emptyTitle: "Nothing counted yet",
    emptyBody:
      "Token Insights reads usage metadata recorded by PI-Desktop, Claude Code, Codex and OpenCode. Have a conversation, then rescan — this page fills itself in.",
    filteredEmptyTitle: "No usage matches these filters",
    filteredEmptyBody: "Every number would be zero. Loosen a filter, or clear them all and start again.",
    errorTitle: "Could not read the dashboard",
    errorBody: "The panel could not reach its plugin settings. Try again, or reopen the panel from the command palette.",
    retry: "Try again",
  },
  zh: {
    title: "Token Insights",
    appearance: "外观",
    theme: "主题",
    language: "语言",
    followApp: "跟随应用",
    light: "浅色",
    dark: "深色",
    english: "English",
    chinese: "中文",
    appearanceFollowing: (source) => `正在跟随 PI-Desktop（读取自 ${source}）。`,
    appearanceFollowingTheme: (label) => `正在跟随 PI-Desktop 主题“${label}”。`,
    appearanceUnavailable: "读不到应用的外观设置，本面板改为跟随系统，并可在上方手动选择。",
    appearanceOverridden: "已在此面板手动指定。选择“跟随应用”可重新跟随 PI-Desktop。",
    refresh: "刷新数据",
    range7d: "7天",
    range30d: "30天",
    range90d: "90天",
    range1y: "1年",
    rangeall: "全部",
    rangecustom: "自定义",
    rangeLabel: "时间范围",
    from: "起",
    to: "止",
    sources: "工具",
    models: "模型",
    providers: "提供商",
    allOf: (name) => `全部${name}`,
    selectedOf: (name, count) => `${name}：${count}`,
    searchPlaceholder: "按模型、提供商、工具或会话筛选",
    searchModels: "搜索模型",
    noMatches: "没有匹配项",
    clearFilters: "清除筛选",
    scanningCounting: "正在查找元数据文件…",
    scanningFiles: (done, total) => `正在读取 ${done} / ${total} 个文件…`,
    scanFailed: "上次扫描失败",
    rescanHint: "在命令面板运行“Token Insights: Open”可立即重新扫描。",
    removeFilter: (label) => `移除筛选 ${label}`,
    chipRange: (label) => `范围：${label}`,
    chipQuery: (text) => `搜索：${text}`,
    greetMorning: "早上好",
    greetAfternoon: "下午好",
    greetEvening: "晚上好",
    greetNight: "还没睡",
    heroFirst: "第一笔 token 已经记下。",
    heroTotal: (greeting) => `${greeting}，这是你和你的工具一起写下的。`,
    heroSub: (replies, sessions, days) => `tokens · ${replies} 条回复 · ${sessions} 段对话 · ${days} 个活跃日`,
    heroBest: (date, amount) => `目前最高的一天是 ${date}，${amount} tokens。`,
    heroPeak: (hour) => `你思考最密集的时段在 ${hour} 前后。`,
    heroQuiet: "这个范围内还没有数据，把范围放宽就会出现。",
    deltaUp: (pct) => `较上一周期 +${pct}%`,
    deltaDown: (pct) => `较上一周期 ${pct}%`,
    deltaFlat: "与上一周期持平",
    streakToday: (days) => `连续 ${days} 天`,
    streakYesterday: (days) => `连续 ${days} 天，停在昨天`,
    streakNone: "还没有连续记录",
    streakBest: (days) => `最长 ${days} 天`,
    streakTiedBest: "正在追平纪录",
    milestoneReached: (amount) => `已达成 ${amount}`,
    milestoneOn: (date) => `${date}`,
    milestoneNext: (amount) => `下一个里程碑 ${amount}`,
    milestoneRemaining: (amount) => `还差 ${amount}`,
    milestoneAll: "榜上的里程碑都已被你走完。",
    input: "输入",
    output: "输出",
    cacheRead: "缓存读取",
    reasoning: "推理",
    shareOfTotal: (pct) => `占总量 ${pct}%`,
    perReply: (amount) => `每条回复 ${amount}`,
    noneInWindow: "这个范围内没有",
    activity: "活动",
    activityNote: (weeks) => `最近 ${weeks} 周`,
    less: "少",
    more: "多",
    heatCell: (date, tokens) => `${date} · ${tokens} tokens`,
    heatEmpty: (date) => `${date} · 无活动`,
    heatOutside: (date) => `${date} · 不在所选范围内`,
    modelsTitle: "模型",
    modelsNote: (count) => `共 ${count} 个`,
    rhythm: "节奏",
    rhythmNote: (from, to) => `高峰 ${from}–${to}`,
    rhythmNoteEmpty: "还看不出节奏",
    sourcesTitle: "工具",
    providersNote: (count) => `${count} 个提供商`,
    sessionsTitle: "消耗最多的会话",
    sessionsNote: (count) => `${count} 段对话`,
    sessionLabel: (short) => `会话 ${short}`,
    replies: (count) => `${count} 条回复`,
    empty: "暂无数据",
    provenance: (files, time) => `统计自 ${files} 个本地元数据文件 · 数据从未离开这台设备 · ${time} 更新`,
    disclaimer:
      "仅统计聚合数量：从不读取消息正文、工具参数与项目路径。" +
      "各分项按每个工具自己的字段汇总——部分工具的缓存读取与推理已包含在输入/输出内，因此四张卡片之和可能大于总量。",
    loadingTitle: "正在读取本机用量",
    loadingBody: "首次扫描会遍历本地元数据文件，需要几秒钟。",
    emptyTitle: "还没有可统计的数据",
    emptyBody:
      "Token Insights 读取 PI-Desktop、Claude Code、Codex 与 OpenCode 记录的用量元数据。先聊几句，再重新扫描，这一页会自己长出来。",
    filteredEmptyTitle: "没有符合这些筛选条件的用量",
    filteredEmptyBody: "所有数字都会是 0。放宽某个条件，或者清除全部筛选重新开始。",
    errorTitle: "无法读取面板数据",
    errorBody: "面板读不到自己的插件设置。可以重试，或从命令面板重新打开面板。",
    retry: "重试",
  },
};

/* -------------------------------------------------------------------- state */

const state = {
  locale: "en",
  t: STRINGS.en,
  appearance: null,
  override: { theme: "auto", locale: "auto" },
  facts: null,
  scanState: null,
  summary: null,
  allTimeSummary: null,
  milestones: null,
  filter: defaultFilter(),
  openPopover: null,
  modelSearch: "",
  reduceMotion: false,
  celebrated: false,
  status: "loading",
  lastFactsAt: 0,
  lastAppearanceKey: "",
  pollTimer: null,
};

function defaultFilter() {
  return { range: "30d", from: null, to: null, sources: [], models: [], providers: [], query: "" };
}

/* ------------------------------------------------------------------ helpers */

function el(id) {
  return document.getElementById(id);
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function readStore(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeStore(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* a panel that cannot persist preferences still works */
  }
}

function intlLocale() {
  return state.locale === "zh" ? "zh-CN" : "en-US";
}

function grouped(value) {
  return Number(value || 0).toLocaleString(intlLocale());
}

function compact(value) {
  const amount = Number(value || 0);
  const abs = Math.abs(amount);
  if (abs >= 1e12) return `${(amount / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${(amount / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(amount / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(amount / 1e3).toFixed(1)}K`;
  return String(Math.round(amount));
}

function share(part, whole) {
  const total = Number(whole || 0);
  if (total <= 0) return 0;
  return Math.round((Number(part || 0) / total) * 1000) / 10;
}

function formatDay(dayKey) {
  try {
    return new Intl.DateTimeFormat(intlLocale(), { month: "short", day: "numeric" }).format(
      A.dateFromDayKey(dayKey),
    );
  } catch {
    return dayKey;
  }
}

function formatFullDay(dayKey) {
  try {
    return new Intl.DateTimeFormat(intlLocale(), { year: "numeric", month: "short", day: "numeric" }).format(
      A.dateFromDayKey(dayKey),
    );
  } catch {
    return dayKey;
  }
}

function formatHour(hour) {
  try {
    const date = new Date();
    date.setHours(hour, 0, 0, 0);
    return new Intl.DateTimeFormat(intlLocale(), { hour: "numeric", hour12: state.locale !== "zh" }).format(date);
  } catch {
    return `${hour}:00`;
  }
}

function formatTime(timestamp) {
  if (!timestamp) return "—";
  try {
    return new Intl.DateTimeFormat(intlLocale(), { dateStyle: "medium", timeStyle: "short" }).format(
      new Date(timestamp),
    );
  } catch {
    return new Date(timestamp).toISOString();
  }
}

function weekdayNames() {
  const base = new Date(2024, 0, 1); // a Monday
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(base);
    date.setDate(base.getDate() + index);
    try {
      return new Intl.DateTimeFormat(intlLocale(), { weekday: "short" }).format(date);
    } catch {
      return String(index);
    }
  });
}

function monthName(monthIndex) {
  try {
    return new Intl.DateTimeFormat(intlLocale(), { month: "short" }).format(new Date(2024, monthIndex, 1));
  } catch {
    return String(monthIndex + 1);
  }
}

/* ------------------------------------------------------------- appearance */

/**
 * Resolve the palette and language to use right now.
 *
 * Precedence: an explicit choice in this panel, then the host's own setting,
 * then the appearance this panel last saw (cached), then the OS. Falling back to
 * the cache before the OS is what keeps a reopen from flashing a palette the
 * host does not use.
 */
function resolveAppearance() {
  const host = state.appearance;
  const override = state.override;
  const cached = boot.cached;
  const hostBase = host?.ok ? host.base : cached?.base || "system";
  const themeFromHost = hostBase === "light" || hostBase === "dark" ? hostBase : boot.prefersLight() ? "light" : "dark";
  const base = override.theme === "auto" ? themeFromHost : override.theme;
  const cachedTheme =
    !host?.ok && cached?.pluginThemeCss ? { id: cached.pluginThemeId, css: cached.pluginThemeCss } : null;
  const theme = host?.ok ? host.pluginTheme : cachedTheme;
  const usePluginTheme = override.theme === "auto" && Boolean(theme);
  const localeFromHost = String(host?.locale || "").toLowerCase().startsWith("zh") ? "zh" : "en";
  const locale =
    override.locale === "auto"
      ? host?.ok
        ? localeFromHost
        : cached?.locale || navigatorLocale()
      : override.locale;
  return {
    base,
    locale,
    pluginThemeId: usePluginTheme ? theme.id : null,
    pluginThemeCss: usePluginTheme ? theme.css : null,
  };
}

function navigatorLocale() {
  const tag = String(navigator.language || "en").toLowerCase();
  return tag.startsWith("zh") ? "zh" : "en";
}

function applyAppearance(reveal) {
  const resolved = resolveAppearance();
  boot.applyAppearance(resolved);
  boot.themeTrail.push(document.documentElement.dataset.theme || "(unset)");
  // Cached so the next open paints the right palette before any script runs.
  writeStore(boot.cacheKey, resolved);
  state.locale = resolved.locale;
  state.t = STRINGS[resolved.locale] || STRINGS.en;
  if (reveal) revealContent();
}

/**
 * Content is cloaked until the appearance is final.
 *
 * On a first-ever open there is no cached palette, and guessing one would mean
 * painting a theme we then correct in front of the user. A blank moment of a few
 * hundred milliseconds is the honest alternative.
 */
function revealContent() {
  document.documentElement.dataset.booting = "false";
}

/* ------------------------------------------------------- window chrome ---- */

/**
 * The host may or may not honour `ui.frame: false`. A frameless window has no
 * native title strip, which on macOS is exactly where the traffic lights are —
 * so the lead padding is reserved only in that case, detected at runtime.
 */
function detectChrome() {
  const platform = /mac/i.test(navigator.platform || navigator.userAgent) ? "mac" : /win/i.test(navigator.platform || "") ? "win" : "other";
  const outer = Number(window.outerHeight) || 0;
  const inner = Number(window.innerHeight) || 0;
  const chromeHeight = outer - inner;
  document.documentElement.dataset.platform = platform;
  document.documentElement.dataset.chrome = outer > 0 && chromeHeight <= 2 ? "frameless" : "framed";
}

/* ----------------------------------------------------------------- filters */

function loadFilter() {
  const stored = readStore(FILTER_KEY, null);
  if (!stored || typeof stored !== "object") return defaultFilter();
  const base = defaultFilter();
  return {
    range: RANGES.includes(stored.range) ? stored.range : base.range,
    from: typeof stored.from === "string" ? stored.from : null,
    to: typeof stored.to === "string" ? stored.to : null,
    sources: Array.isArray(stored.sources) ? stored.sources.map(String) : [],
    models: Array.isArray(stored.models) ? stored.models.map(String) : [],
    providers: Array.isArray(stored.providers) ? stored.providers.map(String) : [],
    query: typeof stored.query === "string" ? stored.query : "",
  };
}

function saveFilter() {
  writeStore(FILTER_KEY, state.filter);
}

function filterIsDefault() {
  const filter = state.filter;
  return (
    filter.range === "30d" &&
    !filter.sources.length &&
    !filter.models.length &&
    !filter.providers.length &&
    !filter.query
  );
}

/** UI filter → aggregate filter (inclusive day keys). */
function aggregateFilter() {
  const filter = state.filter;
  const today = A.todayKey();
  let sinceDay = null;
  let untilDay = null;
  if (filter.range === "custom") {
    sinceDay = filter.from || null;
    untilDay = filter.to || null;
    if (sinceDay && untilDay && sinceDay > untilDay) {
      const swap = sinceDay;
      sinceDay = untilDay;
      untilDay = swap;
    }
  } else if (RANGE_DAYS[filter.range]) {
    sinceDay = A.shiftDayKey(today, -(RANGE_DAYS[filter.range] - 1));
    untilDay = today;
  }
  return {
    sinceDay,
    untilDay,
    sources: filter.sources,
    models: filter.models,
    providers: filter.providers,
    query: filter.query,
  };
}

function recompute() {
  if (!state.facts) {
    state.summary = null;
    state.allTimeSummary = null;
    state.milestones = null;
    return;
  }
  state.summary = A.aggregate(state.facts, aggregateFilter());
  state.allTimeSummary = A.aggregate(state.facts, {}, { withPrevious: false });
  state.milestones = A.milestones(state.facts);
}

/* ------------------------------------------------------------------ render */

/**
 * Is a scan actually running? A plugin process that died mid-scan leaves
 * `scanning` behind forever, so a state that stopped moving is not a scan.
 */
function scanIsLive() {
  const scan = state.scanState;
  if (scan?.status !== "scanning") return false;
  const at = Number(scan.updatedAt || scan.startedAt || 0);
  return at > 0 && Date.now() - at < SCAN_STALE_MS;
}

function setStatus() {
  const hasFacts = Boolean(state.facts && state.facts.buckets.length);
  const scanning = scanIsLive();
  if (state.status === "error") return "error";
  if (!state.facts) return scanning || state.status === "loading" ? "loading" : "empty";
  if (!hasFacts) return scanning ? "loading" : "empty";
  if (!state.summary || state.summary.totals.total === 0) {
    return filterIsDefault() ? "empty" : "filtered-empty";
  }
  return "ready";
}

function renderState(kind) {
  const t = state.t;
  const box = el("stateBox");
  const actions = el("stateActions");
  clear(actions);
  const show = (title, body) => {
    el("stateTitle").textContent = title;
    el("stateBody").textContent = body;
    box.hidden = false;
  };
  box.hidden = true;
  el("skeleton").hidden = true;
  el("content").hidden = true;

  if (kind === "loading") {
    el("skeleton").hidden = false;
    return;
  }
  if (kind === "empty") {
    show(t.emptyTitle, `${t.emptyBody} ${t.rescanHint}`);
    const retry = make("button", "primary-button", t.refresh);
    retry.type = "button";
    retry.addEventListener("click", () => void poll(true));
    actions.appendChild(retry);
    return;
  }
  if (kind === "filtered-empty") {
    show(t.filteredEmptyTitle, t.filteredEmptyBody);
    const clearButton = make("button", "primary-button", t.clearFilters);
    clearButton.type = "button";
    clearButton.addEventListener("click", () => {
      state.filter = defaultFilter();
      saveFilter();
      recompute();
      render();
    });
    actions.appendChild(clearButton);
    return;
  }
  if (kind === "error") {
    show(t.errorTitle, t.errorBody);
    const retry = make("button", "primary-button", t.retry);
    retry.type = "button";
    retry.addEventListener("click", () => void poll(true));
    actions.appendChild(retry);
    return;
  }
  el("content").hidden = false;
}

function renderStaticText() {
  const t = state.t;
  document.title = t.title;
  el("appTitle").textContent = t.title;
  el("refreshBtn").title = t.refresh;
  el("refreshBtn").setAttribute("aria-label", t.refresh);
  el("appearanceBtn").title = t.appearance;
  el("appearanceBtn").setAttribute("aria-label", t.appearance);
  el("menuThemeLabel").textContent = t.theme;
  el("menuLangLabel").textContent = t.language;
  el("rangeSwitch").setAttribute("aria-label", t.rangeLabel);
  el("queryInput").placeholder = t.searchPlaceholder;
  el("queryInput").setAttribute("aria-label", t.searchPlaceholder);
  el("modelSearch").placeholder = t.searchModels;
  el("modelSearch").setAttribute("aria-label", t.searchModels);
  el("customFrom").setAttribute("aria-label", t.from);
  el("customTo").setAttribute("aria-label", t.to);
  el("clearFilters").textContent = t.clearFilters;
  el("activityTitle").textContent = t.activity;
  el("modelsTitle").textContent = t.modelsTitle;
  el("rhythmTitle").textContent = t.rhythm;
  el("sourcesTitle").textContent = t.sourcesTitle;
  el("sessionsTitle").textContent = t.sessionsTitle;
  el("legendLess").textContent = t.less;
  el("legendMore").textContent = t.more;
  el("tileInputLabel").textContent = t.input;
  el("tileOutputLabel").textContent = t.output;
  el("tileCacheLabel").textContent = t.cacheRead;
  el("tileReasoningLabel").textContent = t.reasoning;
  el("heatmap").setAttribute("aria-label", t.activity);
}

function renderAppearanceMenu() {
  const t = state.t;
  const themeRow = el("themeChoices");
  const langRow = el("langChoices");
  clear(themeRow);
  clear(langRow);

  const choice = (row, label, active, onPick) => {
    const button = make("button", "segment", label);
    button.type = "button";
    button.setAttribute("aria-pressed", active ? "true" : "false");
    button.addEventListener("click", onPick);
    row.appendChild(button);
  };

  choice(themeRow, t.followApp, state.override.theme === "auto", () => setOverride("theme", "auto"));
  choice(themeRow, t.light, state.override.theme === "light", () => setOverride("theme", "light"));
  choice(themeRow, t.dark, state.override.theme === "dark", () => setOverride("theme", "dark"));
  choice(langRow, t.followApp, state.override.locale === "auto", () => setOverride("locale", "auto"));
  choice(langRow, t.english, state.override.locale === "en", () => setOverride("locale", "en"));
  choice(langRow, t.chinese, state.override.locale === "zh", () => setOverride("locale", "zh"));

  const host = state.appearance;
  const overridden = state.override.theme !== "auto" || state.override.locale !== "auto";
  el("appearanceNote").textContent = overridden
    ? t.appearanceOverridden
    : host?.ok
      ? host.pluginTheme
        ? t.appearanceFollowingTheme(host.pluginTheme.label)
        : t.appearanceFollowing(host.source === "sqlite" ? "pi.sqlite" : String(host.source || "pi.sqlite"))
      : t.appearanceUnavailable;
}

function setOverride(key, value) {
  state.override = { ...state.override, [key]: value };
  writeStore(OVERRIDE_KEY, state.override);
  applyAppearance(true);
  render();
}

/**
 * The custom from/to pair is also the readout of whatever window is selected.
 * Keeping it in step means the fields never contradict the segmented control,
 * and switching to Custom starts from the window you were just looking at.
 */
function windowForRange(range) {
  const today = A.todayKey();
  if (RANGE_DAYS[range]) {
    return { from: A.shiftDayKey(today, -(RANGE_DAYS[range] - 1)), to: today };
  }
  if (range === "all") {
    return { from: state.facts?.days?.[0] || today, to: today };
  }
  return { from: state.filter.from, to: state.filter.to };
}

function renderRanges() {
  const t = state.t;
  const row = el("rangeSwitch");
  clear(row);
  for (const range of RANGES) {
    const button = make("button", "segment", t[`range${range}`]);
    button.type = "button";
    button.dataset.range = range;
    button.setAttribute("aria-pressed", state.filter.range === range ? "true" : "false");
    button.addEventListener("click", () => {
      if (state.filter.range === range) return;
      state.filter.range = range;
      if (range !== "custom") {
        const bounds = windowForRange(range);
        state.filter.from = bounds.from;
        state.filter.to = bounds.to;
      }
      saveFilter();
      recompute();
      render();
    });
    row.appendChild(button);
  }
  const custom = state.filter.range === "custom";
  el("customRange").hidden = !custom;
  // Filled in for every range, not only the custom one: if the fields are ever
  // visible they must already say what the page is showing.
  const shown = custom ? { from: state.filter.from, to: state.filter.to } : windowForRange(state.filter.range);
  el("customFrom").value = shown.from || "";
  el("customTo").value = shown.to || "";
  el("customFrom").max = A.todayKey();
  el("customTo").max = A.todayKey();
}

function optionCounts(dimension) {
  // Counts come from the same window with this dimension released, so a user can
  // see what selecting an option would bring in rather than a global number.
  if (!state.facts) return new Map();
  const filter = { ...aggregateFilter(), [dimension]: [] };
  const summary = A.aggregate(state.facts, filter, { withPrevious: false });
  const rows = summary[dimension] || [];
  return new Map(rows.map((row) => [String(row.id ?? row.label), row.total]));
}

function renderPicker(dimension, buttonId, popId, listHost, labelKey) {
  const t = state.t;
  const button = el(buttonId);
  const pop = el(popId);
  const selected = state.filter[dimension];
  const name = t[labelKey];
  button.textContent = selected.length ? t.selectedOf(name, selected.length) : t.allOf(name);
  button.classList.toggle("is-set", selected.length > 0);
  button.setAttribute("aria-expanded", state.openPopover === dimension ? "true" : "false");
  button.setAttribute("aria-label", `${name}: ${selected.length ? selected.join(", ") : t.allOf(name)}`);
  pop.hidden = state.openPopover !== dimension;

  const host = listHost ? el(listHost) : pop;
  clear(host);
  if (!state.facts) return;

  const counts = optionCounts(dimension);
  // Sources and providers carry a resolved label; models are already readable.
  const entries =
    dimension === "models"
      ? state.facts.models.map((value) => ({ id: value, label: value }))
      : state.facts[dimension].map((entry) => ({ id: entry.id, label: entry.label }));

  const search = dimension === "models" ? state.modelSearch.trim().toLowerCase() : "";
  const visible = entries
    .filter((entry) => !search || entry.label.toLowerCase().includes(search))
    .sort((left, right) => (counts.get(right.id) || 0) - (counts.get(left.id) || 0));

  if (!visible.length) {
    host.appendChild(make("div", "option-empty", t.noMatches));
    return;
  }

  for (const entry of visible) {
    const option = make("button", "option");
    option.type = "button";
    const active = selected.includes(entry.id);
    option.setAttribute("aria-pressed", active ? "true" : "false");
    option.appendChild(make("span", "box"));
    option.appendChild(make("span", "label", entry.label));
    option.appendChild(make("span", "count", compact(counts.get(entry.id) || 0)));
    option.addEventListener("click", () => {
      const next = new Set(state.filter[dimension]);
      if (next.has(entry.id)) next.delete(entry.id);
      else next.add(entry.id);
      state.filter[dimension] = [...next];
      saveFilter();
      recompute();
      render();
    });
    host.appendChild(option);
  }
}

function renderChips() {
  const t = state.t;
  const row = el("chipRow");
  clear(row);
  const chips = [];

  if (state.filter.range !== "30d") {
    const label =
      state.filter.range === "custom"
        ? `${state.filter.from || "…"} → ${state.filter.to || "…"}`
        : t[`range${state.filter.range}`];
    chips.push({ label: t.chipRange(label), remove: () => {
      state.filter.range = "30d";
    } });
  }
  for (const dimension of ["sources", "models", "providers"]) {
    for (const value of state.filter[dimension]) {
      const label =
        dimension === "models"
          ? value
          : state.facts?.[dimension]?.find((entry) => entry.id === value)?.label || value;
      chips.push({
        label,
        remove: () => {
          state.filter[dimension] = state.filter[dimension].filter((item) => item !== value);
        },
      });
    }
  }
  if (state.filter.query) {
    chips.push({ label: t.chipQuery(state.filter.query), remove: () => {
      state.filter.query = "";
      el("queryInput").value = "";
    } });
  }

  row.hidden = chips.length === 0;
  for (const chip of chips) {
    const node = make("span", "chip");
    node.appendChild(make("span", null, chip.label));
    const button = make("button", null, "×");
    button.type = "button";
    button.setAttribute("aria-label", t.removeFilter(chip.label));
    button.addEventListener("click", () => {
      chip.remove();
      saveFilter();
      recompute();
      render();
    });
    node.appendChild(button);
    row.appendChild(node);
  }
  el("clearFilters").hidden = filterIsDefault();
}

function greeting() {
  const t = state.t;
  const hour = new Date().getHours();
  if (hour < 5) return t.greetNight;
  if (hour < 12) return t.greetMorning;
  if (hour < 18) return t.greetAfternoon;
  return t.greetEvening;
}

function animateNumber(node, value) {
  const target = Number(value || 0);
  if (state.reduceMotion) {
    node.textContent = grouped(target);
    return;
  }
  const start = performance.now();
  const duration = 620;
  const step = (now) => {
    const progress = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    node.textContent = grouped(Math.round(target * eased));
    if (progress < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function renderHero() {
  const t = state.t;
  const summary = state.summary;
  const totals = summary.totals;

  el("heroGreeting").textContent = totals.total > 0 ? t.heroTotal(greeting()) : t.heroFirst;
  animateNumber(el("heroNumber"), totals.total);
  el("heroSub").textContent = t.heroSub(grouped(totals.messages), grouped(totals.sessions), grouped(totals.activeDays));

  const notes = [];
  if (summary.bestDay) notes.push(t.heroBest(formatFullDay(summary.bestDay.date), compact(summary.bestDay.total)));
  if (summary.peakHour != null) notes.push(t.heroPeak(formatHour(summary.peakHour)));
  el("heroNote").textContent = notes.join(" ") || t.heroQuiet;

  const delta = el("heroDelta");
  if (summary.deltaPct == null) {
    delta.hidden = true;
  } else {
    delta.hidden = false;
    const pct = summary.deltaPct;
    delta.textContent = pct > 0 ? t.deltaUp(pct) : pct < 0 ? t.deltaDown(pct) : t.deltaFlat;
    delta.classList.toggle("is-up", pct > 0);
    delta.classList.toggle("is-down", pct < 0);
  }

  renderBadges();
  renderSparkline();
  renderMilestone();
}

function renderBadges() {
  const t = state.t;
  const host = el("heroBadges");
  clear(host);
  // The streak is a property of the person, not of the current filter, so it is
  // read from the all-time cube.
  const streak = state.allTimeSummary?.streak;
  if (streak) {
    const badge = make("span", "badge is-streak");
    const label =
      streak.current === 0
        ? t.streakNone
        : streak.includesToday
          ? t.streakToday(streak.current)
          : t.streakYesterday(streak.current);
    badge.appendChild(make("span", null, label));
    if (streak.longest > 0) {
      const best =
        streak.current > 0 && streak.current >= streak.longest ? t.streakTiedBest : t.streakBest(streak.longest);
      badge.appendChild(make("strong", null, best));
    }
    host.appendChild(badge);
  }

  const latest = state.milestones?.latest;
  if (latest) {
    const badge = make("span", "badge");
    badge.appendChild(make("span", null, t.milestoneReached(compact(latest.threshold))));
    badge.appendChild(make("strong", null, t.milestoneOn(formatDay(latest.date))));
    // Celebrate a milestone the first time this panel sees it, once, and never
    // again — a party that repeats on every open is noise, not delight.
    const seen = readStore(SEEN_MILESTONE_KEY, 0);
    if (!state.celebrated && Number(seen) < latest.threshold) {
      badge.classList.add("is-celebrating");
      writeStore(SEEN_MILESTONE_KEY, latest.threshold);
      state.celebrated = true;
    }
    host.appendChild(badge);
  }
}

function renderSparkline() {
  const host = el("sparkline");
  clear(host);
  const daily = state.summary.daily;
  if (!daily.length) return;
  const series = daily.slice(-SPARK_DAYS);
  const max = series.reduce((best, entry) => Math.max(best, entry.total), 0) || 1;
  for (const entry of series) {
    const bar = make("i");
    bar.style.height = `${Math.max(2, Math.round((entry.total / max) * 100))}%`;
    if (entry.total === max) bar.classList.add("is-peak");
    bar.title = state.t.heatCell(formatFullDay(entry.date), grouped(entry.total));
    host.appendChild(bar);
  }
}

function renderMilestone() {
  const t = state.t;
  const box = el("milestoneBox");
  const next = state.milestones?.next;
  if (!next) {
    if (state.milestones?.reached?.length) {
      box.hidden = false;
      el("milestoneLabel").textContent = t.milestoneAll;
      el("milestoneRemaining").textContent = "";
      el("milestoneBar").style.width = "100%";
      return;
    }
    box.hidden = true;
    return;
  }
  box.hidden = false;
  el("milestoneLabel").textContent = t.milestoneNext(compact(next.threshold));
  el("milestoneRemaining").textContent = t.milestoneRemaining(compact(next.remaining));
  el("milestoneBar").style.width = `${Math.max(2, Math.min(100, Math.round(next.progress * 100)))}%`;
}

function renderTiles() {
  const t = state.t;
  const totals = state.summary.totals;
  const rows = [
    ["tileInput", "tileInputNote", totals.input],
    ["tileOutput", "tileOutputNote", totals.output],
    ["tileCache", "tileCacheNote", totals.cacheRead],
    ["tileReasoning", "tileReasoningNote", totals.reasoning],
  ];
  for (const [valueId, noteId, amount] of rows) {
    el(valueId).textContent = compact(amount);
    el(valueId).title = grouped(amount);
    el(noteId).textContent = amount > 0 ? t.shareOfTotal(share(amount, totals.total)) : t.noneInWindow;
  }
}

function heatLevels(values) {
  const sorted = values.filter((value) => value > 0).sort((left, right) => left - right);
  if (!sorted.length) return [0, 0, 0, 0];
  const at = (ratio) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
  return [at(0.25), at(0.5), at(0.75), at(0.92)];
}

function renderHeatmap() {
  const t = state.t;
  const grid = el("heatmap");
  const days = el("heatDays");
  const months = el("heatMonths");
  clear(grid);
  clear(days);
  clear(months);

  const names = weekdayNames();
  names.forEach((name, index) => {
    days.appendChild(make("span", null, index % 2 === 0 ? name : ""));
  });

  const today = A.dateFromDayKey(A.todayKey());
  // Grid starts on the Monday HEAT_WEEKS-1 weeks before this week's Monday.
  const offsetToMonday = (today.getDay() + 6) % 7;
  const start = new Date(today);
  start.setDate(today.getDate() - offsetToMonday - (HEAT_WEEKS - 1) * 7);

  const dailyMap = state.summary.dailyMap;
  const values = [...dailyMap.values()].map((entry) => entry.total);
  const thresholds = heatLevels(values);
  const filter = aggregateFilter();
  const todayKey = A.todayKey();
  let lastMonth = -1;

  for (let week = 0; week < HEAT_WEEKS; week += 1) {
    const weekStart = new Date(start);
    weekStart.setDate(start.getDate() + week * 7);
    const month = weekStart.getMonth();
    const label = make("span", null, month === lastMonth ? "" : monthName(month));
    label.style.width = `calc(var(--heat-cell) + var(--heat-gap))`;
    months.appendChild(label);
    lastMonth = month;
  }

  for (let week = 0; week < HEAT_WEEKS; week += 1) {
    for (let day = 0; day < 7; day += 1) {
      const date = new Date(start);
      date.setDate(start.getDate() + week * 7 + day);
      const key = A.dayKeyFromDate(date);
      const cell = make("i");
      const entry = dailyMap.get(key);
      const outside =
        key > todayKey ||
        (filter.sinceDay && key < filter.sinceDay) ||
        (filter.untilDay && key > filter.untilDay);
      const total = entry?.total || 0;
      const level = total <= 0 ? 0 : total <= thresholds[0] ? 1 : total <= thresholds[1] ? 2 : total <= thresholds[2] ? 3 : 4;
      cell.dataset.level = String(level);
      if (outside) cell.classList.add("is-out");
      if (key === todayKey) cell.classList.add("is-today");
      cell.dataset.tip = outside
        ? t.heatOutside(formatFullDay(key))
        : total > 0
          ? t.heatCell(formatFullDay(key), grouped(total))
          : t.heatEmpty(formatFullDay(key));
      grid.appendChild(cell);
    }
  }

  el("streakNote").textContent = t.activityNote(HEAT_WEEKS);
  el("heatTip").textContent = "";
  // Newest weeks matter most; start the viewport there when it overflows.
  const scroller = el("heatScroll");
  requestAnimationFrame(() => {
    scroller.scrollLeft = scroller.scrollWidth;
  });
}

function renderRanking(hostId, rows, options = {}) {
  const t = state.t;
  const host = el(hostId);
  clear(host);
  const limit = options.limit || 8;
  const visible = rows.slice(0, limit);
  if (!visible.length) {
    host.appendChild(make("div", "empty-row", t.empty));
    return;
  }
  const max = visible.reduce((best, row) => Math.max(best, row.total), 0) || 1;
  for (const row of visible) {
    const node = make("div", "row");
    const label = make("div", "row-label");
    label.appendChild(make("span", null, options.label ? options.label(row) : row.label));
    if (options.sub) {
      const sub = make("span", "muted", ` ${options.sub(row)}`);
      label.appendChild(sub);
    }
    label.title = `${options.label ? options.label(row) : row.label} · ${grouped(row.total)}`;
    node.appendChild(label);
    node.appendChild(make("div", "row-value", `${compact(row.total)} · ${share(row.total, state.summary.totals.total)}%`));
    const bar = make("div", "row-bar");
    const fill = make("i");
    fill.style.width = `${Math.max(1, Math.round((row.total / max) * 100))}%`;
    bar.appendChild(fill);
    node.appendChild(bar);
    host.appendChild(node);
  }
}

function renderRhythm() {
  const t = state.t;
  const summary = state.summary;
  const clock = el("clock");
  const axis = el("clockAxis");
  const week = el("weekbar");
  clear(clock);
  clear(axis);
  clear(week);

  const max = summary.hourly.reduce((best, entry) => Math.max(best, entry.total), 0) || 1;
  summary.hourly.forEach((entry, hour) => {
    const bar = make("i");
    bar.style.height = `${Math.max(2, Math.round((entry.total / max) * 100))}%`;
    if (summary.peakHour === hour) bar.classList.add("is-peak");
    bar.title = `${formatHour(hour)} · ${grouped(entry.total)}`;
    clock.appendChild(bar);
  });
  for (const hour of [0, 6, 12, 18, 23]) axis.appendChild(make("span", null, formatHour(hour)));

  const names = weekdayNames();
  const weekMax = summary.weekday.reduce((best, entry) => Math.max(best, entry.total), 0) || 1;
  summary.weekday.forEach((entry, index) => {
    const cell = make("div");
    if (summary.peakWeekday === index) cell.classList.add("is-peak");
    const bar = make("span");
    bar.style.opacity = String(Math.max(0.25, entry.total / weekMax));
    cell.appendChild(bar);
    cell.appendChild(make("span", null, names[index]));
    cell.title = `${names[index]} · ${grouped(entry.total)}`;
    week.appendChild(cell);
  });

  el("rhythmNote").textContent =
    summary.peakHour == null
      ? t.rhythmNoteEmpty
      : t.rhythmNote(formatHour(summary.peakHour), formatHour((summary.peakHour + 1) % 24));
}

function renderFooter() {
  const t = state.t;
  const facts = state.facts;
  el("provenanceLine").textContent = t.provenance(
    grouped(facts.diagnostics?.filesScanned || 0),
    formatTime(facts.generatedAt),
  );
  el("disclaimerLine").textContent = t.disclaimer;
}

function renderScanProgress() {
  const t = state.t;
  const scan = state.scanState;
  const live = scanIsLive();
  const pill = el("scanPill");
  const bar = el("scanBar");
  const fill = el("scanBarFill");
  pill.hidden = !live;
  bar.hidden = !live;
  el("refreshBtn").classList.toggle("is-busy", live);
  if (!live) {
    // A failed scan is worth one quiet line; a stale one is worth nothing.
    if (scan?.status === "failed") {
      pill.hidden = false;
      pill.classList.add("is-error");
      pill.textContent = t.scanFailed;
    } else {
      pill.classList.remove("is-error");
      // Emptied as well as hidden: a stale sentence must not be one CSS mistake
      // away from being back on screen.
      pill.textContent = "";
      fill.style.width = "0";
    }
    return;
  }
  pill.classList.remove("is-error");
  const total = Number(scan.filesTotal || 0);
  const done = Math.min(Number(scan.filesScanned || 0), total || Infinity);
  if (total > 0) {
    pill.textContent = t.scanningFiles(grouped(done), grouped(total));
    fill.style.width = `${Math.max(2, Math.round((done / total) * 100))}%`;
    bar.dataset.determinate = "true";
  } else {
    // Before the file lists come back there is no honest percentage to show.
    pill.textContent = t.scanningCounting;
    fill.style.width = "100%";
    bar.dataset.determinate = "false";
  }
}

function render() {
  renderStaticText();
  renderAppearanceMenu();
  renderRanges();
  renderPicker("sources", "sourceBtn", "sourcePop", null, "sources");
  renderPicker("models", "modelBtn", "modelPop", "modelList", "models");
  renderPicker("providers", "providerBtn", "providerPop", null, "providers");
  renderChips();
  renderScanProgress();
  el("appearanceBtn").setAttribute("aria-expanded", state.openPopover === "appearance" ? "true" : "false");
  el("appearanceMenu").hidden = state.openPopover !== "appearance";

  const kind = setStatus();
  renderState(kind);
  if (kind !== "ready") return;

  const t = state.t;
  renderHero();
  renderTiles();
  renderHeatmap();
  renderRanking("modelRanking", state.summary.models, { sub: (row) => t.replies(grouped(row.messages)) });
  el("modelsNote").textContent = t.modelsNote(state.summary.models.length);
  renderRhythm();
  renderRanking("sourceRanking", state.summary.sources, { limit: 6 });
  renderRanking("providerRanking", state.summary.providers, { limit: 5 });
  el("providersNote").textContent = t.providersNote(state.summary.providers.length);
  renderRanking("sessionRanking", state.summary.sessions, {
    limit: 8,
    label: (row) => t.sessionLabel(row.label),
    sub: (row) => row.sourceLabel,
  });
  el("sessionsNote").textContent = t.sessionsNote(grouped(state.summary.totals.sessions));
  renderFooter();
}

/* ------------------------------------------------------------------- data */

function appearanceKey(appearance) {
  if (!appearance) return "none";
  return JSON.stringify([
    appearance.ok,
    appearance.themePreference,
    appearance.base,
    appearance.locale,
    appearance.pluginTheme?.id ?? null,
    appearance.pluginTheme?.css?.length ?? 0,
  ]);
}

async function poll(force) {
  let settings;
  try {
    settings = await bridge.invoke("plugin.getSettings");
  } catch {
    state.status = "error";
    render();
    return;
  }
  state.status = "ok";

  const appearance = settings?.hostAppearance || null;
  const key = appearanceKey(appearance);
  let dirty = Boolean(force);
  if (key !== state.lastAppearanceKey) {
    state.lastAppearanceKey = key;
    state.appearance = appearance;
    // The host's answer is final, so this is also the moment to unveil.
    applyAppearance(true);
    dirty = true;
  }

  const scanKey = JSON.stringify(settings?.scanState || null);
  if (scanKey !== JSON.stringify(state.scanState || null)) {
    state.scanState = settings?.scanState || null;
    dirty = true;
  }

  const facts = settings?.usageFacts;
  if (A.isFacts(facts) && facts.generatedAt !== state.lastFactsAt) {
    state.lastFactsAt = facts.generatedAt;
    state.facts = facts;
    // Selections that no longer exist in a fresh cube would silently filter
    // everything out; drop them instead.
    pruneFilter();
    recompute();
    dirty = true;
  } else if (!A.isFacts(facts) && state.facts) {
    state.facts = null;
    state.summary = null;
    dirty = true;
  }

  if (dirty) render();
}

function pruneFilter() {
  const facts = state.facts;
  if (!facts) return;
  const sourceIds = new Set(facts.sources.map((entry) => entry.id));
  const models = new Set(facts.models);
  const providers = new Set(facts.providers.map((entry) => entry.id));
  const before = JSON.stringify([state.filter.sources, state.filter.models, state.filter.providers]);
  state.filter.sources = state.filter.sources.filter((id) => sourceIds.has(id));
  state.filter.models = state.filter.models.filter((id) => models.has(id));
  state.filter.providers = state.filter.providers.filter((id) => providers.has(id));
  if (JSON.stringify([state.filter.sources, state.filter.models, state.filter.providers]) !== before) saveFilter();
}

function startPolling() {
  stopPolling();
  const cadence = document.hidden ? POLL_HIDDEN_MS : POLL_MS;
  state.pollCadence = cadence;
  state.pollTimer = window.setInterval(() => void poll(false), cadence);
}

function stopPolling() {
  if (state.pollTimer) window.clearInterval(state.pollTimer);
  state.pollTimer = null;
}

/* ----------------------------------------------------------------- events */

function closePopovers() {
  if (!state.openPopover) return;
  state.openPopover = null;
  render();
}

function bindEvents() {
  el("refreshBtn").addEventListener("click", () => void poll(true));

  el("appearanceBtn").addEventListener("click", (event) => {
    event.stopPropagation();
    state.openPopover = state.openPopover === "appearance" ? null : "appearance";
    render();
  });

  for (const [dimension, buttonId] of [
    ["sources", "sourceBtn"],
    ["models", "modelBtn"],
    ["providers", "providerBtn"],
  ]) {
    el(buttonId).addEventListener("click", (event) => {
      event.stopPropagation();
      state.openPopover = state.openPopover === dimension ? null : dimension;
      if (state.openPopover === "models") state.modelSearch = "";
      render();
      if (state.openPopover === "models") el("modelSearch").focus();
    });
  }

  for (const id of ["appearanceMenu", "sourcePop", "modelPop", "providerPop"]) {
    el(id).addEventListener("click", (event) => event.stopPropagation());
  }

  el("modelSearch").addEventListener("input", (event) => {
    state.modelSearch = event.target.value;
    renderPicker("models", "modelBtn", "modelPop", "modelList", "models");
  });

  let queryTimer = null;
  el("queryInput").addEventListener("input", (event) => {
    const value = event.target.value;
    if (queryTimer) window.clearTimeout(queryTimer);
    queryTimer = window.setTimeout(() => {
      state.filter.query = value;
      saveFilter();
      recompute();
      render();
    }, 180);
  });

  for (const [id, key] of [["customFrom", "from"], ["customTo", "to"]]) {
    el(id).addEventListener("change", (event) => {
      state.filter[key] = event.target.value || null;
      state.filter.range = "custom";
      saveFilter();
      recompute();
      render();
    });
  }

  el("clearFilters").addEventListener("click", () => {
    state.filter = defaultFilter();
    state.modelSearch = "";
    el("queryInput").value = "";
    saveFilter();
    recompute();
    render();
  });

  el("heatmap").addEventListener("mouseover", (event) => {
    const tip = event.target?.dataset?.tip;
    if (tip) el("heatTip").textContent = tip;
  });
  el("heatmap").addEventListener("mouseleave", () => {
    el("heatTip").textContent = "";
  });

  document.addEventListener("click", closePopovers);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closePopovers();
  });

  window.addEventListener("resize", () => detectChrome());
  // Coming back to the window should feel instant; leaving it only slows the
  // cadence down, so a visible-but-unfocused panel never freezes.
  window.addEventListener("focus", () => void poll(false));
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void poll(false);
    startPolling();
  });
}

/* -------------------------------------------------------------------- init */

async function init() {
  state.reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  state.override = readStore(OVERRIDE_KEY, { theme: "auto", locale: "auto" });
  state.filter = loadFilter();
  detectChrome();
  // A cached palette is trustworthy enough to show immediately; without one the
  // page stays cloaked until the first settings read (or the failsafe) lands.
  const hasCachedAppearance = Boolean(boot.cached) || state.override.theme !== "auto";
  applyAppearance(hasCachedAppearance);
  renderStaticText();
  render();
  bindEvents();
  const failsafe = window.setTimeout(revealContent, 900);
  await poll(true);
  window.clearTimeout(failsafe);
  revealContent();
  startPolling();
}

/** Test surface for the verification harness; unused in normal operation. */
window.__tokenInsights = {
  state,
  poll,
  render,
  applyAppearance,
  aggregateFilter,
  setFilter(patch) {
    state.filter = { ...state.filter, ...patch };
    saveFilter();
    recompute();
    render();
  },
  setOverride,
  themeTrail: boot.themeTrail,
  i18nKeyDiff() {
    const en = Object.keys(STRINGS.en).sort();
    const zh = Object.keys(STRINGS.zh).sort();
    return {
      missingInZh: en.filter((key) => !zh.includes(key)),
      missingInEn: zh.filter((key) => !en.includes(key)),
      typeMismatch: en.filter((key) => zh.includes(key) && typeof STRINGS.en[key] !== typeof STRINGS.zh[key]),
    };
  },
};

void init();
