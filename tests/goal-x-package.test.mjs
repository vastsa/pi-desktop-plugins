import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = join(root, "plugins", "pi.goal-x");
const manifest = JSON.parse(readFileSync(join(pluginRoot, "manifest.json"), "utf8"));
const main = require(join(pluginRoot, "main.js"));

test("Goal X package paths and PI-Desktop metadata are internally consistent", () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.id, "pi.goal-x");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.main, "main.js");
  assert.ok(manifest.i18n?.en?.name);
  assert.ok(manifest.i18n?.["zh-CN"]?.name);
  assert.ok(manifest.ui?.title?.en);
  assert.ok(manifest.ui?.title?.["zh-CN"]);

  const packagedPaths = [
    manifest.main,
    manifest.ui?.panel,
    ...(manifest.contributes?.views || []).map((view) => view.entry),
    ...(manifest.contributes?.skills || []),
    "README.md",
    "MIGRATION.md",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
  ].filter(Boolean);
  for (const relativePath of packagedPaths) {
    assert.equal(existsSync(join(pluginRoot, relativePath)), true, `missing package path: ${relativePath}`);
  }

  const declaredCommands = (manifest.contributes?.commands || []).map((command) => command.id);
  const runtimeCommands = main.__test.COMMAND_DEFINITIONS.map((command) => command.id);
  assert.deepEqual(declaredCommands, runtimeCommands);
  for (const commandId of declaredCommands) {
    assert.ok(manifest.activationEvents.includes(`onCommand:${commandId}`));
  }

  const declaredTools = (manifest.contributes?.agentTools || []).map((tool) => tool.name);
  const runtimeTools = main.__test.TOOL_DEFINITIONS.map((tool) => tool.name);
  assert.deepEqual(declaredTools, runtimeTools);
});

test("Goal X declares bounded capabilities and the v3 host chrome contract", () => {
  const permissions = new Set(manifest.permissions || []);
  for (const required of [
    "ui.panel",
    "ui.view",
    "agent.tool.register",
    "agent.prompt.inject",
    "models.list",
    "session.read",
    "agent.complete",
  ]) {
    assert.equal(permissions.has(required), true, `missing permission: ${required}`);
  }
  for (const forbiddenPrefix of ["fs.", "net.", "shell.", "clipboard."]) {
    assert.equal(
      [...permissions].some((permission) => permission.startsWith(forbiddenPrefix)),
      false,
      `unexpected permission family: ${forbiddenPrefix}`,
    );
  }

  const panel = readFileSync(join(pluginRoot, manifest.ui.panel), "utf8");
  const styles = readFileSync(join(pluginRoot, "renderer", "styles.css"), "utf8");
  assert.match(panel, /<meta\s+name="pi-plugin-chrome"\s+content="v3"\s*\/>/);
  assert.match(panel, /<link\s+rel="stylesheet"\s+href="\.\/styles\.css"\s*\/>/);
  assert.match(styles, /--titlebar:\s*var\(--pi-plugin-titlebar-height, 46px\)/);
  assert.match(styles, /\.chrome-bar\s*\{[\s\S]*height:\s*var\(--titlebar\)/);
  assert.match(styles, /\.chrome-bar\s*\{[\s\S]*padding:\s*0 104px 0 16px/);
  assert.match(styles, /-webkit-app-region:\s*drag/);
  assert.match(styles, /\.chrome-bar button\s*\{\s*-webkit-app-region:\s*no-drag/);
  assert.match(panel, /\.\/lucide\.min\.js/);
  assert.match(panel, /\.\/appearance-boot\.js/);
  assert.match(panel, /\.\/capsule-retint\.js/);
  assert.doesNotMatch(panel, /https?:\/\//i);
});
