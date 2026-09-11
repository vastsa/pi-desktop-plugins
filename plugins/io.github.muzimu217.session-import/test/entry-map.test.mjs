// @ts-check
/**
 * Tests for the shared entry -> message mapper.
 *
 * These cover the three tool shapes real agents write, because that is where
 * a declarative spec has to stay faithful to the hand-written adapters:
 *   - entry-level two-phase events (WorkBuddy function_call -> *_result)
 *   - block-level two-phase events (Claude tool_use -> tool_result)
 *   - self-contained tool entries
 * Plus the envelope/drop/text-op/follow rules those adapters need.
 *
 * Run:
 *   node --test test/entry-map.test.mjs
 */
"use strict";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path, { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

const { mapEntries } = require(`${PLUGIN_DIR}/lib/drivers/entry-map.js`);
const { applyTextOps } = require(`${PLUGIN_DIR}/lib/drivers/extract.js`);

let tmpRoot;
before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "simap-"));
});
after(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

const roles = (msgs) => msgs.map((m) => m.role);

/* ------------------------------------------------------------------ *
 * shape 2: entry-level two-phase tool events (WorkBuddy)
 * ------------------------------------------------------------------ */

describe("entry-map: entry-level toolCall pairing", () => {
  const spec = {
    match: { path: "type", in: ["message", "function_call", "function_call_result"] },
    rolePath: "role",
    content: { path: "content" },
    tsPath: "timestamp",
    toolCall: {
      call: {
        typePath: "type",
        types: ["function_call"],
        idPath: "callId",
        namePath: "name",
        argsPath: "arguments",
        argsJson: true,
      },
      result: {
        typePath: "type",
        types: ["function_call_result"],
        idPath: "callId",
        resultPath: "output",
        statusPath: "status",
      },
    },
  };

  test("pairs a call with its later result and emits at result time", async () => {
    const messages = await mapEntries(spec, [
      { type: "message", role: "user", content: "run it", timestamp: 1 },
      { type: "function_call", callId: "c1", name: "bash", arguments: '{"cmd":"ls"}', timestamp: 2 },
      { type: "function_call_result", callId: "c1", output: "file.txt", status: "completed", timestamp: 3 },
      { type: "message", role: "assistant", content: "done", timestamp: 4 },
    ]);

    assert.deepEqual(roles(messages), ["user", "tool", "assistant"]);
    const tool = messages[1];
    assert.equal(tool.toolName, "bash");
    assert.equal(tool.content, "file.txt");
    assert.equal(tool.toolResult, "file.txt");
    assert.equal(tool.toolStatus, "success");
    assert.equal(tool.toolCallId, "c1");
    assert.deepEqual(tool.toolArgs, { cmd: "ls" }, "arguments string is parsed as JSON");
  });

  test("a result object with .text is unwrapped; a failure maps to error", async () => {
    const messages = await mapEntries(spec, [
      { type: "function_call", callId: "c2", name: "bash", timestamp: 1 },
      { type: "function_call_result", callId: "c2", output: { text: "boom" }, status: "error", timestamp: 2 },
    ]);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].content, "boom");
    assert.equal(messages[0].toolStatus, "error");
  });

  test("resultFormat json keeps a structured payload verbatim", async () => {
    // codex.js stores whatever the tool returned: a string as-is, anything
    // else JSON-stringified. It never scans the payload for text blocks.
    const rawSpec = {
      ...spec,
      toolCall: {
        ...spec.toolCall,
        result: { ...spec.toolCall.result, resultFormat: "json" },
      },
    };
    const payload = [{ type: "input_text", text: "Wall time: 1s" }];
    const messages = await mapEntries(rawSpec, [
      { type: "function_call", callId: "c3", name: "bash", timestamp: 1 },
      { type: "function_call_result", callId: "c3", output: payload, timestamp: 2 },
    ]);
    assert.equal(messages[0].content, JSON.stringify(payload));

    // ...while the default still prefers the readable text
    const textMessages = await mapEntries(spec, [
      { type: "function_call", callId: "c4", name: "bash", timestamp: 1 },
      { type: "function_call_result", callId: "c4", output: payload, timestamp: 2 },
    ]);
    assert.equal(textMessages[0].content, "Wall time: 1s");
  });

  test("an unpaired call emits nothing by default, and a running call with emitUnpaired", async () => {
    const entries = [{ type: "function_call", callId: "lonely", name: "bash", timestamp: 1 }];
    assert.equal((await mapEntries(spec, entries)).length, 0);

    const withUnpaired = await mapEntries({ ...spec, toolCall: { ...spec.toolCall, emitUnpaired: true } }, entries);
    assert.equal(withUnpaired.length, 1);
    assert.equal(withUnpaired[0].toolStatus, "running");
    assert.equal(withUnpaired[0].toolName, "bash");
  });
});

/* ------------------------------------------------------------------ *
 * shape 3: block-level two-phase tool events (Claude Code)
 * ------------------------------------------------------------------ */

describe("entry-map: block-level toolCall pairing", () => {
  const spec = {
    rolePath: "message.role",
    content: {
      blocks: { path: "message.content", typeField: "type", types: ["text"], textField: "text" },
    },
    tsPath: "timestamp",
    drop: { startsWith: ["<"], roles: ["user"] },
    toolCall: {
      callBlocks: {
        path: "message.content",
        typeField: "type",
        type: "tool_use",
        idPath: "id",
        namePath: "name",
        argsPath: "input",
        roles: ["assistant"],
      },
      resultBlocks: {
        path: "message.content",
        typeField: "type",
        type: "tool_result",
        idPath: "tool_use_id",
        resultPath: "content",
        statusPath: "is_error",
        roles: ["user"],
      },
    },
  };

  test("tool_use blocks are answered by the later tool_result block", async () => {
    const messages = await mapEntries(spec, [
      { type: "user", message: { role: "user", content: [{ type: "text", text: "read a" }] }, timestamp: 1 },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "sure" },
            { type: "tool_use", id: "t1", name: "Read", input: { file_path: "a" } },
          ],
        },
        timestamp: 2,
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "FILE BODY" }],
        },
        timestamp: 3,
      },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "here" }] }, timestamp: 4 },
    ]);

    assert.deepEqual(roles(messages), ["user", "assistant", "tool", "assistant"]);
    const tool = messages[2];
    assert.equal(tool.toolName, "Read");
    assert.equal(tool.content, "FILE BODY");
    assert.equal(tool.toolStatus, "success");
    assert.equal(tool.toolCallId, "t1");
    assert.deepEqual(tool.toolArgs, { file_path: "a" });
  });

  test("an entry carrying tool_result blocks suppresses its own text", async () => {
    const messages = await mapEntries(spec, [
      { type: "function_call", callId: "x", timestamp: 0 },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "tool_use", id: "t9", name: "Bash", input: {} }] },
        timestamp: 1,
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "text", text: "this text is not part of the conversation" },
            { type: "tool_result", tool_use_id: "t9", content: "out" },
          ],
        },
        timestamp: 2,
      },
    ]);
    assert.deepEqual(roles(messages), ["tool"]);
  });

  test("is_error marks the tool message as failed", async () => {
    const messages = await mapEntries(spec, [
      { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Bash", input: {} }] }, timestamp: 1 },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "nope", is_error: true }] }, timestamp: 2 },
    ]);
    assert.equal(messages[0].toolStatus, "error");
  });
});

/* ------------------------------------------------------------------ *
 * envelope unwrapping, filters, text ops, externalized results
 * ------------------------------------------------------------------ */

describe("entry-map: envelope + filtering + text ops", () => {
  test("unwrapPath reads both the wrapped and the bare item shape", async () => {
    const spec = { unwrapPath: "payload", rolePath: "role", content: { path: "content" }, tsPath: "timestamp" };
    const messages = await mapEntries(spec, [
      { timestamp: 1700000000000, type: "response_item", payload: { type: "message", role: "user", content: "hi" } },
      { timestamp: 1700000001000, role: "assistant", content: "yo" },
    ]);
    assert.deepEqual(roles(messages), ["user", "assistant"]);
    assert.equal(messages[0].content, "hi");
    // The timestamp lives on the envelope, not on the unwrapped payload.
    assert.equal(messages[0].createdAt, new Date(1700000000000).toISOString());
    assert.equal(messages[1].content, "yo");
  });

  test("match keeps only the configured entry kinds", async () => {
    const spec = { match: { path: "type", in: ["message"] }, rolePath: "role", content: { path: "content" } };
    const messages = await mapEntries(spec, [
      { type: "message", role: "user", content: "kept" },
      { type: "ai-title", role: "user", content: "dropped" },
    ]);
    assert.deepEqual(messages.map((m) => m.content), ["kept"]);
  });

  test("skipTypes drops sidechain branches", async () => {
    const spec = {
      rolePath: "role",
      content: { path: "content" },
      skipTypePath: "isSidechain",
      skipTypes: [true],
    };
    const messages = await mapEntries(spec, [
      { role: "user", content: "main" },
      { role: "assistant", content: "sidechain", isSidechain: true },
    ]);
    assert.deepEqual(messages.map((m) => m.content), ["main"]);
  });

  test("drop is role-scoped: injected user text goes, assistant text stays", async () => {
    const spec = {
      rolePath: "role",
      content: { path: "content" },
      drop: { startsWith: ["<", "# AGENTS.md"], roles: ["user"] },
    };
    const messages = await mapEntries(spec, [
      { role: "user", content: "<system-reminder>ignore</system-reminder>" },
      { role: "user", content: "# AGENTS.md instructions" },
      { role: "user", content: "real question" },
      { role: "assistant", content: "<system-reminder>keep me</system-reminder>" },
    ]);
    assert.deepEqual(messages.map((m) => m.content), ["real question", "<system-reminder>keep me</system-reminder>"]);
  });

  test("textOps strip injected blocks and extract the real query", () => {
    const ops = [
      { op: "stripXmlBlocks", tags: ["system-reminder", "cb_summary"], roles: ["user"] },
      { op: "extractXmlTag", tag: "user_query", roles: ["user"] },
    ];
    assert.equal(
      applyTextOps("<system-reminder>noise</system-reminder>hello", ops, "user"),
      "hello",
    );
    assert.equal(
      applyTextOps("<user_query>the actual prompt</user_query>", ops, "user"),
      "the actual prompt",
    );
    // role-scoped: the same text survives on an assistant message
    assert.equal(
      applyTextOps("<user_query>the actual prompt</user_query>", ops, "assistant"),
      "<user_query>the actual prompt</user_query>",
    );
    // a malformed tag name is ignored rather than turned into a regex
    assert.equal(applyTextOps("keep .* me", [{ op: "stripXmlBlocks", tags: [".*"] }], "user"), "keep .* me");
  });
});

describe("entry-map: externalized result follow-up", () => {
  const spec = (marker) => ({
    rolePath: "role",
    toolCall: {
      result: {
        typePath: "type",
        types: ["function_call_result"],
        idPath: "callId",
        resultPath: "output",
        follow: { marker: marker ?? "Full output saved to:" },
      },
    },
  });

  test("reads the real output back from inside the data root", async () => {
    const root = fs.mkdtempSync(path.join(tmpRoot, "follow-"));
    fs.writeFileSync(path.join(root, "out.txt"), "FULL OUTPUT BODY\n");
    const messages = await mapEntries(
      spec(),
      [
        { type: "function_call", callId: "c1", name: "bash" },
        {
          type: "function_call_result",
          callId: "c1",
          output: `<persisted-output> Output too large. Full output saved to: ${path.join(root, "out.txt")}`,
        },
      ],
      { root },
    );
    assert.equal(messages[0].content, "FULL OUTPUT BODY");
  });

  test("refuses a pointer outside the data root", async () => {
    const root = fs.mkdtempSync(path.join(tmpRoot, "follow-"));
    const elsewhere = fs.mkdtempSync(path.join(tmpRoot, "elsewhere-"));
    const target = path.join(elsewhere, "secret.txt");
    fs.writeFileSync(target, "SHOULD NOT BE READ");
    const messages = await mapEntries(
      spec(),
      [
        { type: "function_call", callId: "c1", name: "bash" },
        { type: "function_call_result", callId: "c1", output: `Full output saved to: ${target}` },
      ],
      { root },
    );
    assert.ok(messages[0].content.includes("Full output saved to:"));
    assert.ok(!messages[0].content.includes("SHOULD NOT BE READ"));
  });

  test("without a root there is nothing to follow", async () => {
    const messages = await mapEntries(
      spec(),
      [
        { type: "function_call", callId: "c1", name: "bash" },
        { type: "function_call_result", callId: "c1", output: "Full output saved to: /etc/passwd" },
      ],
      {},
    );
    assert.ok(messages[0].content.includes("/etc/passwd"));
  });
});
