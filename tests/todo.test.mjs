import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const pluginRoot = join(root, "plugins/pi.todo");

const manifest = JSON.parse(
  readFileSync(join(pluginRoot, "manifest.json"), "utf8"),
);
const mainSource = readFileSync(join(pluginRoot, "main.js"), "utf8");
const panelHtml = readFileSync(
  join(pluginRoot, "renderer/index.html"),
  "utf8",
);

test("manifest declares the expected identity, permissions and contributions", () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.id, "pi.todo");
  assert.equal(manifest.version, "0.6.5");
  assert.match(manifest.engines.piDesktop, /^>=/);
  assert.deepEqual(manifest.permissions, [
    "ui.panel",
    "notify",
    "background.service",
    "agent.tool.register",
  ]);
  assert.equal(typeof manifest.ui.title.en, "string");
  assert.equal(typeof manifest.ui.title["zh-CN"], "string");
  assert.ok(manifest.contributes.services, "declares a resident service");
  assert.equal(manifest.contributes.services[0].id, "due-reminder");
  assert.ok(
    manifest.contributes.agentTools.some((t) => t.name === "todo_manage"),
    "registers the todo_manage agent tool",
  );
});

test("background service keeps due reminders running while the panel is closed", () => {
  assert.match(mainSource, /pi\.services\.register\(\{[\s\S]*id: "due-reminder"/);
  assert.match(
    mainSource,
    /showNativeNotification\(\{ title, body/,
    "fires native notifications from the plugin process",
  );
  assert.match(
    mainSource,
    /saveTodos\(todos\); \/\/ 先写回再通知/,
    "persists reminded before notifying so restarts never re-remind",
  );
  assert.match(
    mainSource,
    /pi\.services\.unregister\("due-reminder"\)/,
    "unregisters the service on unload",
  );
  assert.match(panelHtml, /<meta\s+name="pi-plugin-chrome"\s+content="v3"\s*\/>/);
});