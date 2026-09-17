import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = path.join(root, "plugins", "io.github.akshayxkill.nexus-scenic-themes");
const manifestPath = path.join(pluginRoot, "manifest.json");

function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function read(file) { return fs.readFileSync(path.join(pluginRoot, file), "utf8"); }

test("manifest declares the four isolated scenic themes and host scenic destination", () => {
  const manifest = readJson(manifestPath);
  assert.equal(manifest.id, "io.github.akshayxkill.nexus-scenic-themes");
  assert.equal(manifest.version, "0.1.0");
  assert.equal(manifest.author, "Akshayxkill");
  assert.deepEqual(manifest.permissions, ["ui.theme", "ui.settings", "ui.window.appearance"]);
  assert.deepEqual(manifest.contributes.themes.map((theme) => theme.id), [
    "twilight-mountains", "alpine-light", "obsidian-horizon", "emerald-afterglow",
  ]);
  assert.deepEqual(manifest.contributes.themes.map((theme) => theme.base), ["dark", "light", "dark", "dark"]);
  for (const theme of manifest.contributes.themes) {
    assert.equal(theme.variables.length, 1);
    assert.deepEqual(theme.variables[0], {
      name: "--nexus-backdrop-blur", type: "length", unit: "px", min: 0, max: 20, default: 6,
    });
    assert.ok(theme.assets?.length === 1);
  }
  assert.equal(manifest.contributes.settingsDestinations, undefined);
  const destination = manifest.contributes.scenicThemes;
  assert.equal(destination.id, "nexus-scenic-themes");
  assert.equal(destination.icon, "palette");
  assert.equal(destination.label.en, "Nexus Scenic Themes");
  assert.equal(destination.label["zh-CN"], "Nexus 风景主题");
  assert.deepEqual(destination.themes.map((theme) => theme.themeId), [
    "twilight-mountains", "alpine-light", "obsidian-horizon", "emerald-afterglow",
  ]);
  for (const card of destination.themes) assert.match(card.previewAsset, /^assets\/.+\.png$/);
});

test("theme styles and bundled backdrop assets exist and stay scoped", () => {
  const manifest = readJson(manifestPath);
  for (const theme of manifest.contributes.themes) {
    assert.ok(fs.existsSync(path.join(pluginRoot, theme.path)));
    const css = read(theme.path);
    assert.match(css, new RegExp(`:root\\[data-theme=.*data-plugin-theme=\\"plugin:io\\.github\\.akshayxkill\\.nexus-scenic-themes:${theme.id}\\"`));
    assert.match(css, /url\("assets\//);
    assert.doesNotMatch(css, /https?:\/\//);
    assert.doesNotMatch(css, /(^|[,{])\s*(?:html|body|button|input|div|section)\b/);
    for (const asset of theme.assets) assert.ok(fs.existsSync(path.join(pluginRoot, asset)));
  }
});

test("the obsolete plugin Settings document is absent", () => {
  assert.equal(fs.existsSync(path.join(pluginRoot, "settings", "index.html")), false);
  assert.equal(fs.existsSync(path.join(pluginRoot, "settings", "settings.css")), false);
  assert.equal(fs.existsSync(path.join(pluginRoot, "settings", "settings.js")), false);
});

test("theme CSS uses the dynamic blur only on the scenic backdrop", () => {
  const manifest = readJson(manifestPath);
  for (const theme of manifest.contributes.themes) {
    const css = read(theme.path);
    const uses = css.match(/var\(--nexus-backdrop-blur(?:\s*,[^)]*)?\)/g) ?? [];
    assert.equal(uses.length, 1);
    assert.match(css, /\.app-scenic-backdrop\s*\{[^}]*filter:[^;}]*blur\(var\(--nexus-backdrop-blur(?:\s*,[^)]*)?\)/s);
    assert.match(css, /:is\(\.main-pane,\.chat-surface,\.route-page\)\s*\{\s*background:\s*transparent;/);
    assert.doesNotMatch(css, /(?:transcript|tool-row|code|dialog|menu)[^{]*\{[^}]*--nexus-backdrop-blur/);
  }
});

test("scenic settings keeps the host canvas open and gives surfaces to named tiles", () => {
  const manifest = readJson(manifestPath);
  for (const theme of manifest.contributes.themes) {
    const css = read(theme.path);
    assert.match(css, /\.settings-shell-full\s+\.settings-nav/);
    assert.match(css, /:is\(\.settings-shell,\.settings-shell-full,\.settings-content,\.settings-content-inner(?:,\.settings-titlebar)?\)\s*\{\s*background:\s*transparent\s*!important;/);
    assert.match(css, /\.settings-panel:has\(> \.settings-row\).*?background:\s*transparent;.*?overflow:\s*visible;/s);
    assert.match(css, /:is\(\.settings-row,\.shortcut-row,\.provider-row,\.model-provider-row,\.agent-capability-row/);
    assert.match(css, /\.projects-row-block\s*\{[^}]*background:\s*rgba\(/s);
    assert.match(css, /:is\(\.settings-search,\.field-input,\.field-select,\.field-textarea/);
    assert.doesNotMatch(css, /(^|[,{])\s*(?:html|body|button|input|div|section)\b/);
  }
});

test("scenic settings does not repaint the full app shell over its backdrop", () => {
  const manifest = readJson(manifestPath);
  for (const theme of manifest.contributes.themes) {
    const css = read(theme.path);
    assert.match(css, /\.app-shell\.settings-mode\s*\{\s*background:\s*transparent\s*!important;/);
    assert.match(css, /:is\([^)]*\.settings-content[^)]*\)\s*\{\s*background:\s*transparent\s*!important;/s);
    assert.doesNotMatch(css, /:is\(\.app-shell,\.chat-surface,\.route-page\)\s*\{\s*background:/);
  }
});

test("scenic themes own the full host canvas instead of an interior shell", () => {
  const manifest = readJson(manifestPath);
  for (const theme of manifest.contributes.themes) {
    const css = read(theme.path);
    assert.match(css, /:is\(body,#root,\.app-shell,\.app-shell\.settings-mode\)\s*\{\s*background:\s*transparent\s*!important;/);
    assert.match(css, /\.app-scenic-backdrop\s*\{[^}]*background:\s*url\(/s);
    assert.match(css, /:is\(\.settings-shell,\.settings-shell-full,\.settings-content,\.settings-content-inner,\.settings-titlebar\)\s*\{\s*background:\s*transparent\s*!important;/);
    assert.match(css, /\.settings-shell-full\s+\.settings-nav[^}]*background:/s);
  }
});
