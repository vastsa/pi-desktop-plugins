import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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
      /<meta\s+name="pi-plugin-chrome"\s+content="v3"\s*\/>/,
      `${pluginId} must opt into v3 paint-through chrome`,
    );
    assert.match(
      panelHtml,
      /PI-Desktop owns exactly (?:a transparent 46px drag band|a 46px drag band)/,
      `${pluginId} must document the host-owned 46px drag band`,
    );
    assert.match(
      panelHtml,
      /three-button[\s\S]*window-control capsule/,
      `${pluginId} must document the host window-control capsule`,
    );
    assert.match(
      panelHtml,
      /var\(--pi-plugin-titlebar-height, 46px\)/,
      `${pluginId} must document the fixed/sticky offset contract`,
    );
  }

  assert.equal(panelPlugins.length, 12, "the official marketplace should cover all panel plugins");
});

test("super domain keeps its v3 surface full-bleed and interactive", () => {
  const pluginRoot = join(root, "plugins", "pi.super-domain-man", "renderer");
  const panel = readFileSync(join(pluginRoot, "index.html"), "utf8");
  const polish = readFileSync(join(pluginRoot, "panel-polish.css"), "utf8");
  const boot = readFileSync(join(pluginRoot, "style-boot.js"), "utf8");

  assert.match(panel, /<link\s+rel="stylesheet"\s+href="\.\/panel-polish\.css"/);
  assert.match(panel, /pi-plugin-panel-page-background/);
  assert.match(panel, /attributeFilter:\s*\["data-theme"\]/);
  assert.match(polish, /body\s*\{[\s\S]*background:\s*var\(--bg\)\s*!important/);
  assert.match(polish, /#root\s*\{\s*background:\s*var\(--bg\)\s*!important/);
  assert.match(polish, /#root\s*>\s*\.flex\.h-screen[\s\S]*height:\s*100%\s*!important/);
  assert.match(polish, /#root\s+aside\[class\*="w-\["\][\s\S]*top:\s*0\s*!important/);
  assert.match(polish, /#root\s+main\[class\*="ml-\["\][\s\S]*height:\s*100%\s*!important/);
  assert.match(polish, /#root\s+main\[class\*="ml-\["\]\s*>\s*div[\s\S]*width:\s*100%\s*!important/);
  assert.match(polish, /max-width:\s*none\s*!important/);
  assert.match(boot, /data-pi-plugin-no-drag/);
  assert.match(boot, /MutationObserver/);
});

test("remaining v3 panels reserve the capsule and expose a full page surface", () => {
  const cases = [
    ["pi.bianqian", /background:\s*rgb\(var\(--paper\)\)\s*!important/],
    ["pi.clipboard-history", /padding:\s*7px\s+max\(116px/],
    ["pi.gitlens", /\.view\s*>\s*\.toolbar:first-child\s*\{\s*padding-right:\s*104px/],
    ["pi.scratch-calc", /max-width:\s*none\s*!important/],
    ["pi.todo", /max-width:\s*none\s*!important/],
    ["pi.token-insights", /\.titlebar\s*\{\s*padding-right:\s*116px\s*!important/],
  ];

  for (const [pluginId, surfacePattern] of cases) {
    const renderer = join(root, "plugins", pluginId, "renderer");
    const panel = readFileSync(join(renderer, "index.html"), "utf8");
    const polishPath = join(renderer, "panel-polish.css");
    const polish = readFileSync(existsSync(polishPath) ? polishPath : join(renderer, "index.html"), "utf8");
    const retint = readFileSync(join(renderer, "capsule-retint.js"), "utf8");

    assert.match(panel, /capsule-retint\.js/, `${pluginId} must load capsule retinting`);
    assert.match(polish, surfacePattern, `${pluginId} must keep its v3 surface aligned`);
    assert.match(retint, /--pi-plugin-panel-page-background/);
    assert.match(retint, /MutationObserver/);
  }
});

test("demo panels use a full-height responsive surface", () => {
  const cases = [
    ["demo.hello", /\.card\s*\{[\s\S]*flex:\s*1 1 auto/],
    ["demo.workspace-notes", /body\s*\{[\s\S]*display:\s*flex[\s\S]*gap:\s*12px/],
    ["demo.workspace-summary", /pre\s*\{[\s\S]*max-height:\s*none\s*!important[\s\S]*overflow:\s*auto/],
  ];

  for (const [pluginId, surfacePattern] of cases) {
    const renderer = join(root, "plugins", pluginId, "renderer");
    const panel = readFileSync(join(renderer, "index.html"), "utf8");
    const polish = readFileSync(join(renderer, "panel-polish.css"), "utf8");
    const retint = readFileSync(join(renderer, "capsule-retint.js"), "utf8");

    assert.match(panel, /capsule-retint\.js/, `${pluginId} must load capsule retinting`);
    assert.match(polish, /html, body\s*\{[\s\S]*height:\s*100%/, `${pluginId} must fill the viewport`);
    assert.match(polish, surfacePattern, `${pluginId} must keep its content surface responsive`);
    assert.match(retint, /--pi-plugin-panel-page-background/);
    assert.match(retint, /MutationObserver/);
  }
});
