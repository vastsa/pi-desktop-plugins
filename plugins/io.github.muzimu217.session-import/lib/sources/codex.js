/**
 * Codex adapter: reads the JSONL session files under
 * ~/.codex/sessions (both the newer
 * {timestamp,type,payload} wraps and the older bare header format).
 * Ported from the built-in codex.ts importer.
 */
"use strict";

const os = require("node:os");
const path = require("node:path");
const fsp = require("node:fs").promises;
const { createReadStream } = require("node:fs");
const readline = require("node:readline");
const { toIso, truncateTitle, projectNameOf, mapValuesWithConcurrency } = require("../util");

const SOURCE = "codex";

const sessionsDirFor = (home = os.homedir()) => path.join(home, ".codex", "sessions");

// How many rollout files to stream at once. High enough to hide read latency,
// low enough to keep the file-descriptor count sane.
const SCAN_CONCURRENCY = 16;

// Progressive scan budget. `scanFast` returns inside this window, then the
// adapter is asked for the full list in the background. Tuned so a cold panel
// open is interactive on trees that hold hundreds of multi-MB rollouts.
const SCAN_FAST_WINDOW_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const SCAN_FAST_MAX_FILES = 120;
const SCAN_FAST_MAX_BYTES = 96 * 1024 * 1024;

// Codex keeps every rollout verbatim, so a single project can hold hundreds of
// multi-MB `.jsonl` files (measured: 864 files / 2.6 GB on a working machine).
// Scanning them all costs ~16s. For the list row we only need the session
// metadata plus the first real user prompt, all of which live near the top, so
// stop reading once we have them and a little confirmation.
const SCAN_HEAD_LINES = 40;

function isKeptItemType(type) {
  return (
    type === "message" ||
    type === "function_call" ||
    type === "function_call_output" ||
    type === "response_item"
  );
}

/**
 * Streaming line reader. `shouldStop(counter)` is consulted after every parsed
 * line so callers can abort as soon as they have enough (keeps peak memory at
 * one line instead of a whole multi-MB transcript).
 */
async function streamLines(filePath, onLine, shouldStop) {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const counter = { lines: 0, items: 0 };
  try {
    for await (const line of rl) {
      counter.lines += 1;
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue; // malformed line — skip
      }
      onLine(parsed, counter);
      if (shouldStop && shouldStop(counter)) break;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return counter;
}

function itemText(item) {
  if (!Array.isArray(item.content)) return "";
  return item.content
    .filter(
      (c) =>
        (c.type === "input_text" || c.type === "output_text" || c.type === "text") &&
        typeof c.text === "string",
    )
    .map((c) => c.text)
    .join("\n")
    .trim();
}

// Codex prepends synthetic user messages carrying repo instructions/env info.
function isSyntheticUserText(text) {
  return (
    text.startsWith("<") ||
    text.startsWith("# AGENTS.md") ||
    text.startsWith("You are Codex")
  );
}

async function parseFile(filePath) {
  let raw;
  try {
    raw = await fsp.readFile(filePath, "utf8");
  } catch {
    return null;
  }
  const parsed = { externalId: "", cwd: null, startedAt: null, lastAt: null, items: [] };
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    // Newer format wraps everything in {timestamp, type, payload}.
    if (obj.type === "session_meta" && obj.payload) {
      parsed.externalId = obj.payload.id ?? parsed.externalId;
      parsed.cwd = obj.payload.cwd ?? parsed.cwd;
      parsed.startedAt = obj.payload.timestamp ?? obj.timestamp ?? parsed.startedAt;
      continue;
    }
    if (obj.type === "response_item" && obj.payload) {
      parsed.items.push({ item: obj.payload, timestamp: obj.timestamp ?? null });
      if (obj.timestamp) parsed.lastAt = obj.timestamp;
      continue;
    }
    // Older format: first line is a bare session header, items are bare lines.
    if (!parsed.externalId && obj.id && obj.timestamp && !obj.type) {
      parsed.externalId = obj.id;
      parsed.startedAt = obj.timestamp;
      parsed.cwd = obj.cwd ?? null;
      continue;
    }
    if (
      obj.type === "message" ||
      obj.type === "function_call" ||
      obj.type === "function_call_output"
    ) {
      parsed.items.push({ item: obj, timestamp: obj.timestamp ?? null });
      if (obj.timestamp) parsed.lastAt = obj.timestamp;
    }
  }
  if (!parsed.externalId) parsed.externalId = path.basename(filePath, ".jsonl");
  return parsed.items.length > 0 ? parsed : null;
}

/**
 * Walk the sessions tree and stat every rollout.
 *
 * `stat` is essentially free on a warm cache (~6ms for 800+ files) whereas
 * *opening* each file costs ~5ms of syscall latency, so we gather size+mtime up
 * front. That lets the progressive scan below decide which files are worth
 * opening without paying for a single `open()` first.
 */
async function listSessionEntries() {
  const paths = [];
  const walk = async (dir, depth) => {
    let entries = [];
    try {
      entries = await fsp.readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      if (entry.endsWith(".jsonl")) paths.push(full);
      else if (depth < 3) await walk(full, depth + 1);
    }
  };
  await walk(sessionsDirFor(), 0);
  const stated = await mapValuesWithConcurrency(paths, SCAN_CONCURRENCY, async (filePath) => {
    try {
      const info = await fsp.stat(filePath);
      if (!info.isFile() || info.size === 0) return null;
      return { filePath, size: info.size, mtimeMs: info.mtimeMs };
    } catch {
      return null;
    }
  });
  return stated.filter(Boolean);
}

/** Pick the files whose contents we can afford to open right now. */
function selectFiles(entries, { maxFiles, maxBytes, sinceMs }) {
  let candidates = entries;
  if (sinceMs) {
    const recent = entries.filter((e) => e.mtimeMs >= sinceMs);
    // Never let a stale clock shrink the list to nothing.
    if (recent.length > 0) candidates = recent;
  }
  if (typeof maxFiles === "number" && candidates.length > maxFiles) {
    // Newest first: those are the sessions a user is actually looking for.
    candidates = [...candidates].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, maxFiles);
  }
  if (typeof maxBytes === "number") {
    const kept = [];
    let bytes = 0;
    for (const entry of candidates) {
      if (bytes + entry.size > maxBytes && kept.length > 0) continue;
      bytes += entry.size;
      kept.push(entry);
    }
    return kept;
  }
  return candidates;
}

/**
 * Streaming scan: parse only as much of each rollout as the list row needs.
 *
 * The previous implementation called `parseFile()` for every file, which read
 * the full blob and JSON-parsed every line — 2.6 GB / 583k lines on a real
 * ~/.codex/sessions tree, ~16s of blocking work before the panel could render.
 * Here each file is streamed and aborted once we have the session id, cwd,
 * the first real user prompt and a model-ish signal.
 *
 * Counts (`messageCount`, `updatedAt`) become head-limited approximations: the
 * list only renders a size hint and a relative time, and `convert()` re-reads
 * the file in full at import time, so nothing user-visible is lost.
 */
async function scanFileMetadata(filePath) {
  let externalId = "";
  let cwd = null;
  let startedAt = null;
  let lastAt = null;
  let firstUser = null;
  let messageCount = 0;
  let sawAnyItem = false;

  const stop = (counter) =>
    !!firstUser && counter.items >= SCAN_HEAD_LINES;

  try {
    await streamLines(
      filePath,
      (obj, counter) => {
        // Newer format: {timestamp, type, payload}.
        if (obj.type === "session_meta" && obj.payload) {
          externalId = obj.payload.id ?? externalId;
          cwd = obj.payload.cwd ?? cwd;
          startedAt = obj.payload.timestamp ?? obj.timestamp ?? startedAt;
          return;
        }
        if (obj.type === "response_item" && obj.payload) {
          sawAnyItem = true;
          counter.items += 1;
          if (obj.timestamp) lastAt = obj.timestamp;
          const item = obj.payload;
          if (!firstUser && item.type === "message" && item.role === "user") {
            const text = itemText(item);
            if (text && !isSyntheticUserText(text)) firstUser = text;
          }
          return;
        }
        // Older format: bare session header, then bare item lines.
        if (!externalId && obj.id && obj.timestamp && !obj.type) {
          externalId = obj.id;
          startedAt = obj.timestamp;
          cwd = obj.cwd ?? null;
          return;
        }
        if (isKeptItemType(obj.type)) {
          sawAnyItem = true;
          counter.items += 1;
          if (obj.timestamp) lastAt = obj.timestamp;
          if (!firstUser && obj.type === "message" && obj.role === "user") {
            const text = itemText(obj);
            if (text && !isSyntheticUserText(text)) firstUser = text;
          }
        }
      },
      stop,
    );
  } catch {
    return null; // unreadable session file — skip
  }

  if (!externalId) externalId = path.basename(filePath, ".jsonl");
  if (!sawAnyItem) return null;
  return { externalId, cwd, startedAt, lastAt, firstUser, messageCount };
}

/**
 * First pass: the sessions a user most likely wants — recent, and bounded in
 * both file count and total bytes so the panel can paint a list in well under a
 * second even on a 3 GB rollout tree.
 */
async function scanFast(entries) {
  const picked = selectFiles(entries ?? (await listSessionEntries()), {
    maxFiles: SCAN_FAST_MAX_FILES,
    maxBytes: SCAN_FAST_MAX_BYTES,
    sinceMs: Date.now() - SCAN_FAST_WINDOW_MS,
  });
  return mapSessions(picked);
}

/** Full pass: every rollout under the sessions tree. */
async function scan() {
  const entries = await listSessionEntries();
  return mapSessions(entries);
}

async function mapSessions(entries) {
  // Transcribing hundreds of rollouts is I/O bound: fan out so the scan
  // finishes in parallel rather than one file at a time.
  const results = await mapValuesWithConcurrency(
    entries,
    SCAN_CONCURRENCY,
    async (entry) => {
      const filePath = entry.filePath ?? entry;
      const meta = await scanFileMetadata(filePath);
      if (!meta || !meta.firstUser) return null;
      return {
        source: SOURCE,
        externalId: meta.externalId,
        title: truncateTitle(meta.firstUser) || meta.externalId,
        fullTitle: meta.firstUser,
        projectName: projectNameOf(meta.cwd) ?? "Codex",
        projectPath: meta.cwd,
        modelId: null,
        providerId: null,
        createdAt: toIso(meta.startedAt),
        updatedAt: toIso(meta.lastAt, toIso(meta.startedAt)),
        messageCount: meta.messageCount,
        filePath,
      };
    },
  );
  const sessions = results.filter(Boolean);
  sessions.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return sessions;
}

async function convert(summary) {
  const parsed = await parseFile(summary.filePath);
  const messages = [];
  const pendingCalls = new Map();

  for (const { item, timestamp } of parsed?.items ?? []) {
    const createdAt = toIso(timestamp, summary.createdAt);
    if (item.type === "message") {
      const text = itemText(item);
      if (!text || (item.role === "user" && isSyntheticUserText(text))) continue;
      messages.push({
        role: item.role === "user" ? "user" : "assistant",
        content: text,
        createdAt,
      });
    } else if (item.type === "function_call" && item.call_id) {
      let args;
      try {
        args = JSON.parse(item.arguments ?? "");
      } catch {
        args = item.arguments;
      }
      pendingCalls.set(item.call_id, { name: item.name ?? "tool", args });
    } else if (item.type === "function_call_output" && item.call_id) {
      const pending = pendingCalls.get(item.call_id);
      pendingCalls.delete(item.call_id);
      const output =
        typeof item.output === "string" ? item.output : JSON.stringify(item.output);
      messages.push({
        role: "tool",
        content: output,
        createdAt,
        toolName: pending?.name ?? "tool",
        toolCallId: item.call_id,
        toolStatus: "success",
        toolArgs: pending?.args,
        toolResult: output,
      });
    }
  }

  return {
    session: {
      id: `import-codex-${summary.externalId}`,
      title: summary.fullTitle || summary.title,
      projectPath: summary.projectPath,
      modelId: summary.modelId,
      providerId: null,
      mode: "agent",
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
    },
    messages,
  };
}

module.exports = { source: SOURCE, label: "Codex", sessionsDirFor, scan, scanFast, convert };
