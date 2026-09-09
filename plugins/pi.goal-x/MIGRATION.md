# Migration map

This document records the functional mapping from `pi-goal-x` 0.31.2 to the
PI-Desktop plugin runtime available in PI-Desktop 0.13.11 and later.

| Upstream capability | PI-Desktop implementation |
| --- | --- |
| Goal record and pool | Normalized `goalXState` object in plugin-private settings, partitioned by a SHA-256 workspace key |
| Session focus | A display focus per workspace plus opaque per-Agent-session focus; explicit panel focus changes invalidate older session mappings to prevent hidden-target mutations |
| Regular / Sisyphus modes | Preserved as goal mode and Agent guidance |
| Hierarchical tasks | Flat parent-linked tool input compiled into a four-level tree |
| Verification contracts and evidence | Preserved on goals and tasks; contracted tasks reject empty evidence |
| Atomic task batches | Clone, validate all operations, then replace the saved goal once |
| Pause / resume / blocker | Preserved; repeated blockers are counted across distinct tool turn ids |
| Goal files and JSONL ledger | Replaced by bounded activity and audit arrays in private plugin settings |
| TUI widget and dialogs | Replaced by a bilingual HTML dashboard available as a panel and docked view |
| Pi slash commands with arguments | Exact no-argument aliases open or act on the panel; PI-Desktop does not pass command arguments |
| Dynamic Pi tool profiles | One fixed five-tool Agent contribution plus a scoped skill |
| Tool-using auditor session | Tool-free `pi.agent.complete` using a configured signed-in model and a bounded, injection-delimited projection of saved goal evidence; current conversation context is never attached |
| Revision/file locks | Serialized settings mutations plus goal-level optimistic revisions |
| Auto-continue and lifecycle hooks | Not available in the current PI-Desktop plugin API |
| Token accounting and budget stop | Budget retained as metadata; automatic accounting is not available |
| Network recovery and compaction hooks | Owned by PI-Desktop rather than the plugin |

The migration is a native adapter rather than a copy of the upstream TypeScript
modules: PI-Desktop loads self-contained CommonJS and isolated HTML, while the
upstream extension depends on Pi SDK lifecycle, TUI, session entries, and direct
Node filesystem access.
