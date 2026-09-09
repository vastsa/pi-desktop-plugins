# Changelog

## 0.1.1 - 2026-09-09

- Keep a usable toolbar in docked work-panel views (host titlebar height is 0).
- Show the three-pane dashboard at the default window width.
- Fail closed on malformed `goalXState` and write a complete settings object.
- Gate renderer mock data behind `?preview=1` so packaged audits cannot rubber-stamp.
- Namespace command ids (`goal-x.open` / `goal-x.new` / `goal-x.new-sisyphus`).
- Follow the official appearance adapter and retint the host capsule.
- Hash only session/turn metadata for blocker reports; do not hash user text.

## 0.1.0 - 2026-09-09

- Port the core `pi-goal-x` goal pool, focus, lifecycle, task tree, evidence,
  and audit workflows to the PI-Desktop plugin API.
- Add a bilingual v3 dashboard for standalone and docked panel use.
- Add five namespaced Agent tools and a focused workflow skill.
- Add host-owned independent completion audits with stale-revision protection.
- Persist bounded, workspace-scoped state in plugin-private settings without
  workspace file or network access.
