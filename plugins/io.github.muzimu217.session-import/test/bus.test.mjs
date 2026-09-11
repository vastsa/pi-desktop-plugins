// @ts-check
/**
 * Unit tests for lib/bus.js — typed event bus + recent-import snapshot.
 *
 * Run:
 *   node --test test/bus.test.mjs
 */
"use strict";

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const PLUGIN_DIR = "/Users/blackevil/dev/pi-desktop-session-import";
const bus = require(`${PLUGIN_DIR}/lib/bus.js`);

describe("bus.EVENTS", () => {
  test("freezes so consumers cannot mutate the protocol", () => {
    const orig = bus.EVENTS.SESSION_IMPORTED;
    assert.throws(() => { bus.EVENTS.SESSION_IMPORTED = "nope"; }, TypeError);
    assert.strictEqual(bus.EVENTS.SESSION_IMPORTED, orig);
  });

  test("exposes all three event names used by main.js", () => {
    assert.strictEqual(bus.EVENTS.SESSION_IMPORTED, "session.imported");
    assert.strictEqual(bus.EVENTS.DISTILLATION_SAVED, "distillation.saved");
    assert.strictEqual(bus.EVENTS.SCAN_FAILED, "scan.failed");
  });
});

describe("bus.recordImport — recent snapshot", () => {
  test("records at/count/source and updates the snapshot in place", () => {
    const before = bus.recentImport.at;
    bus.recordImport({ count: 42, source: "claude-code" });
    assert.strictEqual(bus.recentImport.count, 42);
    assert.strictEqual(bus.recentImport.source, "claude-code");
    assert.ok(bus.recentImport.at instanceof Date);
    assert.ok(bus.recentImport.at.getTime() >= (before?.getTime() ?? 0),
      "at strictly non-decreasing");
  });

  test("emits SESSION_IMPORTED with a copy of the snapshot", () => {
    let captured = null;
    bus.once(bus.EVENTS.SESSION_IMPORTED, (payload) => { captured = payload; });
    bus.recordImport({ count: 1, source: "zcode" });
    assert.ok(captured);
    assert.strictEqual(captured.count, 1);
    assert.strictEqual(captured.source, "zcode");
    assert.ok(captured.at instanceof Date);
  });

  test("handles missing source (legacy commit may not have one)", () => {
    bus.recordImport({ count: 3 });
    assert.strictEqual(bus.recentImport.count, 3);
    assert.strictEqual(bus.recentImport.source, null);
  });
});

describe("bus.recordDistillation / recordScanFailure", () => {
  test("emits DISTILLATION_SAVED with at/path/bytes", () => {
    let captured = null;
    bus.once(bus.EVENTS.DISTILLATION_SAVED, (p) => { captured = p; });
    bus.recordDistillation({ path: "AGENTS.md", bytes: 4096 });
    assert.ok(captured);
    assert.strictEqual(captured.path, "AGENTS.md");
    assert.strictEqual(captured.bytes, 4096);
    assert.ok(captured.at instanceof Date);
  });

  test("emits SCAN_FAILED with structured payload (F-10 integration)", () => {
    let captured = null;
    bus.once(bus.EVENTS.SCAN_FAILED, (p) => { captured = p; });
    bus.recordScanFailure({ source: "zcode", code: "ENOENT", message: "no such file" });
    assert.ok(captured);
    assert.strictEqual(captured.source, "zcode");
    assert.strictEqual(captured.code, "ENOENT");
    assert.match(captured.message, /no such file/);
    assert.ok(captured.at instanceof Date);
  });
});

describe("listener management", () => {
  test("on + off cleanly detaches", () => {
    let count = 0;
    const fn = () => { count += 1; };
    bus.on(bus.EVENTS.SESSION_IMPORTED, fn);
    bus.recordImport({ count: 1, source: "zcode" });
    bus.off(bus.EVENTS.SESSION_IMPORTED, fn);
    bus.recordImport({ count: 2, source: "zcode" });
    assert.strictEqual(count, 1);
  });

  test("many listeners can attach without throwing", () => {
    const fns = [];
    for (let i = 0; i < 30; i++) {
      const f = () => {};
      bus.on(bus.EVENTS.SCAN_FAILED, f);
      fns.push(f);
    }
    for (const f of fns) bus.off(bus.EVENTS.SCAN_FAILED, f);
    assert.ok(true, "did not throw");
  });
});
