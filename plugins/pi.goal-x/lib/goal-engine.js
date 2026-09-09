"use strict";

const LIMITS = Object.freeze({
  objective: 4000,
  verificationContract: 2000,
  taskTitle: 240,
  taskEvidence: 600,
  taskReason: 600,
  tasks: 100,
  taskDepth: 4,
  openGoals: 32,
  archivedGoals: 100,
  activity: 120,
  audits: 12,
  workspaces: 32,
  activityDetails: 4000,
});

class GoalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "GoalError";
    this.code = code;
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function nowIso(now = Date.now()) {
  return new Date(now).toISOString();
}

function makeId(prefix = "gx") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}_${random}`;
}

function boundedText(value, field, max, options = {}) {
  const text = String(value ?? "").trim();
  if (!text && options.required) {
    throw new GoalError("INVALID_ARGUMENT", `${field} is required.`);
  }
  if (text.length > max) {
    throw new GoalError("LIMIT_EXCEEDED", `${field} must be ${max} characters or fewer.`);
  }
  return text;
}

function normalizeTokenBudget(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new GoalError("INVALID_ARGUMENT", "token_budget must be a positive whole safe integer.");
  }
  return number;
}

function normalizeId(value, field = "id") {
  const id = String(value ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(id)) {
    throw new GoalError(
      "INVALID_ARGUMENT",
      `${field} must start with a letter or number and contain only letters, numbers, dot, underscore, or dash.`,
    );
  }
  return id;
}

function pushActivity(goal, type, message, details, at = nowIso()) {
  goal.activity = Array.isArray(goal.activity) ? goal.activity : [];
  goal.activity.unshift({
    id: makeId("event"),
    type: clippedText(type, 80) || "activity",
    message: clippedText(message, LIMITS.taskReason),
    details: boundedActivityDetails(details),
    at,
  });
  goal.activity = goal.activity.slice(0, LIMITS.activity);
}

function clippedText(value, max) {
  const text = String(value ?? "");
  return (text.length > max ? text.slice(0, max) : text).trim();
}

function boundedActivityDetails(details) {
  if (!details || typeof details !== "object") return undefined;
  try {
    const encoded = JSON.stringify(details);
    return encoded.length <= LIMITS.activityDetails ? clone(details) : { truncated: true };
  } catch {
    return undefined;
  }
}

function normalizedUsage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const allowed = [
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "reasoningTokens",
    "totalTokens",
  ];
  const usage = {};
  for (const key of allowed) {
    const value = Number(raw[key]);
    if (Number.isFinite(value) && value >= 0) usage[key] = Math.floor(value);
  }
  return Object.keys(usage).length ? usage : null;
}

function normalizeTaskList(items, state, depth) {
  if (!Array.isArray(items) || depth > LIMITS.taskDepth) return [];
  const tasks = [];
  for (const item of items) {
    if (state.remaining <= 0) break;
    const task = normalizeTask(item, state, depth);
    if (task) tasks.push(task);
  }
  return tasks;
}

function normalizeTask(raw, state = { remaining: LIMITS.tasks }, depth = 1) {
  if (!raw || typeof raw !== "object" || depth > LIMITS.taskDepth || state.remaining <= 0) return null;
  const id = clippedText(raw.id, 80);
  const title = clippedText(raw.title, LIMITS.taskTitle);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(id) || !title) return null;
  state.remaining -= 1;
  const status = ["pending", "complete", "skipped"].includes(raw.status) ? raw.status : "pending";
  const subtasks = normalizeTaskList(raw.subtasks, state, depth + 1);
  return {
    id,
    title,
    status,
    verificationContract: clippedText(raw.verificationContract, LIMITS.verificationContract) || null,
    lightweightSubtasks: raw.lightweightSubtasks === true,
    evidence: clippedText(raw.evidence, LIMITS.taskEvidence) || null,
    skipReason: clippedText(raw.skipReason, LIMITS.taskReason) || null,
    completedAt: typeof raw.completedAt === "string" ? raw.completedAt : null,
    skippedAt: typeof raw.skippedAt === "string" ? raw.skippedAt : null,
    subtasks,
  };
}

function normalizeGoal(raw) {
  if (!raw || typeof raw !== "object") return null;
  const objective = clippedText(raw.objective, LIMITS.objective);
  const id = clippedText(raw.id, 80);
  if (!objective || !id) return null;
  const status = ["active", "paused", "blocked", "budget_limited", "complete", "archived"].includes(raw.status)
    ? raw.status
    : "paused";
  const taskState = { remaining: LIMITS.tasks };
  const tasks = normalizeTaskList(raw.tasks, taskState, 1);
  const activeSeconds = Number.isFinite(raw?.usage?.activeSeconds)
    ? Math.max(0, Math.floor(raw.usage.activeSeconds))
    : 0;
  return {
    id,
    objective,
    mode: raw.mode === "sisyphus" ? "sisyphus" : "regular",
    status,
    revision: Number.isSafeInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0,
    verificationContract: clippedText(raw.verificationContract, LIMITS.verificationContract) || null,
    tokenBudget: Number.isSafeInteger(raw.tokenBudget) && raw.tokenBudget > 0 ? raw.tokenBudget : null,
    blockCompletion: raw.blockCompletion === true,
    tasks,
    currentTaskId: clippedText(raw.currentTaskId, 80) || null,
    pauseReason: clippedText(raw.pauseReason, LIMITS.taskReason) || null,
    suggestedAction: clippedText(raw.suggestedAction, LIMITS.taskReason) || null,
    blocker: normalizeBlocker(raw.blocker),
    audits: Array.isArray(raw.audits)
      ? raw.audits.slice(0, LIMITS.audits).map(normalizeAudit).filter(Boolean)
      : [],
    activity: Array.isArray(raw.activity)
      ? raw.activity.slice(0, LIMITS.activity).map(normalizeActivity).filter(Boolean)
      : [],
    usage: { activeSeconds },
    activeSince: status === "active" && typeof raw.activeSince === "string" ? raw.activeSince : null,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : nowIso(),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : nowIso(),
    completedAt: typeof raw.completedAt === "string" ? raw.completedAt : null,
    archiveReason: clippedText(raw.archiveReason, LIMITS.taskReason) || null,
  };
}

function normalizeBlocker(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    fingerprint: clippedText(raw.fingerprint, 300),
    count: Math.min(3, Math.max(0, Math.floor(Number(raw.count) || 0))),
    turnIds: Array.isArray(raw.turnIds)
      ? raw.turnIds.slice(-3).map((item) => clippedText(item, 80)).filter(Boolean)
      : [],
    reason: clippedText(raw.reason, LIMITS.taskReason),
    attemptedActions: Array.isArray(raw.attemptedActions)
      ? raw.attemptedActions.slice(0, 8).map((item) => clippedText(item, 240)).filter(Boolean)
      : [],
    lastAt: typeof raw.lastAt === "string" ? raw.lastAt : null,
  };
}

function normalizeAudit(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    id: clippedText(raw.id, 80) || makeId("audit"),
    approved: raw.approved === true,
    skipped: raw.skipped === true,
    modelKey: clippedText(raw.modelKey, 240) || null,
    report: clippedText(raw.report, 8000) || null,
    usage: normalizedUsage(raw.usage),
    at: typeof raw.at === "string" ? raw.at : nowIso(),
  };
}

function normalizeActivity(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    id: clippedText(raw.id, 80) || makeId("event"),
    type: clippedText(raw.type, 80) || "activity",
    message: clippedText(raw.message, LIMITS.taskReason),
    details: boundedActivityDetails(raw.details),
    at: typeof raw.at === "string" ? raw.at : nowIso(),
  };
}

function normalizeWorkspace(raw, descriptor = {}) {
  const goals = Array.isArray(raw?.goals)
    ? raw.goals.slice(0, LIMITS.openGoals).map(normalizeGoal).filter(Boolean)
    : [];
  const archivedGoals = Array.isArray(raw?.archivedGoals)
    ? raw.archivedGoals.slice(0, LIMITS.archivedGoals).map(normalizeGoal).filter(Boolean)
    : [];
  const focused = clippedText(raw?.focusedGoalId, 80);
  const openGoalIds = new Set(goals.map((goal) => goal.id));
  const sessionFocus = Array.isArray(raw?.sessionFocus)
    ? raw.sessionFocus.slice(0, 64)
      .filter((entry) => entry && typeof entry === "object")
      .map((entry) => ({
        key: clippedText(entry.key, 80),
        goalId: clippedText(entry.goalId, 80),
        updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : nowIso(),
      }))
      .filter((entry) => entry.key && openGoalIds.has(entry.goalId))
    : [];
  return {
    key: clippedText(descriptor.key ?? raw?.key ?? "global", 128),
    path: clippedText(descriptor.path ?? raw?.path ?? "", 4096),
    name: clippedText(descriptor.name ?? raw?.name ?? "No workspace", 240),
    focusedGoalId: goals.some((goal) => goal.id === focused) ? focused : null,
    sessionFocus,
    goals,
    archivedGoals,
    updatedAt: typeof raw?.updatedAt === "string" ? raw.updatedAt : nowIso(),
  };
}

function normalizeRoot(raw) {
  const root = {
    version: 1,
    workspaces: Object.create(null),
  };
  if (!raw || typeof raw !== "object" || !raw.workspaces || typeof raw.workspaces !== "object") {
    return root;
  }
  for (const [key, workspace] of Object.entries(raw.workspaces).slice(0, LIMITS.workspaces)) {
    if (!key || key.length > 128 || ["__proto__", "prototype", "constructor"].includes(key)) continue;
    root.workspaces[key] = normalizeWorkspace(workspace, { key });
  }
  return root;
}

function ensureWorkspace(root, descriptor) {
  if (!descriptor?.key) throw new GoalError("INVALID_ARGUMENT", "workspace key is required.");
  const hasWorkspace = Object.prototype.hasOwnProperty.call(root.workspaces, descriptor.key);
  if (!hasWorkspace && Object.keys(root.workspaces).length >= LIMITS.workspaces) {
    const empty = Object.values(root.workspaces)
      .filter((workspace) => workspace.goals.length === 0 && workspace.archivedGoals.length === 0)
      .sort((left, right) => String(left.updatedAt).localeCompare(String(right.updatedAt)))[0];
    if (!empty) {
      throw new GoalError(
        "WORKSPACE_LIMIT_EXCEEDED",
        `Goal X can retain data for at most ${LIMITS.workspaces} workspaces. Archive cleanup is required before adding another.`,
      );
    }
    delete root.workspaces[empty.key];
  }
  const current = root.workspaces[descriptor.key];
  const workspace = normalizeWorkspace(current, descriptor);
  root.workspaces[descriptor.key] = workspace;
  return workspace;
}

function checkRevision(goal, expectedRevision) {
  if (expectedRevision == null) return;
  if (!Number.isSafeInteger(Number(expectedRevision)) || Number(expectedRevision) !== goal.revision) {
    throw new GoalError("STALE_STATE", `Goal changed since revision ${expectedRevision}; refresh and retry.`);
  }
}

function findGoal(workspace, goalId, options = {}) {
  const id = String(goalId ?? workspace.focusedGoalId ?? "").trim();
  if (!id) throw new GoalError("NO_FOCUSED_GOAL", "No goal is focused.");
  const list = options.archived ? workspace.archivedGoals : workspace.goals;
  const goal = list.find((item) => item.id === id);
  if (!goal) throw new GoalError("NOT_FOUND", `Goal ${id} was not found.`);
  return goal;
}

function sessionFocusedGoalId(workspace, sessionKey) {
  const key = String(sessionKey ?? "").trim();
  if (!key) return null;
  const entry = (workspace.sessionFocus || []).find((item) => item.key === key);
  return entry && workspace.goals.some((goal) => goal.id === entry.goalId) ? entry.goalId : null;
}

function setSessionFocus(workspace, sessionKey, goalId) {
  const key = String(sessionKey ?? "").trim();
  if (!key) return null;
  const id = goalId == null || goalId === "" ? null : findGoal(workspace, goalId).id;
  const entries = (workspace.sessionFocus || []).filter((item) => item.key !== key);
  if (id) entries.unshift({ key, goalId: id, updatedAt: nowIso() });
  workspace.sessionFocus = entries.slice(0, 64);
  workspace.updatedAt = nowIso();
  return id;
}

function settleActiveTime(goal, now = Date.now()) {
  if (goal.status !== "active" || !goal.activeSince) return;
  const started = new Date(goal.activeSince).getTime();
  if (Number.isFinite(started)) {
    goal.usage.activeSeconds += Math.max(0, Math.floor((now - started) / 1000));
  }
  goal.activeSince = null;
}

function touch(goal, now = Date.now()) {
  goal.revision += 1;
  goal.updatedAt = nowIso(now);
}

function resetBlocker(goal) {
  goal.blocker = null;
  if (goal.status === "blocked") {
    goal.status = "active";
    goal.activeSince = nowIso();
  }
}

function createGoal(workspace, input, options = {}) {
  if (workspace.goals.length >= LIMITS.openGoals) {
    throw new GoalError("LIMIT_EXCEEDED", `A workspace may keep at most ${LIMITS.openGoals} open goals.`);
  }
  const timestamp = nowIso(options.now);
  const objective = boundedText(input?.objective, "objective", LIMITS.objective, { required: true });
  const verificationContract = boundedText(
    input?.verification_contract ?? input?.verificationContract,
    "verification_contract",
    LIMITS.verificationContract,
  ) || null;
  const goal = {
    id: options.id ? normalizeId(options.id) : makeId("goal"),
    objective,
    mode: input?.mode === "sisyphus" ? "sisyphus" : "regular",
    status: "active",
    revision: 0,
    verificationContract,
    tokenBudget: normalizeTokenBudget(input?.token_budget ?? input?.tokenBudget),
    blockCompletion: input?.block_completion === true || input?.blockCompletion === true,
    tasks: [],
    currentTaskId: null,
    pauseReason: null,
    suggestedAction: null,
    blocker: null,
    audits: [],
    activity: [],
    usage: { activeSeconds: 0 },
    activeSince: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
    archiveReason: null,
  };
  pushActivity(goal, "created", "Goal created and focused.", { mode: goal.mode }, timestamp);
  workspace.goals.unshift(goal);
  workspace.focusedGoalId = goal.id;
  if (options.sessionKey) setSessionFocus(workspace, options.sessionKey, goal.id);
  else workspace.sessionFocus = [];
  workspace.updatedAt = timestamp;
  return goal;
}

function setFocus(workspace, goalId) {
  workspace.sessionFocus = [];
  if (goalId == null || goalId === "") {
    workspace.focusedGoalId = null;
    workspace.updatedAt = nowIso();
    return null;
  }
  const goal = findGoal(workspace, goalId);
  workspace.focusedGoalId = goal.id;
  workspace.updatedAt = nowIso();
  return goal;
}

function editGoal(workspace, goalId, input, options = {}) {
  const goal = findGoal(workspace, goalId);
  checkRevision(goal, options.expectedRevision);
  let changed = false;
  if (input.objective !== undefined) {
    const objective = boundedText(input.objective, "objective", LIMITS.objective, { required: true });
    if (objective !== goal.objective) {
      goal.objective = objective;
      changed = true;
    }
  }
  if (input.verification_contract !== undefined || input.verificationContract !== undefined) {
    const verification = boundedText(
      input.verification_contract ?? input.verificationContract,
      "verification_contract",
      LIMITS.verificationContract,
    ) || null;
    if (verification !== goal.verificationContract) {
      goal.verificationContract = verification;
      changed = true;
    }
  }
  if (input.token_budget !== undefined || input.tokenBudget !== undefined) {
    const tokenBudget = normalizeTokenBudget(input.token_budget ?? input.tokenBudget);
    if (tokenBudget !== goal.tokenBudget) {
      goal.tokenBudget = tokenBudget;
      changed = true;
    }
  }
  if (input.mode !== undefined) {
    const mode = input.mode === "sisyphus" ? "sisyphus" : "regular";
    if (mode !== goal.mode) {
      goal.mode = mode;
      changed = true;
    }
  }
  if (input.block_completion !== undefined || input.blockCompletion !== undefined) {
    const blockCompletion = input.block_completion === true || input.blockCompletion === true;
    if (blockCompletion !== goal.blockCompletion) {
      goal.blockCompletion = blockCompletion;
      changed = true;
    }
  }
  if (!changed) return goal;
  goal.blocker = null;
  touch(goal, options.now);
  pushActivity(goal, "edited", "Goal definition updated.", null, goal.updatedAt);
  workspace.updatedAt = goal.updatedAt;
  return goal;
}

function pauseGoal(workspace, goalId, reason, suggestedAction, options = {}) {
  const goal = findGoal(workspace, goalId);
  checkRevision(goal, options.expectedRevision);
  if (goal.status !== "active") {
    throw new GoalError("INVALID_STATE", `Only an active goal can be paused; current status is ${goal.status}.`);
  }
  const pauseReason = boundedText(reason, "reason", LIMITS.taskReason, { required: true });
  settleActiveTime(goal, options.now);
  goal.status = "paused";
  goal.pauseReason = pauseReason;
  goal.suggestedAction = boundedText(suggestedAction, "suggested_action", LIMITS.taskReason) || null;
  goal.blocker = null;
  touch(goal, options.now);
  pushActivity(goal, "paused", "Goal paused.", { reason: pauseReason }, goal.updatedAt);
  workspace.updatedAt = goal.updatedAt;
  return goal;
}

function resumeGoal(workspace, goalId, options = {}) {
  const goal = findGoal(workspace, goalId);
  checkRevision(goal, options.expectedRevision);
  if (!["paused", "blocked", "budget_limited"].includes(goal.status)) {
    throw new GoalError("INVALID_STATE", `Goal status ${goal.status} cannot be resumed.`);
  }
  goal.status = "active";
  goal.activeSince = nowIso(options.now);
  goal.pauseReason = null;
  goal.suggestedAction = null;
  goal.blocker = null;
  touch(goal, options.now);
  pushActivity(goal, "resumed", "Goal resumed.", null, goal.updatedAt);
  workspace.focusedGoalId = goal.id;
  workspace.sessionFocus = [];
  workspace.updatedAt = goal.updatedAt;
  return goal;
}

function blockerFingerprint(reason) {
  return String(reason ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .slice(0, 300);
}

function reportBlocked(workspace, goalId, input, options = {}) {
  const goal = findGoal(workspace, goalId);
  checkRevision(goal, options.expectedRevision);
  if (goal.status !== "active") {
    throw new GoalError("INVALID_STATE", `Only an active goal can report a blocker; current status is ${goal.status}.`);
  }
  const reason = boundedText(input?.reason, "reason", LIMITS.taskReason, { required: true });
  const fingerprint = blockerFingerprint(reason);
  const turnId = String(options.turnId ?? "").trim();
  if (!turnId) {
    throw new GoalError("TURN_ID_UNAVAILABLE", "Cannot verify a distinct Agent turn for this blocker report.");
  }
  const previous = goal.blocker;
  let count = previous?.fingerprint === fingerprint ? Number(previous.count) || 0 : 0;
  const turnIds = previous?.fingerprint === fingerprint && Array.isArray(previous.turnIds)
    ? previous.turnIds.slice(-2)
    : [];
  if (!turnIds.includes(turnId)) {
    count += 1;
    turnIds.push(turnId);
  }
  const attemptedActions = Array.isArray(input?.attempted_actions)
    ? input.attempted_actions.slice(0, 8).map((item) => boundedText(item, "attempted_action", 240)).filter(Boolean)
    : [];
  goal.blocker = {
    fingerprint,
    count,
    turnIds: turnIds.slice(-3),
    reason,
    attemptedActions,
    lastAt: nowIso(options.now),
  };
  if (count >= 3) {
    settleActiveTime(goal, options.now);
    goal.status = "blocked";
    goal.pauseReason = reason;
    goal.suggestedAction = boundedText(input?.suggested_action, "suggested_action", LIMITS.taskReason) || null;
  }
  touch(goal, options.now);
  pushActivity(
    goal,
    count >= 3 ? "blocked" : "blocker_reported",
    count >= 3 ? "Goal marked blocked after three matching reports." : `Blocker reported (${count}/3).`,
    { reason, count, attemptedActions },
    goal.updatedAt,
  );
  workspace.updatedAt = goal.updatedAt;
  return { goal, blocked: goal.status === "blocked", count, remaining: Math.max(0, 3 - count) };
}

function flattenTasks(tasks, output = [], parent = null, depth = 1) {
  for (const task of tasks || []) {
    output.push({ task, parent, depth });
    flattenTasks(task.subtasks, output, task, depth + 1);
  }
  return output;
}

function buildTaskTree(items, existingTasks = []) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new GoalError("INVALID_ARGUMENT", "tasks must contain at least one task.");
  }
  if (items.length > LIMITS.tasks) {
    throw new GoalError("LIMIT_EXCEEDED", `A goal may contain at most ${LIMITS.tasks} tasks.`);
  }
  const existing = new Map(flattenTasks(existingTasks).map(({ task }) => [task.id, task]));
  const nodes = new Map();
  const parents = new Map();
  for (const raw of items) {
    const id = normalizeId(raw?.id, "task id");
    if (nodes.has(id)) throw new GoalError("INVALID_ARGUMENT", `Duplicate task id: ${id}.`);
    const title = boundedText(raw?.title, `task ${id} title`, LIMITS.taskTitle, { required: true });
    const previous = existing.get(id);
    const node = {
      id,
      title,
      status: previous?.status || "pending",
      verificationContract: boundedText(
        raw?.verification_contract ?? raw?.verificationContract,
        `task ${id} verification_contract`,
        LIMITS.verificationContract,
      ) || null,
      lightweightSubtasks: raw?.lightweight_subtasks === true || raw?.lightweightSubtasks === true,
      evidence: previous?.evidence || null,
      skipReason: previous?.skipReason || null,
      completedAt: previous?.completedAt || null,
      skippedAt: previous?.skippedAt || null,
      subtasks: [],
    };
    nodes.set(id, node);
    const parentId = String(raw?.parent_id ?? raw?.parentId ?? "").trim() || null;
    if (parentId === id) throw new GoalError("INVALID_ARGUMENT", `Task ${id} cannot be its own parent.`);
    parents.set(id, parentId);
  }
  for (const [id, parentId] of parents) {
    if (parentId && !nodes.has(parentId)) {
      throw new GoalError("INVALID_ARGUMENT", `Task ${id} references missing parent ${parentId}.`);
    }
    const seen = new Set([id]);
    let cursor = parentId;
    let depth = 1;
    while (cursor) {
      if (seen.has(cursor)) throw new GoalError("INVALID_ARGUMENT", `Task cycle detected at ${cursor}.`);
      seen.add(cursor);
      cursor = parents.get(cursor) || null;
      depth += 1;
      if (depth > LIMITS.taskDepth) {
        throw new GoalError("LIMIT_EXCEEDED", `Task nesting may be at most ${LIMITS.taskDepth} levels.`);
      }
    }
  }
  const roots = [];
  for (const [id, node] of nodes) {
    const parentId = parents.get(id);
    if (parentId) nodes.get(parentId).subtasks.push(node);
    else roots.push(node);
  }
  return roots;
}

function setGoalTasks(workspace, goalId, input, options = {}) {
  const goal = findGoal(workspace, goalId);
  checkRevision(goal, options.expectedRevision);
  if (!["active", "paused"].includes(goal.status)) {
    throw new GoalError("INVALID_STATE", `Tasks cannot be changed while goal status is ${goal.status}.`);
  }
  goal.tasks = buildTaskTree(input?.tasks, goal.tasks);
  if (input?.block_completion !== undefined || input?.blockCompletion !== undefined) {
    goal.blockCompletion = input?.block_completion === true || input?.blockCompletion === true;
  }
  if (!flattenTasks(goal.tasks).some(({ task }) => task.id === goal.currentTaskId && task.status === "pending")) {
    goal.currentTaskId = null;
  }
  goal.blocker = null;
  touch(goal, options.now);
  pushActivity(
    goal,
    "tasks_set",
    `Task plan updated (${flattenTasks(goal.tasks).length} tasks).`,
    { changeSummary: boundedText(input?.change_summary, "change_summary", LIMITS.taskReason) || null },
    goal.updatedAt,
  );
  workspace.updatedAt = goal.updatedAt;
  return goal;
}

function descendants(task, output = []) {
  for (const child of task.subtasks || []) {
    output.push(child);
    descendants(child, output);
  }
  return output;
}

function updateGoalTasks(workspace, goalId, updates, options = {}) {
  const goal = findGoal(workspace, goalId);
  checkRevision(goal, options.expectedRevision);
  if (goal.status !== "active") {
    throw new GoalError("INVALID_STATE", `Task progress requires an active goal; current status is ${goal.status}.`);
  }
  if (!Array.isArray(updates) || updates.length === 0 || updates.length > LIMITS.tasks) {
    throw new GoalError("INVALID_ARGUMENT", `updates must contain 1-${LIMITS.tasks} operations.`);
  }
  const draft = clone(goal);
  const flat = flattenTasks(draft.tasks);
  const byId = new Map(flat.map((entry) => [entry.task.id, entry.task]));
  const parentById = new Map(flat.map((entry) => [entry.task.id, entry.parent]));
  for (const raw of updates) {
    const taskId = normalizeId(raw?.task_id ?? raw?.taskId, "task_id");
    const task = byId.get(taskId);
    if (!task) throw new GoalError("NOT_FOUND", `Task ${taskId} was not found.`);
    const status = String(raw?.status ?? "");
    if (!['start', 'complete', 'skipped', 'pending'].includes(status)) {
      throw new GoalError("INVALID_ARGUMENT", `Unsupported task status: ${status}.`);
    }
    if (status === "start") {
      if (task.status !== "pending") throw new GoalError("INVALID_STATE", `Task ${taskId} is already ${task.status}.`);
      draft.currentTaskId = taskId;
      continue;
    }
    if (status === "complete") {
      if (task.status !== "pending") {
        throw new GoalError("INVALID_STATE", `Task ${taskId} is ${task.status}; only a pending task can be completed.`);
      }
      const unresolved = descendants(task).filter((child) => child.status === "pending");
      if (unresolved.length && !task.lightweightSubtasks) {
        throw new GoalError("TASKS_INCOMPLETE", `Task ${taskId} still has ${unresolved.length} pending subtasks.`);
      }
      const evidence = boundedText(raw?.evidence, "evidence", LIMITS.taskEvidence);
      if (task.verificationContract && !evidence) {
        throw new GoalError("EVIDENCE_REQUIRED", `Task ${taskId} requires evidence: ${task.verificationContract}`);
      }
      task.status = "complete";
      task.evidence = evidence || null;
      task.skipReason = null;
      task.completedAt = nowIso(options.now);
      task.skippedAt = null;
      if (draft.currentTaskId === taskId) draft.currentTaskId = null;
      continue;
    }
    if (status === "skipped") {
      if (task.status !== "pending") {
        throw new GoalError("INVALID_STATE", `Task ${taskId} is ${task.status}; only a pending task can be skipped.`);
      }
      const reason = boundedText(raw?.reason, "reason", LIMITS.taskReason, { required: true });
      const skippedAt = nowIso(options.now);
      task.status = "skipped";
      task.skipReason = reason;
      task.evidence = null;
      task.completedAt = null;
      task.skippedAt = skippedAt;
      for (const child of descendants(task)) {
        if (child.status === "pending") {
          child.status = "skipped";
          child.skipReason = `Parent ${taskId} skipped: ${reason}`.slice(0, LIMITS.taskReason);
          child.skippedAt = skippedAt;
        }
      }
      if (draft.currentTaskId === taskId || descendants(task).some((child) => child.id === draft.currentTaskId)) {
        draft.currentTaskId = null;
      }
      continue;
    }
    if (task.status !== "skipped") {
      throw new GoalError("INVALID_STATE", `Task ${taskId} is ${task.status}; only a skipped task can be reopened.`);
    }
    task.status = "pending";
    task.evidence = null;
    task.skipReason = null;
    task.completedAt = null;
    task.skippedAt = null;
    let parent = parentById.get(taskId);
    while (parent) {
      if (parent.status === "complete") {
        parent.status = "pending";
        parent.evidence = null;
        parent.completedAt = null;
      }
      parent = parentById.get(parent.id);
    }
  }
  draft.blocker = null;
  touch(draft, options.now);
  pushActivity(
    draft,
    "task_progress",
    `Applied ${updates.length} task update${updates.length === 1 ? "" : "s"}.`,
    {
      updates: updates.slice(0, 20).map((item) => ({
        taskId: item.task_id ?? item.taskId,
        status: item.status,
      })),
      totalUpdates: updates.length,
      truncated: updates.length > 20,
    },
    draft.updatedAt,
  );
  const index = workspace.goals.findIndex((item) => item.id === goal.id);
  workspace.goals[index] = draft;
  workspace.updatedAt = draft.updatedAt;
  return draft;
}

function taskStats(goal) {
  const tasks = flattenTasks(goal.tasks).map(({ task }) => task);
  return {
    total: tasks.length,
    pending: tasks.filter((task) => task.status === "pending").length,
    complete: tasks.filter((task) => task.status === "complete").length,
    skipped: tasks.filter((task) => task.status === "skipped").length,
  };
}

function assertCompletable(goal) {
  if (!["active", "paused", "budget_limited"].includes(goal.status)) {
    throw new GoalError("INVALID_STATE", `Goal status ${goal.status} cannot be completed.`);
  }
  const stats = taskStats(goal);
  if (goal.blockCompletion && stats.pending > 0) {
    throw new GoalError("TASKS_INCOMPLETE", `${stats.pending} tasks are still pending.`);
  }
  return stats;
}

function applyAuditResult(workspace, goalId, audit, options = {}) {
  const goal = findGoal(workspace, goalId);
  checkRevision(goal, options.expectedRevision);
  assertCompletable(goal);
  const timestamp = nowIso(options.now);
  const auditEntry = {
    id: makeId("audit"),
    approved: audit?.approved === true,
    skipped: audit?.skipped === true,
    modelKey: String(audit?.modelKey ?? "").trim() || null,
    report: String(audit?.report ?? "").trim().slice(0, 8000) || null,
    usage: normalizedUsage(audit?.usage),
    at: timestamp,
  };
  goal.audits.unshift(auditEntry);
  goal.audits = goal.audits.slice(0, LIMITS.audits);
  if (!auditEntry.approved) {
    touch(goal, options.now);
    pushActivity(goal, "audit_rejected", "Completion audit requested more work.", null, timestamp);
    workspace.updatedAt = goal.updatedAt;
    return { goal, archived: false, audit: auditEntry };
  }
  settleActiveTime(goal, options.now);
  goal.status = "complete";
  goal.completedAt = timestamp;
  goal.archiveReason = auditEntry.skipped ? "audit_disabled" : "audited_completion";
  goal.currentTaskId = null;
  touch(goal, options.now);
  pushActivity(
    goal,
    auditEntry.skipped ? "completed_without_audit" : "completed",
    auditEntry.skipped ? "Goal completed with auditing disabled." : "Goal completed after audit approval.",
    null,
    timestamp,
  );
  workspace.goals = workspace.goals.filter((item) => item.id !== goal.id);
  workspace.archivedGoals.unshift(goal);
  workspace.archivedGoals = workspace.archivedGoals.slice(0, LIMITS.archivedGoals);
  if (workspace.focusedGoalId === goal.id) workspace.focusedGoalId = null;
  workspace.sessionFocus = (workspace.sessionFocus || []).filter((entry) => entry.goalId !== goal.id);
  workspace.updatedAt = goal.updatedAt;
  return { goal, archived: true, audit: auditEntry };
}

function archiveGoal(workspace, goalId, options = {}) {
  const goal = findGoal(workspace, goalId);
  checkRevision(goal, options.expectedRevision);
  settleActiveTime(goal, options.now);
  goal.status = "archived";
  goal.archiveReason = boundedText(options.reason, "reason", LIMITS.taskReason) || "cleared_by_user";
  goal.currentTaskId = null;
  touch(goal, options.now);
  pushActivity(goal, "archived", "Goal archived by the user.", { reason: goal.archiveReason }, goal.updatedAt);
  workspace.goals = workspace.goals.filter((item) => item.id !== goal.id);
  workspace.archivedGoals.unshift(goal);
  workspace.archivedGoals = workspace.archivedGoals.slice(0, LIMITS.archivedGoals);
  if (workspace.focusedGoalId === goal.id) workspace.focusedGoalId = null;
  workspace.sessionFocus = (workspace.sessionFocus || []).filter((entry) => entry.goalId !== goal.id);
  workspace.updatedAt = goal.updatedAt;
  return goal;
}

function restoreGoal(workspace, goalId, options = {}) {
  const archived = findGoal(workspace, goalId, { archived: true });
  checkRevision(archived, options.expectedRevision);
  if (workspace.goals.length >= LIMITS.openGoals) {
    throw new GoalError("LIMIT_EXCEEDED", `A workspace may keep at most ${LIMITS.openGoals} open goals.`);
  }
  const goal = clone(archived);
  goal.status = "paused";
  goal.activeSince = null;
  goal.completedAt = null;
  goal.archiveReason = null;
  goal.pauseReason = "Restored from archive. Resume when ready.";
  touch(goal, options.now);
  pushActivity(goal, "restored", "Goal restored from archive in paused state.", null, goal.updatedAt);
  workspace.archivedGoals = workspace.archivedGoals.filter((item) => item.id !== goal.id);
  workspace.goals.unshift(goal);
  workspace.focusedGoalId = goal.id;
  workspace.sessionFocus = [];
  workspace.updatedAt = goal.updatedAt;
  return goal;
}

function activeSeconds(goal, now = Date.now()) {
  let value = goal.usage.activeSeconds;
  if (goal.status === "active" && goal.activeSince) {
    const started = new Date(goal.activeSince).getTime();
    if (Number.isFinite(started)) value += Math.max(0, Math.floor((now - started) / 1000));
  }
  return value;
}

function publicGoal(goal, options = {}) {
  const value = clone(goal);
  value.usage.activeSeconds = activeSeconds(goal, options.now);
  value.stats = taskStats(goal);
  if (value.blocker) {
    value.blocker = {
      count: Number(value.blocker.count) || 0,
      reason: value.blocker.reason || null,
      attemptedActions: value.blocker.attemptedActions || [],
      lastAt: value.blocker.lastAt || null,
    };
  }
  return value;
}

function workspaceView(workspace, options = {}) {
  return {
    key: workspace.key,
    name: workspace.name,
    hasWorkspace: Boolean(workspace.path),
    focusedGoalId: workspace.focusedGoalId,
    goals: workspace.goals.map((goal) => publicGoal(goal, options)),
    archivedGoals: workspace.archivedGoals.map((goal) => publicGoal(goal, options)),
    updatedAt: workspace.updatedAt,
  };
}

module.exports = {
  LIMITS,
  GoalError,
  normalizeRoot,
  normalizeWorkspace,
  ensureWorkspace,
  findGoal,
  sessionFocusedGoalId,
  setSessionFocus,
  createGoal,
  setFocus,
  editGoal,
  pauseGoal,
  resumeGoal,
  reportBlocked,
  buildTaskTree,
  setGoalTasks,
  updateGoalTasks,
  taskStats,
  assertCompletable,
  applyAuditResult,
  archiveGoal,
  restoreGoal,
  publicGoal,
  workspaceView,
  blockerFingerprint,
  flattenTasks,
  nowIso,
};
