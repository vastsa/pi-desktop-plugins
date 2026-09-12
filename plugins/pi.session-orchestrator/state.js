"use strict";

const MAX_PERSISTED_WORKERS = 256;
const MAX_TEXT_CHARS = 65_536;
const MAX_TITLE_CHARS = 160;
const VALID_STATUSES = new Set([
  "created",
  "running",
  "waiting_permission",
  "completed",
  "failed",
  "cancelled",
]);
const ACTIVE_STATUSES = new Set(["created", "running", "waiting_permission"]);

function boundedText(value, limit = MAX_TEXT_CHARS) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, limit);
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function normalizeRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const parentSessionId = boundedText(value.parentSessionId, 256);
  const workerSessionId = boundedText(value.workerSessionId, 256);
  const task = boundedText(value.task);
  const title = boundedText(value.title, MAX_TITLE_CHARS);
  const createdAt = validTimestamp(value.createdAt) ? value.createdAt : "";
  const status = VALID_STATUSES.has(value.status) ? value.status : "created";

  if (!parentSessionId || !workerSessionId || !task || !title || !createdAt) return null;

  const normalized = {
    parentSessionId,
    workerSessionId,
    task,
    title,
    status,
    createdAt,
  };

  if (validTimestamp(value.updatedAt)) normalized.updatedAt = value.updatedAt;
  if (typeof value.modelKey === "string" && value.modelKey.trim()) {
    normalized.modelKey = boundedText(value.modelKey, 512);
  }
  if (validTimestamp(value.promptedAt)) normalized.promptedAt = value.promptedAt;
  if (typeof value.turnId === "string" && value.turnId.trim()) {
    normalized.turnId = boundedText(value.turnId, 256);
  }
  if (typeof value.report === "string" && value.report.trim()) {
    normalized.report = boundedText(value.report, 12_000);
  }
  if (typeof value.error === "string" && value.error.trim()) {
    normalized.error = boundedText(value.error, 2_000);
  }

  return normalized;
}

function cloneRecord(record) {
  return { ...record };
}

function retainRecords(values) {
  if (values.length <= MAX_PERSISTED_WORKERS) return values;

  const active = values.filter((record) => ACTIVE_STATUSES.has(record.status));
  const terminal = values.filter((record) => !ACTIVE_STATUSES.has(record.status));
  const terminalLimit = Math.max(0, MAX_PERSISTED_WORKERS - active.length);
  return [...terminal.slice(-terminalLimit), ...active];
}

/**
 * Relationship metadata is plugin-owned settings. Worker transcripts are not
 * mirrored here; they stay in the host's durable session store.
 */
async function createWorkerStore() {
  const settings = (await pi.plugin.getSettings()) || {};

  const records = new Map();
  const loaded = Array.isArray(settings.workers) ? settings.workers : [];
  for (const record of retainRecords(loaded.map(normalizeRecord).filter(Boolean))) {
    records.set(record.workerSessionId, record);
  }

  let writeQueue = Promise.resolve();

  function snapshot() {
    return retainRecords([...records.values()]).map(cloneRecord);
  }

  function persist() {
    const payload = {
      version: 1,
      workers: snapshot(),
      workersUpdatedAt: Date.now(),
    };
    writeQueue = writeQueue
      .catch(() => undefined)
      .then(() => pi.plugin.setSettings(payload));
    return writeQueue;
  }

  function prune() {
    while (records.size > MAX_PERSISTED_WORKERS) {
      const removable = [...records.values()].find(
        (record) => !ACTIVE_STATUSES.has(record.status),
      );
      const fallback = records.keys().next().value;
      const workerSessionId = removable?.workerSessionId ?? fallback;
      if (workerSessionId === undefined) break;
      records.delete(workerSessionId);
    }
  }

  function get(workerSessionId) {
    const record = records.get(String(workerSessionId || ""));
    return record ? cloneRecord(record) : null;
  }

  function all() {
    return snapshot();
  }

  function upsert(next) {
    const record = normalizeRecord(next);
    if (!record) throw new Error("invalid worker relationship");
    records.set(record.workerSessionId, record);
    prune();
    return persist();
  }

  function update(workerSessionId, patch) {
    const current = records.get(String(workerSessionId || ""));
    if (!current) return Promise.resolve();
    return upsert({
      ...current,
      ...patch,
      parentSessionId: current.parentSessionId,
      workerSessionId: current.workerSessionId,
      updatedAt: new Date().toISOString(),
    });
  }

  return {
    get,
    all,
    update,
    upsert,
    flush: () => writeQueue,
  };
}

module.exports = {
  ACTIVE_STATUSES,
  MAX_PERSISTED_WORKERS,
  MAX_TEXT_CHARS,
  VALID_STATUSES,
  createWorkerStore,
  normalizeRecord,
};
