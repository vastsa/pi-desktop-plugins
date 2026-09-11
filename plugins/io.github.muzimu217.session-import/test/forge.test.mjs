// @ts-check
/**
 * Unit tests for lib/forge.js — corpus budgeting, rate limiting, distillation
 * entry point. Runs without an Electron host: builds a fake `pi` on
 * globalThis and exercises the module's exported functions directly.
 *
 * Style: node --test (no extra deps). Run with:
 *   node --test test/forge.test.mjs
 */
"use strict";

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

// Each test starts with a clean slate — clear require cache for forge.js so
// its module-level state (callLog) resets.
function freshForge() {
  delete require.cache[require.resolve(`${PLUGIN_DIR}/lib/forge.js`)];
  return require(`${PLUGIN_DIR}/lib/forge.js`);
}

describe("forge.buildCorpus", () => {
  const forge = freshForge();

  test("returns empty string for empty input", () => {
    assert.strictEqual(forge.buildCorpus([]), "");
  });

  test("emits title block + user/assistant/tools with role labels", () => {
    const sessions = [
      {
        title: "T1",
        projectPath: "/tmp/proj",
        modelId: "claude-opus",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
          { role: "tool", content: "ran" },
        ],
      },
    ];
    const out = forge.buildCorpus(sessions, 100_000);
    assert.match(out, /## 会话：T1/);
    assert.match(out, /- 项目：\/tmp\/proj/);
    assert.match(out, /- 模型：claude-opus/);
    assert.match(out, /\*\*用户\*\*: hi/);
    assert.match(out, /\*\*助手\*\*: hello/);
    assert.match(out, /\*\*工具\*\*: ran/);
  });

  test("trims whitespace-only messages and skips them", () => {
    const out = forge.buildCorpus(
      [{ title: "T", messages: [{ role: "user", content: "  \n  " }, { role: "user", content: "ok" }] }],
      100_000,
    );
    assert.ok(!out.includes("  \n  "), "whitespace-only chunk not emitted");
    assert.match(out, /\*\*用户\*\*: ok/);
  });

  test("budget split is per-session; over budget, tail is dropped, head kept", () => {
    // budget 100 chars, 2 sessions → 50 each
    const big = "x".repeat(80);
    const sessions = [
      {
        title: "BIG",
        messages: [
          { role: "user", content: big },
          { role: "user", content: "TAIL-MARKER" },
        ],
      },
      { title: "OTHER", messages: [{ role: "user", content: "other" }] },
    ];
    const out = forge.buildCorpus(sessions, 100);
    assert.ok(out.includes("BIG"), "title present");
    assert.ok(out.includes("TAIL-MARKER") === false, "tail dropped on overflow");
    assert.ok(out.includes("other"), "second session rendered");
  });

  test("budget split: per-session cap clamps large body (head kept, tail dropped)", () => {
    // 1 session, budget 1000. Header ~7 chars; per-session budget ~993.
    // First message chunk = "**用户**: " + 1000 y's + "\n" = ~1006 chars > 1000
    // so the body is dropped entirely and TAIL-MARKER falls outside too.
    const sessions = [
      {
        title: "T",
        messages: [
          { role: "user", content: "y".repeat(1000) },
          { role: "user", content: "TAIL-MARKER" },
        ],
      },
    ];
    const out = forge.buildCorpus(sessions, 1000);
    const yCount = (out.match(/y/g) || []).length;
    assert.ok(yCount <= 1000, `body clamped: yCount=${yCount}`);
    assert.ok(!out.includes("TAIL-MARKER"), "tail truncated when per-session budget exceeded");
    assert.match(out, /## 会话：T/, "header still rendered");
  });

  test("budget split: when first message alone exceeds budget, NOTHING is emitted (defensive)", () => {
    // Documents current behavior — single huge message gets broken by `if (used + chunk.length > perSession) break;`,
    // meaning a too-big first message yields no body text at all (header only).
    // This is a known wart the spec should not regress silently: covered here.
    const huge = "z".repeat(5000);
    const out = forge.buildCorpus(
      [{ title: "T", messages: [{ role: "user", content: huge }] }],
      1000,
    );
    const zCount = (out.match(/z/g) || []).length;
    assert.strictEqual(zCount, 0, "first-chunk-skipped when it alone exceeds per-session budget");
    assert.match(out, /## 会话：T/);
  });

  test("joins sessions with --- separator", () => {
    const out = forge.buildCorpus(
      [
        { title: "A", messages: [{ role: "user", content: "1" }] },
        { title: "B", messages: [{ role: "user", content: "2" }] },
      ],
      10_000,
    );
    assert.match(out, /\n\n---\n\n/);
  });

  test("system and unknown roles render as user label (defensive)", () => {
    const out = forge.buildCorpus(
      [{ title: "T", messages: [{ role: "system", content: "sysnote" }, { role: "weird", content: "?" }] }],
      10_000,
    );
    // The mapping is `assistant -> 助手`, `tool -> 工具`, else -> 用户.
    // system + weird both fall through to "用户".
    assert.ok(out.includes("sysnote"));
    assert.ok(out.includes("?"));
  });
});

describe("forge.distill (rate limit + error paths)", () => {
  beforeEach(() => {
    delete require.cache[require.resolve(`${PLUGIN_DIR}/lib/forge.js`)];
  });

  test("RATE_LIMITED thrown when callLog already full within window", async () => {
    // Fresh module so callLog is empty at start.
    delete require.cache[require.resolve(`${PLUGIN_DIR}/lib/forge.js`)];
    const forge = require(`${PLUGIN_DIR}/lib/forge.js`);
    // After 8 successful calls the 9th rejects. Use a fake pi returning minimal text.
    globalThis.pi = {
      agent: {
        complete: async () => ({
          text: "ok",
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
      },
    };
    const sessions = [{ title: "T", messages: [{ role: "user", content: "hi" }] }];
    for (let i = 0; i < 8; i++) {
      await forge.distill({ sessions, modelKey: "m", thinkingLevel: "off", goal: "" });
    }
    await assert.rejects(
      () => forge.distill({ sessions, modelKey: "m", thinkingLevel: "off", goal: "" }),
      (err) => {
        assert.strictEqual(err.code, "RATE_LIMITED");
        assert.ok(err.retryAfterMs > 0 && err.retryAfterMs <= 60_000);
        return true;
      },
    );
  });

  test("'没有可蒸馏的会话内容' when sessions array is empty", async () => {
    // Fresh module so module-level callLog starts empty.
    delete require.cache[require.resolve(`${PLUGIN_DIR}/lib/forge.js`)];
    const forge = require(`${PLUGIN_DIR}/lib/forge.js`);
    let called = false;
    globalThis.pi = {
      agent: { complete: async () => { called = true; return { text: "" }; } },
    };
    await assert.rejects(
      () => forge.distill({ sessions: [] }),
      /没有可蒸馏的会话内容/,
    );
    assert.strictEqual(called, false, "agent.complete must not be called when corpus is empty");
  });

  test("messages=[] still emits title-only corpus and completes (defensive: not silently dropped)", async () => {
    // Documents current behavior: an empty messages array in one session
    // does NOT cause `distill` to throw — the title alone makes the corpus
    // non-empty, so the agent is consulted (and may return distilled text).
    delete require.cache[require.resolve(`${PLUGIN_DIR}/lib/forge.js`)];
    const forge = require(`${PLUGIN_DIR}/lib/forge.js`);
    let captured = null;
    globalThis.pi = {
      agent: {
        complete: async (input) => {
          captured = input;
          return { text: "STILL-RAN", usage: { inputTokens: 5, outputTokens: 3 } };
        },
      },
    };
    const out = await forge.distill({ sessions: [{ title: "Lonely Session", messages: [] }] });
    assert.strictEqual(out.text, "STILL-RAN");
    assert.ok(captured.messages[0].content.includes("## 会话：Lonely Session"));
  });

  test("happy path: returns text + usage, builds corpus, goal prepended to prompt", async () => {
    const forge = require(`${PLUGIN_DIR}/lib/forge.js`);
    let captured;
    globalThis.pi = {
      agent: {
        complete: async (input) => {
          captured = input;
          return {
            text: "## 项目约定\n- always read first",
            usage: { inputTokens: 100, outputTokens: 50 },
          };
        },
      },
    };
    const sessions = [{ title: "T", messages: [{ role: "user", content: "hello" }] }];
    const out = await forge.distill({
      sessions,
      modelKey: "claude-opus",
      thinkingLevel: "high",
      goal: "关注部署",
    });
    assert.strictEqual(out.text, "## 项目约定\n- always read first");
    assert.deepStrictEqual(out.usage, { inputTokens: 100, outputTokens: 50 });
    assert.ok(captured);
    assert.strictEqual(captured.modelKey, "claude-opus");
    assert.strictEqual(captured.thinkingLevel, "high");
    assert.match(captured.system, /你是一位资深工程负责人/);
    assert.ok(captured.messages[0].content.includes("本次提炼的重点：关注部署"));
    assert.ok(captured.messages[0].content.includes("## 会话：T"));
  });

  test("extractText: handles string, text, content string, content[]", () => {
    const forge = require(`${PLUGIN_DIR}/lib/forge.js`);
    // internal helper, access via distill returning the fake result
    // We rely on the implementation: probe by returning varying shapes from pi.
    const cases = [
      { in: "plain", expect: "plain" },
      { in: { text: "via.text" }, expect: "via.text" },
      { in: { content: "via.content" }, expect: "via.content" },
      { in: { content: [{ type: "text", text: "block" }] }, expect: "block" },
      { in: { content: [{ text: "no-type" }] }, expect: "no-type" },
      { in: null, expect: "" },
    ];
    globalThis.pi = { agent: { complete: async () => "init" } };
    return (async () => {
      for (const c of cases) {
        globalThis.pi.agent.complete = async () => c.in;
        const r = await forge.distill({ sessions: [{ title: "T", messages: [{ role: "user", content: "x" }] }] });
        assert.strictEqual(r.text, c.expect, `for input ${JSON.stringify(c.in)}`);
      }
    })();
  });
});

describe("forge.listImported / readMessages", () => {
  beforeEach(() => {
    delete require.cache[require.resolve(`${PLUGIN_DIR}/lib/forge.js`)];
  });

  test("listImported passes through {sessions} wrapper", async () => {
    const forge = require(`${PLUGIN_DIR}/lib/forge.js`);
    const sessions = [{ id: 1, title: "a" }];
    globalThis.pi = { session: { list: async (args) => ({ sessions, limit: args.limit }) } };
    const got = await forge.listImported({ limit: 200 });
    // legacy {sessions} shape: entries gain the sessionId projection
    assert.deepStrictEqual(got, [{ id: 1, title: "a", sessionId: 1 }]);
  });

  test("listImported unwraps bare array responses (legacy host)", async () => {
    const forge = require(`${PLUGIN_DIR}/lib/forge.js`);
    const sessions = [{ id: 2 }];
    globalThis.pi = { session: { list: async () => sessions } };
    const got = await forge.listImported();
    assert.deepStrictEqual(got, [{ id: 2, sessionId: 2 }]);
  });

  test("listImported prefers official {items} wrapper with sessionId", async () => {
    const forge = require(`${PLUGIN_DIR}/lib/forge.js`);
    globalThis.pi = {
      session: { list: async () => ({ items: [{ sessionId: "abc-1", title: "official" }] }) },
    };
    const got = await forge.listImported();
    assert.deepStrictEqual(got, [{ sessionId: "abc-1", title: "official", id: "abc-1" }]);
  });

  test("listImported clamps limit to [1, 200]", async () => {
    const forge = require(`${PLUGIN_DIR}/lib/forge.js`);
    const seen = [];
    globalThis.pi = { session: { list: async (args) => { seen.push(args.limit); return []; } } };
    await forge.listImported({ limit: 999 });
    await forge.listImported({ limit: -5 });
    await forge.listImported({ limit: "abc" });
    assert.deepStrictEqual(seen, [200, 1, 100]);
  });

  test("readMessages unwraps array vs {messages} envelope", async () => {
    const forge = require(`${PLUGIN_DIR}/lib/forge.js`);
    globalThis.pi = { session: { listMessages: async () => ([{ id: 1 }]) } };
    assert.deepStrictEqual(await forge.readMessages("s1"), [{ id: 1 }]);
    globalThis.pi = { session: { listMessages: async () => ({ messages: [{ id: 2 }] }) } };
    assert.deepStrictEqual(await forge.readMessages("s2"), [{ id: 2 }]);
  });

  test("listImported forwards source when provided", async () => {
    const forge = require(`${PLUGIN_DIR}/lib/forge.js`);
    let got;
    globalThis.pi = { session: { list: async (args) => { got = args; return []; } } };
    await forge.listImported({ source: "zcode", limit: 10 });
    assert.strictEqual(got.source, "zcode");
  });
});

describe("forge.COMPLETE_LIMITS reflects ADR 0174", () => {
  test("constants match the docs", () => {
    const forge = require(`${PLUGIN_DIR}/lib/forge.js`);
    assert.strictEqual(forge.COMPLETE_LIMITS.systemMax, 32 * 1024);
    assert.strictEqual(forge.COMPLETE_LIMITS.messagesMaxChars, 200_000);
    assert.strictEqual(forge.COMPLETE_LIMITS.callsPerMinute, 8);
  });
});
