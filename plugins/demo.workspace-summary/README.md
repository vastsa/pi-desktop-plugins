# Workspace Summary

Practical official template plugin for PI-Desktop.

## What it does

- Opens an isolated panel with a workspace inventory
- Reads top-level entries and a README excerpt
- Copies a markdown summary to the clipboard
- Registers an agent tool: `plugin_demo_workspace_summary_workspace_summary`

## Permissions

- `ui.panel`
- `fs.read.workspace`
- `clipboard.write`
- `notify`
- `agent.tool.register`

## Why this template

Use this as the starting point for real productivity plugins:

1. Keep a small `manifest.json`
2. Register commands/tools in `main.js`
3. Put UI in `renderer/index.html`
4. Request only the permissions you need
