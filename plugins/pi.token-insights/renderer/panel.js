/**
 * Token Insights panel.
 *
 * A panel window has no `pi` object — it reaches the host through
 * window.pluginBridge, which passes the same permission gate the plugin process
 * does. Everything here is read-only except the price table.
 *
 * The cost formula is duplicated in main.js (the agent tool cannot call into a
 * panel and vice versa). Keep the two in step.
 */

const bridge = window.pluginBridge;
const MILLION = 1_000_000;
const PRICE_KEYS = ["input", "output", "cacheRead", "cacheWrite"];
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
    cache: "Cache reuse",
    cost: "Estimated spend",
    shareOfTotal: (p) => `${p}% of total`,
    cacheNote: (t) => `${t} tokens replayed from cache`,
    cacheNone: "No cached reads in this window",
    costUnpriced: (n) => `${n} ${n === 1 ? "model" : "models"} unpriced`,
    costEmpty: "Add prices to see an estimate",
    costAllPriced: "Every model in this window is priced",
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
    projects: "Projects",
    sessions: "Top sessions",
    noProject: "(no project)",
    untitled: "(untitled)",
    empty: "Nothing here yet",
    provenance: (files, time) =>
      `Counted from ${files} local session ${files === 1 ? "file" : "files"} · ` +
      `never leaves this device · updated ${time}`,
    disclaimer:
      "Aggregate counts only — message content is never read. Not a statement of your remaining subscription balance.",
    emptyTitle: "Nothing counted yet",
    emptyBody:
      "Token Insights reads the usage recorded on each assistant reply. Have a conversation, then come back — this page fills itself in.",
    errorTitle: "Could not read usage",
    deniedBody:
      "This plugin needs the “Read local token usage” permission. Grant it in Settings → Plugins, then reopen this panel.",
    drawerTitle: "Price table",
    drawerIntro:
      "Enter what you actually pay, per million tokens. Nothing is pre-filled: vendor prices change, and a stale guess is worse than no number. Models you leave blank show no cost and stay out of the total.",
    currency: "Currency",
    save: "Save",
    saved: "Saved",
    saveFailed: "Could not save",
    priceIn: "In",
    priceOut: "Out",
    priceCacheRead: "C·read",
    priceCacheWrite: "C·write",
    noModels: "No models to price yet.",
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
    cache: "缓存复用",
    cost: "预估花费",
    shareOfTotal: (p) => `占总量 ${p}%`,
    cacheNote: (t) => `${t} tokens 来自缓存复用`,
    cacheNone: "这段时间没有缓存读取",
    costUnpriced: (n) => `${n} 个模型未定价`,
    costEmpty: "填入价格后显示金额",
    costAllPriced: "这段时间的模型都已定价",
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
    projects: "项目",
    sessions: "高消耗会话",
    noProject: "（无项目）",
    untitled: "（未命名）",
    empty: "暂无数据",
    provenance: (files, time) =>
      `统计自 ${files} 个本地会话文件 · 数据从未离开这台设备 · ${time} 更新`,
    disclaimer: "仅统计聚合数量，从不读取消息内容；也不代表订阅剩余额度。",
    emptyTitle: "还没有可统计的数据",
    emptyBody:
      "Token Insights 读取每条助手回复上记录的用量。先聊几句再回来，这一页会自己长出来。",
    errorTitle: "无法读取用量",
    deniedBody:
      "此插件需要“读取本机 token 用量”权限。请在 设置 → 插件 中授权后重新打开面板。",
    drawerTitle: "价格表",
    drawerIntro:
      "按每百万 token 填入你实际支付的价格。插件不预置任何厂商价格：价格会变，过期的猜测比没有数字更糟。留空的模型不显示金额，也不计入总额。",
    currency: "币种",
    save: "保存",
    saved: "已保存",
    saveFailed: "保存失败",
    priceIn: "输入",
    priceOut: "输出",
    priceCacheRead: "缓存读",
    priceCacheWrite: "缓存写",
    noModels: "暂无可定价的模型。",
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
  t: STRINGS.en,
  locale: "en",
  range: "30d",
  settings: { currency: "USD", prices: {} },
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

function money(amount, currency) {
  try {
    return new Intl.NumberFormat(state.locale === "zh" ? "zh-CN" : "en-US", {
      style: "currency",
      currency: currency || "USD",
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency || "USD"}`;
  }
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

/* -------------------------------------------------------------------- cost */

function rateFor(prices, modelId) {
  const entry = prices && typeof prices === "object" ? prices[modelId] : null;
  if (!entry || typeof entry !== "object") return null;
  const rate = {};
  let priced = false;
  for (const key of PRICE_KEYS) {
    const value = num(entry[key]);
    rate[key] = value;
    if (value > 0) priced = true;
  }
  return priced ? rate : null;
}

/** Priced models only; unpriced ones are counted, not silently zeroed. */
function estimateCost(models, prices) {
  let total = 0;
  let pricedModels = 0;
  let unpriced = 0;
  const perModel = new Map();
  for (const model of models || []) {
    const rate = rateFor(prices, model.modelId);
    if (!rate) {
      unpriced += 1;
      continue;
    }
    const cost =
      (num(model.input) * rate.input +
        num(model.output) * rate.output +
        num(model.cacheRead) * rate.cacheRead +
        num(model.cacheWrite) * rate.cacheWrite) /
      MILLION;
    perModel.set(model.modelId, cost);
    total += cost;
    pricedModels += 1;
  }
  return { total, pricedModels, unpriced, perModel };
}

/* ------------------------------------------------------------------ ranges */

function rangeParams(range) {
  const tzOffsetMinutes = -new Date().getTimezoneOffset();
  if (range === "all") return { tzOffsetMinutes };
  const days = range === "1y" ? 364 : 29;
  return { sinceMs: addDays(startOfToday(), -days).getTime(), tzOffsetMinutes };
}

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

function renderTiles(summary, cost) {
  const t = state.t;
  const totals = summary.totals || {};
  const total = num(totals.total);

  el("tileInputLabel").textContent = t.input;
  el("tileOutputLabel").textContent = t.output;
  el("tileCacheLabel").textContent = t.cache;
  el("tileCostLabel").textContent = t.cost;

  el("tileInput").textContent = compact(totals.input);
  el("tileInputNote").textContent = t.shareOfTotal(share(totals.input, total));
  el("tileOutput").textContent = compact(totals.output);
  el("tileOutputNote").textContent = t.shareOfTotal(share(totals.output, total));

  const cacheRead = num(totals.cacheRead);
  const readable = cacheRead + num(totals.input);
  el("tileCache").textContent = readable > 0 ? `${share(cacheRead, readable)}%` : "—";
  el("tileCacheNote").textContent = cacheRead > 0 ? t.cacheNote(compact(cacheRead)) : t.cacheNone;

  const costValue = el("tileCost");
  const costNote = el("tileCostNote");
  if (cost.pricedModels > 0) {
    costValue.textContent = money(cost.total, state.settings.currency);
    costNote.textContent = cost.unpriced > 0 ? t.costUnpriced(cost.unpriced) : t.costAllPriced;
    costNote.dataset.tone = cost.unpriced > 0 ? "warning" : "";
  } else {
    costValue.textContent = "—";
    costNote.textContent = t.costEmpty;
    costNote.dataset.tone = "";
  }
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

function renderRankings(summary, cost) {
  const t = state.t;
  const total = num(summary.totals?.total);

  el("modelsTitle").textContent = t.models;
  el("projectsTitle").textContent = t.projects;
  el("sessionsTitle").textContent = t.sessions;

  const models = (summary.models || []).slice(0, 6);
  const top = num(models[0]?.total) || 1;
  el("modelsNote").textContent = t.modelsNote((summary.models || []).length);
  const modelList = el("modelList");
  clear(modelList);
  if (!models.length) modelList.appendChild(emptyRow(t.empty));
  for (const model of models) {
    const modelCost = cost.perModel.get(model.modelId);
    const meta = [
      `${compact(model.input)} ${t.priceIn.toLowerCase()} · ${compact(model.output)} ${t.priceOut.toLowerCase()}`,
    ];
    if (typeof modelCost === "number") meta.push(money(modelCost, state.settings.currency));
    modelList.appendChild(
      rankRow(
        model.modelId,
        `${compact(model.total)} · ${share(model.total, total)}%`,
        num(model.total) / top,
        meta.join("  ·  "),
      ),
    );
  }

  const projects = (summary.projects || []).slice(0, 6);
  const topProject = num(projects[0]?.total) || 1;
  const projectList = el("projectList");
  clear(projectList);
  if (!projects.length) projectList.appendChild(emptyRow(t.empty));
  for (const project of projects) {
    projectList.appendChild(
      rankRow(
        project.name || project.path || t.noProject,
        `${compact(project.total)} · ${share(project.total, total)}%`,
        num(project.total) / topProject,
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
  el("provenanceLine").textContent = t.provenance(num(summary.scannedFiles), time);
  el("disclaimerLine").textContent = t.disclaimer;
}

/* ------------------------------------------------------------------ drawer */

function renderDrawer() {
  const t = state.t;
  el("drawerTitle").textContent = t.drawerTitle;
  el("drawerIntro").textContent = t.drawerIntro;
  el("currencyLabel").textContent = t.currency;
  el("savePrices").textContent = t.save;
  el("currencyInput").value = state.settings.currency || "USD";

  const rows = el("priceRows");
  clear(rows);
  const models = (state.allSummary?.models || []).slice(0, 40);
  if (!models.length) {
    rows.appendChild(emptyRow(t.noModels));
    return;
  }
  for (const model of models) {
    const block = document.createElement("div");

    const head = document.createElement("div");
    head.className = "price-row-head";
    const name = document.createElement("div");
    name.className = "price-model";
    name.textContent = model.modelId;
    name.title = model.modelId;
    const usage = document.createElement("div");
    usage.className = "price-usage";
    usage.textContent = `${compact(model.total)} tokens`;
    head.appendChild(name);
    head.appendChild(usage);
    block.appendChild(head);

    const grid = document.createElement("div");
    grid.className = "price-grid";
    const labels = {
      input: t.priceIn,
      output: t.priceOut,
      cacheRead: t.priceCacheRead,
      cacheWrite: t.priceCacheWrite,
    };
    for (const key of PRICE_KEYS) {
      const cell = document.createElement("label");
      cell.className = "price-cell";
      const label = document.createElement("span");
      label.textContent = labels[key];
      const input = document.createElement("input");
      input.type = "number";
      input.min = "0";
      input.step = "0.01";
      input.dataset.model = model.modelId;
      input.dataset.key = key;
      const existing = state.settings.prices?.[model.modelId]?.[key];
      input.value = Number.isFinite(Number(existing)) && Number(existing) > 0 ? String(existing) : "";
      cell.appendChild(label);
      cell.appendChild(input);
      grid.appendChild(cell);
    }
    block.appendChild(grid);
    rows.appendChild(block);
  }
}

function openDrawer() {
  renderDrawer();
  el("drawerStatus").textContent = "";
  el("drawer").hidden = false;
  el("drawerScrim").hidden = false;
  el("currencyInput").focus();
}

function closeDrawer() {
  el("drawer").hidden = true;
  el("drawerScrim").hidden = true;
}

async function savePrices() {
  // plugin.setSettings merges only at the top level, so `prices` is replaced
  // wholesale. Start from what is stored and rewrite just the rendered models,
  // or a model further down the list than the drawer shows would lose its price.
  const prices = { ...(state.settings.prices || {}) };
  const touched = new Set();
  for (const input of el("priceRows").querySelectorAll("input[data-model]")) {
    const modelId = input.dataset.model;
    if (!touched.has(modelId)) {
      touched.add(modelId);
      delete prices[modelId];
    }
    const value = Number(input.value);
    if (!Number.isFinite(value) || value <= 0) continue;
    prices[modelId] = prices[modelId] || {};
    prices[modelId][input.dataset.key] = value;
  }
  const currency = (el("currencyInput").value || "USD").trim().toUpperCase().slice(0, 8) || "USD";
  try {
    await bridge.invoke("plugin.setSettings", { currency, prices });
    state.settings = { currency, prices };
    el("drawerStatus").textContent = state.t.saved;
    renderDrawer();
    paint();
  } catch (error) {
    el("drawerStatus").textContent = `${state.t.saveFailed}: ${error?.message || error}`;
  }
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
  const cost = estimateCost(summary.models, state.settings.prices);
  renderHero(summary);
  renderTiles(summary, cost);
  renderHeatmap(state.allSummary || summary);
  renderRankings(summary, cost);
  renderRhythm(summary);
  renderFooter(summary);
  el("stateBox").hidden = true;
  el("content").hidden = false;
}

async function load({ force = false } = {}) {
  const button = el("refreshBtn");
  button.classList.add("is-busy");
  try {
    const settings = await bridge.invoke("plugin.getSettings");
    state.settings = {
      currency: typeof settings?.currency === "string" && settings.currency ? settings.currency : "USD",
      prices: settings?.prices && typeof settings.prices === "object" ? settings.prices : {},
    };

    if (force || !state.allSummary) {
      state.allSummary = await bridge.invoke("usage.summary", rangeParams("all"));
    }
    state.rangeSummary =
      state.range === "all"
        ? state.allSummary
        : await bridge.invoke("usage.summary", rangeParams(state.range));

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
    bridge.invoke("app.getLocale").catch(() => "en"),
  ]);
  applyTheme(theme);
  applyLocale(locale);

  bridge.on("theme", (payload) => applyTheme(payload?.theme));

  wireRange();
  el("refreshBtn").addEventListener("click", () => load({ force: true }));
  el("pricesBtn").addEventListener("click", openDrawer);
  el("drawerClose").addEventListener("click", closeDrawer);
  el("drawerScrim").addEventListener("click", closeDrawer);
  el("savePrices").addEventListener("click", savePrices);
  // Bound once: renderHeatmap only refills the grid, it never replaces it.
  el("heatmap").addEventListener("mouseleave", () => {
    el("heatTip").textContent = "";
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !el("drawer").hidden) closeDrawer();
  });

  await load({ force: true });
}

boot();
