/**
 * WorkBuddy adapter: reads ~/.workbuddy/projects/<slug>/<uuid>.jsonl.
 * Logic ported verbatim from the verified feat/workbuddy-session-import
 * importer (injection stripping, call pairing, externalized result read-back,
 * ai-title preference).
 */
"use strict";

const os = require("node:os");
const path = require("node:path");
const fsp = require("node:fs").promises;
const { toIso, truncateTitle, projectNameOf } = require("../util");

const SOURCE = "workbuddy";

const projectsDirFor = (home = os.homedir()) =>
  path.join(home, ".workbuddy", "projects");

const TEXT_BLOCKS = new Set(["text", "input_text", "output_text"]);

const INJECTED_BLOCK =
  /<(system-reminder|cb_summary|conversation_history_summary)\b[\s\S]*?<\/\1>/gi;
const UNCLOSED_BLOCK =
  /<(system-reminder|cb_summary|conversation_history_summary)\b[\s\S]*$/i;
const USER_QUERY = /<user_query>([\s\S]*?)<\/user_query>/i;
const PERSISTED_OUTPUT = /<persisted-output>[\s\S]*?Full output saved to:\s*(\S+)/i;

async function readLines(filePath) {
  const raw = await fsp.readFile(filePath, "utf8");
  const out = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

function blockText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => TEXT_BLOCKS.has(b.type ?? "") && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

function stripInjected(text) {
  const paired = text.replace(INJECTED_BLOCK, "");
  const query = paired.match(USER_QUERY);
  if (query) return query[1].trim();
  return paired.replace(UNCLOSED_BLOCK, "").trim();
}

function resultText(output) {
  if (!output) return "";
  if (Array.isArray(output)) return blockText(output);
  if (typeof output.text === "string") return output.text.trim();
  return "";
}

async function resolveResultText(output, projectsDir) {
  const text = resultText(output);
  const match = text.match(PERSISTED_OUTPUT);
  if (!match) return text;
  const external = match[1];
  if (!path.resolve(external).startsWith(path.resolve(projectsDir) + path.sep)) {
    return text;
  }
  try {
    const full = await fsp.readFile(external, "utf8");
    return full.trim() || text;
  } catch {
    return text;
  }
}

function parseArgs(raw) {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function isConversationLine(line) {
  return line.type === "message" && (line.role === "user" || line.role === "assistant");
}

async function convertFile(filePath, projectsDir) {
  const lines = await readLines(filePath);
  const messages = [];
  const pendingTools = new Map();

  for (const line of lines) {
    if (line.type === "function_call" && line.callId) {
      pendingTools.set(line.callId, {
        name: line.name ?? "tool",
        args: parseArgs(line.arguments),
        createdAt: toIso(line.timestamp),
      });
      continue;
    }
    if (line.type === "function_call_result" && line.callId) {
      const pending = pendingTools.get(line.callId);
      pendingTools.delete(line.callId);
      const createdAt = toIso(line.timestamp);
      const text = await resolveResultText(line.output, projectsDir);
      const failed = line.status === "error" || line.status === "failed";
      messages.push({
        role: "tool",
        content: text,
        createdAt,
        toolName: line.name ?? pending?.name ?? "tool",
        toolCallId: line.callId,
        toolStatus: failed ? "error" : "success",
        toolArgs: pending?.args,
        toolResult: text,
      });
      continue;
    }
    if (!isConversationLine(line)) continue;
    const createdAt = toIso(line.timestamp);
    if (line.role === "assistant") {
      const text = blockText(line.content);
      if (text) messages.push({ role: "assistant", content: text, createdAt });
    } else {
      const text = stripInjected(blockText(line.content));
      if (text) messages.push({ role: "user", content: text, createdAt });
    }
  }
  return { lines, messages };
}

function summarize(filePath, lines, messages) {
  const convo = lines.filter(isConversationLine);
  const aiTitle = lines
    .filter((l) => l.type === "ai-title" && l.aiTitle)
    .map((l) => l.aiTitle)
    .pop();
  const firstUser = convo.find((l) => {
    if (l.role !== "user") return false;
    return !!stripInjected(blockText(l.content));
  });
  const cwd = lines.find((l) => l.cwd)?.cwd ?? null;
  const externalId = path.basename(filePath, ".jsonl");
  return {
    source: SOURCE,
    externalId,
    title:
      truncateTitle(aiTitle ?? "") ||
      truncateTitle(stripInjected(blockText(firstUser?.content)) || "") ||
      externalId,
    fullTitle: String(aiTitle ?? stripInjected(blockText(firstUser?.content)) ?? ""),
    projectName: projectNameOf(cwd) ?? "WorkBuddy",
    projectPath: cwd,
    modelId:
      convo.find((l) => l.role === "assistant" && l.providerData?.model)?.providerData
        ?.model ?? null,
    providerId: null,
    createdAt: toIso(lines[0]?.timestamp),
    updatedAt: toIso(lines[lines.length - 1]?.timestamp),
    messageCount: convo.length,
    filePath,
  };
}

async function scan() {
  const projectsDir = projectsDirFor();
  let projectDirs = [];
  try {
    projectDirs = await fsp.readdir(projectsDir);
  } catch {
    return [];
  }
  const sessions = [];
  for (const dir of projectDirs) {
    const dirPath = path.join(projectsDir, dir);
    let files = [];
    try {
      files = (await fsp.readdir(dirPath)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const file of files) {
      const filePath = path.join(dirPath, file);
      try {
        const lines = await readLines(filePath);
        const convoCount = lines.filter(isConversationLine).length;
        if (convoCount === 0) continue;
        sessions.push(summarize(filePath, lines, convoCount));
      } catch {
        // unreadable session file — skip
      }
    }
  }
  sessions.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return sessions;
}

async function convert(summary) {
  const projectsDir = projectsDirFor();
  const { messages } = await convertFile(summary.filePath, projectsDir);
  // Re-derive metadata from the same file so titles/model stay accurate.
  const lines = await readLines(summary.filePath);
  const meta = summarize(summary.filePath, lines, messages);
  return {
    session: {
      id: `import-workbuddy-${meta.externalId}`,
      title: meta.fullTitle || meta.title,
      projectPath: meta.projectPath,
      modelId: meta.modelId,
      providerId: null,
      mode: "agent",
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
    },
    messages,
  };
}

module.exports = { source: SOURCE, label: "WorkBuddy", projectsDirFor, scan, convert };
