# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository purpose

Official plugin marketplace repository for PI-Desktop (a desktop environment app). The PI-Desktop client fetches `catalog.json` from GitHub raw and installs the `.piplug` packages it references. This repo is the source of truth: plugin sources in `plugins/`, packed artifacts in `packages/`, marketplace index in `catalog.json`.

## Commands

No package.json / npm. Tooling is Python 3 (stdlib only) and Node.js (built-in test runner).

- **Pack a plugin**: `python3 scripts/pack_plugin.py plugins/<id>` — writes `packages/<id>-<version>.piplug` (version read from `manifest.json`), prints sha256 and size.
- **Rebuild catalog**: `python3 scripts/rebuild_catalog.py` — regenerates `catalog.json` from `plugins/*/manifest.json` + `packages/*.piplug`; exits with an error if a plugin has no matching package. `catalog.json` is generated output — never hand-edit it.
- **Run tests**: `node --test tests/`, or a single file e.g. `node --test tests/gitlens.test.mjs`.
- **Local verification** requires the PI-Desktop app: **Plugins → Load dev plugin** and choose `plugins/<id>`; or install the packed `.piplug` via **Install .piplug**.
- No linter/formatter is configured.

Standard release flow for a plugin change: bump `version` in `manifest.json` → `python3 scripts/pack_plugin.py plugins/<id>` → `python3 scripts/rebuild_catalog.py` → run tests. Commit messages use conventional format with the plugin id as scope (e.g. `feat(pi.gitlens): ...`, `fix(super-domain-man): ...`).

## Architecture

### Plugin anatomy — `plugins/<id>/`

- `manifest.json` (required) — identity, permissions, `ui.panel`, contributions
- `main.js` (required) — CommonJS module exporting `onLoad()` / `onUnload()`, runs in the plugin process with a global `pi` runtime API
- `renderer/` (optional) — isolated panel UI (`index.html` + assets)
- `skills/` (optional) — agent skill markdown
- `README.md` — shown in the marketplace detail view

Plugins are **fully self-contained**: no shared runtime with the host or other plugins at run time, and no host-side `npm install` — dependencies must be bundled into the package. Packing constraints: package root must contain `manifest.json`, no symlinks, no path traversal, max 50MB.

### Manifest essentials

- `ui.title` must be bilingual `{"en": ..., "zh-CN": ...}` so the host follows the app language. When opening a panel from a command, call `pi.ui.openPanel()` without a `title` option so the host resolves the localized manifest title.
- `contributes.commands` / `contributes.agentTools` / `contributes.settings` declare what `main.js` registers.
- Request the minimum permission set; high-risk permissions prompt at install time and auto-update never silently expands them. Common permissions: `ui.panel`, `fs.read.workspace`, `fs.write.workspace`, `clipboard.read`/`write`, `notify`, `net.fetch`, `shell.openExternal`, `agent.tool.register`, `agent.prompt.inject`, `usage.read`.
- Agent tools are exposed with the forced prefix `plugin_<id_safe>_<tool>`.

### Runtime API

`main.js` runs in the plugin process with global `pi`: `pi.plugin.getSettings()/getDataPath()/getId()`, `pi.commands.register/unregister()`, `pi.ui.openPanel()/showToast()`, `pi.agent.registerTool/unregisterTool()`, plus permission-gated fs/clipboard/net/shell APIs. `onUnload` must unregister everything `onLoad` registered.

### Appearance adapter — `plugins/shared/appearance/`

Canonical source for following the host's color mode (light/dark) and locale (zh-CN/en). It is **not shipped in packages** — copy both files into each plugin's `renderer/` (all current plugins already do this):

- `appearance-boot.js` — synchronous, in `<head>` before the body. Replays the last known appearance from localStorage (per-plugin cache key via `window.__APPEARANCE_CACHE_KEY`, default `pi.appearance.v1`) to avoid a flash on open; falls back to OS preference.
- `appearance.js` — loaded at the end of `<body>`; `window.__appearance.init(window.pluginBridge)` pulls `bridge.invoke("app.getAppearance")` and subscribes to `bridge.on("appearance:changed")`, re-applying live and writing the cache. Degrades silently on hosts without the channel.
- Panel CSS keys off `[data-theme="dark"]` / `[data-theme="light"]`; text switches via `onThemeChange` / `onLocaleChange` (or `current().locale`).

Panel chrome (titlebar, drag region) is host-owned — plugin content must not implement a second titlebar.

### Packages & catalog

- `.piplug` is a store-compressed zip written by a hand-rolled struct-packed Python zip writer in `scripts/pack_plugin.py` (no compression level, no external zip dependency).
- `catalog.json` keeps a single `versions` entry per plugin, so the current manifest version must always have a matching `packages/<id>-<version>.piplug`; `rebuild_catalog.py` fails otherwise.
- The catalog `shasum` must match the packed file — it is recomputed on every rebuild.

### Tests

`tests/*.test.mjs` use the `node:test` runner with `node:assert/strict`. They load plugin source directly via `createRequire` (plugins are CJS) and assert manifest identity/permissions, agent-tool schemas, and behavior — e.g. `gitlens.test.mjs` spins up real temp git repositories via `git init`; `token-insights.test.mjs` builds JSONL session fixtures in temp dirs. When adding a plugin or changing a plugin's manifest, the corresponding test asserts the exact permission list and version.
