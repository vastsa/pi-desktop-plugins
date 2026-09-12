"use strict";

const { ACTIVE_STATUSES, createWorkerStore } = require("./state.js");

const MAX_WORKERS_PER_PARENT = 4;
const MAX_ACTIVE_WORKERS = 16;
const MAX_WAIT_WORKERS = 16;
const MAX_REPORT_CHARS = 12_000;
const POLL_INTERVAL_MS = 750;
const WAIT_TIMEOUT_MS = 100_000;
const VALID_THINKING_LEVELS = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const VALID_PERMISSION_MODES = new Set(["inherit", "ask", "accept-edits", "auto"]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

let workerStore;
let spawnReservations = new Map();
let workerLocks = new Map();

function configureWorkerRuntime(store) {
  workerStore = store;
  spawnReservations = new Map();
  workerLocks = new Map();
}

function resetWorkerRuntime() {
  workerStore = undefined;
  spawnReservations = new Map();
  workerLocks = new Map();
}

function getWorkerStore() {
  if (!workerStore) throw taskError("NOT_FOUND", "Session Orchestrator is not loaded");
  return workerStore;
}

function taskError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function errorCode(error) {
  return error?.code || error?.errorCode || error?.data?.errorCode || "";
}

function isNotFound(error) {
  return ["NOT_FOUND", "SESSION_NOT_FOUND", "RUNTIME_NOT_FOUND"].includes(errorCode(error));
}

function text(value, field, limit) {
  if (typeof value !== "string") {
    throw taskError("INVALID_ARGUMENT", `${field} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized) throw taskError("INVALID_ARGUMENT", `${field} must not be empty`);
  if (normalized.length > limit) {
    throw taskError("LIMIT_EXCEEDED", `${field} exceeds ${limit} characters`);
  }
  return normalized;
}

function optionalText(value, field, limit) {
  if (value === undefined || value === null || value === "") return undefined;
  return text(value, field, limit);
}

function parentIdFromContext(ctx) {
  const parentSessionId = typeof ctx?.sessionId === "string" ? ctx.sessionId.trim() : "";
  if (!parentSessionId) {
    throw taskError("INVALID_ARGUMENT", "SessionTask requires an active parent session");
  }
  return parentSessionId;
}

function assertOrchestratorSession(parentSessionId) {
  const worker = getWorkerStore()
    .all()
    .find((record) => record.workerSessionId === parentSessionId);
  if (worker) {
    throw taskError("PERMISSION_DENIED", "Worker sessions cannot create or control other workers");
  }
}

function desktop(operation, args = [], confirm = false) {
  if (!globalThis.pi?.desktop?.invoke) {
    throw taskError("UNSUPPORTED", "PI-Desktop desktop.control API is unavailable");
  }
  return globalThis.pi.desktop.invoke({
    operation,
    args,
    ...(confirm ? { confirm: true } : {}),
  });
}

async function desktopOperations() {
  if (!globalThis.pi?.desktop?.listOperations) {
    return [];
  }
  try {
    const operations = await globalThis.pi.desktop.listOperations();
    return Array.isArray(operations) ? operations : [];
  } catch (error) {
    if (errorCode(error) === "UNSUPPORTED") return [];
    throw error;
  }
}

function sessionFromResponse(response, operation) {
  const session = response?.session;
  if (!session || typeof session.id !== "string" || !session.id.trim()) {
    throw taskError("INTERNAL", `${operation} did not return a session`);
  }
  return session;
}

async function getSession(sessionId, messageLimit = 1, contentLimit = 4096) {
  const response = await desktop("session/get", [
    {
      id: sessionId,
      messageLimit,
      contentLimit,
    },
  ]);
  const session = response?.session;
  if (!session) throw taskError("NOT_FOUND", `session not found: ${sessionId}`);
  return session;
}

async function getAgentStatus(sessionId) {
  const response = await desktop("agent/getStatus", [sessionId]);
  if (response?.status && typeof response.status === "object") return response.status;
  return response && typeof response === "object" ? response : {};
}

function splitModelKey(modelKey) {
  const slash = modelKey.indexOf("/");
  if (slash <= 0 || slash === modelKey.length - 1) {
    throw taskError("INVALID_ARGUMENT", "model must use provider/model format");
  }
  return {
    providerId: modelKey.slice(0, slash),
    modelId: modelKey.slice(slash + 1),
  };
}

async function resolveModel(modelInput, parentSession, ctx) {
  const explicit = optionalText(modelInput, "model", 512);
  if (explicit) {
    const models = await globalThis.pi.models.list();
    const match = models.find((candidate) => candidate?.key === explicit);
    if (!match) throw taskError("NOT_FOUND", `configured model not found: ${explicit}`);
    if (!match.providerId || !match.modelId) {
      throw taskError("INVALID_ARGUMENT", `configured model is incomplete: ${explicit}`);
    }
    return {
      providerId: match.providerId,
      modelId: match.modelId,
      modelKey: match.key,
    };
  }

  const providerId =
    typeof parentSession.providerId === "string" ? parentSession.providerId.trim() : "";
  const modelId = typeof parentSession.modelId === "string" ? parentSession.modelId.trim() : "";
  if (providerId && modelId) {
    return { providerId, modelId, modelKey: `${providerId}/${modelId}` };
  }

  const contextModel = typeof ctx?.modelKey === "string" ? ctx.modelKey.trim() : "";
  if (contextModel) {
    const parsed = splitModelKey(contextModel);
    return { ...parsed, modelKey: contextModel };
  }

  return { providerId: undefined, modelId: undefined, modelKey: undefined };
}

function resolveThinkingLevel(parentSession, ctx) {
  const candidate =
    typeof parentSession.thinkingLevel === "string" && parentSession.thinkingLevel.trim()
      ? parentSession.thinkingLevel.trim()
      : typeof ctx?.thinkingLevel === "string"
        ? ctx.thinkingLevel.trim()
        : "";
  if (!candidate) return undefined;
  if (!VALID_THINKING_LEVELS.has(candidate)) {
    throw taskError("INVALID_ARGUMENT", `unsupported thinking level: ${candidate}`);
  }
  return candidate;
}

function permissionMode(session) {
  const value = typeof session?.permissionMode === "string"
    ? session.permissionMode.trim()
    : "";
  return VALID_PERMISSION_MODES.has(value) ? value : "inherit";
}

/**
 * The host extension copies the persisted permission mode atomically while
 * creating the child. A mismatch means the extension is not available (or a
 * host returned an incomplete projection), so prompting the child would be
 * unsafe and is refused.
 */
function permissionInheritanceError(parentSession, workerSession) {
  const parentMode = permissionMode(parentSession);
  const workerMode = permissionMode(workerSession);
  if (parentMode === workerMode) return null;
  return taskError(
    "PERMISSION_DENIED",
    `host did not preserve parent permission mode (${parentMode} -> ${workerMode}); worker was not prompted`,
  );
}

function activeCount(records) {
  return records.filter((record) => ACTIVE_STATUSES.has(record.status)).length;
}

function reservationCount(parentSessionId) {
  return spawnReservations.get(parentSessionId) ?? 0;
}

function totalReservations() {
  return [...spawnReservations.values()].reduce((sum, count) => sum + count, 0);
}

function reserveSpawn(parentSessionId) {
  const records = getWorkerStore().all();
  const parentActive = records.filter(
    (record) =>
      record.parentSessionId === parentSessionId && ACTIVE_STATUSES.has(record.status),
  ).length;
  if (parentActive + reservationCount(parentSessionId) >= MAX_WORKERS_PER_PARENT) {
    throw taskError(
      "LIMIT_EXCEEDED",
      `parent session already has ${MAX_WORKERS_PER_PARENT} active workers`,
    );
  }
  if (activeCount(records) + totalReservations() >= MAX_ACTIVE_WORKERS) {
    throw taskError("LIMIT_EXCEEDED", `plugin active worker limit is ${MAX_ACTIVE_WORKERS}`);
  }
  spawnReservations.set(parentSessionId, reservationCount(parentSessionId) + 1);
}

function releaseSpawn(parentSessionId) {
  const count = reservationCount(parentSessionId);
  if (count <= 1) spawnReservations.delete(parentSessionId);
  else spawnReservations.set(parentSessionId, count - 1);
}

function now() {
  return new Date().toISOString();
}

function workerId(value) {
  return text(value, "workerId", 256);
}

function normalizeWorkerIds(value, required = false) {
  if (value === undefined || value === null) {
    if (required) throw taskError("INVALID_ARGUMENT", "workerIds is required");
    return undefined;
  }
  if (!Array.isArray(value)) throw taskError("INVALID_ARGUMENT", "workerIds must be an array");
  const ids = [...new Set(value.map((item) => workerId(item)))];
  if (required && ids.length === 0) {
    throw taskError("INVALID_ARGUMENT", "workerIds must not be empty");
  }
  if (ids.length > MAX_WAIT_WORKERS) {
    throw taskError("LIMIT_EXCEEDED", `at most ${MAX_WAIT_WORKERS} workers may be selected`);
  }
  return ids;
}

function recordForParent(parentSessionId, id) {
  const record = getWorkerStore().get(id);
  if (!record || record.parentSessionId !== parentSessionId) {
    throw taskError("NOT_FOUND", `worker not found: ${id}`);
  }
  return record;
}

function recordsForParent(parentSessionId, ids) {
  const records = getWorkerStore()
    .all()
    .filter((record) => record.parentSessionId === parentSessionId);
  if (!ids || ids.length === 0) return records;
  return ids.map((id) => recordForParent(parentSessionId, id));
}

function shorten(value, limit) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 1))}…`;
}

function publicWorker(record, includeReport = false) {
  return {
    workerId: record.workerSessionId,
    workerSessionId: record.workerSessionId,
    parentSessionId: record.parentSessionId,
    title: record.title,
    task: shorten(record.task, 240),
    status: record.status,
    createdAt: record.createdAt,
    ...(record.updatedAt ? { updatedAt: record.updatedAt } : {}),
    ...(record.modelKey ? { model: record.modelKey } : {}),
    ...(record.turnId ? { turnId: record.turnId } : {}),
    ...(includeReport && record.report ? { report: record.report } : {}),
    ...(record.error ? { error: record.error } : {}),
  };
}

function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      if (typeof part.text === "string") return part.text;
      return typeof part.content === "string" ? part.content : "";
    })
    .join("");
}

function assistantReport(session, after) {
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  const threshold = after ? Date.parse(after) : Number.NEGATIVE_INFINITY;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    if (message.status === "error" || message.status === "aborted") continue;
    if (Number.isFinite(threshold) && Number.isFinite(Date.parse(message.createdAt))) {
      if (Date.parse(message.createdAt) < threshold) continue;
    }
    const report = shorten(messageText(message.content), MAX_REPORT_CHARS);
    if (report) return report;
  }
  return "";
}

async function refreshRecord(record, includeReport = true) {
  const currentRecord = getWorkerStore().get(record.workerSessionId) ?? record;
  if (TERMINAL_STATUSES.has(currentRecord.status)) return currentRecord;

  let status;
  try {
    status = await getAgentStatus(currentRecord.workerSessionId);
  } catch (error) {
    if (isNotFound(error)) {
      const failed = {
        ...currentRecord,
        status: "failed",
        error: "Worker session no longer exists",
      };
      const latest = getWorkerStore().get(currentRecord.workerSessionId);
      if (latest && TERMINAL_STATUSES.has(latest.status)) return latest;
      await getWorkerStore().upsert(failed);
      return getWorkerStore().get(currentRecord.workerSessionId) ?? failed;
    }
    throw error;
  }

  const running = status.isRunning === true;
  const pendingToolConfirmations = Array.isArray(status.pendingToolConfirmations)
    ? status.pendingToolConfirmations.length
    : typeof status.pendingToolConfirmations === "number"
      ? status.pendingToolConfirmations
      : 0;

  if (running) {
    const nextStatus = pendingToolConfirmations > 0 ? "waiting_permission" : "running";
    const latest = getWorkerStore().get(currentRecord.workerSessionId);
    if (latest && TERMINAL_STATUSES.has(latest.status)) return latest;
    if (nextStatus !== currentRecord.status) {
      await getWorkerStore().update(currentRecord.workerSessionId, { status: nextStatus });
    }
    return getWorkerStore().get(currentRecord.workerSessionId) ?? {
      ...currentRecord,
      status: nextStatus,
    };
  }

  if (!includeReport) return currentRecord;

  let session;
  try {
    session = await getSession(currentRecord.workerSessionId, 32, 64_000);
  } catch (error) {
    if (isNotFound(error)) {
      const failed = {
        ...currentRecord,
        status: "failed",
        error: "Worker session no longer exists",
      };
      const latest = getWorkerStore().get(currentRecord.workerSessionId);
      if (latest && TERMINAL_STATUSES.has(latest.status)) return latest;
      await getWorkerStore().upsert(failed);
      return getWorkerStore().get(currentRecord.workerSessionId) ?? failed;
    }
    throw error;
  }

  const latest = getWorkerStore().get(currentRecord.workerSessionId);
  if (latest && TERMINAL_STATUSES.has(latest.status)) return latest;
  const report = assistantReport(session, currentRecord.promptedAt);
  if (report) {
    await getWorkerStore().update(currentRecord.workerSessionId, {
      status: "completed",
      report,
      error: undefined,
    });
    return getWorkerStore().get(currentRecord.workerSessionId) ?? {
      ...currentRecord,
      status: "completed",
      report,
    };
  }

  const failed = {
    ...currentRecord,
    status: "failed",
    error: "Worker ended without a final report",
  };
  await getWorkerStore().upsert(failed);
  return getWorkerStore().get(currentRecord.workerSessionId) ?? failed;
}

async function refreshRecords(records, includeReport = true) {
  return Promise.all(
    records.map((record) =>
      withWorkerLock(record.workerSessionId, () => refreshRecord(record, includeReport)),
    ),
  );
}

async function sendToWorker(record, message, parentSessionId) {
  const promptedAt = now();
  const response = await desktop("agent/prompt", [
    {
      sessionId: record.workerSessionId,
      content: message,
      viewingSessionId: parentSessionId,
    },
  ]);
  if (response?.accepted === false) {
    throw taskError("AGENT_BUSY", "worker Agent did not accept the prompt");
  }
  const turnId = typeof response?.turnId === "string" ? response.turnId : undefined;
  await getWorkerStore().update(record.workerSessionId, {
    status: "running",
    promptedAt,
    ...(turnId ? { turnId } : {}),
    report: undefined,
    error: undefined,
  });
  return {
    workerId: record.workerSessionId,
    workerSessionId: record.workerSessionId,
    accepted: response?.accepted === true,
    ...(turnId ? { turnId } : {}),
  };
}

function withWorkerLock(workerSessionId, callback) {
  const id = String(workerSessionId);
  const previous = workerLocks.get(id) || Promise.resolve();
  const run = previous.catch(() => undefined).then(callback);
  workerLocks.set(id, run);
  void run.then(
    () => {
      if (workerLocks.get(id) === run) workerLocks.delete(id);
    },
    () => {
      if (workerLocks.get(id) === run) workerLocks.delete(id);
    },
  );
  return run;
}

function sleepWithSignal(ms, signal) {
  return new Promise((resolve, reject) => {
    let timer;
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(taskError("ABORTED", "wait was cancelled")));
    timer = setTimeout(() => finish(resolve), ms);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

module.exports = {
  ACTIVE_STATUSES,
  MAX_ACTIVE_WORKERS,
  MAX_WAIT_WORKERS,
  MAX_WORKERS_PER_PARENT,
  POLL_INTERVAL_MS,
  TERMINAL_STATUSES,
  WAIT_TIMEOUT_MS,
  assertOrchestratorSession,
  configureWorkerRuntime,
  createWorkerStore,
  desktop,
  desktopOperations,
  getAgentStatus,
  getSession,
  getWorkerStore,
  normalizeWorkerIds,
  now,
  parentIdFromContext,
  permissionInheritanceError,
  publicWorker,
  recordForParent,
  recordsForParent,
  refreshRecord,
  refreshRecords,
  releaseSpawn,
  reserveSpawn,
  resolveModel,
  resolveThinkingLevel,
  resetWorkerRuntime,
  sendToWorker,
  sessionFromResponse,
  shorten,
  sleepWithSignal,
  taskError,
  text,
  optionalText,
  withWorkerLock,
  workerId,
};
