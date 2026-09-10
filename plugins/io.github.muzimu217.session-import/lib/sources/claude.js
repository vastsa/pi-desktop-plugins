/**
 * Claude Code adapter: reads ~/.claude/projects/<slug>/<uuid>.jsonl.
 * Ported from the built-in claude.ts importer.
 */
"use strict";

const os = require("node:os");
const path = require("node:path");
const fsp = require("node:fs").promises;
const { toIso, truncateTitle, projectNameOf } = require("../util");

const SOURCE = "claude-code";

const projectsDirFor = (home = os.homedir()) => path.join(home, ".claude", "projects");

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

function isConversationLine(line) {
  return (
    (line.type === "user" || line.type === "assistant") &&
    line.isSidechain !== true &&
    !!line.message
  );
}

function blockText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

// Claude Code injects synthetic user lines (command caveats, system reminders,
// slash-command transcripts) that all start with an XML-ish tag.
function isSyntheticUserText(text) {
  return text.startsWith("<");
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
        const convo = lines.filter(isConversationLine);
        if (convo.length === 0) continue;
        const firstUser = convo.find((l) => {
          if (l.type !== "user") return false;
          const text = blockText(l.message?.content);
          return !!text && !isSyntheticUserText(text);
        });
        const model =
          convo.find((l) => l.type === "assistant" && l.message?.model)?.message?.model ??
          null;
        sessions.push({
          source: SOURCE,
          externalId: path.basename(file, ".jsonl"),
          title:
            truncateTitle(blockText(firstUser?.message?.content) || "") ||
            path.basename(file, ".jsonl"),
          fullTitle: blockText(firstUser?.message?.content) || "",
          projectName: projectNameOf(convo[0]?.cwd) ?? dir,
          projectPath: convo[0]?.cwd ?? null,
          modelId: model,
          providerId: null,
          createdAt: toIso(convo[0]?.timestamp),
          updatedAt: toIso(convo[convo.length - 1]?.timestamp),
          messageCount: convo.length,
          filePath,
        });
      } catch {
        // unreadable session file — skip
      }
    }
  }
  sessions.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return sessions;
}

async function convert(summary) {
  const lines = (await readLines(summary.filePath)).filter(isConversationLine);
  const messages = [];
  const pendingTools = new Map();

  for (const line of lines) {
    const createdAt = toIso(line.timestamp);
    const content = line.message?.content;
    const blocks = Array.isArray(content) ? content : null;

    if (line.type === "assistant") {
      const text = blockText(content);
      if (text) messages.push({ role: "assistant", content: text, createdAt });
      for (const b of blocks ?? []) {
        if (b.type === "tool_use" && b.id) {
          pendingTools.set(b.id, { name: b.name, args: b.input, createdAt });
        }
      }
    } else if (line.type === "user") {
      const toolResults = (blocks ?? []).filter((b) => b.type === "tool_result");
      if (toolResults.length > 0) {
        for (const b of toolResults) {
          const pending = pendingTools.get(b.tool_use_id);
          pendingTools.delete(b.tool_use_id);
          const resultText =
            typeof b.content === "string" ? b.content : blockText(b.content);
          messages.push({
            role: "tool",
            content: resultText,
            createdAt,
            toolName: pending?.name ?? "tool",
            toolCallId: b.tool_use_id,
            toolStatus: b.is_error ? "error" : "success",
            toolArgs: pending?.args,
            toolResult: resultText,
          });
        }
      } else {
        const text = blockText(content);
        if (text && !isSyntheticUserText(text)) {
          messages.push({ role: "user", content: text, createdAt });
        }
      }
    }
  }

  return {
    session: {
      id: `import-claude-code-${summary.externalId}`,
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

module.exports = { source: SOURCE, label: "Claude Code", projectsDirFor, scan, convert };
