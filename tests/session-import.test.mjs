import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(here, "../plugins/io.github.muzimu217.session-import");
const manifest = JSON.parse(readFileSync(join(pluginRoot, "manifest.json"), "utf8"));

test("session import manifest declares the exact runtime permissions", () => {
  assert.equal(manifest.id, "io.github.muzimu217.session-import");
  assert.equal(manifest.version, "0.4.2");
  assert.deepEqual(manifest.permissions, [
    "ui.panel",
    "ui.view",
    "session.import",
    "session.read.own",
    "agent.complete",
    "models.list",
    "fs.write",
  ]);
  assert.deepEqual(
    manifest.contributes.sessionSources.map(({ id }) => id),
    ["zcode", "workbuddy", "claude-code", "codex", "opencode", "pi"],
  );
});
