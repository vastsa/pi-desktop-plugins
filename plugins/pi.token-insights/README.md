# Token Insights

Every conversation you have had on this machine already wrote its token counts to
disk. Token Insights reads them back and turns them into a single themed window:
how much you have spent, on which models, in which projects, and at what hours of
the night.

Open it from the command palette — **Token Insights: Open**.

## What you get

- **The headline.** Total tokens for the selected window, the change versus the
  previous window of the same length, a sparkline of the daily trend, and a
  small context-aware line that celebrates sustained work without treating a
  quieter period as failure.
- **A 12-month activity heatmap.** One square per day, so a habit becomes visible
  as a shape. Hover any square for that day's count.
- **Model and project rankings.** Where the tokens actually went, with each row's
  share of the total.
- **Rhythm.** A 24-hour clock and a weekday strip that show when you work, plus
  your current and longest daily streak.
- **Input / output / cache reuse tiles.** Cache reuse is the share of prompt
  tokens served from cache rather than re-sent — the higher it is, the more of
  your context you got for free.
- **Estimated cost**, once you have entered prices. See below.

Three ranges are available in the title bar: **30D**, **1Y**, and **ALL**.

## Where the numbers come from

From your own session transcripts in the PI-Desktop data directory, and nowhere
else. Each assistant message records the token usage the provider reported for
it; Token Insights adds those up. The footer of the panel always states how many
session files were scanned.

Two consequences worth knowing:

- Sessions created before usage recording existed contribute nothing.
- These are **provider-reported counts, not your billing statement**, and not a
  statement of the balance left on any subscription. Treat cost as an estimate.

## Cost estimates and the price table

**No vendor prices ship with this plugin.** Prices change, they vary per account,
and a stale hard-coded number is worse than no number at all. So the plugin ships
empty and asks you once.

Click the price icon in the title bar. The drawer lists every model that appears
in your history. Fill in the price **per million tokens**, in whatever currency
you set at the top of the drawer:

| Field | Meaning |
|---|---|
| `input` | Fresh prompt tokens sent to the model |
| `output` | Tokens the model generated |
| `cacheRead` | Prompt tokens served from cache (usually much cheaper) |
| `cacheWrite` | Tokens written into the cache (often slightly dearer than input) |

You do not have to fill in all four, or all models. A model counts as priced once
it has at least one number.

Models you leave blank are **excluded from the total and labelled as unpriced** —
they are never silently counted as free. The estimated-spend tile shows `—` until
at least one model has a price.

The same values live in **Settings → Plugins → Token Insights → Price table** as
JSON, if you would rather paste them:

```json
{
  "claude-opus-5": { "input": 3, "output": 15, "cacheRead": 0.3, "cacheWrite": 3.75 },
  "some-local-model": { "input": 0, "output": 0 }
}
```

## Ask the agent

The plugin registers one agent tool, exposed as
`plugin_pi_token_insights_token_usage_summary`. Once the plugin is installed and
the tool is allowed, you can simply ask:

- "Which model cost me the most this month?"
- "How many tokens did I burn last week versus the week before?"
- "Which project is eating my budget?"
- "What time of day do I actually work?"

The tool takes `since` / `until` (an ISO date, or a shorthand like `7d`, `12w`,
`1y`), `groupBy` (`model`, `project`, `day`, `session`) and `limit`. It returns
both structured data and a short markdown summary, using the same price table as
the panel.

## Permissions

| Permission | Why it is needed |
|---|---|
| `usage.read` | Read aggregate token counts from local sessions. This is the whole plugin. |
| `ui.panel` | Open the dashboard window. |
| `agent.tool.register` | Expose `token_usage_summary` so the agent can answer usage questions. |

Nothing else is requested. In particular there is **no `net.fetch`**, so the
plugin cannot make a network request even if it wanted to — the panel's own
content-security policy sets `connect-src 'none'` on top of that.

## Privacy

`usage.read` returns counts and labels, never conversation content. Concretely,
the plugin can see:

- token counts per day, hour, weekday, model, project and session
- model ids and provider ids
- project names and paths, and session titles (to label the rankings)

It cannot see, and never requests, the text of any message, tool call, or file.
It writes nothing back to your sessions; the only thing it stores is your own
price table, in the plugin's own settings.

Everything stays on this machine.

## The window

The panel draws its own 46px title bar so that it matches PI-Desktop instead of
sitting inside a grey OS frame. The window buttons are still the real ones, drawn
by the system — the plugin has no way to control your window.

It follows the app's theme (switching live when you change it) and its language
(English and 简体中文).

`renderer/panel.css` is a **hand-kept mirror** of the PI-Desktop design system
(`docs/spec/04-ux/07-ui-design-system.md`): the same `--ds-*` semantic tokens,
type ramp, spacing and motion durations. Plugin panels load from `file://` in an
isolated window and cannot import the app's stylesheet, so the tokens are copied.
If the app's palette changes, that file is the one to update.

## Requirements

PI-Desktop **0.2.9** or newer — earlier versions do not provide the documented
`usage.read` API, so the plugin will refuse to install.
