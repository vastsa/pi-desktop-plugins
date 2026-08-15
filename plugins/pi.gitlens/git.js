"use strict";

/**
 * Git Lens — git runner and parsers.
 *
 * Every git operation is executed with execFile("git", [...]) and an argument
 * array: no shell, no string interpolation, so user input can never become a
 * shell command. Commands always run with `-C <repoRoot>` against the
 * repository root resolved from the current workspace, and GIT_TERMINAL_PROMPT
 * is disabled so git never blocks waiting for credentials.
 *
 * All parsers are pure functions over git output so tests can feed them
 * fixtures without a real repository.
 */

const { execFile } = require("node:child_process");
const path = require("node:path");

const GIT = "git";
const MAX_BUFFER = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;

/** One record per commit; fields are unit-separated, records are group-separated. */
const LOG_FORMAT = [
  "%H", "%h", "%an", "%ae", "%aI", "%cI", "%D", "%s", "%b",
].join("%x1f") + "%x1e";

function runGit(repoRoot, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      GIT,
      ["-C", repoRoot, ...args],
      {
        maxBuffer: options.maxBuffer || MAX_BUFFER,
        timeout: options.timeoutMs || DEFAULT_TIMEOUT_MS,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_PAGER: "cat",
          GIT_OPTIONAL_LOCKS: "0",
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          const message = String(stderr || "").trim() || error.message || "git failed";
          const gitError = new Error(message);
          gitError.name = "GitError";
          gitError.code = "GIT_FAILED";
          gitError.exitCode = typeof error.code === "number" ? error.code : null;
          gitError.stderr = String(stderr || "");
          reject(gitError);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/** Resolve the repository root for a candidate directory, or null when it is not a repo. */
async function resolveRepoRoot(candidate) {
  const output = await runGit(candidate, ["rev-parse", "--show-toplevel"], {
    timeoutMs: 8000,
  }).catch((error) => {
    if (/not a git repository/i.test(error.message || "")) return null;
    throw error;
  });
  return output ? String(output).trim() || null : null;
}

/** A repository-relative path the plugin is willing to touch (no absolute, no escapes). */
function isSafeRelativePath(rel) {
  if (typeof rel !== "string" || rel.length === 0) return false;
  if (path.isAbsolute(rel)) return false;
  const normalized = path.normalize(rel);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) return false;
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) return false;
  return true;
}

/** A ref expression safe to pass as a git argument (no option injection, no whitespace). */
function isSafeRef(ref) {
  if (typeof ref !== "string" || ref.length === 0) return false;
  if (ref.startsWith("-")) return false;
  if (/\s/.test(ref)) return false;
  // Refs the plugin accepts: HEAD, shas, branch/tag names, refs/heads/..., ~ and ^
  // ancestry, plus the @ that makes @{upstream} work. Everything else is refused.
  return /^[A-Za-z0-9._^~:@/\\-]+$/.test(ref);
}

/** A branch name safe for create/switch/delete (first char alphanumeric). */
function isSafeBranchName(name) {
  if (typeof name !== "string" || name.length === 0) return false;
  if (name === "HEAD") return false;
  if (name.includes("..") || name.includes("@{")) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name);
}

function parseStatusPorcelain(output) {
  const result = {
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    gone: false,
    entries: [],
    staged: [],
    unstaged: [],
    untracked: [],
    conflicts: [],
  };
  const lines = String(output || "").split("\n");
  for (const line of lines) {
    if (line.length === 0) continue;
    if (line.startsWith("## ")) {
      const header = line.slice(3);
      const bracket = header.indexOf(" [");
      const branchPart = bracket === -1 ? header : header.slice(0, bracket);
      const tail = bracket === -1 ? "" : header.slice(bracket + 2, header.length - 1);
      const [local, upstream] = branchPart.split("...");
      result.branch = local || null;
      result.upstream = upstream || null;
      if (/gone/i.test(tail)) result.gone = true;
      const aheadMatch = tail.match(/ahead (\d+)/);
      const behindMatch = tail.match(/behind (\d+)/);
      if (aheadMatch) result.ahead = Number(aheadMatch[1]);
      if (behindMatch) result.behind = Number(behindMatch[1]);
      continue;
    }
    if (line.length < 3) continue;
    const x = line[0];
    const y = line[1];
    let pathPart = line.slice(3);
    let origPath = null;
    const arrow = pathPart.indexOf(" -> ");
    if (arrow !== -1) {
      origPath = pathPart.slice(0, arrow);
      pathPart = pathPart.slice(arrow + 4);
    }
    const entry = { x, y, path: pathPart, origPath };
    result.entries.push(entry);
    const code = x + y;
    const isConflict = /^(DD|AU|UD|UA|DU|AA|UU)$/.test(code) || x === "U" || y === "U";
    if (isConflict) result.conflicts.push(entry);
    else if (y === "?") result.untracked.push(entry);
    else if (x !== " " && x !== "?") result.staged.push(entry);
    else if (y !== " ") result.unstaged.push(entry);
  }
  return result;
}

function parseLogRecords(output) {
  const records = [];
  const parts = String(output || "").split("\x1e");
  for (const part of parts) {
    if (!part) continue;
    const fields = part.replace(/^\r?\n/, "").split("\x1f");
    if (fields.length < 9) continue;
    records.push({
      sha: fields[0],
      shortSha: fields[1],
      author: fields[2],
      authorEmail: fields[3],
      authorDate: fields[4],
      committerDate: fields[5],
      refs: fields[6] || null,
      subject: fields[7],
      body: String(fields[8] || "").trim(),
    });
  }
  return records;
}

function parseNameStatus(output) {
  const files = [];
  const lines = String(output || "").split("\n");
  for (const line of lines) {
    if (!line) continue;
    const fields = line.split("\t");
    if (fields.length < 2) continue;
    const statusField = fields[0];
    const status = statusField[0] || "?";
    const score = Number.parseInt(statusField.slice(1), 10);
    files.push({
      status,
      score: Number.isFinite(score) ? score : null,
      path: fields[fields.length - 1],
      origPath: fields.length > 2 ? fields[1] : null,
    });
  }
  return files;
}

function parseNumstat(output) {
  const files = [];
  const lines = String(output || "").split("\n");
  for (const line of lines) {
    if (!line) continue;
    const [added, deleted, ...rest] = line.split("\t");
    const filePath = rest.join("\t");
    if (!filePath) continue;
    files.push({
      path: filePath,
      additions: added === "-" ? null : Number(added),
      deletions: deleted === "-" ? null : Number(deleted),
      binary: added === "-" || deleted === "-",
    });
  }
  return files;
}

function parseBlameLinePorcelain(output) {
  const lines = String(output || "").split("\n");
  const records = [];
  let current = null;
  for (const line of lines) {
    if (!line) continue;
    if (/^[0-9a-f]{40} \d+ \d+/.test(line)) {
      if (current) records.push(current);
      const parts = line.split(" ");
      current = {
        sha: parts[0],
        origLine: Number(parts[1]),
        finalLine: Number(parts[2]),
        author: "",
        authorMail: "",
        authorTime: null,
        authorTz: "",
        summary: "",
        content: "",
      };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("\t")) {
      current.content = line.slice(1);
      continue;
    }
    const separator = line.indexOf(" ");
    if (separator === -1) continue;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1).trim();
    switch (key) {
      case "author":
        current.author = value;
        break;
      case "author-mail":
        current.authorMail = value.replace(/^<|>$/g, "");
        break;
      case "author-time": {
        const parsed = Number(value);
        current.authorTime = Number.isFinite(parsed) ? parsed : null;
        break;
      }
      case "author-tz":
        current.authorTz = value;
        break;
      case "summary":
        current.summary = value;
        break;
      case "filename":
        current.filename = value;
        break;
      default:
        break;
    }
  }
  if (current) records.push(current);
  return records;
}

function parseBranchList(output) {
  // `git for-each-ref` (and `git branch --format`) understands %00 as the NUL
  // field separator but not %x1f/%x1e, and emits one newline-terminated record
  // per ref, so records split on "\n" and fields on "\x00".
  const branches = [];
  const lines = String(output || "").split("\n");
  for (const line of lines) {
    if (!line) continue;
    const fields = line.split("\x00");
    const name = String(fields[0] || "").trim();
    if (!name) continue;
    branches.push({
      name,
      upstream: fields[1] || null,
      committerDate: fields[2] || null,
      subject: fields[3] || "",
    });
  }
  return branches;
}

function parseStashList(output) {
  const stashes = [];
  const parts = String(output || "").split("\x1e");
  for (const part of parts) {
    if (!part) continue;
    const fields = part.replace(/^\r?\n/, "").split("\x1f");
    const ref = String(fields[0] || "").trim();
    if (!ref) continue;
    stashes.push({ ref, message: fields[1] || "" });
  }
  return stashes;
}

module.exports = {
  LOG_FORMAT,
  runGit,
  resolveRepoRoot,
  isSafeRelativePath,
  isSafeRef,
  isSafeBranchName,
  parseStatusPorcelain,
  parseLogRecords,
  parseNameStatus,
  parseNumstat,
  parseBlameLinePorcelain,
  parseBranchList,
  parseStashList,
};
