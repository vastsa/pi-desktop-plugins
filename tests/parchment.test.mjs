import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL("..", import.meta.url)));
const pluginRoot = join(root, "plugins", "pi.parchment");
const manifest = JSON.parse(readFileSync(join(pluginRoot, "manifest.json"), "utf8"));
const themeCss = readFileSync(
  join(pluginRoot, "themes", "parchment.css"),
  "utf8",
);

test("Parchment manifest declares the exact release identity and capabilities", () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.id, "pi.parchment");
  assert.equal(manifest.version, "1.0.1");
  assert.equal(manifest.main, "main.js");
  assert.equal(manifest.ui.panel, "renderer/index.html");
  assert.deepEqual(manifest.permissions, ["ui.panel", "ui.theme"]);
  assert.deepEqual(manifest.contributes.themes, [
    {
      id: "parchment",
      label: "Parchment",
      base: "light",
      path: "themes/parchment.css",
    },
  ]);
  assert.ok(manifest.i18n?.en?.safetyNotes);
  assert.ok(manifest.i18n?.["zh-CN"]?.safetyNotes);
});

test("Parchment code surfaces match the host light-theme specificity", () => {
  assert.match(
    themeCss,
    /:root\[data-theme="light"\]\s+\.code-block\s*\{[\s\S]*background:\s*#efe7d4/,
  );
  assert.match(
    themeCss,
    /:root\[data-theme="light"\]\s+\.prose-chat\s+pre\s*\{[\s\S]*background:\s*#efe7d4/,
  );
  assert.match(
    themeCss,
    /:root\[data-theme="light"\]\s+\.prose-chat\s+code\s*\{[\s\S]*background:\s*rgba\(42, 38, 32, 0\.07\)/,
  );
});
