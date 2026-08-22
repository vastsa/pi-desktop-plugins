import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const git = require("../plugins/pi.gitlens/git.js");
const main = require("../plugins/pi.gitlens/main.js");
const manifest = JSON.parse(
  require("node:fs").readFileSync(join(here, "../plugins/pi.gitlens/manifest.json"), "utf8"),
);
const mainSource = require("node:fs").readFileSync(
  join(here, "../plugins/pi.gitlens/main.js"),
  "utf8",
);
const gitSource = require("node:fs").readFileSync(
  join(here, "../plugins/pi.gitlens/git.js"),
  "utf8",
);
const panelSource = require("node:fs").readFileSync(
  join(here, "../plugins/pi.gitlens/renderer/panel.js"),
  "utf8",
);
const panelHtml = require("node:fs").readFileSync(
  join(here, "../plugins/pi.gitlens/renderer/index.html"),
  "utf8",
);
const panelPolishSource = require("node:fs").readFileSync(
  join(here, "../plugins/pi.gitlens/renderer/panel-polish.css"),
  "utf8",
);
const capsuleRetintSource = require("node:fs").readFileSync(
  join(here, "../plugins/pi.gitlens/renderer/capsule-retint.js"),
  "utf8",
);

let hasGit = true;
try {
  execFileSync("git", ["--version"], { stdio: "ignore" });
} catch {
  hasGit = false;
}

function createTempRepo() {
  const root = mkdtempSync(join(tmpdir(), "pi-gitlens-"));
  const run = (args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
  run(["init", "-b", "main"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test Runner"]);
  return {
    root,
    run,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("manifest declares the expected identity, permissions and contributions", () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.id, "pi.gitlens");
  assert.equal(manifest.version, "0.1.4");
  assert.match(manifest.engines.piDesktop, /^>=/);
  assert.deepEqual(manifest.permissions, ["ui.panel", "agent.tool.register", "agent.prompt.inject"]);
  assert.equal(typeof manifest.ui.title.en, "string");
  assert.equal(typeof manifest.ui.title["zh-CN"], "string");
  assert.ok(manifest.ui.title.en.length > 0 && manifest.ui.title["zh-CN"].length > 0);
  assert.equal(manifest.contributes.commands.length, 5);
  assert.equal(manifest.contributes.agentTools.length, 9);
  assert.deepEqual(manifest.contributes.skills, ["skills/git-workflow.md"]);
  const toolNames = manifest.contributes.agentTools.map((tool) => tool.name);
  assert.deepEqual(toolNames, [
    "git_status",
    "git_log",
    "git_show",
    "git_diff",
    "git_blame",
    "git_branch",
    "git_commit",
    "git_stash",
    "git_open_panel",
  ]);
  const low = manifest.contributes.agentTools.filter((tool) => tool.risk === "low").map((tool) => tool.name);
  const medium = manifest.contributes.agentTools.filter((tool) => tool.risk === "medium").map((tool) => tool.name);
  assert.deepEqual(low, ["git_status", "git_log", "git_show", "git_diff", "git_blame", "git_open_panel"]);
  assert.deepEqual(medium, ["git_branch", "git_commit", "git_stash"]);
  assert.ok(!JSON.stringify(manifest).includes('"fs."'), "no file permissions requested");
  assert.ok(!JSON.stringify(manifest).includes("net.fetch"), "no network permission requested");
});

test("v3 panel chrome keeps the header clear and follows palette changes", () => {
  assert.match(panelHtml, /<meta\s+name="pi-plugin-chrome"\s+content="v3"\s*\/>/);
  assert.match(panelHtml, /<script src="\.\/capsule-retint\.js"><\/script>/);
  assert.match(panelPolishSource, /\.view > \.toolbar:first-child\s*\{\s*padding-right:\s*104px;\s*\}/);
  assert.match(capsuleRetintSource, /--pi-plugin-panel-page-background/);
  assert.match(capsuleRetintSource, /--pi-plugin-panel-page-foreground/);
  assert.match(capsuleRetintSource, /lastBackground/);
  assert.match(capsuleRetintSource, /lastForeground/);
  assert.match(capsuleRetintSource, /attributeFilter: \["data-theme", "data-base", "style"\]/);
});

test("main.js registers every tool and command it declares, and routes panel channels", () => {
  for (const tool of manifest.contributes.agentTools) {
    assert.match(mainSource, new RegExp(`name: "${tool.name}"`), `tool ${tool.name} registered`);
  }
  const unregisterList = mainSource.match(/const tools = \[([\s\S]*?)\];/)?.[1] || "";
  for (const tool of manifest.contributes.agentTools) {
    assert.match(unregisterList, new RegExp(`"${tool.name}"`), `tool ${tool.name} unregistered`);
  }
  for (const command of manifest.contributes.commands) {
    assert.match(mainSource, new RegExp(`id: "${command.id}"`), `command ${command.id} registered`);
  }
  for (const channel of ["git.state", "git.status", "git.log", "git.show", "git.diff", "git.blame", "git.branch", "git.commit", "git.stash"]) {
    assert.match(mainSource, new RegExp(`case "${channel}"`), `panel channel ${channel} handled`);
  }
  assert.match(mainSource, /execFile\("git"/, "runs git through execFile");
  assert.match(gitSource, /GIT_TERMINAL_PROMPT/, "disables terminal prompts");
  assert.match(panelSource, /appearance\.init/, "panel follows app appearance");
  assert.match(panelSource, /textContent/, "panel escapes user content via textContent");
});

test("parseStatusPorcelain groups entries and parses the branch header", () => {
  const output = [
    "## feature/x...origin/feature/x [ahead 2, behind 1]",
    "M  src/a.ts",
    " M src/b.ts",
    "A  src/c.ts",
    "?? notes/",
    "R  old.ts -> new.ts",
    "UU conflicted.ts",
    " D deleted.ts",
  ].join("\n");
  const status = git.parseStatusPorcelain(output);
  assert.equal(status.branch, "feature/x");
  assert.equal(status.upstream, "origin/feature/x");
  assert.equal(status.ahead, 2);
  assert.equal(status.behind, 1);
  assert.deepEqual(status.staged.map((e) => e.path), ["src/a.ts", "src/c.ts", "new.ts"]);
  assert.deepEqual(status.unstaged.map((e) => e.path), ["src/b.ts", "deleted.ts"]);
  assert.deepEqual(status.untracked.map((e) => e.path), ["notes/"]);
  assert.deepEqual(status.conflicts.map((e) => e.path), ["conflicted.ts"]);
  const renamed = status.staged.find((e) => e.path === "new.ts");
  assert.equal(renamed.origPath, "old.ts");
});

test("parseLogRecords splits records and fields", () => {
  const record = [
    "a" .repeat(40), "abcd123", "Ada", "ada@example.com",
    "2026-08-01T10:00:00+08:00", "2026-08-01T10:00:00+08:00",
    "HEAD -> main, origin/main", "Fix the thing", "Long body line",
  ].join("\x1f");
  const records = git.parseLogRecords(record + "\x1e\n");
  assert.equal(records.length, 1);
  assert.equal(records[0].shortSha, "abcd123");
  assert.equal(records[0].author, "Ada");
  assert.equal(records[0].subject, "Fix the thing");
  assert.equal(records[0].body, "Long body line");
  assert.equal(records[0].refs, "HEAD -> main, origin/main");
});

test("parseNameStatus and parseNumstat parse diff listings", () => {
  const names = git.parseNameStatus("M\tsrc/a.ts\nR100\told.ts\tnew.ts\nA\tadded.ts\n");
  assert.deepEqual(names[0], { status: "M", score: null, path: "src/a.ts", origPath: null });
  assert.deepEqual(names[1], { status: "R", score: 100, path: "new.ts", origPath: "old.ts" });
  const counts = git.parseNumstat("3\t1\tsrc/a.ts\n-\t-\tbin.dat\n");
  assert.deepEqual(counts[0], { path: "src/a.ts", additions: 3, deletions: 1, binary: false });
  assert.equal(counts[1].binary, true);
  assert.equal(counts[1].additions, null);
});

test("parseBlameLinePorcelain parses line-porcelain output", () => {
  const sha = "a".repeat(40);
  const output = [
    `${sha} 1 1 3`,
    "author Alice",
    "author-mail <alice@example.com>",
    "author-time 1750000000",
    "author-tz +0800",
    "committer Alice",
    "committer-mail <alice@example.com>",
    "committer-time 1750000000",
    "committer-tz +0800",
    "summary First commit",
    "boundary",
    "filename src/a.ts",
    "\tline one",
    `${sha} 2 2`,
    "author Alice",
    "author-mail <alice@example.com>",
    "author-time 1750000000",
    "author-tz +0800",
    "summary First commit",
    "filename src/a.ts",
    "\tline two",
    "",
  ].join("\n");
  const records = git.parseBlameLinePorcelain(output);
  assert.equal(records.length, 2);
  assert.equal(records[0].sha, sha);
  assert.equal(records[0].finalLine, 1);
  assert.equal(records[0].author, "Alice");
  assert.equal(records[0].authorMail, "alice@example.com");
  assert.equal(records[0].authorTime, 1750000000);
  assert.equal(records[0].summary, "First commit");
  assert.equal(records[0].content, "line one");
  assert.equal(records[1].finalLine, 2);
});

test("parseBranchList and parseStashList parse their formats", () => {
  const branches = git.parseBranchList(
    "main\x00origin/main\x002026-08-01T10:00:00+08:00\x00Fix the thing\n" +
      "dev\x00\x002026-08-02T10:00:00+08:00\x00WIP\n",
  );
  assert.equal(branches.length, 2);
  assert.equal(branches[0].name, "main");
  assert.equal(branches[0].upstream, "origin/main");
  assert.equal(branches[1].upstream, null);
  assert.equal(branches[1].subject, "WIP");

  const stashes = git.parseStashList("stash@{0}\x1fWIP on main: fix stuff\x1e\n");
  assert.equal(stashes.length, 1);
  assert.equal(stashes[0].ref, "stash@{0}");
  assert.equal(stashes[0].message, "WIP on main: fix stuff");
});

test("path, ref and branch validation refuses escapes and option injection", () => {
  assert.equal(git.isSafeRelativePath("src/a.ts"), true);
  assert.equal(git.isSafeRelativePath("a/b/c.ts"), true);
  assert.equal(git.isSafeRelativePath("../etc/passwd"), false);
  assert.equal(git.isSafeRelativePath("/etc/passwd"), false);
  assert.equal(git.isSafeRelativePath(""), false);
  assert.equal(git.isSafeRef("HEAD"), true);
  assert.equal(git.isSafeRef("main"), true);
  assert.equal(git.isSafeRef("HEAD~2"), true);
  assert.equal(git.isSafeRef("--upload-pack=x"), false);
  assert.equal(git.isSafeRef("a b"), false);
  assert.equal(git.isSafeBranchName("feat/x-1"), true);
  assert.equal(git.isSafeBranchName("HEAD"), false);
  assert.equal(git.isSafeBranchName("-rf"), false);
  assert.equal(git.isSafeBranchName("a..b"), false);
});

test("integration: resolve, status, log, diff and blame against a real repo", { skip: !hasGit }, async () => {
  const repo = createTempRepo();
  try {
    repo.run(["config", "commit.gpgsign", "false"]);
    writeFileSync(join(repo.root, "a.txt"), "line one\nline two\nline three\n");
    repo.run(["add", "-A"]);
    repo.run(["commit", "-m", "first commit"]);
    writeFileSync(join(repo.root, "b.txt"), "hello\n");
    repo.run(["add", "b.txt"]);
    repo.run(["commit", "-m", "second commit"]);

    const resolved = await git.resolveRepoRoot(repo.root);
    assert.equal(resolved, realpathSync(repo.root));

    const emptyDir = mkdtempSync(join(tmpdir(), "pi-gitlens-no-repo-"));
    try {
      const notARepo = await git.resolveRepoRoot(emptyDir);
      assert.equal(notARepo, null);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }

    const statusRaw = await git.runGit(repo.root, ["status", "--porcelain=v1", "-b"]);
    const status = git.parseStatusPorcelain(statusRaw);
    assert.equal(status.branch, "main");
    assert.equal(status.staged.length, 0);
    assert.equal(status.unstaged.length, 0);

    writeFileSync(join(repo.root, "a.txt"), "line one\nline two changed\nline three\n");
    const dirty = git.parseStatusPorcelain(
      await git.runGit(repo.root, ["status", "--porcelain=v1", "-b"]),
    );
    assert.equal(dirty.unstaged.length, 1);
    assert.equal(dirty.unstaged[0].path, "a.txt");

    const log = git.parseLogRecords(
      await git.runGit(repo.root, ["log", "--no-color", "-n", "10", `--format=${git.LOG_FORMAT}`]),
    );
    assert.equal(log.length, 2);
    assert.equal(log[0].subject, "second commit");
    assert.equal(log[1].subject, "first commit");
    assert.match(log[0].sha, /^[0-9a-f]{40}$/);
    assert.match(log[1].sha, /^[0-9a-f]{40}$/);

    const blame = git.parseBlameLinePorcelain(
      await git.runGit(repo.root, ["blame", "--line-porcelain", "--", "a.txt"]),
    );
    assert.equal(blame.length, 3);
    assert.equal(blame[2].author, "Test Runner");
    assert.equal(blame[2].summary, "first commit");
    assert.equal(blame[2].content, "line three");

    const diff = await git.runGit(repo.root, ["diff", "--no-color", "--numstat", "HEAD"]);
    const counts = git.parseNumstat(diff);
    assert.equal(counts.length, 1);
    assert.equal(counts[0].path, "a.txt");
    assert.equal(counts[0].additions, 1);
    assert.equal(counts[0].deletions, 1);
  } finally {
    repo.cleanup();
  }
});


test("agent tool handlers run end-to-end against a real repository", { skip: !hasGit }, async () => {
  const repo = createTempRepo();
  try {
    repo.run(["config", "commit.gpgsign", "false"]);
    writeFileSync(join(repo.root, "a.txt"), "line one\nline two\n");
    repo.run(["add", "-A"]);
    repo.run(["commit", "-m", "first commit"]);
    writeFileSync(join(repo.root, "a.txt"), "line one\nline two changed\nline three\n");

    const previousPi = global.pi;
    global.pi = {
      workspace: { get: async () => ({ path: repo.root, name: "repo" }) },
    };

    try {
      const status = await main.onPanelInvoke("git.status", {});
      assert.equal(status.ok, true);
      assert.equal(status.branch, "main");
      assert.equal(status.unstaged.length, 1);
      assert.equal(status.unstaged[0].path, "a.txt");

      const log = await main.onPanelInvoke("git.log", { count: 5 });
      assert.equal(log.ok, true);
      assert.equal(log.commits.length, 1);
      assert.match(log.commits[0].sha, /^[0-9a-f]{40}$/);

      const diff = await main.onPanelInvoke("git.diff", { patch: true });
      assert.equal(diff.ok, true);
      assert.equal(diff.files.length, 1);
      assert.equal(diff.files[0].path, "a.txt");
      assert.equal(diff.files[0].additions, 2);
      assert.equal(diff.files[0].deletions, 1);
      assert.match(diff.patch, /^diff --git a\/a\.txt/);

      const blame = await main.onPanelInvoke("git.blame", { path: "a.txt", limit: 10 });
      assert.equal(blame.ok, true);
      assert.equal(blame.lines.length, 3);
      assert.equal(blame.lines[0].content, "line one");

      const create = await main.onPanelInvoke("git.branch", { action: "create", name: "feat/e2e" });
      assert.equal(create.ok, true);
      const branchList = await main.onPanelInvoke("git.branch", { action: "list" });
      assert.equal(branchList.branches.length, 2);
      const switched = await main.onPanelInvoke("git.branch", { action: "switch", name: "feat/e2e" });
      assert.equal(switched.current, "feat/e2e");

      const committed = await main.onPanelInvoke("git.commit", {
        message: "second commit",
        stage: "all",
      });
      assert.equal(committed.ok, true);
      assert.equal(committed.subject, "second commit");
      assert.match(committed.sha, /^[0-9a-f]{7,}$/);

      const clean = await main.onPanelInvoke("git.status", {});
      assert.equal(clean.staged.length, 0);
      assert.equal(clean.unstaged.length, 0);
      assert.equal(clean.untracked.length, 0);

      writeFileSync(join(repo.root, "a.txt"), "line one\nline two changed\nline three\nstashed line\n");
      const stashPush = await main.onPanelInvoke("git.stash", { action: "push", message: "wip e2e" });
      assert.equal(stashPush.ok, true);
      assert.equal(stashPush.created, true);
      const stashList = await main.onPanelInvoke("git.stash", { action: "list" });
      assert.equal(stashList.stashes.length, 1);
      const stashPop = await main.onPanelInvoke("git.stash", { action: "pop" });
      assert.equal(stashPop.ok, true);

      const state = await main.onPanelInvoke("git.state", {});
      assert.equal(state.ok, true);
      assert.equal(state.repoRoot, realpathSync(repo.root));

      // Path/ref guards reject escapes through the panel channel too.
      await assert.rejects(() => main.onPanelInvoke("git.blame", { path: "../etc/passwd" }));
      await assert.rejects(() => main.onPanelInvoke("git.branch", { action: "create", name: "-rf" }));
    } finally {
      global.pi = previousPi;
    }
  } finally {
    repo.cleanup();
  }
});
