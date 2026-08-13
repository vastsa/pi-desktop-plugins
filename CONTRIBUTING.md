# Contributing plugins to PI-Desktop

This repository is the **official plugin marketplace warehouse** for [PI-Desktop](https://github.com/vastsa/PI-Desktop).

PI-Desktop reads:

```text
https://raw.githubusercontent.com/vastsa/pi-desktop-plugins/main/catalog.json
```

and installs the `.piplug` packages referenced by that catalog.

## Quick start

```bash
# 1) fork + clone
git clone https://github.com/<you>/pi-desktop-plugins.git
cd pi-desktop-plugins

# 2) copy the practical template
cp -R plugins/demo.workspace-summary plugins/my.plugin-id

# 3) edit manifest + code
#    - change id/name/version/description
#    - implement main.js
#    - optional renderer/index.html

# 4) pack
python3 scripts/pack_plugin.py plugins/my.plugin-id

# 5) rebuild catalog
python3 scripts/rebuild_catalog.py

# 6) open a PR to vastsa/pi-desktop-plugins
```

## Plugin layout

```text
plugins/<id>/
  manifest.json      # required
  main.js            # required entry
  renderer/          # optional isolated panel UI
  README.md          # shown in marketplace detail
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
  "author": "your-name",
  "main": "main.js",
  "permissions": ["ui.panel"],
  "engines": { "piDesktop": ">=0.2.0" }
}
```

### Recommended fields for marketplace quality

- `categories`: e.g. `["productivity", "official"]`
- `changelog`: short release notes for the current version
- `safetyNotes`: plain-language risk summary
- `ui.panel`: isolated panel html entry
- `contributes.commands` / `contributes.agentTools` / `contributes.settings`

### Panel title and host chrome compatibility

Panel titles must provide both English and Simplified Chinese so PI-Desktop can
follow the active application language:

```json
{
  "ui": {
    "panel": "renderer/index.html",
    "title": {
      "en": "My Plugin",
      "zh-CN": "我的插件"
    }
  }
}
```

Do not hard-code a replacement title when opening the panel from a command. Use
`pi.ui.openPanel()` without a `title` option so the host can resolve the
localized manifest title. PI-Desktop owns the panel titlebar and adapts its
background and foreground to the page appearance; plugin content should start
below that host-owned chrome and should not implement a second draggable window
titlebar.

## Local verification in PI-Desktop

Before opening a PR:

1. Open PI-Desktop → **Plugins**
2. Use **Load dev plugin** and choose `plugins/<id>`
3. Confirm:
   - command palette entry works
   - panel opens (if declared)
   - agent tool appears with forced prefix `plugin_<id_safe>_<tool>`
   - undeclared permissions fail cleanly

Or install the packed artifact:

1. `python3 scripts/pack_plugin.py plugins/<id>`
2. PI-Desktop → **Install .piplug**
3. Review permissions carefully

## Packaging rules

- Root of the package must contain `manifest.json`
- No symlinks
- No path traversal
- Prefer store-compressed `.piplug`
- Max package size: 50MB
- Do not expect host-side `npm install` at install time; bundle dependencies yourself

## Permission policy

Request the minimum set:

| Permission | Use |
|---|---|
| `ui.panel` | Open isolated panel |
| `fs.read.workspace` | Read project files |
| `fs.write.workspace` | Modify project files |
| `clipboard.read` / `clipboard.write` | Clipboard access |
| `notify` | Local notifications |
| `net.fetch` | Outbound network |
| `shell.openExternal` | Open external links |
| `agent.tool.register` | Expose tools to the agent |
| `usage.read` | Read aggregate local token usage without message content |

High-risk permissions are reviewed in the install UI. Auto-update will not silently expand permissions.

## PR checklist

- [ ] Unique `id`
- [ ] Semantic `version`
- [ ] README explains what/why/permissions
- [ ] `python3 scripts/pack_plugin.py ...` succeeds
- [ ] `python3 scripts/rebuild_catalog.py` updated `catalog.json`
- [ ] Package sha256 in catalog matches the `.piplug`
- [ ] Tested via Load dev plugin and/or Install .piplug
- [ ] No secrets in source or package

## After merge

Once merged to `main`:

1. GitHub raw catalog updates
2. In PI-Desktop open **Plugins → Marketplace**
3. Click **Refresh from repo**
4. Your plugin becomes installable

## Template recommendation

Start from:

- `plugins/demo.workspace-summary` for a real productivity plugin
- `plugins/demo.hello` for the smallest command/panel/tool sample
- `plugins/demo.workspace-notes` for high-risk capability demos
