/**
 * User-defined sources (declarative only).
 *
 * A user can add a source by dropping a JSON spec at
 *   <workspace>/docs/session-import-sources.json
 * `docs/**` is already inside the plugin's declared fs.read scope, so this
 * needs no new permission.
 *
 * SECURITY: the plugin runs with full read access to the user's home
 * directory. Accepting executable code from a config file would therefore be
 * arbitrary code execution. Specs are validated to be pure data:
 *   - no functions / non-JSON values
 *   - no keys from a code-ish denylist (eval/require/script/transform/...)
 *   - driver must be a registered driver name
 *   - id must match the plugin-sdk source id regex and must not shadow a
 *     built-in source
 *   - the data root cannot be absurdly broad ("/" or the home dir itself)
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { driverNames } = require("./drivers");

/** Relative to the workspace root; inside the declared fs.read scope. */
const CONFIG_PATH = "docs/session-import-sources.json";

/** plugin-sdk/src/index.ts — source id regex. */
const SOURCE_ID_RE = /^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/;

/** Built-in source ids that must never be shadowed by a custom spec. */
const BUILTIN_IDS = ["zcode", "workbuddy", "claude-code", "codex", "opencode", "pi"];

/**
 * Keys that would turn data into behaviour. Any occurrence anywhere in the
 * spec (at any depth) is rejected outright.
 */
const FORBIDDEN_KEYS = new Set([
  "eval",
  "function",
  "functions",
  "require",
  "import",
  "script",
  "code",
  "transform",
  "exec",
  "spawn",
  "constructor",
  "__proto__",
  "prototype",
]);

const MAX_SPECS = 25;
const MAX_JSON_BYTES = 512 * 1024;
const MAX_DEPTH = 12;

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Reject any spec containing code-ish keys or non-data values, at any depth. */
function assertDeclarative(value, errors, at = "$", depth = 0) {
  if (depth > MAX_DEPTH) {
    errors.push(`${at}: nesting too deep (max ${MAX_DEPTH})`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertDeclarative(v, errors, `${at}[${i}]`, depth + 1));
    return;
  }
  if (!isPlainObject(value)) {
    const t = typeof value;
    if (!["string", "number", "boolean"].includes(t) && value !== null) {
      errors.push(`${at}: unsupported value type "${t}" (specs must be plain data)`);
    }
    return;
  }
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
      errors.push(`${at}.${key}: forbidden key (specs are declarative data only)`);
      continue;
    }
    assertDeclarative(value[key], errors, `${at}.${key}`, depth + 1);
  }
}

function resolveAndGuard(p, errors, field) {
  if (typeof p !== "string" || !p.trim()) {
    errors.push(`${field}: must be a non-empty string path`);
    return null;
  }
  const home = os.homedir();
  const expanded =
    p === "~" ? home : p.startsWith("~/") ? path.join(home, p.slice(2)) : p;
  const abs = path.normalize(path.isAbsolute(expanded) ? expanded : path.resolve(expanded));
  if (abs === path.sep) {
    errors.push(`${field}: refusing to scan the filesystem root`);
    return null;
  }
  if (abs === home) {
    errors.push(`${field}: refusing to scan the entire home directory (point at a subdir)`);
    return null;
  }
  return abs;
}

/** Validate one spec; returns { ok, errors, spec } (spec has resolved paths). */
function validateSpec(raw, index) {
  const errors = [];
  const at = `specs[${index}]`;

  if (!isPlainObject(raw)) {
    return { ok: false, errors: [`${at}: must be an object`], spec: null };
  }

  assertDeclarative(raw, errors, at);

  const id = raw.id;
  if (typeof id !== "string" || !SOURCE_ID_RE.test(id)) {
    errors.push(`${at}.id: must match ${SOURCE_ID_RE}`);
  } else if (BUILTIN_IDS.includes(id)) {
    errors.push(`${at}.id: "${id}" is a built-in source and cannot be overridden`);
  }

  const label = raw.label;
  if (typeof label !== "string" || !label.trim()) {
    errors.push(`${at}.label: must be a non-empty string`);
  }

  const driver = raw.driver;
  if (typeof driver !== "string" || !driverNames().includes(driver)) {
    errors.push(`${at}.driver: must be one of ${driverNames().join(", ")}`);
  }

  // Each driver carries its data under a different key; resolve + guard it.
  const spec = { ...raw };
  if (driver === "sqlite-session") {
    const db = resolveAndGuard(raw.db, errors, `${at}.db`);
    if (db) spec.db = db;
  } else {
    const root = resolveAndGuard(raw.root, errors, `${at}.root`);
    if (root) spec.root = root;
  }

  if (errors.length) return { ok: false, errors, spec: null };
  return { ok: true, errors: [], spec };
}

/**
 * Load and validate every custom spec for a workspace.
 * Missing / malformed config is not an error — it just yields no sources.
 */
async function loadCustomSources(options = {}) {
  const { workspaceRoot = null, readText = null } = options;
  const result = { specs: [], errors: [], configPath: CONFIG_PATH };

  let raw = null;
  if (typeof readText === "function") {
    // Preferred path: host-mediated read. The host resolves CONFIG_PATH
    // against the workspace and enforces the declared fs.read scope, so the
    // plugin never reaches outside its permissions.
    try {
      raw = await readText(CONFIG_PATH);
    } catch {
      return result; // absent / unreadable -> simply no custom sources
    }
  } else if (workspaceRoot) {
    // Fallback for tests and for hosts without a usable fs bridge.
    const configPath = path.join(workspaceRoot, CONFIG_PATH);
    result.configPath = configPath;
    try {
      const st = fs.statSync(configPath);
      if (st.size > MAX_JSON_BYTES) {
        result.errors.push(`config too large (${st.size} bytes > ${MAX_JSON_BYTES})`);
        return result;
      }
      raw = fs.readFileSync(configPath, "utf8");
    } catch {
      return result;
    }
  } else {
    return result;
  }

  if (typeof raw !== "string" || !raw.trim()) return result;
  if (Buffer.byteLength(raw) > MAX_JSON_BYTES) {
    result.errors.push(`config too large (> ${MAX_JSON_BYTES} bytes)`);
    return result;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    result.errors.push(`config is not valid JSON: ${err && err.message}`);
    return result;
  }

  const list = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.sources) ? parsed.sources : null;
  if (!list) {
    result.errors.push('config must be an array of specs, or { "sources": [...] }');
    return result;
  }
  if (list.length > MAX_SPECS) {
    result.errors.push(`too many specs (${list.length} > ${MAX_SPECS})`);
    return result;
  }

  list.forEach((rawSpec, i) => {
    const { ok, errors, spec } = validateSpec(rawSpec, i);
    if (ok) result.specs.push(spec);
    else result.errors.push(...errors);
  });

  return result;
}

module.exports = {
  CONFIG_PATH,
  SOURCE_ID_RE,
  BUILTIN_IDS,
  FORBIDDEN_KEYS,
  validateSpec,
  loadCustomSources,
  assertDeclarative,
};
