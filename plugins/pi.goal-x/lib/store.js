"use strict";

const { createHash } = require("node:crypto");
const { GoalError, normalizeRoot, ensureWorkspace, workspaceView } = require("./goal-engine");

const STATE_SETTING_KEY = "goalXState";
const MAX_STATE_BYTES = 8 * 1024 * 1024;
let mutationQueue = Promise.resolve();

function normalizedWorkspacePath(value) {
  const path = String(value ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[A-Za-z]:\//.test(path) ? path.toLowerCase() : path;
}

function workspaceDescriptor(workspace) {
  const path = normalizedWorkspacePath(workspace?.path);
  const key = path
    ? `workspace-${createHash("sha256").update(path).digest("hex").slice(0, 20)}`
    : "global";
  return {
    key,
    path,
    name: String(workspace?.name ?? "").trim() || (path ? path.split("/").pop() : "No workspace"),
  };
}

async function currentDescriptor() {
  const workspace = await pi.workspace.get();
  return workspaceDescriptor(workspace);
}

async function readSettings() {
  const settings = await pi.plugin.getSettings();
  if (settings == null) return {};
  if (typeof settings !== "object" || Array.isArray(settings)) {
    throw new GoalError("STORAGE_INVALID", "Goal X settings are not a valid object; no data was changed.");
  }
  return settings;
}

async function readCurrentWorkspace() {
  const [settings, descriptor] = await Promise.all([readSettings(), currentDescriptor()]);
  const root = normalizeRoot(settings[STATE_SETTING_KEY]);
  const workspace = ensureWorkspace(root, descriptor);
  return { settings, root, workspace, descriptor };
}

function stateSizeBytes(root) {
  try {
    return Buffer.byteLength(JSON.stringify(root), "utf8");
  } catch {
    throw new GoalError("STORAGE_INVALID", "Goal X state could not be serialized; no data was changed.");
  }
}

function assertStateCapacity(root) {
  const bytes = stateSizeBytes(root);
  if (bytes > MAX_STATE_BYTES) {
    throw new GoalError(
      "STATE_LIMIT_EXCEEDED",
      `Goal X state would use ${bytes} bytes, above the ${MAX_STATE_BYTES}-byte safety limit; no data was changed.`,
    );
  }
  return bytes;
}

async function saveRoot(root) {
  assertStateCapacity(root);
  const current = await readSettings();
  await pi.plugin.setSettings({ ...current, [STATE_SETTING_KEY]: root });
}

function serializeMutation(operation) {
  const run = mutationQueue.then(operation, operation);
  mutationQueue = run.catch(() => undefined);
  return run;
}

async function mutateCurrentWorkspace(mutator) {
  return serializeMutation(async () => {
    const { settings, root, workspace, descriptor } = await readCurrentWorkspace();
    const result = await mutator(workspace, { settings, root, descriptor });
    workspace.updatedAt = new Date().toISOString();
    await saveRoot(root);
    return { result, settings, root, workspace, descriptor };
  });
}

async function updatePluginSettings(updater) {
  return serializeMutation(async () => {
    const current = await readSettings();
    const patch = await updater({ ...current });
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw new GoalError("INVALID_ARGUMENT", "The settings update must return an object.");
    }
    const next = { ...current, ...patch };
    if (!Object.prototype.hasOwnProperty.call(patch, STATE_SETTING_KEY) && Object.prototype.hasOwnProperty.call(current, STATE_SETTING_KEY)) {
      next[STATE_SETTING_KEY] = current[STATE_SETTING_KEY];
    }
    if (Object.prototype.hasOwnProperty.call(next, STATE_SETTING_KEY)) {
      assertStateCapacity(next[STATE_SETTING_KEY]);
    }
    await pi.plugin.setSettings(next);
    return next;
  });
}

async function currentWorkspaceView() {
  const { workspace, descriptor } = await readCurrentWorkspace();
  return {
    workspace: workspaceView(workspace),
    descriptor: {
      key: descriptor.key,
      name: descriptor.name,
      hasWorkspace: Boolean(descriptor.path),
    },
  };
}

module.exports = {
  STATE_SETTING_KEY,
  normalizedWorkspacePath,
  workspaceDescriptor,
  readSettings,
  readCurrentWorkspace,
  mutateCurrentWorkspace,
  updatePluginSettings,
  currentWorkspaceView,
  __test: {
    MAX_STATE_BYTES,
    stateSizeBytes,
    assertStateCapacity,
    resetQueue() {
      mutationQueue = Promise.resolve();
    },
  },
};
