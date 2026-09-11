// @ts-check
/**
 * Unit tests for lib/save-modes.js — the three distillation save combiners.
 * Run: node --test test/save-modes.test.mjs
 */
"use strict";

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { combine, normalize, isMode, hasMergeSection, wrapSection, MERGE_START, MERGE_END } = require("../lib/save-modes.js");

describe("lib/save-modes combine", () => {
  test("overwrite replaces existing entirely", () => {
    assert.strictEqual(combine("OLD CONTENT", "NEW", "overwrite"), "NEW");
  });

  test("overwrite is the fallback for unknown modes", () => {
    assert.strictEqual(combine("OLD", "NEW", "bogus"), "NEW");
    assert.strictEqual(combine("OLD", "NEW", undefined), "NEW");
  });

  test("append onto empty file == incoming", () => {
    assert.strictEqual(combine("", "NEW", "append"), "NEW");
  });

  test("append joins with a blank line separator", () => {
    assert.strictEqual(combine("OLD", "NEW", "append"), "OLD\n\nNEW");
  });

  test("merge on a fresh file wraps the incoming text in markers", () => {
    const out = combine("", "DISTILLED", "merge");
    assert.strictEqual(out, `${MERGE_START}\nDISTILLED\n${MERGE_END}`);
    assert.ok(hasMergeSection(out));
  });

  test("merge replaces only the marked section, keeping surrounding prose", () => {
    const existing = [
      "# Project conventions",
      "",
      MERGE_START,
      "OLD DISTILLED",
      MERGE_END,
      "",
      "## Notes",
      "hand-written section",
    ].join("\n");
    const out = combine(existing, "NEW DISTILLED", "merge");
    assert.ok(out.startsWith("# Project conventions"));
    assert.ok(out.includes("## Notes"));
    assert.ok(out.includes("hand-written section"));
    assert.ok(out.includes("NEW DISTILLED"));
    assert.ok(!out.includes("OLD DISTILLED"));
    // exactly one marker pair remains
    assert.strictEqual(out.split(MERGE_START).length - 1, 1);
    assert.strictEqual(out.split(MERGE_END).length - 1, 1);
  });

  test("merge onto an unmarked file appends a wrapped section", () => {
    const out = combine("# Heading\n\nprose", "DISTILLED", "merge");
    assert.ok(out.startsWith("# Heading"));
    assert.ok(out.includes(wrapSection("DISTILLED")));
  });
});

describe("lib/save-modes helpers", () => {
  test("isMode recognizes only the three modes", () => {
    assert.ok(isMode("overwrite") && isMode("append") && isMode("merge"));
    assert.ok(!isMode("delete"));
  });
  test("normalize maps unknown to overwrite", () => {
    assert.strictEqual(normalize("merge"), "merge");
    assert.strictEqual(normalize("nope"), "overwrite");
  });
  test("hasMergeSection detects markers", () => {
    assert.ok(hasMergeSection(wrapSection("x")));
    assert.ok(!hasMergeSection("no markers here"));
  });
});
