import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pluginRoot = join(here, "../plugins/pi.terminal");
const shell = require("../plugins/pi.terminal/shell.js");
const { createPtyHost, DRAIN_LIMIT } = require("../plugins/pi.terminal/pty.js");
const env = require("../plugins/pi.terminal/env.js");
const manifest = JSON.parse(readFileSync(join(pluginRoot, "manifest.json"), "utf8"));
const mainSource = readFileSync(join(pluginRoot, "main.js"), "utf8");
const panelHtml = readFileSync(join(pluginRoot, "renderer/index.html"), "utf8");
const panelJs = readFileSync(join(pluginRoot, "renderer/terminal.js"), "utf8");
const panelCss = readFileSync(join(pluginRoot, "renderer/terminal.css"), "utf8");
const polish = readFileSync(join(pluginRoot, "renderer/panel-polish.css"), "utf8");

const FAKE_HELPER = `#!/usr/bin/env node
const readline = require("node:readline");
const sessions = new Set();
function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.type === "spawn") {
    sessions.add(msg.id);
    send({ type: "data", id: msg.id, data: Buffer.from("ready:" + msg.shell + ":" + (msg.argv0 || "") + "\\n").toString("base64") });
  } else if (msg.type === "write") {
    send({ type: "data", id: msg.id, data: msg.data });
  } else if (msg.type === "resize") {
    send({
      type: "data",
      id: msg.id,
      data: Buffer.from("resized:" + msg.cols + "x" + msg.rows + "\\n").toString("base64"),
    });
  } else if (msg.type === "kill") {
    send({ type: "exit", id: msg.id, code: 0 });
  }
});
`;

function waitFor(fn, timeoutMs = 1500) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const value = await fn();
        if (value) {
          resolve(value);
          return;
        }
      } catch (error) {
        if (Date.now() - started > timeoutMs) {
          reject(error);
          return;
        }
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error("timeout"));
        return;
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

test("manifest declares terminal identity, views, permissions and no agent tools", () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.id, "pi.terminal");
  assert.equal(manifest.version, "0.1.5");
  assert.equal(manifest.ui, undefined);
  assert.deepEqual(manifest.permissions, [
    "ui.view",
    "background.service",
    "clipboard.read",
    "clipboard.write",
    "agent.prompt.inject",
  ]);
  assert.equal(manifest.contributes.views[0].id, "shell");
  assert.equal(manifest.contributes.views[0].icon, "terminal");
  assert.equal(manifest.contributes.views[0].entry, "renderer/index.html");
  assert.equal(manifest.contributes.commands[0].id, "pi.terminal.open");
  assert.equal(manifest.contributes.services[0].id, "pty-host");
  assert.equal(manifest.contributes.skills[0], "skills/terminal.md");
  assert.equal(manifest.contributes.agentTools, undefined);
  assert.match(manifest.safetyNotes, /PTY|forkpty|ConPTY/);
  assert.match(manifest.engines.piDesktop, /^>=0\.8/);
  assert.doesNotMatch(mainSource, /openPanel\(/);
  assert.match(mainSource, /showToast/);
  assert.match(mainSource, /pty\.drain/);
  assert.match(mainSource, /pi\.services\.register/);
  assert.match(mainSource, /captureLoginEnv/);
  assert.match(mainSource, /loginArgv0/);
  assert.match(mainSource, /workspaceKey/);
  assert.match(mainSource, /host\.list\(\{ workspace: scope\.key \}\)/);
  assert.match(mainSource, /pty\.appearance/);
  assert.match(mainSource, /pi\.app\.getAppearance/);
  assert.match(mainSource, /COLORFGBG/);
});

test("docks in the work panel with v3 chrome and no detached window", () => {
  assert.match(panelHtml, /<meta\s+name="pi-plugin-chrome"\s+content="v3"\s*\/>/);
  assert.match(panelHtml, /contributes\.views/);
  assert.match(panelHtml, /--pi-plugin-titlebar-height/);
  assert.doesNotMatch(panelHtml, /capsule-retint/);
  assert.match(panelCss, /var\(--pi-plugin-titlebar-height, 0px\)/);
  assert.doesNotMatch(panelCss, /padding-right:\s*104px/);
  assert.doesNotMatch(panelCss, /body\.detached/);
  assert.match(panelCss, /data-theme="dark"/);
  assert.match(panelCss, /data-theme="light"/);
  assert.match(panelCss, /--term-bg/);
  assert.match(panelCss, /background-color:\s*var\(--term-bg\)/);
  assert.match(panelJs, /pty\.drain/);
  assert.match(panelJs, /function pullHostAppearance/);
  assert.match(panelJs, /pty\.appearance/);
  assert.match(panelJs, /MutationObserver/);
  assert.match(panelJs, /term\.refresh/);
  assert.match(panelJs, /clipboard\.writeText/);
  assert.match(panelJs, /Ctrl\+Shift\+C|ctrl && shift/);
  assert.match(panelJs, /profileItems = state\.profiles\.map/);
  assert.match(panelJs, /function syncWorkspace/);
  assert.match(panelJs, /function detachLocalTabs/);
  assert.doesNotMatch(panelJs, /isDetached|body\.classList\.add\("detached"\)/);
  assert.match(polish, /min-width:\s*0/);
});

test("helper binary names cover the six pack targets", () => {
  assert.equal(shell.helperFileName("darwin", "arm64"), "pi-pty-darwin-arm64");
  assert.equal(shell.helperFileName("darwin", "x64"), "pi-pty-darwin-x64");
  assert.equal(shell.helperFileName("linux", "arm64"), "pi-pty-linux-arm64");
  assert.equal(shell.helperFileName("linux", "amd64"), "pi-pty-linux-x64");
  assert.equal(shell.helperFileName("win32", "x64"), "pi-pty-win32-x64.exe");
  assert.equal(shell.helperFileName("win32", "arm64"), "pi-pty-win32-arm64.exe");
  assert.equal(shell.helperFileName("freebsd", "x64"), null);
  const vendor = join(pluginRoot, "vendor");
  for (const name of [
    "pi-pty-darwin-arm64",
    "pi-pty-darwin-x64",
    "pi-pty-linux-arm64",
    "pi-pty-linux-x64",
    "pi-pty-win32-arm64.exe",
    "pi-pty-win32-x64.exe",
  ]) {
    assert.equal(existsSync(join(vendor, name)), true, `missing ${name}`);
  }
});

test("default shells follow platform conventions", () => {
  const darwin = shell.resolveDefaultShell({ platform: "darwin", env: { SHELL: "/bin/zsh" } });
  assert.equal(darwin.shell, "/bin/zsh");
  assert.deepEqual(darwin.args, []);
  assert.equal(darwin.argv0, "-zsh");
  const darwinFallback = shell.resolveDefaultShell({ platform: "darwin", env: {} });
  assert.equal(darwinFallback.shell, "/bin/zsh");
  assert.deepEqual(darwinFallback.args, []);
  assert.equal(darwinFallback.argv0, "-zsh");
  const linux = shell.resolveDefaultShell({ platform: "linux", env: {} });
  assert.equal(linux.shell, "/bin/bash");
  assert.deepEqual(linux.args, []);
  assert.equal(linux.argv0, "-bash");
  const win = shell.resolveDefaultShell({
    platform: "win32",
    env: { SystemRoot: "C:\\Windows", PATH: "C:\\Windows\\System32", PATHEXT: ".EXE" },
    existsSync: (candidate) => String(candidate).toLowerCase().endsWith("powershell.exe"),
  });
  assert.match(win.shell, /powershell\.exe$/i);
  assert.deepEqual(win.args, ["-NoLogo"]);
  const profiles = shell.discoverBuiltinProfiles({
    platform: "win32",
    env: {
      ProgramFiles: "C:\\Program Files",
      PATH: "",
    },
    existsSync: (candidate) => String(candidate).includes("Git") && String(candidate).endsWith("bash.exe"),
  });
  assert.equal(profiles.some((profile) => profile.id === "git-bash"), true);
});

test("cwd must stay inside the workspace or home directory", () => {
  const home = "/Users/lan";
  const workspace = "/Users/lan/proj";
  const opts = { workspace, home, platform: "darwin" };
  assert.equal(shell.resolveAllowedCwd(null, opts), workspace);
  assert.equal(shell.resolveAllowedCwd("src", opts), join(workspace, "src"));
  assert.throws(() => shell.resolveAllowedCwd("/tmp/evil", opts), /workspace or home/);
  const user = shell.normalizeUserProfiles([
    { id: "dev", name: "Dev", shell: "/bin/zsh", args: ["-l"], cwd: workspace },
    { id: "bad" },
  ]);
  assert.equal(user.length, 1);
  const merged = shell.mergeProfiles([{ id: "default", shell: "/bin/zsh" }], user);
  assert.equal(merged.some((profile) => profile.id === "dev"), true);
  assert.equal(shell.workspaceKey("/Users/lan/proj/"), "/Users/lan/proj");
  assert.equal(shell.workspaceKey(null), "");
  assert.equal(shell.workspaceKey("  "), "");
});

test("pty host talks JSON lines with a fake helper", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-terminal-"));
  const helperPath = join(dir, "fake-helper.js");
  writeFileSync(helperPath, FAKE_HELPER);
  const host = createPtyHost({
    helperPath: process.execPath,
    spawn: (file, args, options) => spawn(file, [helperPath, ...args], options),
    homedir: dir,
    maxSessions: 2,
    drainLimit: DRAIN_LIMIT,
  });
  try {
    const spawned = await host.spawn({
      shell: "/bin/zsh",
      argv0: "-zsh",
      cwd: dir,
      workspace: dir,
    });
    assert.equal(spawned.ok, true);
    const ready = await waitFor(async () => {
      const chunk = await host.drain(spawned.session.id, { afterSeq: 0, waitMs: 50 });
      return chunk.data ? Buffer.from(chunk.data, "base64").toString("utf8") : "";
    });
    assert.match(ready, /ready:\/bin\/zsh:-zsh/);
    const seq = (await host.drain(spawned.session.id, { afterSeq: 0, waitMs: 0 })).seq;
    host.write(spawned.session.id, "echo hi");
    const echoed = await waitFor(async () => {
      const chunk = await host.drain(spawned.session.id, { afterSeq: seq, waitMs: 50 });
      return chunk.data ? Buffer.from(chunk.data, "base64").toString("utf8") : "";
    });
    assert.equal(echoed, "echo hi");
    host.resize(spawned.session.id, 120, 40);
    const listed = host.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].cols, 120);
    const second = await host.spawn({ shell: "/bin/bash", cwd: dir, workspace: dir });
    assert.equal(second.ok, true);
    const third = await host.spawn({ shell: "/bin/sh", cwd: dir, workspace: dir });
    assert.equal(third.ok, false);
    assert.match(third.error, /Maximum of 2/);
    await host.kill(spawned.session.id);
    const exit = await waitFor(async () => {
      const chunk = await host.drain(spawned.session.id, { afterSeq: 0, waitMs: 50 });
      return chunk.exited ? chunk : null;
    });
    assert.equal(exit.exited, true);
  } finally {
    await host.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sessions are isolated per workspace", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-terminal-ws-"));
  const alpha = join(dir, "alpha");
  const beta = join(dir, "beta");
  mkdirSync(alpha);
  mkdirSync(beta);
  const helperPath = join(dir, "fake-helper.js");
  writeFileSync(helperPath, FAKE_HELPER);
  const host = createPtyHost({
    helperPath: process.execPath,
    spawn: (file, args, options) => spawn(file, [helperPath, ...args], options),
    homedir: dir,
    maxSessions: 1,
    drainLimit: DRAIN_LIMIT,
  });
  try {
    const first = await host.spawn({ shell: "/bin/zsh", cwd: alpha, workspace: alpha });
    assert.equal(first.ok, true);
    const second = await host.spawn({ shell: "/bin/bash", cwd: beta, workspace: beta });
    assert.equal(second.ok, true, second.error);
    assert.equal(host.list().length, 2);
    const alphaKey = shell.workspaceKey(alpha);
    const betaKey = shell.workspaceKey(beta);
    assert.equal(host.list({ workspace: alphaKey }).length, 1);
    assert.equal(host.list({ workspace: betaKey }).length, 1);
    assert.equal(host.list({ workspace: alphaKey })[0].workspace, alphaKey);
    const overflow = await host.spawn({ shell: "/bin/sh", cwd: alpha, workspace: alpha });
    assert.equal(overflow.ok, false);
    assert.match(overflow.error, /Maximum of 1/);
    const crossed = host.write(first.session.id, "leak", { workspace: betaKey });
    assert.equal(crossed.ok, false);
    const owned = host.write(first.session.id, "ok", { workspace: alphaKey });
    assert.equal(owned.ok, true);
    const drainCross = await host.drain(first.session.id, { workspace: betaKey, waitMs: 0 });
    assert.equal(drainCross.ok, false);
  } finally {
    await host.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real helper can spawn a short command when the native binary exists", async (t) => {
  const helperPath = shell.helperPath(pluginRoot);
  if (!helperPath || !existsSync(helperPath)) {
    t.skip("native PTY helper is not built for this platform");
    return;
  }
  const home = homedir();
  const host = createPtyHost({ helperPath, homedir: home });
  try {
    const spawned = await host.spawn({
      shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
      args: process.platform === "win32" ? ["/c", "echo hello-pi-pty"] : ["-c", "printf hello-pi-pty; sleep 0.2"],
      cwd: home,
      workspace: home,
      cols: 80,
      rows: 24,
    });
    assert.equal(spawned.ok, true, spawned.error);
    const output = await waitFor(async () => {
      const chunk = await host.drain(spawned.session.id, { afterSeq: 0, waitMs: 80 });
      const text = chunk.data ? Buffer.from(chunk.data, "base64").toString("utf8") : "";
      return text.includes("hello-pi-pty") ? text : "";
    }, 4000);
    assert.match(output, /hello-pi-pty/);
  } finally {
    await host.stop();
  }
});

test("login env dump is parsed and PATH is augmented", async () => {
  const parsed = env.parseNulEnv("PATH=/usr/bin\0HOME=/tmp\0");
  assert.equal(parsed.PATH, "/usr/bin");
  assert.equal(parsed.HOME, "/tmp");
  assert.equal(env.loginArgv0("/bin/zsh", "darwin"), "-zsh");
  assert.equal(env.loginArgv0("/bin/bash", "linux"), "-bash");
  assert.equal(env.loginArgv0("pwsh.exe", "win32"), "");
  const stripped = env.stripGuiVars({
    ELECTRON_RUN_AS_NODE: "1",
    VSCODE_IPC_HOOK: "x",
    NODE_OPTIONS: "--require hijack",
    PATH: "/bin",
  });
  assert.equal(stripped.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(stripped.VSCODE_IPC_HOOK, undefined);
  assert.equal(stripped.NODE_OPTIONS, undefined);
  assert.equal(stripped.PATH, "/bin");

  const pathValue = env.augmentPath("/usr/bin:/bin", {
    platform: "darwin",
    home: "/Users/lan",
    existsSync: (candidate) =>
      candidate === "/opt/homebrew/bin" || candidate === "/usr/local/bin",
    readdirSync: () => [],
  });
  assert.match(pathValue, /^\/opt\/homebrew\/bin:/);
  assert.match(pathValue, /\/usr\/bin:\/bin$/);

  const nvmDirs = env.extraPathDirs({
    platform: "darwin",
    home: "/u",
    existsSync: (candidate) =>
      candidate === "/u/.nvm/versions/node" || candidate === "/u/.nvm/versions/node/v24.14.0/bin",
    readdirSync: (dir) => (String(dir).endsWith("node") ? ["v24.14.0"] : []),
  });
  assert.equal(nvmDirs.includes("/u/.nvm/versions/node/v24.14.0/bin"), true);

  const merged = env.mergeUserEnv(
    { PATH: "/custom/bin" },
    {
      platform: "darwin",
      home: "/Users/lan",
      processEnv: { ELECTRON_FOO: "1", USER: "lan", PATH: "/usr/bin" },
      existsSync: () => false,
      readdirSync: () => [],
    },
  );
  assert.equal(merged.TERM, "xterm-256color");
  assert.equal(merged.COLORTERM, "truecolor");
  assert.equal(merged.ELECTRON_FOO, undefined);
  assert.match(merged.PATH, /\/custom\/bin/);

  let unixCalls = 0;
  const dumped = await env.captureLoginEnv({
    platform: "darwin",
    home: "/Users/lan",
    processEnv: { PATH: "/usr/bin", USER: "lan", HOME: "/Users/lan" },
    existsSync: () => false,
    readdirSync: () => [],
    execFile: (_file, args, _opts, cb) => {
      unixCalls += 1;
      assert.equal(args[0], "-ilc");
      cb(null, `${env.START}PATH=/opt/homebrew/bin:/usr/bin\0HOME=/Users/lan\0${env.END}`);
    },
  });
  assert.equal(unixCalls, 1);
  assert.match(dumped.PATH, /\/opt\/homebrew\/bin/);
  assert.equal(dumped.TERM, "xterm-256color");

  let winCalls = 0;
  const win = await env.captureLoginEnv({
    platform: "win32",
    home: "C:\\Users\\lan",
    processEnv: { Path: "C:\\Windows", USERNAME: "lan" },
    existsSync: () => false,
    execFile: (_file, _args, _opts, cb) => {
      winCalls += 1;
      cb(new Error("should not run"));
    },
  });
  assert.equal(winCalls, 0);
  assert.equal(win.TERM, "xterm-256color");
});

test("flattens host appearance for the renderer adapter", () => {
  const { appearanceBase, flattenAppearance, colorFgBg } = require("../plugins/pi.terminal/main.js").__test;
  assert.equal(appearanceBase({ base: "dark" }), "dark");
  assert.equal(appearanceBase({ theme: "light" }), "light");
  assert.equal(colorFgBg({ base: "light" }), "0;15");
  assert.equal(colorFgBg({ base: "dark" }), "15;0");
  const flat = flattenAppearance(
    {
      theme: "plugin:x:y",
      base: "dark",
      locale: "zh-CN",
      pluginTheme: { id: "x", css: "body{}" },
    },
    "en",
  );
  assert.equal(flat.pluginThemeCss, "body{}");
  assert.equal(flat.locale, "zh-CN");
  const appearanceJs = readFileSync(join(pluginRoot, "renderer/appearance.js"), "utf8");
  const appearanceBoot = readFileSync(join(pluginRoot, "renderer/appearance-boot.js"), "utf8");
  assert.match(appearanceJs, /POLL_MS/);
  assert.match(appearanceJs, /startPoll/);
  assert.match(appearanceJs, /explicitBase/);
  assert.match(appearanceJs, /Do not snap to the OS/);
  assert.doesNotMatch(appearanceBoot, /prefers-color-scheme/);
  assert.equal(colorFgBg(null), "15;0");
});
