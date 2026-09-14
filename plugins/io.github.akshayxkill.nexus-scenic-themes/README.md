# Nexus Scenic Themes

Four locally packaged scenic themes for PI-Desktop: Twilight Mountains, Alpine Light, Obsidian Horizon, and Emerald Afterglow.

Open **Settings → Extensions → Nexus Scenic Themes** to choose a theme and set its backdrop-only blur from 0 to 20 pixels. Each theme remembers its own blur value.

## Permissions

- `ui.theme` applies the four declared themes and their validated backdrop-blur variable.
- `ui.settings` contributes the sandboxed Settings destination.
- `ui.window.appearance` supplies safe native fallback colors while a declared theme is selected.

No files, network, clipboard, shell, agent tools, or remote assets are used. Backdrops are bundled locally. Visual direction and assets are attributed to the Nexus project: https://github.com/Akshayxkill/PI-Desktop-Nexus.

## Compatibility

This preview requires PI-Desktop builds containing the plugin appearance extensions API from `feat/plugin-appearance-extensions`. It will receive a released version floor once that API merges upstream.
