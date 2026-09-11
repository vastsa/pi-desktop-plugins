/**
 * Shared entry -> message mapper.
 *
 * Both the jsonl-transcript and json-tree drivers read a stream of "entries"
 * (one line / one array item) and turn each into messages using declarative
 * rules, so the mapping lives here rather than being duplicated.
 *
 * Three tool shapes are supported, because that is what real agents write:
 *
 *  1. self-contained tool entry (`entry.tool`)
 *     the whole entry IS a call+result (e.g. an OpenCode tool part)
 *
 *  2. two-phase tool events at entry level (`entry.toolCall.call` / `.result`)
 *     `function_call` -> `function_call_output`  (Codex)
 *     `function_call` -> `function_call_result`  (WorkBuddy)
 *
 *  3. two-phase tool events as content blocks (`entry.toolCall.callBlocks` /
 *     `.resultBlocks`)
 *     a `tool_use` block inside an assistant message, whose `tool_result`
 *     block arrives in a later user message (Claude Code).
 *
 * Shapes 2 and 3 need state across entries to pair an id with its result, so
 * `mapEntry` takes a `pending` map. Results are emitted where the built-in
 * adapters emit them — at result time, not call time — so a declarative spec
 * produces the same message sequence as the hand-written adapter.
 */
"use strict";

const path = require("node:path");
const fsp = require("node:fs/promises");

const {
  extractText,
  extractValue,
  getPath,
  asText,
  mapRole,
  toIso,
  applyTextOps,
  droppedBy,
} = require("./extract");

/** Only these are conversation roles; everything else is metadata. */
const TEXT_ROLES = new Set(["user", "assistant"]);

const DEFAULT_FOLLOW_MAX_BYTES = 1024 * 1024;

const isInside = (file, root) => file === root || file.startsWith(root + path.sep);

/** Status for a self-contained / entry-level tool event (no result seen yet). */
function mapToolStatus(status) {
  const s = status == null ? "" : String(status);
  if (s === "error" || s === "failed" || s === "true") return "error";
  if (s === "completed" || s === "success" || s === "false") return "success";
  return "running";
}

/** Status for a paired tool result: a result exists, so it is error or success. */
function resultStatus(value, errorValues) {
  const s = value == null ? "" : String(value);
  if (Array.isArray(errorValues) && errorValues.length) {
    return errorValues.map(String).includes(s) ? "error" : "success";
  }
  if (s === "error" || s === "failed" || s === "true") return "error";
  return "success";
}

/** Text out of a block-array field (or a plain string), ignoring other types. */
function blockValueText(value, typeField, types, textField) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  const out = [];
  for (const b of value) {
    if (b == null) continue;
    if (typeof b !== "object") {
      out.push(String(b));
      continue;
    }
    const t = typeField ? getPath(b, typeField) : undefined;
    if (Array.isArray(types) && types.length && !types.includes(t)) continue;
    const txt = textField ? getPath(b, textField) : undefined;
    if (typeof txt === "string" && txt) out.push(txt);
  }
  return out.join("\n").trim();
}

const DEFAULT_RESULT_TEXT_TYPES = ["text", "output_text", "input_text"];

/**
 * A tool result may be a string, a block array, or an object with .text.
 *
 * Trimming follows the built-in adapters exactly: a plain string is returned
 * verbatim (claude.js / codex.js do not trim), while text joined out of blocks
 * or read off an object is trimmed (blockText / workbuddy's resultText do).
 */
function resultToText(value, rule = {}) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  // "json": the app stores the result verbatim and its adapter stringifies
  // whatever it cannot read as a plain string (codex.js). Preferring the raw
  // payload over a block scan is what keeps those two byte-identical.
  if (rule.resultFormat === "json") return asText(value);
  if (Array.isArray(value)) {
    return blockValueText(
      value,
      rule.resultTypeField ?? "type",
      rule.resultTextTypes ?? DEFAULT_RESULT_TEXT_TYPES,
      rule.resultTextField ?? "text",
    );
  }
  if (typeof value === "object") {
    if (typeof value.text === "string") return value.text.trim();
    if (Array.isArray(value.content)) return resultToText(value.content, rule);
    return asText(value);
  }
  return asText(value);
}

function blocksAt(target, dotted) {
  const v = getPath(target, dotted);
  return Array.isArray(v) ? v : [];
}

/** Does this entry carry one of the given types? */
function typeMatches(target, rule) {
  if (!rule || !Array.isArray(rule.types) || !rule.types.length) return false;
  const t = getPath(target, rule.typePath || "type");
  return t != null && rule.types.includes(t);
}

/** Omit `roles` (or pass an empty list) to apply a rule to every role. */
function roleAllowed(role, rule) {
  if (!rule || !Array.isArray(rule.roles) || !rule.roles.length) return true;
  return rule.roles.includes(role);
}

function toolArgs(target, rule) {
  if (!rule || !rule.argsPath) return null;
  const raw = getPath(target, rule.argsPath);
  if (rule.argsJson && typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw ?? null;
}

/**
 * Follow an externalized result back to disk.
 *
 * Some agents truncate a large tool result and leave a pointer instead:
 *   "<persisted-output> Output too large (254.6KB).
 *    Full output saved to: /…/projects/<slug>/tool-output.txt"
 * `follow: { marker: "Full output saved to:", maxBytes }` reads that file so
 * the import keeps the real output.
 *
 * The read is bounded and confined: the target must resolve inside the
 * spec's own data root, so a spec can never pull in a file the scan could
 * not already have opened.
 */
async function followResult(text, rule, ctx) {
  if (!rule || !text || typeof rule.marker !== "string" || !rule.marker) return text;
  const idx = text.indexOf(rule.marker);
  if (idx < 0) return text;
  const token = text.slice(idx + rule.marker.length).trim().split(/\s+/)[0];
  if (!token) return text;
  if (!ctx?.root) return text;
  const abs = path.resolve(token);
  if (!isInside(abs, ctx.root)) return text;
  const maxBytes = Number.isFinite(rule.maxBytes)
    ? Math.max(1, rule.maxBytes)
    : DEFAULT_FOLLOW_MAX_BYTES;
  try {
    const st = await fsp.stat(abs);
    if (!st.isFile() || st.size > maxBytes) return text;
    const full = await fsp.readFile(abs, "utf8");
    return full.trim() || text;
  } catch {
    return text; // unreadable pointer -> keep the pointer text
  }
}

function makeToolMessage({ id, name, args, text, status, createdAt }) {
  const msg = {
    role: "tool",
    content: text,
    toolName: name,
    toolStatus: status,
    toolArgs: args ?? null,
    toolResult: text,
    createdAt,
  };
  // Only paired calls/results have an id; self-contained entries have none.
  if (id != null) msg.toolCallId = String(id);
  return msg;
}

/**
 * The object all spec paths resolve against.
 *
 * Agents that wrap items in an envelope (Codex:
 * `{timestamp, type, payload}`) would otherwise force every path in the spec
 * to be prefixed. `unwrapPath` lifts the inner object when it is present and
 * leaves bare (older-format) entries untouched, so one spec covers both.
 */
function resolveTarget(entry, spec) {
  if (!spec.unwrapPath) return entry;
  const inner = getPath(entry, spec.unwrapPath);
  return inner && typeof inner === "object" && !Array.isArray(inner) ? inner : entry;
}

/**
 * Map one entry to 0..n messages.
 * @param {object} entrySpec
 * @param {object} entry
 * @param {Map<string, {name:string, args:any, createdAt:string|null}>} pending
 * @param {{root?: string}} [ctx] data root, needed by `toolCall.*.follow`
 */
async function mapEntry(entrySpec, entry, pending, ctx) {
  const spec = entrySpec ?? {};
  if (!entry || typeof entry !== "object") return [];

  const target = resolveTarget(entry, spec);

  // Only map entries of the configured kind (conversation lines, kept items).
  if (spec.match) {
    const v = getPath(target, spec.match.path);
    if (!Array.isArray(spec.match.in) || !spec.match.in.includes(v)) return [];
  }

  if (spec.skipTypePath && Array.isArray(spec.skipTypes) && spec.skipTypes.length) {
    const t = getPath(target, spec.skipTypePath);
    if (t != null && spec.skipTypes.includes(t)) return [];
  }

  // Envelope fields (timestamps live outside the payload) win over inner ones.
  const ts = toIso(getPath(entry, spec.tsPath) ?? getPath(target, spec.tsPath), spec.tsUnit);
  const role = mapRole(extractValue(spec.rolePath, target), spec.roleMap);

  // 1) self-contained tool entry: the entry carries call and result.
  const tool = spec.tool;
  if (tool && Array.isArray(tool.toolTypes) && tool.toolTypes.length) {
    const t = getPath(target, tool.typePath || "type");
    if (tool.toolTypes.includes(t)) {
      const result = extractText(tool.resultPath, target);
      return [
        makeToolMessage({
          id: tool.idPath ? getPath(target, tool.idPath) : undefined,
          name: extractText(tool.namePath, target) || "tool",
          args: extractValue(tool.argsPath, target) ?? null,
          text: result,
          status: mapToolStatus(extractValue(tool.statusPath, target)),
          createdAt: ts,
        }),
      ];
    }
  }

  const tc = spec.toolCall;
  if (tc && pending) {
    // 2) entry-level call: remember it, emit nothing (the result carries it).
    if (typeMatches(target, tc.call) && roleAllowed(role, tc.call)) {
      const id = getPath(target, tc.call.idPath);
      if (id != null) {
        pending.set(String(id), {
          name: String(getPath(target, tc.call.namePath) ?? "tool"),
          args: toolArgs(target, tc.call),
          createdAt: ts,
        });
      }
      return [];
    }

    // 3) entry-level result: emit, merging whatever the call recorded.
    if (typeMatches(target, tc.result) && roleAllowed(role, tc.result)) {
      const id = getPath(target, tc.result.idPath);
      if (id != null) {
        const p = pending.get(String(id));
        pending.delete(String(id));
        const text = await followResult(
          resultToText(
            tc.result.resultPath ? getPath(target, tc.result.resultPath) : null,
            tc.result,
          ),
          tc.result.follow,
          ctx,
        );
        const name =
          (tc.result.namePath && getPath(target, tc.result.namePath)) || p?.name || "tool";
        return [
          makeToolMessage({
            id,
            name: String(name),
            args: p?.args ?? null,
            text,
            status: resultStatus(
              tc.result.statusPath ? getPath(target, tc.result.statusPath) : undefined,
              tc.result.errorValues,
            ),
            createdAt: ts,
          }),
        ];
      }
      return [];
    }

    // 4) block-level call: remember each tool_use, keep the message's text.
    if (tc.callBlocks && roleAllowed(role, tc.callBlocks)) {
      const cb = tc.callBlocks;
      for (const b of blocksAt(target, cb.path)) {
        if (!b || typeof b !== "object") continue;
        if (getPath(b, cb.typeField) !== cb.type) continue;
        const id = getPath(b, cb.idPath);
        if (id == null) continue;
        pending.set(String(id), {
          name: String(getPath(b, cb.namePath) ?? "tool"),
          args: cb.argsPath ? getPath(b, cb.argsPath) ?? null : null,
          createdAt: ts,
        });
      }
    }

    // 5) block-level results: emit one tool message each and suppress the
    //    entry's text, exactly like the built-in Claude adapter does.
    if (tc.resultBlocks && roleAllowed(role, tc.resultBlocks)) {
      const rb = tc.resultBlocks;
      const out = [];
      for (const b of blocksAt(target, rb.path)) {
        if (!b || typeof b !== "object") continue;
        if (getPath(b, rb.typeField) !== rb.type) continue;
        const id = getPath(b, rb.idPath);
        const p = id != null ? pending.get(String(id)) : undefined;
        if (id != null) pending.delete(String(id));
        const text = await followResult(
          resultToText(rb.resultPath ? getPath(b, rb.resultPath) : null, rb),
          rb.follow,
          ctx,
        );
        const name = (rb.namePath && getPath(b, rb.namePath)) || p?.name || "tool";
        out.push(
          makeToolMessage({
            id,
            name: String(name),
            args: p?.args ?? null,
            text,
            status: resultStatus(
              rb.statusPath ? getPath(b, rb.statusPath) : undefined,
              rb.errorValues,
            ),
            createdAt: ts,
          }),
        );
      }
      if (out.length) return out;
    }
  }

  // 6) ordinary conversation message.
  if (!TEXT_ROLES.has(role)) return [];
  const text = applyTextOps(extractText(spec.content, target), spec.textOps, role);
  if (!text) return [];
  if (droppedBy(spec.drop, text, role)) return [];
  return [{ role, content: text, createdAt: ts }];
}

/** Map a whole transcript/session body to messages. */
async function mapEntries(entrySpec, entries, ctx) {
  const messages = [];
  if (!Array.isArray(entries)) return messages;
  const pending = new Map();
  for (const entry of entries) {
    for (const msg of await mapEntry(entrySpec, entry, pending, ctx)) messages.push(msg);
  }
  // A call with no result is dropped by default because that is what the
  // built-in adapters do. `emitUnpaired: true` keeps it as a running call.
  if (entrySpec?.toolCall?.emitUnpaired) {
    for (const p of pending.values()) {
      messages.push(
        makeToolMessage({
          id: undefined,
          name: p.name,
          args: p.args ?? null,
          text: "",
          status: "running",
          createdAt: p.createdAt,
        }),
      );
    }
    pending.clear();
  }
  return messages;
}

function firstUserText(messages) {
  for (const m of messages) {
    if (m.role === "user" && m.content) return m.content;
  }
  return "";
}

module.exports = {
  mapEntry,
  mapEntries,
  mapToolStatus,
  resultStatus,
  resultToText,
  firstUserText,
  blockValueText,
};
