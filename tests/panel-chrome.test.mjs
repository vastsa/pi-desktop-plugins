import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("every panel plugin documents the host-owned 46px chrome contract", () => {
  const pluginDirs = readdirSync(join(root, "plugins"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "shared")
    .map((entry) => entry.name);
  const panelPlugins = [];

  for (const pluginId of pluginDirs) {
    const pluginRoot = join(root, "plugins", pluginId);
    const manifest = JSON.parse(readFileSync(join(pluginRoot, "manifest.json"), "utf8"));
    if (!manifest.ui?.panel) continue;

    panelPlugins.push(pluginId);
    const panelPath = join(pluginRoot, manifest.ui.panel);
    const panelHtml = readFileSync(panelPath, "utf8");
    assert.match(
      panelHtml,
      /PI-Desktop owns exactly a transparent 46px drag band/,
      `${pluginId} must document the non-clickable host drag band`,
    );
    assert.match(
      panelHtml,
      /three-button window-control capsule/,
      `${pluginId} must document the host window-control capsule`,
    );
    assert.match(
      panelHtml,
      /var\(--pi-plugin-titlebar-height, 46px\)/,
      `${pluginId} must document the fixed/sticky offset contract`,
    );
  }

  assert.equal(panelPlugins.length, 10, "the official marketplace should cover all panel plugins");
});
