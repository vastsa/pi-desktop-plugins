# Changelog — Deps Audit

## 0.1.0 — 2026-09-09

- Initial release.
- Scan the workspace root with `osv-scanner`; render the OSV database matches
  in the work panel, grouped by severity (Critical / High / Medium / Low /
  Unrated).
- View-side actions: trigger scan, select a finding, "copy to Agent" with a
  pre-built message that asks the Agent to first explain the risk, then
  propose the smallest possible upgrade.
- Agent tool: `deps_audit_run` (low risk) lets the Agent invoke a scan and
  receive a structured finding list.
- Settings: `scannerPath` (default `osv-scanner`), `severityMin` (default `low`).
- Local-only: the plugin makes no network calls of its own. The OSV database
  is fetched by `osv-scanner`.
- 17 unit tests cover parser (v1 / v2 / bare-array shapes, severity bucketing,
  fixed-version extraction) and scanner (binary resolution, manifest picking,
  spawn error paths).
