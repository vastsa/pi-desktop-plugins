# Token Insights

Token Insights is an independent PI-Desktop plugin that scans local session
JSONL files in its own plugin process. It turns recorded token metadata into a
private dashboard with trends, categories, and a little encouragement for the
work that keeps adding up.

Open **Token Insights: Open** from the command palette. This command scans the
latest local transcripts, writes a de-identified snapshot to the plugin's own
settings, then opens the dashboard.

## What it shows

- Total token usage for 30 days, one year, or all recorded history.
- Input, output, cache-read, cache-write, and reasoning token totals.
- Model, provider, and short session-ID rankings.
- Daily activity, a 12-month heatmap, hourly and weekday rhythm.
- Current and longest streaks, plus period-over-period change.
- Gentle milestone copy that recognizes sustained work without treating a quiet
  day as a failure.

## Native local scan

The plugin finds the PI-Desktop `sessions` directory from its own data path and
parses every session `.jsonl` file line by line. Revision files are excluded.
Only assistant records with `meta.usage` are counted.

The scan keeps only these values in its dashboard snapshot:

- Usage counts and timestamps.
- Model and provider IDs.
- The first eight characters of the session filename ID.

It never stores or returns message blocks, message text, tool arguments,
project paths, full session titles, or a transcript copy. The plugin requests no
network permission and makes no network calls.

## Refresh behavior

The panel runs in an isolated renderer and can only read plugin settings. Its
refresh icon reloads the most recent snapshot. To perform a new scan, run
**Token Insights: Open** again; a background scan also runs after the plugin
loads so the panel has a recent snapshot when opened from the plugin manager.

## Limitations

- Only local PI-Desktop session transcripts are included.
- Historical assistant records without `meta.usage` do not contribute counts.
- Session JSONL files do not reliably contain project labels, so categories use
  models, providers, short session IDs, and time rather than project names.
- Token counts are provider-reported usage metadata, not a billing statement or
  subscription balance.

## Agent tool

`plugin_pi_token_insights_token_usage_summary` scans the same local metadata for
an on-demand report. It accepts optional `since`, `until`, `groupBy` (`model`,
`provider`, `day`, or `session`), and `limit` arguments. Dates can be ISO values
or short periods such as `7d`, `12w`, or `1y`.

## Permissions

| Permission | Purpose |
|---|---|
| `ui.panel` | Open the dashboard. |
| `agent.tool.register` | Register the on-demand summary tool. |

The plugin reads local files through the Node runtime bundled with the plugin;
it does not depend on PI-Desktop's unavailable `usage.read` API.

## Requirements

PI-Desktop **0.2.0** or newer.
