import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const panelCss = readFileSync(
  join(root, "plugins/pi.markdown/renderer/panel-polish.css"),
  "utf8",
);
const panelHtml = readFileSync(
  join(root, "plugins/pi.markdown/renderer/index.html"),
  "utf8",
);

test("pi.markdown v3 paints through the host band without leaving a bottom gap", () => {
  assert.match(panelHtml, /meta name="pi-plugin-chrome" content="v3"/);
  assert.match(
    panelCss,
    /#root\s*\{[^}]*height:\s*100%;/s,
    "the v3 root must fill the viewport after the bundled legacy height rule",
  );
  assert.match(
    panelCss,
    /\.sidebar-container\s*\{[^}]*padding-top:\s*0;/s,
    "the sidebar must paint its first row through the host band",
  );
  assert.match(
    panelCss,
    /\.editor-pane > \.editor-title-row\s*\{[^}]*top:\s*0;/s,
    "the editor title row must paint through the host band",
  );
  assert.match(
    panelCss,
    /--pimd-sidebar-header-h:\s*43px/,
    "the sidebar header must retain its compact input rhythm",
  );
  assert.match(
    panelCss,
    /--pimd-title-row-h:\s*45px/,
    "the editor title row must retain its compact input rhythm",
  );
  assert.match(
    panelCss,
    /\.sidebar-container > \.sidebar-header\s*\{[^}]*padding-top:\s*8px;/s,
  );
  assert.match(
    panelCss,
    /\.editor-pane > \.editor-title-row\s*\{[^}]*padding-top:\s*8px;/s,
  );
});
