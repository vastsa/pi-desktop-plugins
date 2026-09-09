# AGENTS.md

Mandatory rules for AI coding agents working in this repository.

## Language

Use English for code, identifiers, comments, commits, specifications, and
documentation. When the user writes in another language, reply in that language.

## Repository Purpose

Official plugin marketplace repository for PI-Desktop. The PI-Desktop client
fetches `catalog.json` from GitHub raw and installs the `.piplug` packages it
references.

This repo is the source of truth:

- `plugins/` — plugin source directories
- `packages/` — packed `.piplug` artifacts
- `catalog.json` — generated marketplace index (never hand-edit)

`plugins.aiuo.net` is **not live yet**. Do not publish with
`pi-plugin publish --registry https://plugins.aiuo.net`. Until that registry
launches, every official release is: pack → rebuild catalog → commit
`packages/` + `catalog.json`.

## Commands

No package.json / npm. Tooling is Python 3 (stdlib only) and Node.js (built-in
test runner).

| Action | Command |
|---|---|
| Pack a plugin | `python3 scripts/pack_plugin.py plugins/<id>` |
| Rebuild catalog | `python3 scripts/rebuild_catalog.py` |
| Run all tests | `node --test tests/*.test.mjs` |
| Run one test | `node --test tests/<name>.test.mjs` |

Local verification requires the PI-Desktop app: **Plugins → Load dev plugin**
and choose `plugins/<id>`; or install the packed `.piplug` via
**Install plugin package**.

No linter/formatter is configured.

## Standard Release Flow

```text
bump version in manifest.json
→ python3 scripts/pack_plugin.py plugins/<id>
→ python3 scripts/rebuild_catalog.py
→ node --test tests/*.test.mjs
→ commit packages/<id>-<version>.piplug + catalog.json
→ (optionally commit manifest.json if changed)
```

The catalog keeps a single `versions` entry per plugin. The current manifest
version **must** always have a matching `packages/<id>-<version>.piplug`;
`rebuild_catalog.py` fails otherwise. The catalog `shasum` is recomputed on
every rebuild and must match the packed file. Plugin IDs listed in
`UNPUBLISHED_PLUGIN_IDS` (`scripts/rebuild_catalog.py`) stay in `plugins/`
but are omitted from `catalog.json`. Do not re-add them unless asked to relist.

## Plugin Anatomy

```text
plugins/<id>/
  manifest.json      # required — identity, permissions, ui, contributions
  main.js            # required — CJS module, onLoad()/onUnload(), global pi
  renderer/          # optional — isolated panel UI (index.html + assets)
  skills/            # optional — agent skill markdown
  README.md          # shown in marketplace detail view
```

Plugins are fully self-contained: no shared runtime, no host-side `npm install`.
Dependencies must be bundled. Max 50MB, no symlinks, no path traversal.

### Manifest Requirements

Every `manifest.json` **must** include:

- `schemaVersion`, `id`, `name`, `version`, `description`
- `i18n` block with at minimum `en` and `zh-CN` keys, each containing:
  - `name` — localized display name
  - `description` — localized feature summary
  - `safetyNotes` — plain-language risk summary for the install UI
- `author`
- `main` — entry file (always `main.js`)
- `permissions` — minimal set, reviewed at install time for high-risk entries
- `engines.piDesktop` — minimum host version

Recommended:

- `ui.title` as `{"en": ..., "zh-CN": ...}` so the host resolves the localized
  panel title. When opening a panel from a command, call `pi.ui.openPanel()`
  without a `title` option.
- `categories` — e.g. `["productivity", "official"]`
- `changelog` — short release notes for the current version
- `contributes.commands` / `contributes.agentTools` / `contributes.settings`

### Permission Policy

Request the minimum set. High-risk permissions prompt at install time. Common
permissions:

| Permission | Use |
|---|---|
| `ui.panel` | Open isolated panel |
| `ui.view` | Dock in the right work panel |
| `fs.read.workspace` | Read project files |
| `fs.write.workspace` | Modify project files |
| `fs.read` / `fs.write` | User-selected directory access (gateway) |
| `clipboard.read` / `clipboard.write` | Clipboard access |
| `notify` | Local notifications |
| `net.fetch` | Outbound network |
| `shell.openExternal` | Open external links |
| `agent.tool.register` | Expose tools to the agent |
| `agent.prompt.inject` | Inject skill prompts |
| `background.service` | Keep plugin process resident |
| `usage.read` | Read aggregate local token usage |

Agent tools are exposed with the forced prefix `plugin_<id_safe>_<tool>`.

### Runtime API

`main.js` runs in the plugin process with global `pi`:

- `pi.plugin.getSettings()` / `getDataPath()` / `getId()`
- `pi.commands.register()` / `unregister()`
- `pi.ui.openPanel()` / `showToast()`
- `pi.agent.registerTool()` / `unregisterTool()`
- Permission-gated `fs` / `clipboard` / `net` / `shell` APIs

`onUnload` must unregister everything `onLoad` registered.

### Appearance Adapter

Canonical source: `plugins/shared/appearance/` (not shipped in packages).
Copy both files into each plugin's `renderer/`:

- `appearance-boot.js` — synchronous, in `<head>`. Replays cached appearance
  from localStorage to avoid a flash on open.
- `appearance.js` — end of `<body>`. Pulls `bridge.invoke("app.getAppearance")`
  and subscribes to `bridge.on("appearance:changed")`, re-applying live.
- CSS keys off `[data-theme="dark"]` / `[data-theme="light"]`.

### Host Chrome Contract

PI-Desktop reserves a 46px transparent drag band at the top of every panel and
renders a minimal three-button window-control capsule in the top-right corner.
Plugins must not implement a second draggable titlebar. Window-level fixed or
sticky plugin UI must start at `top: var(--pi-plugin-titlebar-height, 46px)`.

## Tests

`tests/*.test.mjs` use the `node:test` runner with `node:assert/strict`. They
load plugin source directly via `createRequire` (plugins are CJS) and assert:

- Manifest identity, permissions, and contributions
- Agent-tool schemas and behavior
- Plugin-specific logic against real or synthetic fixtures

When adding a plugin or changing a plugin's manifest, the corresponding test
must assert the exact permission list and version.

## Commit Format

```text
type(scope): description
```

Allowed types:

```text
feat fix docs test chore refactor perf build ci
```

Scope is the plugin id (without `plugins/` prefix). Examples:

```text
feat(pi.gitlens): add stash view
fix(pi.ssh-manager): reject shell metacharacters in host field
chore: pack pi.goal-x 0.1.1 and rebuild catalog
```

Requirements:

- English only
- Concise, imperative description
- One logical change per commit

## GitHub Issue Handling

When the user provides a GitHub issue URL (or an unambiguous issue number for
this repository), treat it as an intake gate. Do not start implementation until
the reported problem has been independently verified.

1. Fetch the issue (title, body, labels, comments, and state).
2. Decide whether the claim is real in the current codebase:
   - Bug: reproduce it, or show concrete code/spec evidence that it exists.
   - Feature or improvement: confirm the requested behavior is actually missing
     or incomplete, and in scope.
3. If the problem does **not** exist: comment with verification evidence, close
   when the conclusion is clear.
4. If the problem **does** exist: implement the smallest coherent fix, commit,
   then comment and close.
5. Write the issue comment in the issue's language. Repository code, docs, and
   commits stay English.
6. An issue link authorizes commenting on and closing **that** issue. It does
   not authorize a git push. Remote publishing remains opt-in.

## GitHub Pull Request Handling

When the user provides a GitHub pull request URL (or an unambiguous pull request
number), review the principle first. Do not discard the contributor's work.

1. Fetch the pull request (title, body, files, commits, comments, checks).
2. If the principle is sound: merge **that** pull request, preserving commits.
   Completeness gaps (tests, i18n, style) are follow-up after merge.
3. If the principle is not sound or a harm blocker exists: do not merge.
   Comment with evidence. Do not silently reimplement.
4. Write the pull request comment in the pull request's language. Repository
   code, docs, and commits stay English.
5. A pull request link authorizes reviewing, commenting on, and merging **that**
   pull request. It does not authorize force-push or publishing unrelated work.

## Completion Checklist

Before reporting done:

- [ ] `manifest.json` has complete `i18n` (en + zh-CN: name, description, safetyNotes)
- [ ] `ui.title` is bilingual `{en, zh-CN}` (if panel plugin)
- [ ] Permission set is minimal
- [ ] `python3 scripts/pack_plugin.py plugins/<id>` succeeds
- [ ] `python3 scripts/rebuild_catalog.py` succeeds
- [ ] `node --test tests/*.test.mjs` passes (or new test added)
- [ ] Package sha256 in catalog matches the `.piplug`
- [ ] No secrets, local data, or unrelated changes are included
- [ ] All logical changes committed with conventional format
- [ ] Remote publishing only if explicitly requested

## Final Report

Report:

- What changed (plugin id, version, files)
- Pack and catalog result (sha256, size)
- Test result
- Commit hash and message
- Push target and result, or confirmation that nothing was pushed
