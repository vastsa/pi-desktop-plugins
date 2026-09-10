/**
 * Pi adapter: reads ~/.pi/agent/sessions/**\/<session>.jsonl
 * (first line = session header, remaining lines = entries).
 * Ported from the built-in pi.ts importer.
 */
"use strict";

const os = require("node:os");
const path = require("node:path");
const fsp = require("node:fs").promises;
const { toIso, truncateTitle, projectNameOf } = require("../util");

const SOURCE = "pi";

const sessionsDirFor = (home = os.homedir()) => path.join(home, ".pi", "agent", "sessions");

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

async function parseFile(filePath) {
  let raw;
  try {
    raw = await fsp.readFile(filePath, "utf8");
  } catch {
    return null;
  }
  const lines = raw.split("\n").filter((l) => l.trim());
  if (lines.length === 0) return null;
  let header;
  try {
    header = JSON.parse(lines[0]);
  } catch {
    return null;
  }
  if (header.type !== "session" || !header.id) return null;
  const entries = [];
  for (const line of lines.slice(1)) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // skip malformed lines
    }
  }
  return { header, entries };
}

async function scan() {
  const sessionsDir = sessionsDirFor();
  let dirs = [];
  try {
    dirs = await fsp.readdir(sessionsDir);
  } catch {
    return [];
  }
  const sessions = [];
  for (const dir of dirs) {
    const dirPath = path.join(sessionsDir, dir);
    let files = [];
    try {
      files = (await fsp.readdir(dirPath)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const file of files) {
      const filePath = path.join(dirPath, file);
      const parsed = await parseFile(filePath);
      if (!parsed) continue;
      const messageEntries = parsed.entries.filter((e) => e.type === "message");
      if (messageEntries.length === 0) continue;
      const sessionName = parsed.entries
        .filter((e) => e.type === "session_info" && e.name)
        .map((e) => e.name)
        .pop();
      const firstUser = messageEntries.find(
        (e) => e.message?.role === "user" && contentText(e.message.content),
      );
      const lastTs =
        messageEntries[messageEntries.length - 1]?.timestamp ?? parsed.header.timestamp;
      sessions.push({
        source: SOURCE,
        externalId: parsed.header.id,
        title:
          truncateTitle(sessionName ?? contentText(firstUser?.message?.content) ?? "") ||
          parsed.header.id,
        fullTitle: String(sessionName ?? contentText(firstUser?.message?.content) ?? ""),
        projectName: projectNameOf(parsed.header.cwd) ?? "Pi",
        projectPath: parsed.header.cwd ?? null,
        modelId:
          messageEntries.find((e) => e.message?.role === "assistant")?.message?.model ??
          null,
        providerId:
          messageEntries.find((e) => e.message?.role === "assistant")?.message?.provider ??
          null,
        createdAt: toIso(parsed.header.timestamp),
        updatedAt: toIso(lastTs, toIso(parsed.header.timestamp)),
        messageCount: messageEntries.length,
        filePath,
      });
    }
  }
  sessions.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return sessions;
}

async function convert(summary) {
  const parsed = await parseFile(summary.filePath);
  const messages = [];
  const pendingCalls = new Map();
  let providerId = null;
  let modelId = null;

  for (const entry of parsed?.entries ?? []) {
    if (entry.type !== "message" || !entry.message) continue;
    const msg = entry.message;
    const createdAt = toIso(msg.timestamp ?? entry.timestamp, summary.createdAt);

    if (msg.role === "user") {
      const text = contentText(msg.content);
      if (text) messages.push({ role: "user", content: text, createdAt });
    } else if (msg.role === "assistant") {
      providerId = msg.provider ?? providerId;
      modelId = msg.model ?? modelId;
      const text = contentText(msg.content);
      if (text) messages.push({ role: "assistant", content: text, createdAt });
      for (const b of Array.isArray(msg.content) ? msg.content : []) {
        if (b.type === "toolCall" && b.id) {
          pendingCalls.set(b.id, { name: b.name, args: b.arguments });
        }
      }
    } else if (msg.role === "toolResult" && msg.toolCallId) {
      const pending = pendingCalls.get(msg.toolCallId);
      pendingCalls.delete(msg.toolCallId);
      const resultText = contentText(msg.content);
      messages.push({
        role: "tool",
        content: resultText,
        createdAt,
        toolName: msg.toolName ?? pending?.name ?? "tool",
        toolCallId: msg.toolCallId,
        toolStatus: msg.isError ? "error" : "success",
        toolArgs: pending?.args,
        toolResult: resultText,
      });
    }
  }

  return {
    session: {
      id: `import-pi-${summary.externalId}`,
      title: summary.fullTitle || summary.title,
      projectPath: summary.projectPath,
      modelId,
      providerId,
      mode: "agent",
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
    },
    messages,
  };
}

module.exports = { source: SOURCE, label: "Pi", sessionsDirFor, scan, convert };
