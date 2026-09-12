"use strict";

const {
  ACTIVE_STATUSES,
  POLL_INTERVAL_MS,
  TERMINAL_STATUSES,
  WAIT_TIMEOUT_MS,
  assertOrchestratorSession,
  desktop,
  desktopOperations,
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
  sendToWorker,
  sessionFromResponse,
  shorten,
  sleepWithSignal,
  taskError,
  text,
  optionalText,
  withWorkerLock,
  workerId,
} = require("./runtime.js");

const MAX_TASK_CHARS = 65_536;
const MAX_TITLE_CHARS = 80;
const MAX_MESSAGE_CHARS = 65_536;

function errorMessage(error) {
  return shorten(error?.message ?? String(error), 2_000);
}

function workerPrompt(task) {
  return [
    "You are a PI-Desktop worker session managed by a parent Agent.",
    "Complete the task below using this session only.",
    "Do not create or control other sessions, and do not invoke SessionTask.",
    "Return a concise final report with findings, changed files, and verification when relevant.",
    "",
    "Task:",
    task,
  ].join("\n");
}

async function spawnWorker(args, ctx) {
  const parentSessionId = parentIdFromContext(ctx);
  assertOrchestratorSession(parentSessionId);
  const task = text(args.task, "task", MAX_TASK_CHARS);
  const title = optionalText(args.title, "title", MAX_TITLE_CHARS) || shorten(task, MAX_TITLE_CHARS);

  reserveSpawn(parentSessionId);
  let record = null;
  try {
    const parentSession = await getSession(parentSessionId, 1, 4_096);
    const model = await resolveModel(args.model, parentSession, ctx);
    const thinkingLevel = resolveThinkingLevel(parentSession, ctx);
    const input = {
      title,
      mode: "agent",
      inheritPermissionFromSessionId: parentSessionId,
      ...(typeof parentSession.projectPath === "string" && parentSession.projectPath.trim()
        ? { projectPath: parentSession.projectPath.trim() }
        : {}),
      ...(model.providerId ? { providerId: model.providerId } : {}),
      ...(model.modelId ? { modelId: model.modelId } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
    };

    const created = sessionFromResponse(
      await desktop("session/create", [input]),
      "session/create",
    );
    record = {
      parentSessionId,
      workerSessionId: created.id,
      task,
      title,
      status: "created",
      createdAt: now(),
      ...(model.modelKey ? { modelKey: model.modelKey } : {}),
    };
    await getWorkerStore().upsert(record);

    try {
      const result = await withWorkerLock(record.workerSessionId, async () => {
        const latest = getWorkerStore().get(record.workerSessionId) ?? record;
        if (TERMINAL_STATUSES.has(latest.status)) {
          throw taskError("ABORTED", "worker was stopped before its first prompt");
        }
        const inheritanceError = permissionInheritanceError(parentSession, created);
        if (inheritanceError) {
          await getWorkerStore().update(record.workerSessionId, {
            status: "failed",
            error: errorMessage(inheritanceError),
          });
          throw inheritanceError;
        }
        return sendToWorker(
          latest,
          workerPrompt(task),
          parentSessionId,
        );
      });
      return {
        action: "spawn",
        workerId: created.id,
        workerSessionId: created.id,
        title,
        status: "running",
        ...result,
      };
    } catch (error) {
      await getWorkerStore().update(record.workerSessionId, {
        status: "failed",
        error: errorMessage(error),
      });
      throw error;
    }
  } finally {
    releaseSpawn(parentSessionId);
  }
}

async function sendWorker(args, ctx) {
  const parentSessionId = parentIdFromContext(ctx);
  assertOrchestratorSession(parentSessionId);
  const id = workerId(args.workerId);
  const message = text(args.message, "message", MAX_MESSAGE_CHARS);

  return withWorkerLock(id, async () => {
    const record = recordForParent(parentSessionId, id);
    const current = await refreshRecord(record, true);
    if (ACTIVE_STATUSES.has(current.status)) {
      throw taskError("AGENT_BUSY", "worker is still active");
    }

    reserveSpawn(parentSessionId);
    try {
      return {
        action: "send",
        ...(await sendToWorker(current, message, parentSessionId)),
      };
    } finally {
      releaseSpawn(parentSessionId);
    }
  });
}

async function statusWorkers(args, ctx) {
  const parentSessionId = parentIdFromContext(ctx);
  assertOrchestratorSession(parentSessionId);
  const ids = normalizeWorkerIds(args.workerIds);
  const records = recordsForParent(parentSessionId, ids);
  const refreshed = await refreshRecords(records, true);
  return {
    action: "status",
    workers: refreshed.map((record) => publicWorker(record, false)),
  };
}

async function waitWorkers(args, ctx) {
  const parentSessionId = parentIdFromContext(ctx);
  assertOrchestratorSession(parentSessionId);
  const ids = normalizeWorkerIds(args.workerIds, true);
  const deadline = Date.now() + WAIT_TIMEOUT_MS;

  while (true) {
    if (ctx?.signal?.aborted) {
      throw taskError("ABORTED", "wait was cancelled");
    }

    const records = recordsForParent(parentSessionId, ids);
    const refreshed = await refreshRecords(records, true);
    if (refreshed.every((record) => TERMINAL_STATUSES.has(record.status))) {
      return {
        action: "wait",
        timedOut: false,
        workers: refreshed.map((record) => publicWorker(record, true)),
      };
    }

    if (Date.now() >= deadline) {
      return {
        action: "wait",
        timedOut: true,
        workers: refreshed.map((record) => publicWorker(record, true)),
      };
    }

    await sleepWithSignal(
      Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())),
      ctx?.signal,
    );
  }
}

async function resultWorker(args, ctx) {
  const parentSessionId = parentIdFromContext(ctx);
  assertOrchestratorSession(parentSessionId);
  const id = workerId(args.workerId);

  return withWorkerLock(id, async () => {
    const record = recordForParent(parentSessionId, id);
    const refreshed = await refreshRecord(record, true);
    return {
      action: "result",
      ready: refreshed.status === "completed",
      worker: publicWorker(refreshed, true),
    };
  });
}

async function cancelWorker(args, ctx) {
  const parentSessionId = parentIdFromContext(ctx);
  assertOrchestratorSession(parentSessionId);
  const id = workerId(args.workerId);

  return withWorkerLock(id, async () => {
    const record = recordForParent(parentSessionId, id);
    const current = await refreshRecord(record, true);
    if (TERMINAL_STATUSES.has(current.status)) {
      return {
        action: "cancel",
        worker: publicWorker(current, false),
        sessionRetained: true,
      };
    }

    if (ACTIVE_STATUSES.has(current.status)) {
      await desktop("agent/abort", [{ sessionId: current.workerSessionId }]);
    }

    const cancelled = {
      ...current,
      status: "cancelled",
      error: undefined,
    };
    await getWorkerStore().upsert(cancelled);
    return {
      action: "cancel",
      worker: publicWorker(cancelled, false),
      sessionRetained: true,
    };
  });
}

async function listWorkers(args, ctx) {
  const parentSessionId = parentIdFromContext(ctx);
  assertOrchestratorSession(parentSessionId);
  const records = recordsForParent(parentSessionId);
  const refreshed = await refreshRecords(records, true);
  return {
    action: "list",
    workers: refreshed.map((record) => publicWorker(record, false)),
  };
}

async function executeSessionTask(args, ctx) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw taskError("INVALID_ARGUMENT", "SessionTask arguments must be an object");
  }
  const action = text(args.action, "action", 32);
  switch (action) {
    case "spawn":
      return spawnWorker(args, ctx);
    case "send":
      return sendWorker(args, ctx);
    case "status":
      return statusWorkers(args, ctx);
    case "wait":
      return waitWorkers(args, ctx);
    case "result":
      return resultWorker(args, ctx);
    case "cancel":
      return cancelWorker(args, ctx);
    case "list":
      return listWorkers(args, ctx);
    default:
      throw taskError("INVALID_ARGUMENT", `unsupported SessionTask action: ${action}`);
  }
}

function panelRecord(id) {
  const record = getWorkerStore().get(workerId(id));
  if (!record) throw taskError("NOT_FOUND", "worker not found");
  return record;
}

async function panelList() {
  const records = await refreshRecords(getWorkerStore().all(), true);
  return {
    workers: records
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
      .map((record) => publicWorker(record, false)),
  };
}

async function panelCancel(payload) {
  const id = workerId(payload?.workerId);
  return withWorkerLock(id, async () => {
    const record = panelRecord(id);
    const current = await refreshRecord(record, true);
    if (TERMINAL_STATUSES.has(current.status)) {
      return {
        ok: true,
        worker: publicWorker(current, false),
        sessionRetained: true,
      };
    }
    if (ACTIVE_STATUSES.has(current.status)) {
      await desktop("agent/abort", [{ sessionId: current.workerSessionId }]);
    }
    const cancelled = {
      ...current,
      status: "cancelled",
      error: undefined,
    };
    await getWorkerStore().upsert(cancelled);
    return {
      ok: true,
      worker: publicWorker(cancelled, false),
      sessionRetained: true,
    };
  });
}

async function panelOpen(payload) {
  const record = panelRecord(payload?.workerId);
  const operations = await desktopOperations();
  if (!operations.some((operation) => operation.id === "session/open")) {
    throw taskError(
      "UNSUPPORTED",
      "this PI-Desktop host cannot open a session from a plugin panel; update the host or use the session list",
    );
  }
  await desktop("session/open", [record.workerSessionId]);
  return { ok: true, workerId: record.workerSessionId };
}

module.exports = {
  executeSessionTask,
  panelCancel,
  panelList,
  panelOpen,
  __test: {
    executeSessionTask,
    permissionInheritanceError,
    workerPrompt,
  },
};
