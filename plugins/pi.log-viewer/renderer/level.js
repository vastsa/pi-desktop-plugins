"use strict";

(function exposeLevel(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.LogLevel = api;
})(typeof globalThis === "object" ? globalThis : this, () => {
  const LEVEL_MAP = Object.freeze({
    FATAL: "error",
    ERROR: "error",
    WARN: "warn",
    WARNING: "warn",
    INFO: "info",
    DEBUG: "debug",
    TRACE: "debug",
  });
  const LEVELS = Object.freeze(["error", "warn", "info", "debug", "other"]);
  const TOKEN = "FATAL|ERROR|WARN|WARNING|INFO|DEBUG|TRACE";
  const PIPE_RE = new RegExp(`(?:^|\\|)\\s*(${TOKEN})\\s*(?=\\||$)`, "i");
  const BRACKET_RE = new RegExp(`(?:\\[|\\()\\s*(${TOKEN})\\s*(?:\\]|\\))`, "i");
  const KEYED_RE = new RegExp(`(?:^|[^\\w])(?:level|severity|lvl)\\s*[:=]\\s*(${TOKEN})\\b`, "i");
  const LEADING_RE = new RegExp(
    `^\\s*(?:\\d{4}[-/]\\d{2}[-/]\\d{2}(?:[T ]\\d{2}:\\d{2}:\\d{2}(?:[.,]\\d{1,6})?(?:Z|[+-]\\d{2}:?\\d{2})?)?\\s*)?(?:\\[[^\\]]+\\]\\s*)?(?:[-|]\\s*)?(${TOKEN})(?=\\s|[:|,\\-]|$)`,
    "i",
  );
  const DELIMITED_RE = new RegExp(`(?:^|[|\\-])\\s*(${TOKEN})\\s*(?=[|\\-:]|$)`, "i");
  const FALLBACK_RE = new RegExp(`\\b(${TOKEN})\\b`, "i");

  /** Uppercase delimited tokens — cheap indexOf fast path before regex. */
  const QUICK_DELIMS = Object.freeze([
    ["|ERROR|", "error"],
    ["|FATAL|", "error"],
    ["|WARN|", "warn"],
    ["|WARNING|", "warn"],
    ["|INFO|", "info"],
    ["|DEBUG|", "debug"],
    ["|TRACE|", "debug"],
    ["[ERROR]", "error"],
    ["[FATAL]", "error"],
    ["[WARN]", "warn"],
    ["[WARNING]", "warn"],
    ["[INFO]", "info"],
    ["[DEBUG]", "debug"],
    ["[TRACE]", "debug"],
  ]);

  function normalise(raw) {
    return raw ? LEVEL_MAP[String(raw).toUpperCase()] || null : null;
  }

  function find(line, pattern) {
    const match = pattern.exec(line);
    return match ? normalise(match[1]) : null;
  }

  /**
   * Detect a level from a physical log line. Structured fields have priority;
   * the unstructured token fallback is intentionally last so a field such as
   * `|INFO|` wins over an ERROR mentioned by the message body.
   */
  function detectLevel(value) {
    const line = String(value || "");
    for (let i = 0; i < QUICK_DELIMS.length; i += 1) {
      if (line.includes(QUICK_DELIMS[i][0])) return QUICK_DELIMS[i][1];
    }
    let level = find(line, PIPE_RE);
    if (level) return level;
    level = find(line, BRACKET_RE);
    if (level) return level;
    const keyed = KEYED_RE.exec(line);
    level = keyed ? normalise(keyed[1]) : null;
    if (level) return level;
    level = find(
      line,
      LEADING_RE,
    );
    if (level) return level;
    level = find(line, DELIMITED_RE);
    if (level) return level;
    return find(line, FALLBACK_RE);
  }

  function levelFromLine(value) {
    return detectLevel(value) || "other";
  }

  return { LEVEL_MAP, LEVELS, detectLevel, levelFromLine, normalise };
});
