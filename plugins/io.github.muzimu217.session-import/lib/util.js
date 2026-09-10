/** Shared helpers for all source adapters. */
"use strict";

function toIso(value, fallback) {
  if (value !== undefined && value !== null) {
    const d = new Date(Number(value));
    if (!Number.isNaN(d.getTime())) return d.toISOString();
    // Also accepts ISO strings passthrough via Date parsing above only for
    // epoch numbers; strings go through the generic parser below.
    const d2 = new Date(value);
    if (!Number.isNaN(d2.getTime())) return d2.toISOString();
  }
  return fallback ?? new Date().toISOString();
}

function truncateTitle(text, max = 60) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function projectNameOf(projectPath) {
  if (!projectPath) return null;
  const clean = String(projectPath).replace(/[\\/]+$/, "");
  return clean.split(/[\\/]/).pop() || null;
}

module.exports = { toIso, truncateTitle, projectNameOf };
