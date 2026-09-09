# Host API integration from the log viewer plugin

The host-side enhancements below now have a plugin-side integration. Both
follow the existing plugin design logic: a user gesture grants reach, the grant
is memory-only, the deny-list always wins, and every access is audited.

## 1. Byte-range file read — filed as vastsa/PI-Desktop#90

`fs.stat(path)` and `fs.readRange(path, byteOffset, length)` use exactly the
`fs.read` permission semantics. The plugin now uses these APIs for indexing,
pagination, search, and follow; it fails closed when the host does not expose
both methods.

## 2. Dropped-file grant (drag & drop into a plugin panel)

### Problem

A file dragged into a sandboxed plugin panel surfaces as a `File` object.
The panel cannot resolve it to a local path (the host preload does not expose
`webUtils.getPathForFile`), and a `File` object cannot be cloned across the
plugin bridge to the plugin process. Plugins must therefore read dropped
files inside the renderer (Web Worker + `Blob.slice`), which:

- duplicates the paging/indexing engine in the renderer;
- gives no file identity for persisted state (a `File` reference dies with
  the page); and
- cannot serve tail follow, because the snapshot never sees appends.

### Host contract

Two pieces, mirroring the `requestDirectory` model (§6.3 of the plugin
security spec — "the user just pointed at it"):

1. **Preload path resolution.** The host plugin-panel preload exposes:

   ```ts
   pluginBridge.getDroppedFilePath(file: File): string | null
   ```

   backed by `webUtils.getPathForFile` (available in preload, no Node
   integration leaked). Returns `null` for non-file drags. This alone
   changes nothing about permissions — a path string grants nothing.

2. **Host-owned drop grant.** A panel bridge channel:

   ```ts
   fs.registerDropped(path: string): Promise<{ grantId: string }>
   ```

   The host validates the path against the protected-path deny-list, then
   records a session-scoped grant allowing `fs.read`-mode APIs on that single
   file. The grant:

   - is created only from a real drop event (the host can gate the channel
     on renderer-initiated drop bookkeeping, or simply rely on the fact that
     only the panel itself knows a path for a file the user dragged);
   - lives in memory, dies with the plugin process, and is never persisted;
   - is refused for deny-listed paths regardless of what the user dragged;
   - is audited like every other fs access.

   `fs.stat` / `fs.readRange` accept an absolute path only when accompanied by
   the matching drop grant, so the plugin process streams dropped files with
   the same code path as picked files.

### Why this fits the plugin design logic

- **Gesture-bound:** reach comes from the user physically dragging a file
  into the plugin's own panel — the same trust event as picking a directory
  in `requestDirectory`.
- **Zero standing power:** one file, one session, gone on reload; nothing is
  added to `manifest.fs`.
- **Fail-closed:** deny-list wins over the gesture, matching the rule that a
  session grant "covers the containing directory" but never protected paths.
- **Auditable:** registration and every read go through the host gateway.

### Alternatives considered

- Renderer-side `Blob.slice` reading (the former v1 behavior): worked, but
  split the engine in two and lost file identity and tail follow.
- Exposing `File` objects over the bridge: structured clone cannot carry
  them through `contextBridge` cleanly, and the plugin process cannot read
  from a renderer-held blob without a proxy stream — more host machinery,
  not less.
- Telling users to put logs in a directory and use `requestDirectory`:
  reasonable fallback, but drag & drop is the interaction users expect for
  ad-hoc log inspection.
