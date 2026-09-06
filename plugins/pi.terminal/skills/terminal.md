---
name: Interactive terminal
description: Use the PI-Desktop Terminal plugin for a human-driven interactive shell. Do not treat it as a replacement for the host Bash tool.
---

# Interactive terminal

The `pi.terminal` plugin is an **interactive PTY for the user**, docked only in the right work panel. It has no detached window.

## When to use it

- The user asks to open a terminal, shell, console, or "otty-like" pane next to the chat.
- They want a long-lived interactive session (`vim`, `htop`, a REPL, paging).

Open it by telling them to use the work-panel **Terminal** view (Mod+J, then Terminal). The command **Terminal: Open** only reminds them of that path. There is no agent tool that writes into the PTY.

## What not to do

- Do **not** try to send keystrokes or commands into the plugin PTY.
- For bounded, model-directed commands, keep using the host **Bash** tool. That path is permission-aware, non-interactive, and shown in the transcript.
- Do not confuse this plugin with `pi.ssh-manager`. Remote hosts stay in SSH Manager; this plugin only runs a local shell.
- Do not offer a separate Terminal window — it does not exist.

## Behaviour to remember

- Closing the view does not kill the shell; reopening reconnects with limited in-memory scrollback.
- Tabs are isolated per open project. Switching projects never shows another project's PTY; those sessions stay in the background until the plugin is disabled.
- Uninstalling or disabling the plugin kills every session.
- Default cwd is the open workspace, otherwise the user's home directory.
- Sessions are login shells with the user's interactive PATH (pnpm, nvm, Homebrew, cargo, bun), not the thin GUI PATH of the Electron host.
- macOS defaults to `$SHELL` then zsh; Linux to `$SHELL` then bash; Windows to PowerShell, then cmd, with Git Bash as an optional profile when installed.
