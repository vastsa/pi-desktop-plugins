---
name: Git workflow
description: Use when the user asks about the current project's git state, commit history, file changes, line attribution (blame), branches, commits, or stashes. Guides the agent through PI-Desktop's Git Lens plugin tools: inspect first, then mutate deliberately, and never push, pull, fetch, force, or rewrite history unless the user explicitly asks.
---

# Git workflow (Git Lens)

PI-Desktop ships the **Git Lens** plugin (`pi.gitlens`). Its tools run the
system `git` binary against the repository root of the currently open
workspace. Tools are exposed to the agent under the forced prefix
`plugin_pi_gitlens_<tool>`.

## Read-only inspection (prefer first)

- `git_status` — working tree state: branch, upstream, ahead/behind, and
  changes grouped into staged / unstaged / untracked / conflicts. Start here
  whenever the user asks "what changed" or before doing anything else.
- `git_log` — recent commits. Filter with `path`, `query` (subject grep) or
  `author`. Use a narrow `path` for "what touched this file recently".
- `git_show` — one commit in detail: message, author, dates, changed files,
  optional unified patch (`patch: true`). Use a short sha or `HEAD`.
- `git_diff` — working-tree diff versus `HEAD` (default) or between two refs.
  Set `patch: true` only when the user wants to see the actual code change;
  prefer the stat for overview questions.
- `git_blame` — per-line attribution for one file: originating commit sha,
  author, author time, commit subject. Require a `path`.

## Deliberate mutation (ask before acting, or act on explicit request)

- `git_commit` — stage (`all` / `tracked` / specific paths) and commit with a
  clear message. Never amend, and never rewrite history, unless the user
  explicitly asks. Respect the repository's commit conventions.
- `git_branch` — list, create, switch, delete. Deleting is safe by default
  (`-d` refuses unmerged branches); only use `force` when the user confirms.
- `git_stash` — push/pop/drop stashes for WIP the user wants to set aside.

## Workflow rules

1. Inspect before mutating: run `git_status` and, when relevant, `git_diff`
   before committing or stashing.
2. Never `push`, `pull`, `fetch`, rebase, reset, or force-push — Git Lens
   tools do not expose those operations. If the user asks for them, say the
   plugin does not provide them and suggest running git in the terminal.
3. Never stage or commit secrets: check `git_status` for `.env*`, credential
   files, `*.pem`, or large artifacts before `git_commit`. Prefer staging
   explicit paths when a broad `add -A` would sweep in unwanted files.
4. Prefer short SHAs in replies; show subjects and authors, not full bodies,
   unless the user asks for detail.
5. When the user wants to *see* git information, call
   `git_open_panel` with the matching `view` (overview / history / diff /
   branches / blame) instead of dumping long output. The panel opens as a new
   page in PI-Desktop.
6. If the workspace is not a git repository, the tools fail with a clear
   message — report that rather than working around it.
