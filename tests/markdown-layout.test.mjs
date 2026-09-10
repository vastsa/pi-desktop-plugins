import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = join(root, "plugins", "pi.markdown");
const require = createRequire(import.meta.url);

const manifest = JSON.parse(readFileSync(join(pluginRoot, "manifest.json"), "utf8"));
const mainSource = readFileSync(join(pluginRoot, "main.js"), "utf8");
const panelHtml = readFileSync(join(pluginRoot, "renderer", "index.html"), "utf8");
const panelCss = readFileSync(join(pluginRoot, "renderer", "panel-polish.css"), "utf8");

// ---------------------------------------------------------------------------
// manifest
// ---------------------------------------------------------------------------

test("manifest declares the expected identity, permissions and contributions", () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.id, "pi.markdown");
  assert.equal(manifest.version, "0.5.0");
  assert.match(manifest.engines.piDesktop, /^>=/);
  assert.equal(manifest.main, "main.js");
  assert.equal(manifest.ui.panel, "renderer/index.html");
  assert.equal(manifest.ui.width, 1280);
  assert.equal(manifest.ui.height, 800);
  assert.equal(manifest.ui.title.en, "Pi Markdown");
  assert.equal(manifest.ui.title["zh-CN"], "Pi Markdown 笔记");
  assert.deepEqual(manifest.permissions, [
    "ui.panel",
    "agent.prompt.inject",
    "agent.tool.register",
  ]);
  assert.deepEqual(manifest.contributes.skills, ["skills/pi-markdown.md"]);

  const commandIds = manifest.contributes.commands.map((c) => c.id);
  assert.deepEqual(commandIds, ["pi-markdown.open"]);

  const toolNames = manifest.contributes.agentTools.map((t) => t.name);
  assert.deepEqual(toolNames, ["preview_file"]);
  assert.equal(manifest.contributes.agentTools[0].risk, "high");
  assert.deepEqual(manifest.contributes.agentTools[0].schema.required, ["path"]);

  // The preview tool reads through node fs, so the host fs gateway is not used.
  assert.ok(!JSON.stringify(manifest).includes('"fs.'), "no fs permissions requested");
  assert.equal(manifest.fs, undefined, "no fs gateway scopes declared");
  assert.ok(!JSON.stringify(manifest).includes('"net.'), "no network permission requested");
});

test("manifest documents the preview tool and drops the retired open_file tool", () => {
  // The changelog legitimately records the rename, so assert on the live surface.
  const liveSurface = JSON.stringify({
    description: manifest.description,
    i18n: manifest.i18n,
    agentTools: manifest.contributes.agentTools,
    permissions: manifest.permissions,
    fs: manifest.fs,
  });
  assert.ok(!liveSurface.includes("open_file"), "no live surface advertises open_file");
  const description = manifest.contributes.agentTools[0].description;
  assert.match(description, /只读预览|read-only preview/i);

  for (const locale of ["en", "zh-CN"]) {
    const block = manifest.i18n[locale];
    assert.ok(block, `i18n.${locale} present`);
    assert.equal(typeof block.name, "string");
    assert.equal(typeof block.description, "string");
    assert.equal(typeof block.safetyNotes, "string");
    assert.match(block.safetyNotes, /preview_file/);
    assert.match(block.safetyNotes, /fs|Node/i, "safety notes disclose direct disk reads");
  }
  // The claimed capability must match the code: no gateway language left behind.
  assert.ok(!liveSurface.includes("pi.fs"));
  assert.ok(!liveSurface.includes("目录选择器"));
});

// ---------------------------------------------------------------------------
// main.js
// ---------------------------------------------------------------------------

test("main.js registers exactly what the manifest declares", () => {
  for (const tool of manifest.contributes.agentTools) {
    assert.match(mainSource, new RegExp(`name: ${tool.name}|name: PREVIEW_TOOL_NAME`));
  }
  assert.match(mainSource, /PREVIEW_TOOL_NAME = "preview_file"/);
  assert.match(mainSource, /registerTool\(/);
  assert.match(mainSource, /unregisterTool\(PREVIEW_TOOL_NAME\)/, "onUnload unregisters the tool");
  assert.match(mainSource, /"pi-markdown\.open"/, "command registered");
  assert.match(mainSource, /normalizeChannel/, "unwraps skill.setEnabled id");

  for (const channel of ["file.pull", "file.save", "file.exit", "note.sync", "store.path"]) {
    assert.match(mainSource, new RegExp(`"${channel.replace(".", "\\.")}"`), `channel ${channel} handled`);
  }

  // The retired gateway path must be gone.
  assert.ok(!mainSource.includes("pi.fs.readText"));
  assert.ok(!mainSource.includes("pi.fs.writeText"));
  assert.ok(!mainSource.includes("requestDirectory"));
});

test("main.js reads and writes the previewed file through node fs", () => {
  assert.match(mainSource, /require\("fs"\)/);
  assert.match(mainSource, /fs\.promises\.readFile\(target, "utf8"\)/);
  assert.match(mainSource, /fs\.promises\.writeFile\(target, out, "utf8"\)/);
  // Guard rails that survive without the gateway.
  assert.match(mainSource, /EXTERNAL_EXTENSIONS = new Set\(\["\.md", "\.markdown", "\.txt"\]\)/);
  assert.match(mainSource, /MAX_EXTERNAL_BYTES = 5 \* 1024 \* 1024/);
  assert.match(mainSource, /NUL/, "rejects binary content");
  assert.match(mainSource, /hasBom/, "preserves the original BOM");
  assert.match(mainSource, /isAbsolutePath/, "requires an absolute path");
});

test("preview_file reads a real file, fills one slot, and writes edits back", async () => {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "pi-md-"));
  const file = join(dir, "demo.md");
  writeFileSync(file, "\ufeff# 标题\n\n正文 $x^2$\n", "utf8");

  const registered = [];
  let opened = 0;
  global.pi = {
    app: {
      getLocale: async () => "zh-CN",
      getAppearance: async () => ({ base: "light" }),
    },
    plugin: {
      getSettings: async () => ({}),
      setSettings: async () => undefined,
      getDataPath: async () => "C:/data",
    },
    commands: { register: async () => undefined, unregister: async () => undefined },
    agent: {
      registerTool: async (tool) => registered.push(tool),
      unregisterTool: async () => undefined,
    },
    ui: { openPanel: async () => { opened += 1; } },
    fs: {
      // The preview path must never fall back to the host gateway.
      readText: async () => { throw new Error("host fs gateway must not be used"); },
      writeText: async () => { throw new Error("host fs gateway must not be used"); },
    },
  };

  try {
    const mod = require(join(pluginRoot, "main.js"));
    await mod.onLoad();
    assert.deepEqual(registered.map((tool) => tool.name), ["preview_file"]);
    const tool = registered[0];

    // A non-text target is rejected before anything is read.
    writeFileSync(join(dir, "bin.png"), "x", "utf8");
    await assert.rejects(() => tool.execute({ path: join(dir, "bin.png") }), /不支持的文件类型/);
    await assert.rejects(() => tool.execute({ path: "relative.md" }), /绝对路径/);

    const result = await tool.execute({ path: file });
    assert.equal(result.ok, true);
    assert.equal(result.name, "demo.md");
    assert.equal(opened, 1, "the tool opens the panel");

    // The BOM is stripped for the editor…
    const pull1 = await mod.onPanelInvoke("file.pull", {});
    assert.equal(pull1.file.content, "# 标题\n\n正文 $x^2$\n");

    // …and restored on write-back.
    const saved = await mod.onPanelInvoke("file.save", {
      path: file,
      content: "# 改过的标题\n",
    });
    assert.equal(saved.ok, true);
    assert.equal(readFileSync(file, "utf8"), "\ufeff# 改过的标题\n");

    // Only one preview may occupy the slot at a time; a live session blocks a new one.
    await assert.rejects(() => tool.execute({ path: file }), /已有文件正在预览/);

    // Saving a different path than the active session is refused.
    const other = join(dir, "other.md");
    writeFileSync(other, "# other\n", "utf8");
    await assert.rejects(
      () => mod.onPanelInvoke("file.save", { path: other, content: "x" }),
      /保存路径与当前编辑的文件不一致/,
    );

    // Exiting frees the slot for the next call.
    assert.deepEqual(await mod.onPanelInvoke("file.exit", {}), { ok: true });
    assert.deepEqual(await mod.onPanelInvoke("file.exit", {}), { ok: true });
    const reopened = await tool.execute({ path: other });
    assert.equal(reopened.ok, true, "the slot is reusable after exit");
    await assert.rejects(() => mod.onPanelInvoke("nope.nope", {}), /unsupported panel channel/);

    await mod.onUnload();
  } finally {
    delete global.pi;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// panel
// ---------------------------------------------------------------------------

test("pi.markdown v3 paints through the host band without leaving a bottom gap", () => {
  assert.match(panelHtml, /meta name="pi-plugin-chrome" content="v3"/);
  assert.match(panelHtml, /var\(--pi-plugin-titlebar-height, 46px\)/);
  assert.match(
    panelCss,
    /#root\s*\{[^}]*height:\s*100%;/s,
    "the v3 root must fill the viewport after the bundled legacy height rule",
  );
  assert.match(
    panelCss,
    /\.editor-title-row\s*\{\s*padding-right:\s*116px;/s,
    "the title row must reserve room for the host window-control capsule",
  );
});

test("panel polish only targets selectors the panel actually renders", () => {
  // Comments name the removed selectors on purpose, so scan the rules only.
  const rules = panelCss.replace(/\/\*[\s\S]*?\*\//g, "");
  // These class names never existed in the React tree; keeping them meant dead CSS
  // that silently pretended to drive the layout.
  for (const dead of [
    ".sidebar-container",
    ".editor-pane",
    ".tab-button",
    ".sidebar-header",
    ".sidebar-tabs",
    "--c-sidebar-header",
  ]) {
    assert.ok(!rules.includes(dead), `${dead} is dead CSS and must not come back`);
  }
  assert.match(rules, /\.editor-title-row/, "the live title-row class is used");
  assert.match(rules, /\.pi-md-scroll/, "the live scroll-container class is used");
});

test("code blocks and formulas render as a single rounded container", () => {
  assert.match(
    panelCss,
    /\.milkdown \.milkdown-code-block\s*\{[^}]*border:\s*1px solid/s,
    "the code block owns exactly one border",
  );
  assert.match(
    panelCss,
    /\.milkdown \.milkdown-code-block pre,[\s\S]*?border:\s*none;/,
    "inner elements must not add a second border",
  );
  assert.ok(
    !/\.milkdown \.ProseMirror pre\s*\{[^}]*border:/s.test(panelCss),
    "the ProseMirror pre must not reintroduce an outer border",
  );
  assert.match(panelCss, /\.milkdown \.ProseMirror :not\(pre\) > code/, "inline code is styled separately");
});

test("legacy open_file UI affordances are gone from the panel bundle", () => {
  const appJs = readFileSync(join(pluginRoot, "renderer", "assets", "app.js"), "utf8");
  assert.ok(!appJs.includes("单文件模式"), "the edit-mode banner copy is removed");
  assert.ok(!appJs.includes("external.exit"), "the back-to-notes action is removed");
  // Preview mode keeps a single editable escape hatch.
  assert.match(appJs, /只读预览/, "the read-only preview badge is present");
});
