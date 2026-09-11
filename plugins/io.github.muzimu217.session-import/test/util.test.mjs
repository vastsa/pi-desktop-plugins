// @ts-check
/**
 * Unit tests for lib/util.js — toIso / truncateTitle / projectNameOf.
 * These are the helpers every source adapter depends on for title/timestamp
 * normalization. Edge cases here are common breaking points (null, undefined,
 * epoch ms vs ISO string).
 *
 * Run:
 *   node --test test/util.test.mjs
 */
"use strict";

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const PLUGIN_DIR = "/Users/blackevil/dev/pi-desktop-session-import";
const { toIso, truncateTitle, projectNameOf } = require(`${PLUGIN_DIR}/lib/util.js`);

describe("util.toIso", () => {
  test("accepts epoch ms (number)", () => {
    const ms = 1725840000000; // 2024-09-09T00:00:00Z
    assert.strictEqual(toIso(ms), "2024-09-09T00:00:00.000Z");
  });

  test("accepts ISO string passthrough", () => {
    assert.strictEqual(toIso("2024-09-09T00:00:00.000Z"), "2024-09-09T00:00:00.000Z");
  });

  test("falls back to fallback arg when invalid", () => {
    const fb = "2024-01-01T00:00:00.000Z";
    assert.strictEqual(toIso("not-a-date", fb), fb);
  });

  test("falls back to now (ISO string) when invalid and no fallback", () => {
    const r = toIso("not-a-date");
    assert.match(r, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  test("null and undefined each fall through to fallback", () => {
    const fb = "2024-01-01T00:00:00.000Z";
    assert.strictEqual(toIso(null, fb), fb);
    assert.strictEqual(toIso(undefined, fb), fb);
  });
});

describe("util.truncateTitle", () => {
  test("returns empty for null / undefined / empty / whitespace", () => {
    assert.strictEqual(truncateTitle(null), "");
    assert.strictEqual(truncateTitle(undefined), "");
    assert.strictEqual(truncateTitle(""), "");
    assert.strictEqual(truncateTitle("   \n  "), "");
  });

  test("collapses whitespace and trims before measuring length", () => {
    assert.strictEqual(truncateTitle("hello\n\n\t  world"), "hello world");
  });

  test("passes through short titles", () => {
    assert.strictEqual(truncateTitle("hello world"), "hello world");
  });

  test("truncates at default 60 chars with ellipsis", () => {
    const long = "a".repeat(100);
    const out = truncateTitle(long);
    assert.strictEqual(out.length, 61); // 60 + the ellipsis char
    assert.match(out, /…$/);
  });

  test("respects custom max", () => {
    const out = truncateTitle("abcdefgh", 5);
    assert.strictEqual(out, "abcde…");
  });

  test("does NOT truncate when length is exactly the max", () => {
    const s = "x".repeat(60);
    assert.strictEqual(truncateTitle(s), s);
  });
});

describe("util.projectNameOf", () => {
  test("null / empty returns null", () => {
    assert.strictEqual(projectNameOf(null), null);
    assert.strictEqual(projectNameOf(""), null);
    assert.strictEqual(projectNameOf(undefined), null);
  });

  test("returns last segment of unix path", () => {
    assert.strictEqual(projectNameOf("/home/user/projects/foo"), "foo");
  });

  test("returns last segment of windows path", () => {
    assert.strictEqual(projectNameOf("C:\\Users\\me\\bar"), "bar");
  });

  test("strips trailing separators", () => {
    assert.strictEqual(projectNameOf("/tmp/proj/"), "proj");
    assert.strictEqual(projectNameOf("/tmp/proj///"), "proj");
  });

  test("single-segment path returns that segment", () => {
    assert.strictEqual(projectNameOf("proj"), "proj");
  });
});
