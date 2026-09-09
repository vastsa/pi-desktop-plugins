# Goal X for PI-Desktop

Goal X ports the durable goal-management workflow of
[`pi-goal-x`](https://github.com/tmonk/pi-goal-x) to PI-Desktop's sandboxed
plugin API. It keeps a separate goal pool for each workspace, lets the user or
Agent focus one goal, records a nested task plan and evidence, and can ask a
separate host-owned model completion to audit the result before archiving it.

The port is implemented against PI-Desktop's public plugin surface. It does
not load the original Pi extension or its SDK dependencies.

## Features

- Regular goals and Sisyphus mode (order is Agent guidance, not engine-enforced)
- Up to 32 open goals per workspace, with an explicit focus
- Nested tasks with stable ids, completion contracts, evidence, skip reasons,
  and atomic batch updates
- Active, paused, blocked, budget-limited metadata, complete, and archived
  lifecycle states
- Three-distinct-turn confirmation before an Agent can mark a repeated blocker
- Optimistic revisions so stale panels and audit results cannot overwrite
  newer goal state
- A bilingual panel and docked work-panel view with open and archived goals
- Five Agent tools matching the core `pi-goal-x` tool surface
- Optional independent completion audit using a signed-in PI-Desktop model
- Workspace-scoped persistence in the plugin's private settings

## Use

Open **Goal X** from the work panel or global search. The following exact slash
commands are also available:

| Command | Action |
| --- | --- |
| `/goal-x.open` | Open the dashboard |
| `/goal-x.new` | Open a regular-goal draft |
| `/goal-x.new-sisyphus` | Open an ordered-goal draft (Sisyphus mode) |
| `/goal-x.unfocus` | Clear the current workspace focus |
| `/goal-x.pause`, `/goal-x.resume` | Change the focused goal immediately |

PI-Desktop plugin commands currently receive no arguments. Use the panel, or
ask the Agent to create the goal in Agent mode.

### Agent tools

PI-Desktop namespaces plugin tools before exposing them to the model:

- `plugin_pi_goal_x_create_goal`
- `plugin_pi_goal_x_get_goal`
- `plugin_pi_goal_x_update_goal`
- `plugin_pi_goal_x_set_goal_tasks`
- `plugin_pi_goal_x_update_goal_task`

The bundled skill teaches the Agent when and how to use them. PI-Desktop hides
plugin tools and skills in Plan and built-in Goal discussion modes; they become
available after the session enters Agent mode.

Agent focus is scoped to the current session, while the dashboard keeps a
workspace display focus. An explicit create, focus, unfocus, resume, or restore
action in the dashboard invalidates older hidden session mappings; an older
Agent session must then pass `goal_id` explicitly instead of silently mutating
the goal it previously focused.

## Completion audits

When the completion auditor is enabled, `update_goal` with
`status: "complete"` starts a separate, tool-free model completion. The auditor
receives the goal, task statuses, verification contracts, evidence, the
executor's untrusted completion claim. It does not receive the current
conversation. It must return `<approved/>` before Goal X archives the goal.

The panel can also run an audit. A panel-started audit receives the saved goal
record and evidence but cannot read an arbitrary conversation. Configure the
auditor model and reasoning effort in the panel or generated plugin settings.
Leaving the model blank uses the executor model for Agent-tool audits and the
first authenticated model as a fallback.

Auditing uses `pi.agent.complete`, so it consumes the selected provider's quota.
PI-Desktop resolves credentials in the host; Goal X never receives API keys.

## Persistence and safety

The authoritative state is stored under the plugin-private `goalXState` setting
in PI-Desktop's data directory. Workspace paths are hashed for isolation; the
path and workspace label stay local in that private record. Goal X requests no
workspace file, network, shell, or clipboard permission.

| Permission | Why it is needed |
| --- | --- |
| `ui.panel` | Open the standalone dashboard |
| `ui.view` | Show the same dashboard in the work panel |
| `agent.tool.register` | Provide the five goal tools in Agent mode |
| `agent.prompt.inject` | Load the Goal X workflow skill on demand |
| `models.list` | Populate the auditor model picker and choose a fallback |
| `session.read` | Locally derive an opaque turn identifier from session/turn metadata so repeated blocker reports must come from distinct Agent turns; conversation text is not stored, hashed, or sent to the auditor |
| `agent.complete` | Run the independent completion audit |

The state root, each workspace, and every mutation are normalized before use.
Mutations are serialized, task batches commit atomically, and completion audits
re-check the goal revision before archiving. Goal X retains at most 32 workspace
records and refuses a write above 8 MiB rather than overwriting existing data;
only completely empty old workspace records are reclaimed automatically.

## PI-Desktop API limits

This migration intentionally does not claim two `pi-goal-x` behaviors that the
current PI-Desktop plugin API cannot implement:

- **Automatic continuation:** plugins cannot trigger a new Agent turn or hook
  every turn. Goal X persists progress, but the user starts the next turn.
- **Automatic token-budget enforcement:** plugin tools receive no cumulative
  session usage event. `token_budget` is retained as planning metadata, not a
  hard stop.

PI-Desktop also provides no generic confirmation dialog to plugin commands, so
destructive lifecycle actions such as archive remain panel actions rather than
single-keystroke commands.

## Develop and verify

Load this directory from **Plugins -> Load development plugin**. PI-Desktop
hot-reloads changes.

Run the portable unit tests:

```bash
node --test tests/*.test.mjs
```

From a PI-Desktop source checkout with dependencies installed, validate and
pack the exact artifact:

```bash
pnpm pi-plugin check /path/to/pi.goal-x
pnpm pi-plugin pack /path/to/pi.goal-x
```

The package is written to `dist/pi.goal-x-0.1.0.piplug`. Install that package
once before release to exercise the same permission review and packaging path
users receive.

## Upstream and migration notes

Goal X is inspired by `pi-goal-x` 0.31.2 at commit
`fe430b251eeaff4ff7c041085fd05458b2776cb9`. The upstream project and this port
are MIT licensed. Its Pi SDK/TUI integration, filesystem ledger, automatic turn
lifecycle, recovery hooks, interactive terminal questionnaires, and tool-using
auditor were replaced with PI-Desktop-native storage, panels, tools, and the
host-owned one-shot completion API.

See [MIGRATION.md](MIGRATION.md) for the capability map.

## License

Goal X is MIT licensed. See [LICENSE](LICENSE). The bundled Lucide icon subset
is ISC licensed; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
