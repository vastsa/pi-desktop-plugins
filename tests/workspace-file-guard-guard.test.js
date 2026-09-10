"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  classify,
  defaultProjectRoot,
  defaultShell,
  envAssignments,
  formatEnv,
  isRelativeTo,
  resolvePath,
  resolveToolRoot,
  systemDrive,
} = require("../plugins/pi.workspace-file-guard/guard");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const win = process.platform === "win32";
const home = os.homedir();
const project = win ? "D:\\example-project" : "/data/example-project";
const scratch = path.join(home, ".pi-desktop", "scratch", "session-1");
const systemTemp = os.tmpdir();
const osDrive = systemDrive();
const pluginCwd = fs.mkdtempSync(path.join(systemTemp, "pi-wfg-plugin-cwd-"));

const previousCwd = process.cwd();
process.chdir(pluginCwd);
try {
  const inside = classify(path.join(project, "src", "main.js"), project, { scratch });
  assert(inside.allowed, "project file should be allowed");
  assert(inside.reasons.includes("inside project root"), "expected inside-project reason");

  const relativeSrc = classify("src/a.js", project, { scratch });
  assert(relativeSrc.allowed, "relative src should be allowed against project root");
  assert(
    relativeSrc.path.toLowerCase() === path.join(project, "src", "a.js").toLowerCase(),
    `relative src resolved to ${relativeSrc.path}`
  );
  assert(
    !relativeSrc.path.toLowerCase().includes("plugins"),
    "relative src must not resolve into the plugin directory"
  );

  const relativeTmp = classify(".tmp/out/log.txt", project, { scratch });
  assert(relativeTmp.allowed, "relative .tmp should stay inside the project");

  const scratchFile = classify(path.join(scratch, "dump.txt"), project, { scratch });
  assert(scratchFile.allowed, "PI scratch should be allowed");

  const desktop = classify(path.join(home, "Desktop", "junk.txt"), project, { scratch });
  assert(!desktop.allowed, "Desktop junk should be forbidden");

  const relativeDesktop = classify(`..${path.sep}Desktop${path.sep}x.txt`, project, { scratch });
  assert(!relativeDesktop.allowed || isRelativeTo(relativeDesktop.path, project), "relative escape should not silently allow Desktop");
  if (!isRelativeTo(relativeDesktop.path, project)) {
    assert(!relativeDesktop.allowed, "path that leaves the project should be forbidden");
  }

  const downloads = classify(path.join(home, "Downloads", "out.bin"), project, { scratch });
  assert(!downloads.allowed, "Downloads junk should be forbidden");

  const tempFile = classify(path.join(systemTemp, "agent.log"), project, { scratch });
  assert(!tempFile.allowed, "OS temp should be forbidden");

  if (win && osDrive) {
    const sysTemp = classify(path.join(`${osDrive.toUpperCase()}\\Windows\\Temp`, "agent.log"), project, {
      scratch,
    });
    assert(!sysTemp.allowed, "Windows\\Temp on the system drive should be forbidden");
    assert(
      sysTemp.reasons.some((reason) => /system volume|junk path|different volume/i.test(reason)),
      `expected system-volume reason, got ${sysTemp.reasons.join("; ")}`
    );
  } else {
    const posixTemp = classify("/tmp/agent.log", project, { scratch });
    assert(!posixTemp.allowed, "/tmp should be forbidden on POSIX");
  }

  const plugins = classify(
    path.join(home, ".pi-desktop", "plugins", "pi.workspace-file-guard"),
    project,
    { scratch }
  );
  assert(!plugins.allowed, "plugin install without explicit request should be blocked");

  const pluginsExplicit = classify(
    path.join(home, ".pi-desktop", "plugins", "pi.workspace-file-guard"),
    project,
    { scratch, explicit: true }
  );
  assert(pluginsExplicit.allowed, "plugin install with explicit request should be allowed");

  assert(
    isRelativeTo(path.join(project, ".tmp", "out"), project),
    ".tmp inside project should count as relative"
  );
  assert(!isRelativeTo(systemTemp, project), "OS temp should not be relative to the project");

  const root = defaultProjectRoot({ workspace: project });
  assert(root.toLowerCase() === resolvePath(project).toLowerCase(), "workspace should win");

  const missingWorkspace = resolveToolRoot({});
  assert(!missingWorkspace.ok, "tools must fail closed without workspace");
  assert(
    !String(missingWorkspace.projectRoot || "").toLowerCase().includes("plugins"),
    "failed root must not fall back to plugin dir"
  );

  const withWorkspace = resolveToolRoot({ workspace: project });
  assert(withWorkspace.ok, "workspace should resolve");
  assert(withWorkspace.projectRoot.toLowerCase() === resolvePath(project).toLowerCase(), "workspace root mismatch");

  const env = envAssignments({ projectRoot: project, scratch });
  assert(env.TEMP === resolvePath(scratch), "TEMP should point at PI scratch");
  assert(String(env.PIP_CACHE_DIR).includes(".tmp"), "pip cache should stay in project .tmp");

  const spaced = envAssignments({
    projectRoot: win ? "D:\\My Project" : "/data/My Project",
    scratch: path.join(home, "scratch dir"),
  });
  const cmdScript = formatEnv(spaced, "cmd");
  assert(cmdScript.includes('set "TMP='), "cmd assignments must be quoted");
  assert(cmdScript.includes("scratch dir"), "cmd script should keep spaces inside quotes");

  assert(
    defaultShell() === (win ? "powershell" : "bash"),
    "default shell should follow the current OS"
  );

  const namedOther = classify(win ? "E:\\backup\\out.txt" : "/mnt/backup/out.txt", project, {
    scratch,
    explicit: true,
  });
  assert(namedOther.allowed, "user-named destination on another volume should be allowed");

  const namedDesktop = classify(path.join(home, "Desktop", "forced.txt"), project, {
    scratch,
    explicit: true,
  });
  assert(!namedDesktop.allowed, "Desktop stays forbidden even when explicit");

  const namedTemp = classify(path.join(systemTemp, "forced.log"), project, {
    scratch,
    explicit: true,
  });
  assert(!namedTemp.allowed, "OS temp stays forbidden even when explicit");

  const filesystemRoot = path.parse(project).root;
  const unsafeRoot = classify(path.join(home, "Downloads", "root-escape.txt"), filesystemRoot, {
    scratch,
  });
  assert(!unsafeRoot.allowed, "filesystem root must not be accepted as a project root");

  const relativeRoot = resolveToolRoot({ explicit: "." });
  assert(!relativeRoot.ok, "explicit project roots must be absolute");

  const unsafeScratch = classify(path.join(home, "Downloads", "scratch-escape.txt"), project, {
    scratch: filesystemRoot,
  });
  assert(!unsafeScratch.allowed, "unsafe scratch overrides must not broaden the allowed area");

  const symlinkBase = fs.mkdtempSync(path.join(systemTemp, "pi-wfg-symlink-"));
  try {
    const symlinkProject = path.join(symlinkBase, "project");
    const symlinkOutside = path.join(symlinkBase, "outside");
    fs.mkdirSync(symlinkProject);
    fs.mkdirSync(symlinkOutside);
    const link = path.join(symlinkProject, "link");
    let symlinkCreated = false;
    try {
      fs.symlinkSync(symlinkOutside, link, win ? "junction" : "dir");
      symlinkCreated = true;
    } catch {
      // Some Windows environments do not grant symlink creation to tests.
    }
    if (symlinkCreated) {
      const symlinkTarget = classify(path.join(link, "junk.txt"), symlinkProject, { scratch });
      assert(!symlinkTarget.allowed, "symlink targets must be rejected");
    }
  } finally {
    fs.rmSync(symlinkBase, { recursive: true, force: true });
  }

  if (process.platform === "darwin") {
    assert(!classify(path.join(home, "desktop", "lowercase.txt"), project, { scratch }).allowed, "macOS media paths are case-insensitive");
    assert(!classify("/private/etc/hosts", project, { scratch }).allowed, "macOS private system aliases must be blocked");
  }
  let missingRootThrew = false;
  try {
    defaultProjectRoot({});
  } catch {
    missingRootThrew = true;
  }
  assert(missingRootThrew, "defaultProjectRoot must not guess cwd");

  let cmdQuoteThrew = false;
  try {
    formatEnv({ TMP: 'C:\\say "hi"' }, "cmd");
  } catch (error) {
    cmdQuoteThrew = /double quotes/.test(String(error.message));
  }
  assert(cmdQuoteThrew, "cmd dialect must reject embedded quotes");

  const bashDangerous = "/tmp/$(touch pwned)/$HOME/`whoami`";
  const bashScript = formatEnv({ TMP: bashDangerous }, "bash");
  assert(
    bashScript === `export TMP='${bashDangerous}'\n`,
    "bash assignments must use literal-safe quoting"
  );

  const powershellDangerous = "C:/temp/$(whoami)/$env:PATH";
  const powershellScript = formatEnv({ TMP: powershellDangerous }, "powershell");
  assert(
    powershellScript === `$env:TMP = '${powershellDangerous}'\n`,
    "PowerShell assignments must use literal-safe quoting"
  );

  for (const value of ["C:/x/%PATH%", "C:/x/!PATH!", "C:/x/line\r\nnext"]) {
    let unsafeCmdThrew = false;
    try {
      formatEnv({ TMP: value }, "cmd");
    } catch (error) {
      unsafeCmdThrew = /cannot contain/.test(String(error.message));
    }
    assert(unsafeCmdThrew, "cmd assignments must reject expansion and control characters");
  }

  if (win) {
    const viaEnv = classify("%USERPROFILE%\\Downloads\\dump.bin", project, { scratch });
    assert(!viaEnv.allowed, "env-expanded Downloads should be forbidden");
  }

  console.log("ok");
} finally {
  process.chdir(previousCwd);
  fs.rmSync(pluginCwd, { recursive: true, force: true });
}
