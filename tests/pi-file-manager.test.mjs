import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const pluginRoot = join(root, "plugins/pi.file-manager");

const manifest = JSON.parse(readFileSync(join(pluginRoot, "manifest.json"), "utf8"));
const mainRaw = readFileSync(join(pluginRoot, "main.js"), "utf8");
const viewHtml = readFileSync(join(pluginRoot, "views/index.html"), "utf8");

/**
 * Source with block and line comments removed, so structural assertions do not
 * trip over prose that explains why the gateway is bypassed.
 */
const mainSource = mainRaw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/**
 * Loads the plugin the way the host does: a CommonJS entry in a Node process
 * with a global `pi`. `workspace.get()` is pointed at a disposable project
 * root so the path guard and the write path can be exercised for real.
 */
function loadPlugin(workspacePath) {
  const require = createRequire(import.meta.url);
  const dataDir = mkdtempSync(join(tmpdir(), "pifm-data-"));
  let settings = {};
  global.pi = {
    plugin: {
      getId: () => "pi.file-manager",
      getManifest: () => manifest,
      getSettings: async () => ({ ...settings }),
      setSettings: async (partial) => {
        settings = { ...settings, ...partial };
      },
      getDataPath: async () => dataDir,
    },
    workspace: {
      get: async () => (workspacePath ? { path: workspacePath, name: "project" } : null),
    },
  };
  delete require.cache[require.resolve(join(pluginRoot, "main.js"))];
  const mod = require(join(pluginRoot, "main.js"));
  return { mod, invoke: (channel, payload) => mod.onPanelInvoke(channel, payload ?? {}), dataDir };
}

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), "pifm-proj-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "app.ts"), "const a = 1;\n");
  writeFileSync(join(dir, ".env"), "SECRET=1\n");
  writeFileSync(join(dir, "key.pem"), "-----BEGIN CERTIFICATE-----\n");
  mkdirSync(join(dir, ".git"));
  writeFileSync(join(dir, ".git", "config"), "[core]\n");
  return dir;
}

test("manifest declares the exact release identity and capabilities", () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.id, "pi.file-manager");
  assert.equal(manifest.version, "0.2.0");
  assert.equal(manifest.main, "main.js");
  assert.match(manifest.engines.piDesktop, /^>=0\.9\.0$/);
  // A work-panel view, not a detached panel: exactly one permission.
  assert.deepEqual(manifest.permissions, ["ui.view"]);
  assert.equal(manifest.ui, undefined, "declares no ui.panel entry");
  assert.deepEqual(manifest.contributes.views, [
    {
      id: "manager",
      title: { en: "File Manager", "zh-CN": "文件管理器" },
      icon: "folder",
      entry: "views/index.html",
      order: 40,
    },
  ]);
  assert.ok(manifest.i18n?.en?.name);
  assert.ok(manifest.i18n?.en?.description);
  assert.ok(manifest.i18n?.en?.safetyNotes);
  assert.ok(manifest.i18n?.["zh-CN"]?.name);
  assert.ok(manifest.i18n?.["zh-CN"]?.description);
  assert.ok(manifest.i18n?.["zh-CN"]?.safetyNotes);
});

test("the view entry is a file:// safe classic script", () => {
  // The host loads a docked view over file://, where Chromium blocks ESM and
  // crossorigin assets. A module script or a crossorigin link would blank the
  // pane, so both must stay absent, and the chrome marker must be declared.
  assert.match(viewHtml, /<meta\s+name="pi-plugin-chrome"\s+content="v2"\s*\/>/);
  assert.doesNotMatch(viewHtml, /type="module"/);
  assert.doesNotMatch(viewHtml, /crossorigin/);
  assert.match(viewHtml, /<script\s+src="\.\/assets\/index\.js"[^>]*><\/script>/);
});

test("only ui.view is declared, and the plugin never calls the pi.fs gateway", () => {
  // File access deliberately bypasses the host gateway (manifest.fs cannot
  // express a whole-tree write), so no fs permission may be claimed.
  assert.deepEqual(manifest.permissions, ["ui.view"]);
  assert.equal(manifest.fs, undefined, "declares no manifest.fs scope");
  assert.equal(manifest.net, undefined, "declares no egress allowlist");
  assert.doesNotMatch(mainSource, /pi\.fs\./);
});

test("path guard refuses escapes and credential paths", async (t) => {
  const project = makeProject();
  const { mod, invoke } = loadPlugin(project);
  t.after(() => {
    rmSync(project, { recursive: true, force: true });
    delete global.pi;
  });
  await mod.onLoad();

  for (const candidate of [
    "../outside.txt",
    "..\\..\\outside.txt",
    "src/../../outside.txt",
    "/etc/passwd",
    "C:\\Windows\\win.ini",
  ]) {
    const result = await invoke("fm.read", { path: candidate });
    assert.equal(result.ok, false, `absolute/traversal path must be refused: ${candidate}`);
  }

  for (const candidate of [".env", ".git/config", "key.pem"]) {
    const read = await invoke("fm.read", { path: candidate });
    assert.equal(read.ok, false, `credential path must not be readable: ${candidate}`);
    assert.equal(read.code, "DENIED_PATH");
    const write = await invoke("fm.write", { path: candidate, text: "x", eol: "lf", bom: false });
    assert.equal(write.ok, false, `credential path must not be writable: ${candidate}`);
  }

  // Listing hides credential paths but never hides the project's own files.
  const listed = await invoke("fm.list", { path: "" });
  const names = listed.entries.map((entry) => entry.name);
  assert.ok(!names.includes(".env"), "listing omits .env");
  assert.ok(!names.includes("key.pem"), "listing omits key.pem");
  assert.ok(!names.includes(".git"), "listing omits .git");
  assert.ok(names.includes("src"), "listing keeps ordinary directories");
});

test("a symlink that resolves outside the project root is refused", async (t) => {
  const project = makeProject();
  const outside = mkdtempSync(join(tmpdir(), "pifm-outside-"));
  writeFileSync(join(outside, "secret.txt"), "outside\n");
  const { mod, invoke } = loadPlugin(project);
  t.after(() => {
    rmSync(project, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    delete global.pi;
  });
  await mod.onLoad();

  try {
    symlinkSync(outside, join(project, "link-out"), "junction");
  } catch (error) {
    t.skip(`symlink creation unavailable: ${error.code ?? error.message}`);
    return;
  }

  const escaped = await invoke("fm.read", { path: "link-out/secret.txt" });
  assert.equal(escaped.ok, false, "must not read through an out-of-root symlink");
  assert.equal(escaped.code, "SYMLINK_ESCAPE");

  const listed = await invoke("fm.list", { path: "" });
  const link = listed.entries.find((entry) => entry.name === "link-out");
  assert.equal(link.isSymlink, true);
  assert.equal(link.isDirectory, false, "a symlinked directory is never expandable");
  assert.equal(link.outside, true);
});

test("writes are atomic and refuse to clobber an out-of-editor change", async (t) => {
  const project = makeProject();
  const { mod, invoke } = loadPlugin(project);
  t.after(() => {
    rmSync(project, { recursive: true, force: true });
    delete global.pi;
  });
  await mod.onLoad();

  const before = await invoke("fm.read", { path: "src/app.ts" });
  assert.equal(before.kind, "text");
  assert.equal(before.text, "const a = 1;\n");

  const saved = await invoke("fm.write", {
    path: "src/app.ts",
    text: "const a = 42;\n",
    expectedMtimeMs: before.mtimeMs,
    expectedSize: before.size,
    eol: "lf",
    bom: false,
  });
  assert.equal(saved.ok, true);
  assert.equal(readFileSync(join(project, "src", "app.ts"), "utf8"), "const a = 42;\n");
  // Atomic write means the temp file never survives a successful save.
  assert.deepEqual(
    readdirSync(join(project, "src")),
    ["app.ts"],
    "no temp-file residue after a successful write",
  );

  // The file changes underneath the editor: the next save must conflict
  // instead of silently overwriting, and must leave the disk untouched.
  writeFileSync(join(project, "src", "app.ts"), "const externally = 1;\n");
  const conflict = await invoke("fm.write", {
    path: "src/app.ts",
    text: "const fromEditor = 1;\n",
    expectedMtimeMs: before.mtimeMs,
    expectedSize: before.size,
    eol: "lf",
    bom: false,
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, "CONFLICT");
  assert.equal(
    readFileSync(join(project, "src", "app.ts"), "utf8"),
    "const externally = 1;\n",
    "a conflicting write must not touch the file",
  );
});

test("ignore rules hide entries only when a rule file exists", async (t) => {
  const project = makeProject();
  mkdirSync(join(project, "dist"));
  writeFileSync(join(project, "dist", "bundle.js"), "// built\n");
  const { mod, invoke } = loadPlugin(project);
  t.after(() => {
    rmSync(project, { recursive: true, force: true });
    delete global.pi;
  });
  await mod.onLoad();

  const withoutRules = await invoke("fm.list", { path: "" });
  assert.equal(withoutRules.ignoreActive, false);
  assert.ok(
    withoutRules.entries.some((entry) => entry.name === "dist"),
    "with no rule file nothing is filtered out",
  );

  writeFileSync(join(project, ".gitignore"), "dist/\n");
  const withRules = await invoke("fm.list", { path: "" });
  assert.equal(withRules.ignoreActive, true);
  assert.equal(
    withRules.entries.find((entry) => entry.name === "dist").ignored,
    true,
    "a .gitignore rule marks the entry as ignored",
  );
});

test("search paginates without dropping matches", async (t) => {
  const project = makeProject();
  for (let index = 0; index < 5; index += 1) {
    mkdirSync(join(project, "deep", "nested"), { recursive: true });
    writeFileSync(join(project, "deep", "nested", `hit-${index}.txt`), `${index}\n`);
  }
  const { mod, invoke } = loadPlugin(project);
  t.after(() => {
    rmSync(project, { recursive: true, force: true });
    delete global.pi;
  });
  await mod.onLoad();

  const found = [];
  let cursor = null;
  let rounds = 0;
  for (;;) {
    const page = await invoke("fm.search", { query: "hit-", cursor, limit: 2 });
    found.push(...page.matches.map((match) => match.path));
    cursor = page.nextCursor;
    rounds += 1;
    if (page.done || rounds > 20) break;
  }
  assert.equal(found.length, 5, "every match is returned across pages");
  assert.equal(new Set(found).size, 5, "no duplicate matches across pages");
  assert.ok(rounds >= 3, "the small limit actually forced pagination");
});

test("mutating channels refuse to run without an open project", async (t) => {
  const { mod, invoke } = loadPlugin(null);
  t.after(() => delete global.pi);
  await mod.onLoad();

  const hello = await invoke("fm.hello");
  assert.equal(hello.ok, true);
  assert.equal(hello.root, null);

  for (const [channel, payload] of [
    ["fm.list", { path: "" }],
    ["fm.read", { path: "a.txt" }],
    ["fm.create", { parent: "", name: "a.txt" }],
    ["fm.search", { query: "a" }],
  ]) {
    const result = await invoke(channel, payload);
    assert.equal(result.ok, false, `${channel} must fail without a workspace`);
    assert.equal(result.code, "NO_WORKSPACE");
  }
});

test("unknown channels answer UNSUPPORTED instead of throwing", async (t) => {
  const project = makeProject();
  const { mod, invoke } = loadPlugin(project);
  t.after(() => {
    rmSync(project, { recursive: true, force: true });
    delete global.pi;
  });
  await mod.onLoad();

  const result = await invoke("fm.does-not-exist");
  assert.equal(result.ok, false);
  assert.equal(result.code, "UNSUPPORTED");
});
