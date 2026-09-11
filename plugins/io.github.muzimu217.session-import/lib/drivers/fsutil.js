/**
 * Filesystem helpers shared by the format drivers.
 *
 * Every driver walks user-configured paths, so all traversal here is
 * best-effort and bounded: `~` expansion, absolute resolution, a hard cap on
 * how many files are collected, and a per-file size ceiling so a huge or
 * accidentally-overlapping root cannot stall a scan (the plugin's watchdog
 * timeouts are the outer backstop).
 */
"use strict";

const os = require("node:os");
const path = require("node:path");
const fsp = require("node:fs/promises");

// Bounded defaults: a user-configured root must never be able to turn a scan
// into an unbounded filesystem walk. Specs may override, but these are the
// safety rails applied when they do not.
const DEFAULT_MAX_FILES = 2000;
const DEFAULT_MAX_FILE_BYTES = 32 * 1024 * 1024; // 32 MiB

function expandHome(p, home = os.homedir()) {
  if (typeof p !== "string" || p === "") return p;
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
}

const EXTENSION_RE = /^\.[A-Za-z0-9]{1,16}$/;

/** True for POSIX `/` and Windows drive roots such as `C:\`. */
function isFilesystemRoot(p) {
  if (typeof p !== "string" || !p) return false;
  const n = path.normalize(p);
  if (n === path.sep) return true;
  if (/^[A-Za-z]:[\\/]?$/.test(n) || /^[A-Za-z]:[\\/]?$/.test(p.trim())) return true;
  const root = path.parse(n).root;
  return Boolean(root) && n === path.normalize(root);
}

function resolveSafe(p, home = os.homedir()) {
  const expanded = expandHome(p, home);
  return path.normalize(path.isAbsolute(expanded) ? expanded : path.resolve(expanded));
}

function isInside(file, root) {
  if (typeof file !== "string" || typeof root !== "string" || !file || !root) return false;
  const a = path.resolve(file);
  const b = path.resolve(root);
  return a === b || a.startsWith(b + path.sep);
}

/** True when the path exists (file or dir). */
async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Recursively collect files under `root` filtered by extension.
 * Bounded by `max` so a broad root cannot explode the scan.
 */
async function listFiles(root, options = {}) {
  const {
    extension = ".jsonl",
    recursive = true,
    max = DEFAULT_MAX_FILES,
    maxBytes = DEFAULT_MAX_FILE_BYTES,
    // Depth limit counted from the root (root itself is depth 1, so
    // maxDepth:2 matches `<root>/<dir>/<file>` and never descends further).
    // Apps like Claude Code keep non-session data (e.g. .timelines) in
    // deeper subdirectories, so unbounded recursion picks up junk.
    maxDepth = Infinity,
  } = options;
  // Empty/`*` extensions would match every file. Require a real suffix.
  if (typeof extension !== "string" || !EXTENSION_RE.test(extension)) return [];
  const out = [];
  const depthCap = Number.isFinite(maxDepth) ? Math.max(1, Math.trunc(maxDepth)) : Infinity;

  const walk = async (dir, depth) => {
    if (out.length >= max) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir -> skip, don't fail the whole scan
    }
    for (const entry of entries) {
      if (out.length >= max) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (recursive && depth < depthCap) await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (extension && !entry.name.endsWith(extension)) continue;
      out.push(full);
    }
  };

  await walk(root, 1);

  if (!maxBytes) return out;
  // Drop files too large to parse safely in one go.
  const kept = [];
  for (const file of out) {
    try {
      const st = await fsp.stat(file);
      if (st.size <= maxBytes) kept.push(file);
    } catch {
      /* unreadable -> drop */
    }
  }
  return kept;
}

/** Read a text file, or null when unreadable/oversized. */
async function readText(filePath, maxBytes = DEFAULT_MAX_FILE_BYTES) {
  try {
    const st = await fsp.stat(filePath);
    if (st.size > maxBytes) return null;
    return await fsp.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

/** Split raw text into parsed JSON objects, ignoring blank/malformed lines. */
function parseLines(raw, maxLines = 20000) {
  const out = [];
  if (!raw) return out;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      /* skip malformed line */
    }
    if (out.length >= maxLines) break;
  }
  return out;
}

module.exports = {
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_FILE_BYTES,
  EXTENSION_RE,
  expandHome,
  isFilesystemRoot,
  isInside,
  resolveSafe,
  exists,
  listFiles,
  readText,
  parseLines,
};
