// @ts-check
/**
 * Unit tests for lib/i18n.js — the view-side i18n dictionary + getMessage.
 *
 * Run:
 *   node --test test/i18n.test.mjs
 */
"use strict";

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { getMessage, detectLocale, DICT, LOCALES } = require("../lib/i18n.js");

describe("lib/i18n getMessage", () => {
  test("zh-CN resolves the Chinese string", () => {
    assert.strictEqual(getMessage("zh-CN", "importer.scan"), "扫描本机工具");
  });

  test("en resolves the English string", () => {
    assert.strictEqual(getMessage("en", "importer.scan"), "Scan local tools");
  });

  test("unknown locale falls back to zh-CN", () => {
    assert.strictEqual(getMessage("fr", "importer.scan"), "扫描本机工具");
  });

  test("missing key falls back to the key itself", () => {
    assert.strictEqual(getMessage("en", "does.not.exist"), "does.not.exist");
  });

  test("interpolates {count} placeholder", () => {
    assert.strictEqual(
      getMessage("zh-CN", "importer.count.sessions", { count: 12 }),
      "12 个会话",
    );
    assert.strictEqual(
      getMessage("en", "importer.count.sessions", { count: 12 }),
      "12 sessions",
    );
  });

  test("interpolates multiple placeholders in order", () => {
    assert.strictEqual(
      getMessage("zh-CN", "importer.notify.body", { source: "zcode", count: 3 }),
      "已通过「zcode」导入 3 个会话。点击右侧「会话熔炉」开始蒸馏。",
    );
  });

  test("unknown placeholder is left verbatim (no crash)", () => {
    assert.strictEqual(
      getMessage("en", "importer.imported", { wrong: 5 }),
      "Imported {count} sessions",
    );
  });

  test("every zh-CN key has a matching en key", () => {
    const en = Object.keys(DICT.en).sort();
    const zh = Object.keys(DICT["zh-CN"]).sort();
    assert.deepStrictEqual(en, zh, "en and zh-CN dictionaries must stay in lockstep");
  });

  test("LOCALES lists both supported locales", () => {
    assert.deepStrictEqual(LOCALES.sort(), ["en", "zh-CN"]);
  });
});

describe("lib/i18n detectLocale", () => {
  test("zh navigator yields zh-CN", () => {
    assert.strictEqual(detectLocale({ language: "zh-CN", languages: ["zh-CN", "en"] }), "zh-CN");
  });

  test("en navigator yields en", () => {
    assert.strictEqual(detectLocale({ language: "en-US", languages: ["en-US"] }), "en");
  });
});
