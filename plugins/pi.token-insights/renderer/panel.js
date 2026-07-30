/**
 * Token Insights panel.
 *
 * A panel window has no `pi` object — it reaches the host through
 * window.pluginBridge, which passes the same permission gate the plugin process
 * does. The panel only renders the latest de-identified local snapshot.
 */

const bridge = window.pluginBridge;
const MILLION = 1_000_000;
const HEAT_WEEKS = 53;
const SPARK_BARS = 60;

const STRINGS = {
  en: {
    title: "Token Insights",
    quoteStreak: (n) => `${n} days of showing up. It is adding up.`,
    quoteLongStreak: (n) => `${n} days in a row. You made the habit real.`,
    quotePeak: (h) => `${pad(h)}:00 is where your ideas tend to wake up`,
    quoteMilestoneLarge: "A hundred million tokens of work with your name on it",
    quoteMilestone: "These millions are the shape of work you kept doing",
    quoteDefault: "The work is still here, even when the pace changes",
    quoteGentle: "A quieter day does not erase the progress behind it",
    quoteFirst: "The first marks are down. There is a lot of room ahead.",
    heroSub: (m, s, d) =>
      `tokens · ${m} replies · ${s} sessions · ${d} active ${d === 1 ? "day" : "days"}`,
    delta: (p) => `${p}% vs previous period`,
    input: "Input",
    output: "Output",
    cache: "Cache read",
    reasoning: "Reasoning",
    shareOfTotal: (p) => `${p}% of total`,
    activity: "Activity",
    activityNote: "last 12 months",
    streakNote: (c, l) => `Current ${c} ${c === 1 ? "day" : "days"} · longest ${l}`,
    streakNone: "No active streak yet",
    less: "Less",
    more: "More",
    models: "Models",
    modelsNote: (n) => `${n} in this window`,
    rhythm: "Rhythm",
    rhythmNote: (h) => `Peak ${pad(h)}:00–${pad((h + 1) % 24)}:00`,
    sources: "Tool sources",
    sessions: "Top sessions",
    untitled: "(untitled)",
    empty: "Nothing here yet",
    provenance: (files, sources, time) =>
      `Counted from ${files} local ${sources === 1 ? "source file" : "source files"} across ${sources} tool ${sources === 1 ? "source" : "sources"} · ` +
      `never leaves this device · updated ${time}`,
    disclaimer:
      "Aggregate counts only — message content is never read. Not a statement of your remaining subscription balance.",
    emptyTitle: "Nothing counted yet",
    emptyBody:
      "A local snapshot is being prepared. Run Token Insights: Open from the command palette to scan again right away.",
    errorTitle: "Could not read usage",
    deniedBody: "This plugin needs panel and agent-tool permissions. Grant them in Settings → Plugins, then reopen this panel.",
    weekdays: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
    dayInitials: ["M", "", "W", "", "F", "", ""],
    months: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
    heatCell: (date, tokens) => `${date} · ${tokens} tokens`,
    heatEmpty: (date) => `${date} · no activity`,
  },
  zh: {
    title: "Token Insights",
    quoteStreak: (n) => `连续 ${n} 天出现，积累正在发生`,
    quoteLongStreak: (n) => `连续 ${n} 天，你把习惯写成了事实`,
    quotePeak: (h) => `${pad(h)}:00，灵感常在这个时刻醒来`,
    quoteMilestoneLarge: "一亿 token 的认真，都写着你的名字",
    quoteMilestone: "这些百万 token，是你持续做事留下的形状",
    quoteDefault: "节奏会变，已经完成的工作不会消失",
    quoteGentle: "今天慢一点，也不会抹去已经走过的路",
    quoteFirst: "第一笔记录已经落下，前面还有很大的空间",
    heroSub: (m, s, d) => `tokens · ${m} 条回复 · ${s} 段对话 · ${d} 个活跃日`,
    delta: (p) => `较上一周期 ${p}%`,
    input: "输入",
    output: "输出",
    cache: "缓存读取",
    reasoning: "推理",
    shareOfTotal: (p) => `占总量 ${p}%`,
    activity: "活动",
    activityNote: "最近 12 个月",
    streakNote: (c, l) => `当前连续 ${c} 天 · 最长 ${l} 天`,
    streakNone: "还没有连续记录",
    less: "少",
    more: "多",
    models: "模型",
    modelsNote: (n) => `共 ${n} 个`,
    rhythm: "节奏",
    rhythmNote: (h) => `高光时段 ${pad(h)}:00–${pad((h + 1) % 24)}:00`,
    sources: "工具来源",
    sessions: "高消耗会话",
    untitled: "（未命名）",
    empty: "暂无数据",
    provenance: (files, sources, time) =>
      `统计自 ${sources} 个工具来源的 ${files} 个本地文件 · 数据从未离开这台设备 · ${time} 更新`,
    disclaimer: "仅统计聚合数量，从不读取消息内容；也不代表订阅剩余额度。",
    emptyTitle: "还没有可统计的数据",
    emptyBody:
      "本地快照正在准备中。从命令面板运行 Token Insights: Open，即可立即重新扫描。",
    errorTitle: "无法读取用量",
    deniedBody: "此插件需要面板与 Agent 工具权限。请在 设置 → 插件 中授权后重新打开面板。",
    weekdays: ["一", "二", "三", "四", "五", "六", "日"],
    dayInitials: ["一", "", "三", "", "五", "", ""],
    months: [
      "1月", "2月", "3月", "4月", "5月", "6月",
      "7月", "8月", "9月", "10月", "11月", "12月",
    ],
    heatCell: (date, tokens) => `${date} · ${tokens} tokens`,
    heatEmpty: (date) => `${date} · 无活动`,
  },
};

const state = {
  t: STRINGS.zh,
  locale: "zh",
  range: "30d",
  allSummary: null,
  rangeSummary: null,
  reduceMotion: false,
};

/* ----------------------------------------------------------------- helpers */

function pad(n) {
  return String(n).padStart(2, "0");
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function el(id) {
  return document.getElementById(id);
}

function compact(value) {
  const n = num(value);
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (abs >= MILLION) return `${(n / MILLION).toFixed(2)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

function grouped(value) {
  return num(value).toLocaleString(state.locale === "zh" ? "zh-CN" : "en-US");
}

function share(part, whole) {
  const total = num(whole);
  if (total <= 0) return 0;
  return Math.round((num(part) / total) * 1000) / 10;
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

/** Local calendar key, matching the host's tz-aware bucket keys. */
function dayKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function svgIcon(paths) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}

const TRENDING_UP = ["M16 7h6v6", "m22 7-8.5 8.5-5-5L2 17"];
const TRENDING_DOWN = ["M16 17h6v-6", "m22 17-8.5-8.5-5 5L2 7"];

/**
 * Sparse daily buckets -> a dense series over the visible window, then folded
 * into at most SPARK_BARS columns so a year and a month read the same way.
 */
function sparkSeries(summary, range) {
  const byDate = new Map((summary.daily || []).map((row) => [row.date, num(row.total)]));
  const end = startOfToday();
  let start;
  if (range === "all") {
    const first = summary.firstActivityAt ? new Date(summary.firstActivityAt) : end;
    first.setHours(0, 0, 0, 0);
    start = first;
  } else {
    start = addDays(end, range === "1y" ? -364 : -29);
  }
  const dense = [];
  for (let cursor = new Date(start); cursor <= end; cursor = addDays(cursor, 1)) {
    dense.push(byDate.get(dayKey(cursor)) || 0);
  }
  if (dense.length <= SPARK_BARS) return dense;
  const bucketSize = Math.ceil(dense.length / SPARK_BARS);
  const folded = [];
  for (let i = 0; i < dense.length; i += bucketSize) {
    folded.push(dense.slice(i, i + bucketSize).reduce((a, b) => a + b, 0));
  }
  return folded;
}

/* ----------------------------------------------------------------- renders */

function renderHero(summary) {
  const t = state.t;
  const totals = summary.totals || {};
  const total = num(totals.total);

  const streak = summary.streak || {};
  const peak = peakIndex(summary.hourly);
  let quote;
  if (num(streak.current) >= 7) quote = t.quoteLongStreak(num(streak.current));
  else if (num(streak.current) >= 3) quote = t.quoteStreak(num(streak.current));
  else if (total >= 100_000_000) quote = t.quoteMilestoneLarge;
  else if (total >= 1_000_000) quote = t.quoteMilestone;
  else if (num(totals.messages) <= 3 && total > 0) quote = t.quoteFirst;
  else if (peak != null) quote = t.quotePeak(peak);
  else if (num(streak.longest) > 0) quote = t.quoteGentle;
  else quote = t.quoteDefault;
  el("heroQuote").textContent = quote;

  const previous = num(summary.previousTotals?.total);
  const delta = el("heroDelta");
  clear(delta);
  if (previous > 0 && total > 0) {
    const pct = Math.round(((total - previous) / previous) * 1000) / 10;
    delta.appendChild(svgIcon(pct >= 0 ? TRENDING_UP : TRENDING_DOWN));
    delta.appendChild(document.createTextNode(t.delta(`${pct >= 0 ? "+" : ""}${pct}`)));
    delta.hidden = false;
  } else {
    delta.hidden = true;
  }

  countUp(el("heroNumber"), total);
  el("heroSub").textContent = t.heroSub(
    grouped(totals.messages),
    grouped(totals.sessions),
    num(totals.activeDays),
  );

  const series = sparkSeries(summary, state.range);
  const peakValue = Math.max(1, ...series);
  const spark = el("sparkline");
  clear(spark);
  series.forEach((value, index) => {
    const bar = document.createElement("i");
    const height = value > 0 ? Math.max(2, Math.round((value / peakValue) * 44)) : 1;
    bar.style.setProperty("--h", `${height}px`);
    if (index >= series.length - Math.ceil(series.length / 4)) {
      bar.dataset.recent = "true";
    }
    spark.appendChild(bar);
  });
}

function countUp(node, target) {
  if (state.reduceMotion) {
    node.textContent = grouped(target);
    return;
  }
  const start = performance.now();
  const duration = 600;
  function frame(now) {
    const progress = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    node.textContent = grouped(Math.round(target * eased));
    if (progress < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function renderTiles(summary) {
  const t = state.t;
  const totals = summary.totals || {};
  const total = num(totals.total);

  el("tileInputLabel").textContent = t.input;
  el("tileOutputLabel").textContent = t.output;
  el("tileCacheLabel").textContent = t.cache;
  el("tileReasoningLabel").textContent = t.reasoning;

  el("tileInput").textContent = compact(totals.input);
  el("tileInputNote").textContent = t.shareOfTotal(share(totals.input, total));
  el("tileOutput").textContent = compact(totals.output);
  el("tileOutputNote").textContent = t.shareOfTotal(share(totals.output, total));

  const cacheRead = num(totals.cacheRead);
  el("tileCache").textContent = compact(cacheRead);
  el("tileCacheNote").textContent = t.shareOfTotal(share(cacheRead, total));

  const reasoning = num(totals.reasoning);
  el("tileReasoning").textContent = compact(reasoning);
  el("tileReasoningNote").textContent = t.shareOfTotal(share(reasoning, total));

}

function renderHeatmap(summary) {
  const t = state.t;
  const byDate = new Map((summary.daily || []).map((row) => [row.date, num(row.total)]));
  const today = startOfToday();
  // Column 0 starts on the Monday 52 weeks before this week's Monday.
  const mondayOffset = (today.getDay() + 6) % 7;
  const firstMonday = addDays(today, -mondayOffset - (HEAT_WEEKS - 1) * 7);

  const values = [];
  for (let i = 0; i < HEAT_WEEKS * 7; i += 1) {
    const date = addDays(firstMonday, i);
    values.push({ date, future: date > today, total: byDate.get(dayKey(date)) || 0 });
  }

  const active = values.filter((cell) => cell.total > 0).map((cell) => cell.total);
  const ceiling = active.length
    ? active.slice().sort((a, b) => a - b)[Math.floor(active.length * 0.9)] || Math.max(...active)
    : 0;

  const grid = el("heatmap");
  clear(grid);
  const tip = el("heatTip");
  for (const cell of values) {
    const box = document.createElement("i");
    const key = dayKey(cell.date);
    if (cell.future) {
      box.dataset.void = "true";
    } else {
      box.dataset.level = String(heatLevel(cell.total, ceiling));
      box.dataset.label =
        cell.total > 0 ? t.heatCell(key, grouped(cell.total)) : t.heatEmpty(key);
      box.addEventListener("mouseenter", () => {
        tip.textContent = box.dataset.label;
      });
    }
    grid.appendChild(box);
  }

  const dayCol = el("heatDays");
  clear(dayCol);
  for (const initial of t.dayInitials) {
    const row = document.createElement("div");
    row.textContent = initial;
    dayCol.appendChild(row);
  }

  const months = el("heatMonths");
  clear(months);
  let lastMonth = -1;
  for (let week = 0; week < HEAT_WEEKS; week += 1) {
    const label = document.createElement("span");
    const weekStart = addDays(firstMonday, week * 7);
    // Label a column only when its week actually opens a new month.
    if (weekStart.getDate() <= 7 && weekStart.getMonth() !== lastMonth) {
      label.textContent = t.months[weekStart.getMonth()];
      lastMonth = weekStart.getMonth();
    }
    months.appendChild(label);
  }

  const streak = summary.streak || {};
  el("activityTitle").textContent = t.activity;
  el("streakNote").textContent = num(streak.current)
    ? t.streakNote(num(streak.current), num(streak.longest))
    : t.streakNone;
  el("legendLess").textContent = t.less;
  el("legendMore").textContent = t.more;
}

function heatLevel(total, ceiling) {
  if (total <= 0) return 0;
  if (ceiling <= 0) return 1;
  const ratio = total / ceiling;
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.85) return 3;
  return 4;
}

function rankRow(name, valueText, ratio, metaText) {
  const row = document.createElement("div");
  row.className = "rank-row";

  const label = document.createElement("div");
  label.className = "rank-name";
  label.textContent = name;
  label.title = name;
  row.appendChild(label);

  const value = document.createElement("div");
  value.className = "rank-value";
  value.textContent = valueText;
  row.appendChild(value);

  const bar = document.createElement("div");
  bar.className = "rank-bar";
  const fill = document.createElement("span");
  fill.style.setProperty("--w", `${Math.max(1, Math.round(ratio * 100))}%`);
  bar.appendChild(fill);
  row.appendChild(bar);

  if (metaText) {
    const meta = document.createElement("div");
    meta.className = "rank-meta";
    meta.textContent = metaText;
    row.appendChild(meta);
  }
  return row;
}

function emptyRow(text) {
  const row = document.createElement("div");
  row.className = "empty-row";
  row.textContent = text;
  return row;
}

function renderRankings(summary) {
  const t = state.t;
  const total = num(summary.totals?.total);

  el("modelsTitle").textContent = t.models;
  el("sourcesTitle").textContent = t.sources;
  el("sessionsTitle").textContent = t.sessions;

  const models = (summary.models || []).slice(0, 6);
  const top = num(models[0]?.total) || 1;
  el("modelsNote").textContent = t.modelsNote((summary.models || []).length);
  const modelList = el("modelList");
  clear(modelList);
  if (!models.length) modelList.appendChild(emptyRow(t.empty));
  for (const model of models) {
    modelList.appendChild(
      rankRow(
        model.label || model.modelId,
        `${compact(model.total)} · ${share(model.total, total)}%`,
        num(model.total) / top,
        `${compact(model.input)} ${t.input.toLowerCase()} · ${compact(model.output)} ${t.output.toLowerCase()}`,
      ),
    );
  }

  const sources = (summary.sources || []).slice(0, 6);
  const topSource = num(sources[0]?.total) || 1;
  const sourceList = el("sourceList");
  clear(sourceList);
  if (!sources.length) sourceList.appendChild(emptyRow(t.empty));
  for (const source of sources) {
    sourceList.appendChild(
      rankRow(
        source.label || source.sourceId || "Unknown source",
        `${compact(source.total)} · ${share(source.total, total)}%`,
        num(source.total) / topSource,
      ),
    );
  }

  const sessions = (summary.topSessions || []).slice(0, 6);
  const topSession = num(sessions[0]?.total) || 1;
  const sessionList = el("sessionList");
  clear(sessionList);
  if (!sessions.length) sessionList.appendChild(emptyRow(t.empty));
  for (const session of sessions) {
    sessionList.appendChild(
      rankRow(
        session.title || t.untitled,
        compact(session.total),
        num(session.total) / topSession,
      ),
    );
  }
}

function peakIndex(slots) {
  let best = null;
  let bestTotal = 0;
  (slots || []).forEach((slot, index) => {
    const total = num(slot?.total);
    if (total > bestTotal) {
      bestTotal = total;
      best = index;
    }
  });
  return best;
}

function renderRhythm(summary) {
  const t = state.t;
  el("rhythmTitle").textContent = t.rhythm;

  const hourly = summary.hourly || [];
  const peak = peakIndex(hourly);
  el("rhythmNote").textContent = peak == null ? "" : t.rhythmNote(peak);

  const ceiling = Math.max(1, ...hourly.map((slot) => num(slot?.total)));
  const clock = el("clock");
  clear(clock);
  hourly.forEach((slot, hour) => {
    const bar = document.createElement("i");
    const value = num(slot?.total);
    bar.style.setProperty("--h", `${value > 0 ? Math.max(3, Math.round((value / ceiling) * 96)) : 2}px`);
    if (hour === peak) bar.dataset.peak = "true";
    clock.appendChild(bar);
  });

  const axis = el("clockAxis");
  clear(axis);
  for (let hour = 0; hour < 24; hour += 1) {
    const cell = document.createElement("div");
    cell.textContent = hour % 6 === 0 ? pad(hour) : "";
    axis.appendChild(cell);
  }

  const weekday = summary.weekday || [];
  const weekCeiling = Math.max(1, ...weekday.map((slot) => num(slot?.total)));
  const weekbar = el("weekbar");
  clear(weekbar);
  weekday.forEach((slot, index) => {
    const cell = document.createElement("div");
    const track = document.createElement("span");
    const fill = document.createElement("i");
    const value = num(slot?.total);
    fill.style.setProperty("--w", `${value > 0 ? Math.max(4, Math.round((value / weekCeiling) * 100)) : 0}%`);
    track.appendChild(fill);
    cell.appendChild(track);
    cell.appendChild(document.createTextNode(t.weekdays[index] || ""));
    weekbar.appendChild(cell);
  });
}

function renderFooter(summary) {
  const t = state.t;
  const time = new Date(num(summary.generatedAt) || Date.now()).toLocaleTimeString(
    state.locale === "zh" ? "zh-CN" : "en-US",
    { hour: "2-digit", minute: "2-digit" },
  );
  el("provenanceLine").textContent = t.provenance(
    num(summary.scannedFiles),
    (summary.sourceDiagnostics || []).filter((item) => num(item.filesScanned) > 0).length,
    time,
  );
  el("disclaimerLine").textContent = t.disclaimer;
}

/* ------------------------------------------------------------------- shell */

function showState(title, body) {
  el("content").hidden = true;
  el("stateTitle").textContent = title;
  el("stateBody").textContent = body;
  el("stateBox").hidden = false;
}

function paint() {
  const summary = state.rangeSummary;
  if (!summary) return;
  renderHero(summary);
  renderTiles(summary);
  renderHeatmap(state.allSummary || summary);
  renderRankings(summary);
  renderRhythm(summary);
  renderFooter(summary);
  el("stateBox").hidden = true;
  el("content").hidden = false;
}

async function load() {
  const button = el("refreshBtn");
  button.classList.add("is-busy");
  try {
    const settings = await bridge.invoke("plugin.getSettings");
    const snapshot = settings?.usageSnapshot;
    if (snapshot?.schemaVersion !== 2 || !snapshot?.all || !snapshot?.thirtyDays || !snapshot?.oneYear) {
      showState(state.t.emptyTitle, state.t.emptyBody);
      return;
    }
    state.allSummary = snapshot.all;
    state.rangeSummary = state.range === "all"
      ? snapshot.all
      : state.range === "1y"
        ? snapshot.oneYear
        : snapshot.thirtyDays;

    if (num(state.allSummary?.totals?.total) <= 0) {
      showState(state.t.emptyTitle, state.t.emptyBody);
      return;
    }
    paint();
  } catch (error) {
    const message = String(error?.message || error);
    const denied = /PERMISSION_DENIED|permission/i.test(message);
    showState(state.t.errorTitle, denied ? state.t.deniedBody : message);
  } finally {
    button.classList.remove("is-busy");
  }
}

function applyLocale(locale) {
  state.locale = String(locale || "en").toLowerCase().startsWith("zh") ? "zh" : "en";
  state.t = STRINGS[state.locale];
  document.documentElement.lang = state.locale === "zh" ? "zh-CN" : "en";
  document.documentElement.dataset.lang = state.locale;
  el("appTitle").textContent = state.t.title;
  document.title = state.t.title;
  el("activityTitle").textContent = state.t.activity;
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === "light" ? "light" : "dark";
}

function applyPlatform() {
  const ua = navigator.userAgent;
  const platform = /Macintosh|Mac OS X/.test(ua) ? "mac" : /Windows/.test(ua) ? "win" : "other";
  document.documentElement.dataset.platform = platform;
}

function wireRange() {
  for (const button of el("rangeSwitch").querySelectorAll(".segment")) {
    button.setAttribute("aria-pressed", String(button.dataset.range === state.range));
    button.addEventListener("click", () => {
      if (state.range === button.dataset.range) return;
      state.range = button.dataset.range;
      for (const other of el("rangeSwitch").querySelectorAll(".segment")) {
        other.setAttribute("aria-pressed", String(other.dataset.range === state.range));
      }
      load();
    });
  }
}

async function boot() {
  state.reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  applyPlatform();

  const [theme, locale] = await Promise.all([
    bridge.invoke("app.getTheme").catch(() => "dark"),
    bridge.invoke("app.getLocale").catch(() => "zh-CN"),
  ]);
  applyTheme(theme);
  applyLocale(locale);

  bridge.on("theme", (payload) => applyTheme(payload?.theme));

  wireRange();
  el("refreshBtn").addEventListener("click", load);
  // Bound once: renderHeatmap only refills the grid, it never replaces it.
  el("heatmap").addEventListener("mouseleave", () => {
    el("heatTip").textContent = "";
  });
  await load();
}

boot();
