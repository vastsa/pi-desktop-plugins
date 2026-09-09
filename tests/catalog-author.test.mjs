import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const catalog = JSON.parse(readFileSync(join(root, "catalog.json"), "utf8"));
const generator = readFileSync(join(root, "scripts", "rebuild_catalog.py"), "utf8");

test("marketplace catalog authors are strings the PI-Desktop host can parse", () => {
  assert.ok(Array.isArray(catalog.plugins) && catalog.plugins.length > 0);
  for (const plugin of catalog.plugins) {
    assert.equal(
      typeof plugin.author,
      "string",
      `${plugin.id} author must be a string, got ${JSON.stringify(plugin.author)}`,
    );
    assert.ok(plugin.author.trim(), `${plugin.id} author must not be blank`);
  }
});

test("catalog rebuild stringifies object authors instead of copying them", () => {
  assert.match(generator, /def catalog_author\(/);
  assert.match(generator, /catalog_author\(manifest\.get\("author"\)\)/);
});

test("unpublished plugins stay out of the marketplace catalog", () => {
  const ids = new Set(catalog.plugins.map((plugin) => plugin.id));
  assert.equal(ids.has("com.vastsa.voice-assistant"), false);
  assert.match(generator, /UNPUBLISHED_PLUGIN_IDS/);
  assert.match(generator, /com\.vastsa\.voice-assistant/);
});

