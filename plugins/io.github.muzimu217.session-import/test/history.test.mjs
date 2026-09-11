// @ts-check
/**
 * Unit tests for lib/history.js — JSONL distillation-history ring buffer.
 * Run: node --test test/history.test.mjs
 */
"use strict";

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  HISTORY_LIMIT,
  HISTORY_PATH,
  parseJsonl,
  serializeEntry,
  toJsonl,
  addEntry,
} = require("../lib/history.js");

describe("lib/history parseJsonl", () => {
  test("empty / blank input yields []", () => {
    assert.deepStrictEqual(parseJsonl(""), []);
    assert.deepStrictEqual(parseJsonl("   \n\n  "), []);
  });

  test("parses one entry per non-blank line", () => {
    const text = [
      JSON.stringify({ a: 1 }),
      "",
      JSON.stringify({ b: 2 }),
    ].join("\n");
    assert.deepStrictEqual(parseJsonl(text), [{ a: 1 }, { b: 2 }]);
  });

  test("skips malformed lines instead of throwing", () => {
    const text = [JSON.stringify({ a: 1 }), "not json {", JSON.stringify({ b: 2 })].join("\n");
    assert.deepStrictEqual(parseJsonl(text), [{ a: 1 }, { b: 2 }]);
  });
});

describe("lib/history addEntry cap", () => {
  test("keeps the most recent HISTORY_LIMIT entries", () => {
    let entries = [];
    for (let i = 0; i < HISTORY_LIMIT + 10; i++) entries = addEntry(entries, { n: i });
    assert.strictEqual(entries.length, HISTORY_LIMIT);
    assert.strictEqual(entries[0].n, 10); // oldest survivor
    assert.strictEqual(entries[entries.length - 1].n, HISTORY_LIMIT + 9); // newest
  });
});

describe("lib/history round-trip", () => {
  test("toJsonl -> parseJsonl preserves entries", () => {
    const entries = [{ a: 1 }, { b: 2, c: "x" }];
    const back = parseJsonl(toJsonl(entries));
    assert.deepStrictEqual(back, entries);
  });

  test("serializeEntry emits a single line", () => {
    assert.strictEqual(serializeEntry({ a: 1 }).includes("\n"), false);
  });

  test("HISTORY_PATH lives under the docs/** fs scope", () => {
    assert.ok(HISTORY_PATH.startsWith("docs/"), HISTORY_PATH);
  });
});
