/**
 * lib/history.js — distillation history as a JSONL ring buffer.
 *
 * Pure (no host dependency). Persistence is handled by main.js through the
 * host `pi.fs` API; this module only (de)serializes and caps the buffer.
 *
 * Stored at HISTORY_PATH (within the plugin's `fs.write`/`fs.read` scope:
 * `docs/**`), one JSON object per line, newest last, capped at HISTORY_LIMIT.
 */
"use strict";

const HISTORY_LIMIT = 50;
const HISTORY_PATH = "docs/.session-import-history.jsonl";

/**
 * Parse JSONL text into an array of entries. Malformed/blank lines are
 * skipped so a partially-written file never crashes the loader.
 * @param {string} text
 * @returns {Array<object>}
 */
function parseJsonl(text) {
  if (!text) return [];
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed);
      if (entry && typeof entry === "object") out.push(entry);
    } catch {
      // skip unparseable line
    }
  }
  return out;
}

/** Serialize one entry to a single JSON line. */
function serializeEntry(entry) {
  return JSON.stringify(entry);
}

/** Serialize the full entry list back to JSONL text. */
function toJsonl(entries) {
  const body = entries.map(serializeEntry).join("\n");
  return body ? body + "\n" : "";
}

/**
 * Append an entry and keep only the most recent HISTORY_LIMIT entries.
 * @param {Array<object>} entries current entries
 * @param {object} entry entry to append
 * @returns {Array<object>}
 */
function addEntry(entries, entry) {
  const next = [...(entries || []), entry];
  return next.slice(-HISTORY_LIMIT);
}

module.exports = {
  HISTORY_LIMIT,
  HISTORY_PATH,
  parseJsonl,
  serializeEntry,
  toJsonl,
  addEntry,
};
