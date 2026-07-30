/**
 * Local transcript adapters. Each adapter emits only normalized usage metadata.
 * Parsed records are discarded immediately and never enter the plugin snapshot.
 */

const { createReadStream, existsSync, readdirSync, readFileSync } = require("node:fs");
const { createInterface } = require("node:readline");
const path = require("node:path");

const SOURCE_LABELS = {
  "pi-desktop": "PI-Desktop",
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function field(object, ...names) {
  for (const name of names) {
    if (object?.[name] != null) return object[name];
  }
  return 0;
}

function toTokens(usage) {
  if (!usage || typeof usage !== "object") return null;
  const input = number(field(usage, "inputTokens", "input_tokens", "input"));
  const output = number(field(usage, "outputTokens", "output_tokens", "output"));
  const cacheRead = number(field(usage, "cacheReadTokens", "cache_read_input_tokens", "cached_input_tokens", "cacheRead"));
  const cacheWrite = number(field(usage, "cacheWriteTokens", "cache_creation_input_tokens", "cache_write_input_tokens", "cacheWrite"));
  const reasoning = number(field(usage, "reasoningTokens", "reasoning_output_tokens", "reasoning"));
  const total = number(field(usage, "totalTokens", "total_tokens", "total"));
  if (!input && !output && !cacheRead && !cacheWrite && !reasoning && !total) return null;
  return { input, output, cacheRead, cacheWrite, reasoning, total: total || input + output + cacheRead + cacheWrite + reasoning };
}

function sourceLabel(sourceId) {
  return SOURCE_LABELS[sourceId] || sourceId;
}

function diagnostics(sourceId) {
  return { sourceId, filesScanned: 0, filesSkipped: 0, malformedLines: 0, usageMessages: 0 };
}

function listFiles(root, suffix, recursive = true) {
  if (!existsSync(root)) return [];
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isFile() && entry.name.endsWith(suffix)) files.push(candidate);
      else if (recursive && entry.isDirectory()) visit(candidate);
    }
  };
  visit(root);
  return files.sort();
}

async function scanJsonl(root, sourceId, acceptFile, createParser) {
  const result = { events: [], diagnostics: diagnostics(sourceId) };
  let files;
  try {
    files = listFiles(root, ".jsonl");
  } catch {
    result.diagnostics.filesSkipped += 1;
    return result;
  }
  for (const file of files) {
    if (acceptFile && !acceptFile(file)) continue;
    try {
      const parser = createParser(file);
      const reader = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
      for await (const line of reader) {
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          result.diagnostics.malformedLines += 1;
          continue;
        }
        const event = parser(record);
        if (!event) continue;
        result.events.push(event);
        result.diagnostics.usageMessages += 1;
      }
      result.diagnostics.filesScanned += 1;
    } catch {
      result.diagnostics.filesSkipped += 1;
    }
  }
  return result;
}

function event(sourceId, sessionId, timestamp, modelId, providerId, tokens) {
  if (!tokens || Number.isNaN(timestamp)) return null;
  const id = String(sessionId || "unknown");
  return {
    sourceId,
    sessionId: `${sourceId}:${id}`,
    timestamp,
    modelId: String(modelId || "Unknown model"),
    providerId: String(providerId || "Unknown provider"),
    tokens,
  };
}

function scanPiTranscriptDirectory(root) {
  return scanJsonl(
    root,
    "pi-desktop",
    (file) => {
      const name = path.basename(file);
      return !name.endsWith(".revisions.jsonl") && !name.startsWith("import-codex-") && !name.startsWith("import-claude-code-");
    },
    (file) => (record) => {
      if (record?.type !== "message" || record?.role !== "assistant") return null;
      return event(
        "pi-desktop",
        path.basename(file, ".jsonl"),
        Date.parse(record.createdAt || ""),
        record.meta?.modelId,
        record.meta?.providerId,
        toTokens(record.meta?.usage),
      );
    },
  );
}

function scanClaudeCodeDirectory(root) {
  return scanJsonl(root, "claude-code", null, (file) => (record) => {
    if (record?.type !== "assistant") return null;
    return event(
      "claude-code",
      record.sessionId || record.session_id || path.basename(file, ".jsonl"),
      Date.parse(record.timestamp || ""),
      record.message?.model,
      "anthropic",
      toTokens(record.message?.usage),
    );
  });
}

function scanCodexDirectory(root) {
  return scanJsonl(root, "codex", null, (file) => {
    const state = { sessionId: path.basename(file, ".jsonl"), modelId: "Unknown model", providerId: "openai" };
    return (record) => {
      if (record?.type === "turn_context") {
        state.modelId = record.payload?.model || state.modelId;
        return null;
      }
      if (record?.type === "session_meta") {
        state.sessionId = record.payload?.id || state.sessionId;
        state.providerId = record.payload?.model_provider || state.providerId;
        return null;
      }
      if (record?.type !== "event_msg" || record.payload?.type !== "token_count") return null;
      return event(
        "codex",
        state.sessionId,
        Date.parse(record.timestamp || ""),
        state.modelId,
        state.providerId,
        toTokens(record.payload?.info?.last_token_usage),
      );
    };
  });
}

function scanOpenCodeDirectory(root) {
  const result = { events: [], diagnostics: diagnostics("opencode") };
  let files;
  try {
    files = listFiles(root, ".json");
  } catch {
    result.diagnostics.filesSkipped += 1;
    return result;
  }
  for (const file of files) {
    try {
      const record = JSON.parse(readFileSync(file, "utf8"));
      if (record?.role !== "assistant") continue;
      const tokens = toTokens({
        input: record.tokens?.input,
        output: record.tokens?.output,
        reasoning: record.tokens?.reasoning,
        cacheRead: record.tokens?.cache?.read,
        cacheWrite: record.tokens?.cache?.write,
      });
      const scanned = event(
        "opencode",
        record.sessionID || record.sessionId || path.basename(path.dirname(file)),
        Date.parse(record.time?.completed || record.time?.created || ""),
        record.modelID,
        record.providerID,
        tokens,
      );
      result.diagnostics.filesScanned += 1;
      if (!scanned) continue;
      result.events.push(scanned);
      result.diagnostics.usageMessages += 1;
    } catch {
      result.diagnostics.filesSkipped += 1;
    }
  }
  return result;
}

function mergeResults(results) {
  const sources = results.map((result) => result.diagnostics);
  return {
    events: results.flatMap((result) => result.events),
    diagnostics: {
      filesScanned: sources.reduce((sum, item) => sum + item.filesScanned, 0),
      filesSkipped: sources.reduce((sum, item) => sum + item.filesSkipped, 0),
      malformedLines: sources.reduce((sum, item) => sum + item.malformedLines, 0),
      usageMessages: sources.reduce((sum, item) => sum + item.usageMessages, 0),
      sources,
    },
  };
}

module.exports = {
  mergeResults,
  scanClaudeCodeDirectory,
  scanCodexDirectory,
  scanOpenCodeDirectory,
  scanPiTranscriptDirectory,
  sourceLabel,
  toTokens,
};
