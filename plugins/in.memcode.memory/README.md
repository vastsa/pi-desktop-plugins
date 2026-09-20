# Memcode Memory

Adds explicit Memcode long-term-memory tools to PI-Desktop agents. The plugin
uses Memcode's personal v2 API, so the API credential determines the user; no
user ID or integration attribution is accepted from agent arguments.

## Setup

Set the credential in the environment that starts PI-Desktop, then restart the
app:

```bash
export MEMCODE_API_KEY=your_memcode_api_key
```

The plugin never persists this value in PI-Desktop settings. Start with
`memcode_test_connection`, then explicitly approve memory writes when PI asks.

## Tools

| Tool | Risk | Operation |
| --- | --- | --- |
| `memcode_test_connection` | Medium | `GET /v2/test`; validates the configured credential without reading memory |
| `memcode_save_memory` | High | `POST /v2/memory/ingest`; persists user-approved text and returns an asynchronous job receipt |
| `memcode_search_memories` | Medium | `POST /v2/memory/search`; searches the authenticated user's memory/chunk index |
| `memcode_retrieve_answer` | Medium | `POST /v2/memory/retrieve`; returns a grounded answer and source records |

PI-Desktop exposes these under its normal plugin-prefixed tool names.

## Capability and data-flow review

| Entry point | Data read | Destination | Permission | Confirmation/bounds | Cleanup |
| --- | --- | --- | --- | --- | --- |
| All tools | `MEMCODE_API_KEY` and tool arguments | `https://memory.memcode.in` only | `net.fetch` | PI install grant; 20s timeout; 256 KiB response cap; no redirects outside allowlist | No background task or retained token |
| Save tool | User-approved text and optional assistant response | `/v2/memory/ingest` | `agent.tool.register`, `net.fetch` | High-risk agent-tool approval; 20,000-character fields | Durable data follows the user's Memcode retention settings |
| Search/retrieve | Query and bounded numeric options | `/v2/memory/search`, `/v2/memory/retrieve` | `agent.tool.register`, `net.fetch` | Medium-risk tool policy; query and result bounds | No plugin-local cache |

The plugin has no third-party runtime dependencies, native code, dynamic code,
filesystem access, telemetry, retries, timers, or background services. It does
not send client-provided attribution headers or metadata; Memcode assigns any
integration attribution server-side.

## Failure behavior

- Missing or malformed credentials fail before the network call.
- HTTP errors expose only the status (and bounded `Retry-After` for 429), not
  response bodies that could contain sensitive details.
- Malformed or oversized JSON responses are rejected.
- The plugin never retries a write automatically.
- Unload unregisters every tool, including after a partially failed load.

Deleting memories is intentionally outside this first version because
PI-Desktop agent tools must not perform destructive remote actions without a
separate, explicit design and confirmation path.
