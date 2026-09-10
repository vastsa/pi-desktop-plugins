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

const { ADAPTERS, getAdapter } = require("./lib/registry");
const forge = require("./lib/forge");

/** Scan results cached per source so switching sources never rescans. */
const cache = new Map();

async function onLoad() {
  await pi.commands.register({
    id: "session-import.open",
    title: "Session Import: Open Panel",
    keywords: ["import", "导入", "会话"],
    run: async () => {
      await pi.ui.openPanel();
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
}

async function onUnload() {
  await pi.commands.unregister("session-import.open");
  await pi.commands.unregister("session-forge.open");
}

async function onPanelInvoke(channel, payload) {
  switch (channel) {
    case "import.adapters":
      return ADAPTERS.map((a) => ({ source: a.source, label: a.label }));
    case "import.scanSource":
      return scanSource(payload);
    case "import.sessions":
      return sessions(payload);
    case "import.convertBatch":
      return convertBatch(payload);
    case "import.capabilities":
      return { officialSessionApi: officialSessionApi() !== null };
    case "import.commit":
      if (!officialSessionApi()) throw new Error("official session API unavailable on this host");
      return commitOfficial(String(payload?.source ?? ""), Array.isArray(payload?.items) ? payload.items : []);
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
    default:
      throw new Error(`unknown channel: ${channel}`);
  }
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
    modelKey: payload?.modelKey || undefined,
    thinkingLevel: payload?.thinkingLevel || undefined,
    goal: payload?.goal ? String(payload.goal) : undefined,
  });

  return { ok: true, distilled: result.text, usage: result.usage, unreadable };
}

async function forgeSave(payload) {
  const path = String(payload?.path ?? "");
  const content = String(payload?.content ?? "");
  if (!path) throw new Error("path required");
  if (!content.trim()) throw new Error("nothing to save");
  await pi.fs.writeText(path, content);
  return { ok: true, path, bytes: Buffer.byteLength(content, "utf8") };
}

async function scanSource(payload) {
  const source = String(payload?.source ?? "");
  const adapter = getAdapter(source);
  if (!adapter) throw new Error(`unknown source: ${source}`);
  if (cache.has(source)) {
    const sessions = cache.get(source);
    return { source, found: sessions.length > 0, count: sessions.length };
  }
  let sessions = [];
  try {
    sessions = await adapter.scan();
  } catch {
    sessions = [];
  }
  cache.set(source, sessions);
  return { source, found: sessions.length > 0, count: sessions.length };
}

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
      const conv = await adapter.convert(item);
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
};

function officialSessionApi() {
  return typeof pi?.session?.importBatch === "function" ? pi.session : null;
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

/** Keep tool payloads inside contract size/depth limits without dropping data. */
function safeToolPayload(value) {
  if (value === null || value === undefined) return undefined;
  const simple = typeof value !== "object";
  const serialized = JSON.stringify(value);
  if (serialized !== undefined && serialized.length > CONTRACT.toolPayloadMax) {
    return serialized.slice(0, CONTRACT.toolPayloadMax);
  }
  if (!simple && jsonDepth(value) > CONTRACT.jsonDepthMax) return serialized;
  return value;
}

/** Map one converted session onto the #169 `importBatch` input shape. */
function toContractSession(item, conv) {
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
    const atMs = Math.max(parseIsoMs(m.createdAt, prevMs), prevMs);
    prevMs = atMs;
    const msg = {
      role: m.role,
      content: String(m.content ?? "").slice(0, CONTRACT.contentMax),
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

  return {
    externalId: String(item.externalId ?? conv.session.id).slice(0, CONTRACT.externalIdMax),
    title: String(conv.session.title ?? item.title ?? "").slice(0, CONTRACT.titleMax),
    projectPath: conv.session.projectPath ?? null,
    modelId: conv.session.modelId ?? null,
    providerId: conv.session.providerId ?? null,
    createdAt,
    updatedAt,
    messages,
  };
}

/**
 * Convert + import the selected summaries through the official API.
 * Chunked at the contract batch limit; aggregates importBatch results.
 */
async function commitOfficial(source, items) {
  const adapter = getAdapter(source);
  if (!adapter) throw new Error(`unknown source: ${source}`);

  const contractSessions = [];
  let unreadable = 0;
  for (const item of items) {
    try {
      const conv = await adapter.convert(item);
      contractSessions.push(toContractSession(item, conv));
    } catch {
      unreadable += 1;
    }
  }

  let imported = 0;
  let skipped = 0;
  const failed = [];
  for (let i = 0; i < contractSessions.length; i += CONTRACT.batchSessionsMax) {
    const chunk = contractSessions.slice(i, i + CONTRACT.batchSessionsMax);
    const res = await officialSessionApi().importBatch({ source, sessions: chunk, mode: "skip" });
    imported += res.imported ?? 0;
    skipped += res.skipped ?? 0;
    for (const r of res.results ?? []) {
      if (r.status === "failed") {
        failed.push({ externalId: r.externalId, error: r.errorMessage ?? r.errorCode ?? "failed" });
      }
    }
  }
  return { ok: failed.length === 0, imported, skipped, failed, unreadable };
}

module.exports = {
  onLoad,
  onUnload,
  onPanelInvoke,
};
