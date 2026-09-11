// @ts-check
/**
 * Tests for lib/custom-sources.js — the security boundary of the
 * extensibility layer.
 *
 * The plugin runs with full read access to the user's home directory, so a
 * config file that could smuggle in behaviour would be arbitrary code
 * execution. These tests pin that down: specs must be pure data, must not
 * shadow built-ins, and must name a registered driver.
 *
 * Run:
 *   node --test test/custom-sources.test.mjs
 */
"use strict";

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const PLUGIN_DIR = "/Users/blackevil/dev/pi-desktop-session-import";
const cs = require(`${PLUGIN_DIR}/lib/custom-sources.js`);
const { makeDeclarativeSource } = require(`${PLUGIN_DIR}/lib/sources/declarative.js`);

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sicfg-"));
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  return root;
}

function writeConfig(root, value) {
  fs.writeFileSync(
    path.join(root, cs.CONFIG_PATH),
    typeof value === "string" ? value : JSON.stringify(value),
  );
}

const validSpec = (over = {}) => ({
  id: "mytool",
  label: "My Tool",
  driver: "jsonl-transcript",
  root: path.join(os.homedir(), ".mytool", "sessions"),
  entry: { rolePath: "role", content: { path: "content" } },
  ...over,
});

describe("validateSpec", () => {
  test("accepts a well-formed spec", () => {
    const { ok, errors, spec } = cs.validateSpec(validSpec(), 0);
    assert.equal(ok, true, errors.join("; "));
    assert.deepEqual(errors, []);
    assert.equal(spec.id, "mytool");
    assert.ok(path.isAbsolute(spec.root), "root is resolved to an absolute path");
  });

  test("rejects keys that would turn data into behaviour", () => {
    for (const key of ["eval", "code", "require", "transform", "script", "__proto__"]) {
      const { ok, errors } = cs.validateSpec({ ...validSpec(), [key]: "console.log(1)" }, 0);
      assert.equal(ok, false, `spec with "${key}" must be rejected`);
      assert.ok(
        errors.some((e) => e.toLowerCase().includes("forbidden")),
        `expected a "forbidden key" error for ${key}, got: ${errors.join("; ")}`,
      );
    }
  });

  test("rejects a nested forbidden key (deep in the spec)", () => {
    const spec = validSpec({ entry: { rolePath: "role", content: { path: "content" }, eval: "x" } });
    const { ok, errors } = cs.validateSpec(spec, 0);
    assert.equal(ok, false);
    assert.ok(errors.some((e) => e.includes("entry.eval")), errors.join("; "));
  });

  test("rejects non-data values (functions)", () => {
    const spec = validSpec({ entry: { rolePath: "role", content: { path: "content" }, helper: () => 1 } });
    const { ok, errors } = cs.validateSpec(spec, 0);
    assert.equal(ok, false);
    assert.ok(errors.some((e) => e.includes("unsupported value type")), errors.join("; "));
  });

  test("rejects ids that shadow a built-in source", () => {
    for (const id of cs.BUILTIN_IDS) {
      const { ok, errors } = cs.validateSpec(validSpec({ id }), 0);
      assert.equal(ok, false, `"${id}" must not be overridable`);
      assert.ok(errors.some((e) => e.includes("built-in")), errors.join("; "));
    }
  });

  test("rejects malformed ids", () => {
    for (const id of ["", "bad id!", "9leading", "a".repeat(80)]) {
      const { ok } = cs.validateSpec(validSpec({ id }), 0);
      assert.equal(ok, false, `id "${id}" must be rejected`);
    }
  });

  test("rejects unknown drivers", () => {
    const { ok, errors } = cs.validateSpec(validSpec({ driver: "totally-custom" }), 0);
    assert.equal(ok, false);
    assert.ok(errors.some((e) => e.includes("must be one of")), errors.join("; "));
  });

  test("rejects absurdly broad data roots", () => {
    for (const root of ["/", os.homedir()]) {
      const { ok, errors } = cs.validateSpec(validSpec({ root }), 0);
      assert.equal(ok, false, `root "${root}" must be rejected`);
      assert.ok(errors.some((e) => e.includes("refusing")), errors.join("; "));
    }
  });

  test("expands ~ in paths", () => {
    const { ok, spec } = cs.validateSpec(validSpec({ root: "~/.mytool/sessions" }), 0);
    assert.equal(ok, true);
    assert.ok(spec.root.startsWith(os.homedir()));
    assert.ok(!spec.root.includes("~"));
  });

  test("requires a db path for the sqlite driver", () => {
    const { ok, errors } = cs.validateSpec(
      { id: "sqltool", label: "SQL", driver: "sqlite-session" },
      0,
    );
    assert.equal(ok, false);
    assert.ok(errors.some((e) => e.includes(".db")), errors.join("; "));
  });
});

describe("loadCustomSources", () => {
  test("no config file -> no specs, no errors", async () => {
    const root = workspace();
    const res = await cs.loadCustomSources({ workspaceRoot: root });
    assert.deepEqual(res.specs, []);
    assert.deepEqual(res.errors, []);
  });

  test("loads a valid config (array form)", async () => {
    const root = workspace();
    writeConfig(root, [validSpec()]);
    const res = await cs.loadCustomSources({ workspaceRoot: root });
    assert.equal(res.specs.length, 1);
    assert.equal(res.specs[0].id, "mytool");
    assert.deepEqual(res.errors, []);
  });

  test("loads a valid config (object form with sources[])", async () => {
    const root = workspace();
    writeConfig(root, { sources: [validSpec({ id: "other" })] });
    const res = await cs.loadCustomSources({ workspaceRoot: root });
    assert.equal(res.specs.length, 1);
    assert.equal(res.specs[0].id, "other");
  });

  test("malformed JSON is reported, not thrown", async () => {
    const root = workspace();
    writeConfig(root, "{ not json");
    const res = await cs.loadCustomSources({ workspaceRoot: root });
    assert.deepEqual(res.specs, []);
    assert.ok(res.errors.some((e) => e.includes("not valid JSON")));
  });

  test("invalid specs are skipped and reported", async () => {
    const root = workspace();
    writeConfig(root, [validSpec(), validSpec({ id: "opencode" }), validSpec({ driver: "nope" })]);
    const res = await cs.loadCustomSources({ workspaceRoot: root });
    assert.equal(res.specs.length, 1); // only the valid one
    assert.ok(res.errors.length >= 2);
  });

  test("an oversized config is refused", async () => {
    const root = workspace();
    writeConfig(root, `[${JSON.stringify(validSpec())},${" ".repeat(600 * 1024)}]`);
    const res = await cs.loadCustomSources({ workspaceRoot: root });
    assert.deepEqual(res.specs, []);
    assert.ok(res.errors.some((e) => e.includes("too large")));
  });

  test("supports an injected reader (host fs bridge)", async () => {
    let asked = null;
    const res = await cs.loadCustomSources({
      readText: async (rel) => {
        asked = rel;
        return JSON.stringify([validSpec({ id: "viareader" })]);
      },
    });
    assert.equal(asked, cs.CONFIG_PATH);
    assert.equal(res.specs.length, 1);
    assert.equal(res.specs[0].id, "viareader");
  });

  test("a missing file via the injected reader yields no sources", async () => {
    const res = await cs.loadCustomSources({
      readText: async () => {
        throw new Error("ENOENT");
      },
    });
    assert.deepEqual(res.specs, []);
    assert.deepEqual(res.errors, []);
  });
});

describe("end-to-end: config -> working adapter", () => {
  test("a source declared in config actually scans real files", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "sie2e-"));
    const dataDir = path.join(home, ".mytool", "sessions");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, "s1.jsonl"),
      JSON.stringify({ role: "user", content: "hello from custom source" }) + "\n" +
        JSON.stringify({ role: "assistant", content: "hi" }) + "\n",
    );

    const wsRoot = workspace();
    writeConfig(wsRoot, [
      {
        id: "mytool",
        label: "My Tool",
        driver: "jsonl-transcript",
        root: dataDir,
        entry: { rolePath: "role", content: { path: "content" } },
      },
    ]);

    const { specs, errors } = await cs.loadCustomSources({ workspaceRoot: wsRoot });
    assert.deepEqual(errors, []);
    assert.equal(specs.length, 1);

    const adapter = makeDeclarativeSource(specs[0]);
    const summaries = await adapter.scan();
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].messageCount, 2);
    const { messages } = await adapter.convert(summaries[0]);
    assert.equal(messages[0].content, "hello from custom source");
  });
});

describe("end-to-end: config -> registry -> pipeline", () => {
  test("a custom source becomes reachable through allAdapters/getAdapter", async () => {
    const registry = require(`${PLUGIN_DIR}/lib/registry.js`);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "sireg-"));
    const dataDir = path.join(home, ".mytool", "sessions");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, "s1.jsonl"),
      JSON.stringify({ role: "user", content: "registry integration" }) + "\n",
    );

    const wsRoot = workspace();
    writeConfig(wsRoot, [
      {
        id: "mytool",
        label: "My Tool",
        driver: "jsonl-transcript",
        root: dataDir,
        entry: { rolePath: "role", content: { path: "content" } },
      },
    ]);

    const dynamic = await registry.refreshDynamicSources({ workspaceRoot: wsRoot });
    assert.equal(dynamic.length, 1);
    assert.equal(dynamic[0].source, "mytool");

    // Built-ins stay at 6 (ADR 0008) while the pipeline sees 7.
    assert.equal(registry.ADAPTERS.length, 6);
    assert.equal(registry.allAdapters().length, 7);
    assert.ok(registry.getAdapter("mytool"), "custom source is resolvable");

    // ...and it really scans through the same entry point main.js uses.
    const summaries = await registry.getAdapter("mytool").scan();
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].messageCount, 1);
  });

  test("built-ins always win when a spec tries to shadow one", async () => {
    const registry = require(`${PLUGIN_DIR}/lib/registry.js`);
    const wsRoot = workspace();
    // "opencode" is a built-in; validation must refuse to register it.
    writeConfig(wsRoot, [
      { id: "opencode", label: "Fake", driver: "jsonl-transcript", root: "/tmp" },
    ]);
    const dynamic = await registry.refreshDynamicSources({ workspaceRoot: wsRoot });
    assert.equal(dynamic.length, 0);
    const report = registry.getDynamicLoadReport();
    assert.ok(report.errors.some((e) => e.includes("built-in")));
    assert.notEqual(registry.getAdapter("opencode").label, "Fake");
  });
});

describe("custom sources: real-world spec shapes stay valid data", () => {
  test("toolCall / textOps / follow / unwrapPath specs are accepted", () => {
    // These are the shapes the built-in Claude/WorkBuddy/Codex adapters need.
    // None of them may be rejected by the declarative-only denylist.
    const spec = {
      id: "claude-like",
      label: "Claude-like",
      driver: "jsonl-transcript",
      root: "~/.claude/projects",
      maxDepth: 2,
      session: {
        idFrom: { first: [{ path: "payload.id" }, { path: "id" }] },
        idFromEntry: { path: "type", in: ["session_meta"] },
        titleFrom: "firstUser",
      },
      entry: {
        unwrapPath: "payload",
        match: { path: "type", in: ["user", "assistant"] },
        rolePath: "message.role",
        content: { blocks: { path: "message.content", typeField: "type", types: ["text"], textField: "text" } },
        tsPath: "timestamp",
        drop: { startsWith: ["<"], roles: ["user"] },
        textOps: [
          { op: "stripXmlBlocks", tags: ["system-reminder"], roles: ["user"] },
          { op: "extractXmlTag", tag: "user_query", roles: ["user"] },
        ],
        toolCall: {
          callBlocks: { path: "message.content", typeField: "type", type: "tool_use", idPath: "id", namePath: "name", argsPath: "input", roles: ["assistant"] },
          resultBlocks: { path: "message.content", typeField: "type", type: "tool_result", idPath: "tool_use_id", resultPath: "content", statusPath: "is_error", roles: ["user"] },
          emitUnpaired: true,
        },
      },
    };
    const { ok, errors } = cs.validateSpec(spec, 0);
    assert.deepEqual(errors, []);
    assert.equal(ok, true);
  });

  test("a follow rule cannot widen the read scope beyond the data root", () => {
    // follow is data, so it passes validation; the containment check lives in
    // the mapper (see entry-map tests) and must stay there.
    const { ok } = cs.validateSpec(
      {
        id: "with-follow",
        label: "Follow",
        driver: "jsonl-transcript",
        root: "~/.mytool/sessions",
        entry: { toolCall: { result: { follow: { marker: "Full output saved to:", maxBytes: 1024 } } } },
      },
      0,
    );
    assert.equal(ok, true);
  });
});
