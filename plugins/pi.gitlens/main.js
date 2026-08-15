"use strict";

/**
 * Git Lens — PI-Desktop plugin entry.
 *
 * Plugin id : pi.gitlens
 * Commands  : gitlens.open / gitlens.openHistory / gitlens.openChanges /
 *             gitlens.openBranches / gitlens.openBlame
 * Agent tools: git_status, git_log, git_show, git_diff, git_blame, git_branch,
 *             git_commit, git_stash, git_open_panel
 * Panel channels: git.state / git.status / git.log / git.show / git.diff /
 *             git.blame / git.branch / git.commit / git.stash
 *
 * Design notes
 * - All git access goes through ./git.js: execFile("git", [...]) with
 *   argument arrays, `-C <repoRoot>`, no shell, no string interpolation.
 * - The repository root is always resolved from pi.workspace.get() via
 *   `git rev-parse --show-toplevel`, so the plugin can never run git against a
 *   directory the user did not open.
 * - Agent tools and the panel share the same handlers; panel requests arrive
 *   through onPanelInvoke and are forwarded to the same functions.
 * - Read-only tools are risk "low"; tools that mutate repository state
 *   (branch / commit / stash) are risk "medium" and go through the normal
 *   Agent permission policy.
 *
 * Permissions
 * - ui.panel: the isolated panel (manifest.ui.panel)
 * - agent.tool.register: register the nine agent tools
 * - agent.prompt.inject: load the git-workflow skill
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

/** Where the AI asked the panel to land; consumed by the panel via git.state. */
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
// agent tools (shared with the panel)
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
  // If the panel is already open it does not reload, so close it first to make
  // the new page take effect. Closing an unopened panel is a no-op.
  await pi.ui.closePanel().catch(() => {});
  await pi.ui.openPanel();
  return { ok: true, view: target, note: `Git Lens panel opened on ${target}` };
}

async function toolOpenPanel(args) {
  const view = String(args?.view || "overview");
  const extra = { path: args?.path, ref: args?.ref };
  return openPanelView(view, extra);
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
  await pi.commands.register({
    id: "gitlens.open",
    title: "Git Lens: Open",
    keywords: ["git", "lens", "gitlens", "版本", "历史", "分支", "提交"],
    run: () => openPanelView("overview"),
  });
  await pi.commands.register({
    id: "gitlens.openHistory",
    title: "Git Lens: Open History",
    keywords: ["git", "history", "log", "提交历史"],
    run: () => openPanelView("history"),
  });
  await pi.commands.register({
    id: "gitlens.openChanges",
    title: "Git Lens: Open Changes",
    keywords: ["git", "diff", "changes", "改动", "差异"],
    run: () => openPanelView("diff"),
  });
  await pi.commands.register({
    id: "gitlens.openBranches",
    title: "Git Lens: Open Branches",
    keywords: ["git", "branch", "分支"],
    run: () => openPanelView("branches"),
  });
  await pi.commands.register({
    id: "gitlens.openBlame",
    title: "Git Lens: Open Blame",
    keywords: ["git", "blame", "逐行"],
    run: () => openPanelView("blame"),
  });
}

async function registerTools() {
  const tools = [
    {
      name: "git_status",
      description:
        "Show the git status of the current project's repository: current branch, upstream, ahead/behind counts, and the working tree grouped into staged, unstaged, untracked and conflict entries (porcelain XY codes, rename pairs included). Read-only.",
      risk: "low",
      schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Optional repository-relative path to limit the status to." },
        },
      },
      execute: (args) => toolStatus(args || {}),
    },
    {
      name: "git_log",
      description:
        "Show recent commit history of the current project's repository. Supports an optional repo-relative path, free-text grep over subjects, an author filter and a result count. Returns sha, short sha, author, dates, subject, body and ref decorations for each commit. Read-only.",
      risk: "low",
      schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Optional repository-relative path to show history for (file or directory)." },
          query: { type: "string", description: "Optional free-text matched against commit subjects (case-insensitive grep)." },
          author: { type: "string", description: "Optional author name/email substring filter (case-insensitive)." },
          count: { type: "integer", minimum: 1, maximum: 100, description: "Maximum number of commits to return (default 20)." },
        },
      },
      execute: (args) => toolLog(args || {}),
    },
    {
      name: "git_show",
      description:
        "Show a single commit of the current project's repository: message, author, dates, changed files with add/delete counts, and optionally the full patch. Use a sha, HEAD or any ref expression as ref. Read-only.",
      risk: "low",
      schema: {
        type: "object",
        properties: {
          ref: { type: "string", description: "Commit to show. Defaults to HEAD." },
          path: { type: "string", description: "Optional repository-relative path to limit the shown files." },
          patch: { type: "boolean", description: "Include the unified diff patch (default false; large patches are truncated)." },
          stat: { type: "boolean", description: "Include per-file add/delete counts (default true)." },
        },
      },
      execute: (args) => toolShow(args || {}),
    },
    {
      name: "git_diff",
      description:
        "Show the diff of the current project's repository: between a base ref and the working tree (default), or between two refs. Returns changed files with add/delete counts and optionally the unified patch. Read-only.",
      risk: "low",
      schema: {
        type: "object",
        properties: {
          base: { type: "string", description: "Base ref for the diff. Defaults to HEAD." },
          target: { type: "string", description: "Optional second ref. When omitted the working tree is compared against base." },
          path: { type: "string", description: "Optional repository-relative path to limit the diff to." },
          patch: { type: "boolean", description: "Include the unified diff patch (default false; large patches are truncated)." },
          stat: { type: "boolean", description: "Include per-file add/delete counts (default true)." },
        },
      },
      execute: (args) => toolDiff(args || {}),
    },
    {
      name: "git_blame",
      description:
        "Blame a file in the current project's repository (GitLens-style line attribution): for every line, the originating commit sha, author, author time and commit subject. Path is required; an optional line range limits the output. Read-only.",
      risk: "low",
      schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repository-relative path of the file to blame." },
          startLine: { type: "integer", minimum: 1, description: "Optional first line of the blame range (1-based, inclusive)." },
          endLine: { type: "integer", minimum: 1, description: "Optional last line of the blame range (1-based, inclusive)." },
          limit: { type: "integer", minimum: 1, maximum: 5000, description: "Maximum number of blamed lines to return (default 2000; set higher for large files)." },
        },
        required: ["path"],
      },
      execute: (args) => toolBlame(args || {}),
    },
    {
      name: "git_branch",
      description:
        "Manage local branches of the current project's repository. Actions: list (default, includes current branch, upstream and last commit), create (new branch from an optional start point), switch (checkout an existing local branch), delete (safe delete; fails on unmerged branches unless force is set).",
      risk: "medium",
      schema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "create", "switch", "delete"], description: "Branch operation to perform (default list)." },
          name: { type: "string", description: "Branch name for create/switch/delete. Must be a safe git ref name." },
          startPoint: { type: "string", description: "Optional ref the new branch starts from (create only)." },
          force: { type: "boolean", description: "For delete: force delete even if unmerged. For create: reset an existing branch to the start point." },
        },
      },
      execute: (args) => toolBranch(args || {}),
    },
    {
      name: "git_commit",
      description:
        "Stage changes and create a commit in the current project's repository. stage can be 'all' (git add -A), 'tracked' (git add -u) or an array of repo-relative paths. Respects repository hooks and never skips verification. Returns the new commit sha and subject.",
      risk: "medium",
      schema: {
        type: "object",
        properties: {
          message: { type: "string", description: "Commit message (required)." },
          stage: {
            oneOf: [
              { type: "string", enum: ["all", "tracked"] },
              { type: "array", items: { type: "string" }, description: "Repository-relative paths to stage." },
            ],
            description: "What to stage before committing (default 'all').",
          },
          amend: { type: "boolean", description: "Amend the last commit instead of creating a new one (default false)." },
        },
        required: ["message"],
      },
      execute: (args) => toolCommit(args || {}),
    },
    {
      name: "git_stash",
      description:
        "Manage the stash of the current project's repository. Actions: list (default), push (stash the working tree with an optional message; includeUntracked adds -u), pop (restore the newest stash or the one at index), drop (delete the newest stash or the one at index).",
      risk: "medium",
      schema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "push", "pop", "drop"], description: "Stash operation to perform (default list)." },
          message: { type: "string", description: "Optional stash message (push only)." },
          includeUntracked: { type: "boolean", description: "Include untracked files when pushing (default false)." },
          index: { type: "integer", minimum: 0, description: "Zero-based stash index for pop/drop (default 0)." },
        },
      },
      execute: (args) => toolStash(args || {}),
    },
    {
      name: "git_open_panel",
      description:
        "Open the Git Lens panel in PI-Desktop on a specific page (overview, history, diff, branches or blame). Use this when the user asks to see git information in a visual page, wants a dashboard of the repository, or asks to 'open' git history/changes/branches/blame. Optionally preselect a path (blame/diff/history) or a ref.",
      risk: "low",
      schema: {
        type: "object",
        properties: {
          view: { type: "string", enum: VIEWS, description: "Panel page to open (default overview)." },
          path: { type: "string", description: "Optional repository-relative path to preselect on the page." },
          ref: { type: "string", description: "Optional ref to focus (e.g. a commit sha) where the page supports it." },
        },
      },
      execute: (args) => toolOpenPanel(args || {}),
    },
  ];

  for (const tool of tools) {
    await pi.agent.registerTool({
      name: tool.name,
      description: tool.description,
      risk: tool.risk,
      schema: tool.schema,
      execute: tool.execute,
    });
  }
}

async function onLoad() {
  await registerCommands();
  await registerTools();
}

async function onUnload() {
  const commands = [
    "gitlens.open",
    "gitlens.openHistory",
    "gitlens.openChanges",
    "gitlens.openBranches",
    "gitlens.openBlame",
  ];
  const tools = [
    "git_status",
    "git_log",
    "git_show",
    "git_diff",
    "git_blame",
    "git_branch",
    "git_commit",
    "git_stash",
    "git_open_panel",
  ];
  await Promise.all([
    ...commands.map((id) => pi.commands.unregister(id).catch(() => {})),
    ...tools.map((name) => pi.agent.unregisterTool(name).catch(() => {})),
  ]);
}

module.exports = { onLoad, onUnload, onPanelInvoke };
