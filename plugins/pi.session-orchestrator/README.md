# Session Orchestrator

Session Orchestrator is the official PI-Desktop plugin for coordinating real
durable worker sessions from the current Agent.

## Agent Tool

The plugin registers one high-risk tool, `SessionTask`, with these actions:

- `spawn(task, title?, model?)` creates a new durable session and immediately
  starts its Agent.
- `send(workerId, message)` continues the same durable worker session.
- `status(workerIds?)` reads bounded live status.
- `wait(workerIds)` polls at low frequency with a 100-second timeout and
  returns bounded terminal records.
- `result(workerId)` returns only the worker's final report when available.
- `cancel(workerId)` aborts the active Agent and retains the session.
- `list()` lists workers created by the current Parent Session.

The intended flow is to call `spawn` several times without awaiting each
result, then call `wait` once with all worker ids and summarize the returned
reports in the Parent. The plugin does not copy a worker transcript into the
Parent context.

## Safety and boundaries

- Every worker is created with reviewed `desktop.control` operations:
  `session/get`, `session/create`, `agent/prompt`,
  `agent/getStatus`, and `agent/abort`.
- The create request carries `inheritPermissionFromSessionId`. The host binds
  that id to the current Agent tool session and returns the inherited
  permission mode before the worker is prompted. If an older host ignores that
  field for a Parent with an explicit permission mode, the plugin fails closed
  and records the unprompted worker as failed.
- Workers inherit the Parent project, provider/model, and thinking level. An
  explicitly requested model must be present in the host's public
  `models.list` result.
- Parent/worker relationships are stored in the plugin's private settings as
  bounded `workers` records. They are restored after plugin or app restart;
  the durable worker transcript remains in PI-Desktop's normal session store.
- A Parent can control only worker ids recorded under that Parent. A worker
  cannot create or control another worker. The limits are four active workers
  per Parent, sixteen active workers across the plugin, and sixteen workers
  per wait call.
- `cancel` uses `agent/abort` and never deletes a durable session.
- No localhost MCP HTTP calls, MCP bearer tokens, network access, transcript
  copying, session forks, session deletion, message bus, or second session
  database are used.
- The tool is high-risk and remains subject to PI-Desktop's normal tool policy.
  The plugin does not set `confirm` or bypass native permission confirmation.

## Capability matrix

| Surface | Data read or written | Boundary and user confirmation |
| --- | --- | --- |
| `desktop.control` | Parent/session metadata, worker creation, Agent status, prompts and aborts | Only reviewed catalog operations are reachable; the install grant and the host's normal Agent policy remain in force. The plugin never invokes dangerous `session/delete` or `session/configure`. |
| `models.list` | Public provider/model identifiers only | No credentials or transcript content are returned. An explicit `model` must match this list. |
| `ui.panel` | Plugin-owned worker summaries | The panel uses `pluginBridge`, escapes untrusted labels/tasks, and only exposes Stop/Open actions for persisted worker ids. |
| Plugin settings | `parentSessionId`, `workerSessionId`, task, status, timestamps and bounded final report | Stored in the plugin-private settings namespace; worker transcript content is never copied into it. |

The high-risk desktop surface is intentionally narrow: `spawn`, `send`,
`status`, `wait`, `result`, `cancel` and `list` are the only operations exposed
by `SessionTask`.

## Agents panel

The isolated Agents panel restores the persisted worker list, refreshes status,
and offers Open Session and Stop actions. Open Session uses the optional
reviewed `session/open` host operation; on an older host the panel reports a
clear unsupported error and leaves the worker available in the normal session
list.

## Host compatibility

Version 0.1.0 targets PI-Desktop hosts that expose the reviewed
`desktop.control` catalog and the additive
`inheritPermissionFromSessionId` / `session/open` host capabilities. The
plugin still uses only the stable SDK gateway, so no MCP token or private
Electron channel is required.

The corresponding PI-Desktop host change is additive: it adds the reviewed
`session/open` navigation operation, carries a `source: "plugin"` marker so
background worker prompts do not steal the Parent view, and lets
`session/create` resolve the parent's persisted permission mode atomically.
It does not add a Session database schema, change the existing Task/Subagent
runtime, or introduce a second session system.
