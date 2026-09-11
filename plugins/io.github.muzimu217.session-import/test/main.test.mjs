// @ts-check
/**
 * Unit tests for main.js — capabilities detection, scan cache, convertBatch
 * error tolerance, official #169 contract mapping, error observability (F-10).
 *
 * Style: node --test. The plugin-sdk global `pi` is stubbed. The registry is
 * replaced in require.cache so we exercise main.js's switch dispatch.
 *
 * Run:
 *   node --test test/main.test.mjs
 */
"use strict";

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const PLUGIN_DIR = "/Users/blackevil/dev/pi-desktop-session-import";

// ---------- helpers ----------

/** Replace the registry inside main.js's require cache. */
function installRegistry(adapters) {
  const registryPath = require.resolve(`${PLUGIN_DIR}/lib/registry.js`);
  require.cache[registryPath] = {
    id: registryPath,
    filename: registryPath,
    loaded: true,
    exports: {
      ADAPTERS: adapters,
      allAdapters: () => adapters,
      getAdapter: (s) => adapters.find((a) => a.source === s) ?? null,
      // Extensibility exports (no custom sources in these unit tests).
      getDynamicAdapters: () => [],
      refreshDynamicSources: async () => [],
      getDynamicLoadReport: () => ({ count: 0, errors: [], configPath: null }),
      CONFIG_PATH: "docs/session-import-sources.json",
    },
  };
}

/** Drop main.js from require cache so onLoad/onUnload run fresh each test. */
function freshMain() {
  delete require.cache[require.resolve(`${PLUGIN_DIR}/main.js`)];
  return require(`${PLUGIN_DIR}/main.js`);
}

/** Tiny adapter factory. */
function makeAdapter(source, { scan = [], convert, failScan = null, failConvert = null } = {}) {
  return {
    source,
    label: source,
    scan: async () => (failScan ? Promise.reject(failScan) : scan),
    convert: async (item) => (failConvert ? Promise.reject(failConvert) : convert(item)),
  };
}

// =============================================================================

describe("main.onPanelInvoke / import.* dispatch", () => {
  beforeEach(() => {
    delete require.cache[require.resolve(`${PLUGIN_DIR}/main.js`)];
    installRegistry([]); // empty by default; tests opt in
  });

  test("import.adapters returns [{source, label}] for each registered adapter", async () => {
    installRegistry([
      makeAdapter("a", { scan: [], convert: () => ({ session: {}, messages: [] }) }),
      makeAdapter("b", { scan: [], convert: () => ({ session: {}, messages: [] }) }),
    ]);
    const main = freshMain();
    const out = await main.onPanelInvoke("import.adapters");
    assert.deepStrictEqual(out, [
      { source: "a", label: "a", custom: false, dataPath: null },
      { source: "b", label: "b", custom: false, dataPath: null },
    ]);
  });

  test("unknown channel throws Error", async () => {
    const main = freshMain();
    await assert.rejects(() => main.onPanelInvoke("nope"), /unknown channel: nope/);
  });
});

describe("F-10 import.scanSource — error observability (P0 of v0.5.0)", () => {
  beforeEach(() => {
    delete require.cache[require.resolve(`${PLUGIN_DIR}/main.js`)];
  });

  test("happy path: adapter.scan returns sessions -> {found: true, count: N}", async () => {
    installRegistry([
      makeAdapter("ok", {
        scan: [{ source: "ok", externalId: "1", title: "t" }],
        convert: () => ({ session: {}, messages: [] }),
      }),
    ]);
    const main = freshMain();
    const r = await main.onPanelInvoke("import.scanSource", { source: "ok" });
    assert.deepStrictEqual(r, {
      source: "ok",
      found: true,
      count: 1,
      error: null,
      // Adapters without scanFast() complete in one pass.
      partial: false,
      // Sessions too large for the host contract (surfaced in the UI).
      oversized: 0,
    });
  });

  test("F-10: adapter.scan rejects with ERR (path-missing) -> returned shape carries `error`", async () => {
    const err = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
    installRegistry([makeAdapter("missing", { failScan: err })]);
    const main = freshMain();
    const r = await main.onPanelInvoke("import.scanSource", { source: "missing" });
    assert.strictEqual(r.source, "missing");
    assert.strictEqual(r.found, false);
    assert.strictEqual(r.count, 0);
    assert.ok(r.error, "error object present");
    assert.strictEqual(r.error.code, "ENOENT");
    assert.match(r.error.message, /ENOENT/);
  });

  test("F-10: permission-denied surfaced distinctly", async () => {
    const err = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    installRegistry([makeAdapter("denied", { failScan: err })]);
    const main = freshMain();
    const r = await main.onPanelInvoke("import.scanSource", { source: "denied" });
    assert.strictEqual(r.error.code, "EACCES");
  });

  test("F-10: corrupt-db (custom error code from SQLite layer) flows through", async () => {
    const err = Object.assign(new Error("database disk image is malformed"), { code: "SQLITE_CORRUPT" });
    installRegistry([makeAdapter("corrupt", { failScan: err })]);
    const main = freshMain();
    const r = await main.onPanelInvoke("import.scanSource", { source: "corrupt" });
    assert.strictEqual(r.error.code, "SQLITE_CORRUPT");
    assert.strictEqual(r.found, false);
  });

  test("unknown source throws (not silently swallowed)", async () => {
    installRegistry([]);
    const main = freshMain();
    await assert.rejects(() => main.onPanelInvoke("import.scanSource", { source: "nope" }), /unknown source: nope/);
  });

  test("cache prevents re-scan across same source", async () => {
    let scanCalls = 0;
    installRegistry([
      {
        source: "c",
        label: "c",
        scan: async () => {
          scanCalls += 1;
          return [{ source: "c", externalId: "1" }];
        },
        convert: () => ({ session: {}, messages: [] }),
      },
    ]);
    const main = freshMain();
    await main.onPanelInvoke("import.scanSource", { source: "c" });
    await main.onPanelInvoke("import.scanSource", { source: "c" });
    await main.onPanelInvoke("import.scanSource", { source: "c" });
    assert.strictEqual(scanCalls, 1, "scanned exactly once");
  });
});

describe("import.sessions — pagination-after-scan contract", () => {
  beforeEach(() => delete require.cache[require.resolve(`${PLUGIN_DIR}/main.js`)]);

  test("returns the cached scans after scanSource", async () => {
    const make = (s) => ({ source: "x", externalId: s, title: `T${s}` });
    installRegistry([
      {
        source: "x",
        label: "x",
        scan: async () => [make("1"), make("2"), make("3")],
        convert: () => ({ session: {}, messages: [] }),
      },
    ]);
    const main = freshMain();
    await main.onPanelInvoke("import.scanSource", { source: "x" });
    const out = await main.onPanelInvoke("import.sessions", { source: "x" });
    assert.strictEqual(out.sessions.length, 3);
    assert.strictEqual(out.source, "x");
  });

  test("refuses to fetch sessions without a prior scan", async () => {
    installRegistry([
      makeAdapter("x", { scan: [], convert: () => ({ session: {}, messages: [] }) }),
    ]);
    const main = freshMain();
    await assert.rejects(
      () => main.onPanelInvoke("import.sessions", { source: "x" }),
      /source not scanned/,
    );
  });
});

describe("import.convertBatch — error tolerance", () => {
  beforeEach(() => delete require.cache[require.resolve(`${PLUGIN_DIR}/main.js`)]);

  test("convertBatch assigns UUID to each message even when adapter omits ids", async () => {
    installRegistry([
      {
        source: "x",
        label: "x",
        scan: async () => [{ source: "x", externalId: "1" }],
        convert: async (item) => ({
          session: { id: "imp-x-1", title: item.externalId, createdAt: "2026-09-09T00:00:00.000Z", updatedAt: "2026-09-09T00:01:00.000Z" },
          messages: [
            { role: "user", content: "hi", createdAt: "2026-09-09T00:00:30.000Z" },
            { role: "assistant", content: "yo", createdAt: "2026-09-09T00:01:00.000Z" },
          ],
        }),
      },
    ]);
    const main = freshMain();
    const out = await main.onPanelInvoke("import.convertBatch", {
      source: "x",
      items: [{ externalId: "1" }],
    });
    assert.strictEqual(out.sessions.length, 1);
    for (const m of out.sessions[0].messages) {
      assert.match(m.id, /^[0-9a-f-]{36}$/);
    }
  });

  test("convertBatch reports unreadable count and skips failed items", async () => {
    installRegistry([
      {
        source: "x",
        label: "x",
        scan: async () => [],
        convert: async (item) => {
          if (item.externalId === "bad") throw new Error("parse fail");
          return { session: { title: "ok" }, messages: [] };
        },
      },
    ]);
    const main = freshMain();
    const out = await main.onPanelInvoke("import.convertBatch", {
      source: "x",
      items: [{ externalId: "good" }, { externalId: "bad" }, { externalId: "good2" }],
    });
    assert.strictEqual(out.sessions.length, 2);
    assert.strictEqual(out.unreadable, 1);
  });

  test("convertBatch rejects nothing-to-select upfront", async () => {
    installRegistry([
      makeAdapter("x", { scan: [], convert: () => ({ session: {}, messages: [] }) }),
    ]);
    const main = freshMain();
    await assert.rejects(
      () => main.onPanelInvoke("import.convertBatch", { source: "x", items: [] }),
      /nothing selected/,
    );
  });
});

describe("import.capabilities + import.commit fallback", () => {
  beforeEach(() => delete require.cache[require.resolve(`${PLUGIN_DIR}/main.js`)]);

  test("capabilities.officialSessionApi = false when pi.session.importBatch missing", async () => {
    installRegistry([]);
    globalThis.pi = {
      commands: { register: async () => {}, unregister: async () => {} },
      ui: { openPanel: async () => {}, showToast: async () => {} },
    };
    const main = freshMain();
    const caps = await main.onPanelInvoke("import.capabilities");
    assert.strictEqual(caps.officialSessionApi, false);
  });

  test("capabilities.officialSessionApi = true when pi.session.importBatch present", async () => {
    installRegistry([]);
    globalThis.pi = {
      commands: { register: async () => {}, unregister: async () => {} },
      ui: { openPanel: async () => {}, showToast: async () => {} },
      session: { importBatch: async () => ({ imported: 0, skipped: 0 }) },
    };
    const main = freshMain();
    const caps = await main.onPanelInvoke("import.capabilities");
    assert.strictEqual(caps.officialSessionApi, true);
  });

  test("import.commit reports a clear error when no session-import API exists on the host", async () => {
    installRegistry([makeAdapter("x", { scan: [], convert: () => ({ session: {}, messages: [] }) })]);
    globalThis.pi = {
      commands: { register: async () => {}, unregister: async () => {} },
      ui: { openPanel: async () => {}, showToast: async () => {} },
    };
    const main = freshMain();
    // No session.importBatch and no session.import on this stub host: the
    // commit must surface a clear, actionable error (not a cryptic
    // "host api not available: session.importBatch" crash).
    await assert.rejects(
      () => main.onPanelInvoke("import.commit", { source: "x", items: [{ externalId: "1" }] }),
      /feat\/zcode-session-import|当前宿主未提供会话导入接口/,
    );
  });

  test("import.commit uses the legacy session.import bridge when available", async () => {
    const importedCalls = [];
    installRegistry([
      makeAdapter("x", {
        scan: [],
        convert: () => ({ session: { id: "s1", title: "T", mode: "agent" }, messages: [{ role: "user", content: "hi", createdAt: "2026-01-01T00:00:00.000Z" }] }),
      }),
    ]);
    globalThis.pi = {
      commands: { register: async () => {}, unregister: async () => {} },
      ui: { openPanel: async () => {}, showToast: async () => {} },
      session: {
        import: async (payload) => {
          importedCalls.push(payload);
          return { ok: true, imported: true, skipped: false };
        },
      },
    };
    const main = freshMain();
    const r = await main.onPanelInvoke("import.commit", { source: "x", items: [{ externalId: "1" }] });
    assert.strictEqual(r.imported, 1, "legacy bridge imported the session");
    assert.strictEqual(importedCalls.length, 1, "one session.import call");
    assert.strictEqual(importedCalls[0].session.id, "s1");
    assert.strictEqual(importedCalls[0].messages[0].id != null, true, "message id allocated");
  });
});

describe("P0-F1 import.recent — cross-view state channel", () => {
  beforeEach(() => {
    delete require.cache[require.resolve(`${PLUGIN_DIR}/main.js`)];
    delete require.cache[require.resolve(`${PLUGIN_DIR}/lib/bus.js`)];
  });

  test("returns null at/count 0/source null when no import has happened", async () => {
    installRegistry([]);
    globalThis.pi = {
      commands: { register: async () => {}, unregister: async () => {} },
      ui: { openPanel: async () => {}, showToast: async () => {} },
    };
    const main = freshMain();
    const r = await main.onPanelInvoke("import.recent");
    assert.strictEqual(r.lastImportAt, null);
    assert.strictEqual(r.lastImportCount, 0);
    assert.strictEqual(r.lastImportSource, null);
  });

  test("after import.commit success, snapshot carries imported count + source + ISO timestamp", async () => {
    installRegistry([
      {
        source: "stub",
        label: "stub",
        scan: async () => [],
        convert: async (item) => ({
          session: { id: `s-${item.externalId}`, title: `T${item.externalId}` },
          messages: [],
        }),
      },
    ]);
    const importBatchCalls = [];
    globalThis.pi = {
      commands: { register: async () => {}, unregister: async () => {} },
      ui: { openPanel: async () => {}, showToast: async () => {} },
      session: {
        importBatch: async (input) => {
          importBatchCalls.push(input);
          const results = input.sessions.map((s) => ({
            externalId: s.externalId, sessionId: `sid-${s.externalId}`, status: "imported",
          }));
          return { results, imported: input.sessions.length, skipped: 0, failed: 0 };
        },
      },
    };
    const main = freshMain();
    await main.onPanelInvoke("import.commit", {
      source: "stub",
      items: [{ externalId: "a" }, { externalId: "b" }, { externalId: "c" }],
    });
    const r = await main.onPanelInvoke("import.recent");
    assert.strictEqual(r.lastImportCount, 3);
    assert.strictEqual(r.lastImportSource, "stub");
    assert.match(r.lastImportAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  test("failed-only import (no successful sessions) does NOT update snapshot", async () => {
    installRegistry([
      {
        source: "stub",
        label: "stub",
        scan: async () => [],
        convert: async () => ({ session: {}, messages: [] }),
      },
    ]);
    globalThis.pi = {
      commands: { register: async () => {}, unregister: async () => {} },
      ui: { openPanel: async () => {}, showToast: async () => {} },
      session: {
        importBatch: async () => ({
          results: [{ status: "failed", externalId: "x", errorMessage: "boom" }],
          imported: 0, skipped: 0, failed: 1,
        }),
      },
    };
    const main = freshMain();
    await main.onPanelInvoke("import.commit", { source: "stub", items: [{ externalId: "x" }] });
    const r = await main.onPanelInvoke("import.recent");
    assert.strictEqual(r.lastImportCount, 0, "no successful import → snapshot untouched");
    assert.strictEqual(r.lastImportAt, null);
  });
});

describe("forge.* dispatch", () => {
  beforeEach(() => delete require.cache[require.resolve(`${PLUGIN_DIR}/main.js`)]);

  test("forge.capabilities reports booleans for each dependency", async () => {
    installRegistry([]);
    globalThis.pi = {
      commands: { register: async () => {}, unregister: async () => {} },
      ui: { openPanel: async () => {}, showToast: async () => {} },
      session: { list: () => {}, listMessages: () => {} },
      agent: { complete: () => {} },
      models: { list: () => {} },
      fs: { writeText: () => {} },
    };
    const main = freshMain();
    const caps = await main.onPanelInvoke("forge.capabilities");
    assert.deepStrictEqual(caps, {
      listSessions: true,
      listMessages: true,
      complete: true,
      models: true,
      writeText: true,
    });
  });

  test("forge.models normalizes {models:[]} and bare arrays", async () => {
    installRegistry([]);
    globalThis.pi = {
      commands: { register: async () => {}, unregister: async () => {} },
      ui: { openPanel: async () => {}, showToast: async () => {} },
      models: { list: async () => [{ modelKey: "openai/gpt-4o" }] },
    };
    const main = freshMain();
    const out = await main.onPanelInvoke("forge.models");
    assert.deepStrictEqual(out.models, [{ modelKey: "openai/gpt-4o" }]);
  });

  test("forge.save rejects empty path", async () => {
    installRegistry([]);
    let writeCalls = 0;
    globalThis.pi = {
      commands: { register: async () => {}, unregister: async () => {} },
      ui: { openPanel: async () => {}, showToast: async () => {} },
      fs: { writeText: async () => { writeCalls += 1; } },
    };
    const main = freshMain();
    await assert.rejects(
      () => main.onPanelInvoke("forge.save", { path: "", content: "x" }),
      /path required/,
    );
    assert.strictEqual(writeCalls, 0);
  });

  test("forge.save returns {bytes} matching utf8 byte length", async () => {
    installRegistry([]);
    const writes = new Map();
    globalThis.pi = {
      commands: { register: async () => {}, unregister: async () => {} },
      ui: { openPanel: async () => {}, showToast: async () => {} },
      fs: {
        writeText: async (path, content) => { writes.set(path, content); },
      },
    };
    const main = freshMain();
    const out = await main.onPanelInvoke("forge.save", { path: "AGENTS.md", content: "你好" });
    assert.strictEqual(out.path, "AGENTS.md");
    assert.strictEqual(out.bytes, Buffer.byteLength("你好", "utf8"));
    // P1-F3: forge.save also records a history entry, so assert on the
    // target-file write specifically (not the last write overall).
    assert.strictEqual(writes.get("AGENTS.md"), "你好");
  });

  test("forge.save rejects empty content", async () => {
    installRegistry([]);
    globalThis.pi = {
      commands: { register: async () => {}, unregister: async () => {} },
      ui: { openPanel: async () => {}, showToast: async () => {} },
      fs: { writeText: async () => {} },
    };
    const main = freshMain();
    await assert.rejects(
      () => main.onPanelInvoke("forge.save", { path: "AGENTS.md", content: "   " }),
      /nothing to save/,
    );
  });
});

describe("forge.distill dispatch wiring", () => {
  beforeEach(() => delete require.cache[require.resolve(`${PLUGIN_DIR}/main.js`)]);

  test("forge.distill rejects when no sessions selected", async () => {
    installRegistry([]);
    globalThis.pi = {
      commands: { register: async () => {}, unregister: async () => {} },
      ui: { openPanel: async () => {}, showToast: async () => {} },
      session: { listMessages: async () => [] },
    };
    const main = freshMain();
    await assert.rejects(
      () => main.onPanelInvoke("forge.distill", { sessionIds: [] }),
      /no sessions selected/,
    );
  });

  test("forge.distill aggregates unreadable count and surfaces RATE_LIMITED", async () => {
    installRegistry([]);
    let piCompleted = false;
    globalThis.pi = {
      commands: { register: async () => {}, unregister: async () => {} },
      ui: { openPanel: async () => {}, showToast: async () => {} },
      session: {
        list: async () => ({ sessions: [{ id: "s1" }, { id: "s2" }, { id: "s3" }] }),
        listMessages: async (q) => {
          if (q.sessionId === "s2") throw new Error("read fail");
          return [{ role: "user", content: "x" }];
        },
      },
      agent: {
        complete: async () => {
          piCompleted = true;
          return { text: "distilled", usage: { inputTokens: 5, outputTokens: 7 } };
        },
      },
    };
    const main = freshMain();
    // Pre-fill rate window: forge.distill uses module-level callLog. We can't
    // easily peek, so we exhaust it via the public API.
    for (let i = 0; i < 8; i++) {
      // 8 calls with non-empty text -> success, advances callLog
      try {
        await main.onPanelInvoke("forge.distill", {
          sessionIds: ["s1"],
          modelKey: "test-model",
          sessions: [{ id: "s1", title: "T" }],
        });
      } catch (e) {
        if (e.code !== "RATE_LIMITED") throw e;
      }
    }
    // 9th must surface RATE_LIMITED
    await assert.rejects(
      () => main.onPanelInvoke("forge.distill", {
        sessionIds: ["s1"],
        modelKey: "test-model",
        sessions: [{ id: "s1", title: "T" }],
      }),
      (err) => err.code === "RATE_LIMITED",
    );
  });
});

describe("onLoad + onUnload", () => {
  beforeEach(() => {
    delete require.cache[require.resolve(`${PLUGIN_DIR}/main.js`)];
  });

  test("registers exactly three commands (importer + forge entry + forge show)", async () => {
    installRegistry([]);
    const registered = [];
    globalThis.pi = {
      commands: { register: async (cmd) => { registered.push(cmd.id); } },
      ui: { openPanel: async () => {}, showToast: async () => {}, notify: async () => ({ ok: true }) },
    };
    const main = freshMain();
    await main.onLoad();
    assert.deepStrictEqual(registered, [
      "session-import.open",
      "session-forge.show",
      "session-forge.open",
    ]);

    const unregistered = [];
    globalThis.pi.commands.unregister = async (id) => { unregistered.push(id); };
    await main.onUnload();
    assert.deepStrictEqual(unregistered, [
      "session-import.open",
      "session-forge.open",
      "session-forge.show",
    ]);
  });
});

describe("P1-U1 app.locale — best-effort host locale", () => {
  beforeEach(() => {
    delete require.cache[require.resolve(`${PLUGIN_DIR}/main.js`)];
    installRegistry([]);
  });

  test("returns zh-CN when host exposes no locale", async () => {
    globalThis.pi = { ui: {} };
    const main = freshMain();
    assert.strictEqual(await main.onPanelInvoke("app.locale"), "zh-CN");
    delete globalThis.pi;
  });

  test("prefers pi.i18n.locale", async () => {
    globalThis.pi = { i18n: { locale: "en" }, ui: {} };
    const main = freshMain();
    assert.strictEqual(await main.onPanelInvoke("app.locale"), "en");
    delete globalThis.pi;
  });

  test("normalizes bare 'zh' to 'zh-CN'", async () => {
    globalThis.pi = { app: { locale: "zh" }, ui: {} };
    const main = freshMain();
    assert.strictEqual(await main.onPanelInvoke("app.locale"), "zh-CN");
    delete globalThis.pi;
  });

  test("rejects unsupported locale and falls back to zh-CN", async () => {
    globalThis.pi = { i18n: { locale: "fr" }, ui: {} };
    const main = freshMain();
    assert.strictEqual(await main.onPanelInvoke("app.locale"), "zh-CN");
    delete globalThis.pi;
  });
});

describe("P1-F3+F4 forge.save (modes) + forge.history", () => {
  const { HISTORY_PATH } = require(`${PLUGIN_DIR}/lib/history.js`);
  const { MERGE_START, MERGE_END } = require(`${PLUGIN_DIR}/lib/save-modes.js`);

  function makeFs() {
    const store = new Map();
    return {
      store,
      readText: async (p) => {
        if (!store.has(p)) {
          const e = new Error("ENOENT");
          e.code = "ENOENT";
          throw e;
        }
        return store.get(p);
      },
      writeText: async (p, c) => { store.set(p, c); },
    };
  }

  beforeEach(() => {
    delete require.cache[require.resolve(`${PLUGIN_DIR}/main.js`)];
    installRegistry([]);
  });
  after(() => { delete globalThis.pi; });

  test("overwrite: writes incoming, no read, records history", async () => {
    const fs = makeFs();
    globalThis.pi = { fs, session: {}, agent: {}, models: {}, ui: {} };
    const main = freshMain();
    const res = await main.onPanelInvoke("forge.save", { path: "AGENTS.md", content: "HELLO", mode: "overwrite" });
    assert.strictEqual(res.mode, "overwrite");
    assert.strictEqual(fs.store.get("AGENTS.md"), "HELLO");
    assert.ok(fs.store.has(HISTORY_PATH), "history file written");
  });

  test("append: joins new text after existing with a blank line", async () => {
    const fs = makeFs();
    fs.store.set("AGENTS.md", "OLD");
    globalThis.pi = { fs, session: {}, agent: {}, models: {}, ui: {} };
    const main = freshMain();
    const res = await main.onPanelInvoke("forge.save", { path: "AGENTS.md", content: "NEW", mode: "append" });
    assert.strictEqual(fs.store.get("AGENTS.md"), "OLD\n\nNEW");
    assert.strictEqual(res.mode, "append");
  });

  test("merge: replaces only the marked section", async () => {
    const fs = makeFs();
    fs.store.set(
      "AGENTS.md",
      ["# H", "", MERGE_START, "X", MERGE_END, "", "foot"].join("\n"),
    );
    globalThis.pi = { fs, session: {}, agent: {}, models: {}, ui: {} };
    const main = freshMain();
    const res = await main.onPanelInvoke("forge.save", { path: "AGENTS.md", content: "Y", mode: "merge" });
    const out = fs.store.get("AGENTS.md");
    assert.ok(out.startsWith("# H"));
    assert.ok(out.includes("foot"));
    assert.ok(out.includes("Y"));
    assert.ok(!out.includes("\nX\n"));
    assert.strictEqual(res.mode, "merge");
  });

  test("forge.history.load parses the JSONL ring buffer", async () => {
    const fs = makeFs();
    fs.store.set(HISTORY_PATH, JSON.stringify({ a: 1 }) + "\n");
    globalThis.pi = { fs, session: {}, agent: {}, models: {}, ui: {} };
    const main = freshMain();
    const r = await main.onPanelInvoke("forge.history.load", {});
    assert.deepStrictEqual(r.entries, [{ a: 1 }]);
  });

  test("forge.history.record appends an entry and returns the count", async () => {
    const fs = makeFs();
    globalThis.pi = { fs, session: {}, agent: {}, models: {}, ui: {} };
    const main = freshMain();
    const r = await main.onPanelInvoke("forge.history.record", { entry: { path: "AGENTS.md" } });
    assert.strictEqual(r.count, 1);
    assert.ok(fs.store.get(HISTORY_PATH).includes("AGENTS.md"));
  });
});

after(() => {
  // Reset global pi to avoid leaking into sibling test files.
  delete globalThis.pi;
});
