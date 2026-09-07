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
const panelCss = readFileSync(join(here, "../plugins/pi.token-insights/renderer/panel.css"), "utf8");
const panelPolishCss = readFileSync(
  join(here, "../plugins/pi.token-insights/renderer/panel-polish.css"),
  "utf8",
);

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
  assert.equal(manifest.version, "0.4.8");
  assert.deepEqual(manifest.permissions, ["ui.panel", "agent.tool.register"]);
  assert.equal(manifest.engines.piDesktop, ">=0.2.9");
  assert.deepEqual(
    manifest.contributes.agentTools[0].schema.properties.groupBy.enum,
    ["model", "provider", "source", "day", "session"],
  );
  assert.doesNotMatch(JSON.stringify(manifest), /usage\.read|project rankings|price table/i);
  assert.match(panelSource, /function compact\(value\)/);
  assert.match(panelSource, /sourcesTitle: "Tools"/);
  assert.match(panelSource, /sourcesTitle: "工具"/);
  assert.match(panelSource, /function applyAppearance\(reveal\)/);
  assert.match(panelSource, /STRINGS\[resolved\.locale\] \|\| STRINGS\.en/);
  assert.match(panelSource, /tileReasoning/);
  assert.match(panelSource, /state\.locale === "zh" \? "zh-CN" : "en-US"/);
  assert.match(panelCss, /:root\[data-theme="dark"\]/);
  assert.match(panelCss, /:root\[data-theme="light"\]/);
});

test("the titlebar reserves the host window-control capsule's corner", () => {
  // The reserve is declared once and consumed everywhere that reaches the
  // top-right corner, so the capsule can never cover the panel's own buttons.
  assert.match(panelCss, /--capsule-reserve:\s*104px;/);
  assert.match(panelCss, /\.titlebar \{[\s\S]*?padding: 0 var\(--capsule-reserve\) 0 12px;[\s\S]*?\}/);

  // An absolute offset resolves against the padding box, so the menu has to
  // apply the reserve itself to stay under the buttons that open it.
  assert.match(panelCss, /\.menu \{[\s\S]*?right: var\(--capsule-reserve\);[\s\S]*?\}/);
  assert.match(panelCss, /width: min\(300px, calc\(100vw - 12px - var\(--capsule-reserve\)\)\);/);

  // The narrow-width gutter override tightens the left side only: a two-value
  // padding-inline here would otherwise reset the right side back to 12px.
  assert.match(panelPolishCss, /\.titlebar \{ padding-inline: 12px var\(--capsule-reserve\); \}/);
  assert.doesNotMatch(panelPolishCss, /\.titlebar \{ padding-inline: 12px; \}/);

  // A long localized title truncates instead of running under the reserve.
  assert.match(panelCss, /\.titlebar-title \{[\s\S]*?text-overflow: ellipsis;[\s\S]*?\}/);
});

test("Windows keeps the scrollbar gutter inside the content scroller", () => {
  // Classic Windows scrollbars turn a root-level stable gutter into a visible
  // second right-hand rail. Only the page's scroll container needs the
  // reservation, so the panel surface reaches the window edge.
  assert.doesNotMatch(
    panelPolishCss,
    /html\s*,\s*body\s*\{[^}]*scrollbar-gutter\s*:/,
  );
  assert.match(
    panelPolishCss,
    /\.scroll\s*\{\s*scrollbar-gutter\s*:\s*stable\s*;/,
  );
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

    const result = await plugin.__test.scanPiTranscriptDirectory(fixture.sessions);
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

test("completed-turn remainder fills subagent tokens missing from transcripts", () => {
  const noon = new Date(2026, 6, 30, 12).getTime();
  const jsonl = {
    events: [
      {
        sourceId: "pi-desktop",
        sessionId: "pi-desktop:abc",
        timestamp: noon,
        modelId: "alpha",
        providerId: "local",
        tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 15 },
      },
    ],
    diagnostics: { sourceId: "pi-desktop", filesScanned: 1, filesSkipped: 0, malformedLines: 0, usageMessages: 1 },
  };
  const merged = plugin.__test.mergePiDesktopTurnRemainder(jsonl, [
    {
      sourceId: "pi-desktop",
      sessionId: "pi-desktop:abc",
      timestamp: noon,
      modelId: "alpha",
      providerId: "local",
      tokens: { input: 20, output: 15, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 35 },
    },
  ]);
  assert.equal(merged.events.length, 2);
  assert.equal(merged.events[1].modelId, "Subagent");
  assert.deepEqual(merged.events[1].tokens, {
    input: 10,
    output: 10,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    total: 20,
  });
});

test("completed-turn remainder does not double-count matching transcripts", () => {
  const noon = new Date(2026, 6, 30, 12).getTime();
  const event = {
    sourceId: "pi-desktop",
    sessionId: "pi-desktop:abc",
    timestamp: noon,
    modelId: "alpha",
    providerId: "local",
    tokens: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, reasoning: 0, total: 18 },
  };
  const merged = plugin.__test.mergePiDesktopTurnRemainder(
    { events: [event], diagnostics: { usageMessages: 1 } },
    [event],
  );
  assert.equal(merged.events.length, 1);
  assert.equal(merged.events[0].modelId, "alpha");
});

test("completed-turn rows fill a session-day with no transcript", () => {
  const noon = new Date(2026, 6, 30, 12).getTime();
  const turn = {
    sourceId: "pi-desktop",
    sessionId: "pi-desktop:abc",
    timestamp: noon,
    modelId: "alpha",
    providerId: "local",
    tokens: { input: 8, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 10 },
  };
  const merged = plugin.__test.mergePiDesktopTurnRemainder(
    { events: [], diagnostics: { usageMessages: 0 } },
    [turn],
  );
  assert.equal(merged.events.length, 1);
  assert.equal(merged.events[0].modelId, "alpha");
  assert.equal(merged.events[0].tokens.total, 10);
});

test("readCompletedTurnUsage maps turn rows without message text", () => {
  let sqlite;
  try {
    sqlite = require("node:sqlite");
  } catch {
    return;
  }
  if (!sqlite?.DatabaseSync) return;
  const fixture = createFixture();
  try {
    const db = new sqlite.DatabaseSync(join(fixture.root, "pi.sqlite"));
    db.exec(`CREATE TABLE turns (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      status TEXT,
      provider_id TEXT,
      model_id TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      usage_json TEXT,
      started_at INTEGER,
      ended_at INTEGER
    )`);
    const endedAt = new Date(2026, 6, 30, 12).getTime();
    db.prepare(
      `INSERT INTO turns (id, session_id, status, provider_id, model_id, input_tokens, output_tokens, usage_json, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "t1",
      "sess-uuid",
      "completed",
      "local",
      "alpha",
      10,
      5,
      JSON.stringify({
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 2,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: 17,
      }),
      endedAt - 1,
      endedAt,
    );
    db.close();
    const result = plugin.__test.readCompletedTurnUsage(fixture.root);
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].sessionId, "pi-desktop:sess-uuid");
    assert.deepEqual(result.events[0].tokens, {
      input: 10,
      output: 5,
      cacheRead: 2,
      cacheWrite: 0,
      reasoning: 0,
      total: 17,
    });
    assert.doesNotMatch(JSON.stringify(result), /secret|message text|tool arguments/i);
  } finally {
    fixture.cleanup();
  }
});

test("adapters normalize Claude Code, Codex, and OpenCode without cumulative Codex double-counting", async () => {
  const fixture = createFixture();
  const claude = join(fixture.root, "claude-projects", "project-a");
  const codex = join(fixture.root, "codex-sessions", "2026", "07", "31");
  const opencode = join(fixture.root, "opencode-message", "open-session");
  try {
    mkdirSync(claude, { recursive: true });
    mkdirSync(codex, { recursive: true });
    mkdirSync(opencode, { recursive: true });
    writeJsonl(claude, "claude-session.jsonl", [
      {
        type: "assistant",
        sessionId: "claude-private-id",
        timestamp: "2026-07-30T08:00:00.000Z",
        message: {
          model: "claude-sonnet",
          usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 },
        },
      },
      { type: "user", timestamp: "2026-07-30T08:01:00.000Z", message: { content: "not usage" } },
    ]);
    writeJsonl(codex, "rollout-private-id.jsonl", [
      { type: "session_meta", payload: { id: "codex-private-id", model_provider: "openai" } },
      { type: "turn_context", payload: { model: "gpt-5" } },
      { type: "event_msg", timestamp: "2026-07-30T09:00:00.000Z", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 }, total_token_usage: { total_tokens: 10 } } } },
      { type: "event_msg", timestamp: "2026-07-30T09:01:00.000Z", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 }, total_token_usage: { total_tokens: 20 } } } },
    ]);
    writeFileSync(join(opencode, "msg-private-id.json"), JSON.stringify({
      role: "assistant",
      sessionID: "opencode-private-id",
      modelID: "qwen",
      providerID: "openrouter",
      time: { completed: "2026-07-30T10:00:00.000Z" },
      tokens: { input: 3, output: 2, reasoning: 1, cache: { read: 4, write: 2 } },
      content: "not retained",
    }));

    const [claudeResult, codexResult, openCodeResult] = await Promise.all([
      plugin.__test.scanClaudeCodeDirectory(dirname(claude)),
      plugin.__test.scanCodexDirectory(join(fixture.root, "codex-sessions")),
      plugin.__test.scanOpenCodeDirectory(join(fixture.root, "opencode-message")),
    ]);
    const events = [...claudeResult.events, ...codexResult.events, ...openCodeResult.events];
    assert.equal(events.reduce((sum, item) => sum + item.tokens.total, 0), 49);
    assert.equal(codexResult.events.reduce((sum, item) => sum + item.tokens.total, 0), 20);
    assert.equal(claudeResult.events[0].sourceId, "claude-code");
    assert.equal(openCodeResult.events[0].sourceId, "opencode");
    const facts = plugin.__test.buildFacts(events, { generatedAt: Date.now() });
    const summary = plugin.__test.aggregate(facts, {});
    assert.equal(summary.totals.total, 49);
    assert.doesNotMatch(JSON.stringify(summary), /private-id|not retained|content/i);
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
      sourceId: "pi-desktop",
      sessionId: "1234567890abcdef",
      timestamp: today.getTime(),
      modelId: "alpha",
      providerId: "openai",
      tokens: { input: 10, output: 5, cacheRead: 3, cacheWrite: 2, reasoning: 1, total: 21 },
    },
    {
      sourceId: "claude-code",
      sessionId: "1234567890abcdef",
      timestamp: yesterday.getTime(),
      modelId: "beta",
      providerId: "anthropic",
      tokens: { input: 4, output: 6, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 10 },
    },
  ];
  const facts = plugin.__test.buildFacts(events, {
    generatedAt: Date.now(),
    diagnostics: { filesScanned: 2, malformedLines: 1, usageMessages: 2 },
  });
  const summary = plugin.__test.aggregate(facts, {}, { now: Date.now() });

  assert.equal(summary.totals.total, 31);
  assert.equal(summary.totals.sessions, 2);
  assert.equal(summary.totals.activeDays, 2);
  assert.equal(summary.models.length, 2);
  assert.equal(summary.providers.length, 2);
  assert.equal(summary.sources.length, 2);
  assert.equal(summary.sessions[0].label, "12345678");
  assert.equal(summary.hourly[9].total, 31);
  assert.equal(summary.weekday.reduce((sum, slot) => sum + slot.total, 0), 31);
  assert.equal(summary.streak.current, 2);
  assert.equal(summary.streak.longest, 2);
  assert.equal(facts.diagnostics.filesScanned, 2);
  assert.equal(facts.diagnostics.malformedLines, 1);
});

test("on-load writes a snapshot before opening the panel and the tool groups by provider", async () => {
  const fixture = createFixture();
  const calls = { registered: [], unregistered: [], timeline: [], facts: [] };
  const previousPi = globalThis.pi;
  try {
    mkdirSync(fixture.dataPath, { recursive: true });
    plugin.__test.setScanRoots({
      piDesktop: fixture.sessions,
      claudeCode: join(fixture.root, "missing-claude"),
      codex: join(fixture.root, "missing-codex"),
      openCode: join(fixture.root, "missing-opencode"),
    });
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
          if (value.usageFacts) calls.facts.push(value.usageFacts);
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

    // The appearance publish is fingerprint-deduped (onLoad already published
    // the same appearance), so the command itself only opens the panel;
    // refreshFacts' initial scanState write lands synchronously right behind it.
    assert.deepEqual(calls.timeline, ["panel", "settings"]);
    assert.equal(plugin.__test.aggregate(calls.facts.at(-1), {}).totals.total, 15);
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
    // Always unload, even when an assertion above threw: the appearance/source
    // watchers keep interval timers alive and would fire after the test with
    // globalThis.pi already restored, producing unhandled rejections.
    await plugin.onUnload().catch(() => undefined);
    plugin.__test.setScanRoots(null);
    globalThis.pi = previousPi;
    fixture.cleanup();
  }
});
