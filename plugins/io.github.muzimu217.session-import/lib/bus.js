/**
 * Tiny typed event bus for the session-import plugin.
 *
 * Why a bus at all? Cross-view state inside PI-Desktop plugins cannot use a
 * native push channel — `pluginBridge.invoke` is pull-only. The bus lives
 * inside main.js's Node process: importers emit `session.imported` after a
 * successful batch, and the forge view pulls a snapshot through the
 * `import.recent` channel on each refresh. The bus keeps that snapshot
 * race-free and lets future subscribers (notifications, Agent tools) tap in.
 *
 * Storage: small in-memory state, no persistence. The plugin process exits
 * when PI-Desktop unloads the plugin anyway.
 */
"use strict";

const { EventEmitter } = require("node:events");

/** Canonical event names — single source of truth across main.js + UI. */
const EVENTS = Object.freeze({
  /** Emitted after a successful official or legacy import batch. */
  SESSION_IMPORTED: "session.imported",
  /** Emitted after a successful forge.save (distilled rule written to disk). */
  DISTILLATION_SAVED: "distillation.saved",
  /** Emitted when a scan error is recorded (F-10 observability). */
  SCAN_FAILED: "scan.failed",
});

const emitter = new EventEmitter();
// Plugins can fire any number of events; don't crash the host on a single
// misbehaving listener.
emitter.setMaxListeners(50);

/** Snapshot of the most recent import — refreshable by forge view. */
const recentImport = {
  at: null, // Date
  count: 0,
  source: null,
};

function recordImport({ count, source }) {
  recentImport.at = new Date();
  recentImport.count = count;
  recentImport.source = source ?? null;
  emitter.emit(EVENTS.SESSION_IMPORTED, { ...recentImport });
}

function recordDistillation({ path, bytes }) {
  emitter.emit(EVENTS.DISTILLATION_SAVED, { at: new Date(), path, bytes });
}

function recordScanFailure({ source, code, message }) {
  emitter.emit(EVENTS.SCAN_FAILED, { source, code, message, at: new Date() });
}

function on(evt, listener) { emitter.on(evt, listener); }
function once(evt, listener) { emitter.once(evt, listener); }
function off(evt, listener) { emitter.off(evt, listener); }

module.exports = {
  EVENTS,
  recentImport,
  recordImport,
  recordDistillation,
  recordScanFailure,
  on, once, off,
};
