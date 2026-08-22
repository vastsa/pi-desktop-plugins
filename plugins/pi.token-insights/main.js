/**
 * Token Insights scans local usage metadata from supported AI tools and hands a
 * compact, de-identified fact cube to its panel through plugin settings.
 *
 * Three things are published into settings:
 *   usageFacts     the fact cube the panel filters and aggregates locally
 *   hostAppearance the app's current theme/locale, so the panel can follow it
 *   scanState      whether a scan is running, so the panel can say so
 *
 * The panel bridge has no channel for usage or appearance, which is why the
 * plugin process resolves both and the panel only reads settings. Nothing here
 * writes outside the plugin's own settings, and nothing reaches the network.
 */

const path = require("node:path");
const { watch } = require("node:fs");
const { homedir } = require("node:os");
const {
  mergeResults,
  scanClaudeCodeDirectory,
  scanCodexDirectory,
  scanOpenCodeDirectory,
  scanPiTranscriptDirectory,
  sourceLabel,
  toTokens,
} = require("./source-adapters");
const aggregateApi = require("./aggregate");
const { hostRootFromDataPath, readHostAppearance, readProviderLabels } = require("./host-read");

const { aggregate, buildFacts, dayKeyFromTimestamp, milestones, shiftDayKey, todayKey } = aggregateApi;

const RELATIVE = /^(\d+)\s*(d|w|m|y)$/i;
/** How often the host's appearance record is re-checked while the plugin lives. */
const APPEARANCE_POLL_MS = 2_000;
/**
 * Scan progress is published at most this often. Each publish rewrites the
 * plugin settings file, so the cadence is a compromise between a bar that moves
 * and disk the user never asked us to churn.
 */
const SCAN_PROGRESS_MS = 400;
/** A change under a source directory waits this long for the flurry to settle. */
const WATCH_DEBOUNCE_MS = 30_000;
/** …and a watch-triggered rescan never runs more often than this. */
const WATCH_MIN_GAP_MS = 5 * 60_000;
/** Data older than this refreshes on the next change, debounce or not. */
const WATCH_MAX_STALE_MS = 15 * 60_000;

let testRoots = null;
let appearanceTimer = null;
let appearanceFingerprint = null;
let scanning = null;
let watchers = [];
let watchTimer = null;
let lastScanFinishedAt = 0;

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

async function hostRoot() {
  return hostRootFromDataPath(await pi.plugin.getDataPath());
}

/** PI-Desktop transcripts live next to the plugin data directory. */
async function transcriptRoot() {
  return path.join(await hostRoot(), "sessions");
}

/** The four directories this plugin ever reads usage from. */
async function sourceRoots() {
  const home = homedir();
  return {
    piDesktop: testRoots?.piDesktop || (await transcriptRoot()),
    claudeCode: testRoots?.claudeCode || path.join(home, ".claude", "projects"),
    codex: testRoots?.codex || path.join(home, ".codex", "sessions"),
    openCode: testRoots?.openCode || path.join(home, ".local", "share", "opencode", "storage", "message"),
  };
}

async function scanEvents(progress) {
  const roots = await sourceRoots();
  const results = await Promise.all([
    scanPiTranscriptDirectory(roots.piDesktop, progress),
    scanClaudeCodeDirectory(roots.claudeCode, progress),
    scanCodexDirectory(roots.codex, progress),
    scanOpenCodeDirectory(roots.openCode, progress),
  ]);
  return mergeResults(results);
}

/**
 * Counts every adapter's files into one total and ticks per file, throttling the
 * publish so the panel gets a bar that moves without a write per file.
 */
function progressReporter(publish) {
  const counts = { filesTotal: 0, filesScanned: 0 };
  let lastAt = 0;
  const emit = (force) => {
    const now = Date.now();
    if (!force && now - lastAt < SCAN_PROGRESS_MS) return;
    lastAt = now;
    publish({ ...counts, updatedAt: now });
  };
  return {
    counts,
    // A new total is worth showing at once: it is what turns the bar determinate.
    addTotal(count) {
      counts.filesTotal += count;
      emit(true);
    },
    tick() {
      counts.filesScanned += 1;
      // Always publish the final file, or the bar freezes short of the end and
      // then vanishes — which reads as "it stalled", not "it finished".
      emit(counts.filesTotal > 0 && counts.filesScanned >= counts.filesTotal);
    },
  };
}

async function collectFacts(progress) {
  const startedAt = Date.now();
  // Resolving provider names is best-effort: an unreadable host only means the
  // panel keeps showing the raw provider id it already had.
  let providerLabels = {};
  try {
    providerLabels = readProviderLabels(await hostRoot());
  } catch {
    providerLabels = {};
  }
  const { events, diagnostics } = await scanEvents(progress);
  const facts = buildFacts(events, {
    generatedAt: startedAt,
    labelForSource: sourceLabel,
    labelForProvider: (id) => providerLabels[id] || id,
    diagnostics,
  });
  facts.scanMs = Date.now() - startedAt;
  return facts;
}

/**
 * Rescan and publish. Concurrent callers share one scan: the command, the tool
 * and the load hook all want the same fresh cube, not three of them.
 */
function refreshFacts(reason = "manual") {
  if (scanning) return scanning;
  scanning = (async () => {
    const startedAt = Date.now();
    // Settings writes are read-modify-write over the whole file, so only one is
    // ever in flight. A sample that arrives during a write is remembered rather
    // than dropped, which is what guarantees the last one — 100% — lands.
    let writing = false;
    let queued = null;
    const write = (counts) => {
      writing = true;
      void pi.plugin
        .setSettings({ scanState: { status: "scanning", startedAt, reason, ...counts } })
        .catch(() => undefined)
        .finally(() => {
          writing = false;
          if (queued) {
            const next = queued;
            queued = null;
            write(next);
          }
        });
    };
    const publish = (counts) => {
      if (writing) queued = counts;
      else write(counts);
    };
    await pi.plugin.setSettings({
      scanState: { status: "scanning", startedAt, reason, filesTotal: 0, filesScanned: 0, updatedAt: startedAt },
    });
    try {
      const facts = await collectFacts(progressReporter(publish));
      lastScanFinishedAt = Date.now();
      await pi.plugin.setSettings({
        usageFacts: facts,
        scanState: {
          status: "ready",
          finishedAt: lastScanFinishedAt,
          scanMs: facts.scanMs,
          filesScanned: facts.diagnostics.filesScanned,
          reason,
        },
        // v2 snapshots are no longer read; drop the payload instead of leaving a
        // stale copy of it behind in settings.json.
        usageSnapshot: null,
      });
      return facts;
    } catch (error) {
      lastScanFinishedAt = Date.now();
      await pi.plugin.setSettings({
        scanState: { status: "failed", finishedAt: lastScanFinishedAt, message: String(error?.message || error) },
      });
      throw error;
    } finally {
      scanning = null;
    }
  })();
  return scanning;
}

/**
 * Watch the source directories so the dashboard keeps up on its own.
 *
 * The panel bridge is read-only, so a panel cannot ask for a rescan — without
 * this, data would only refresh when the command runs. Debounced hard and rate
 * limited, because a full scan costs seconds of CPU and the answer changes
 * slowly.
 */
function startSourceWatch(roots) {
  stopSourceWatch();
  for (const root of Object.values(roots)) {
    try {
      const watcher = watch(root, { recursive: true, persistent: false }, () => {
        // Continuous activity keeps resetting the debounce, so a long busy
        // session would never refresh; past this age the next event scans.
        const stale = Date.now() - lastScanFinishedAt > WATCH_MAX_STALE_MS;
        if (stale && !scanning) {
          if (watchTimer) clearTimeout(watchTimer);
          watchTimer = null;
          void refreshFacts("watch").catch(() => undefined);
          return;
        }
        if (watchTimer) clearTimeout(watchTimer);
        watchTimer = setTimeout(() => {
          watchTimer = null;
          if (scanning) return;
          if (Date.now() - lastScanFinishedAt < WATCH_MIN_GAP_MS) return;
          void refreshFacts("watch").catch(() => undefined);
        }, WATCH_DEBOUNCE_MS);
        watchTimer.unref?.();
      });
      watcher.on?.("error", () => undefined);
      watchers.push(watcher);
    } catch {
      // A missing or unwatchable directory just means no auto-refresh from it.
    }
  }
}

function stopSourceWatch() {
  if (watchTimer) clearTimeout(watchTimer);
  watchTimer = null;
  for (const watcher of watchers) {
    try {
      watcher.close();
    } catch {
      /* already gone */
    }
  }
  watchers = [];
}

/** Appearance is cheap to read and changes at human speed; a small poll is enough. */
async function publishAppearance(root) {
  const appearance = readHostAppearance(root);
  const fingerprint = JSON.stringify([
    appearance.ok,
    appearance.themePreference,
    appearance.base,
    appearance.locale,
    appearance.pluginTheme?.id ?? null,
    appearance.pluginTheme?.css?.length ?? 0,
  ]);
  if (fingerprint === appearanceFingerprint) return appearance;
  appearanceFingerprint = fingerprint;
  await pi.plugin.setSettings({ hostAppearance: appearance });
  return appearance;
}

function startAppearanceWatch(root) {
  stopAppearanceWatch();
  appearanceTimer = setInterval(() => {
    void publishAppearance(root).catch(() => undefined);
  }, APPEARANCE_POLL_MS);
  appearanceTimer.unref?.();
}

function stopAppearanceWatch() {
  if (appearanceTimer) clearInterval(appearanceTimer);
  appearanceTimer = null;
}

/* -------------------------------------------------------------- agent tool */

function parseInstant(input) {
  if (input == null || input === "") return null;
  const text = String(input).trim();
  const relative = RELATIVE.exec(text);
  if (relative) {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    const amount = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    if (unit === "d") date.setDate(date.getDate() - amount);
    if (unit === "w") date.setDate(date.getDate() - amount * 7);
    if (unit === "m") date.setMonth(date.getMonth() - amount);
    if (unit === "y") date.setFullYear(date.getFullYear() - amount);
    return date.getTime();
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const [year, month, day] = text.split("-").map(Number);
    return new Date(year, month - 1, day).getTime();
  }
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : parsed;
}

function compact(value) {
  const amount = number(value);
  if (amount >= 1_000_000_000) return `${(amount / 1_000_000_000).toFixed(2)}B`;
  if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(2)}M`;
  if (amount >= 1_000) return `${(amount / 1_000).toFixed(1)}K`;
  return String(Math.round(amount));
}

function stringList(value) {
  if (value == null) return [];
  const list = Array.isArray(value) ? value : String(value).split(",");
  return list.map((item) => String(item).trim()).filter(Boolean);
}

/**
 * The tool answers from the same cube and the same aggregation the panel uses,
 * so "which model cost me the most this month" cannot disagree with the screen.
 */
async function buildReport(args = {}) {
  const sinceInput = args.since == null ? "" : String(args.since).trim();
  const untilInput = args.until == null ? "" : String(args.until).trim();
  const sinceMs = parseInstant(sinceInput);
  const untilMs = parseInstant(untilInput);
  if (sinceInput && sinceMs == null) {
    throw new Error("Invalid since value. Use an ISO date or a shorthand such as 30d.");
  }
  if (untilInput && untilMs == null) throw new Error("Invalid until value. Use an ISO date or date-time.");
  if (sinceMs != null && untilMs != null && sinceMs >= untilMs) {
    throw new Error("The since value must be earlier than until.");
  }

  const facts = await refreshFacts();
  const filter = {
    sinceDay: sinceMs == null ? null : dayKeyFromTimestamp(sinceMs),
    // `until` is exclusive for callers, inclusive for day buckets.
    untilDay: untilMs == null ? null : shiftDayKey(dayKeyFromTimestamp(untilMs), -1),
    sources: stringList(args.sources ?? args.source),
    models: stringList(args.models ?? args.model),
    providers: stringList(args.providers ?? args.provider),
    query: args.query == null ? "" : String(args.query),
  };
  const summary = aggregate(facts, filter);
  const groupBy = ["model", "provider", "source", "day", "session"].includes(args.groupBy)
    ? args.groupBy
    : "model";
  const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 25);
  const rows =
    groupBy === "day"
      ? [...summary.daily].sort((left, right) => right.total - left.total)
      : summary[`${groupBy}s`] || [];
  const total = summary.totals.total;
  const ranking = rows.slice(0, limit).map((row) => ({
    key: row.label ?? row.date,
    total: number(row.total),
    messages: number(row.messages),
    share: total ? Math.round((number(row.total) / total) * 1000) / 10 : 0,
  }));
  const reach = milestones(facts);

  const lines = [
    "# Token usage",
    "",
    `- Window: ${filter.sinceDay || facts.days[0] || "n/a"} → ${filter.untilDay || facts.days[facts.days.length - 1] || "n/a"}`,
    `- Total: ${total.toLocaleString("en-US")} tokens (in ${compact(summary.totals.input)}, out ${compact(summary.totals.output)}, cache read ${compact(summary.totals.cacheRead)}, reasoning ${compact(summary.totals.reasoning)})`,
    `- Activity: ${summary.totals.messages} assistant replies across ${summary.totals.sessions} sessions on ${summary.totals.activeDays} active days`,
    `- Streak: ${summary.streak.current} days${summary.streak.includesToday ? " including today" : summary.streak.endedOn ? " through yesterday" : ""}, longest ${summary.streak.longest}`,
    summary.deltaPct == null
      ? "- Previous period: no comparable window"
      : `- Previous period: ${summary.deltaPct >= 0 ? "+" : ""}${summary.deltaPct}%`,
    "",
    `## Top by ${groupBy}`,
    ...(ranking.length
      ? ranking.map((row) => `- ${row.key}: ${compact(row.total)} tokens (${row.share}%, ${row.messages} replies)`)
      : ["- nothing matched this filter"]),
    "",
    `_Scanned ${facts.diagnostics.filesScanned} local metadata files. Message text is never read or returned._`,
  ];

  return {
    ok: true,
    scannedFiles: facts.diagnostics.filesScanned,
    window: { sinceDay: filter.sinceDay, untilDay: filter.untilDay },
    totals: summary.totals,
    groupBy,
    ranking,
    deltaPct: summary.deltaPct,
    streak: summary.streak,
    peakHour: summary.peakHour,
    milestone: reach.latest,
    nextMilestone: reach.next,
    text: lines.join("\n"),
  };
}

/* ---------------------------------------------------------------- lifecycle */

async function onLoad() {
  const root = await hostRoot();
  // Appearance first: the panel should never open in the wrong palette while a
  // six-second scan finishes.
  await publishAppearance(root).catch(() => undefined);
  startAppearanceWatch(root);

  await pi.commands.register({
    id: "tokenInsights.open",
    title: "Token Insights: Open",
    keywords: ["token", "usage", "tokens", "cost", "spend", "stats", "用量", "统计"],
    category: "Productivity",
    run: async () => {
      await publishAppearance(root).catch(() => undefined);
      // Open now, scan behind it: the panel renders the previous cube and
      // switches to the fresh one as soon as it lands.
      await pi.ui.openPanel();
      void refreshFacts("command").catch((error) =>
        pi.ui.showToast(`Token Insights scan failed: ${error.message}`, "warn"),
      );
    },
  });

  await pi.agent.registerTool({
    name: "token_usage_summary",
    description:
      "Scan supported local AI-tool metadata and summarize token use by tool source, model, provider, day, " +
      "or short session id. Supports the same filters as the dashboard and never returns message text.",
    risk: "medium",
    schema: {
      type: "object",
      properties: {
        since: { type: "string", description: "ISO date/date-time or a shorthand such as 7d, 30d, 12w, 1y." },
        until: { type: "string", description: "Exclusive ISO date/date-time end. Defaults to now." },
        groupBy: { type: "string", enum: ["model", "provider", "source", "day", "session"] },
        sources: { type: "string", description: "Comma-separated tool sources, e.g. pi-desktop,codex." },
        models: { type: "string", description: "Comma-separated model ids to keep." },
        providers: { type: "string", description: "Comma-separated provider ids to keep." },
        query: { type: "string", description: "Free-text match over source, model, provider or short session id." },
        limit: { type: "number", description: "Maximum ranking rows, from 1 through 25." },
      },
    },
    execute: buildReport,
  });

  startSourceWatch(await sourceRoots());
  void refreshFacts("load").catch((error) =>
    pi.ui.showToast(`Token Insights scan failed: ${error.message}`, "warn"),
  );
}

async function onUnload() {
  stopAppearanceWatch();
  stopSourceWatch();
  await pi.commands.unregister("tokenInsights.open");
  await pi.agent.unregisterTool("token_usage_summary");
}

module.exports = {
  onLoad,
  onUnload,
  __test: {
    aggregate,
    buildFacts,
    buildReport,
    collectFacts,
    progressReporter,
    refreshFacts,
    sourceRoots,
    milestones,
    parseInstant,
    readHostAppearance,
    readProviderLabels,
    scanClaudeCodeDirectory,
    scanCodexDirectory,
    scanOpenCodeDirectory,
    scanPiTranscriptDirectory,
    todayKey,
    toTokens,
    setScanRoots: (roots) => {
      testRoots = roots;
    },
  },
};
