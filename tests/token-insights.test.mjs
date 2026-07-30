import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "../plugins/pi.token-insights/main.js"), "utf8");
const manifest = JSON.parse(
  readFileSync(join(here, "../plugins/pi.token-insights/manifest.json"), "utf8"),
);

function summary() {
  return {
    generatedAt: Date.now(),
    scannedFiles: 3,
    sinceMs: null,
    untilMs: null,
    totals: {
      input: 1_000_000,
      output: 500_000,
      cacheRead: 100,
      cacheWrite: 200,
      reasoning: 0,
      total: 1_500_300,
      messages: 8,
      sessions: 2,
      activeDays: 3,
    },
    previousTotals: { total: 1_000_000 },
    models: [
      {
        modelId: "alpha",
        providerId: "local",
        input: 1_000_000,
        output: 500_000,
        cacheRead: 100,
        cacheWrite: 200,
        reasoning: 0,
        total: 1_500_300,
        messages: 8,
        sessions: 2,
      },
    ],
    projects: [{ name: "desktop", path: "/work/desktop", total: 1_500_300, sessions: 2 }],
    topSessions: [{ id: "s1", title: "Implement dashboard", total: 1_500_300, messages: 8 }],
    daily: [
      { date: "2026-07-02", total: 1_000_000, messages: 4 },
      { date: "2026-07-01", total: 500_300, messages: 4 },
    ],
    hourly: Array.from({ length: 24 }, (_, hour) => ({ total: hour === 15 ? 500 : 0 })),
    weekday: Array.from({ length: 7 }, () => ({ total: 0, messages: 0 })),
    streak: { current: 4, longest: 8 },
  };
}

function loadPlugin(overrides = {}) {
  const calls = { registered: [], unregistered: [], ranges: [] };
  const pi = {
    plugin: {
      getSettings: async () => ({
        currency: "USD",
        prices: { alpha: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 3 } },
        ...overrides.settings,
      }),
    },
    usage: {
      summary: async (range) => {
        calls.ranges.push(range);
        return overrides.summary ?? summary();
      },
    },
    commands: {
      register: async (command) => calls.registered.push({ type: "command", value: command }),
      unregister: async (id) => calls.unregistered.push({ type: "command", value: id }),
    },
    agent: {
      registerTool: async (tool) => calls.registered.push({ type: "tool", value: tool }),
      unregisterTool: async (name) => calls.unregistered.push({ type: "tool", value: name }),
    },
    ui: { openPanel: async () => undefined },
  };
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, pi, Date, Intl, Map, Math, Number, Object, String, Array, RegExp }, { filename: "main.js" });
  return { calls, plugin: module.exports };
}

test("manifest requests only the dashboard, usage, and agent-tool permissions", () => {
  assert.deepEqual(manifest.permissions, ["ui.panel", "usage.read", "agent.tool.register"]);
  assert.equal(manifest.engines.piDesktop, ">=0.2.9");
  assert.equal(manifest.ui.panel, "renderer/index.html");
});

test("loads the command and agent tool, then removes both on unload", async () => {
  const { calls, plugin } = loadPlugin();
  await plugin.onLoad();

  assert.equal(calls.registered.length, 2);
  assert.equal(calls.registered[0].value.id, "tokenInsights.open");
  assert.equal(calls.registered[1].value.name, "token_usage_summary");

  await plugin.onUnload();
  assert.deepEqual(calls.unregistered, [
    { type: "command", value: "tokenInsights.open" },
    { type: "tool", value: "token_usage_summary" },
  ]);
});

test("returns a local-time range, cost estimate, and selected ranking", async () => {
  const { calls, plugin } = loadPlugin();
  await plugin.onLoad();
  const tool = calls.registered.find((item) => item.type === "tool").value;
  const report = await tool.execute({ since: "2026-07-01", until: "2026-07-03", groupBy: "day", limit: 1 });

  assert.equal(calls.ranges.length, 1);
  assert.equal(calls.ranges[0].sinceMs, new Date(2026, 6, 1).getTime());
  assert.equal(calls.ranges[0].untilMs, new Date(2026, 6, 3).getTime());
  assert.equal(calls.ranges[0].tzOffsetMinutes, -new Date().getTimezoneOffset());
  assert.equal(report.groupBy, "day");
  assert.equal(report.ranking.length, 1);
  assert.equal(report.ranking[0].key, "2026-07-02");
  assert.equal(report.cost.total, 7);
  assert.match(report.text, /Estimated cost: \$7\.00/);
  assert.match(report.text, /Token usage/);
});

test("rejects invalid and inverted time windows before reading usage", async () => {
  const { calls, plugin } = loadPlugin();
  await plugin.onLoad();
  const tool = calls.registered.find((item) => item.type === "tool").value;

  await assert.rejects(() => tool.execute({ since: "not-a-date" }), /Invalid since value/);
  await assert.rejects(
    () => tool.execute({ since: "2026-07-03", until: "2026-07-01" }),
    /must be earlier/,
  );
  assert.equal(calls.ranges.length, 0);
});
