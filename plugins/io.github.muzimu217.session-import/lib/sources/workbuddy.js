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
const { createReadStream } = require("node:fs");
const readline = require("node:readline");
const { toIso, truncateTitle, projectNameOf, mapValuesWithConcurrency } = require("../util");

const SOURCE = "workbuddy";

// Reading every project transcript for a list row is I/O bound; fan out so the
// panel does not wait on one file at a time.
const SCAN_CONCURRENCY = 12;

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

/**
 * Streaming variant of {@link summarize}: parse the transcript line by line
 * instead of materialising the whole file.
 *
 * WorkBuddy's list row needs the *last* line (`updatedAt`) and a trailing
 * `ai-title` record, so this cannot abort early the way the Codex/Claude
 * scans do. What it does avoid is `readFile` + `split("\n")` over transcripts
 * that reach tens of MB, which dominated the scan on a large `~/.workbuddy`.
 * Only the fields the row renders are retained, so peak memory stays flat.
 */
async function summarizeFile(filePath) {
  let firstTimestamp = null;
  let lastTimestamp = null;
  let aiTitle = null;
  let firstUserText = null;
  let cwd = null;
  let model = null;
  let convoCount = 0;

  const stream = createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const raw of rl) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      let line;
      try {
        line = JSON.parse(trimmed);
      } catch {
        continue; // malformed line — skip
      }
      if (line.timestamp) {
        if (!firstTimestamp) firstTimestamp = line.timestamp;
        lastTimestamp = line.timestamp;
      }
      if (line.type === "ai-title" && line.aiTitle) {
        aiTitle = line.aiTitle; // last one wins, matching summarize()
        continue;
      }
      if (!cwd && line.cwd) cwd = line.cwd;
      if (!isConversationLine(line)) continue;
      convoCount += 1;
      if (line.role === "assistant" && !model && line.providerData?.model) {
        model = line.providerData.model;
      }
      if (!firstUserText && line.role === "user") {
        const text = stripInjected(blockText(line.content));
        if (text) firstUserText = text;
      }
    }
  } catch {
    return null; // unreadable session file — skip
  } finally {
    rl.close();
    stream.destroy();
  }
  if (convoCount === 0) return null;

  const externalId = path.basename(filePath, ".jsonl");
  return {
    source: SOURCE,
    externalId,
    title: truncateTitle(aiTitle ?? "") || truncateTitle(firstUserText || "") || externalId,
    fullTitle: String(aiTitle ?? firstUserText ?? ""),
    projectName: projectNameOf(cwd) ?? "WorkBuddy",
    projectPath: cwd,
    modelId: model,
    providerId: null,
    createdAt: toIso(firstTimestamp),
    updatedAt: toIso(lastTimestamp, toIso(firstTimestamp)),
    messageCount: convoCount,
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
  const filesByDir = await Promise.all(
    projectDirs.map(async (dir) => {
      const dirPath = path.join(projectsDir, dir);
      try {
        const files = (await fsp.readdir(dirPath)).filter((f) => f.endsWith(".jsonl"));
        return files.map((f) => path.join(dirPath, f));
      } catch {
        return [];
      }
    }),
  );
  const filePaths = filesByDir.flat();
  const found = await mapValuesWithConcurrency(
    filePaths,
    SCAN_CONCURRENCY,
    (filePath) => summarizeFile(filePath),
  );
  found.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return found;
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
