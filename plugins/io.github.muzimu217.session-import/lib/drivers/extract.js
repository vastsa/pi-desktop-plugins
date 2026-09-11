/**
 * Declarative value extraction used by every format driver.
 *
 * Drivers never embed app-specific logic; a spec describes *where* to look
 * (dotted path / block array / first-non-empty / literal) and these helpers
 * do the walking. That is what lets a new source be added as JSON instead of
 * a new .js adapter.
 */
"use strict";

/** Resolve a dotted path ("a.b.c" or "a.0.b") against an object. */
function getPath(obj, dotted) {
  if (obj == null || !dotted) return undefined;
  const parts = String(dotted).split(".").filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = Array.isArray(cur) ? cur[Number(p)] : cur[p];
  }
  return cur;
}

const isNonEmptyStr = (v) => typeof v === "string" && v.trim().length > 0;

/** Coerce any value to display text (objects/arrays -> JSON). */
function asText(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return "";
  }
}

/**
 * Extract text from one entry via a declarative rule. Accepted shapes:
 *   "a.b"                                   -> value at that path
 *   { path: "a.b" }                          -> value at that path
 *   { literal: "x" }                         -> constant
 *   { first: [rule, rule, ...] }             -> first non-empty result
 *   { blocks: { path, typeField, types, textField } }
 *        -> array at path; keep items whose typeField is in types (or all
 *           when types is empty); join their textField (or the item itself).
 */
function extractText(rule, entry) {
  if (!rule) return "";
  if (typeof rule === "string") return asText(getPath(entry, rule));
  if (typeof rule.literal === "string") return rule.literal;
  if (Array.isArray(rule.first)) {
    for (const sub of rule.first) {
      const v = extractText(sub, entry);
      if (v) return v;
    }
    return "";
  }
  if (rule.blocks) {
    const arr = getPath(entry, rule.blocks.path);
    // Older entries carry content as a plain string — that IS the text.
    if (typeof arr === "string") return arr;
    // Never fall back to stringifying the array: content blocks may hold
    // thinking/tool_use payloads, and dumping their raw JSON into the
    // conversation is worse than emitting nothing.
    if (!Array.isArray(arr)) return "";
    const texts = [];
    for (const item of arr) {
      if (item == null) continue;
      if (typeof item !== "object") {
        texts.push(asText(item));
        continue;
      }
      const t = rule.blocks.typeField ? getPath(item, rule.blocks.typeField) : undefined;
      if (Array.isArray(rule.blocks.types) && rule.blocks.types.length) {
        if (!rule.blocks.types.includes(t)) continue;
      }
      const txt = rule.blocks.textField ? getPath(item, rule.blocks.textField) : item;
      if (isNonEmptyStr(txt)) texts.push(txt);
      else if (txt != null) texts.push(asText(txt));
    }
    return texts.join("\n").trim();
  }
  if (rule.path) return asText(getPath(entry, rule.path));
  return "";
}

/** Extract a raw (unstringified) value — used for roles, ids, tool payloads. */
function extractValue(rule, entry) {
  if (!rule) return undefined;
  if (typeof rule === "string") return getPath(entry, rule);
  if (rule.path) return getPath(entry, rule.path);
  return undefined;
}

/** Map a raw role through a spec's roleMap, defaulting to the raw value. */
function mapRole(raw, roleMap) {
  const key = raw == null ? "" : String(raw);
  if (roleMap && Object.prototype.hasOwnProperty.call(roleMap, key)) {
    return String(roleMap[key]);
  }
  return key;
}

/** Normalize a timestamp (ms | s | iso string) to an ISO string. */
function toIso(value, unit) {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = unit === "s" ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof value === "string") {
    const n = Number(value);
    if (/^\d+$/.test(value.trim()) && Number.isFinite(n)) {
      const ms = unit === "s" ? n * 1000 : n;
      const d = new Date(ms);
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

/**
 * Whitelisted text post-processing.
 *
 * Several agents wrap injected context in XML-ish tags (WorkBuddy:
 * <system-reminder>, <user_query>; Codex: markdown instructions). Stripping
 * them is a pure string operation over already-extracted text, so a spec can
 * ask for it without ever supplying code. Tag names are charset-checked and
 * count-capped before they reach a RegExp.
 */
const MAX_TEXT_OPS = 8;
const MAX_TEXT_OP_TAGS = 16;
const TAG_RE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;

function stripXmlBlocks(text, tags) {
  let out = text;
  for (const tag of Array.isArray(tags) ? tags.slice(0, MAX_TEXT_OP_TAGS) : []) {
    if (typeof tag !== "string" || !TAG_RE.test(tag)) continue;
    out = out.replace(new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}>`, "gi"), "");
    out = out.replace(new RegExp(`<${tag}\\b[\\s\\S]*$`, "i"), "");
  }
  return out;
}

function extractXmlTag(text, tag) {
  if (typeof tag !== "string" || !TAG_RE.test(tag)) return text;
  const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? m[1].trim() : text;
}

/**
 * Apply a spec's `textOps` to extracted text.
 *   [{ op:"stripXmlBlocks", tags:[...], roles:["user"] },
 *    { op:"extractXmlTag",  tag:"user_query", roles:["user"] }]
 * `roles` restricts an op to a mapped role; omit it to apply to every role.
 */
function applyTextOps(text, ops, role) {
  if (!text || !Array.isArray(ops) || !ops.length) return text;
  let out = text;
  let applied = 0;
  for (const op of ops) {
    if (applied >= MAX_TEXT_OPS) break;
    if (!op || typeof op !== "object") continue;
    if (Array.isArray(op.roles) && op.roles.length && !op.roles.includes(role)) continue;
    applied += 1;
    const name = String(op.op ?? "");
    if (name === "stripXmlBlocks") out = stripXmlBlocks(out, op.tags);
    else if (name === "extractXmlTag") out = extractXmlTag(out, op.tag);
  }
  return out.trim();
}

/** Is this text dropped by a spec's `drop` rule? */
function droppedBy(rule, text, role) {
  if (!rule || typeof rule !== "object") return false;
  if (Array.isArray(rule.roles) && rule.roles.length && !rule.roles.includes(role)) {
    return false;
  }
  if (Array.isArray(rule.startsWith) && rule.startsWith.length) {
    for (const p of rule.startsWith) {
      if (typeof p === "string" && p && text.startsWith(p)) return true;
    }
  }
  if (Array.isArray(rule.equals) && rule.equals.length && rule.equals.includes(text)) {
    return true;
  }
  return false;
}

module.exports = {
  getPath,
  asText,
  extractText,
  extractValue,
  mapRole,
  toIso,
  applyTextOps,
  droppedBy,
};
