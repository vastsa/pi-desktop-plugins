"use strict";

const { createHash } = require("node:crypto");
const {
  GoalError,
  findGoal,
  sessionFocusedGoalId,
  createGoal,
  setFocus,
  editGoal,
  pauseGoal,
  resumeGoal,
  reportBlocked,
  setGoalTasks,
  updateGoalTasks,
  assertCompletable,
  applyAuditResult,
  archiveGoal,
  restoreGoal,
  publicGoal,
  workspaceView,
} = require("./lib/goal-engine");
const {
  readSettings,
  readCurrentWorkspace,
  mutateCurrentWorkspace,
  updatePluginSettings,
  currentWorkspaceView,
} = require("./lib/store");
const { runAudit } = require("./lib/auditor");

const TOOL_NAMES = ["create_goal", "get_goal", "update_goal", "set_goal_tasks", "update_goal_task"];
const COMMAND_IDS = [
  "goal-x.open",
  "goal-x.new",
  "goal-x.new-sisyphus",
  "goal-x.unfocus",
  "goal-x.pause",
  "goal-x.resume",
];

const DEFAULT_SETTINGS = Object.freeze({
  auditorEnabled: true,
  auditorModelKey: "",
  auditorEffort: "high",
  defaultBlockCompletion: true,
});
const COMPLETION_SUMMARY_LIMIT = 2000;

let pendingCreateMode = null;

function opaqueKey(prefix, value) {
  const text = String(value ?? "").trim();
  return text ? `${prefix}-${createHash("sha256").update(text).digest("hex").slice(0, 24)}` : null;
}

function sessionKey(context) {
  return opaqueKey("session", context?.sessionId);
}

function resolveGoalId(workspace, goalId, context) {
  if (goalId) return findGoal(workspace, goalId).id;
  const key = sessionKey(context);
  if (!key) return findGoal(workspace, null).id;
  const focused = sessionFocusedGoalId(workspace, key);
  if (!focused) {
    throw new GoalError(
      "NO_FOCUSED_GOAL",
      "This Agent session has no focused Goal X goal. Pass goal_id explicitly or create a goal in this session.",
    );
  }
  return focused;
}

async function blockerTurnId(context) {
  if (context?.turnId) return opaqueKey("turn", `${context.sessionId || ""}:${context.turnId}`);
  if (!context?.sessionId) return null;
  try {
    const llmContext = await pi.session.getLlmContext();
    if (String(llmContext?.sessionId ?? "").trim() !== String(context.sessionId).trim()) return null;
    const messages = Array.isArray(llmContext?.messages) ? llmContext.messages : [];
    let userCount = 0;
    let lastUserIndex = -1;
    for (let index = 0; index < messages.length; index += 1) {
      if (messages[index]?.role !== "user") continue;
      userCount += 1;
      lastUserIndex = index;
    }
    if (lastUserIndex < 0) return null;
    return opaqueKey("turn", `${context.sessionId}\0${userCount}\0${lastUserIndex}`);
  } catch {
    return null;
  }
}

function errorResult(error) {
  return {
    ok: false,
    code: error?.code || "GOAL_X_ERROR",
    error: error?.message || String(error),
  };
}

async function safeTool(operation, context) {
  try {
    return await operation();
  } catch (error) {
    context?.log?.(`Goal X error [${error?.code || "GOAL_X_ERROR"}]: ${error?.message || error}`);
    return errorResult(error);
  }
}

function auditSettings(raw) {
  const effort = ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(raw?.auditorEffort)
    ? raw.auditorEffort
    : DEFAULT_SETTINGS.auditorEffort;
  return {
    auditorEnabled: raw?.auditorEnabled !== false,
    auditorModelKey: String(raw?.auditorModelKey ?? "").trim(),
    auditorEffort: effort,
    defaultBlockCompletion: raw?.defaultBlockCompletion !== false,
  };
}

function completionSummary(value) {
  const summary = String(value ?? "").trim();
  if (summary.length > COMPLETION_SUMMARY_LIMIT) {
    throw new GoalError(
      "LIMIT_EXCEEDED",
      `completion_summary must be ${COMPLETION_SUMMARY_LIMIT} characters or fewer.`,
    );
  }
  return summary || undefined;
}

function goalSummary(goal) {
  const view = publicGoal(goal);
  return {
    id: view.id,
    objective: view.objective,
    mode: view.mode,
    status: view.status,
    revision: view.revision,
    verificationContract: view.verificationContract,
    tokenBudget: view.tokenBudget,
    blockCompletion: view.blockCompletion,
    currentTaskId: view.currentTaskId,
    pauseReason: view.pauseReason,
    suggestedAction: view.suggestedAction,
    blocker: view.blocker,
    usage: view.usage,
    stats: view.stats,
    tasks: view.tasks,
    latestAudit: view.audits[0] || null,
    recentActivity: view.activity.slice(0, 12),
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
    completedAt: view.completedAt,
    archiveReason: view.archiveReason,
  };
}

async function getFocusedGoal(goalId, context) {
  const state = await readCurrentWorkspace();
  const resolvedGoalId = resolveGoalId(state.workspace, goalId, context);
  return { ...state, goal: findGoal(state.workspace, resolvedGoalId) };
}

async function createGoalAction(args, context) {
  const settings = auditSettings(await readSettings());
  const mutation = await mutateCurrentWorkspace((workspace) => createGoal(workspace, {
    ...args,
    block_completion: args?.block_completion ?? settings.defaultBlockCompletion,
  }, { sessionKey: sessionKey(context) }));
  return mutation.result;
}

async function completeGoalAction(args, context) {
  const summary = completionSummary(args?.completion_summary);
  const initial = await getFocusedGoal(args?.goal_id, context);
  const goal = initial.goal;
  const expectedRevision = goal.revision;
  if (args?.expected_revision != null && Number(args.expected_revision) !== expectedRevision) {
    throw new GoalError("STALE_STATE", `Goal changed since revision ${args.expected_revision}; refresh and retry.`);
  }
  assertCompletable(goal);
  const settings = auditSettings(initial.settings);
  if (!settings.auditorEnabled) {
    const mutation = await mutateCurrentWorkspace((workspace) => applyAuditResult(
      workspace,
      goal.id,
      {
        approved: true,
        skipped: true,
        report: "Completion auditing was disabled by the user.",
      },
      { expectedRevision },
    ));
    return mutation.result;
  }
  const audit = await runAudit(goal, {
    settings,
    completionSummary: summary,
  }, context);
  const mutation = await mutateCurrentWorkspace((workspace) => applyAuditResult(
    workspace,
    goal.id,
    audit,
    { expectedRevision },
  ));
  return mutation.result;
}

function singleOrBatchTaskUpdates(args) {
  if (Array.isArray(args?.updates)) {
    if (args.task_id != null || args.status != null || args.evidence != null || args.reason != null) {
      throw new GoalError("INVALID_ARGUMENT", "Use either updates or the single-task fields, not both.");
    }
    return args.updates;
  }
  if (!args?.task_id || !args?.status) {
    throw new GoalError("INVALID_ARGUMENT", "task_id and status are required when updates is omitted.");
  }
  return [{ task_id: args.task_id, status: args.status, evidence: args.evidence, reason: args.reason }];
}

const TOOL_DEFINITIONS = [
  {
    name: "create_goal",
    description: "Create and focus a persistent workspace goal only after the user explicitly requests it. Supports regular and ordered Sisyphus goals.",
    risk: "low",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        objective: { type: "string", minLength: 1, maxLength: 4000, description: "The complete outcome to achieve." },
        mode: { type: "string", enum: ["regular", "sisyphus"], description: "Use sisyphus only for an explicitly ordered goal." },
        verification_contract: { type: "string", maxLength: 2000, description: "Concrete evidence required before completion." },
        token_budget: { type: "integer", minimum: 1, description: "Optional user-supplied token budget metadata." },
        block_completion: { type: "boolean", description: "Require every task to resolve before completion." },
      },
      required: ["objective"],
    },
    execute: (args, context) => safeTool(async () => {
      const goal = await createGoalAction(args, context);
      return { ok: true, goal: goalSummary(goal) };
    }, context),
  },
  {
    name: "get_goal",
    description: "Read the current workspace goal pool or one goal, including task evidence, audit state, and recent activity.",
    risk: "low",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        goal_id: { type: "string", description: "Open goal id. Defaults to the focused goal." },
        view: { type: "string", enum: ["focused", "pool"], description: "Use pool to list all open goals." },
        include_archived: { type: "boolean", description: "Include recently archived goals in a pool response." },
      },
    },
    execute: (args, context) => safeTool(async () => {
      const { workspace } = await readCurrentWorkspace();
      const focusedGoalId = sessionFocusedGoalId(workspace, sessionKey(context));
      if (args?.view !== "pool" && (args?.goal_id || focusedGoalId)) {
        const goal = findGoal(workspace, args?.goal_id || focusedGoalId);
        return { ok: true, focusedGoalId, goal: goalSummary(goal) };
      }
      const view = workspaceView(workspace);
      return {
        ok: true,
        focusedGoalId,
        goals: view.goals.map(goalSummary),
        archivedGoals: args?.include_archived ? view.archivedGoals.map(goalSummary) : undefined,
      };
    }, context),
  },
  {
    name: "update_goal",
    description: "Report a goal outcome: complete runs an independent audit, blocked requires three matching turn reports, and paused stops immediately with a reason.",
    risk: "medium",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        goal_id: { type: "string", description: "Open goal id. Defaults to the focused goal." },
        status: { type: "string", enum: ["complete", "blocked", "paused"], description: "Outcome to report." },
        reason: { type: "string", maxLength: 600, description: "Required for blocked or paused." },
        attempted_actions: { type: "array", maxItems: 8, items: { type: "string", maxLength: 240 } },
        suggested_action: { type: "string", maxLength: 600 },
        completion_summary: { type: "string", maxLength: 2000, description: "Executor claim supplied to the auditor; not treated as evidence." },
        expected_revision: { type: "integer", minimum: 0, description: "Reject stale updates when supplied." },
      },
      required: ["status"],
    },
    execute: (args, context) => safeTool(async () => {
      if (args.status === "complete") {
        const completed = await completeGoalAction(args, context);
        return {
          ok: true,
          approved: completed.audit.approved,
          archived: completed.archived,
          audit: completed.audit,
          goal: goalSummary(completed.goal),
        };
      }
      if (args.status === "paused") {
        const mutation = await mutateCurrentWorkspace((workspace) => pauseGoal(
          workspace,
          resolveGoalId(workspace, args.goal_id, context),
          args.reason,
          args.suggested_action,
          { expectedRevision: args.expected_revision },
        ));
        return { ok: true, goal: goalSummary(mutation.result) };
      }
      const turnId = await blockerTurnId(context);
      const mutation = await mutateCurrentWorkspace((workspace) => reportBlocked(workspace, resolveGoalId(workspace, args.goal_id, context), args, {
        expectedRevision: args.expected_revision,
        turnId,
      }));
      return {
        ok: true,
        blocked: mutation.result.blocked,
        reports: mutation.result.count,
        reportsRemaining: mutation.result.remaining,
        goal: goalSummary(mutation.result.goal),
      };
    }, context),
  },
  {
    name: "set_goal_tasks",
    description: "Create or replace a focused goal's task tree. Stable task ids retain progress and parent_id defines nesting.",
    risk: "low",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        goal_id: { type: "string", description: "Open goal id. Defaults to the focused goal." },
        tasks: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string", minLength: 1, maxLength: 80 },
              title: { type: "string", minLength: 1, maxLength: 240 },
              parent_id: { type: "string", maxLength: 80 },
              verification_contract: { type: "string", maxLength: 2000 },
              lightweight_subtasks: { type: "boolean" },
            },
            required: ["id", "title"],
          },
        },
        block_completion: { type: "boolean" },
        change_summary: { type: "string", maxLength: 600 },
        expected_revision: { type: "integer", minimum: 0 },
      },
      required: ["tasks"],
    },
    execute: (args, context) => safeTool(async () => {
      const mutation = await mutateCurrentWorkspace((workspace) => setGoalTasks(
        workspace,
        resolveGoalId(workspace, args.goal_id, context),
        args,
        { expectedRevision: args.expected_revision },
      ));
      return { ok: true, goal: goalSummary(mutation.result) };
    }, context),
  },
  {
    name: "update_goal_task",
    description: "Atomically start, complete, skip, or reopen one or more goal tasks. Contracted tasks require completion evidence.",
    risk: "low",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        goal_id: { type: "string", description: "Open goal id. Defaults to the focused goal." },
        task_id: { type: "string", maxLength: 80 },
        status: { type: "string", enum: ["start", "complete", "skipped", "pending"] },
        evidence: { type: "string", maxLength: 600 },
        reason: { type: "string", maxLength: 600 },
        updates: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              task_id: { type: "string", minLength: 1, maxLength: 80 },
              status: { type: "string", enum: ["start", "complete", "skipped", "pending"] },
              evidence: { type: "string", maxLength: 600 },
              reason: { type: "string", maxLength: 600 },
            },
            required: ["task_id", "status"],
          },
        },
        expected_revision: { type: "integer", minimum: 0 },
      },
    },
    execute: (args, context) => safeTool(async () => {
      const updates = singleOrBatchTaskUpdates(args);
      const mutation = await mutateCurrentWorkspace((workspace) => updateGoalTasks(
        workspace,
        resolveGoalId(workspace, args.goal_id, context),
        updates,
        { expectedRevision: args.expected_revision },
      ));
      return { ok: true, goal: goalSummary(mutation.result) };
    }, context),
  },
];

async function openPanel(mode = null) {
  pendingCreateMode = mode;
  await pi.ui.openPanel();
}

async function pauseFocusedFromCommand() {
  try {
    const mutation = await mutateCurrentWorkspace((workspace) => pauseGoal(
      workspace,
      null,
      "Paused by the user from the command palette.",
      null,
    ));
    await pi.ui.showToast(`Paused: ${mutation.result.objective.slice(0, 80)}`);
  } catch (error) {
    await pi.ui.showToast(error?.message || String(error), "warn");
  }
}

async function resumeFocusedFromCommand() {
  try {
    const mutation = await mutateCurrentWorkspace((workspace) => resumeGoal(workspace, null));
    await pi.ui.showToast(`Resumed: ${mutation.result.objective.slice(0, 80)}`);
  } catch (error) {
    await pi.ui.showToast(error?.message || String(error), "warn");
  }
}

async function unfocusFromCommand() {
  await mutateCurrentWorkspace((workspace) => setFocus(workspace, null));
  await pi.ui.showToast("Goal focus cleared.");
}

const COMMAND_DEFINITIONS = [
  { id: "goal-x.open", title: "Goal X: Open dashboard", keywords: ["goal", "目标"], run: () => openPanel() },
  { id: "goal-x.new", title: "Goal X: New goal", keywords: ["goal", "new", "新建目标"], run: () => openPanel("regular") },
  { id: "goal-x.new-sisyphus", title: "Goal X: New ordered goal", keywords: ["sisyphus", "ordered", "有序目标"], run: () => openPanel("sisyphus") },
  { id: "goal-x.unfocus", title: "Goal X: Clear focus", keywords: ["goal", "unfocus", "取消聚焦"], run: unfocusFromCommand },
  { id: "goal-x.pause", title: "Goal X: Pause focused goal", keywords: ["goal", "pause", "暂停"], run: pauseFocusedFromCommand },
  { id: "goal-x.resume", title: "Goal X: Resume focused goal", keywords: ["goal", "resume", "恢复"], run: resumeFocusedFromCommand },
];

async function panelState() {
  const [{ workspace, descriptor }, rawSettings] = await Promise.all([
    currentWorkspaceView(),
    readSettings(),
  ]);
  const mode = pendingCreateMode;
  pendingCreateMode = null;
  return {
    workspace,
    descriptor,
    settings: auditSettings(rawSettings),
    pendingCreateMode: mode,
  };
}

async function panelComplete(payload) {
  const completed = await completeGoalAction({
    goal_id: payload?.goalId,
    completion_summary: payload?.completionSummary,
    expected_revision: payload?.expectedRevision,
  }, null);
  return {
    ok: true,
    approved: completed.audit.approved,
    archived: completed.archived,
    audit: completed.audit,
    goal: goalSummary(completed.goal),
  };
}

async function onPanelInvoke(channel, payload) {
  switch (channel) {
    case "goal.state":
      return panelState();
    case "goal.create": {
      const goal = await createGoalAction({
        objective: payload?.objective,
        mode: payload?.mode,
        verification_contract: payload?.verificationContract,
        token_budget: payload?.tokenBudget,
        block_completion: payload?.blockCompletion,
      });
      return { ok: true, goal: goalSummary(goal) };
    }
    case "goal.focus": {
      const mutation = await mutateCurrentWorkspace((workspace) => setFocus(workspace, payload?.goalId));
      return { ok: true, goal: mutation.result ? goalSummary(mutation.result) : null };
    }
    case "goal.edit": {
      const mutation = await mutateCurrentWorkspace((workspace) => editGoal(
        workspace,
        payload?.goalId,
        {
          objective: payload?.objective,
          mode: payload?.mode,
          verificationContract: payload?.verificationContract,
          tokenBudget: payload?.tokenBudget,
          blockCompletion: payload?.blockCompletion,
        },
        { expectedRevision: payload?.expectedRevision },
      ));
      return { ok: true, goal: goalSummary(mutation.result) };
    }
    case "goal.status": {
      const action = String(payload?.action ?? "");
      if (action === "pause") {
        const mutation = await mutateCurrentWorkspace((workspace) => pauseGoal(
          workspace,
          payload?.goalId,
          payload?.reason,
          payload?.suggestedAction,
          { expectedRevision: payload?.expectedRevision },
        ));
        return { ok: true, goal: goalSummary(mutation.result) };
      }
      if (action === "resume") {
        const mutation = await mutateCurrentWorkspace((workspace) => resumeGoal(
          workspace,
          payload?.goalId,
          { expectedRevision: payload?.expectedRevision },
        ));
        return { ok: true, goal: goalSummary(mutation.result) };
      }
      throw new GoalError("INVALID_ARGUMENT", `Unsupported status action: ${action}.`);
    }
    case "goal.setTasks": {
      const mutation = await mutateCurrentWorkspace((workspace) => setGoalTasks(
        workspace,
        payload?.goalId,
        { tasks: payload?.tasks, blockCompletion: payload?.blockCompletion, change_summary: payload?.changeSummary },
        { expectedRevision: payload?.expectedRevision },
      ));
      return { ok: true, goal: goalSummary(mutation.result) };
    }
    case "goal.updateTask": {
      const updates = Array.isArray(payload?.updates)
        ? payload.updates
        : [{ task_id: payload?.taskId, status: payload?.status, evidence: payload?.evidence, reason: payload?.reason }];
      const mutation = await mutateCurrentWorkspace((workspace) => updateGoalTasks(
        workspace,
        payload?.goalId,
        updates,
        { expectedRevision: payload?.expectedRevision },
      ));
      return { ok: true, goal: goalSummary(mutation.result) };
    }
    case "goal.complete":
      return panelComplete(payload);
    case "goal.archive": {
      const mutation = await mutateCurrentWorkspace((workspace) => archiveGoal(
        workspace,
        payload?.goalId,
        { expectedRevision: payload?.expectedRevision, reason: payload?.reason },
      ));
      return { ok: true, goal: goalSummary(mutation.result) };
    }
    case "goal.restore": {
      const mutation = await mutateCurrentWorkspace((workspace) => restoreGoal(
        workspace,
        payload?.goalId,
        { expectedRevision: payload?.expectedRevision },
      ));
      return { ok: true, goal: goalSummary(mutation.result) };
    }
    case "goal.settings.get": {
      const [raw, models] = await Promise.all([readSettings(), pi.models.list()]);
      return { settings: auditSettings(raw), models: Array.isArray(models) ? models : [] };
    }
    case "goal.settings.set": {
      const next = await updatePluginSettings((current) => auditSettings({ ...current, ...payload }));
      return { ok: true, settings: auditSettings(next) };
    }
    default:
      throw Object.assign(new Error(`Unsupported panel channel: ${channel}`), { code: "UNSUPPORTED" });
  }
}

async function onLoad() {
  for (const command of COMMAND_DEFINITIONS) await pi.commands.register(command);
  for (const tool of TOOL_DEFINITIONS) await pi.agent.registerTool(tool);
}

async function onUnload() {
  for (const toolName of TOOL_NAMES) await pi.agent.unregisterTool(toolName);
  for (const commandId of COMMAND_IDS) await pi.commands.unregister(commandId);
}

module.exports = {
  onLoad,
  onUnload,
  onPanelInvoke,
  __test: {
    auditSettings,
    singleOrBatchTaskUpdates,
    goalSummary,
    TOOL_DEFINITIONS,
    COMMAND_DEFINITIONS,
  },
};
