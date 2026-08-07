# Token Insights

A private dashboard for the tokens you spend on this machine. It reads the usage
metadata your tools already write locally, aggregates it, and shows you the
trend, the models, the rhythm, the streak — and nothing that isn't yours.

## What it shows

- **Hero** — total tokens in the selected window, the change against the
  previous window of equal length, your best day and your busiest hour.
- **Four counters** — input, output, cache read, reasoning.
- **Activity** — a 53-week heatmap; days outside the current filter stay dimmed
  so the window you picked is visible at a glance.
- **Models / Tools / Providers / Sessions** — rankings with share of total.
- **Rhythm** — hour-of-day and weekday distribution.
- **Streak and milestones** — current and longest streak, the last milestone you
  crossed and how far the next one is. Milestones are derived from your real
  cumulative curve, so every date shown is a date that happened.

## Filters

The filter bar composes freely, and the whole page — hero, counters, heatmap,
rhythm, every ranking and the footer — recomputes from the filtered set:

- time range: 7D / 30D / 90D / 1Y / ALL, or a custom from–to pair. The from/to
  fields always read out the window the current range covers, so switching to
  Custom starts from exactly what you were looking at
- tool source, model and provider (multi-select; the model list is searchable)
- free text over tool, model, provider, short session id or date

Active filters appear as removable chips, `Clear filters` restores everything,
and your selection is remembered the next time you open the panel. If a
combination matches nothing, the page says so and offers the way out instead of
showing a wall of zeros.

## Follows the app

The panel is its own window, so it cannot inherit the app's stylesheet. Instead
the plugin reads PI-Desktop's own appearance record and the panel mirrors it:

- light, dark, or **a theme contributed by another plugin** — the panel adopts
  that theme's `--ds-*` palette, including its accent
- the app's language (Simplified Chinese or English), including number and date
  formatting
- changes apply within a couple of seconds, with no need to reopen the panel
- the palette is cached locally, so reopening never flashes the wrong theme

If the appearance cannot be read (older runtime, moved data directory), the
panel follows your system colour scheme and the theme/language switches in its
own appearance menu — never a blank page.

## The agent tool

`token_usage_summary` answers from the same aggregation the dashboard renders,
so the two can never disagree. It accepts `since`, `until`, `groupBy`
(`model` / `provider` / `source` / `day` / `session`), `sources`, `models`,
`providers`, `query` and `limit`.

> which model cost me the most in the last 30 days?
> how many tokens did Codex use last week?

## Privacy

Everything is local and read-only:

| Read | Why |
| --- | --- |
| `~/.pi-desktop/sessions/*.jsonl` | assistant-reply usage counts |
| `~/.claude/projects`, `~/.codex/sessions`, `~/.local/share/opencode/storage/message` | the same, for those tools |
| `pi.sqlite` → `kv(ns='app')` | the app's theme and language |
| `pi.sqlite` → `providers(id, name)` | so a ranking shows `openlux`, not a UUID |
| `plugins/registry.json` + a theme plugin's CSS | to mirror an active plugin theme |

It never reads message text, tool arguments, project paths or credentials. Full
session ids are never kept — only an 8-character prefix, enough to tell two
sessions apart. The plugin writes nothing except its own settings, and makes no
network request. Requested permissions are `ui.panel` and `agent.tool.register`
only.

## Notes

- The four counters are summed from each tool's own fields. For some tools cache
  reads and reasoning are already counted inside input and output, so the four
  cards can add up to more than the total. The footer says so on screen.
- Token counts are what the tools recorded. They are not a statement about your
  remaining subscription balance.
- Opening the panel triggers a rescan in the background; the page renders the
  previous cube immediately and swaps in the fresh one when it lands. While a
  scan runs you see the real file count and a progress bar, not a spinner.
- The plugin also watches the source directories (heavily debounced, and never
  more than one scan per five minutes) so the numbers keep up on their own.
- A plugin panel is read-only by design — it cannot ask the plugin for a rescan —
  so the toolbar button says what it does: reload the latest data. For an
  immediate rescan run **Token Insights: Open** from the command palette.
- Motion respects `prefers-reduced-motion`: with it on, the count-up and the
  milestone pulse are gone and every number is still there.
