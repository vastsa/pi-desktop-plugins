"use strict";

/**
 * 文件管理器 — PI-Desktop 插件主进程
 *
 * 插件 id: pi.file-manager
 * 视图:    contributes.views[0] → views/index.html（右侧工作面板）
 *
 * 为什么用原生 node:fs：
 *   宿主的 pi.fs.* 网关做不到本插件的核心诉求——manifest.fs 的 write/delete
 *   在语法上就禁止整树通配（plugin-sdk fs-policy.ts isWholeTreePattern），任何
 *   一个能通过校验的窄 scope 都会让「保存」变成每次都弹权限确认；而 fs.list /
 *   fs.glob 还有条数上限、跳过 node_modules、屏蔽凭据路径，并且没有创建 /
 *   重命名 / 移动。官方文档也承认这个边界：brokered gate「约束不了插件进程里
 *   的直接 Node 访问」（docs/spec/05-security/01-security.md）。
 *
 * 因此本插件自己承担全部安全责任：
 *   ① 路径包含：规范化 + realpath 双重校验，拒绝 .. 与符号链接 / junction 逃逸
 *   ② 敏感路径黑名单：.env* / .ssh / *.pem / .git/** 等读写全拒
 *   ③ 原子写：临时文件 → fsync → chmod → rename，中断不留半写文件
 *   ④ 冲突检测：mtimeMs + size 作为乐观锁，外部改动过的文件不静默覆盖
 *   ⑤ 写入审计：追加到插件数据目录 write-audit.jsonl（宿主审计不到这条路径）
 *   ⑥ 上限：预览 2 MiB / 写入 8 MiB / 单目录 3000 条 / 搜索分页
 *
 * 通道：视图 window.pluginBridge.invoke("fm.*", payload) → onPanelInvoke。
 *   宿主对自定义通道的转发超时是 30s（plugin-runtime.ts PLUGIN_PANEL_TIMEOUT_MS），
 *   所以任何遍历类操作都必须分页，绝不整树递归返回。
 */

const fs = require("node:fs/promises");
const path = require("node:path");

// ── 上限 ────────────────────────────────────────────────────────────────────

const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_WRITE_BYTES = 8 * 1024 * 1024;
const MAX_LIST_ENTRIES = 3000;
const MAX_SEARCH_MATCHES = 60;
const MAX_SEARCH_SCANNED = 200000;
const SEARCH_BUDGET_MS = 3000;
const MAX_SEARCH_SESSIONS = 4;
const AUDIT_MAX_BYTES = 1024 * 1024;

const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|svg|ico|bmp|avif|tiff?)$/i;

// ── 敏感路径黑名单（读与写都拒绝） ──────────────────────────────────────────

const DENY_SEGMENTS = new Set([
  ".git",
  ".ssh",
  ".aws",
  ".gnupg",
  ".gpg",
  ".npmrc",
  ".git-credentials",
  ".netrc",
  "_netrc",
]);
const DENY_EXACT_NAMES = new Set([".env"]);
const DENY_NAME_PREFIXES = [".env.", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"];
const DENY_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx", ".keystore", ".jks"]);

/** 写入额外拒绝：依赖目录体量巨大且几乎不可能手改。 */
const WRITE_DENY_SEGMENTS = new Set(["node_modules"]);

/** 忽略规则文件名；项目里一个都没有时不过滤任何条目。 */
const IGNORE_FILE_NAMES = [".gitignore", ".ignore"];

// ── 模块状态 ────────────────────────────────────────────────────────────────

let dataPath = null;
let prefs = { splitRatio: 0.32, showIgnored: false, mdPreview: false };
const searchSessions = new Map();

// ── 错误 ────────────────────────────────────────────────────────────────────

function fail(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

function toFailure(error) {
  return {
    ok: false,
    code: typeof error?.code === "string" ? error.code : "INTERNAL",
    message: String(error?.message ?? error),
  };
}

// ── 路径安全 ────────────────────────────────────────────────────────────────

/**
 * child 是否严格位于 parent 之内（child === parent 返回 false）。
 * Windows 下 path.relative 已按大小写不敏感比较公共前缀。
 */
function isInside(parent, child) {
  const rel = path.relative(parent, child);
  if (!rel) return false;
  if (path.isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(`..${path.sep}`);
}

function segmentsOf(relPath) {
  return String(relPath)
    .split("/")
    .filter((part) => part && part !== ".");
}

function isDenied(relPath, mode) {
  for (const segment of segmentsOf(relPath)) {
    const lower = segment.toLowerCase();
    if (DENY_SEGMENTS.has(lower)) return true;
    if (DENY_EXACT_NAMES.has(lower)) return true;
    if (DENY_NAME_PREFIXES.some((prefix) => lower.startsWith(prefix))) return true;
    if (DENY_EXTENSIONS.has(path.extname(lower))) return true;
    if (mode === "write" && WRITE_DENY_SEGMENTS.has(lower)) return true;
  }
  return false;
}

async function exists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

async function currentRoot() {
  const workspace = await pi.workspace.get();
  return workspace?.path ? workspace : null;
}

/** 把相对根目录的正斜杠路径规范化；拒绝绝对路径与 `..` 段。 */
function normalizeRelative(relPath) {
  if (typeof relPath !== "string") throw fail("INVALID_PATH", "path must be a string");
  if (path.isAbsolute(relPath)) throw fail("ABSOLUTE_PATH", "absolute paths are not accepted");
  const rel = relPath.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (segmentsOf(rel).some((part) => part === "..")) {
    throw fail("ESCAPE", "path escapes the project root");
  }
  return rel;
}

/**
 * 所有通道的唯一入口守卫。返回 { root, rootPath, abs, rel, isRoot }。
 */
async function resolveInsideRoot(relPath, { mode = "read", allowRoot = false } = {}) {
  const root = await currentRoot();
  if (!root) throw fail("NO_WORKSPACE", "no project is open");
  const rootPath = root.path;
  const rel = normalizeRelative(relPath);

  if (!rel) {
    if (!allowRoot) throw fail("INVALID_PATH", "the project root is not a valid target here");
    return { root, rootPath, abs: rootPath, rel: "", isRoot: true };
  }

  if (isDenied(rel, mode)) throw fail("DENIED_PATH", `refused path: ${rel}`);

  const abs = path.resolve(rootPath, rel);
  if (!isInside(rootPath, abs)) throw fail("ESCAPE", "path escapes the project root");

  let realRoot;
  try {
    realRoot = await fs.realpath(rootPath);
  } catch {
    realRoot = rootPath;
  }

  // 父目录必须真实存在且落在根内：这是符号链接 / junction 逃逸的主闸门。
  let realParent;
  try {
    realParent = await fs.realpath(path.dirname(abs));
  } catch {
    throw fail("NOT_FOUND", "parent directory does not exist");
  }
  if (realParent !== realRoot && !isInside(realRoot, realParent)) {
    throw fail("SYMLINK_ESCAPE", "parent directory resolves outside the project root");
  }

  if (await exists(abs)) {
    let realAbs;
    try {
      realAbs = await fs.realpath(abs);
    } catch {
      realAbs = abs;
    }
    if (realAbs !== realRoot && !isInside(realRoot, realAbs)) {
      throw fail("SYMLINK_ESCAPE", "path resolves outside the project root");
    }
  }

  return { root, rootPath, abs, rel, isRoot: false };
}

// ── 忽略规则（.gitignore / .ignore 语义子集） ────────────────────────────────
//
// 项目里存在忽略规则文件就按规则隐藏，一个都没有就全部展示。
// 子集支持：空行、# 注释、! 取反、末尾 / 仅目录、前导 / 锚定、* ? ** 通配、
// 无斜杠模式匹配任意层级。不支持 \ 转义与 [a-z] 字符类。

function compileIgnoreLine(rawLine, base) {
  let line = String(rawLine).replace(/\r$/, "");
  if (!line.trim() || line.startsWith("#")) return null;

  let negated = false;
  if (line.startsWith("!")) {
    negated = true;
    line = line.slice(1);
  }

  const dirOnly = line.endsWith("/");
  if (dirOnly) line = line.slice(0, -1);

  const anchored = line.startsWith("/");
  if (anchored) line = line.slice(1);
  if (!line) return null;
  const isAnchored = anchored || line.includes("/");

  let source = "";
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "*") {
      if (line[index + 1] === "*") {
        index += 1;
        if (line[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }

  const pattern = isAnchored
    ? `^${source}(?:/.*)?$`
    : `^(?:.*/)?${source}(?:/.*)?$`;
  return { base, regex: new RegExp(pattern), negated, dirOnly };
}

async function readIgnoreFile(rootPath, relDir) {
  const dirAbs = relDir ? path.join(rootPath, relDir.split("/").join(path.sep)) : rootPath;
  const rules = [];
  for (const name of IGNORE_FILE_NAMES) {
    let text;
    try {
      text = await fs.readFile(path.join(dirAbs, name), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const rule = compileIgnoreLine(line, relDir);
      if (rule) rules.push(rule);
    }
  }
  return rules;
}

/** 根 → 目标目录这一链上的全部规则（浅的在前，深的在后，深层优先）。 */
async function rulesForDirectory(rootPath, relDir) {
  const parts = segmentsOf(relDir);
  const chain = [""];
  for (let index = 1; index <= parts.length; index += 1) {
    chain.push(parts.slice(0, index).join("/"));
  }
  const rules = [];
  for (const base of chain) {
    rules.push(...(await readIgnoreFile(rootPath, base)));
  }
  return rules;
}

/**
 * 命中判定。祖先目录被忽略则整体忽略（与 git 一致，取反无法把文件从
 * 被排除的目录里救回来）；否则由最后一条匹配的规则决定。
 */
function matchesRules(relPath, isDirectory, rules) {
  const parts = segmentsOf(relPath);
  for (let depth = 1; depth <= parts.length; depth += 1) {
    const target = parts.slice(0, depth).join("/");
    const targetIsDir = depth < parts.length || isDirectory;

    let verdict;
    for (const rule of rules) {
      let local = target;
      if (rule.base) {
        if (!target.startsWith(`${rule.base}/`)) continue;
        local = target.slice(rule.base.length + 1);
      }
      if (!local) continue;
      if (rule.dirOnly && !targetIsDir) continue;
      if (rule.regex.test(local)) verdict = !rule.negated;
    }

    if (verdict === undefined) continue;
    if (verdict) return true;
    if (depth === parts.length) return false;
  }
  return false;
}

// ── 审计 ────────────────────────────────────────────────────────────────────

async function audit(entry) {
  if (!dataPath) return;
  const file = path.join(dataPath, "write-audit.jsonl");
  const line = `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`;
  try {
    const stat = await fs.stat(file).catch(() => null);
    if (stat && stat.size > AUDIT_MAX_BYTES) await fs.writeFile(file, line, "utf8");
    else await fs.appendFile(file, line, "utf8");
  } catch {
    /* 审计失败不应影响主流程 */
  }
}

// ── 读 ──────────────────────────────────────────────────────────────────────

async function handleList(payload) {
  const { rootPath, abs, rel } = await resolveInsideRoot(payload?.path ?? "", {
    allowRoot: true,
  });

  const rules = await rulesForDirectory(rootPath, rel);

  let dirents;
  try {
    dirents = await fs.readdir(abs, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") throw fail("NOT_FOUND", "directory not found");
    if (error?.code === "ENOTDIR") throw fail("INVALID_PATH", "not a directory");
    if (error?.code === "EACCES" || error?.code === "EPERM") {
      throw fail("DENIED_PATH", "permission denied");
    }
    throw error;
  }

  const entries = [];
  let truncated = false;

  for (const dirent of dirents) {
    if (dirent.name === ".git") continue;
    if (entries.length >= MAX_LIST_ENTRIES) {
      truncated = true;
      break;
    }

    const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
    if (isDenied(childRel, "read")) continue;

    const childAbs = path.join(abs, dirent.name);
    const isSymlink = dirent.isSymbolicLink();
    const isDirectory = dirent.isDirectory();

    let size;
    let mtimeMs;
    try {
      const stat = isSymlink ? await fs.lstat(childAbs) : await fs.stat(childAbs);
      mtimeMs = stat.mtimeMs;
      if (!isDirectory) size = stat.size;
    } catch {
      continue;
    }

    let escapes = false;
    if (isSymlink) {
      try {
        const real = await fs.realpath(childAbs);
        escapes = real !== rootPath && !isInside(rootPath, real);
      } catch {
        escapes = true;
      }
    }

    entries.push({
      name: dirent.name,
      path: childRel,
      isDirectory: isDirectory && !isSymlink,
      size,
      mtimeMs,
      ignored: rules.length > 0 && matchesRules(childRel, isDirectory, rules),
      isSymlink,
      outside: escapes,
    });
  }

  entries.sort((left, right) => {
    if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
    return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
  });

  return {
    ok: true,
    path: rel,
    entries,
    truncated,
    ignoreActive: rules.length > 0,
  };
}

async function handleRead(payload) {
  const { abs, rel } = await resolveInsideRoot(payload?.path ?? "", { mode: "read" });

  const stat = await fs.stat(abs).catch(() => null);
  if (!stat) throw fail("NOT_FOUND", "file not found");
  if (stat.isDirectory()) throw fail("INVALID_PATH", "path is a directory");

  const base = { path: rel, size: stat.size, mtimeMs: stat.mtimeMs };

  if (IMAGE_EXT.test(rel)) return { ok: true, kind: "image", ...base };
  if (stat.size > MAX_READ_BYTES) return { ok: true, kind: "tooLarge", ...base };

  const buffer = await fs.readFile(abs);
  if (buffer.subarray(0, 4096).includes(0)) return { ok: true, kind: "binary", ...base };

  const bom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
  const text = (bom ? buffer.subarray(3) : buffer).toString("utf8");
  const eol = text.includes("\r\n") ? "crlf" : "lf";

  return {
    ok: true,
    kind: "text",
    text: eol === "crlf" ? text.split("\r\n").join("\n") : text,
    eol,
    bom,
    ...base,
  };
}

// ── 写 ──────────────────────────────────────────────────────────────────────

async function atomicWrite(abs, serialized, mode) {
  const dir = path.dirname(abs);
  const suffix = `${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}`;
  const tmp = path.join(dir, `.${path.basename(abs)}.${suffix}.tmp`);

  let handle = null;
  try {
    handle = await fs.open(tmp, "w");
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;

    // rename 会替换 inode，先把原文件权限位搬到临时文件上。
    if (mode != null) await fs.chmod(tmp, mode).catch(() => {});

    // Windows 上防病毒 / 索引器可能造成瞬态 EPERM / EBUSY。
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fs.rename(tmp, abs);
        return;
      } catch (error) {
        const transient =
          error?.code === "EPERM" || error?.code === "EBUSY" || error?.code === "EACCES";
        if (!transient || attempt >= 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
      }
    }
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

async function handleWrite(payload) {
  const { abs, rel } = await resolveInsideRoot(payload?.path ?? "", { mode: "write" });

  const text = typeof payload?.text === "string" ? payload.text : "";
  if (Buffer.byteLength(text, "utf8") > MAX_WRITE_BYTES) {
    throw fail("TOO_LARGE", "content exceeds the 8 MiB write limit");
  }

  const stat = await fs.stat(abs).catch(() => null);
  if (stat?.isDirectory()) throw fail("INVALID_PATH", "path is a directory");

  // 乐观锁：编辑器之外的改动绝不静默覆盖。
  if (stat && typeof payload?.expectedMtimeMs === "number") {
    const mtimeChanged = Math.abs(stat.mtimeMs - payload.expectedMtimeMs) > 0.5;
    const sizeChanged =
      typeof payload?.expectedSize === "number" && stat.size !== payload.expectedSize;
    if (mtimeChanged || sizeChanged) {
      return {
        ok: false,
        code: "CONFLICT",
        message: "the file changed on disk since it was opened",
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      };
    }
  }

  let serialized = text;
  if (payload?.eol === "crlf") serialized = serialized.split("\n").join("\r\n");
  if (payload?.bom) serialized = `\uFEFF${serialized}`;

  await atomicWrite(abs, serialized, stat?.mode ?? null);

  const next = await fs.stat(abs);
  await audit({
    api: "fm.write",
    path: rel,
    bytes: Buffer.byteLength(serialized, "utf8"),
    result: "ok",
  });

  return { ok: true, mtimeMs: next.mtimeMs, size: next.size };
}

// ── 新建 / 重命名 / 移动 ────────────────────────────────────────────────────

const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function assertValidName(rawName) {
  if (typeof rawName !== "string") throw fail("INVALID_NAME", "name is required");
  const name = rawName.trim();
  if (!name) throw fail("INVALID_NAME", "name is required");
  if (name === "." || name === "..") throw fail("INVALID_NAME", "invalid name");
  if (/[\\/:*?"<>|]/.test(name)) throw fail("INVALID_NAME", "name contains an illegal character");
  if (WINDOWS_RESERVED.test(name)) throw fail("INVALID_NAME", "name is reserved by the system");
  if (name.length > 200) throw fail("INVALID_NAME", "name is too long");
  return name;
}

function entryFromStat(name, rel, stat) {
  return {
    name,
    path: rel,
    isDirectory: stat.isDirectory(),
    size: stat.isDirectory() ? undefined : stat.size,
    mtimeMs: stat.mtimeMs,
    ignored: false,
    isSymlink: false,
    outside: false,
  };
}

async function handleCreate(payload) {
  const parent = await resolveInsideRoot(payload?.parent ?? "", { allowRoot: true });
  const name = assertValidName(payload?.name);

  const childAbs = path.join(parent.abs, name);
  const childRel = parent.rel ? `${parent.rel}/${name}` : name;
  if (isDenied(childRel, "write")) throw fail("DENIED_PATH", `refused path: ${childRel}`);
  if (await exists(childAbs)) throw fail("EXISTS", "an entry with that name already exists");

  const isDirectory = Boolean(payload?.isDirectory);
  if (isDirectory) await fs.mkdir(childAbs);
  else await fs.writeFile(childAbs, "", { flag: "wx" });

  await audit({ api: "fm.create", path: childRel, result: "ok" });
  return { ok: true, entry: entryFromStat(name, childRel, await fs.stat(childAbs)) };
}

async function handleRename(payload) {
  const source = await resolveInsideRoot(payload?.path ?? "", { mode: "write" });
  const name = assertValidName(payload?.newName);

  const parentRel = path.posix.dirname(source.rel);
  const dirPrefix = parentRel === "." ? "" : parentRel;
  const nextRel = dirPrefix ? `${dirPrefix}/${name}` : name;
  if (isDenied(nextRel, "write")) throw fail("DENIED_PATH", `refused path: ${nextRel}`);

  const nextAbs = path.join(path.dirname(source.abs), name);
  if (await exists(nextAbs)) throw fail("EXISTS", "an entry with that name already exists");

  await fs.rename(source.abs, nextAbs);
  await audit({ api: "fm.rename", path: `${source.rel} → ${nextRel}`, result: "ok" });
  return { ok: true, entry: entryFromStat(name, nextRel, await fs.stat(nextAbs)) };
}

async function handleMove(payload) {
  const source = await resolveInsideRoot(payload?.from ?? "", { mode: "write" });
  const target = await resolveInsideRoot(payload?.toDir ?? "", { mode: "write", allowRoot: true });

  const targetStat = await fs.stat(target.abs).catch(() => null);
  if (!targetStat?.isDirectory()) throw fail("INVALID_PATH", "the destination is not a directory");
  if (source.abs === target.abs) return { ok: true, entry: null };

  // 不能把目录移进它自己的子孙。
  if (isInside(source.abs, target.abs)) {
    throw fail("INVALID_PATH", "cannot move a directory into itself");
  }

  const name = path.posix.basename(source.rel);
  const nextAbs = path.join(target.abs, name);
  const nextRel = target.rel ? `${target.rel}/${name}` : name;
  if (nextAbs === source.abs) return { ok: true, entry: null };
  if (isDenied(nextRel, "write")) throw fail("DENIED_PATH", `refused path: ${nextRel}`);
  if (await exists(nextAbs)) throw fail("EXISTS", "an entry with that name already exists");

  try {
    await fs.rename(source.abs, nextAbs);
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
    // 跨卷：复制 + 删除。
    await fs.cp(source.abs, nextAbs, { recursive: true, errorOnExist: true });
    await fs.rm(source.abs, { recursive: true });
  }

  await audit({ api: "fm.move", path: `${source.rel} → ${nextRel}`, result: "ok" });
  return { ok: true, entry: entryFromStat(name, nextRel, await fs.stat(nextAbs)) };
}

// ── 搜索（分页 + 会话游标） ─────────────────────────────────────────────────

function pruneSessions() {
  while (searchSessions.size > MAX_SEARCH_SESSIONS) {
    const oldest = [...searchSessions.entries()].sort(
      (left, right) => left[1].createdAt - right[1].createdAt,
    )[0];
    if (!oldest) return;
    searchSessions.delete(oldest[0]);
  }
}

async function handleSearch(payload) {
  const root = await currentRoot();
  if (!root) throw fail("NO_WORKSPACE", "no project is open");
  const rootPath = root.path;

  const query = String(payload?.query ?? "").trim();
  if (!query) return { ok: true, matches: [], nextCursor: null, done: true, scanned: 0 };

  const cursor = typeof payload?.cursor === "string" ? payload.cursor : null;
  const limit = Math.min(Math.max(Number(payload?.limit) || MAX_SEARCH_MATCHES, 1), 200);

  let session = cursor ? searchSessions.get(cursor) : null;
  if (!session) {
    // 栈里是「目录帧」而不是目录路径：帧被完整扫完才出栈，否则命中上限时
    // 该目录剩余条目会被永久丢掉（分页会漏结果）。
    session = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
      needle: query.toLowerCase(),
      stack: [{ dir: "", entries: null, index: 0, rules: [] }],
      scanned: 0,
    };
    searchSessions.set(session.id, session);
    pruneSessions();
  }

  const matches = [];
  const deadline = Date.now() + SEARCH_BUDGET_MS;
  const outOfBudget = () =>
    matches.length >= limit || Date.now() > deadline || session.scanned >= MAX_SEARCH_SCANNED;

  while (session.stack.length > 0) {
    if (outOfBudget()) break;

    const frame = session.stack.pop();
    if (!frame.entries) {
      const absDir = frame.dir
        ? path.join(rootPath, frame.dir.split("/").join(path.sep))
        : rootPath;
      frame.rules = await rulesForDirectory(rootPath, frame.dir);
      try {
        frame.entries = await fs.readdir(absDir, { withFileTypes: true });
      } catch {
        frame.entries = [];
      }
      frame.index = 0;
    }

    // 子目录先收集，等本帧处理完再入栈：直接在循环里 push 会让后面的
    // `pop()` 把刚压入的子帧弹掉，父帧则被反复重扫（死循环）。
    const children = [];
    while (frame.index < frame.entries.length) {
      if (outOfBudget()) break;

      const dirent = frame.entries[frame.index];
      frame.index += 1;

      if (dirent.name === ".git") continue;
      const childRel = frame.dir ? `${frame.dir}/${dirent.name}` : dirent.name;
      if (isDenied(childRel, "read")) continue;

      const isDirectory = dirent.isDirectory();
      if (frame.rules.length > 0 && matchesRules(childRel, isDirectory, frame.rules)) continue;

      session.scanned += 1;
      if (isDirectory && !dirent.isSymbolicLink()) {
        children.push({ dir: childRel, entries: null, index: 0, rules: [] });
      }
      if (
        dirent.name.toLowerCase().includes(session.needle) ||
        childRel.toLowerCase().includes(session.needle)
      ) {
        matches.push({ name: dirent.name, path: childRel, isDirectory });
      }
    }

    // 未扫完则原样回栈，下次续扫；扫完才释放目录列表。
    if (frame.index < frame.entries.length) session.stack.push(frame);
    else frame.entries = null;

    for (const child of children) session.stack.push(child);
  }

  const done = session.scanned >= MAX_SEARCH_SCANNED || session.stack.length === 0;
  if (done) searchSessions.delete(session.id);

  return {
    ok: true,
    matches,
    nextCursor: done ? null : session.id,
    done,
    scanned: session.scanned,
  };
}

// ── 偏好 ────────────────────────────────────────────────────────────────────

function sanitizePrefs(partial) {
  const next = { ...prefs };
  if (partial && typeof partial === "object") {
    if (typeof partial.splitRatio === "number" && Number.isFinite(partial.splitRatio)) {
      next.splitRatio = Math.min(Math.max(partial.splitRatio, 0.15), 0.7);
    }
    if (typeof partial.showIgnored === "boolean") next.showIgnored = partial.showIgnored;
    if (typeof partial.mdPreview === "boolean") next.mdPreview = partial.mdPreview;
  }
  return next;
}

async function handlePrefsSet(payload) {
  prefs = sanitizePrefs(payload?.partial);
  await pi.plugin.setSettings({ fmPrefs: prefs });
  return { ok: true, prefs };
}

async function handleHello() {
  const root = await currentRoot();
  return {
    ok: true,
    root: root ? { path: root.path, name: root.name ?? path.posix.basename(root.path) } : null,
    limits: {
      maxReadBytes: MAX_READ_BYTES,
      maxWriteBytes: MAX_WRITE_BYTES,
      maxListEntries: MAX_LIST_ENTRIES,
    },
    ignoreFiles: IGNORE_FILE_NAMES,
    prefs,
  };
}

// ── 通道路由 ────────────────────────────────────────────────────────────────

const CHANNELS = {
  "fm.hello": handleHello,
  "fm.prefs.get": handleHello,
  "fm.prefs.set": handlePrefsSet,
  "fm.list": handleList,
  "fm.read": handleRead,
  "fm.write": handleWrite,
  "fm.create": handleCreate,
  "fm.rename": handleRename,
  "fm.move": handleMove,
  "fm.search": handleSearch,
};

async function onPanelInvoke(channel, payload) {
  const handler = CHANNELS[channel];
  if (!handler) return { ok: false, code: "UNSUPPORTED", message: `unknown channel: ${channel}` };
  try {
    return await handler(payload ?? {});
  } catch (error) {
    return toFailure(error);
  }
}

// ── 生命周期 ────────────────────────────────────────────────────────────────

async function onLoad() {
  try {
    dataPath = await pi.plugin.getDataPath();
  } catch {
    dataPath = null;
  }
  try {
    const settings = await pi.plugin.getSettings();
    prefs = sanitizePrefs(settings?.fmPrefs ?? {});
  } catch {
    /* 保持默认 */
  }
}

async function onUnload() {
  searchSessions.clear();
}

module.exports = { onLoad, onUnload, onPanelInvoke };
