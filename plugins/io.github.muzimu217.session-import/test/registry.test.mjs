// @ts-check
/**
 * Tests for lib/registry.js — every supported source id must be reachable
 * via getAdapter, and each adapter must expose scan/convert functions with
 * the documented shape.
 *
 * Run:
 *   node --test test/registry.test.mjs
 */
"use strict";

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const { ADAPTERS, getAdapter } = require(`${PLUGIN_DIR}/lib/registry.js`);

const EXPECTED_SOURCES = ["zcode", "workbuddy", "claude-code", "codex", "opencode", "pi"];

describe("registry", () => {
  test("ADAPTERS has exactly 6 sources (mandatory by ADR 0008)", () => {
    assert.strictEqual(ADAPTERS.length, 6);
  });

  for (const source of EXPECTED_SOURCES) {
    test(`registers source ${source}`, () => {
      const a = getAdapter(source);
      assert.ok(a, `getAdapter("${source}") returned falsy`);
      assert.strictEqual(a.source, source);
      assert.strictEqual(typeof a.scan, "function");
      assert.strictEqual(typeof a.convert, "function");
      assert.ok(a.label && typeof a.label === "string", "has a non-empty label");
    });
  }

  test("getAdapter returns null for unknown source", () => {
    assert.strictEqual(getAdapter("nope"), null);
    assert.strictEqual(getAdapter(""), null);
  });

  test("all sources have a non-empty label (UI dependency)", () => {
    for (const a of ADAPTERS) {
      assert.ok(a.label && a.label.length > 0, `label for ${a.source} is empty`);
    }
  });

  test("all source ids match the plugin-sdk contributes.sessionSources regex", () => {
    // plugin-sdk/src/index.ts: id 正则 ^[a-zA-Z][a-zA-Z0-9._-]{0,63}$
    const re = /^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/;
    for (const a of ADAPTERS) {
      assert.match(a.source, re, `${a.source} does not match the source id regex`);
    }
  });
});
