# PI-Desktop Plugins

[中文版 / Chinese](./README.zh-CN.md)

Official plugin marketplace repository for [PI-Desktop](https://github.com/vastsa/PI-Desktop).
Contains plugin sources, installable `.piplug` packages, and the generated marketplace catalog.

> `plugins.aiuo.net` is not live yet. The PI-Desktop client fetches `catalog.json` from GitHub raw. Until the registry launches, every release is: pack → rebuild catalog → commit / merge to `main`.

## Repository Layout

| Path | Description |
|------|-------------|
| `catalog.json` | Marketplace index fetched by PI-Desktop clients |
| `packages/*.piplug` | Packed plugin packages users download and install |
| `plugins/<id>/` | Plugin source directories, one folder per plugin |
| `scripts/` | Build helpers (`pack_plugin.py`, `rebuild_catalog.py`) |

## Available Plugins

### Official (maintained by PI-Desktop team)

| Plugin | Description | Author |
|--------|-------------|--------|
| **pi.todo** | Lightweight todo app with four-quadrant matrix and simple list layouts, due reminders and AI tool integration | PI-Desktop |
| **pi.token-insights** | Token usage dashboard tracking PI-Desktop, Claude Code, Codex and other tools | PI-Desktop |
| **pi.gitlens** | GitLens-style local Git management docked in the work panel (human UI only, no agent tools) | PI-Desktop |
| **pi.ssh-manager** | Local-first SSH host management with AI remote command tool, transient panel passwords and no persisted credentials | PI-Desktop |
| **pi.terminal** | Interactive terminal docked in the work panel; multi-tab, cross-platform shell | PI-Desktop |
| **pi.session-orchestrator** | Coordinate real durable worker sessions from an Agent with bounded parallel execution and final-report aggregation | PI-Desktop |

### Community

| Plugin | Description | Author |
|--------|-------------|--------|
| **pi.scratch-calc** | Scratch calculator with multi-line history, percentage/power/π/e and dark mode | Tioit-Wang |
| **pi.super-domain-man** | Multi-platform DNS record management and SSL certificate monitoring/issuance | Tioit-Wang |
| **pi.markdown** | Local Markdown notes with WYSIWYG editing, table of contents, code highlighting, Mermaid / KaTeX | Tioit-Wang |
| **pi.clipboard-history** | Clipboard history capturing text during runtime, retained 30 days, one-click restore | Tioit-Wang |
| **pi.log-viewer** | Large log viewer with streaming pagination, live tail, search highlighting and multi-file tabs | Tioit-Wang |
| **pi.bianqian** | Markdown desktop sticky notes: multi-note, live preview, task lists, highlighter and trash | ZY |
| **io.github.muzimu217.session-import** | Universal session import + forge: bring sessions in from ZCode, WorkBuddy, Claude Code, Codex, OpenCode and Pi, then distill them into project conventions and reusable practices | muzimu217 |

### Demos

| Plugin | Description |
|--------|-------------|
| **demo.hello** | Minimal example: panel + command + tool registration |
| **demo.workspace-summary** | Practical template: scan workspace and generate a summary |
| **demo.workspace-notes** | High-risk capability demo: file read/write + network requests |

## Install Plugins

1. Open PI-Desktop → **Plugins**
2. Go to the **Marketplace** page
3. Click **Refresh from repository** to load the latest catalog
4. Browse and install plugins

Catalog URL:

```text
https://raw.githubusercontent.com/vastsa/pi-desktop-plugins/main/catalog.json
```

## Develop Your Own Plugin

### Quick Start

```bash
# 1) Fork + clone
git clone https://github.com/<you>/pi-desktop-plugins.git
cd pi-desktop-plugins

# 2) Copy a template
cp -R plugins/demo.workspace-summary plugins/my.plugin-id

# 3) Edit manifest + code
#    - Update id/name/version/description in manifest.json
#    - Implement main.js
#    - Create renderer/index.html (optional panel UI)

# 4) Pack
python3 scripts/pack_plugin.py plugins/my.plugin-id

# 5) Rebuild catalog
python3 scripts/rebuild_catalog.py

# 6) Test in PI-Desktop
#    - Use "Load dev plugin" or install the .piplug directly
```

### Plugin Structure

```
plugins/<id>/
├── manifest.json      # Required: plugin metadata
├── main.js            # Required: CJS entry, exports onLoad()/onUnload()
├── renderer/          # Optional: panel UI
│   ├── index.html
│   ├── style.css
│   └── script.js
├── README.md          # Recommended: shown in marketplace detail
└── skills/            # Optional: AI agent tool definitions
```

### Key manifest.json Fields

```json
{
  "schemaVersion": 1,
  "id": "my.plugin-id",
  "name": "My Plugin",
  "version": "0.1.0",
  "description": "What it does",
  "i18n": {
    "en": { "name": "My Plugin", "description": "What it does" },
    "zh-CN": { "name": "我的插件", "description": "插件功能描述" }
  },
  "author": "your-name",
  "main": "main.js",
  "categories": ["productivity"],
  "permissions": ["ui.panel"],
  "engines": { "piDesktop": ">=0.2.0" }
}
```

### Common Permissions

| Permission | Use |
|------------|-----|
| `ui.panel` | Open isolated panel |
| `fs.read.workspace` | Read workspace files |
| `fs.write.workspace` | Modify workspace files |
| `clipboard.read` / `clipboard.write` | Clipboard access |
| `notify` | Local notifications |
| `net.fetch` | Outbound network requests |
| `shell.openExternal` | Open external links |
| `agent.tool.register` | Register AI agent tools |

> **Tip**: Request the minimum set of permissions. High-risk permissions prompt the user at install time.

## Security
Plugin review is a release gate. See [SECURITY.md](./SECURITY.md) for the mandatory policy, blocker list, risk tiers, artifact checks, and vulnerability reporting process. New plugins and behavior-changing releases must pass `python3 scripts/security_audit.py --check-packages`; high-risk changes require two independent maintainer reviews.
## Contributing

1. Fork this repository
2. Create your plugin from a demo template
3. Test thoroughly in PI-Desktop
4. Submit a Pull Request (ensure unique `id`, semver versioning, clear docs)

See [CONTRIBUTING.md](./CONTRIBUTING.md) for details.

## Packaging Constraints

- Package root must contain `manifest.json`
- No symlinks or path traversal
- Store-compressed `.piplug` format
- Max package size: 50 MB
- Bundle your own dependencies — no host-side `npm install`

## License

MIT
