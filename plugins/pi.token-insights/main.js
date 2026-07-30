/**
 * Token Insights scans local usage metadata from supported AI tools. It never
 * stores transcript content in its plugin snapshot or agent-tool output.
 */

const path = require("node:path");
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

const RELATIVE = /^(\d+)\s*(d|w|m|y)$/i;
let testRoots = null;

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function emptyTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 };
}

function emptyTotals() {
  return { ...emptyTokens(), messages: 0, sessions: 0, activeDays: 0 };
}

function addTokens(target, source) {
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "reasoning", "total"]) {
    target[key] += number(source[key]);
  }
}

function dayKey(timestamp) {
  const date = new Date(timestamp);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function startOfToday() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function makeRange(sinceMs, untilMs) {
  return { sinceMs: sinceMs ?? null, untilMs: untilMs ?? null };
}

function contains(range, timestamp) {
  return (range.sinceMs == null || timestamp >= range.sinceMs) &&
    (range.untilMs == null || timestamp < range.untilMs);
}

function zeroSlots(length) {
  return Array.from({ length }, () => ({ total: 0, messages: 0 }));
}

function groupEntry(map, key) {
  if (!map.has(key)) {
    map.set(key, { tokens: emptyTokens(), messages: 0, sessions: new Set(), lastActivityAt: 0 });
  }
  return map.get(key);
}

function pushGroup(group, event) {
  addTokens(group.tokens, event.tokens);
  group.messages += 1;
  group.sessions.add(event.sessionId);
  group.lastActivityAt = Math.max(group.lastActivityAt, event.timestamp);
}

function namespacedSessionId(event) {
  const sourceId = String(event.sourceId || "unknown");
  const sessionId = String(event.sessionId || "unknown");
  return sessionId.startsWith(`${sourceId}:`) ? sessionId : `${sourceId}:${sessionId}`;
}

function sortByTotal(entries) {
  return entries.sort((left, right) => right.total - left.total || left.label.localeCompare(right.label));
}

function streak(events) {
  const active = new Set(events.map((event) => dayKey(event.timestamp)));
  if (!active.size) return { current: 0, longest: 0 };

  let longest = 0;
  let run = 0;
  const ordered = [...active].sort();
  let previous = null;
  for (const key of ordered) {
    const date = new Date(`${key}T00:00:00`);
    if (previous && date.getTime() - previous.getTime() === 86_400_000) run += 1;
    else run = 1;
    longest = Math.max(longest, run);
    previous = date;
  }

  let current = 0;
  for (let cursor = startOfToday(); ; cursor = addDays(cursor, -1)) {
    if (!active.has(dayKey(cursor.getTime()))) break;
    current += 1;
  }
  return { current, longest };
}

function totalsForRange(events, range) {
  const totals = emptyTotals();
  const sessions = new Set();
  const days = new Set();
  for (const event of events) {
    if (!contains(range, event.timestamp)) continue;
    addTokens(totals, event.tokens);
    totals.messages += 1;
    sessions.add(namespacedSessionId(event));
    days.add(dayKey(event.timestamp));
  }
  totals.sessions = sessions.size;
  totals.activeDays = days.size;
  return totals;
}

function summarize(events, range, allEvents, generatedAt, diagnostics = {}) {
  const selected = events.filter((event) => contains(range, event.timestamp));
  const totals = emptyTotals();
  const daily = new Map();
  const models = new Map();
  const providers = new Map();
  const sources = new Map();
  const sessions = new Map();
  const sessionIds = new Set();
  const hourly = zeroSlots(24);
  const weekday = zeroSlots(7);

  for (const inputEvent of selected) {
    const event = { ...inputEvent, sessionId: namespacedSessionId(inputEvent) };
    addTokens(totals, event.tokens);
    totals.messages += 1;
    sessionIds.add(event.sessionId);

    const day = groupEntry(daily, dayKey(event.timestamp));
    pushGroup(day, event);
    pushGroup(groupEntry(models, `${event.sourceId}\u0000${event.providerId}\u0000${event.modelId}`), event);
    pushGroup(groupEntry(providers, event.providerId), event);
    pushGroup(groupEntry(sources, event.sourceId), event);
    pushGroup(groupEntry(sessions, event.sessionId), event);

    const timestamp = new Date(event.timestamp);
    hourly[timestamp.getHours()].total += event.tokens.total;
    hourly[timestamp.getHours()].messages += 1;
    const dayIndex = (timestamp.getDay() + 6) % 7;
    weekday[dayIndex].total += event.tokens.total;
    weekday[dayIndex].messages += 1;
  }

  totals.sessions = sessionIds.size;
  totals.activeDays = daily.size;
  const previousRange = range.sinceMs == null
    ? null
    : makeRange(
        range.sinceMs - ((range.untilMs ?? generatedAt) - range.sinceMs),
        range.sinceMs,
      );
  const previousTotals = previousRange ? totalsForRange(events, previousRange) : emptyTotals();

  const asDaily = [...daily.entries()]
    .map(([date, value]) => ({ date, ...value.tokens, messages: value.messages }))
    .sort((left, right) => left.date.localeCompare(right.date));
  const asModels = sortByTotal(
    [...models.entries()].map(([key, value]) => {
      const [sourceId, providerId, modelId] = key.split("\u0000");
      return {
        label: `${sourceLabel(sourceId)} / ${providerId}/${modelId}`,
        sourceId,
        providerId,
        modelId,
        ...value.tokens,
        messages: value.messages,
        sessions: value.sessions.size,
      };
    }),
  );
  const asProviders = sortByTotal(
    [...providers.entries()].map(([providerId, value]) => ({
      label: providerId,
      providerId,
      ...value.tokens,
      messages: value.messages,
      sessions: value.sessions.size,
    })),
  );
  const asSources = sortByTotal(
    [...sources.entries()].map(([sourceId, value]) => ({
      label: sourceLabel(sourceId),
      sourceId,
      ...value.tokens,
      messages: value.messages,
      sessions: value.sessions.size,
    })),
  );
  const asSessions = sortByTotal(
    [...sessions.entries()].map(([id, value]) => {
      const [sourceId, ...sessionParts] = id.split(":");
      const shortId = sessionParts.join(":").slice(0, 8);
      return {
        label: `${sourceLabel(sourceId)} · Session ${shortId}`,
        title: `${sourceLabel(sourceId)} · Session ${shortId}`,
        total: value.tokens.total,
        messages: value.messages,
        lastActivityAt: value.lastActivityAt,
      };
    }),
  ).slice(0, 12);
  let firstActivityAt = null;
  let lastActivityAt = null;
  for (const event of allEvents) {
    if (firstActivityAt == null || event.timestamp < firstActivityAt) firstActivityAt = event.timestamp;
    if (lastActivityAt == null || event.timestamp > lastActivityAt) lastActivityAt = event.timestamp;
  }

  return {
    generatedAt,
    scannedFiles: number(diagnostics.filesScanned),
    skippedFiles: number(diagnostics.filesSkipped),
    malformedLines: number(diagnostics.malformedLines),
    usageMessages: number(diagnostics.usageMessages),
    sourceDiagnostics: diagnostics.sources || [],
    sinceMs: range.sinceMs,
    untilMs: range.untilMs,
    firstActivityAt,
    lastActivityAt,
    totals,
    previousTotals,
    daily: asDaily,
    hourly,
    weekday,
    models: asModels,
    providers: asProviders,
    sources: asSources,
    topSessions: asSessions,
    streak: streak(allEvents),
  };
}

async function transcriptRoot() {
  const pluginData = await pi.plugin.getDataPath();
  return path.resolve(pluginData, "..", "..", "..", "sessions");
}

async function scanEvents() {
  const piRoot = testRoots?.piDesktop || await transcriptRoot();
  const home = homedir();
  const results = await Promise.all([
    scanPiTranscriptDirectory(piRoot),
    scanClaudeCodeDirectory(testRoots?.claudeCode || path.join(home, ".claude", "projects")),
    scanCodexDirectory(testRoots?.codex || path.join(home, ".codex", "sessions")),
    scanOpenCodeDirectory(testRoots?.openCode || path.join(home, ".local", "share", "opencode", "storage", "message")),
  ]);
  return mergeResults(results);
}

async function collectSnapshot() {
  const generatedAt = Date.now();
  const { events, diagnostics } = await scanEvents();
  const today = startOfToday();
  return {
    schemaVersion: 2,
    generatedAt,
    all: summarize(events, makeRange(null, null), events, generatedAt, diagnostics),
    thirtyDays: summarize(events, makeRange(addDays(today, -29).getTime(), generatedAt), events, generatedAt, diagnostics),
    oneYear: summarize(events, makeRange(addDays(today, -364).getTime(), generatedAt), events, generatedAt, diagnostics),
  };
}

async function refreshSnapshot() {
  const snapshot = await collectSnapshot();
  await pi.plugin.setSettings({ usageSnapshot: snapshot });
  return snapshot;
}

function parseInstant(input, now) {
  if (input == null || input === "") return null;
  const text = String(input).trim();
  const relative = RELATIVE.exec(text);
  if (relative) {
    const date = startOfToday();
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
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}

function ranking(summary, groupBy, limit) {
  const total = number(summary.totals?.total);
  const rows = groupBy === "source" ? summary.sources
    : groupBy === "provider" ? summary.providers
    : groupBy === "day" ? [...(summary.daily || [])].sort((a, b) => b.total - a.total)
    : groupBy === "session" ? summary.topSessions
    : summary.models;
  return (rows || []).slice(0, limit).map((row) => ({
    key: row.modelId || row.providerId || row.date || row.title,
    total: number(row.total),
    share: total ? Math.round((number(row.total) / total) * 1000) / 10 : 0,
  }));
}

async function buildReport(args = {}) {
  const now = Date.now();
  const sinceInput = args.since == null ? "" : String(args.since).trim();
  const untilInput = args.until == null ? "" : String(args.until).trim();
  const sinceMs = parseInstant(sinceInput, now);
  const untilMs = parseInstant(untilInput, now);
  if (sinceInput && sinceMs == null) throw new Error("Invalid since value. Use an ISO date or a shorthand such as 30d.");
  if (untilInput && untilMs == null) throw new Error("Invalid until value. Use an ISO date or date-time.");
  if (sinceMs != null && untilMs != null && sinceMs >= untilMs) throw new Error("The since value must be earlier than until.");

  const { events, diagnostics } = await scanEvents();
  const summary = summarize(events, makeRange(sinceMs, untilMs), events, now, diagnostics);
  const groupBy = ["model", "provider", "source", "day", "session"].includes(args.groupBy) ? args.groupBy : "model";
  const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 25);
  const previous = number(summary.previousTotals?.total);
  const deltaPct = previous ? Math.round(((summary.totals.total - previous) / previous) * 1000) / 10 : null;
  const report = {
    ok: true,
    scannedFiles: summary.scannedFiles,
    totals: summary.totals,
    groupBy,
    ranking: ranking(summary, groupBy, limit),
    deltaPct,
    streak: summary.streak,
  };
  const lines = [
    "# Token usage",
    "",
    `- Total: ${summary.totals.total.toLocaleString("en-US")} tokens`,
    `- Activity: ${summary.totals.messages} assistant replies across ${summary.totals.sessions} sessions`,
    `- Streak: ${summary.streak.current} days now, longest ${summary.streak.longest}`,
    "",
    `## Top by ${groupBy}`,
    ...report.ranking.map((row) => `- ${row.key}: ${compact(row.total)} tokens (${row.share}%)`),
    "",
    `_Scanned ${summary.scannedFiles} local transcript files. Message text is never returned._`,
  ];
  return { ...report, text: lines.join("\n") };
}

async function onLoad() {
  await pi.commands.register({
    id: "tokenInsights.open",
    title: "Token Insights: Open",
    keywords: ["token", "usage", "tokens", "cost", "spend", "stats"],
    category: "Productivity",
    run: async () => {
      await refreshSnapshot();
      await pi.ui.openPanel({ title: "Token Insights" });
    },
  });
  await pi.agent.registerTool({
    name: "token_usage_summary",
    description: "Scan supported local AI-tool metadata and summarize token use by tool, model, provider, day, or session without returning message text.",
    risk: "medium",
    schema: {
      type: "object",
      properties: {
        since: { type: "string", description: "ISO date/date-time or a shorthand such as 7d, 30d, 12w, 1y." },
        until: { type: "string", description: "Exclusive ISO date/date-time end. Defaults to now." },
        groupBy: { type: "string", enum: ["model", "provider", "source", "day", "session"] },
        limit: { type: "number", description: "Maximum ranking rows, from 1 through 25." },
      },
    },
    execute: buildReport,
  });
  void refreshSnapshot().catch((error) => pi.ui.showToast(`Token Insights scan failed: ${error.message}`, "warn"));
}

async function onUnload() {
  await pi.commands.unregister("tokenInsights.open");
  await pi.agent.unregisterTool("token_usage_summary");
}

module.exports = {
  onLoad,
  onUnload,
  __test: {
    scanClaudeCodeDirectory,
    scanCodexDirectory,
    scanOpenCodeDirectory,
    scanPiTranscriptDirectory,
    summarize,
    toTokens,
    makeRange,
    parseInstant,
    setScanRoots: (roots) => { testRoots = roots; },
  },
};
