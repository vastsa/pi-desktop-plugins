/**
 * OpenCode adapter: reads ~/.local/share/opencode/storage
 * (session/message/part as one JSON file each).
 * Ported from the built-in opencode.ts importer.
 */
"use strict";

const os = require("node:os");
const path = require("node:path");
const fsp = require("node:fs").promises;
const { toIso, truncateTitle, projectNameOf } = require("../util");

const SOURCE = "opencode";

const storageDirFor = (home = os.homedir()) =>
  path.join(home, ".local", "share", "opencode", "storage");

async function readJson(filePath) {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function listJsonFiles(dir) {
  try {
    return (await fsp.readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
}

async function loadMessages(storageDir, sessionId) {
  const dir = path.join(storageDir, "message", sessionId);
  const out = [];
  for (const file of await listJsonFiles(dir)) {
    const msg = await readJson(path.join(dir, file));
    if (msg) out.push(msg);
  }
  out.sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0));
  return out;
}

async function scan() {
  const storageDir = storageDirFor();
  const sessionRoot = path.join(storageDir, "session");
  let projectDirs = [];
  try {
    projectDirs = await fsp.readdir(sessionRoot);
  } catch {
    return [];
  }
  const sessions = [];
  for (const dir of projectDirs) {
    const dirPath = path.join(sessionRoot, dir);
    let stat;
    try {
      stat = await fsp.stat(dirPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    for (const file of await listJsonFiles(dirPath)) {
      const session = await readJson(path.join(dirPath, file));
      if (!session?.id) continue;
      let messageCount = 0;
      try {
        messageCount = (
          await fsp.readdir(path.join(storageDir, "message", session.id))
        ).filter((f) => f.endsWith(".json")).length;
      } catch {
        continue;
      }
      if (messageCount === 0) continue;
      sessions.push({
        source: SOURCE,
        externalId: session.id,
        title: truncateTitle(session.title ?? "") || session.id,
        fullTitle: String(session.title ?? ""),
        projectName: projectNameOf(session.directory) ?? "OpenCode",
        projectPath: session.directory ?? null,
        modelId: null,
        providerId: null,
        createdAt: toIso(session.time?.created),
        updatedAt: toIso(session.time?.updated, toIso(session.time?.created)),
        messageCount,
        filePath: path.join(dirPath, file),
      });
    }
  }
  sessions.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return sessions;
}

async function convert(summary) {
  const storageDir = storageDirFor();
  const ocMessages = await loadMessages(storageDir, summary.externalId);
  const messages = [];
  let modelId = null;
  let providerId = null;

  for (const msg of ocMessages) {
    if (msg.role === "assistant") {
      modelId = msg.modelID ?? modelId;
      providerId = msg.providerID ?? providerId;
    }
    const createdAt = toIso(msg.time?.created);
    const partDir = path.join(storageDir, "part", msg.id);
    const texts = [];
    for (const file of await listJsonFiles(partDir)) {
      const part = await readJson(path.join(partDir, file));
      if (!part) continue;
      if (part.type === "text" && part.text && part.synthetic !== true) {
        texts.push(part.text);
      } else if (part.type === "tool") {
        const output = part.state?.output;
        const outputText =
          typeof output === "string" ? output : output ? JSON.stringify(output) : "";
        messages.push({
          role: "tool",
          content: outputText,
          createdAt,
          toolName: part.tool ?? "tool",
          toolCallId: part.callID,
          toolStatus: part.state?.status === "error" ? "error" : "success",
          toolArgs: part.state?.input,
          toolResult: outputText,
        });
      }
    }
    const text = texts.join("\n").trim();
    if (text) messages.push({ role: msg.role === "user" ? "user" : "assistant", content: text, createdAt });
  }

  return {
    session: {
      id: `import-opencode-${summary.externalId}`,
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

module.exports = { source: SOURCE, label: "OpenCode", storageDirFor, scan, convert };
