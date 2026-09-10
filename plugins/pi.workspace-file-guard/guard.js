"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TMP_DIRNAME = ".tmp";
const WIN = process.platform === "win32";

function expandEnv(input) {
  let out = String(input ?? "");
  const replaceName = (name, original) => {
    const value = process.env[name];
    return value == null ? original : value;
  };
  if (WIN) {
    out = out.replace(/%([^%]+)%/g, (all, name) => replaceName(name, all));
  }
  out = out.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (all, name) => replaceName(name, all));
  if (!WIN) {
    out = out.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (all, name) => replaceName(name, all));
  }
  return out;
}

function expandUser(input) {
  const raw = expandEnv(String(input ?? "").trim());
  if (!raw) return raw;
  if (raw === "~") return os.homedir();
  if (raw.startsWith("~/") || raw.startsWith("~\\")) {
    return path.join(os.homedir(), raw.slice(2));
  }
  return raw;
}

function isAbsolutePath(target) {
  if (!target) return false;
  if (path.isAbsolute(target)) return true;
  if (WIN && /^[a-zA-Z]:[\\/]/.test(target)) return true;
  if (target.startsWith("\\\\") || target.startsWith("//")) return true;
  return false;
}

function resolvePath(input, base) {
  const expanded = expandUser(input);
  try {
    if (base && expanded && !isAbsolutePath(expanded)) {
      return path.resolve(resolvePath(base), expanded);
    }
    return path.resolve(expanded);
  } catch {
    return path.resolve(String(input ?? ""));
  }
}

function compareKey(target) {
  const normalized = path.normalize(String(target || ""));
  return WIN ? normalized.toLowerCase() : normalized;
}

function isRelativeTo(target, root) {
  if (!target || !root) return false;
  const resolvedTarget = resolvePath(target);
  const resolvedRoot = resolvePath(root);
  const rel = path.relative(resolvedRoot, resolvedTarget);
  if (rel === "") return true;
  if (path.isAbsolute(rel)) return false;
  const prefix = `..${path.sep}`;
  if (rel === ".." || rel.startsWith(prefix)) return false;
  if (WIN) {
    const relCi = path.relative(compareKey(resolvedRoot), compareKey(resolvedTarget));
    if (relCi === "") return true;
    if (path.isAbsolute(relCi) || relCi === ".." || relCi.startsWith(prefix)) return false;
  }
  return true;
}

function driveOf(target) {
  const resolved = resolvePath(target);
  const parsed = path.parse(resolved);
  const root = String(parsed.root || "").replace(/\\/g, "/").toLowerCase();
  if (root && /^[a-z]:/.test(root)) return root.slice(0, 2);
  if (resolved.startsWith("\\\\") || resolved.startsWith("//")) return "unc";
  if (root === "/") return "/";
  return "";
}

function systemDrive() {
  if (!WIN) return "";
  const raw = process.env.SystemDrive || "C:";
  return `${String(raw).replace(/[:\\]/g, "").slice(0, 1).toLowerCase()}:`;
}

function uniquePaths(items) {
  const unique = [];
  const seen = new Set();
  for (const item of items) {
    if (!item) continue;
    const resolved = resolvePath(item);
    const key = compareKey(resolved);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(resolved);
  }
  return unique;
}

function home() {
  return resolvePath(os.homedir());
}

function piHome() {
  return resolvePath(path.join(os.homedir(), ".pi-desktop"));
}

function piAgentHome() {
  return resolvePath(path.join(os.homedir(), ".pi"));
}

function codexHome() {
  const fromEnv = process.env.CODEX_HOME;
  return resolvePath(fromEnv ? fromEnv : path.join(os.homedir(), ".codex"));
}

function scratchRoot() {
  const fromEnv = process.env.PI_SCRATCH_DIR;
  if (fromEnv && String(fromEnv).trim()) return resolvePath(fromEnv);
  return resolvePath(path.join(piHome(), "scratch"));
}

function readXdgUserDirs(h) {
  const file = path.join(h, ".config", "user-dirs.dirs");
  const out = {};
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^XDG_([A-Z_]+)_DIR="?([^"]+)"?/);
    if (!match) continue;
    let value = expandEnv(match[2]);
    if (value.startsWith("$HOME")) value = h + value.slice(5);
    out[match[1].toLowerCase()] = value;
  }
  return out;
}

const USER_MEDIA_XDG = {
  Desktop: "desktop",
  Downloads: "download",
  Documents: "documents",
  Pictures: "pictures",
  Music: "music",
  Videos: "videos",
  Movies: "videos",
};

function userMediaRoots(h) {
  const xdg = readXdgUserDirs(h);
  const roots = Object.entries(USER_MEDIA_XDG).map(([name, xdgKey]) => {
    return xdg[xdgKey] || path.join(h, name);
  });
  roots.push(path.join(h, "OneDrive", "Desktop"));
  roots.push(path.join(h, "OneDrive", "Documents"));
  roots.push(path.join(h, "OneDrive", "Downloads"));
  const pub = process.env.PUBLIC;
  if (pub) {
    roots.push(path.join(pub, "Desktop"));
    roots.push(path.join(pub, "Documents"));
    roots.push(path.join(pub, "Downloads"));
  }
  return roots;
}

function windowsSystemRoots() {
  if (!WIN) return [];
  const systemRoot = process.env.SystemRoot || process.env.windir;
  const systemDriveLetter = systemDrive();
  const driveRoot = systemDriveLetter ? `${systemDriveLetter}\\` : "";
  return [
    process.env.TEMP,
    process.env.TMP,
    process.env.TMPDIR,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Temp"),
    systemRoot && path.join(systemRoot, "Temp"),
    systemRoot,
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    process.env.ProgramW6432,
    process.env.ProgramData,
    driveRoot && path.join(driveRoot, "Temp"),
    driveRoot && path.join(driveRoot, "Windows"),
  ];
}

function posixSystemRoots() {
  if (WIN) return [];
  return [
    "/tmp",
    "/var/tmp",
    "/var/cache",
    "/var/log",
    "/private/tmp",
    "/private/var/tmp",
    "/usr",
    "/bin",
    "/sbin",
    "/etc",
    "/opt",
    "/System",
    "/Library",
    "/Applications",
  ];
}

function junkRoots() {
  const h = home();
  const roots = [
    ...userMediaRoots(h),
    os.tmpdir(),
    path.join(h, "AppData", "Local", "Temp"),
    path.join(h, "Library", "Caches"),
    path.join(h, "Library", "Logs"),
    path.join(h, ".cache"),
    process.env.XDG_CACHE_HOME,
    path.join(piHome(), "logs"),
    path.join(piHome(), "cache"),
    path.join(codexHome(), "visualizations"),
    path.join(codexHome(), "tmp"),
    path.join(codexHome(), ".tmp"),
    path.join(h, ".codex", "visualizations"),
    path.join(h, ".codex", "tmp"),
    path.join(h, ".codex", ".tmp"),
    ...windowsSystemRoots(),
    ...posixSystemRoots(),
    process.env.TEMP,
    process.env.TMP,
    process.env.TMPDIR,
  ];
  return uniquePaths(roots);
}

function allowedExceptions() {
  return uniquePaths([
    path.join(piHome(), "plugins"),
    path.join(piAgentHome(), "agent"),
    path.join(codexHome(), "skills"),
    path.join(codexHome(), "config.toml"),
    path.join(codexHome(), "AGENTS.md"),
  ]);
}

function isToolInternal(target) {
  const roots = uniquePaths([
    path.join(codexHome(), "visualizations"),
    path.join(codexHome(), "tmp"),
    path.join(codexHome(), ".tmp"),
    path.join(home(), ".codex", "visualizations"),
    path.join(home(), ".codex", "tmp"),
    path.join(home(), ".codex", ".tmp"),
    path.join(piHome(), "logs"),
    path.join(piHome(), "cache"),
  ]);
  return roots.some((root) => isRelativeTo(target, root));
}

function defaultProjectRoot({ workspace, explicit } = {}) {
  if (explicit) return resolvePath(explicit);
  if (workspace) return resolvePath(workspace);
  throw new Error("workspace unavailable; pass root or open a workspace");
}

function resolveToolRoot({ explicit, workspace } = {}) {
  if (explicit) return { ok: true, projectRoot: resolvePath(explicit) };
  if (workspace) return { ok: true, projectRoot: resolvePath(workspace) };
  return {
    ok: false,
    error: "workspace unavailable; pass root or open a workspace",
  };
}

function tmpLayout(projectRoot) {
  const tmp = path.join(resolvePath(projectRoot), TMP_DIRNAME);
  return {
    tmp,
    tests: path.join(tmp, "tests"),
    scripts: path.join(tmp, "scripts"),
    cache: path.join(tmp, "cache"),
    out: path.join(tmp, "out"),
  };
}

function envAssignments({ projectRoot, scratch } = {}) {
  const layout = tmpLayout(projectRoot);
  const ephemeral = scratch ? resolvePath(scratch) : layout.tmp;
  const cache = layout.cache;
  return {
    TMP: ephemeral,
    TEMP: ephemeral,
    TMPDIR: ephemeral,
    PYTHONPYCACHEPREFIX: path.join(ephemeral, "pycache"),
    PIP_CACHE_DIR: path.join(cache, "pip"),
    UV_CACHE_DIR: path.join(cache, "uv"),
    npm_config_cache: path.join(cache, "npm"),
    npm_config_tmp: ephemeral,
    GOCACHE: path.join(cache, "go"),
    GOTMPDIR: ephemeral,
    XDG_CACHE_HOME: cache,
    CARGO_TARGET_DIR: path.join(layout.tmp, "target"),
    HF_HOME: path.join(cache, "huggingface"),
  };
}

function defaultShell() {
  return WIN ? "powershell" : "bash";
}

function formatEnv(mapping, shell) {
  const dialect = shell || defaultShell();
  if (dialect === "json") return `${JSON.stringify(mapping, null, 2)}\n`;
  if (dialect === "powershell") {
    return `${Object.entries(mapping)
      .map(([key, value]) => `$env:${key} = ${JSON.stringify(value)}`)
      .join("\n")}\n`;
  }
  if (dialect === "cmd") {
    for (const value of Object.values(mapping)) {
      if (String(value).includes('"')) {
        throw new Error("cmd env assignments cannot contain double quotes");
      }
    }
    return `${Object.entries(mapping)
      .map(([key, value]) => `set "${key}=${value}"`)
      .join("\r\n")}\r\n`;
  }
  return `${Object.entries(mapping)
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n")}\n`;
}

function classify(inputPath, projectRoot, options = {}) {
  const root = resolvePath(projectRoot);
  const target = resolvePath(inputPath, root);
  const scratch = options.scratch ? resolvePath(options.scratch) : scratchRoot();

  if (isRelativeTo(target, root)) {
    return {
      path: target,
      projectRoot: root,
      scratch,
      allowed: true,
      reasons: ["inside project root"],
    };
  }

  if (isRelativeTo(target, scratch)) {
    return {
      path: target,
      projectRoot: root,
      scratch,
      allowed: true,
      reasons: ["inside PI scratch"],
    };
  }

  if (allowedExceptions().some((exception) => isRelativeTo(target, exception))) {
    return {
      path: target,
      projectRoot: root,
      scratch,
      allowed: Boolean(options.explicit),
      reasons: options.explicit
        ? ["tool-home exception"]
        : ["outside project root", "home-config path needs an explicit user request"],
    };
  }

  const reasons = ["outside project root"];
  const targetDrive = driveOf(target);
  const rootDrive = driveOf(root);
  const osDrive = systemDrive();

  if (targetDrive && rootDrive && targetDrive !== rootDrive) {
    reasons.push(`different volume ${targetDrive} vs project ${rootDrive}`);
    if (osDrive && targetDrive === osDrive) {
      reasons.push("system volume is blocked for project junk");
    }
  }

  if (isToolInternal(target)) {
    reasons.push("PI/Codex internal temp/log/visualization path");
  }

  for (const junk of junkRoots()) {
    if (isRelativeTo(target, junk)) {
      reasons.push(`system/user junk path ${junk}`);
      break;
    }
  }

  const blockedByPolicy = reasons.some(
    (reason) =>
      reason.startsWith("system/user junk path") ||
      reason.includes("internal temp/log/visualization")
  );

  if (options.explicit && !blockedByPolicy) {
    return {
      path: target,
      projectRoot: root,
      scratch,
      allowed: true,
      reasons: ["explicit destination named by the user", ...reasons],
    };
  }

  return {
    path: target,
    projectRoot: root,
    scratch,
    allowed: false,
    reasons,
  };
}

module.exports = {
  TMP_DIRNAME,
  classify,
  defaultProjectRoot,
  defaultShell,
  driveOf,
  envAssignments,
  formatEnv,
  isRelativeTo,
  junkRoots,
  resolvePath,
  resolveToolRoot,
  scratchRoot,
  systemDrive,
  tmpLayout,
};
