import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const root = join(here, "..");
const pluginRoot = join(root, "plugins", "pi.session-orchestrator");
const manifest = JSON.parse(readFileSync(join(pluginRoot, "manifest.json"), "utf8"));
const panel = readFileSync(join(pluginRoot, manifest.ui.panel), "utf8");
const panelSource = readFileSync(join(pluginRoot, "renderer/panel.js"), "utf8");
const mainSource = readFileSync(join(pluginRoot, "main.js"), "utf8");
const actionsSource = readFileSync(join(pluginRoot, "actions.js"), "utf8");
const runtimeSource = readFileSync(join(pluginRoot, "runtime.js"), "utf8");

test("manifest declares the durable worker tool, panel and bounded permissions", () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.id, "pi.session-orchestrator");
  assert.equal(manifest.version, "0.1.0");
  assert.equal(manifest.main, "main.js");
  assert.deepEqual(manifest.permissions, [
    "ui.panel",
    "agent.tool.register",
    "desktop.control",
    "models.list",
  ]);
  assert.deepEqual(
    manifest.contributes.agentTools.map((tool) => tool.name),
    ["SessionTask"],
  );
  assert.equal(manifest.contributes.agentTools[0].risk, "high");
  assert.deepEqual(
    manifest.contributes.agentTools[0].schema.properties.action.enum,
    ["spawn", "send", "status", "wait", "result", "cancel", "list"],
  );
  assert.equal(manifest.ui.panel, "renderer/index.html");
  assert.ok(manifest.i18n.en.safetyNotes);
  assert.ok(manifest.i18n["zh-CN"].safetyNotes);
  assert.match(manifest.engines.piDesktop, /^>=0\.14\.7/);
  assert.match(manifest.safetyNotes, /desktop\.control/);
});

test("panel uses the host-owned v3 chrome and only the plugin bridge", () => {
  assert.match(panel, /<meta\s+name="pi-plugin-chrome"\s+content="v3"\s*\/>/);
  assert.match(panel, /PI-Desktop owns exactly a transparent 46px drag band/);
  assert.match(panel, /three-button[\s\S]*window-control capsule/);
  assert.match(panel, /var\(--pi-plugin-titlebar-height, 46px\)/);
  assert.match(panel, /appearance-boot\.js/);
  assert.match(panel, /appearance\.js/);
  assert.match(panel, /capsule-retint\.js/);
  assert.match(panelSource, /pluginBridge/);
  assert.doesNotMatch(panel, /https?:\/\//i);
});

test("source stays on the reviewed desktop gateway and never creates a second session system", () => {
  const source = [mainSource, actionsSource, runtimeSource].join("\n");
  assert.match(source, /session\/create/);
  assert.match(source, /agent\/prompt/);
  assert.match(source, /agent\/getStatus/);
  assert.match(source, /agent\/abort/);
  assert.match(source, /session\/get/);
  assert.doesNotMatch(source, /session\/fork/);
  assert.doesNotMatch(source, /session\/delete/);
  assert.doesNotMatch(source, /localhost|127\.0\.0\.1|MCP bearer|mcp token/i);
  assert.doesNotMatch(source, /child_process|node:net|fetch\s*\(/);
  assert.match(source, /inheritPermissionFromSessionId/);
  assert.match(source, /MAX_WORKERS_PER_PARENT/);
  assert.match(source, /WAIT_TIMEOUT_MS/);
  assert.match(source, /Worker sessions cannot create or control other workers/);
});

test("refuses to load when relationship settings cannot be read", async (t) => {
  const previousPi = globalThis.pi;
  const harness = makeHarness();
  let writes = 0;
  harness.pi.plugin.getSettings = async () => {
    throw new Error("settings unavailable");
  };
  harness.pi.plugin.setSettings = async () => {
    writes += 1;
  };
  globalThis.pi = harness.pi;
  clearPluginCache();
  const activeMain = require(join(pluginRoot, "main.js"));
  t.after(async () => {
    await activeMain.onUnload();
    clearPluginCache();
    if (previousPi === undefined) delete globalThis.pi;
    else globalThis.pi = previousPi;
  });

  await assert.rejects(activeMain.onLoad(), /settings unavailable/);
  assert.equal(harness.registered.tool, null);
  assert.equal(writes, 0);
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function clearPluginCache() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(pluginRoot)) delete require.cache[key];
  }
}

function makeHarness({ inheritPermission = true } = {}) {
  const settings = { workers: [] };
  const calls = [];
  const sessions = new Map([
    [
      "parent",
      {
        id: "parent",
        projectPath: "/repo",
        providerId: "anthropic",
        modelId: "claude",
        thinkingLevel: "high",
        permissionMode: "accept-edits",
        messages: [],
      },
    ],
  ]);
  const running = new Map();
  let nextWorker = 0;
  let nextTurn = 0;
  let promptInFlight = 0;
  let maxPromptInFlight = 0;
  const registered = { command: null, tool: null };

  const pi = {
    plugin: {
      getSettings: async () => clone(settings),
      setSettings: async (partial) => {
        Object.assign(settings, clone(partial));
      },
    },
    commands: {
      register: async (command) => {
        registered.command = command;
      },
      unregister: async () => {
        registered.command = null;
      },
    },
    agent: {
      registerTool: async (tool) => {
        registered.tool = tool;
      },
      unregisterTool: async () => {
        registered.tool = null;
      },
    },
    models: {
      list: async () => [
        {
          key: "anthropic/claude",
          providerId: "anthropic",
          modelId: "claude",
          providerName: "Anthropic",
          label: "Claude",
          supportsReasoning: true,
          thinkingLevels: ["low", "medium", "high"],
        },
        {
          key: "openai/gpt",
          providerId: "openai",
          modelId: "gpt",
          providerName: "OpenAI",
          label: "GPT",
          supportsReasoning: true,
          thinkingLevels: ["low", "high"],
        },
      ],
    },
    ui: {
      openPanel: async () => undefined,
      showToast: async () => undefined,
    },
    desktop: {
      listOperations: async () => [
        { id: "session/get", risk: "read" },
        { id: "session/create", risk: "write" },
        { id: "agent/prompt", risk: "write" },
        { id: "agent/getStatus", risk: "read" },
        { id: "agent/abort", risk: "write" },
        { id: "session/open", risk: "write" },
      ],
      invoke: async ({ operation, args }) => {
        calls.push({ operation, args: clone(args) });
        if (operation === "session/get") {
          const request = args[0];
          const session = sessions.get(request.id);
          if (!session) {
            throw Object.assign(new Error("not found"), { code: "NOT_FOUND" });
          }
          return { session: clone(session) };
        }
        if (operation === "session/create") {
          await delay(5);
          const input = args[0];
          const id = "worker-" + (++nextWorker);
          const parent = sessions.get(input.inheritPermissionFromSessionId);
          const session = {
            id,
            title: input.title,
            projectPath: input.projectPath,
            providerId: input.providerId,
            modelId: input.modelId,
            thinkingLevel: input.thinkingLevel,
            permissionMode: inheritPermission
              ? parent.permissionMode
              : "inherit",
            messages: [],
          };
          sessions.set(id, session);
          running.set(id, { isRunning: false, prompt: null });
          return { session: clone(session) };
        }
        if (operation === "agent/prompt") {
          const request = args[0];
          const state = running.get(request.sessionId);
          if (!state) throw Object.assign(new Error("not found"), { code: "NOT_FOUND" });
          promptInFlight += 1;
          maxPromptInFlight = Math.max(maxPromptInFlight, promptInFlight);
          state.isRunning = true;
          state.prompt = request.content;
          await delay(5);
          promptInFlight -= 1;
          return { accepted: true, turnId: "turn-" + (++nextTurn) };
        }
        if (operation === "agent/getStatus") {
          const state = running.get(args[0]);
          return {
            status: {
              sessionId: args[0],
              isRunning: Boolean(state?.isRunning),
              pendingToolConfirmations: 0,
            },
          };
        }
        if (operation === "agent/abort") {
          const state = running.get(args[0].sessionId);
          if (state) state.isRunning = false;
          return { ok: true };
        }
        if (operation === "session/open") return { ok: true };
        throw new Error("unexpected operation: " + operation);
      },
    },
  };

  return {
    pi,
    settings,
    calls,
    sessions,
    registered,
    complete(workerId, report) {
      const state = running.get(workerId);
      assert.ok(state, "worker must exist before completion");
      state.isRunning = false;
      sessions.get(workerId).messages.push({
        role: "assistant",
        content: report,
        createdAt: new Date().toISOString(),
        status: "complete",
      });
    },
    get maxPromptInFlight() {
      return maxPromptInFlight;
    },
  };
}

test("spawns real workers in parallel, persists relationships, polls reports and preserves sessions", async (t) => {
  const previousPi = globalThis.pi;
  const harness = makeHarness();
  globalThis.pi = harness.pi;
  clearPluginCache();
  let activeMain = require(join(pluginRoot, "main.js"));
  t.after(async () => {
    if (activeMain) await activeMain.onUnload();
    clearPluginCache();
    if (previousPi === undefined) delete globalThis.pi;
    else globalThis.pi = previousPi;
  });

  await activeMain.onLoad();
  assert.equal(harness.registered.tool.name, "SessionTask");
  assert.equal(harness.registered.command.id, "pi.session-orchestrator.open");

  const ctx = { sessionId: "parent", modelKey: "anthropic/claude", thinkingLevel: "high" };
  const spawned = await Promise.all([
    harness.registered.tool.execute({ action: "spawn", task: "Review Frontend", title: "Frontend Review" }, ctx),
    harness.registered.tool.execute({ action: "spawn", task: "Review Electron", title: "Electron Review" }, ctx),
    harness.registered.tool.execute({ action: "spawn", task: "Review Rust", title: "Rust Review" }, ctx),
  ]);
  const workerIds = spawned.map((entry) => entry.workerId);
  assert.equal(new Set(workerIds).size, 3);
  assert.ok(harness.maxPromptInFlight >= 2, "spawned prompts must overlap");

  const creates = harness.calls.filter((call) => call.operation === "session/create");
  assert.equal(creates.length, 3);
  for (const call of creates) {
    const input = call.args[0];
    assert.equal(input.mode, "agent");
    assert.equal(input.projectPath, "/repo");
    assert.equal(input.providerId, "anthropic");
    assert.equal(input.modelId, "claude");
    assert.equal(input.thinkingLevel, "high");
    assert.equal(input.inheritPermissionFromSessionId, "parent");
    assert.equal("messages" in input, false, "parent transcript must not be copied");
  }

  for (const [index, workerId] of workerIds.entries()) {
    harness.complete(workerId, "Final report " + (index + 1));
  }
  const waited = await harness.registered.tool.execute({ action: "wait", workerIds }, ctx);
  assert.equal(waited.timedOut, false);
  assert.deepEqual(
    waited.workers.map((worker) => worker.report),
    ["Final report 1", "Final report 2", "Final report 3"],
  );
  assert.equal("messages" in waited.workers[0], false, "wait returns reports, not transcripts");

  const result = await harness.registered.tool.execute({ action: "result", workerId: workerIds[0] }, ctx);
  assert.equal(result.ready, true);
  assert.equal(result.worker.report, "Final report 1");
  assert.equal("messages" in result.worker, false);

  await harness.registered.tool.execute(
    { action: "send", workerId: workerIds[0], message: "Add one verification detail." },
    ctx,
  );
  assert.equal(
    harness.calls.filter((call) => call.operation === "session/create").length,
    3,
    "send must not create a new session",
  );
  harness.complete(workerIds[0], "Follow-up report");
  const followUp = await harness.registered.tool.execute(
    { action: "wait", workerIds: [workerIds[0]] },
    ctx,
  );
  assert.equal(followUp.workers[0].report, "Follow-up report");

  const cancelledSpawn = await harness.registered.tool.execute(
    { action: "spawn", task: "Long review", title: "Long Review" },
    ctx,
  );
  const cancelled = await harness.registered.tool.execute(
    { action: "cancel", workerId: cancelledSpawn.workerId },
    ctx,
  );
  assert.equal(cancelled.sessionRetained, true);
  assert.equal(cancelled.worker.status, "cancelled");
  assert.ok(harness.sessions.has(cancelledSpawn.workerId));
  assert.equal(harness.calls.some((call) => call.operation === "session/delete"), false);

  const otherParent = await harness.registered.tool.execute({ action: "list" }, { sessionId: "other" });
  assert.deepEqual(otherParent.workers, []);
  await assert.rejects(
    harness.registered.tool.execute(
      { action: "status", workerIds: [workerIds[0]] },
      { sessionId: "other" },
    ),
    (error) => error.code === "NOT_FOUND",
  );
  await assert.rejects(
    harness.registered.tool.execute(
      { action: "list" },
      { sessionId: workerIds[0] },
    ),
    (error) => error.code === "PERMISSION_DENIED",
  );

  await activeMain.onPanelInvoke("workers.open", { workerId: workerIds[0] });
  assert.equal(harness.calls.at(-1).operation, "session/open");

  await activeMain.onUnload();
  activeMain = null;
  clearPluginCache();
  const restarted = require(join(pluginRoot, "main.js"));
  activeMain = restarted;
  await restarted.onLoad();
  const restored = await harness.registered.tool.execute(
    { action: "list" },
    { sessionId: "parent" },
  );
  assert.equal(restored.workers.length, 4);
  assert.equal(restored.workers.some((worker) => worker.workerId === workerIds[0]), true);
  await restarted.onUnload();
  activeMain = null;
});

test("fails closed before prompting when the host cannot preserve explicit permissions", async (t) => {
  const previousPi = globalThis.pi;
  const harness = makeHarness({ inheritPermission: false });
  globalThis.pi = harness.pi;
  clearPluginCache();
  let activeMain = require(join(pluginRoot, "main.js"));
  t.after(async () => {
    if (activeMain) await activeMain.onUnload();
    clearPluginCache();
    if (previousPi === undefined) delete globalThis.pi;
    else globalThis.pi = previousPi;
  });

  await activeMain.onLoad();
  await assert.rejects(
    harness.registered.tool.execute(
      { action: "spawn", task: "must not start" },
      { sessionId: "parent" },
    ),
    (error) => error.code === "PERMISSION_DENIED",
  );
  assert.equal(harness.calls.filter((call) => call.operation === "agent/prompt").length, 0);
  assert.equal(harness.settings.workers[0].status, "failed");
});

test("wait observes AbortSignal cancellation", async (t) => {
  const previousPi = globalThis.pi;
  const harness = makeHarness();
  globalThis.pi = harness.pi;
  clearPluginCache();
  let activeMain = require(join(pluginRoot, "main.js"));
  t.after(async () => {
    if (activeMain) await activeMain.onUnload();
    clearPluginCache();
    if (previousPi === undefined) delete globalThis.pi;
    else globalThis.pi = previousPi;
  });

  await activeMain.onLoad();
  const tool = harness.registered.tool;
  const spawned = await tool.execute(
    { action: "spawn", task: "wait forever" },
    { sessionId: "parent" },
  );
  const controller = new AbortController();
  const waiting = tool.execute(
    { action: "wait", workerIds: [spawned.workerId] },
    { sessionId: "parent", signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(waiting, (error) => error.code === "ABORTED");
});
