# Contributing

The **live marketplace** is [plugins.aiuo.net](https://plugins.aiuo.net), not this GitHub repository.

This repo holds:

- official plugin **source** under `plugins/`
- a **fail-closed GitHub raw mirror** of `catalog.json` + `packages/*.piplug`

Do **not** open PRs whose only purpose is to add a plugin to `catalog.json`. That file is overwritten by CI from the backend.

## Publish a third-party plugin

1. Sign in at `https://plugins.aiuo.net` with GitHub.
2. Create a publisher slug and a CLI token (`pipt_…`).
3. Pack and upload:

```bash
pi-plugin pack
pi-plugin publish --registry https://plugins.aiuo.net --token "$PI_PLUGIN_TOKEN"
```

The first version goes to review. Later versions of a trusted publisher may auto-publish when there is no permission escalation.

## Official plugins in this repo

```bash
# edit plugins/<id>/, bump manifest.version
node --test tests/<name>.test.mjs
# PI-Desktop → Load dev plugin → plugins/<id>
python3 scripts/pack_plugin.py plugins/<id>
pi-plugin publish --registry https://plugins.aiuo.net
```

`python3 scripts/rebuild_catalog.py` is a local fixture helper only.

## Plugin layout

```text
plugins/<id>/
  manifest.json      # required
  main.js            # required entry
  renderer/          # optional isolated panel UI
  README.md
  skills/            # optional
```

### manifest.json minimum

```json
{
  "schemaVersion": 1,
  "id": "my.plugin-id",
  "name": "My Plugin",
  "version": "0.1.0",
  "description": "What it does",
  "i18n": {
    "en": { "name": "My Plugin", "description": "What it does" },
    "zh-CN": { "name": "我的插件", "description": "插件功能简介" }
  },
  "author": "your-name",
  "main": "main.js",
  "permissions": ["ui.panel"],
  "engines": { "piDesktop": ">=0.2.0" }
}
```

Panel titles must be bilingual (`ui.title.en` / `ui.title.zh-CN`). Call `pi.ui.openPanel()` without a `title` option. Do not draw a second window titlebar; host chrome occupies the top 46px (`var(--pi-plugin-titlebar-height, 46px)`).

## Packaging rules

- Root of the package must contain `manifest.json`
- No symlinks, no path traversal
- Store-compressed `.piplug`, max 50MB
- Bundle your own dependencies (no host-side `npm install`)

## Permission policy

Request the minimum set. High-risk permissions (`fs.write`, `net.fetch`, `shell.openExternal`, `agent.prompt.inject`, …) force review. Auto-update will not silently expand permissions.

## PR checklist (source changes only)

- [ ] Unique `id`, semantic `version`
- [ ] README explains what / why / permissions
- [ ] Tests updated (`node --test tests/…`)
- [ ] Loaded as a dev plugin in PI-Desktop
- [ ] **Not** editing `catalog.json` by hand

## Mirror

Hourly GitHub Action: `scripts/sync_catalog.py` pulls `https://plugins.aiuo.net/catalog.json` and artifacts, rewrites URLs to `packages/<id>-<version>.piplug`, and commits only on success. A failed fetch leaves the previous mirror in place.
