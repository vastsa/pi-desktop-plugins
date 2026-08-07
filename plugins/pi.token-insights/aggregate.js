/**
 * Shared aggregation layer for Token Insights.
 *
 * The same file is required by the plugin process (agent tool) and loaded as a
 * plain script by the panel, so a number shown in the UI and a number returned
 * to the agent can never drift apart.
 *
 * Facts are a compact, de-identified cube: dictionaries of sources, models,
 * providers and short session ids, plus one row per
 * day × hour × source × model × provider × session. No message text, no tool
 * arguments, no project paths, no full session ids.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.TokenInsightsAggregate = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const SCHEMA_VERSION = 3;
  const TOKEN_KEYS = ["input", "output", "cacheRead", "cacheWrite", "reasoning", "total"];
  /** Column order of a bucket row. Kept explicit so the wire format is readable. */
  const COLUMNS = [
    "day", "hour", "source", "model", "provider", "session",
    "messages", "input", "output", "cacheRead", "cacheWrite", "reasoning", "total",
  ];
  const C = COLUMNS.reduce((map, name, index) => ({ ...map, [name]: index }), {});
  const DAY_MS = 86_400_000;
  /** Milestones worth a word. Below 1M a first-tokens message is kinder. */
  const MILESTONES = [
    1_000_000, 5_000_000, 10_000_000, 50_000_000, 100_000_000,
    500_000_000, 1_000_000_000, 5_000_000_000, 10_000_000_000,
    50_000_000_000, 100_000_000_000,
  ];

  function number(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  }

  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  /** Local-calendar day key. Both readers run on the same machine as the data. */
  function dayKeyFromTimestamp(timestamp) {
    const date = new Date(timestamp);
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  }

  function dayKeyFromDate(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  }

  function dateFromDayKey(key) {
    const [year, month, day] = String(key).split("-").map(Number);
    return new Date(year, (month || 1) - 1, day || 1);
  }

  function shiftDayKey(key, days) {
    const date = dateFromDayKey(key);
    date.setDate(date.getDate() + days);
    return dayKeyFromDate(date);
  }

  function daysBetween(fromKey, toKey) {
    const from = dateFromDayKey(fromKey).getTime();
    const to = dateFromDayKey(toKey).getTime();
    return Math.round((to - from) / DAY_MS);
  }

  function todayKey(now) {
    return dayKeyFromTimestamp(now == null ? Date.now() : now);
  }

  function emptyTokens() {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 };
  }

  function emptyTotals() {
    return { ...emptyTokens(), messages: 0, sessions: 0, activeDays: 0 };
  }

  function emptyFacts() {
    return {
      schemaVersion: SCHEMA_VERSION,
      generatedAt: 0,
      columns: COLUMNS.slice(),
      days: [],
      sources: [],
      models: [],
      providers: [],
      sessions: [],
      buckets: [],
      firstActivityAt: null,
      lastActivityAt: null,
      diagnostics: { filesScanned: 0, filesSkipped: 0, malformedLines: 0, usageMessages: 0, sources: [] },
    };
  }

  function indexer() {
    const map = new Map();
    const list = [];
    return {
      list,
      index(key, make) {
        const existing = map.get(key);
        if (existing != null) return existing;
        const next = list.length;
        map.set(key, next);
        list.push(make ? make() : key);
        return next;
      },
    };
  }

  /**
   * Fold scanned events into the fact cube.
   *
   * `labelForSource` maps a source id to its display label, and
   * `labelForProvider` resolves a provider id (PI-Desktop writes configuration
   * UUIDs) to the name the user gave it, so the panel never shows an opaque id
   * it could have translated.
   */
  function buildFacts(events, options = {}) {
    const labelForSource = options.labelForSource || ((id) => id);
    const labelForProvider = options.labelForProvider || ((id) => id);
    const facts = emptyFacts();
    facts.generatedAt = number(options.generatedAt) || Date.now();

    const days = indexer();
    const sources = indexer();
    const models = indexer();
    const providers = indexer();
    const sessions = indexer();
    const rows = new Map();
    let firstActivityAt = null;
    let lastActivityAt = null;

    for (const event of events) {
      const timestamp = Number(event?.timestamp);
      if (!Number.isFinite(timestamp)) continue;
      const tokens = event.tokens || {};
      const date = new Date(timestamp);
      const dayIndex = days.index(dayKeyFromDate(date));
      const hour = date.getHours();
      const sourceId = String(event.sourceId || "unknown");
      const sourceIndex = sources.index(sourceId, () => ({ id: sourceId, label: labelForSource(sourceId) }));
      const modelIndex = models.index(String(event.modelId || "Unknown model"));
      const providerId = String(event.providerId || "Unknown provider");
      const providerIndex = providers.index(providerId, () => ({
        id: providerId,
        label: labelForProvider(providerId) || providerId,
      }));
      // Session ids arrive namespaced (`<source>:<id>`); only a short, opaque
      // prefix is kept so a row can be listed without identifying a project.
      const rawSession = String(event.sessionId || "unknown");
      const bare = rawSession.startsWith(`${sourceId}:`) ? rawSession.slice(sourceId.length + 1) : rawSession;
      const sessionKey = `${sourceIndex}\u0000${bare}`;
      const sessionIndex = sessions.index(sessionKey, () => ({ short: bare.slice(0, 8), source: sourceIndex }));

      const key = `${dayIndex}|${hour}|${sourceIndex}|${modelIndex}|${providerIndex}|${sessionIndex}`;
      let row = rows.get(key);
      if (!row) {
        row = [dayIndex, hour, sourceIndex, modelIndex, providerIndex, sessionIndex, 0, 0, 0, 0, 0, 0, 0];
        rows.set(key, row);
      }
      row[C.messages] += 1;
      row[C.input] += number(tokens.input);
      row[C.output] += number(tokens.output);
      row[C.cacheRead] += number(tokens.cacheRead);
      row[C.cacheWrite] += number(tokens.cacheWrite);
      row[C.reasoning] += number(tokens.reasoning);
      row[C.total] += number(tokens.total);

      if (firstActivityAt == null || timestamp < firstActivityAt) firstActivityAt = timestamp;
      if (lastActivityAt == null || timestamp > lastActivityAt) lastActivityAt = timestamp;
    }

    // Day indices are assigned in scan order; sort them so any consumer can
    // treat `days` as a chronological axis.
    const order = days.list
      .map((key, index) => ({ key, index }))
      .sort((left, right) => left.key.localeCompare(right.key));
    const remap = new Array(order.length);
    order.forEach((entry, position) => {
      remap[entry.index] = position;
    });
    facts.days = order.map((entry) => entry.key);
    facts.sources = sources.list;
    facts.models = models.list;
    facts.providers = providers.list;
    facts.sessions = sessions.list;
    facts.buckets = [...rows.values()]
      .map((row) => {
        row[C.day] = remap[row[C.day]];
        return row;
      })
      .sort((left, right) => left[C.day] - right[C.day] || left[C.hour] - right[C.hour]);
    facts.firstActivityAt = firstActivityAt;
    facts.lastActivityAt = lastActivityAt;
    if (options.diagnostics) facts.diagnostics = options.diagnostics;
    return facts;
  }

  function isFacts(candidate) {
    return Boolean(
      candidate &&
        candidate.schemaVersion === SCHEMA_VERSION &&
        Array.isArray(candidate.days) &&
        Array.isArray(candidate.buckets) &&
        Array.isArray(candidate.sources),
    );
  }

  function normalizeFilter(filter = {}) {
    const list = (value) => (Array.isArray(value) ? value.filter((item) => item != null).map(String) : []);
    return {
      sinceDay: filter.sinceDay ? String(filter.sinceDay) : null,
      untilDay: filter.untilDay ? String(filter.untilDay) : null,
      sources: list(filter.sources),
      models: list(filter.models),
      providers: list(filter.providers),
      query: String(filter.query ?? "").trim().toLowerCase(),
    };
  }

  /** Index sets make the per-bucket test an integer lookup instead of a string compare. */
  function selectionSets(facts, filter) {
    const pick = (values, list, keyOf) => {
      if (!values.length) return null;
      const wanted = new Set(values.map((value) => value.toLowerCase()));
      const set = new Set();
      list.forEach((entry, index) => {
        if (wanted.has(String(keyOf(entry)).toLowerCase())) set.add(index);
      });
      return set;
    };
    return {
      sources: pick(filter.sources, facts.sources, (entry) => entry.id),
      models: pick(filter.models, facts.models, (entry) => entry),
      providers: pick(filter.providers, facts.providers, (entry) => entry.id),
    };
  }

  /** Rows a free-text query keeps. Matching is on labels the panel already shows. */
  function queryMatcher(facts, query) {
    if (!query) return null;
    const keep = { sources: new Set(), models: new Set(), providers: new Set(), sessions: new Set(), days: new Set() };
    facts.sources.forEach((entry, index) => {
      if (`${entry.id} ${entry.label}`.toLowerCase().includes(query)) keep.sources.add(index);
    });
    facts.models.forEach((entry, index) => {
      if (String(entry).toLowerCase().includes(query)) keep.models.add(index);
    });
    facts.providers.forEach((entry, index) => {
      if (`${entry.id} ${entry.label}`.toLowerCase().includes(query)) keep.providers.add(index);
    });
    facts.sessions.forEach((entry, index) => {
      if (String(entry.short).toLowerCase().includes(query)) keep.sessions.add(index);
    });
    facts.days.forEach((day, index) => {
      if (day.includes(query)) keep.days.add(index);
    });
    return (row) =>
      keep.sources.has(row[C.source]) ||
      keep.models.has(row[C.model]) ||
      keep.providers.has(row[C.provider]) ||
      keep.sessions.has(row[C.session]) ||
      keep.days.has(row[C.day]);
  }

  function addRow(target, row) {
    target.input += row[C.input];
    target.output += row[C.output];
    target.cacheRead += row[C.cacheRead];
    target.cacheWrite += row[C.cacheWrite];
    target.reasoning += row[C.reasoning];
    target.total += row[C.total];
    if ("messages" in target) target.messages += row[C.messages];
  }

  function groupBucket() {
    return { tokens: emptyTokens(), messages: 0, sessions: new Set(), lastDay: -1, lastHour: -1 };
  }

  function pushGroup(group, row) {
    addRow(group.tokens, row);
    group.messages += row[C.messages];
    group.sessions.add(row[C.session]);
    if (row[C.day] > group.lastDay || (row[C.day] === group.lastDay && row[C.hour] > group.lastHour)) {
      group.lastDay = row[C.day];
      group.lastHour = row[C.hour];
    }
  }

  function rankGroups(map, describe) {
    return [...map.entries()]
      .map(([key, group]) => ({
        key: String(key),
        ...describe(key, group),
        ...group.tokens,
        messages: group.messages,
        sessions: group.sessions.size,
        lastDay: group.lastDay,
        lastHour: group.lastHour,
      }))
      .sort((left, right) => right.total - left.total || String(left.label).localeCompare(String(right.label)));
  }

  /**
   * Streak over a set of active day keys.
   *
   * A streak that ended yesterday is reported as such instead of silently
   * collapsing to zero — the difference matters to the person reading it.
   */
  function streakFromDays(activeDays, now) {
    const days = activeDays instanceof Set ? activeDays : new Set(activeDays || []);
    const result = { current: 0, longest: 0, endedOn: null, includesToday: false };
    if (!days.size) return result;

    let run = 0;
    let previous = null;
    for (const key of [...days].sort()) {
      const time = dateFromDayKey(key).getTime();
      run = previous != null && time - previous === DAY_MS ? run + 1 : 1;
      result.longest = Math.max(result.longest, run);
      previous = time;
    }

    const today = todayKey(now);
    const anchor = days.has(today) ? today : days.has(shiftDayKey(today, -1)) ? shiftDayKey(today, -1) : null;
    if (anchor) {
      result.includesToday = anchor === today;
      result.endedOn = anchor;
      let cursor = anchor;
      while (days.has(cursor)) {
        result.current += 1;
        cursor = shiftDayKey(cursor, -1);
      }
    }
    return result;
  }

  /**
   * All-time milestone crossings, plus the next one and how far it is.
   * Derived from cumulative daily totals, so every date is one that happened.
   */
  function milestones(facts) {
    const daily = new Map();
    for (const row of facts.buckets) {
      const key = facts.days[row[C.day]];
      daily.set(key, (daily.get(key) || 0) + row[C.total]);
    }
    const ordered = [...daily.keys()].sort();
    const reached = [];
    let cumulative = 0;
    let cursor = 0;
    for (const day of ordered) {
      cumulative += daily.get(day);
      while (cursor < MILESTONES.length && cumulative >= MILESTONES[cursor]) {
        reached.push({ threshold: MILESTONES[cursor], date: day });
        cursor += 1;
      }
    }
    const next = cursor < MILESTONES.length ? MILESTONES[cursor] : null;
    return {
      total: cumulative,
      reached,
      latest: reached.length ? reached[reached.length - 1] : null,
      next: next
        ? { threshold: next, remaining: Math.max(0, next - cumulative), progress: next ? cumulative / next : 1 }
        : null,
    };
  }

  /**
   * Aggregate the cube under a filter.
   *
   * `previous` repeats the same aggregation over the window immediately before
   * the selected one (same length, same non-date filters) so a delta is always
   * comparing like with like.
   */
  function aggregate(facts, rawFilter = {}, options = {}) {
    const filter = normalizeFilter(rawFilter);
    const sets = selectionSets(facts, filter);
    const matchesQuery = queryMatcher(facts, filter.query);
    const sinceIndex = filter.sinceDay ? facts.days.findIndex((day) => day >= filter.sinceDay) : 0;
    const totals = emptyTotals();
    const daily = new Map();
    const hourly = Array.from({ length: 24 }, () => ({ total: 0, messages: 0 }));
    const weekday = Array.from({ length: 7 }, () => ({ total: 0, messages: 0 }));
    const bySource = new Map();
    const byModel = new Map();
    const byProvider = new Map();
    const bySession = new Map();
    const sessionIds = new Set();
    const activeDays = new Set();
    let matched = 0;

    for (const row of facts.buckets) {
      const day = facts.days[row[C.day]];
      if (filter.sinceDay && day < filter.sinceDay) continue;
      if (filter.untilDay && day > filter.untilDay) continue;
      if (sets.sources && !sets.sources.has(row[C.source])) continue;
      if (sets.models && !sets.models.has(row[C.model])) continue;
      if (sets.providers && !sets.providers.has(row[C.provider])) continue;
      if (matchesQuery && !matchesQuery(row)) continue;

      matched += 1;
      addRow(totals, row);
      sessionIds.add(row[C.session]);
      activeDays.add(day);

      const dayEntry = daily.get(day) || { total: 0, messages: 0 };
      dayEntry.total += row[C.total];
      dayEntry.messages += row[C.messages];
      daily.set(day, dayEntry);

      hourly[row[C.hour]].total += row[C.total];
      hourly[row[C.hour]].messages += row[C.messages];
      const weekIndex = (dateFromDayKey(day).getDay() + 6) % 7;
      weekday[weekIndex].total += row[C.total];
      weekday[weekIndex].messages += row[C.messages];

      pushGroup(bySource.get(row[C.source]) || bySource.set(row[C.source], groupBucket()).get(row[C.source]), row);
      pushGroup(byModel.get(row[C.model]) || byModel.set(row[C.model], groupBucket()).get(row[C.model]), row);
      pushGroup(
        byProvider.get(row[C.provider]) || byProvider.set(row[C.provider], groupBucket()).get(row[C.provider]),
        row,
      );
      pushGroup(bySession.get(row[C.session]) || bySession.set(row[C.session], groupBucket()).get(row[C.session]), row);
    }

    totals.sessions = sessionIds.size;
    totals.activeDays = activeDays.size;

    const peakHour = hourly.reduce((best, entry, index) => (entry.total > hourly[best].total ? index : best), 0);
    const peakWeekday = weekday.reduce((best, entry, index) => (entry.total > weekday[best].total ? index : best), 0);
    const bestDay = [...daily.entries()].reduce(
      (best, [date, entry]) => (best == null || entry.total > best.total ? { date, ...entry } : best),
      null,
    );

    const summary = {
      generatedAt: facts.generatedAt,
      filter,
      matchedBuckets: matched,
      totals,
      daily: [...daily.entries()]
        .map(([date, entry]) => ({ date, ...entry }))
        .sort((left, right) => left.date.localeCompare(right.date)),
      dailyMap: daily,
      hourly,
      weekday,
      peakHour: totals.total ? peakHour : null,
      peakWeekday: totals.total ? peakWeekday : null,
      bestDay,
      activeDays,
      streak: streakFromDays(activeDays, options.now),
      sources: rankGroups(bySource, (key) => ({
        label: facts.sources[Number(key)]?.label ?? String(key),
        id: facts.sources[Number(key)]?.id ?? String(key),
      })),
      models: rankGroups(byModel, (key) => ({
        label: facts.models[Number(key)] ?? String(key),
        id: facts.models[Number(key)] ?? String(key),
      })),
      providers: rankGroups(byProvider, (key) => ({
        label: facts.providers[Number(key)]?.label ?? String(key),
        id: facts.providers[Number(key)]?.id ?? String(key),
      })),
      sessions: rankGroups(bySession, (key) => {
        const entry = facts.sessions[Number(key)];
        return {
          label: entry ? entry.short : String(key),
          sourceLabel: entry ? facts.sources[entry.source]?.label ?? "" : "",
        };
      }).slice(0, options.sessionLimit || 12),
      firstDay: facts.days[Math.max(0, sinceIndex)] ?? null,
    };

    if (options.withPrevious !== false && filter.sinceDay) {
      const until = filter.untilDay || facts.days[facts.days.length - 1] || filter.sinceDay;
      const span = Math.max(1, daysBetween(filter.sinceDay, until) + 1);
      const previousFilter = {
        ...filter,
        sinceDay: shiftDayKey(filter.sinceDay, -span),
        untilDay: shiftDayKey(filter.sinceDay, -1),
      };
      const previous = aggregate(facts, previousFilter, { ...options, withPrevious: false });
      summary.previous = { totals: previous.totals, spanDays: span };
      summary.deltaPct =
        previous.totals.total > 0
          ? Math.round(((totals.total - previous.totals.total) / previous.totals.total) * 1000) / 10
          : null;
    } else {
      summary.previous = null;
      summary.deltaPct = null;
    }

    return summary;
  }

  return {
    SCHEMA_VERSION,
    COLUMNS,
    COLUMN_INDEX: C,
    MILESTONES,
    TOKEN_KEYS,
    aggregate,
    buildFacts,
    dateFromDayKey,
    dayKeyFromDate,
    dayKeyFromTimestamp,
    daysBetween,
    emptyFacts,
    emptyTokens,
    emptyTotals,
    isFacts,
    milestones,
    normalizeFilter,
    shiftDayKey,
    streakFromDays,
    todayKey,
  };
});
