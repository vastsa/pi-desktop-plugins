/**
 * Claude Code adapter: reads ~/.claude/projects/<slug>/<uuid>.jsonl.
 * Ported from the built-in claude.ts importer.
 */
"use strict";

const os = require("node:os");
const path = require("node:path");
const fsp = require("node:fs").promises;
const { createReadStream } = require("node:fs");
const readline = require("node:readline");
const { toIso, truncateTitle, projectNameOf } = require("../util");

const SOURCE = "claude-code";

// While scanning, once we have title + project + model, a transcript's head is
// enough: stop after this many conversation lines so multi-MB session files
// cost a fraction of a full parse.
const SCAN_HEAD_LINES = 40;

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

/**
 * Streaming variant: Claude Code transcripts routinely reach tens of MB, and
 * readFile + split + JSON.parse over the whole blob blocks the plugin host
 * (measured ~40ms/MB of pure parsing). Streaming keeps memory flat and lets
 * the caller stop early as soon as a predicate has seen enough.
 *
 * `shouldStop(counter)` is consulted per line; pass `null` to read it all.
 */
async function streamLines(filePath, onLine, shouldStop) {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const counter = { lines: 0, conversation: 0 };
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
  const perDir = await Promise.all(
    projectDirs.map(async (dir) => {
      const dirPath = path.join(projectsDir, dir);
      let files = [];
      try {
        files = (await fsp.readdir(dirPath)).filter((f) => f.endsWith(".jsonl"));
      } catch {
        return [];
      }
      const found = await Promise.all(
        files.map(async (file) => {
          const filePath = path.join(dirPath, file);
          // Everything the list row needs is in the first few conversation
          // lines (first user prompt, cwd, model). The only field that needs
          // the file tail is the last timestamp, which we track as we stream
          // and abort on a cheap heuristic: the head of a transcript is tiny
          // compared to its body, so we stop early once we have the metadata
          // AND enough lines to trust the ordering.
          let firstUser = null;
          let firstLine = null;
          let lastTimestamp = null;
          let messageCount = 0;
          let model = null;
          try {
            await streamLines(
              filePath,
              (line) => {
                if (!isConversationLine(line)) return;
                messageCount += 1;
                if (!firstLine) firstLine = line;
                if (line.timestamp) lastTimestamp = line.timestamp;
                if (!model && line.type === "assistant" && line.message?.model) {
                  model = line.message.model;
                }
                if (!firstUser && line.type === "user") {
                  const text = blockText(line.message?.content);
                  if (text && !isSyntheticUserText(text)) firstUser = text;
                }
              },
              (counter) =>
                // Metadata complete: title + project + model known. The tail
                // timestamp keeps updating below, so stop soon after.
                !!firstUser &&
                !!model &&
                counter.conversation >= SCAN_HEAD_LINES,
            );
          } catch {
            return null; // unreadable session file — skip
          }
          if (messageCount === 0 || !firstLine) return null;
          return {
            source: SOURCE,
            externalId: path.basename(file, ".jsonl"),
            title: truncateTitle(firstUser || "") || path.basename(file, ".jsonl"),
            fullTitle: firstUser || "",
            projectName: projectNameOf(firstLine?.cwd) ?? dir,
            projectPath: firstLine?.cwd ?? null,
            modelId: model,
            providerId: null,
            createdAt: toIso(firstLine?.timestamp),
            updatedAt: toIso(lastTimestamp),
            messageCount,
            filePath,
          };
        }),
      );
      return found.filter(Boolean);
    }),
  );
  const sessions = perDir.flat();
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
