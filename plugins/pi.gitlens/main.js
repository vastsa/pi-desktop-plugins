"use strict";

/**
 * Git Lens — PI-Desktop plugin entry.
 *
 * Plugin id : pi.gitlens
 * Commands  : gitlens.open / gitlens.openHistory / gitlens.openChanges /
 *             gitlens.openBranches / gitlens.openBlame
 * Panel channels: git.state / git.status / git.log / git.show / git.diff /
 *             git.blame / git.branch / git.commit / git.stash
 *
 * Design notes
 * - All git access goes through ./git.js: execFile("git", [...]) with
 *   argument arrays, `-C <repoRoot>`, no shell, no string interpolation.
 * - The repository root is always resolved from pi.workspace.get() via
 *   `git rev-parse --show-toplevel`, so the plugin can never run git against a
 *   directory the user did not open.
 * - Handlers are for the work-panel view only. Nothing is registered as an
 *   agent tool; the AI does not get git_status / git_commit / etc.
 *
 * Permissions
 * - ui.view: the work-panel view (contributes.views, no detached window)
 */

const {
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
} = require("./git");

const VIEWS = ["overview", "history", "diff", "branches", "blame"];
const MAX_TOOL_PATCH_CHARS = 120_000;
const MAX_TOOL_ENTRIES = 1_000;
const MAX_BLAME_LINES = 2_000;

const VIEW_LABELS = {
  en: {
    overview: "Overview",
    history: "History",
    diff: "Changes",
    branches: "Branches",
    blame: "Blame",
  },
  "zh-CN": {
    overview: "概览",
    history: "历史",
    diff: "改动",
    branches: "分支",
    blame: "追溯",
  },
};

function isZhLocale(locale) {
  return String(locale || "").toLowerCase().startsWith("zh");
}

async function hostLocale() {
  try {
    if (typeof pi.app?.getLocale === "function") {
      return await pi.app.getLocale();
    }
  } catch {
    /* older hosts */
  }
  return "en";
}

function viewLabel(view, locale) {
  const table = isZhLocale(locale) ? VIEW_LABELS["zh-CN"] : VIEW_LABELS.en;
  return table[view] || view;
}

/** Where a command asked the panel to land; consumed by the panel via git.state. */
let panelState = null;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function truncateText(text, limit = MAX_TOOL_PATCH_CHARS) {
  const value = String(text || "");
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n… [truncated ${value.length - limit} characters]`;
}

function truncateEntries(list, limit = MAX_TOOL_ENTRIES) {
  if (list.length <= limit) return { entries: list, truncated: false };
  return { entries: list.slice(0, limit), truncated: true };
}

function requireRepoPath(value) {
  const rel = String(value ?? "");
  if (!rel || !isSafeRelativePath(rel)) {
    throw fail(
      "INVALID_ARGUMENT",
      "path must be a non-empty repository-relative path (no absolute paths, no '..' escapes)",
    );
  }
  return rel;
}

function requireRef(value, label = "ref") {
  const ref = String(value ?? "");
  if (!isSafeRef(ref)) {
    throw fail(
      "INVALID_ARGUMENT",
      `${label} must be a safe ref expression (e.g. HEAD, a sha, a branch name); got "${ref}"`,
    );
  }
  return ref;
}

function requireBranchName(value) {
  const name = String(value ?? "");
  if (!isSafeBranchName(name)) {
    throw fail(
      "INVALID_ARGUMENT",
      `branch name must be a safe git ref name (alphanumeric start, only [A-Za-z0-9._/-]); got "${name}"`,
    );
  }
  return name;
}

async function getRepoContext() {
  const workspace = await pi.workspace.get();
  if (!workspace || !workspace.path) {
    throw fail(
      "NOT_FOUND",
      "No project is open. Open a project folder first, then retry.",
    );
  }
  let root;
  try {
    root = await resolveRepoRoot(workspace.path);
  } catch (error) {
    throw fail("INTERNAL", `Failed to inspect git repository at ${workspace.path}: ${error.message}`);
  }
  if (!root) {
    throw fail("NOT_FOUND", `Not a git repository: ${workspace.path}`);
  }
  return { workspace, root };
}

function mergeCounts(nameStatus, numstat) {
  const byPath = new Map();
  for (const file of numstat) byPath.set(file.path, file);
  return nameStatus.map((file) => {
    const counts = byPath.get(file.path);
    return {
      ...file,
      additions: counts ? counts.additions : null,
      deletions: counts ? counts.deletions : null,
      binary: counts ? counts.binary : false,
    };
  });
}

async function stashListFor(root) {
  return parseStashList(
    await runGit(root, ["stash", "list", "--format=%gd%x1f%gs%x1e"]),
  );
}

// ---------------------------------------------------------------------------
// panel git handlers
// ---------------------------------------------------------------------------

async function toolStatus(args) {
  const { root, workspace } = await getRepoContext();
  const gitArgs = ["status", "--porcelain=v1", "-b", "--untracked-files=all"];
  const rel = args?.path ? requireRepoPath(args.path) : null;
  if (rel) gitArgs.push("--", rel);
  const status = parseStatusPorcelain(await runGit(root, gitArgs));
  return {
    ok: true,
    repo: root,
    workspace: workspace.path,
    branch: status.branch,
    upstream: status.upstream,
    ahead: status.ahead,
    behind: status.behind,
    gone: status.gone,
    staged: truncateEntries(status.staged).entries,
    unstaged: truncateEntries(status.unstaged).entries,
    untracked: truncateEntries(status.untracked).entries,
    conflicts: status.conflicts,
    truncated: status.staged.length + status.unstaged.length + status.untracked.length > MAX_TOOL_ENTRIES,
  };
}

async function toolLog(args) {
  const { root } = await getRepoContext();
  const count = clampInt(args?.count, 1, 100, 20);
  const gitArgs = ["log", "--no-color", "-n", String(count)];
  if (args?.query) gitArgs.push("--grep", String(args.query), "-i");
  if (args?.author) gitArgs.push("--author", String(args.author), "-i");
  gitArgs.push(`--format=${LOG_FORMAT}`);
  const rel = args?.path ? requireRepoPath(args.path) : null;
  if (rel) gitArgs.push("--", rel);
  const records = parseLogRecords(await runGit(root, gitArgs));
  return { ok: true, repo: root, count: records.length, requested: count, commits: records };
}

async function toolShow(args) {
  const { root } = await getRepoContext();
  const ref = args?.ref ? requireRef(args.ref, "ref") : "HEAD";
  const wantPatch = args?.patch === true;
  const wantStat = args?.stat !== false;
  const rel = args?.path ? requireRepoPath(args.path) : null;

  const metaArgs = ["show", "--no-color", "--no-patch", `--format=${LOG_FORMAT}`, ref];
  const meta = parseLogRecords(await runGit(root, metaArgs))[0] || null;

  const nameArgs = ["show", "--no-color", "--format=", "--name-status", ref];
  if (rel) nameArgs.push("--", rel);
  const nameStatus = parseNameStatus(await runGit(root, nameArgs));

  let files = nameStatus;
  if (wantStat) {
    const numArgs = ["show", "--no-color", "--format=", "--numstat", ref];
    if (rel) numArgs.push("--", rel);
    files = mergeCounts(nameStatus, parseNumstat(await runGit(root, numArgs)));
  }

  let patch = null;
  if (wantPatch) {
    const patchArgs = ["show", "--no-color", "--format=", "--unified=3", ref];
    if (rel) patchArgs.push("--", rel);
    patch = truncateText(await runGit(root, patchArgs));
  }

  return {
    ok: true,
    repo: root,
    ref,
    commit: meta,
    files,
    patch,
  };
}

async function toolDiff(args) {
  const { root } = await getRepoContext();
  const base = args?.base ? requireRef(args.base, "base") : "HEAD";
  const target = args?.target !== undefined && String(args.target) !== ""
    ? requireRef(args.target, "target")
    : null;
  const wantPatch = args?.patch === true;
  const wantStat = args?.stat !== false;
  const rel = args?.path ? requireRepoPath(args.path) : null;
  const range = target ? [base, target] : [base];

  const nameArgs = ["diff", "--no-color", "--name-status", ...range];
  const numArgs = ["diff", "--no-color", "--numstat", ...range];
  if (rel) {
    nameArgs.push("--", rel);
    numArgs.push("--", rel);
  }
  const nameStatus = parseNameStatus(await runGit(root, nameArgs));
  const files = wantStat
    ? mergeCounts(nameStatus, parseNumstat(await runGit(root, numArgs)))
    : nameStatus;

  let patch = null;
  if (wantPatch) {
    const patchArgs = ["diff", "--no-color", "--unified=3", ...range];
    if (rel) patchArgs.push("--", rel);
    patch = truncateText(await runGit(root, patchArgs));
  }

  return {
    ok: true,
    repo: root,
    base,
    target,
    files,
    patch,
  };
}

async function toolBlame(args) {
  const { root } = await getRepoContext();
  const rel = requireRepoPath(args?.path);
  const startLine = clampInt(args?.startLine, 1, 1_000_000_000, 0);
  const endLine = clampInt(args?.endLine, 1, 1_000_000_000, 0);
  const limit = clampInt(args?.limit, 1, 5000, MAX_BLAME_LINES);

  const blameArgs = ["blame", "--line-porcelain"];
  if (startLine > 0) {
    blameArgs.push("-L", endLine > startLine ? `${startLine},${endLine}` : `${startLine},`);
  }
  blameArgs.push("--", rel);
  const records = parseBlameLinePorcelain(await runGit(root, blameArgs));
  const limited = records.slice(0, limit);
  return {
    ok: true,
    repo: root,
    path: rel,
    startLine: startLine > 0 ? startLine : 1,
    endLine: endLine > 0 ? endLine : records.length,
    lines: limited,
    totalLines: records.length,
    truncated: records.length > limit,
  };
}

async function toolBranch(args) {
  const { root } = await getRepoContext();
  const action = String(args?.action || "list");

  async function branchList() {
    const currentRaw = await runGit(root, ["symbolic-ref", "--short", "HEAD"]).catch(() => "");
    const list = parseBranchList(
      await runGit(root, [
        "for-each-ref",
        "refs/heads",
        "--format=%(refname:short)%00%(upstream:short)%00%(committerdate:iso8601)%00%(subject)",
      ]),
    );
    return { branches: list, current: currentRaw.trim() || null };
  }

  switch (action) {
    case "list": {
      const { branches, current } = await branchList();
      return { ok: true, repo: root, action, current, count: branches.length, branches };
    }
    case "create": {
      const name = requireBranchName(args?.name);
      const startPoint = args?.startPoint ? requireRef(args.startPoint, "startPoint") : null;
      const gitArgs = ["branch"];
      if (args?.force === true) gitArgs.push("--force");
      gitArgs.push(name);
      if (startPoint) gitArgs.push(startPoint);
      await runGit(root, gitArgs);
      const { branches } = await branchList();
      return { ok: true, repo: root, action, branch: name, message: `Created branch ${name}`, branches };
    }
    case "switch": {
      const name = requireBranchName(args?.name);
      await runGit(root, ["switch", name]);
      const { branches, current } = await branchList();
      return { ok: true, repo: root, action, branch: name, current, message: `Switched to branch ${name}`, branches };
    }
    case "delete": {
      const name = requireBranchName(args?.name);
      const gitArgs = ["branch", args?.force === true ? "-D" : "-d", name];
      await runGit(root, gitArgs);
      const { branches } = await branchList();
      return { ok: true, repo: root, action, branch: name, message: `Deleted branch ${name}`, branches };
    }
    default:
      throw fail("INVALID_ARGUMENT", `unknown git_branch action: ${action}`);
  }
}

async function toolCommit(args) {
  const { root } = await getRepoContext();
  const message = String(args?.message ?? "").trim();
  if (!message) throw fail("INVALID_ARGUMENT", "message is required for git_commit");
  if (message.length > 5000) throw fail("INVALID_ARGUMENT", "message is too long (max 5000 characters)");
  const amend = args?.amend === true;
  const stage = args?.stage;

  if (stage === "all" || stage === undefined) {
    await runGit(root, ["add", "-A"]);
  } else if (stage === "tracked") {
    await runGit(root, ["add", "-u"]);
  } else if (Array.isArray(stage)) {
    if (stage.length === 0) throw fail("INVALID_ARGUMENT", "stage array must not be empty");
    const paths = stage.map((item) => requireRepoPath(item));
    await runGit(root, ["add", "--", ...paths]);
  } else {
    throw fail("INVALID_ARGUMENT", 'stage must be "all", "tracked" or an array of paths');
  }

  const commitArgs = ["commit"];
  if (amend) commitArgs.push("--amend");
  commitArgs.push("-m", message);
  await runGit(root, commitArgs);

  const shortSha = String(await runGit(root, ["rev-parse", "--short", "HEAD"])).trim();
  const subject = String(await runGit(root, ["log", "-1", "--format=%s"])).trim();
  return {
    ok: true,
    repo: root,
    sha: shortSha,
    subject,
    amended: amend,
    message,
    status: await toolStatus({}),
  };
}

async function toolStash(args) {
  const { root } = await getRepoContext();
  const action = String(args?.action || "list");
  const index = clampInt(args?.index, 0, 10_000, 0);
  const stashRef = `stash@{${index}}`;

  switch (action) {
    case "list": {
      const stashes = await stashListFor(root);
      return { ok: true, repo: root, action, count: stashes.length, stashes };
    }
    case "push": {
      const before = (await stashListFor(root)).length;
      const pushArgs = ["stash", "push"];
      if (args?.includeUntracked === true) pushArgs.push("--include-untracked");
      const message = String(args?.message ?? "").trim();
      if (message) pushArgs.push("-m", message);
      await runGit(root, pushArgs);
      const stashes = await stashListFor(root);
      const created = stashes.length > before;
      return {
        ok: true,
        repo: root,
        action,
        created,
        message: created ? message || "Changes stashed" : "No local changes to stash (working tree is clean)",
        stashes,
      };
    }
    case "pop":
    case "drop": {
      await runGit(root, ["stash", action, stashRef]);
      const stashes = await stashListFor(root);
      return { ok: true, repo: root, action, index, stashRef, message: `${action} ${stashRef}`, stashes };
    }
    default:
      throw fail("INVALID_ARGUMENT", `unknown git_stash action: ${action}`);
  }
}

async function openPanelView(view, extra = {}) {
  const target = VIEWS.includes(view) ? view : "overview";
  panelState = {
    view: target,
    path: extra.path && isSafeRelativePath(extra.path) ? String(extra.path) : null,
    ref: extra.ref && isSafeRef(extra.ref) ? String(extra.ref) : null,
    openedAt: Date.now(),
  };
  // Git Lens only docks in the work panel (no detached window). The live view
  // polls git.state and switches pages when openedAt changes. There is no
  // plugin API to reveal a work-panel tab, so point the user at the switcher
  // when the view is not already on screen.
  const locale = await hostLocale();
  const zh = isZhLocale(locale);
  const page = viewLabel(target, locale);
  const toast = zh
    ? `Git Lens 只在右侧工作面板中打开。按 Mod+J，再选择 Git Lens（${page}）。`
    : `Git Lens lives in the work panel. Press Mod+J, then choose Git Lens (${page}).`;
  await pi.ui.showToast(toast, "info").catch(() => {});
  return {
    ok: true,
    view: target,
    note: zh
      ? `已请求在工作面板中打开 Git Lens 的「${page}」页。若未看到，请打开右侧工作面板（Mod+J）并选择 Git Lens。`
      : `Git Lens requested ${page} in the work panel. If it is not visible, open the right work panel (Mod+J) and choose Git Lens.`,
  };
}

// ---------------------------------------------------------------------------
// panel bridge (onPanelInvoke)
// ---------------------------------------------------------------------------

async function onPanelInvoke(channel, payload) {
  const args = payload || {};
  switch (channel) {
    case "git.state": {
      const context = await getRepoContext().catch(() => null);
      return {
        ok: true,
        state: panelState,
        workspace: context ? { path: context.workspace.path, name: context.workspace.name } : null,
        repoRoot: context ? context.root : null,
      };
    }
    case "git.status":
      return toolStatus(args);
    case "git.log":
      return toolLog(args);
    case "git.show":
      return toolShow(args);
    case "git.diff":
      return toolDiff(args);
    case "git.blame":
      return toolBlame(args);
    case "git.branch":
      return toolBranch(args);
    case "git.commit":
      return toolCommit(args);
    case "git.stash":
      return toolStash(args);
    default:
      throw new Error(`unsupported panel channel: ${channel}`);
  }
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

async function registerCommands() {
  const zh = isZhLocale(await hostLocale());
  const title = (en, cn) => (zh ? cn : en);
  await pi.commands.register({
    id: "gitlens.open",
    title: title("Git Lens: Open", "Git Lens：打开"),
    keywords: ["git", "lens", "gitlens", "版本", "历史", "分支", "提交"],
    run: () => openPanelView("overview"),
  });
  await pi.commands.register({
    id: "gitlens.openHistory",
    title: title("Git Lens: Open History", "Git Lens：打开历史"),
    keywords: ["git", "history", "log", "提交历史"],
    run: () => openPanelView("history"),
  });
  await pi.commands.register({
    id: "gitlens.openChanges",
    title: title("Git Lens: Open Changes", "Git Lens：打开改动"),
    keywords: ["git", "diff", "changes", "改动", "差异"],
    run: () => openPanelView("diff"),
  });
  await pi.commands.register({
    id: "gitlens.openBranches",
    title: title("Git Lens: Open Branches", "Git Lens：打开分支"),
    keywords: ["git", "branch", "分支"],
    run: () => openPanelView("branches"),
  });
  await pi.commands.register({
    id: "gitlens.openBlame",
    title: title("Git Lens: Open Blame", "Git Lens：打开追溯"),
    keywords: ["git", "blame", "逐行"],
    run: () => openPanelView("blame"),
  });
}

async function onLoad() {
  await registerCommands();
}

async function onUnload() {
  const commands = [
    "gitlens.open",
    "gitlens.openHistory",
    "gitlens.openChanges",
    "gitlens.openBranches",
    "gitlens.openBlame",
  ];
  await Promise.all(commands.map((id) => pi.commands.unregister(id).catch(() => {})));
}

module.exports = { onLoad, onUnload, onPanelInvoke };
