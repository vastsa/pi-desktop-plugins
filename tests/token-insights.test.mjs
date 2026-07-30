import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const plugin = require("../plugins/pi.token-insights/main.js");
const manifest = JSON.parse(
  readFileSync(join(here, "../plugins/pi.token-insights/manifest.json"), "utf8"),
);
const panelSource = readFileSync(join(here, "../plugins/pi.token-insights/renderer/panel.js"), "utf8");

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "token-insights-"));
  const sessions = join(root, "sessions");
  mkdirSync(sessions, { recursive: true });
  return {
    root,
    sessions,
    dataPath: join(root, "plugins", "data", "pi.token-insights"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function writeJsonl(directory, name, records) {
  writeFileSync(join(directory, name), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

function usageRecord({ createdAt, modelId = "alpha", providerId = "local", usage, content = "private" }) {
  return {
    type: "message",
    role: "assistant",
    createdAt,
    content: [{ type: "text", text: content }],
    meta: { modelId, providerId, usage },
  };
}

function waitForBackgroundScan() {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

test("manifest declares the independent scanner and minimal host permissions", () => {
  assert.equal(manifest.version, "0.2.1");
  assert.deepEqual(manifest.permissions, ["ui.panel", "agent.tool.register"]);
  assert.equal(manifest.engines.piDesktop, ">=0.2.0");
  assert.deepEqual(
    manifest.contributes.agentTools[0].schema.properties.groupBy.enum,
    ["model", "provider", "day", "session"],
  );
  assert.doesNotMatch(JSON.stringify(manifest), /usage\.read|project rankings|price table/i);
  assert.match(panelSource, /const MILLION = 1_000_000;/);
});

test("scanner aggregates usage metadata, excludes revisions, and drops transcript content", async () => {
  const fixture = createFixture();
  try {
    writeJsonl(fixture.sessions, "session-a.jsonl", [
      usageRecord({
        createdAt: "2026-07-30T08:15:00.000Z",
        modelId: "alpha",
        providerId: "openai",
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1, reasoningTokens: 3 },
        content: "do not retain this message",
      }),
      usageRecord({
        createdAt: "2026-07-30T09:15:00.000Z",
        usage: { inputTokens: 7, outputTokens: 0, cacheReadTokens: null, cacheWriteTokens: null },
        content: "do not retain this fallback either",
      }),
      { type: "message", role: "user", createdAt: "2026-07-30T08:16:00.000Z", content: "do not retain this either" },
    ]);
    writeFileSync(join(fixture.sessions, "session-b.jsonl"), "{bad json}\n");
    writeJsonl(fixture.sessions, "session-c.revisions.jsonl", [
      usageRecord({
        createdAt: "2026-07-30T08:30:00.000Z",
        usage: { inputTokens: 999, outputTokens: 999 },
      }),
    ]);

    const result = await plugin.__test.scanTranscriptDirectory(fixture.sessions);
    assert.equal(result.events.length, 2);
    assert.deepEqual(result.events[0].tokens, {
      input: 10,
      output: 5,
      cacheRead: 2,
      cacheWrite: 1,
      reasoning: 3,
      total: 21,
    });
    assert.equal(result.diagnostics.filesScanned, 2);
    assert.equal(result.diagnostics.filesSkipped, 0);
    assert.equal(result.diagnostics.malformedLines, 1);
    assert.deepEqual(result.events[1].tokens, {
      input: 7,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      total: 7,
    });
    assert.equal(result.diagnostics.usageMessages, 2);
    assert.doesNotMatch(JSON.stringify(result), /content|private|message text|tool arguments/i);
  } finally {
    fixture.cleanup();
  }
});

test("summary groups models, providers, sessions, time buckets, and streaks", () => {
  const today = new Date();
  today.setHours(9, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const events = [
    {
      sessionId: "1234567890abcdef",
      timestamp: today.getTime(),
      modelId: "alpha",
      providerId: "openai",
      tokens: { input: 10, output: 5, cacheRead: 3, cacheWrite: 2, reasoning: 1, total: 21 },
    },
    {
      sessionId: "1234567890abcdef",
      timestamp: yesterday.getTime(),
      modelId: "beta",
      providerId: "anthropic",
      tokens: { input: 4, output: 6, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 10 },
    },
  ];
  const summary = plugin.__test.summarize(events, plugin.__test.makeRange(null, null), events, Date.now(), {
    filesScanned: 2,
    malformedLines: 1,
    usageMessages: 2,
  });

  assert.equal(summary.totals.total, 31);
  assert.equal(summary.totals.sessions, 1);
  assert.equal(summary.models.length, 2);
  assert.equal(summary.providers.length, 2);
  assert.equal(summary.topSessions[0].title, "Session 12345678");
  assert.equal(summary.hourly[9].total, 31);
  assert.equal(summary.weekday.reduce((sum, slot) => sum + slot.total, 0), 31);
  assert.deepEqual(summary.streak, { current: 2, longest: 2 });
  assert.equal(summary.scannedFiles, 2);
  assert.equal(summary.malformedLines, 1);
});

test("on-load writes a snapshot before opening the panel and the tool groups by provider", async () => {
  const fixture = createFixture();
  const calls = { registered: [], unregistered: [], timeline: [], snapshots: [] };
  const previousPi = globalThis.pi;
  try {
    mkdirSync(fixture.dataPath, { recursive: true });
    writeJsonl(fixture.sessions, "session-a.jsonl", [
      usageRecord({
        createdAt: "2026-07-30T08:15:00.000Z",
        modelId: "alpha",
        providerId: "openai",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      }),
    ]);
    globalThis.pi = {
      plugin: {
        getDataPath: async () => fixture.dataPath,
        getSettings: async () => ({}),
        setSettings: async (value) => {
          calls.timeline.push("settings");
          calls.snapshots.push(value.usageSnapshot);
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
      ui: {
        openPanel: async () => calls.timeline.push("panel"),
        showToast: () => undefined,
      },
    };

    await plugin.onLoad();
    await waitForBackgroundScan();
    const command = calls.registered.find((item) => item.type === "command").value;
    const tool = calls.registered.find((item) => item.type === "tool").value;
    calls.timeline.length = 0;
    await command.run();

    assert.deepEqual(calls.timeline, ["settings", "panel"]);
    assert.equal(calls.snapshots.at(-1).all.totals.total, 15);
    const report = await tool.execute({ groupBy: "provider", limit: 1 });
    assert.equal(report.groupBy, "provider");
    assert.equal(report.ranking[0].key, "openai");
    assert.doesNotMatch(JSON.stringify(report), /private|content|tool arguments/i);

    await plugin.onUnload();
    assert.deepEqual(calls.unregistered, [
      { type: "command", value: "tokenInsights.open" },
      { type: "tool", value: "token_usage_summary" },
    ]);
  } finally {
    globalThis.pi = previousPi;
    fixture.cleanup();
  }
});
