import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const main = require("../plugins/pi.goal-x/main.js");

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makePi() {
  const settings = {
    auditorEnabled: false,
    auditorModelKey: "",
    auditorEffort: "high",
    defaultBlockCompletion: true,
  };
  const calls = {
    registeredCommands: [],
    unregisteredCommands: [],
    registeredTools: [],
    unregisteredTools: [],
    eventOn: [],
    eventOff: [],
    openedPanels: 0,
    settingsWrites: [],
    llmMessages: [{ role: "user", content: "Start the agent task." }],
  };
  const pi = {
    workspace: {
      get: async () => ({ path: "/workspace/alpha", name: "Alpha" }),
    },
    plugin: {
      getSettings: async () => jsonClone(settings),
      setSettings: async (patch) => {
        calls.settingsWrites.push(jsonClone(patch));
        Object.assign(settings, jsonClone(patch));
      },
    },
    commands: {
      register: async (command) => calls.registeredCommands.push(command),
      unregister: async (id) => calls.unregisteredCommands.push(id),
    },
    agent: {
      registerTool: async (tool) => calls.registeredTools.push(tool),
      unregisterTool: async (name) => calls.unregisteredTools.push(name),
      complete: async () => {
        throw new Error("auditor should be disabled in this test");
      },
    },
    events: {
      on: (name, handler) => calls.eventOn.push({ name, handler }),
      off: (name, handler) => calls.eventOff.push({ name, handler }),
    },
    ui: {
      openPanel: async () => {
        calls.openedPanels += 1;
      },
      showToast: async () => undefined,
    },
    models: {
      list: async () => [{ key: "provider/model", name: "Model" }],
    },
    session: {
      getLlmContext: async () => ({
        sessionId: "session-agent",
        modelKey: "provider/model",
        messages: jsonClone(calls.llmMessages),
        truncated: false,
      }),
    },
  };
  return { pi, calls, settings };
}

test("onLoad/onUnload registrations match and the panel bridge persists a complete goal lifecycle", async () => {
  const previousPi = globalThis.pi;
  const { pi, calls, settings } = makePi();
  let loaded = false;
  globalThis.pi = pi;

  try {
    await main.onLoad();
    loaded = true;

    const expectedCommandIds = main.__test.COMMAND_DEFINITIONS.map((command) => command.id);
    const expectedToolNames = main.__test.TOOL_DEFINITIONS.map((tool) => tool.name);
    assert.deepEqual(calls.registeredCommands.map((command) => command.id), expectedCommandIds);
    assert.deepEqual(calls.registeredTools.map((tool) => tool.name), expectedToolNames);
    assert.equal(new Set(expectedCommandIds).size, expectedCommandIds.length);
    assert.equal(new Set(expectedToolNames).size, expectedToolNames.length);
    assert.equal(calls.eventOn.length, 1);
    assert.equal(calls.eventOn[0].name, "plugin:settingsChanged");
    assert.equal(typeof calls.eventOn[0].handler, "function");

    const sisyphusCommand = calls.registeredCommands.find((command) => command.id === "sisyphus-direct");
    await sisyphusCommand.run();
    assert.equal(calls.openedPanels, 1);
    const initialPanelState = await main.onPanelInvoke("goal.state");
    assert.equal(initialPanelState.pendingCreateMode, "sisyphus");
    assert.equal(initialPanelState.workspace.goals.length, 0);
    assert.equal((await main.onPanelInvoke("goal.state")).pendingCreateMode, null);

    const created = await main.onPanelInvoke("goal.create", {
      objective: "Ship the migrated plugin",
      verificationContract: "Node tests pass",
    });
    assert.equal(created.ok, true);
    assert.equal(created.goal.status, "active");
    assert.equal(created.goal.blockCompletion, true);
    assert.equal(created.goal.revision, 0);
    assert.ok(settings.goalXState);

    const savedPreferences = await main.onPanelInvoke("goal.settings.set", {
      auditorEnabled: false,
      auditorModelKey: "provider/model",
      auditorEffort: "low",
      defaultBlockCompletion: true,
    });
    assert.equal(savedPreferences.settings.auditorEffort, "low");
    assert.equal(savedPreferences.settings.goalXState, undefined);
    assert.equal((await main.onPanelInvoke("goal.state")).workspace.goals[0].id, created.goal.id);

    const planned = await main.onPanelInvoke("goal.setTasks", {
      goalId: created.goal.id,
      expectedRevision: created.goal.revision,
      blockCompletion: true,
      tasks: [{
        id: "tests",
        title: "Run tests",
        verification_contract: "Attach passing test output",
      }],
    });
    assert.equal(planned.goal.revision, 1);
    assert.equal(planned.goal.stats.pending, 1);

    await assert.rejects(
      () => main.onPanelInvoke("goal.updateTask", {
        goalId: created.goal.id,
        expectedRevision: planned.goal.revision,
        taskId: "tests",
        status: "complete",
      }),
      (error) => error?.code === "EVIDENCE_REQUIRED",
    );
    const afterFailedUpdate = await main.onPanelInvoke("goal.state");
    assert.equal(afterFailedUpdate.workspace.goals[0].revision, planned.goal.revision);
    assert.equal(afterFailedUpdate.workspace.goals[0].stats.pending, 1);

    const progressed = await main.onPanelInvoke("goal.updateTask", {
      goalId: created.goal.id,
      expectedRevision: planned.goal.revision,
      taskId: "tests",
      status: "complete",
      evidence: "node --test: all tests passed",
    });
    assert.equal(progressed.goal.revision, 2);
    assert.equal(progressed.goal.stats.complete, 1);
    assert.equal(progressed.goal.tasks[0].evidence, "node --test: all tests passed");

    await assert.rejects(
      () => main.onPanelInvoke("goal.complete", {
        goalId: created.goal.id,
        expectedRevision: progressed.goal.revision,
        completionSummary: "x".repeat(2001),
      }),
      (error) => error?.code === "LIMIT_EXCEEDED",
    );
    const afterOversizedSummary = await main.onPanelInvoke("goal.state");
    assert.equal(afterOversizedSummary.workspace.goals[0].status, "active");
    assert.equal(afterOversizedSummary.workspace.goals[0].revision, progressed.goal.revision);
    assert.equal(afterOversizedSummary.workspace.archivedGoals.length, 0);

    const completed = await main.onPanelInvoke("goal.complete", {
      goalId: created.goal.id,
      expectedRevision: progressed.goal.revision,
      completionSummary: "Migration and verification are complete.",
    });
    assert.equal(completed.ok, true);
    assert.equal(completed.approved, true);
    assert.equal(completed.archived, true);
    assert.equal(completed.audit.skipped, true);
    assert.equal(completed.goal.status, "complete");

    const archivedState = await main.onPanelInvoke("goal.state");
    assert.equal(archivedState.workspace.goals.length, 0);
    assert.equal(archivedState.workspace.archivedGoals.length, 1);
    assert.equal(archivedState.workspace.focusedGoalId, null);

    const restored = await main.onPanelInvoke("goal.restore", {
      goalId: created.goal.id,
      expectedRevision: completed.goal.revision,
    });
    assert.equal(restored.ok, true);
    assert.equal(restored.goal.status, "paused");
    const restoredState = await main.onPanelInvoke("goal.state");
    assert.equal(restoredState.workspace.goals[0].id, created.goal.id);
    assert.equal(restoredState.workspace.archivedGoals.length, 0);
    assert.equal(restoredState.workspace.focusedGoalId, created.goal.id);

    const createTool = calls.registeredTools.find((tool) => tool.name === "create_goal");
    const agentContext = { sessionId: "session-agent", log: () => undefined };
    const toolResult = await createTool.execute({ objective: "Created through an agent tool" }, {
      ...agentContext,
      log: () => undefined,
    });
    assert.equal(toolResult.ok, true);
    assert.equal(toolResult.goal.objective, "Created through an agent tool");

    const getTool = calls.registeredTools.find((tool) => tool.name === "get_goal");
    const focusedToolResult = await getTool.execute({}, agentContext);
    assert.equal(focusedToolResult.goal.id, toolResult.goal.id);
    const unrelatedSession = await getTool.execute({}, { sessionId: "session-other", log: () => undefined });
    assert.equal(unrelatedSession.goal, undefined);
    assert.ok(Array.isArray(unrelatedSession.goals));

    const updateTool = calls.registeredTools.find((tool) => tool.name === "update_goal");
    const mismatchedSession = await updateTool.execute({
      goal_id: toolResult.goal.id,
      status: "blocked",
      reason: "Concurrent session context was selected",
    }, { sessionId: "session-other", log: () => undefined });
    assert.equal(mismatchedSession.ok, false);
    assert.equal(mismatchedSession.code, "TURN_ID_UNAVAILABLE");
    const afterMismatchedSession = await getTool.execute({ goal_id: toolResult.goal.id }, agentContext);
    assert.equal(afterMismatchedSession.goal.revision, toolResult.goal.revision);
    assert.equal(afterMismatchedSession.goal.blocker, null);

    const blockerOne = await updateTool.execute({ status: "blocked", reason: "Registry unavailable" }, agentContext);
    assert.equal(blockerOne.reports, 1);
    calls.llmMessages.push({ role: "assistant", content: "Still investigating." });
    const sameTurn = await updateTool.execute({ status: "blocked", reason: "Registry unavailable" }, agentContext);
    assert.equal(sameTurn.reports, 1);
    calls.llmMessages.push({ role: "user", content: "Try again." });
    const blockerTwo = await updateTool.execute({ status: "blocked", reason: "Registry unavailable" }, agentContext);
    assert.equal(blockerTwo.reports, 2);
    calls.llmMessages.push({ role: "user", content: "One more check." });
    const blockerThree = await updateTool.execute({ status: "blocked", reason: "Registry unavailable" }, agentContext);
    assert.equal(blockerThree.reports, 3);
    assert.equal(blockerThree.goal.status, "blocked");

    await main.onUnload();
    loaded = false;
    assert.deepEqual(calls.unregisteredTools, expectedToolNames);
    assert.deepEqual(calls.unregisteredCommands, expectedCommandIds);
    assert.equal(calls.eventOff.length, 1);
    assert.equal(calls.eventOff[0].name, "plugin:settingsChanged");
    assert.strictEqual(calls.eventOff[0].handler, calls.eventOn[0].handler);
  } finally {
    if (loaded) await main.onUnload().catch(() => undefined);
    globalThis.pi = previousPi;
  }
});
