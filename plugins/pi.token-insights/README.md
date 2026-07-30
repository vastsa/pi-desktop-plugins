# Token Insights

Token Insights is an independent, local-only dashboard for usage metadata from
supported AI tools. It scans known on-device transcript locations and turns
recorded token counts into trends, categories, rhythm, and encouraging streaks.

Open **Token Insights: Open** from the command palette. It performs a fresh
scan, stores a de-identified dashboard snapshot in the plugin's settings, then
opens the panel.

## Supported local sources

| Tool | Local location | Counted metadata |
|---|---|---|
| PI-Desktop | Its `sessions/*.jsonl` directory | `meta.usage` on assistant records |
| Claude Code | `~/.claude/projects/**/*.jsonl` | `message.usage` on assistant records |
| Codex | `~/.codex/sessions/**/*.jsonl` | Incremental `last_token_usage` records |
| OpenCode | `~/.local/share/opencode/storage/message/**/*.json` | Completed assistant `tokens` records |

Only tools that persist per-response token metadata can be counted accurately.
Web applications or local tools without compatible usage records remain absent
rather than receiving guessed totals.

## Categories and privacy

The dashboard groups usage by tool source, model, provider, short session ID,
date, hour, and weekday. It supports 30 days, one year, and all-time windows.

The scanner parses records only to extract timestamps and token metadata. Its
snapshot retains only aggregated token counts, model/provider IDs, tool source,
and the first eight characters of each session ID. It does not retain or expose
message text, message blocks, tool arguments, project paths, full session IDs,
or full session titles. No data is uploaded and the plugin has no network
permission.

To prevent double counting, PI-Desktop sessions imported from Claude Code or
Codex are skipped when the original source is scanned. Codex uses only
`last_token_usage`, never its cumulative `total_token_usage` field.

## Language and color mode

The panel follows PI-Desktop automatically:

- Simplified Chinese is the default when the host locale is unavailable; English
  and Simplified Chinese text otherwise update live with the application locale.
- Light and dark palettes update live with the application color mode.
- The dashboard also honors the operating system's reduced-motion preference.

The streak, milestone, and quieter-day copy is part of both languages and both
color modes; changing appearance never changes the underlying totals.

The overview uses four number cards: input, output, cache-read, and reasoning
tokens. Each card also shows its share of the selected period total.

## Refresh behavior

The isolated panel can read only the latest plugin snapshot. Its refresh icon
reloads that snapshot. Run **Token Insights: Open** for a new multi-tool scan;
a background scan also runs after plugin load.

## Agent tool

`plugin_pi_token_insights_token_usage_summary` performs an on-demand scan. It
accepts optional `since`, `until`, `groupBy` (`source`, `model`, `provider`,
`day`, or `session`), and `limit` arguments. Dates can be ISO values or short
periods such as `7d`, `12w`, or `1y`.

## Permissions

| Permission | Purpose |
|---|---|
| `ui.panel` | Open the dashboard. |
| `agent.tool.register` | Register the on-demand summary tool. |

The scanner uses the plugin's bundled Node runtime to read supported local data
paths; it does not depend on a PI-Desktop host usage API.

## Requirements

PI-Desktop **0.2.0** or newer.
