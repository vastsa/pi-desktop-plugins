"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function helperFileName(platform = process.platform, arch = process.arch) {
  const cpu = arch === "amd64" ? "x64" : arch;
  if (!["darwin", "linux", "win32"].includes(platform) || !["x64", "arm64"].includes(cpu)) {
    return null;
  }
  return `pi-pty-${platform}-${cpu}${platform === "win32" ? ".exe" : ""}`;
}

function helperPath(pluginRoot, platform = process.platform, arch = process.arch) {
  const name = helperFileName(platform, arch);
  if (!name) return null;
  return path.join(pluginRoot, "vendor", name);
}

function pathEntries(env, platform) {
  const raw = platform === "win32" ? env.Path || env.PATH || "" : env.PATH || "";
  return String(raw)
    .split(platform === "win32" ? ";" : ":")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function which(name, opts = {}) {
  const platform = opts.platform || process.platform;
  const env = opts.env || process.env;
  const existsSync = opts.existsSync || fs.existsSync;
  const pathMod = opts.path || path;
  if (!name) return null;
  if ((pathMod.isAbsolute(name) || /^[A-Za-z]:[\\/]/.test(name)) && existsSync(name)) return name;
  const entries = pathEntries(env, platform);
  const exts =
    platform === "win32"
      ? String(env.PATHEXT || ".EXE;.CMD;.BAT;.COM")
          .split(";")
          .filter(Boolean)
      : [""];
  for (const dir of entries) {
    if (platform === "win32") {
      const direct = pathMod.join(dir, name);
      if (existsSync(direct)) return direct;
      const lower = name.toLowerCase();
      const hasExt = exts.some((ext) => lower.endsWith(ext.toLowerCase()));
      if (!hasExt) {
        for (const ext of exts) {
          const candidate = pathMod.join(dir, name + ext);
          if (existsSync(candidate)) return candidate;
        }
      }
    } else {
      const candidate = pathMod.join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function firstExisting(candidates, existsSync) {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

function defaultUnixShell(platform, env) {
  const fromEnv = String(env.SHELL || "").trim();
  const shellPath = fromEnv || (platform === "darwin" ? "/bin/zsh" : "/bin/bash");
  const name = path.basename(shellPath);
  return {
    shell: shellPath,
    args: [],
    argv0: name.startsWith("-") ? name : `-${name}`,
    name,
  };
}

function defaultWindowsShell(opts) {
  const existsSync = opts.existsSync || fs.existsSync;
  const env = opts.env || process.env;
  const systemRoot = env.SystemRoot || env.WINDIR || "C:\\Windows";
  const programFiles = env.ProgramFiles || "C:\\Program Files";
  const pwsh =
    which("pwsh.exe", opts) ||
    which("pwsh", opts) ||
    firstExisting([path.join(programFiles, "PowerShell", "7", "pwsh.exe")], existsSync);
  if (pwsh) return { shell: pwsh, args: ["-NoLogo"], name: "PowerShell" };
  const powershell =
    which("powershell.exe", opts) ||
    firstExisting(
      [path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")],
      existsSync,
    );
  if (powershell) return { shell: powershell, args: ["-NoLogo"], name: "Windows PowerShell" };
  const cmd =
    which("cmd.exe", opts) || firstExisting([path.join(systemRoot, "System32", "cmd.exe")], existsSync);
  if (cmd) return { shell: cmd, args: [], name: "Command Prompt" };
  return { shell: "powershell.exe", args: ["-NoLogo"], name: "Windows PowerShell" };
}

function resolveDefaultShell(opts = {}) {
  const platform = opts.platform || process.platform;
  const env = opts.env || process.env;
  const resolved =
    platform === "win32" ? defaultWindowsShell({ ...opts, platform, env }) : defaultUnixShell(platform, env);
  return { id: "default", ...resolved };
}

function gitBashPath(opts = {}) {
  const existsSync = opts.existsSync || fs.existsSync;
  const env = opts.env || process.env;
  const pf = env.ProgramFiles || "C:\\Program Files";
  const pf86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const local = env.LOCALAPPDATA || "";
  return firstExisting(
    [
      which("bash.exe", { ...opts, env }),
      path.join(pf, "Git", "bin", "bash.exe"),
      path.join(pf, "Git", "usr", "bin", "bash.exe"),
      path.join(pf86, "Git", "bin", "bash.exe"),
      local ? path.join(local, "Programs", "Git", "bin", "bash.exe") : null,
    ].filter(Boolean),
    existsSync,
  );
}

function discoverBuiltinProfiles(opts = {}) {
  const platform = opts.platform || process.platform;
  const def = resolveDefaultShell(opts);
  const profiles = [
    {
      id: "default",
      name: def.name,
      shell: def.shell,
      args: def.args,
      argv0: def.argv0,
      builtin: true,
    },
  ];
  if (platform === "win32") {
    const bash = gitBashPath(opts);
    if (bash) {
      profiles.push({
        id: "git-bash",
        name: "Git Bash",
        shell: bash,
        args: ["-l"],
        builtin: true,
      });
    }
  }
  return profiles;
}

function normalizeUserProfiles(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const id = String(item.id || "").trim();
    const sh = String(item.shell || "").trim();
    if (!id || !sh) continue;
    const args = Array.isArray(item.args) ? item.args.map((value) => String(value)) : [];
    const env =
      item.env && typeof item.env === "object" && !Array.isArray(item.env)
        ? Object.fromEntries(Object.entries(item.env).map(([key, value]) => [String(key), String(value)]))
        : undefined;
    out.push({
      id,
      name: String(item.name || id),
      shell: sh,
      args,
      argv0: item.argv0 ? String(item.argv0) : undefined,
      cwd: item.cwd ? String(item.cwd) : undefined,
      env,
      builtin: false,
    });
  }
  return out;
}

function mergeProfiles(builtin, user) {
  const map = new Map();
  for (const profile of builtin || []) map.set(profile.id, profile);
  for (const profile of user || []) map.set(profile.id, profile);
  return [...map.values()];
}

function isInsideRoot(root, target, platform, pathMod) {
  if (!root || !target) return false;
  let base = pathMod.resolve(root);
  let value = pathMod.resolve(target);
  if (platform === "win32") {
    base = base.replace(/[/\\]+$/, "").toLowerCase();
    value = value.replace(/[/\\]+$/, "").toLowerCase();
    return value === base || value.startsWith(`${base}\\`);
  }
  if (base !== "/") base = base.replace(/\/+$/, "");
  if (value !== "/") value = value.replace(/\/+$/, "");
  if (base === "/") return value.startsWith("/");
  return value === base || value.startsWith(`${base}/`);
}

function workspaceKey(workspace, opts = {}) {
  const pathMod = opts.path || path;
  const platform = opts.platform || process.platform;
  const raw = workspace && String(workspace).trim();
  if (!raw || raw.includes("\0")) return "";
  let value = pathMod.resolve(raw);
  if (platform === "win32") {
    return value.replace(/[/\\]+$/, "").toLowerCase();
  }
  if (value !== "/") value = value.replace(/\/+$/, "");
  return value;
}

function resolveAllowedCwd(cwd, opts = {}) {
  const pathMod = opts.path || path;
  const platform = opts.platform || process.platform;
  const workspace = opts.workspace || null;
  const home = opts.home || os.homedir();
  const requested = cwd && String(cwd).trim() ? String(cwd).trim() : workspace || home;
  if (!requested || requested.includes("\0")) {
    throw new Error("cwd is required");
  }
  const resolved = pathMod.isAbsolute(requested)
    ? pathMod.resolve(requested)
    : pathMod.resolve(workspace || home || process.cwd(), requested);
  if (resolved.includes("\0")) throw new Error("invalid cwd");
  const allowed = [workspace, home].filter(Boolean);
  if (!allowed.some((root) => isInsideRoot(root, resolved, platform, pathMod))) {
    throw new Error("cwd must be inside the workspace or home directory");
  }
  return resolved;
}

module.exports = {
  helperFileName,
  helperPath,
  which,
  resolveDefaultShell,
  discoverBuiltinProfiles,
  normalizeUserProfiles,
  mergeProfiles,
  resolveAllowedCwd,
  workspaceKey,
  isInsideRoot,
};
