/**
 * Token Insights — plugin process side.
 *
 * Two jobs: open the panel from the command palette, and expose the same
 * numbers to the agent so questions like "which model cost me the most this
 * month" get answered from real local data instead of a guess.
 *
 * The panel does its own money math (it cannot call into this file — panels
 * talk to the host, not to the plugin process). The two formulas are a dozen
 * lines each and must stay in step; there is no shared module to hide them in.
 */

const MILLION = 1_000_000;
const PRICE_KEYS = ["input", "output", "cacheRead", "cacheWrite"];
const RELATIVE = /^(\d+)\s*(d|w|m|y)$/i;

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** A model counts as priced once the user gave it at least one real number. */
function priceFor(prices, modelId) {
  const entry = prices && typeof prices === "object" ? prices[modelId] : null;
  if (!entry || typeof entry !== "object") return null;
  const rate = {};
  let priced = false;
  for (const key of PRICE_KEYS) {
    const value = toNumber(entry[key]);
    rate[key] = value;
    if (value > 0) priced = true;
  }
  return priced ? rate : null;
}

/**
 * Cost of the priced models only. Unpriced models are reported separately
 * rather than folded in at zero, which would quietly understate the total.
 */
function estimateCost(models, prices) {
  let total = 0;
  let pricedModels = 0;
  const unpriced = [];
  const perModel = new Map();
  for (const model of models || []) {
    const rate = priceFor(prices, model.modelId);
    if (!rate) {
      unpriced.push(model.modelId);
      continue;
    }
    const cost =
      (toNumber(model.input) * rate.input +
        toNumber(model.output) * rate.output +
        toNumber(model.cacheRead) * rate.cacheRead +
        toNumber(model.cacheWrite) * rate.cacheWrite) /
      MILLION;
    perModel.set(model.modelId, cost);
    total += cost;
    pricedModels += 1;
  }
  return { total, pricedModels, unpriced, perModel };
}

/**
 * Accepts an ISO date/date-time or a `30d` / `12w` / `6m` / `1y` shorthand.
 * Date-only strings land on local midnight so a day means the user's day.
 */
function parseInstant(input, now) {
  if (input == null || input === "") return null;
  const text = String(input).trim();

  const relative = RELATIVE.exec(text);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    const date = new Date(now);
    date.setHours(0, 0, 0, 0);
    if (unit === "d") date.setDate(date.getDate() - amount);
    if (unit === "w") date.setDate(date.getDate() - amount * 7);
    if (unit === "m") date.setMonth(date.getMonth() - amount);
    if (unit === "y") date.setFullYear(date.getFullYear() - amount);
    return date.getTime();
  }

  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (dateOnly) {
    return new Date(
      Number(dateOnly[1]),
      Number(dateOnly[2]) - 1,
      Number(dateOnly[3]),
    ).getTime();
  }

  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : parsed;
}

function compact(n) {
  const value = toNumber(n);
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (abs >= MILLION) return `${(value / MILLION).toFixed(2)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}

function localDateLabel(ms) {
  const date = new Date(ms);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function money(amount, currency) {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency || "USD",
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency || "USD"}`;
  }
}

function peakHour(hourly) {
  let best = -1;
  let bestTotal = 0;
  (hourly || []).forEach((slot, hour) => {
    const total = toNumber(slot?.total);
    if (total > bestTotal) {
      bestTotal = total;
      best = hour;
    }
  });
  return best < 0 ? null : { hour: best, total: bestTotal };
}

function pct(part, whole) {
  const total = toNumber(whole);
  if (total <= 0) return 0;
  return Math.round((toNumber(part) / total) * 1000) / 10;
}

function rankingRows(summary, groupBy, limit) {
  const total = toNumber(summary.totals?.total);
  if (groupBy === "project") {
    return (summary.projects || []).slice(0, limit).map((row) => ({
      key: row.name || row.path || "(no project)",
      total: row.total,
      share: pct(row.total, total),
      sessions: row.sessions,
    }));
  }
  if (groupBy === "session") {
    return (summary.topSessions || []).slice(0, limit).map((row) => ({
      key: row.title,
      sessionId: row.id,
      total: row.total,
      share: pct(row.total, total),
      messages: row.messages,
    }));
  }
  if (groupBy === "day") {
    return (summary.daily || [])
      .slice()
      .sort((a, b) => toNumber(b.total) - toNumber(a.total))
      .slice(0, limit)
      .map((row) => ({
        key: row.date,
        total: row.total,
        share: pct(row.total, total),
        messages: row.messages,
      }));
  }
  return (summary.models || []).slice(0, limit).map((row) => ({
    key: row.modelId,
    providerId: row.providerId,
    total: row.total,
    share: pct(row.total, total),
    input: row.input,
    output: row.output,
    cacheRead: row.cacheRead,
    cacheWrite: row.cacheWrite,
    sessions: row.sessions,
  }));
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function formatText(report) {
  const { window: win, totals, cost, ranking, groupBy, streak, peak } = report;
  const lines = [];
  lines.push(`# Token usage — ${win.label}`);
  lines.push("");
  lines.push(
    `- Total: ${totals.total.toLocaleString("en-US")} tokens ` +
      `(${compact(totals.input)} in / ${compact(totals.output)} out / ` +
      `${compact(totals.cacheRead)} cache read)`,
  );
  lines.push(
    `- Activity: ${plural(totals.messages, "assistant message", "assistant messages")} across ` +
      `${plural(totals.sessions, "session", "sessions")}, ` +
      `${plural(totals.activeDays, "active day", "active days")}`,
  );
  if (report.deltaPct != null) {
    const direction = report.deltaPct >= 0 ? "up" : "down";
    lines.push(
      `- Versus the preceding window of the same length: ${direction} ${Math.abs(report.deltaPct)}%`,
    );
  }
  if (cost.pricedModels > 0) {
    lines.push(
      `- Estimated cost: ${money(cost.total, cost.currency)} across ` +
        `${plural(cost.pricedModels, "priced model", "priced models")}` +
        (cost.unpriced.length
          ? `; ${plural(cost.unpriced.length, "model has", "models have")} no price yet and ` +
            `${cost.unpriced.length === 1 ? "is" : "are"} excluded`
          : ""),
    );
  } else {
    lines.push(
      "- Estimated cost: unavailable — no prices have been entered yet " +
        "(open Token Insights and fill the price table).",
    );
  }
  if (streak?.current) {
    lines.push(
      `- Streak: ${plural(streak.current, "day", "days")} now, longest ${streak.longest}`,
    );
  }
  if (peak) {
    lines.push(
      `- Busiest hour: ${String(peak.hour).padStart(2, "0")}:00–${String((peak.hour + 1) % 24).padStart(2, "0")}:00`,
    );
  }

  lines.push("", `## Top by ${groupBy}`);
  if (!ranking.length) {
    lines.push("- (nothing in this window)");
  }
  for (const row of ranking) {
    const parts = [`${compact(row.total)} tokens`, `${row.share}%`];
    const modelCost = cost.perModel?.[row.key];
    if (groupBy === "model" && typeof modelCost === "number") {
      parts.push(money(modelCost, cost.currency));
    }
    lines.push(`- ${row.key} — ${parts.join(" · ")}`);
  }

  lines.push(
    "",
    `_Counted from ${plural(report.scannedFiles, "local session file", "local session files")}. ` +
      "Aggregate counts only, no message content. This is not your remaining " +
      "subscription balance._",
  );
  return lines.join("\n");
}

async function buildReport(args = {}) {
  const now = Date.now();
  const settings = (await pi.plugin.getSettings()) || {};
  const prices = settings.prices && typeof settings.prices === "object" ? settings.prices : {};
  const currency = typeof settings.currency === "string" && settings.currency ? settings.currency : "USD";

  const sinceInput = args.since == null ? "" : String(args.since).trim();
  const untilInput = args.until == null ? "" : String(args.until).trim();
  const sinceMs = parseInstant(sinceInput, now);
  const untilMs = parseInstant(untilInput, now);
  if (sinceInput && sinceMs == null) {
    throw new Error("Invalid since value. Use an ISO date or a shorthand such as 30d.");
  }
  if (untilInput && untilMs == null) {
    throw new Error("Invalid until value. Use an ISO date or date-time.");
  }
  if (sinceMs != null && untilMs != null && sinceMs >= untilMs) {
    throw new Error("The since value must be earlier than until.");
  }
  const summary = await pi.usage.summary({
    sinceMs: sinceMs ?? undefined,
    untilMs: untilMs ?? undefined,
    tzOffsetMinutes: -new Date().getTimezoneOffset(),
  });

  const groupBy = ["model", "project", "day", "session"].includes(args.groupBy)
    ? args.groupBy
    : "model";
  const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 25);

  const cost = estimateCost(summary.models, prices);
  const previous = toNumber(summary.previousTotals?.total);
  const current = toNumber(summary.totals?.total);
  const deltaPct = previous > 0 ? Math.round(((current - previous) / previous) * 1000) / 10 : null;

  const label = sinceMs
    ? `${localDateLabel(sinceMs)} → ${localDateLabel(untilMs ?? now)}`
    : "all time";

  const report = {
    ok: true,
    window: { sinceMs: summary.sinceMs, untilMs: summary.untilMs, label },
    scannedFiles: summary.scannedFiles,
    totals: {
      total: toNumber(summary.totals?.total),
      input: toNumber(summary.totals?.input),
      output: toNumber(summary.totals?.output),
      cacheRead: toNumber(summary.totals?.cacheRead),
      cacheWrite: toNumber(summary.totals?.cacheWrite),
      reasoning: toNumber(summary.totals?.reasoning),
      messages: toNumber(summary.totals?.messages),
      sessions: toNumber(summary.totals?.sessions),
      activeDays: toNumber(summary.totals?.activeDays),
    },
    deltaPct,
    groupBy,
    ranking: rankingRows(summary, groupBy, limit),
    cost: {
      currency,
      total: Math.round(cost.total * 100) / 100,
      pricedModels: cost.pricedModels,
      unpriced: cost.unpriced,
      perModel: Object.fromEntries(
        [...cost.perModel].map(([id, value]) => [id, Math.round(value * 100) / 100]),
      ),
    },
    streak: summary.streak,
    peak: peakHour(summary.hourly),
  };

  return { ...report, text: formatText(report) };
}

async function onLoad() {
  await pi.commands.register({
    id: "tokenInsights.open",
    title: "Token Insights: Open",
    keywords: ["token", "usage", "tokens", "cost", "spend", "stats"],
    category: "Productivity",
    run: async () => {
      await pi.ui.openPanel({ title: "Token Insights" });
    },
  });

  await pi.agent.registerTool({
    name: "token_usage_summary",
    description:
      "Summarize local token usage: totals, per-model and per-project rankings, " +
      "busiest hours, activity streak, and estimated cost when a price table exists.",
    risk: "medium",
    schema: {
      type: "object",
      properties: {
        since: {
          type: "string",
          description:
            "Start of the window, inclusive. ISO date or date-time, or a shorthand like 7d, 30d, 12w, 1y.",
        },
        until: { type: "string", description: "End of the window, exclusive. Defaults to now." },
        groupBy: {
          type: "string",
          enum: ["model", "project", "day", "session"],
          description: "Which ranking to expand. Defaults to model.",
        },
        limit: { type: "number", description: "Max rows in the ranking (default 10, max 25)." },
      },
    },
    execute: async (args = {}) => buildReport(args),
  });
}

async function onUnload() {
  await pi.commands.unregister("tokenInsights.open");
  await pi.agent.unregisterTool("token_usage_summary");
}

module.exports = {
  onLoad,
  onUnload,
};
