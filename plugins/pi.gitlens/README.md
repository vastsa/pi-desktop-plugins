# Git Lens

A [GitLens](https://www.gitkraken.com/gitlens)-inspired local Git management
plugin for PI-Desktop. It turns the current workspace's repository into a
visual dashboard, and gives the AI nine agent tools to inspect and manage the
project's git state.

## Features

- **Panel** (`pi.gitlens`): an isolated multi-page dashboard that follows the
  app language (en / zh-CN) and color mode:
  - **Overview** — branch, upstream, ahead/behind, staged / unstaged /
    untracked / conflict counts, recent commits.
  - **History** — searchable commit log; click a commit for its files, stats
    and unified patch.
  - **Changes** — working-tree changes grouped by stage state; per-file diffs;
    commit box with stage-all / tracked staging and amend.
  - **Branches** — list with current badge, create / switch / safe delete.
  - **Blame** — GitLens-style per-line attribution for any repo-relative file.
- **Commands** — `Git Lens: Open`, `Open History`, `Open Changes`,
  `Open Branches`, `Open Blame` from the command palette.
- **Agent tools** — the AI can inspect and manage git directly:

| Tool | Risk | Purpose |
| --- | --- | --- |
| `git_status` | low | Branch, ahead/behind, staged/unstaged/untracked/conflicts |
| `git_log` | low | Commit history with path / query / author filters |
| `git_show` | low | One commit: message, files, stats, optional patch |
| `git_diff` | low | Working tree or ref-to-ref diff, optional patch |
| `git_blame` | low | Per-line attribution of a file |
| `git_branch` | medium | List / create / switch / safe delete branches |
| `git_commit` | medium | Stage and commit (respects hooks, no force) |
| `git_stash` | medium | List / push / pop / drop stashes |
| `git_open_panel` | low | **Open any panel page on demand** (AI-callable new page) |

  The AI-callable `git_open_panel` is the bridge between conversation and UI:
  ask the agent to "open git history" or "show the repo dashboard" and it opens
  the panel on the right page, optionally preselecting a path or ref.

- **Skill** — `Git workflow` teaches the agent when to use each tool:
  inspect first, mutate deliberately, never push/pull/force without an
  explicit request.

## How it works

- The repository root is resolved from the current workspace via
  `git rev-parse --show-toplevel`; every command runs with `-C <repoRoot>`.
- Git is executed through `execFile` with argument arrays — no shell, no
  string interpolation — so paths and refs cannot become commands.
- `GIT_TERMINAL_PROMPT=0` is set, so git never blocks waiting for
  credentials; the tools cannot push, pull or fetch.
- Paths must be repo-relative (no absolute paths, no `..` escapes); refs and
  branch names are validated against a safe charset.
- The panel runs in the host's isolated, context-isolated window and talks to
  the plugin process only through the host bridge.

## Permissions

| Permission | Why |
| --- | --- |
| `ui.panel` | Open the isolated panel |
| `agent.tool.register` | Register the nine agent tools |
| `agent.prompt.inject` | Load the `Git workflow` skill |

No `fs.*`, `net.fetch`, clipboard, shell or notify permissions are requested.
All repository access happens through the system `git` binary inside the
plugin process.

## Commands

| Command | Opens |
| --- | --- |
| `Git Lens: Open` | Overview |
| `Git Lens: Open History` | History |
| `Git Lens: Open Changes` | Changes |
| `Git Lens: Open Branches` | Branches |
| `Git Lens: Open Blame` | Blame |

## Requirements

- PI-Desktop `>= 0.2.9`
- `git` available on `PATH`
- The current workspace must be inside a git repository

## Development

```bash
python3 scripts/pack_plugin.py plugins/pi.gitlens
python3 scripts/rebuild_catalog.py
node tests/gitlens.test.mjs
```

Install the packed `.piplug` via **Plugins → Install plugin package**, or load
the folder as a development plugin.

## Changelog

### 0.1.1

Restyles the panel to mirror the PI-Desktop design system: the purple accent
and bespoke palette are replaced by the app's neutral monochrome accent and
`--ds-*` tokens, and git semantics now use the app's success / warning / error
colors. A contributed app theme re-skins the panel exactly as it re-skins the
shell. No behavior, tool, command or permission changes.

### 0.1.0

First release: multi-view panel (Overview / History / Changes / Branches /
Blame) with app language & theme following, five palette commands, nine agent
tools including the AI-callable `git_open_panel`, and the `Git workflow`
skill. All git operations run through the system git binary against the
resolved repository root of the current workspace.
