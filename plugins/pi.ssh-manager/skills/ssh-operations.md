---
name: SSH remote operations
description: Use when the user asks to inspect, troubleshoot, or operate a host configured in SSH Manager.
---

# SSH remote operations

Use the SSH Manager tools only for a host the user has configured in the panel.

1. Call `ssh_list_hosts` first. Never invent a profile id or silently connect to
   an arbitrary hostname.
2. Call `ssh_connect` before a sequence of commands. Keep strict host-key
   verification unless the user explicitly approves accepting a new key.
3. Treat `ssh_execute` as a high-risk remote shell action. Explain the command
   before running it when it changes state, and ask before destructive work.
4. Do not ask the user to paste a password, private key, passphrase, or secret
   into chat. If password authentication is needed, ask the user to enter it in
   the SSH Manager panel. The panel keeps it in memory only; the AI never
   receives the password value.
5. Do not request commands that print environment files, private keys, tokens,
   or unrelated personal data. Summarize only the output needed for the task.
6. Use `ssh_disconnect` when the remote task is complete. Sessions are logical
   and expire automatically; each command is separately bounded.
