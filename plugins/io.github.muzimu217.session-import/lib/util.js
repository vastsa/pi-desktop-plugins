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

/**
 * Bounded-concurrency map that preserves input order.
 *
 * Scans are I/O bound (hundreds of multi-MB transcripts), so running them one
 * at a time wastes the whole scan on read latency. `limit` caps how many file
 * handles we hold open at once. A throwing worker resolves to `{ok:false}` so
 * one bad file never sinks the batch — callers filter on `.ok`.
 */
async function mapWithConcurrency(items, limit, worker) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  const width = Math.max(1, Math.min(Number(limit) || 1, list.length || 1));
  let cursor = 0;
  const runners = Array.from({ length: width }, async () => {
    while (cursor < list.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = { ok: true, value: await worker(list[index], index) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

/** Same as {@link mapWithConcurrency} but returns the successful values only. */
async function mapValuesWithConcurrency(items, limit, worker) {
  const results = await mapWithConcurrency(items, limit, worker);
  return results.filter((r) => r.ok).map((r) => r.value);
}

module.exports = {
  toIso,
  truncateTitle,
  projectNameOf,
  mapWithConcurrency,
  mapValuesWithConcurrency,
};
