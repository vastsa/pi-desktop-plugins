# Terminal · 终端

Otty-inspired interactive terminal for PI-Desktop. It docks in the right work panel next to the conversation — there is no separate window.

受 Otty 启发的交互式终端，只停靠在右侧工作面板（无独立窗口）。

## What it does

- **Work panel view** — `Terminal` / `终端` in the plugin views menu (icon `terminal`). Open the work panel with **Mod+J**.
- **Tabs** — new / close / switch. Closing the view does **not** kill the shell; reopening replays a bounded in-memory scrollback. Tabs belong to the **currently open project**; switching projects shows that project's terminals only (other shells stay alive in the background until the plugin is disabled).
- **Cross-platform shells**
  - macOS: `$SHELL` → `/bin/zsh` as a real login shell (`argv0` `-zsh`)
  - Linux: `$SHELL` → `/bin/bash` as a real login shell
  - Windows: PowerShell → `cmd.exe`; Git Bash is offered when installed
- **Login PATH** — GUI apps often see a thin PATH. On load the plugin dumps your interactive login environment and injects it into every PTY, then prepends common tool dirs (pnpm, nvm, bun, cargo, Homebrew) if they exist. `node` / `pnpm` / `brew` should resolve the same way they do in Terminal.app.
- Follows the app language (`en` / `zh-CN`) and color mode. Copy/paste: macOS `Cmd+C/V`, Windows/Linux `Ctrl+Shift+C/V`. Find: `Cmd/Ctrl+F`. Font size: `Cmd/Ctrl +` / `-`.

Not in v0.1: pane splits, Recipes, SSH sessions (use **SSH Manager**), or an agent tool that types into the PTY.

## Permissions

| Permission | Why |
| --- | --- |
| `ui.view` | Work-panel Terminal view |
| `background.service` | Keep the plugin process (and live PTYs) resident when the UI is closed |
| `clipboard.read` / `clipboard.write` | Paste / copy |
| `agent.prompt.inject` | Skill that tells the AI this PTY is for humans; host Bash stays the command path |

No `fs.*` permission. The plugin process reads the current workspace path and passes it to the helper as the session cwd.

## How it works

A bundled helper binary (`vendor/pi-pty-<os>-<arch>`) owns the real PTY (forkpty / ConPTY). The plugin process speaks a JSON-line protocol with the helper. The sandboxed view has no Node and no push channel, so output is pulled with `pty.drain` long-polls.

The zip packer does not preserve unix `+x`. On first spawn the plugin `chmod`s the helper.

## Settings

- `fontSize` — 10–24, default 13
- `scrollback` — in-memory reconnect buffer in lines, default 5000
- `maxSessions` — live tab cap, default 8
- `profiles` — JSON array of `{ id, name, shell, args, cwd, env }`. `cwd` must stay inside the workspace or home directory.

## Development

```bash
# rebuild helpers (Go 1.22+)
sh plugins/pi.terminal/helper/build.sh

python3 scripts/pack_plugin.py plugins/pi.terminal
python3 scripts/rebuild_catalog.py
node --test tests/terminal.test.mjs tests/panel-chrome.test.mjs
```

Load `plugins/pi.terminal` as a development plugin, then open **Terminal** from the work panel (Mod+J).

## Requirements

- PI-Desktop `>= 0.8.0` (`ui.view` / work-panel plugin views)
- A helper binary for the current `process.platform` + `process.arch`
