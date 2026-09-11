/**
 * lib/save-modes.js — combiners for the three distillation save modes.
 *
 * Pure (no host dependency) so it is fully unit-testable.
 *   - overwrite: replace the target file entirely
 *   - append:    add the new distilled text after a blank line
 *   - merge:     keep a fenced section delimited by markers; replace that
 *                section on repeat runs, or append it on first run.
 */
"use strict";

const MERGE_START = "<!-- session-import:distilled -->";
const MERGE_END = "<!-- /session-import:distilled -->";

const MODES = ["overwrite", "append", "merge"];

function isMode(value) {
  return MODES.includes(value);
}

function normalize(mode) {
  return isMode(mode) ? mode : "overwrite";
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Wrap incoming distilled text in merge markers. */
function wrapSection(incoming) {
  return `${MERGE_START}\n${incoming}\n${MERGE_END}`;
}

/**
 * Combine existing file content with newly distilled content.
 * @param {string} existing current file content (may be "")
 * @param {string} incoming newly distilled content
 * @param {string} mode one of MODES (anything else → overwrite)
 * @returns {string}
 */
function combine(existing, incoming, mode) {
  const m = normalize(mode);
  if (m === "overwrite") return incoming;
  if (m === "append") {
    if (!existing) return incoming;
    return `${existing}\n\n${incoming}`;
  }
  // merge
  if (!existing) return wrapSection(incoming);
  const re = new RegExp(`${escapeRegex(MERGE_START)}[\\s\\S]*?${escapeRegex(MERGE_END)}`);
  if (re.test(existing)) return existing.replace(re, wrapSection(incoming));
  return `${existing}\n\n${wrapSection(incoming)}`;
}

/** True when existing content already carries a merge section. */
function hasMergeSection(existing) {
  return typeof existing === "string" && existing.includes(MERGE_START);
}

module.exports = {
  MODES,
  MERGE_START,
  MERGE_END,
  isMode,
  normalize,
  wrapSection,
  combine,
  hasMergeSection,
};
