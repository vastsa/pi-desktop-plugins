// End-to-end harness for the official-session-API commit path (no host needed).
import { createRequire } from "node:module";
import assert from "node:assert";

const require = createRequire(import.meta.url);
const PLUGIN_DIR = "/Users/blackevil/dev/pi-desktop-session-import";

const importBatchCalls = [];
const stubAdapter = {
  source: "stub",
  label: "Stub",
  scan: async () => [],
  convert: async (item) => ({
    session: {
      id: `import-stub-${item.externalId}`,
      title: `标题 ${item.externalId}`,
      projectPath: "/tmp/proj",
      modelId: "m",
      providerId: null,
      mode: "agent",
      // deliberately: updatedAt earlier than createdAt, message times out of order
      createdAt: "2026-09-08T00:00:00.000Z",
      updatedAt: "2026-09-07T23:00:00.000Z",
    },
    messages: [
      { role: "user", content: "m1", createdAt: "2026-09-08T00:10:00.000Z" },
      { role: "assistant", content: "m2", createdAt: "2026-09-08T00:05:00.000Z" },
      { role: "assistant", content: "m3", createdAt: "2026-09-08T00:20:00.000Z" },
      { role: "user", content: "m4", createdAt: "garbage" },
      { role: "system", content: "dropped" },
      {
        role: "tool",
        content: "out",
        createdAt: "2026-09-08T00:30:00.000Z",
        toolName: "Read",
        toolCallId: "c1",
        toolStatus: "error",
        toolArgs: { a: { b: { c: { d: { e: { f: { g: { h: { i: 1 } } } } } } } } },
        toolResult: "r",
      },
    ],
  }),
};

// Inject the stub registry before main.js can load the real one.
const registryPath = require.resolve(`${PLUGIN_DIR}/lib/registry.js`);
require.cache[registryPath] = {
  id: registryPath,
  filename: registryPath,
  loaded: true,
  exports: {
    ADAPTERS: [stubAdapter],
    getAdapter: (s) => (s === "stub" ? stubAdapter : null),
  },
};

globalThis.pi = {
  commands: { register: async () => {}, unregister: async () => {} },
  ui: { openPanel: async () => {} },
  session: {
    importBatch: async (input) => {
      importBatchCalls.push(input);
      const results = input.sessions.map((s) => ({
        externalId: s.externalId,
        sessionId: `sid-${s.externalId}`,
        status: "imported",
      }));
      return { results, imported: input.sessions.length, skipped: 0, failed: 0 };
    },
  },
};

const main = require(`${PLUGIN_DIR}/main.js`);

// 1. capabilities detection
const caps = await main.onPanelInvoke("import.capabilities");
assert.strictEqual(caps.officialSessionApi, true, "official API detected");

// 2. commit 150 sessions -> must chunk into 100 + 50
const items = Array.from({ length: 150 }, (_, i) => ({
  externalId: `e${i}`,
  title: `T${i}`,
}));
const res = await main.onPanelInvoke("import.commit", { source: "stub", items });
assert.strictEqual(res.imported, 150, "all imported");
assert.strictEqual(importBatchCalls.length, 2, "two batches");
assert.strictEqual(importBatchCalls[0].sessions.length, 100, "first batch 100");
assert.strictEqual(importBatchCalls[1].sessions.length, 50, "second batch 50");
assert.strictEqual(importBatchCalls[0].source, "stub", "source passed through");
assert.strictEqual(importBatchCalls[0].mode, "skip", "skip mode");

// 3. contract conformance on the first session
const s = importBatchCalls[0].sessions[0];
assert.strictEqual(s.createdAt, "2026-09-08T00:00:00.000Z", "createdAt = min");
assert.strictEqual(s.updatedAt, "2026-09-08T00:00:00.000Z", "updatedAt clamped up >= createdAt");
assert.strictEqual(s.messages.length, 6 - 1, "system message dropped");
const t = s.messages.map((m) => m.createdAt);
assert.deepStrictEqual(
  t,
  [
    "2026-09-08T00:10:00.000Z",
    "2026-09-08T00:10:00.000Z", // out-of-order clamped up
    "2026-09-08T00:20:00.000Z",
    "2026-09-08T00:20:00.000Z", // invalid timestamp -> previous bound
    "2026-09-08T00:30:00.000Z",
  ],
  "message timestamps monotonic non-decreasing",
);
const toolMsg = s.messages[4];
assert.strictEqual(toolMsg.toolStatus, "error");
assert.strictEqual(typeof toolMsg.toolArgs, "string", "deep JSON degraded to string");
assert.ok(toolMsg.toolCallId === "c1" && toolMsg.toolName === "Read");

console.log("ALL COMMIT-PATH ASSERTIONS PASSED (150 sessions, 2 batches, contract guards verified)");
