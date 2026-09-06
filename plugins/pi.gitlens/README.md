# Git Lens

A [GitLens](https://www.gitkraken.com/gitlens)-inspired local Git management
plugin for PI-Desktop. It turns the current workspace's repository into a
visual dashboard, and gives the AI nine agent tools to inspect and manage the
project's git state.

## Features

- **Work panel view** (`pi.gitlens`): docks in the app's right work panel
  (no separate window). Open the work panel (`Mod+J`) and choose **Git Lens**.
  The dashboard follows the app language (en / zh-CN) and color mode from the
  first paint (command palette titles and toasts too):
  - **Overview** — compact staged / unstaged / untracked / conflict counts
    plus recent commits (click a commit to open it).
  - **History** — searchable commit log; click a commit to open a full-page
    sheet (files and patch) with Back.
  - **Changes** — working-tree changes grouped by stage state; click a file
    to open its diff in a full-page sheet; compact commit box.
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
| `git_open_panel` | low | **Focus any Git Lens page** in the work panel |

  The AI-callable `git_open_panel` is the bridge between conversation and UI:
  ask the agent to "open git history" or "show the repo dashboard" and it
  focuses that page in the work panel, optionally preselecting a path or ref.
  If Git Lens is not already visible, open the work panel (`Mod+J`) and choose
  Git Lens.

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
- The UI is a `contributes.views` surface docked in the work panel. It talks
  to the plugin process only through the host bridge, with the same isolation
  as a panel window (sandboxed page, per-plugin partition) but no detached
  window chrome.

## Permissions

| Permission | Why |
| --- | --- |
| `ui.view` | Dock Git Lens in the right work panel |
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

- PI-Desktop `>= 0.8.0`
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

### 0.2.4

Command palette titles, work-panel copy and toasts follow the app language
(en / zh-CN) from the first paint. 命令面板、工作面板文案和提示从首帧起跟随
应用语言。

### 0.2.3

Compact work-panel UI: overview is a single count row (not 2×2 cards).
Clicking a changed file or commit opens a full-page sheet with Back,
instead of dumping the patch under the list.

### 0.2.2

Premium docked UI: iOS-style segmented control, large-title identity,
inset grouped lists, and a 2×2 metric widget. Feishu/iOS density on the
host's neutral gray ramp.

### 0.2.1

Restyles the docked view to match the PI-Desktop work panel and Files plugin:
text tabs, a quiet branch/repo status line, list rows instead of chips and
colored tiles, and the host's neutral gray accent (no purple).

### 0.2.0

Docks only in the right work panel (`contributes.views` + `ui.view`) and no
longer opens a separate window. Commands and `git_open_panel` still switch the
live page; if the view is not visible, a toast points at the work-panel
switcher (`Mod+J`). Requires PI-Desktop `>= 0.8.0`.

### 0.1.4

Keeps the first view toolbar clear of the host window-control capsule and
re-tints the capsule when the panel palette changes.

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
