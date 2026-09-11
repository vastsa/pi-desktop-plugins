/**
 * sqlite-session driver
 *
 * Reads the three-layer on-disk model shared by ZCode and OpenCode:
 *   session -> message -> part, with per-row payloads in a JSON `data` column.
 * Column names and JSON paths come from the spec, so any app using this shape
 * (or a simple session+message pair) is configurable rather than hand-coded.
 *
 * Spec:
 *   db, maxSessions
 *   session: { table, idCol, titleCol, pathCol, createdCol, updatedCol }
 *   message: { table, idCol, sessionIdCol, createdCol, dataCol,
 *              rolePath, tsPath, modelIdPath, providerIdPath }
 *   part:    { table, messageIdCol, sessionIdCol, createdCol, dataCol,
 *              textTypes[], toolType, toolNamePath, argsPath, resultPath,
 *              statusPath, skipSynthetic }
 *   Omit `part` entirely for apps that store message text directly (set
 *   message.contentPath instead).
 */
"use strict";

const { toIso, truncateTitle, projectNameOf } = require("../util");
const { extractValue, getPath, asText, toIso: tsToIso } = require("./extract");
const path = require("node:path");
const { resolveSafe } = require("./fsutil");

const DRIVER = "sqlite-session";

function openDb(dbPath) {
  const { DatabaseSync } = require("node:sqlite");
  return new DatabaseSync(dbPath, { readOnly: true });
}

function parseJsonColumn(raw) {
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function mapToolStatus(status) {
  const s = status == null ? "" : String(status);
  if (s === "error" || s === "failed") return "error";
  if (s === "completed" || s === "success") return "success";
  return "running";
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Quote an identifier for safe interpolation into SQL (columns can't be bound). */
function ident(name) {
  const s = String(name ?? "");
  if (!IDENT_RE.test(s) || s.length > 64) {
    throw new Error(`invalid SQL identifier: ${s}`);
  }
  return `"${s}"`;
}

function tsValue(row, col, fallback, unit) {
  return tsToIso(row?.[col] ?? fallback, unit) ?? toIso(row?.[col] ?? fallback) ?? null;
}

/**
 * Build a structured exclusion filter, e.g.
 *   exclude: [{ col: "task_type", equals: "subagent_child" }]
 *
 * Values are bound (never interpolated) and the column is checked against the
 * real table schema, so a spec can filter rows without ever supplying SQL.
 * Unknown columns are ignored rather than crashing the scan.
 * IFNULL(...,'') keeps rows whose column is NULL.
 */
/** Column names of a table, or an empty set when the table is missing. */
function tableColumns(db, table) {
  try {
    return new Set(db.prepare(`PRAGMA table_info(${ident(table)})`).all().map((r) => r.name));
  } catch {
    return new Set();
  }
}

/**
 * Build an ORDER BY that follows the app's own ordering.
 *
 * ZCode/OpenCode disagree here: ZCode writes a monotonic `sequence` column and
 * its built-in adapter sorts by `sequence, time_created, id`, while OpenCode
 * has no such column at all. Ordering by time alone reorders parts that were
 * written in the same millisecond, so the column is used whenever it exists.
 */
function buildOrderBy(db, table, cols) {
  const have = tableColumns(db, table);
  const parts = [];
  for (const c of cols) {
    if (c && have.has(c)) parts.push(ident(c));
  }
  return parts.length ? ` ORDER BY ${parts.join(", ")}` : "";
}

function buildExclusionClause(db, table, exclude) {
  const out = { sql: "", params: [] };
  if (!Array.isArray(exclude) || !exclude.length) return out;
  const cols = tableColumns(db, table);
  for (const rule of exclude) {
    if (!rule || typeof rule.col !== "string" || !cols.has(rule.col)) continue;
    const c = ident(rule.col);
    if (Array.isArray(rule.in) && rule.in.length) {
      const ph = rule.in.map(() => "?").join(",");
      out.sql += ` AND IFNULL(${c},'') NOT IN (${ph})`;
      out.params.push(...rule.in.map(String));
    } else if (rule.equals !== undefined && rule.equals !== null) {
      out.sql += ` AND IFNULL(${c},'') <> ?`;
      out.params.push(String(rule.equals));
    }
  }
  return out;
}

async function scan(spec, sourceId) {
  const dbPath = resolveSafe(spec.db);
  let db;
  try {
    db = openDb(dbPath);
  } catch {
    return []; // DB absent / unreadable -> nothing to import
  }

  const s = spec.session ?? {};
  const m = spec.message ?? {};
  try {
    const sTable = ident(s.table ?? "session");
    const mTable = m.table ? ident(m.table) : null;
    const limit = Number.isFinite(spec.maxSessions) ? ` LIMIT ${Math.max(1, spec.maxSessions | 0)}` : "";

    const exclusion = buildExclusionClause(db, s.table ?? "session", s.exclude);
    let rows;
    if (mTable) {
      rows = db
        .prepare(
          `SELECT s.${ident(s.idCol ?? "id")} AS sid,
                  s.${ident(s.titleCol ?? "title")} AS title,
                  s.${ident(s.pathCol ?? "directory")} AS directory,
                  s.${ident(s.createdCol ?? "time_created")} AS created,
                  s.${ident(s.updatedCol ?? "time_updated")} AS updated,
                  COALESCE(m.message_count, 0) AS message_count
             FROM ${sTable} s
             LEFT JOIN (
               SELECT ${ident(m.sessionIdCol ?? "session_id")} AS sid, COUNT(*) AS message_count
                 FROM ${mTable}
                GROUP BY ${ident(m.sessionIdCol ?? "session_id")}
             ) m ON m.sid = s.${ident(s.idCol ?? "id")}
            WHERE m.message_count > 0${exclusion.sql}${limit}`,
        )
        .all(...exclusion.params);
    } else {
      rows = db
        .prepare(
          `SELECT ${ident(s.idCol ?? "id")} AS sid,
                  ${ident(s.titleCol ?? "title")} AS title,
                  ${ident(s.pathCol ?? "directory")} AS directory,
                  ${ident(s.createdCol ?? "time_created")} AS created,
                  ${ident(s.updatedCol ?? "time_updated")} AS updated,
                  0 AS message_count
             FROM ${sTable} WHERE 1=1${exclusion.sql}${limit}`,
        )
        .all(...exclusion.params);
    }

    const summaries = [];
    for (const row of rows) {
      if (!row.sid) continue;
      const created = tsToIso(row.created, spec.tsUnit) ?? toIso(row.created);
      const updated = tsToIso(row.updated, spec.tsUnit) ?? toIso(row.updated, created);
      const title = String(row.title ?? "");
      summaries.push({
        source: sourceId,
        externalId: String(row.sid),
        title: truncateTitle(title) || String(row.sid),
        fullTitle: title,
        projectName: projectNameOf(row.directory) ?? (spec.fallbackProject || null),
        projectPath: row.directory ?? null,
        modelId: null,
        providerId: null,
        createdAt: created,
        updatedAt: updated || created,
        messageCount: Number(row.message_count ?? 0),
        filePath: dbPath,
      });
    }
    return summaries;
  } finally {
    db.close();
  }
}

async function convert(spec, summary) {
  const dbPath = resolveSafe(spec.db);
  if (typeof summary.filePath === "string" && path.resolve(summary.filePath) !== dbPath) {
    return { session: null, messages: [] };
  }
  const db = openDb(dbPath);
  const m = spec.message ?? {};
  const p = spec.part ?? null;
    const msgTable = ident(m.table ?? "message");
    const idCol = ident(m.idCol ?? "id");
    const sidCol = ident(m.sessionIdCol ?? "session_id");
    const msgOrder = buildOrderBy(db, m.table ?? "message", [
      m.sequenceCol === null ? null : m.sequenceCol ?? "sequence",
      m.createdCol ?? "time_created",
      m.idCol ?? "id",
    ]);

    try {
      const messageRows = db
        .prepare(
          `SELECT ${idCol} AS mid, ${ident(m.createdCol ?? "time_created")} AS created,
                  ${ident(m.dataCol ?? "data")} AS data
             FROM ${msgTable}
            WHERE ${sidCol} = ?${msgOrder}`,
        )
        .all(summary.externalId);

      const partsByMessage = new Map();
      if (p) {
        const partTable = p.table ?? "part";
        const partOrder = buildOrderBy(db, partTable, [
          p.sequenceCol === null ? null : p.sequenceCol ?? "sequence",
          p.createdCol ?? "time_created",
          "id",
        ]);
        const partRows = db
          .prepare(
            `SELECT ${ident(p.messageIdCol ?? "message_id")} AS mid,
                    ${ident(p.dataCol ?? "data")} AS data
               FROM ${ident(partTable)}
              WHERE ${ident(p.sessionIdCol ?? "session_id")} = ?${partOrder}`,
          )
          .all(summary.externalId);
      for (const row of partRows) {
        const part = parseJsonColumn(row.data);
        if (!part || typeof part !== "object" || !row.mid) continue;
        const bucket = partsByMessage.get(row.mid) ?? [];
        bucket.push(part);
        partsByMessage.set(row.mid, bucket);
      }
    }

    const textTypes = p?.textTypes ?? ["text"];
    const toolType = p?.toolType ?? "tool";
    const skipSynthetic = p?.skipSynthetic !== false;

    const messages = [];
    let modelId = null;
    let providerId = null;

    const flushText = (role, createdAt, texts) => {
      const text = texts.join("\n").trim();
      texts.length = 0;
      if (!text) return;
      messages.push({ role, content: text, createdAt });
    };

    for (const row of messageRows) {
      const msg = parseJsonColumn(row.data) ?? {};
      if (!row.mid) continue;
      const role = String(getPath(msg, m.rolePath ?? "role") ?? "");
      if (role !== "user" && role !== "assistant") continue;
      const createdAt =
        tsToIso(getPath(msg, m.tsPath ?? "time.created"), spec.tsUnit) ?? toIso(row.created);
      if (role === "assistant") {
        modelId = getPath(msg, m.modelIdPath ?? "modelID") ?? modelId;
        providerId = getPath(msg, m.providerIdPath ?? "providerID") ?? providerId;
      }

      const parts = partsByMessage.get(row.mid) ?? [];
      const texts = [];
      for (const part of parts) {
        const type = getPath(part, "type");
        if (type === toolType) {
          flushText(role, createdAt, texts);
          const output = extractValue(p?.resultPath ?? "state.output", part);
          const outputText = typeof output === "string" ? output : asText(output);
          messages.push({
            role: "tool",
            content: outputText,
            toolName: String(getPath(part, p?.toolNamePath ?? "tool") ?? "tool"),
            toolStatus: mapToolStatus(extractValue(p?.statusPath ?? "state.status", part)),
            toolArgs: extractValue(p?.argsPath ?? "state.input", part) ?? null,
            toolResult: outputText,
            createdAt,
          });
        } else if (!textTypes.length || textTypes.includes(type)) {
          if (skipSynthetic && getPath(part, "synthetic") === true) continue;
          const text = getPath(part, "text");
          if (typeof text === "string" && text) texts.push(text);
        }
      }
      flushText(role, createdAt, texts);

      // Apps without a part table keep text on the message row itself.
      if (!p) {
        const direct = m.contentPath ? getPath(msg, m.contentPath) : getPath(msg, "content");
        const text = typeof direct === "string" ? direct : asText(direct);
        if (text) messages.push({ role, content: text, createdAt });
      }
    }

    return {
      session: {
        id: `import-${summary.source}-${summary.externalId}`,
        title: summary.fullTitle || summary.title,
        projectPath: summary.projectPath ?? null,
        modelId,
        providerId,
        mode: "agent",
        createdAt: summary.createdAt,
        updatedAt: summary.updatedAt,
      },
      messages,
    };
  } finally {
    db.close();
  }
}

module.exports = { driver: DRIVER, scan, convert, openDb };
