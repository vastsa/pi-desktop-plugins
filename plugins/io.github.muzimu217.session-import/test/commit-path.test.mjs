// End-to-end harness for the official-session-API commit path (no host needed).
import { createRequire } from "node:module";
import assert from "node:assert";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

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

// 3b. Default placement is "project": a source session that records a project
// path is bound to that project. The host's import_session runs ensure_project
// on the path, so carrying projectPath is enough to bind — the plugin sends no
// projectId (the host resolves/creates the project). Sessions with no projectPath
// fall back to the standalone SESSIONS list instead. Regresses the "checkbox is a
// no-op" bug and the standalone-import-never-shows-up bug.
assert.strictEqual(s.projectPath, "/tmp/proj", "project-bound: projectPath carried so host ensure_project binds it");
assert.strictEqual(s.projectId, undefined, "project-bound: no host projectId sent (host resolves via path)");

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

// 4. Escape-inflation guard.
//
// The host validates `JSON.stringify(field)` bytes, not raw string bytes.
// JSON escaping can add ~44% to a string of quotes/newlines/backslashes, so a
// payload truncated by *raw* byte count could still exceed the host's limit
// and get the whole batch rejected with "toolResult exceeds 256 KiB".
// Regression: every field must fit once re-serialized.
const MAX_CONTENT = 512 * 1024;
const MAX_TOOL = 256 * 1024;
const serializedBytes = (v) => {
  const json = JSON.stringify(v);
  return json === undefined ? Infinity : Buffer.byteLength(json, "utf8");
};

const escapeHeavy = '{"a":"b\\nc"},\n'.repeat(40000); // ~560KB of escape-dense text
const huge = escapeHeavy + "x".repeat(600 * 1024);
assert.ok(
  serializedBytes(huge) > MAX_TOOL,
  "fixture must start above the toolResult limit",
);

const stubAdapterHeavy = {
  source: "heavy",
  label: "Heavy",
  scan: async () => [],
  convert: async () => ({
    session: {
      id: "import-heavy-1",
      title: "heavy",
      createdAt: "2026-09-08T00:00:00.000Z",
      updatedAt: "2026-09-08T00:00:00.000Z",
    },
    messages: [
      {
        role: "assistant",
        content: huge, // escape-dense content, over the 512 KiB content budget
        createdAt: "2026-09-08T00:00:00.000Z",
      },
      {
        role: "tool",
        content: "done",
        createdAt: "2026-09-08T00:00:01.000Z",
        toolName: "Bash",
        toolCallId: "c-heavy",
        toolStatus: "success",
        toolArgs: huge,
        toolResult: huge,
      },
    ],
  }),
};
// Re-inject the registry so the heavy adapter is reachable, then re-require main.
const registryPath2 = require.resolve(`${PLUGIN_DIR}/lib/registry.js`);
require.cache[registryPath2].exports = {
  ADAPTERS: [stubAdapter, stubAdapterHeavy],
  getAdapter: (id) => (id === "stub" ? stubAdapter : id === "heavy" ? stubAdapterHeavy : null),
};
delete require.cache[require.resolve(`${PLUGIN_DIR}/main.js`)];
const main2 = require(`${PLUGIN_DIR}/main.js`);

importBatchCalls.length = 0;
await main2.onPanelInvoke("import.commit", {
  source: "heavy",
  items: [{ externalId: "heavy-1", title: "heavy" }],
});
const heavyPayload = importBatchCalls[0];
assert.ok(heavyPayload, "heavy batch captured");
const heavySession = heavyPayload.sessions[0];
for (const m of heavySession.messages) {
  assert.ok(
    serializedBytes(m.content) <= MAX_CONTENT,
    `content must fit 512 KiB once serialized (got ${serializedBytes(m.content)})`,
  );
  if (m.role !== "tool") continue;
  for (const field of ["toolArgs", "toolResult"]) {
    if (m[field] === undefined) continue;
    assert.ok(
      serializedBytes(m[field]) <= MAX_TOOL,
      `${field} must fit 256 KiB once serialized (got ${serializedBytes(m[field])})`,
    );
  }
}

console.log("ALL COMMIT-PATH ASSERTIONS PASSED (150 sessions, 2 batches, contract guards verified)");
console.log("ESCAPE-INFLATION GUARD VERIFIED (content/toolArgs/toolResult fit serialized limits)");
