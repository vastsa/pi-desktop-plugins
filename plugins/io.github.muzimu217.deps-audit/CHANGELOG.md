# Changelog — Deps Audit

## 0.2.0 — 2026-09-12

Rework after the maintainer review (#20). Seven findings addressed:

- **Lifecycle (F1)**: `onLoad()` now reads the host API from
  `globalThis.pi` — the host builds the API as a global and invokes
  `onLoad()` with no argument, so the previous `onLoad(pi)` signature
  registered nothing on real loads. Regression-tested.
- **Workspace scoping (F3)**: panel scans resolve the active project via
  `pi.workspace.get()` and settings via `pi.plugin.getSettings()`; the old
  `process.cwd()` fallback (which audited the plugin's own directory) is
  gone — no open project now reports `invalid_workspace_root`.
- **Permission containment (F4)**: manifest files are read through the host
  fs gateway under a declared root-manifest `fs.read` scope, staged as
  sanitized copies in a throwaway temp directory, and osv-scanner runs
  against that directory only — the spawned binary never touches the
  workspace. Threat-model notes in README. Negative-path tests added
  (missing binary, corrupt binary, timeout, non-zero exit, parse failure,
  missing gateway).
- **Scanner CLI (F2)**: osv-scanner v2 invocation corrected to
  `scan source --format json --recursive <dir>` (was the invalid
  `scan source -L <file>` per-manifest form), verified against the real
  2.5.1 binary.
- **Clipboard (F5)**: the panel copies via the host `clipboard.write`
  bridge instead of `navigator.clipboard`.
- **Windows (F6)**: PATH lookup uses `where.exe` on Windows, `which`
  elsewhere; every PATH hit is exec-probed so a corrupt download earlier
  on the PATH fails cleanly instead of crashing the scan.
- **Panel chrome (F7)**: v3 chrome contract asserted by
  `tests/panel-chrome.test.mjs` (panel count updated).

The `deps_audit_run` agent tool is now declared `high` risk (native
execution + network), matching the SECURITY.md tier for what it actually
does.

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
