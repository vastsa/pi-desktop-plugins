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
const { toIso, truncateTitle, projectNameOf } = require("../util");

const SOURCE = "codex";

const sessionsDirFor = (home = os.homedir()) => path.join(home, ".codex", "sessions");

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

async function listSessionFiles() {
  const out = [];
  const walk = async (dir, depth) => {
    let entries = [];
    try {
      entries = await fsp.readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      if (entry.endsWith(".jsonl")) out.push(full);
      else if (depth < 3) await walk(full, depth + 1);
    }
  };
  await walk(sessionsDirFor(), 0);
  return out;
}

async function scan() {
  const files = await listSessionFiles();
  const sessions = [];
  for (const filePath of files) {
    const parsed = await parseFile(filePath);
    if (!parsed) continue;
    const firstUser = parsed.items.find(({ item }) => {
      if (item.type !== "message" || item.role !== "user") return false;
      const text = itemText(item);
      return !!text && !isSyntheticUserText(text);
    });
    if (!firstUser) continue;
    sessions.push({
      source: SOURCE,
      externalId: parsed.externalId,
      title: truncateTitle(itemText(firstUser.item)) || parsed.externalId,
      fullTitle: itemText(firstUser.item),
      projectName: projectNameOf(parsed.cwd) ?? "Codex",
      projectPath: parsed.cwd,
      modelId: null,
      providerId: null,
      createdAt: toIso(parsed.startedAt),
      updatedAt: toIso(parsed.lastAt, toIso(parsed.startedAt)),
      messageCount: parsed.items.length,
      filePath,
    });
  }
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

module.exports = { source: SOURCE, label: "Codex", sessionsDirFor, scan, convert };
