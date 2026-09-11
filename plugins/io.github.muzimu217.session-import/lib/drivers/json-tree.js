/**
 * json-tree driver
 *
 * One JSON file per session, with the conversation nested inside it (the
 * legacy Claude/OpenCode per-file layout, and the shape plenty of tools use).
 *
 * Spec:
 *   root, extension (default .json), recursive, maxFiles, maxBytes
 *   session: { idPath, titlePath, tsPath, pathPath, messagesPath,
 *              fallbackProject }
 *   message: { rolePath, roleMap, content:rule, tsPath, tsUnit,
 *              skipTypePath, skipTypes[], tool:{...} }
 *   (the message block is the same declarative mapping the JSONL driver uses,
 *    provided by ../drivers/entry-map)
 */
"use strict";

const path = require("node:path");
const fsp = require("node:fs/promises");
const { toIso, truncateTitle, projectNameOf } = require("../util");
const { getPath, toIso: tsToIso } = require("./extract");
const { resolveSafe, listFiles, readText, isInside } = require("./fsutil");
const { mapEntries } = require("./entry-map");

const DRIVER = "json-tree";

function readJson(raw) {
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function loadSession(spec, file) {
  const raw = await readText(file, spec.maxBytes);
  const doc = readJson(raw);
  if (!doc || typeof doc !== "object") return null;
  const s = spec.session ?? {};
  const messages = await mapEntries(
    spec.message ?? {},
    getPath(doc, s.messagesPath ?? "messages") ?? [],
    { root: resolveSafe(spec.root) },
  );
  return { doc, messages };
}

async function scan(spec, sourceId) {
  const root = resolveSafe(spec.root);
  const files = await listFiles(root, {
    extension: spec.extension ?? ".json",
    recursive: spec.recursive !== false,
    max: spec.maxFiles,
    maxBytes: spec.maxBytes,
    maxDepth: spec.maxDepth,
  });
  const s = spec.session ?? {};

  const summaries = [];
  for (const file of files) {
    const loaded = await loadSession(spec, file);
    if (!loaded) continue;
    const { doc, messages } = loaded;
    if (!messages.length) continue;

    const base = path.basename(file, path.extname(file));
    const externalId = String(getPath(doc, s.idPath ?? "id") ?? base);
    const title = String(getPath(doc, s.titlePath ?? "title") ?? "") || base;
    const projectPath = getPath(doc, s.pathPath ?? "directory") ?? path.dirname(file);
    const ts = tsToIso(getPath(doc, s.tsPath ?? "createdAt"), spec.tsUnit);

    let mtime = null;
    try {
      mtime = toIso((await fsp.stat(file)).mtimeMs);
    } catch {
      mtime = null;
    }

    summaries.push({
      source: sourceId,
      externalId,
      title: truncateTitle(title),
      fullTitle: title,
      projectName: projectNameOf(projectPath) ?? s.fallbackProject ?? null,
      projectPath: typeof projectPath === "string" ? projectPath : null,
      modelId: null,
      providerId: null,
      createdAt: ts || mtime,
      updatedAt: ts || mtime,
      messageCount: messages.length,
      filePath: file,
    });
  }
  return summaries;
}

async function convert(spec, summary) {
  const root = resolveSafe(spec.root);
  const file = typeof summary.filePath === "string" ? path.resolve(summary.filePath) : "";
  if (!file || !isInside(file, root)) return { session: null, messages: [] };
  const loaded = await loadSession(spec, file);
  if (!loaded) return { session: null, messages: [] };

  return {
    session: {
      id: `import-${summary.source}-${summary.externalId}`,
      title: summary.fullTitle || summary.title,
      projectPath: summary.projectPath ?? null,
      modelId: null,
      providerId: null,
      mode: "agent",
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
    },
    messages: loaded.messages,
  };
}

module.exports = { driver: DRIVER, scan, convert };
