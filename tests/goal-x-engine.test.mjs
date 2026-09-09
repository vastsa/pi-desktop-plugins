import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  LIMITS,
  GoalError,
  normalizeRoot,
  ensureWorkspace,
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
  applyAuditResult,
  archiveGoal,
  restoreGoal,
  publicGoal,
  workspaceView,
  flattenTasks,
} = require("../plugins/pi.goal-x/lib/goal-engine.js");

const BASE_TIME = Date.parse("2026-09-09T00:00:00.000Z");

function freshWorkspace(key = "workspace-alpha", path = "/workspace/alpha") {
  const root = normalizeRoot(null);
  return {
    root,
    workspace: ensureWorkspace(root, { key, path, name: "Alpha" }),
  };
}

function assertGoalError(operation, code) {
  assert.throws(operation, (error) => {
    assert.ok(error instanceof GoalError);
    assert.equal(error.code, code);
    return true;
  });
}

test("goal creation and workspace views remain isolated", () => {
  const root = normalizeRoot({ version: 999, workspaces: {} });
  const alpha = ensureWorkspace(root, {
    key: "workspace-alpha",
    path: "/workspace/alpha",
    name: "Alpha",
  });
  const beta = ensureWorkspace(root, {
    key: "workspace-beta",
    path: "/workspace/beta",
    name: "Beta",
  });

  const alphaGoal = createGoal(alpha, {
    objective: "  Publish Goal X  ",
    mode: "sisyphus",
    verification_contract: "Tests pass",
    token_budget: 5000,
    block_completion: true,
  }, { id: "goal-alpha", now: BASE_TIME });
  const betaGoal = createGoal(beta, { objective: "Document Goal X" }, {
    id: "goal-beta",
    now: BASE_TIME + 1000,
  });

  assert.equal(root.version, 1);
  assert.equal(alphaGoal.objective, "Publish Goal X");
  assert.equal(alphaGoal.mode, "sisyphus");
  assert.equal(alphaGoal.verificationContract, "Tests pass");
  assert.equal(alphaGoal.tokenBudget, 5000);
  assert.equal(alphaGoal.blockCompletion, true);
  assert.equal(alpha.focusedGoalId, "goal-alpha");
  assert.deepEqual(alpha.goals.map((goal) => goal.id), ["goal-alpha"]);
  assert.deepEqual(beta.goals.map((goal) => goal.id), ["goal-beta"]);
  assert.equal(betaGoal.mode, "regular");
  assert.notStrictEqual(alpha.goals, beta.goals);

  const alphaView = workspaceView(alpha, { now: BASE_TIME + 2500 });
  const betaView = workspaceView(beta, { now: BASE_TIME + 2500 });
  assert.equal(alphaView.hasWorkspace, true);
  assert.equal(alphaView.goals[0].usage.activeSeconds, 2);
  assert.equal(betaView.goals[0].usage.activeSeconds, 1);
  assert.equal(alphaView.goals.some((goal) => goal.id === "goal-beta"), false);
  assert.equal(betaView.goals.some((goal) => goal.id === "goal-alpha"), false);
});

test("explicit display focus changes invalidate hidden Agent-session focus", () => {
  const { workspace } = freshWorkspace();
  const first = createGoal(workspace, { objective: "First" }, {
    id: "goal-first",
    sessionKey: "session-a",
    now: BASE_TIME,
  });
  const second = createGoal(workspace, { objective: "Second" }, {
    id: "goal-second",
    sessionKey: "session-b",
    now: BASE_TIME + 1000,
  });
  assert.equal(sessionFocusedGoalId(workspace, "session-a"), first.id);
  assert.equal(sessionFocusedGoalId(workspace, "session-b"), second.id);

  setFocus(workspace, first.id);
  assert.equal(workspace.focusedGoalId, first.id);
  assert.equal(sessionFocusedGoalId(workspace, "session-a"), null);
  assert.equal(sessionFocusedGoalId(workspace, "session-b"), null);

  setSessionFocus(workspace, "session-a", first.id);
  createGoal(workspace, { objective: "Created in the panel" }, {
    id: "goal-panel",
    now: BASE_TIME + 2000,
  });
  assert.equal(sessionFocusedGoalId(workspace, "session-a"), null);
});

test("persisted state normalization is bounded and prototype-safe", () => {
  const oversizedTasks = Array.from({ length: LIMITS.tasks + 25 }, (_, index) => ({
    id: `task-${index}`,
    title: `Task ${index}`,
    status: "pending",
    subtasks: [],
  }));
  const rawWorkspaces = {
    __proto__: { goals: [{ id: "bad", objective: "Bad" }] },
    constructor: { goals: [{ id: "also-bad", objective: "Bad" }] },
    alpha: {
      goals: [{ id: "goal-bounded", objective: "Bounded", tasks: oversizedTasks }],
      archivedGoals: [],
    },
  };
  Object.defineProperty(rawWorkspaces, "__proto__", {
    value: { goals: [{ id: "bad", objective: "Bad" }] },
    enumerable: true,
  });

  const root = normalizeRoot({ version: 1, workspaces: rawWorkspaces });
  assert.equal(Object.getPrototypeOf(root.workspaces), null);
  assert.equal(Object.hasOwn(root.workspaces, "__proto__"), false);
  assert.equal(Object.hasOwn(root.workspaces, "constructor"), false);
  assert.equal(flattenTasks(root.workspaces.alpha.goals[0].tasks).length, LIMITS.tasks);
});

test("workspace retention rejects overflow unless an empty workspace can be reclaimed", () => {
  const fullRoot = normalizeRoot(null);
  for (let index = 0; index < LIMITS.workspaces; index += 1) {
    const workspace = ensureWorkspace(fullRoot, { key: `workspace-${index}` });
    createGoal(workspace, { objective: `Goal ${index}` }, { id: `goal-${index}` });
  }
  assertGoalError(
    () => ensureWorkspace(fullRoot, { key: "workspace-overflow" }),
    "WORKSPACE_LIMIT_EXCEEDED",
  );

  const reclaimable = normalizeRoot(null);
  for (let index = 0; index < LIMITS.workspaces; index += 1) {
    ensureWorkspace(reclaimable, { key: `empty-${index}` });
  }
  const replacement = ensureWorkspace(reclaimable, { key: "workspace-replacement" });
  assert.equal(replacement.key, "workspace-replacement");
  assert.equal(Object.keys(reclaimable.workspaces).length, LIMITS.workspaces);
});

test("task plans build a stable tree and reject missing parents, cycles, and excess depth", () => {
  const tree = buildTaskTree([
    { id: "child", title: "Child", parent_id: "root" },
    { id: "root", title: "Root" },
    { id: "grandchild", title: "Grandchild", parent_id: "child" },
    { id: "leaf", title: "Leaf", parent_id: "grandchild" },
  ]);
  const flat = flattenTasks(tree);

  assert.equal(tree.length, 1);
  assert.deepEqual(flat.map(({ task, parent, depth }) => ({
    id: task.id,
    parentId: parent?.id ?? null,
    depth,
  })), [
    { id: "root", parentId: null, depth: 1 },
    { id: "child", parentId: "root", depth: 2 },
    { id: "grandchild", parentId: "child", depth: 3 },
    { id: "leaf", parentId: "grandchild", depth: 4 },
  ]);

  assertGoalError(() => buildTaskTree([
    { id: "orphan", title: "Orphan", parent_id: "missing" },
  ]), "INVALID_ARGUMENT");
  assertGoalError(() => buildTaskTree([
    { id: "a", title: "A", parent_id: "b" },
    { id: "b", title: "B", parent_id: "a" },
  ]), "INVALID_ARGUMENT");
  assertGoalError(() => buildTaskTree([
    { id: "a", title: "A" },
    { id: "b", title: "B", parent_id: "a" },
    { id: "c", title: "C", parent_id: "b" },
    { id: "d", title: "D", parent_id: "c" },
    { id: "e", title: "E", parent_id: "d" },
  ]), "LIMIT_EXCEEDED");
});

test("batch task progress is atomic and contracted tasks require evidence", () => {
  const { workspace } = freshWorkspace();
  const goal = createGoal(workspace, {
    objective: "Finish both checks",
    block_completion: true,
  }, { id: "goal-batch", now: BASE_TIME });
  setGoalTasks(workspace, goal.id, {
    tasks: [
      { id: "build", title: "Build package" },
      { id: "verify", title: "Verify package", verification_contract: "Attach test output" },
    ],
    block_completion: true,
  }, { expectedRevision: 0, now: BASE_TIME + 1000 });

  const revisionBeforeFailure = goal.revision;
  const activityBeforeFailure = goal.activity.length;
  assertGoalError(() => updateGoalTasks(workspace, goal.id, [
    { task_id: "build", status: "complete", evidence: "build.log" },
    { task_id: "verify", status: "complete" },
  ], { expectedRevision: revisionBeforeFailure, now: BASE_TIME + 2000 }), "EVIDENCE_REQUIRED");

  assert.equal(goal.revision, revisionBeforeFailure);
  assert.equal(goal.activity.length, activityBeforeFailure);
  assert.deepEqual(flattenTasks(goal.tasks).map(({ task }) => task.status), ["pending", "pending"]);

  const updated = updateGoalTasks(workspace, goal.id, [
    { task_id: "build", status: "complete", evidence: "build.log" },
    { task_id: "verify", status: "complete", evidence: "node --test: 12 passed" },
  ], { expectedRevision: revisionBeforeFailure, now: BASE_TIME + 3000 });

  assert.notStrictEqual(updated, goal);
  assert.equal(updated.revision, revisionBeforeFailure + 1);
  assert.deepEqual(flattenTasks(updated.tasks).map(({ task }) => ({
    id: task.id,
    status: task.status,
    evidence: task.evidence,
  })), [
    { id: "build", status: "complete", evidence: "build.log" },
    { id: "verify", status: "complete", evidence: "node --test: 12 passed" },
  ]);
  assert.deepEqual(publicGoal(updated, { now: BASE_TIME + 3000 }).stats, {
    total: 2,
    pending: 0,
    complete: 2,
    skipped: 0,
  });
});

test("setting tasks preserves the completion gate unless explicitly changed", () => {
  const { workspace } = freshWorkspace();
  const goal = createGoal(workspace, {
    objective: "Keep the gate",
    block_completion: true,
  }, { id: "goal-preserve-gate", now: BASE_TIME });

  setGoalTasks(workspace, goal.id, {
    tasks: [{ id: "build", title: "Build the package" }],
  }, { expectedRevision: 0, now: BASE_TIME + 1000 });
  assert.equal(goal.blockCompletion, true);

  setGoalTasks(workspace, goal.id, {
    tasks: [{ id: "build", title: "Build the package" }],
    block_completion: false,
  }, { expectedRevision: 1, now: BASE_TIME + 2000 });
  assert.equal(goal.blockCompletion, false);
});

test("task terminal states require explicit valid transitions", () => {
  const { workspace } = freshWorkspace();
  const goal = createGoal(workspace, { objective: "Respect task transitions" }, {
    id: "goal-transitions",
    now: BASE_TIME,
  });
  setGoalTasks(workspace, goal.id, {
    tasks: [
      { id: "done", title: "Complete me" },
      { id: "skip", title: "Skip me" },
    ],
  }, { expectedRevision: 0, now: BASE_TIME + 1000 });
  let current = updateGoalTasks(workspace, goal.id, [
    { task_id: "done", status: "complete" },
    { task_id: "skip", status: "skipped", reason: "Not required" },
  ], { expectedRevision: 1, now: BASE_TIME + 2000 });

  assertGoalError(() => updateGoalTasks(workspace, goal.id, [
    { task_id: "done", status: "pending" },
  ], { expectedRevision: current.revision }), "INVALID_STATE");
  assertGoalError(() => updateGoalTasks(workspace, goal.id, [
    { task_id: "skip", status: "complete" },
  ], { expectedRevision: current.revision }), "INVALID_STATE");

  current = updateGoalTasks(workspace, goal.id, [
    { task_id: "skip", status: "pending" },
  ], { expectedRevision: current.revision, now: BASE_TIME + 3000 });
  assert.equal(flattenTasks(current.tasks).find(({ task }) => task.id === "skip").task.status, "pending");
});

test("pause and resume settle active time and advance revisions", () => {
  const { workspace } = freshWorkspace();
  const goal = createGoal(workspace, { objective: "Pause safely" }, {
    id: "goal-pause",
    now: BASE_TIME,
  });

  pauseGoal(workspace, goal.id, "Waiting for a dependency", "Retry tomorrow", {
    expectedRevision: 0,
    now: BASE_TIME + 5500,
  });
  assert.equal(goal.status, "paused");
  assert.equal(goal.revision, 1);
  assert.equal(goal.usage.activeSeconds, 5);
  assert.equal(goal.activeSince, null);
  assert.equal(goal.pauseReason, "Waiting for a dependency");
  assert.equal(goal.suggestedAction, "Retry tomorrow");

  resumeGoal(workspace, goal.id, { expectedRevision: 1, now: BASE_TIME + 7000 });
  assert.equal(goal.status, "active");
  assert.equal(goal.revision, 2);
  assert.equal(goal.activeSince, "2026-09-09T00:00:07.000Z");
  assert.equal(goal.pauseReason, null);
  assert.equal(goal.suggestedAction, null);
  assert.equal(workspace.focusedGoalId, goal.id);
  assert.equal(publicGoal(goal, { now: BASE_TIME + 10500 }).usage.activeSeconds, 8);
});

test("a blocker requires matching reports from three distinct turns", () => {
  const { workspace } = freshWorkspace();
  const goal = createGoal(workspace, { objective: "Recover the API" }, {
    id: "goal-blocker",
    now: BASE_TIME,
  });

  const first = reportBlocked(workspace, goal.id, {
    reason: "Network / API unavailable!",
    attempted_actions: ["Retried with backoff"],
  }, { expectedRevision: 0, turnId: "turn-a", now: BASE_TIME + 1000 });
  assert.deepEqual({ count: first.count, blocked: first.blocked, remaining: first.remaining }, {
    count: 1,
    blocked: false,
    remaining: 2,
  });

  const duplicateTurn = reportBlocked(workspace, goal.id, {
    reason: "network api unavailable",
  }, { expectedRevision: 1, turnId: "turn-a", now: BASE_TIME + 2000 });
  assert.equal(duplicateTurn.count, 1);
  assert.equal(duplicateTurn.remaining, 2);

  const second = reportBlocked(workspace, goal.id, {
    reason: "NETWORK API UNAVAILABLE.",
  }, { expectedRevision: 2, turnId: "turn-b", now: BASE_TIME + 3000 });
  assert.equal(second.count, 2);
  assert.equal(second.blocked, false);

  const third = reportBlocked(workspace, goal.id, {
    reason: "network-api unavailable",
    suggested_action: "Wait for service recovery",
  }, { expectedRevision: 3, turnId: "turn-c", now: BASE_TIME + 4000 });
  assert.equal(third.count, 3);
  assert.equal(third.remaining, 0);
  assert.equal(third.blocked, true);
  assert.equal(goal.status, "blocked");
  assert.equal(goal.revision, 4);
  assert.equal(goal.pauseReason, "network-api unavailable");
  assert.equal(goal.suggestedAction, "Wait for service recovery");
  assert.deepEqual(goal.blocker.turnIds, ["turn-a", "turn-b", "turn-c"]);
  assertGoalError(() => applyAuditResult(workspace, goal.id, {
    approved: true,
    report: "<approved/>",
  }, { expectedRevision: goal.revision }), "INVALID_STATE");
});

test("expected revisions reject stale writes and no-op edits keep the revision", () => {
  const { workspace } = freshWorkspace();
  const goal = createGoal(workspace, { objective: "Original objective" }, {
    id: "goal-revision",
    now: BASE_TIME,
  });

  editGoal(workspace, goal.id, { objective: "Original objective" }, {
    expectedRevision: 0,
    now: BASE_TIME + 1000,
  });
  assert.equal(goal.revision, 0);

  editGoal(workspace, goal.id, { objective: "Updated objective", blockCompletion: true }, {
    expectedRevision: 0,
    now: BASE_TIME + 2000,
  });
  assert.equal(goal.revision, 1);
  assert.equal(goal.blockCompletion, true);

  assertGoalError(() => pauseGoal(workspace, goal.id, "Stale pause", null, {
    expectedRevision: 0,
    now: BASE_TIME + 3000,
  }), "STALE_STATE");
  assert.equal(goal.status, "active");
  assert.equal(goal.revision, 1);
});

test("audit rejection keeps work open, approval archives it, and restore reopens it paused", () => {
  const { workspace } = freshWorkspace();
  const goal = createGoal(workspace, {
    objective: "Pass independent audit",
    block_completion: true,
  }, { id: "goal-audit", sessionKey: "session-a", now: BASE_TIME });
  setGoalTasks(workspace, goal.id, {
    tasks: [{ id: "test", title: "Run tests", verification_contract: "Passing output" }],
    block_completion: true,
  }, { expectedRevision: 0, now: BASE_TIME + 1000 });
  const completedTasks = updateGoalTasks(workspace, goal.id, [
    { task_id: "test", status: "complete", evidence: "All tests passed" },
  ], { expectedRevision: 1, now: BASE_TIME + 2000 });

  const rejected = applyAuditResult(workspace, goal.id, {
    approved: false,
    modelKey: "auditor/model",
    report: "Missing release artifact. <disapproved/>",
  }, { expectedRevision: completedTasks.revision, now: BASE_TIME + 3000 });
  assert.equal(rejected.archived, false);
  assert.equal(rejected.goal.status, "active");
  assert.equal(rejected.goal.revision, 3);
  assert.deepEqual(workspace.goals.map((item) => item.id), [goal.id]);
  assert.deepEqual(workspace.archivedGoals, []);

  const approved = applyAuditResult(workspace, goal.id, {
    approved: true,
    modelKey: "auditor/model",
    report: "Evidence is sufficient. <approved/>",
  }, { expectedRevision: rejected.goal.revision, now: BASE_TIME + 4000 });
  assert.equal(approved.archived, true);
  assert.equal(approved.goal.status, "complete");
  assert.equal(approved.goal.archiveReason, "audited_completion");
  assert.equal(approved.goal.audits.length, 2);
  assert.deepEqual(workspace.goals, []);
  assert.deepEqual(workspace.archivedGoals.map((item) => item.id), [goal.id]);
  assert.equal(workspace.focusedGoalId, null);
  assert.equal(sessionFocusedGoalId(workspace, "session-a"), null);

  const restored = restoreGoal(workspace, goal.id, {
    expectedRevision: approved.goal.revision,
    now: BASE_TIME + 5000,
  });
  assert.equal(restored.status, "paused");
  assert.equal(restored.completedAt, null);
  assert.equal(restored.archiveReason, null);
  assert.match(restored.pauseReason, /Restored from archive/);
  assert.deepEqual(workspace.archivedGoals, []);
  assert.deepEqual(workspace.goals.map((item) => item.id), [goal.id]);
  assert.equal(workspace.focusedGoalId, goal.id);
  assert.equal(sessionFocusedGoalId(workspace, "session-a"), null);
});

test("manual archive and restore preserve the goal while advancing its revision", () => {
  const { workspace } = freshWorkspace();
  const goal = createGoal(workspace, { objective: "Archive me" }, {
    id: "goal-manual-archive",
    sessionKey: "session-a",
    now: BASE_TIME,
  });

  const archived = archiveGoal(workspace, goal.id, {
    expectedRevision: 0,
    reason: "Superseded",
    now: BASE_TIME + 1000,
  });
  assert.equal(archived.status, "archived");
  assert.equal(archived.archiveReason, "Superseded");
  assert.equal(archived.revision, 1);
  assert.equal(workspace.goals.length, 0);
  assert.equal(workspace.archivedGoals[0].id, goal.id);
  assert.equal(sessionFocusedGoalId(workspace, "session-a"), null);

  const restored = restoreGoal(workspace, goal.id, {
    expectedRevision: 1,
    now: BASE_TIME + 2000,
  });
  assert.equal(restored.status, "paused");
  assert.equal(restored.revision, 2);
  assert.equal(workspace.goals[0].id, goal.id);
  assert.equal(workspace.archivedGoals.length, 0);
  assert.equal(sessionFocusedGoalId(workspace, "session-a"), null);
});
