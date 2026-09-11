/**
 * Universal Session Import — plugin entry.
 *
 * Host injects global `pi`. The work-panel view drives this process through
 * custom `pluginBridge.invoke("import.*")` channels, forwarded to
 * `onPanelInvoke`:
 *
 *   import.scanSource  {source}              -> {found, count}  (cached)
 *   import.sessions    {source}              -> {sessions}
 *   import.convertBatch {source, items:[summary]} -> {sessions:[ImportedSession]}
 *
 * Converted sessions are imported by the panel through the host
 * "session.import" bridge, one call per session.
 */
"use strict";

const {
  ADAPTERS,
  getAdapter,
  allAdapters,
  refreshDynamicSources,
  getDynamicLoadReport,
  CONFIG_PATH,
} = require("./lib/registry");
const { driverNames } = require("./lib/drivers");
const forge = require("./lib/forge");
const bus = require("./lib/bus");
const history = require("./lib/history");
const saveModes = require("./lib/save-modes");

/** Scan results cached per source so switching sources never rescans. */
const cache = new Map();

async function onLoad() {
  await pi.commands.register({
    id: "session-import.open",
    title: "Session Import: Open Panel",
    keywords: ["import", "导入", "会话"],
    run: async () => {
      await pi.ui.openPanel({ title: "一体化会话导入" });
    },
  });

  // P0-F2: explicit "switch to forge" command usable from the importer UI
  // or as a slash command. Opens the work-panel's forge view by its declared
  // view id.
  await pi.commands.register({
    id: "session-forge.show",
    title: "Session Forge: Open Work-Panel View",
    keywords: ["forge", "蒸馏", "panel"],
    run: async () => {
      const caps = forgeCapabilities();
      const missing = Object.entries(caps).filter(([, v]) => !v).map(([k]) => k);
      if (missing.length) {
        await pi.ui.showToast(
          `会话熔炉：宿主缺少 ${missing.join(", ")}，请升级或重新授权`,
          "warn",
        );
        return;
      }
      try {
        await pi.ui.openPanel?.({ viewId: "session-forge" });
      } catch {
        await pi.ui.showToast("会话熔炉：右侧工作面板已可打开「会话熔炉」", "info");
      }
    },
  });

  // 熔炉是 docked view，不是独立窗口；命令只做提示与自检。
  await pi.commands.register({
    id: "session-forge.open",
    title: "Session Forge: Distill Imported Sessions",
    keywords: ["forge", "蒸馏", "distill", "规则", "skill"],
    run: async () => {
      const caps = forgeCapabilities();
      const missing = Object.entries(caps).filter(([, v]) => !v).map(([k]) => k);
      await pi.ui.showToast(
        missing.length
          ? `会话熔炉：宿主缺少 ${missing.join(", ")}，请升级或重新授权`
          : "会话熔炉：在右侧工作面板打开「会话熔炉」",
        missing.length ? "warn" : "info",
      );
    },
  });

  // User-defined sources live in docs/session-import-sources.json and are read
  // through the host fs bridge, so they stay inside the declared fs.read scope.
  // A missing or invalid config simply means "built-in sources only".
  try {
    await refreshDynamicSources({ readText: async (rel) => pi.fs.readText(rel) });
  } catch {
    /* no workspace / no config -> built-in sources only */
  }
}

async function onUnload() {
  await pi.commands.unregister("session-import.open");
  await pi.commands.unregister("session-forge.open");
  await pi.commands.unregister("session-forge.show");
}

async function onPanelInvoke(channel, payload) {
  switch (channel) {
    case "import.adapters":
      return allAdapters().map((a) => ({
        source: a.source,
        label: a.label,
        custom: a.custom === true,
        dataPath: a.dataPath || null,
      }));
    case "import.customSources": {
      const report = getDynamicLoadReport();
      return {
        configPath: report.configPath || CONFIG_PATH,
        drivers: driverNames(),
        count: report.count ?? 0,
        errors: report.errors ?? [],
      };
    }
    case "import.reloadCustomSources": {
      try {
        await refreshDynamicSources({ readText: async (rel) => pi.fs.readText(rel) });
      } catch (err) {
        return {
          configPath: CONFIG_PATH,
          drivers: driverNames(),
          count: 0,
          errors: [String((err && err.message) || err)],
        };
      }
      const report = getDynamicLoadReport();
      return {
        configPath: report.configPath || CONFIG_PATH,
        drivers: driverNames(),
        count: report.count ?? 0,
        errors: report.errors ?? [],
      };
    }
    case "import.scanSource":
      return scanSource(payload);
    case "import.sessions":
      return sessions(payload);
    case "import.convertBatch":
      return convertBatch(payload);
    case "import.capabilities":
      return { officialSessionApi: officialSessionApi() !== null };
    case "import.commit": {
      const source = String(payload?.source ?? "");
      const items = Array.isArray(payload?.items) ? payload.items : [];
      // Prefer the official batch API when the host advertises it. The
      // plugin SDK exposes `pi.session.importBatch` as a callable even when
      // the host has not implemented the backing RPC, so we must guard on the
      // *runtime* error ("host api not available") rather than a typeof check.
      const official = officialSessionApi();
      if (official) {
        try {
          const placement = payload?.placement === "project" ? "project" : "standalone";
          return await commitOfficial(source, items, placement);
        } catch (e) {
          if (!hostLacksImportApi(e)) throw e; // genuine failure — surface it
          // host advertised importBatch but rejected the call → legacy bridge
        }
      }
      // Legacy single-session bridge (local dev host with session.import wired,
      // e.g. feat/zcode-session-import). Catches missing-host-API and reports a
      // clear error instead of a cryptic crash.
      try {
        return await commitLegacy(source, items);
      } catch (e) {
        if (hostLacksImportApi(e) || /HOST_LACKS_IMPORT/.test(String(e?.message ?? e))) {
          throw new Error(
            "当前宿主未提供会话导入接口（session.import / importBatch）。" +
              "请使用接入了导入桥接的宿主构建（feat/zcode-session-import 分支），" +
              "或升级到支持官方 pi.session.importBatch 的宿主版本。",
          );
        }
        throw e;
      }
    }
    // --- P0-F1: cross-view state — forge polls this on each refresh ---
    case "import.recent":
      return {
        lastImportAt: bus.recentImport.at ? bus.recentImport.at.toISOString() : null,
        lastImportCount: bus.recentImport.count,
        lastImportSource: bus.recentImport.source,
      };
    // --- P0-F2: importer view asks main to emit a native notification,
    // telling the user to switch to the forge view. pluginBridge cannot
    // reach pi.ui.* directly from inside the sandboxed view.
    case "import.notify":
      await pi.ui.notify({
        title: String(payload?.title ?? "Session Import"),
        body: String(payload?.body ?? ""),
      });
      return { ok: true };
    // --- P1-U1: best-effort host locale so the work-panel views can pick
    // en / zh-CN without guessing. Falls back to zh-CN when the host SDK
    // does not expose a locale (older builds). ---
    case "app.locale":
      return bestEffortLocale();
    // --- Forge: 会话蒸馏（读回本插件导入的行 -> 宿主 one-shot 补全）---
    case "forge.capabilities":
      return forgeCapabilities();
    case "forge.sessions":
      return forgeSessions(payload);
    case "forge.messages":
      return forgeMessages(payload);
    case "forge.models":
      return forgeModels();
    case "forge.distill":
      return forgeDistill(payload);
    case "forge.save":
      return forgeSave(payload);
    // --- P1-F3: distillation history (JSONL ring buffer under docs/**) ---
    case "forge.history.load":
      return { entries: await loadHistory() };
    case "forge.history.record":
      return { count: await recordHistory(payload?.entry ?? {}) };
    default:
      throw new Error(`unknown channel: ${channel}`);
  }
}

// ---------------------------------------------------------------------------
// Locale — P1-U1
// ---------------------------------------------------------------------------

/** Resolve the host's UI locale, preferring SDK-provided values. */
function bestEffortLocale() {
  const raw = pi?.i18n?.locale || pi?.app?.locale || pi?.locale;
  if (typeof raw === "string" && /^(en|zh-CN|zh)$/i.test(raw.trim())) {
    const v = raw.trim().toLowerCase();
    return v === "zh" ? "zh-CN" : v;
  }
  return "zh-CN";
}

// ---------------------------------------------------------------------------
// Forge — 会话熔炉
// ---------------------------------------------------------------------------

function forgeCapabilities() {
  return {
    listSessions: typeof pi?.session?.list === "function",
    listMessages: typeof pi?.session?.listMessages === "function",
    complete: typeof pi?.agent?.complete === "function",
    models: typeof pi?.models?.list === "function",
    writeText: typeof pi?.fs?.writeText === "function",
  };
}

async function forgeSessions(payload) {
  const sessions = await forge.listImported({
    source: payload?.source ? String(payload.source) : undefined,
    limit: payload?.limit,
  });
  return { sessions };
}

async function forgeMessages(payload) {
  const sessionId = String(payload?.sessionId ?? "");
  if (!sessionId) throw new Error("sessionId required");
  const messages = await forge.readMessages(sessionId, { limit: payload?.limit });
  return { sessionId, messages };
}

async function forgeModels() {
  const rows = await pi.models.list();
  return { models: Array.isArray(rows) ? rows : (rows?.models ?? []) };
}

async function forgeDistill(payload) {
  const sessionIds = Array.isArray(payload?.sessionIds) ? payload.sessionIds : [];
  if (sessionIds.length === 0) throw new Error("no sessions selected");

  // P1#3: 蒸馏必须显式带非空的 modelKey，否则宿主拒收 INVALID_ARGUMENT
  const modelKey = payload?.modelKey || undefined;
  if (!modelKey) throw new Error("请先在上方选择一个蒸馏模型（modelKey 不能为空）");

  // 逐个取回消息；单会话失败不阻断整批。
  const sessions = [];
  let unreadable = 0;
  for (const id of sessionIds) {
    try {
      const meta = payload?.sessions?.find((s) => String(s.id) === String(id)) ?? { id };
      const messages = await forge.readMessages(String(id));
      sessions.push({ ...meta, id: String(id), messages });
    } catch {
      unreadable += 1;
    }
  }
  if (sessions.length === 0) throw new Error("selected sessions could not be read");

  const result = await forge.distill({
    sessions,
    modelKey,
    thinkingLevel: payload?.thinkingLevel || undefined,
    goal: payload?.goal ? String(payload.goal) : undefined,
  });

  return { ok: true, distilled: result.text, usage: result.usage, unreadable };
}

async function forgeSave(payload) {
  const path = String(payload?.path ?? "");
  const content = String(payload?.content ?? "");
  const mode = saveModes.normalize(payload?.mode);
  if (!path) throw new Error("path required");
  if (!content.trim()) throw new Error("nothing to save");
  // P1-F4: overwrite replaces; append/merge need the current file content.
  let existing = "";
  if (mode !== "overwrite") {
    try {
      existing = await pi.fs.readText(path);
    } catch {
      existing = ""; // file not present yet, or read denied — start fresh
    }
  }
  const final = saveModes.combine(existing, content, mode);
  await pi.fs.writeText(path, final);
  const bytes = Buffer.byteLength(final, "utf8");
  // P1-F3: record a history entry for every successful save.
  await recordHistory({
    path,
    mode,
    bytes,
    at: new Date().toISOString(),
    modelKey: payload?.modelKey || null,
    goal: payload?.goal || null,
  });
  return { ok: true, path, bytes, mode };
}

// --- P1-F3: history persistence (read-modify-write under docs/**) ---

async function loadHistory() {
  try {
    return history.parseJsonl(await pi.fs.readText(history.HISTORY_PATH));
  } catch {
    return [];
  }
}

async function recordHistory(entry) {
  const entries = history.addEntry(await loadHistory(), entry);
  try {
    await pi.fs.writeText(history.HISTORY_PATH, history.toJsonl(entries));
  } catch {
    // persistence is best-effort; in-memory entries still returned
  }
  return entries.length;
}

/**
 * Scan a source. Adapters may expose `scanFast()` for a cheap first pass (the
 * Codex adapter does: its rollout tree can hold hundreds of multi-MB
 * transcripts). When one exists we return that immediately, mark the entry
 * `partial`, and queue the full scan for later.
 *
 * The full scan is deliberately NOT started while other sources are still
 * scanning: it reads GBs off the same disk and starves the panels the user is
 * actually waiting on (measured: a concurrent WorkBuddy scan went 1.7s → 9.5s
 * behind Codex's background pass). It runs once the foreground queue drains.
 */
async function scanSource(payload) {
  const source = String(payload?.source ?? "");
  const adapter = getAdapter(source);
  if (!adapter) throw new Error(`unknown source: ${source}`);
  const wantsFull = payload?.full === true;
  if (cache.has(source) && !wantsFull) {
    const sessions = cache.get(source);
    // Cached entries keep their original error (frozen at scan time) so the
    // panel can still show why the first scan failed.
    const error = cacheError.get(source) ?? null;
    return {
      source,
      found: sessions.length > 0,
      count: sessions.length,
      error,
      partial: cachePartial.get(source) === true,
    };
  }

  const useFast = !wantsFull && typeof adapter.scanFast === "function" && !cache.has(source);
  let sessions = [];
  let error = null;
  foregroundScans += 1;
  try {
    const scanFn = useFast ? adapter.scanFast : adapter.scan;
    sessions = await withTimeout(() => scanFn.call(adapter), SCAN_TIMEOUT_MS, `${source}.scan`);
  } catch (e) {
    error = {
      code: e?.code ?? "UNKNOWN",
      message: String(e?.message ?? e),
    };
    sessions = [];
  } finally {
    foregroundScans -= 1;
    // Only the fast branch queues work, but any scan finishing can be the last
    // one outstanding — e.g. Codex's fast pass returns first and queues, then
    // Claude/WorkBuddy finish a second later and unblock the queue.
    if (foregroundScans === 0) scheduleFullScans();
  }
  // C-robustness: drop duplicate summaries (same source+externalId) so the
  // panel never previews or imports the same session twice, and flag sessions
  // that will hit the host's 2000-message cap so the UI can warn about likely
  // truncation. The host is idempotent on externalId, but dedupe keeps the UI
  // honest about what it will actually import.
  const { deduped, oversizedCount } = dedupeSummaries(sessions, source);
  sessions = deduped;
  cache.set(source, sessions);
  cacheError.set(source, error);
  cachePartial.set(source, useFast);
  if (useFast) {
    pendingFullScans.push({ source, adapter });
    // A later call serves the completed list straight from the cache.
    scheduleFullScans();
  }
  return {
    source,
    found: sessions.length > 0,
    count: sessions.length,
    error,
    partial: useFast,
    oversized: oversizedCount,
  };
}

/**
 * Pure helper backing {@link scanSource}: remove duplicate summaries by
 * `source:externalId` and flag sessions whose `messageCount` exceeds the host's
 * 2000-message cap (they will be truncated on import). Exported for tests.
 */
function dedupeSummaries(sessions, source) {
  const seen = new Set();
  const deduped = [];
  let oversizedCount = 0;
  for (const s of sessions) {
    const key = `${s.source || source}:${s.externalId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (typeof s.messageCount === "number" && s.messageCount > CONTRACT.messagesMax) {
      s.oversized = true;
      oversizedCount += 1;
    }
    deduped.push(s);
  }
  return { deduped, oversizedCount };
}

/** Run queued full scans once no foreground scan is outstanding. */
function scheduleFullScans() {
  if (foregroundScans > 0 || pendingFullScans.length === 0) return;
  const next = pendingFullScans.shift();
  void warmFullScan(next.source, next.adapter).finally(() => {
    if (pendingFullScans.length > 0) scheduleFullScans();
  });
}

/** Background full scan used to promote a partial result to a complete one. */
async function warmFullScan(source, adapter) {
  if (fullScanInFlight.has(source)) return;
  fullScanInFlight.add(source);
  try {
    const sessions = await withTimeout(
      () => adapter.scan(),
      FULL_SCAN_TIMEOUT_MS,
      `${source}.scanFull`,
    );
    cache.set(source, sessions);
    cachePartial.set(source, false);
    if (typeof pi?.events?.emit === "function") {
      pi.events.emit("import.scanReady", { source, count: sessions.length });
    }
  } catch {
    // Leave the partial list in place; the next explicit scan retries.
  } finally {
    fullScanInFlight.delete(source);
  }
}

const cachePartial = new Map();
const fullScanInFlight = new Set();
const pendingFullScans = [];
let foregroundScans = 0;

// Parallel cache for scan errors so re-asking the same source preserves the
// original failure (avoid failing twice); never expires alongside the
// session cache.
const cacheError = new Map();

function sessions(payload) {
  const source = String(payload?.source ?? "");
  if (!cache.has(source)) throw new Error(`source not scanned: ${source}`);
  return { source, sessions: cache.get(source) };
}

async function convertBatch(payload) {
  const source = String(payload?.source ?? "");
  const adapter = getAdapter(source);
  if (!adapter) throw new Error(`unknown source: ${source}`);
  const items = Array.isArray(payload?.items) ? payload.items : [];
  if (items.length === 0) throw new Error("nothing selected to import");

  const sessions = [];
  let unreadable = 0;
  for (const item of items) {
    try {
      const conv = await withTimeout(
        () => adapter.convert(item),
        CONVERT_TIMEOUT_MS,
        `${source}.convert`,
      );
      // Host UiMessage requires an id on every message; adapters describe
      // content only, so allocate ids here in one place.
      conv.messages = conv.messages.map((m) => ({
        id: crypto.randomUUID(),
        ...m,
      }));
      sessions.push(conv);
    } catch {
      unreadable += 1;
    }
  }
  return { ok: true, source, sessions, unreadable };
}

// ---------------------------------------------------------------------------
// Official session API (PI-Desktop #169, P0/P1 — pi.session.importBatch).
// Falls back to the legacy dev-build "session.import" bridge when the host
// does not provide the official API yet.
// ---------------------------------------------------------------------------

const CONTRACT = {
  titleMax: 200,
  externalIdMax: 256,
  contentMax: 512 * 1024, // 512 KiB per message content
  toolPayloadMax: 256 * 1024, // 256 KiB serialized toolArgs/toolResult
  jsonDepthMax: 8,
  batchSessionsMax: 100, // importBatch hard limit per call
  messagesMax: 2000, // official LIMIT_EXCEEDED guard (origin/main plugin-runtime)
};

// The host measures every size limit in UTF-8 BYTES
// (plugin-runtime.ts: new TextEncoder().encode(content).byteLength), not in
// UTF-16 code units. CJK / emoji messages weigh 3-4 bytes per character, so a
// naive `String.slice(0, 512 * 1024)` can be 3x over the limit and the host
// rejects the whole batch with "message content exceeds 512 KiB". Keep a small
// margin so encoding overhead on our side never tips it over.
const SIZE_SAFETY_MARGIN = 1024;

/**
 * Truncate a string to at most `maxBytes` UTF-8 bytes without leaving a
 * broken surrogate pair at the cut. Binary-search the boundary so huge
 * transcripts (multi-MB tool results) stay cheap.
 */
const CONVERT_CONCURRENCY = 8;

/** Run `worker` over `items` with bounded concurrency, preserving order. */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = { ok: true, value: await worker(items[index]) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

// ---------------------------------------------------------------------------
// Timeout watchdog — C: a single source's scan/convert must never be able to
// hang the whole panel. A hung `adapter.scan()` (corrupt 224MB db, a network-
// mounted transcript, an un-closed read stream) would otherwise leave
// `foregroundScans` permanently > 0, which blocks `scheduleFullScans()` from
// ever firing and freezes the "scanning" spinner forever. We race every
// scan/convert against a deadline and surface a clean TIMEOUT error instead.
// ---------------------------------------------------------------------------

const SCAN_TIMEOUT_MS = 90 * 1000; // foreground scan (user is waiting on it)
const FULL_SCAN_TIMEOUT_MS = 5 * 60 * 1000; // background full pass (non-blocking)
const CONVERT_TIMEOUT_MS = 30 * 1000; // one session's convert

/** Error raised when a guarded operation exceeds its deadline. */
class TimeoutError extends Error {
  constructor(label, ms) {
    super(`${label} 在 ${ms}ms 内未完成（已超时）`);
    this.code = "TIMEOUT";
    this.name = "TimeoutError";
  }
}

/**
 * Run `factory()` and reject after `ms` if it has not settled.
 *
 * Adapters are a mix of sync (`zcode.scan` reads the DB synchronously) and
 * async (`workbuddy.scan` fans out over the filesystem). A synchronous return
 * cannot be interrupted — but those paths are bounded DB reads, not the hang
 * risk — so we pass it through untouched. Only genuine promises are raced.
 *
 * The underlying promise is intentionally NOT aborted (Node has no cheap way to
 * cancel arbitrary I/O); we merely stop waiting on it. It keeps running
 * read-only in the background and is harmless once the panel has moved on.
 */
function withTimeout(factory, ms, label) {
  let result;
  try {
    result = factory();
  } catch (error) {
    return Promise.reject(error);
  }
  if (!result || typeof result.then !== "function") return Promise.resolve(result);
  if (!Number.isFinite(ms) || ms <= 0) return result;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
  });
  return Promise.race([result, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Bytes a value occupies once the host re-serializes it.
 *
 * The host validates `TextEncoder().encode(JSON.stringify(value)).byteLength`,
 * NOT the raw string length. JSON escaping inflates control characters, quotes
 * and backslashes by up to ~44% (measured), so budgeting a 256 KiB *raw*
 * string can still produce a >256 KiB serialized value and get the whole batch
 * rejected with "toolResult exceeds 256 KiB".
 */
function serializedBytes(value) {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return 0;
    return Buffer.byteLength(serialized, "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Truncate a string so its **JSON-serialized** form fits `maxBytes`.
 *
 * `serializedBytes` counts the value, so the shrinking is done by binary
 * search on the serialized length rather than the raw byte length. Escaping can
 * only shrink in proportion as characters are removed, so this converges.
 */
function truncateToSerializedBytes(text, maxBytes) {
  const value = String(text ?? "");
  if (!value) return value;
  const budget = Math.max(0, maxBytes - SIZE_SAFETY_MARGIN);
  if (serializedBytes(value) <= budget) return value;
  let lo = 0;
  let hi = value.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (serializedBytes(value.slice(0, mid)) <= budget) lo = mid;
    else hi = mid - 1;
  }
  let cut = value.slice(0, lo);
  // Drop a trailing lone high surrogate so the payload stays valid UTF-8.
  if (cut.length > 0) {
    const last = cut.charCodeAt(cut.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  }
  return cut;
}

/**
 * Raw-byte truncation, for places that are NOT re-serialized by the host
 * (nothing today — kept for callers that need a pure byte budget).
 */
function truncateBytes(text, maxBytes) {
  const value = String(text ?? "");
  if (!value) return value;
  const budget = Math.max(0, maxBytes - SIZE_SAFETY_MARGIN);
  if (Buffer.byteLength(value, "utf8") <= budget) return value;
  let lo = 0;
  let hi = value.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (Buffer.byteLength(value.slice(0, mid), "utf8") <= budget) lo = mid;
    else hi = mid - 1;
  }
  let cut = value.slice(0, lo);
  // Drop a trailing lone high surrogate so the payload stays valid UTF-8.
  if (cut.length > 0) {
    const last = cut.charCodeAt(cut.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  }
  return cut;
}

/**
 * Official validation (origin/main plugin-runtime.ts validatePluginSessionPayload)
 * rejects: empty/blank titles (>200 code points), missing externalId, non-RFC3339
 * timestamps, createdAt > updatedAt, non-monotonic message times, >2000 messages,
 * roles outside user/assistant/tool, content > 512 KiB. One bad item fails the
 * WHOLE batch (fail semantics), so pre-validate here and skip the bad item
 * instead of poisoning the batch.
 */
function contractViolation(item, conv) {
  const title = String(conv.session.title ?? item.title ?? "");
  if (!title.trim()) return "empty title";
  const externalId = String(item.externalId ?? conv.session.id ?? "");
  if (!externalId.trim()) return "empty externalId";
  return null;
}

function officialSessionApi() {
  return typeof pi?.session?.importBatch === "function" ? pi.session : null;
}

/**
 * True when the host rejected a session-import call because the API is not
 * actually wired up. The plugin SDK surfaces `pi.session.importBatch` /
 * `pi.session.import` as callables regardless, so the only reliable signal
 * is the runtime error the host emits ("host api not available",
 * "UNSUPPORTED", or an unhandled panel channel).
 */
function hostLacksImportApi(e) {
  const s = e?.message ? String(e.message) : String(e ?? "");
  return /host api not available/i.test(s) || /UNSUPPORTED/i.test(s) || /unknown channel/i.test(s);
}

function parseIsoMs(iso, fallbackMs) {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? fallbackMs : t;
}

function toIso(ms) {
  return new Date(ms).toISOString();
}

function jsonDepth(value, depth = 1) {
  if (value === null || typeof value !== "object") return depth;
  let max = depth;
  for (const v of Object.values(value)) max = Math.max(max, jsonDepth(v, depth + 1));
  return max;
}

// The official validator counts depth over the WHOLE batch input:
// input(1) → sessions(2) → session(3) → messages(4) → message(5) → toolArgs…
// so a tool payload's own depth budget is 8 − 5 = 3. Anything deeper is
// stringified (depth 1) — losing structure but never poisoning the batch.
const TOOL_PAYLOAD_DEPTH_MAX = 3;

/** Keep tool payloads inside contract size/depth limits without dropping data. */
function safeToolPayload(value) {
  if (value === null || value === undefined) return undefined;
  const simple = typeof value !== "object";
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return undefined;

  if (Buffer.byteLength(serialized, "utf8") > CONTRACT.toolPayloadMax) {
    // Oversized by raw measure. The host re-serializes whatever we send, so a
    // truncated *string* must still fit once JSON escaping is applied — which
    // can add ~44%. Truncating the stringified form as a string budgets
    // against that escaped size directly.
    return truncateToSerializedBytes(serialized, CONTRACT.toolPayloadMax);
  }
  if (!simple && jsonDepth(value) > TOOL_PAYLOAD_DEPTH_MAX) {
    // Too deep for the host's depth budget; a string is depth-1. Guard its
    // serialized size too, since stringifying may itself expand.
    return truncateToSerializedBytes(serialized, CONTRACT.toolPayloadMax);
  }
  return value;
}

/** Map one converted session onto the #169 `importBatch` input shape. */
function toContractSession(item, conv, projectId) {
  // createdAt ≤ updatedAt; invalid timestamps degrade to the session bound.
  const createdMs = parseIsoMs(
    conv.session.createdAt ?? item.createdAt,
    parseIsoMs(conv.session.updatedAt ?? item.updatedAt, Date.now()),
  );
  const updatedMs = Math.max(
    parseIsoMs(conv.session.updatedAt ?? item.updatedAt, createdMs),
    createdMs,
  );
  const createdAt = toIso(createdMs);
  const updatedAt = toIso(updatedMs);

  let prevMs = createdMs; // message times must be monotonic non-decreasing
  const messages = [];
  for (const m of conv.messages) {
    if (m.role !== "user" && m.role !== "assistant" && m.role !== "tool") continue;
    if (messages.length >= CONTRACT.messagesMax) break; // official hard limit
    const atMs = Math.max(parseIsoMs(m.createdAt, prevMs), prevMs);
    prevMs = atMs;
    const msg = {
      role: m.role,
      // Budgeted against the serialized size: the host measures
      // JSON.stringify(content), which escaping can inflate well past the raw
      // byte count.
      content: truncateToSerializedBytes(m.content ?? "", CONTRACT.contentMax),
      createdAt: toIso(atMs),
    };
    if (m.role === "tool") {
      msg.toolName = String(m.toolName ?? "tool");
      msg.toolCallId = String(m.toolCallId ?? m.id ?? crypto.randomUUID());
      msg.toolStatus = m.toolStatus === "error" ? "error" : "success";
      const args = safeToolPayload(m.toolArgs);
      const result = safeToolPayload(m.toolResult);
      if (args !== undefined) msg.toolArgs = args;
      if (result !== undefined) msg.toolResult = result;
    }
    messages.push(msg);
  }

  const session = {
    externalId: String(item.externalId ?? conv.session.id).slice(0, CONTRACT.externalIdMax),
    title: String(conv.session.title ?? item.title ?? "").slice(0, CONTRACT.titleMax),
    projectPath: conv.session.projectPath ?? null,
    modelId: conv.session.modelId ?? null,
    providerId: conv.session.providerId ?? null,
    createdAt,
    updatedAt,
    messages,
  };
  // Host contract: only an explicit host-created projectId binds the session
  // to a project. The official host opens plugin-created projects in the
  // renderer when project.create succeeds, so project-bound imports appear in
  // the sidebar as well as the Projects index. An unbound session
  // (projectId omitted) lands in the standalone SESSIONS list. Binding remains
  // opt-in ("placement: project").
  if (projectId !== undefined && projectId !== null) session.projectId = projectId;
  const enforced = enforceContractLimits(session);
  // A session whose message count was capped at the host's 2000-message hard
  // limit also lost content, so flag it as truncated alongside the byte-cap
  // case so the user gets warned either way.
  const messageCapped = conv.messages.length > messages.length;
  return { session: enforced.session, truncated: enforced.truncated || messageCapped };
}

/**
 * Last line of defence against the host's per-field limits.
 *
 * The host rejects the ENTIRE batch for one over-limit field, so a single
 * pathological message would otherwise cost the user every session in the
 * import. Everything above already truncates, but the limits are expressed in
 * serialized bytes and escaping is easy to underestimate; this re-measures
 * against exactly what the host computes and hard-clamps anything that still
 * does not fit.
 */
function enforceContractLimits(session) {
  let truncated = false;
  for (const message of session.messages) {
    const contentBytes = serializedBytes(message.content);
    if (contentBytes > CONTRACT.contentMax) {
      message.content = truncateToSerializedBytes(
        String(message.content ?? ""),
        CONTRACT.contentMax,
      );
      truncated = true;
    }
    if (message.role !== "tool") continue;
    for (const field of ["toolArgs", "toolResult"]) {
      const value = message[field];
      if (value === undefined) continue;
      const bytes = serializedBytes(value);
      if (bytes <= CONTRACT.toolPayloadMax) continue;
      // Truncate through the stringified form so the escaped size is what we
      // budget against.
      const serialized = JSON.stringify(value) ?? "";
      message[field] = truncateToSerializedBytes(serialized, CONTRACT.toolPayloadMax);
      truncated = true;
    }
  }
  return { session, truncated };
}

/**
 * Resolve (and memoize) a host project id per project path. The host's
 * project.create is idempotent for an existing path (returns the same row),
 * so calling it once per distinct path per import is safe.
 */
const projectIdByPath = new Map();
async function resolveProjectId(path) {
  if (!path) return null;
  if (projectIdByPath.has(path)) return projectIdByPath.get(path);
  let id = null;
  if (typeof pi?.project?.create === "function") {
    try {
      const res = await pi.project.create({ path });
      id = Number(res?.projectId ?? res?.id) || null;
    } catch {
      id = null; // host without project.create: fall back to unbound import
    }
  }
  projectIdByPath.set(path, id);
  return id;
}

/**
 * Convert + import the selected summaries through the official API.
 * Chunked at the contract batch limit; aggregates importBatch results.
 */
async function commitOfficial(source, items, placement) {
  const adapter = getAdapter(source);
  if (!adapter) throw new Error(`unknown source: ${source}`);
  const bindProjects = placement === "project";

  // Conversion is dominated by file IO (whole transcripts are read and
  // parsed), so run it with a small concurrency pool instead of serially —
  // a 60-session Claude Code import dropped from ~50s to a few seconds.
  const startedAt = Date.now();
  const converted = await mapWithConcurrency(items, CONVERT_CONCURRENCY, (item) =>
    withTimeout(() => adapter.convert(item), CONVERT_TIMEOUT_MS, `${source}.convert`),
  );
  const convertedAt = Date.now();
  const convertMs = convertedAt - startedAt;

  // Opt-in project binding: resolve each host projectId once per distinct
  // path (memoized inside resolveProjectId), so project.create stays
  // idempotent. Done before the (synchronous) payload assembly below so the
  // byte-costly truncation work stays off the await path.
  if (bindProjects) {
    const paths = new Set();
    for (const outcome of converted) {
      const path = outcome?.ok ? outcome.value?.session?.projectPath : null;
      if (path) paths.add(path);
    }
    for (const path of paths) await resolveProjectId(path);
  }

  const contractSessions = [];
  let unreadable = 0;
  let truncated = 0; // sessions that lost content to the host's byte caps
  for (let i = 0; i < items.length; i += 1) {
    const outcome = converted[i];
    if (!outcome?.ok) {
      unreadable += 1;
      continue;
    }
    const conv = outcome.value;
    if (contractViolation(items[i], conv)) {
      unreadable += 1; // skip poisoned item instead of failing the batch
      continue;
    }
    const projectId = bindProjects
      ? projectIdByPath.get(conv.session.projectPath) ?? null
      : null;
    const built = toContractSession(items[i], conv, projectId);
    contractSessions.push(built.session);
    if (built.truncated) truncated += 1;
  }
  const builtAt = Date.now();

  let imported = 0;
  let skipped = 0;
  const failed = [];
  const batchTimes = [];
  for (let i = 0; i < contractSessions.length; i += CONTRACT.batchSessionsMax) {
    const chunk = contractSessions.slice(i, i + CONTRACT.batchSessionsMax);
    const bt = Date.now();
    const res = await officialSessionApi().importBatch({ source, sessions: chunk, mode: "skip" });
    batchTimes.push({ n: chunk.length, ms: Date.now() - bt });
    imported += res.imported ?? 0;
    skipped += res.skipped ?? 0;
    for (const r of res.results ?? []) {
      if (r.status === "failed") {
        failed.push({ externalId: r.externalId, error: r.errorMessage ?? r.errorCode ?? "failed" });
      }
    }
  }
  const finishedAt = Date.now();
  // P0-F1: record this batch on the cross-view bus so the forge view can
  // surface a "just imported N sessions" hint on next refresh.
  if (imported > 0) {
    bus.recordImport({ count: imported, source });
  }
  return {
    ok: failed.length === 0,
    imported,
    skipped,
    failed,
    unreadable,
    truncated,
    timings: {
      convertMs,
      buildMs: builtAt - convertedAt,
      importMs: finishedAt - builtAt,
      batches: batchTimes,
    },
  };
}

/**
 * Legacy single-session import through the dev-host "session.import" bridge
 * (host-core RPC `session.import`, gated behind `services.importSession` on
 * feat/zcode-session-import). One `pi.session.import` call per converted
 * session; per-item failures are collected rather than aborting the batch.
 */
async function commitLegacy(source, items) {
  const adapter = getAdapter(source);
  if (!adapter) throw new Error(`unknown source: ${source}`);
  if (!pi?.session || typeof pi.session.import !== "function") {
    throw new Error("HOST_LACKS_IMPORT: 当前宿主未暴露 session.import 桥接");
  }

  let imported = 0;
  let skipped = 0;
  let unreadable = 0;
  const failed = [];
  for (const item of items) {
    try {
      const conv = await withTimeout(
        () => adapter.convert(item),
        CONVERT_TIMEOUT_MS,
        `${source}.convert`,
      );
      const messages = (conv.messages || []).map((m) => ({ id: crypto.randomUUID(), ...m }));
      const res = await pi.session.import({ session: conv.session, messages });
      if (res?.imported) imported += 1;
      else skipped += 1;
    } catch (e) {
      failed.push({ externalId: item?.externalId ?? item?.id, error: String(e?.message ?? e) });
    }
  }
  // P0-F1: surface the just-imported count on the forge view.
  if (imported > 0) bus.recordImport({ count: imported, source });
  return { ok: failed.length === 0, imported, skipped, failed, unreadable };
}

module.exports = {
  onLoad,
  onUnload,
  onPanelInvoke,
  // Exported for the self-test harness (tools/selftest-sources.cjs).
  withTimeout,
  dedupeSummaries,
  enforceContractLimits,
  toContractSession,
  truncateToSerializedBytes,
};
