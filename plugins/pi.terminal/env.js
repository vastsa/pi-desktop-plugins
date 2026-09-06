"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");

const START = "__PI_ENV_START__";
const END = "__PI_ENV_END__";
const DUMP_SCRIPT = `printf '%s' '${START}'; /usr/bin/env -0; printf '%s' '${END}'`;

function parseNulEnv(raw) {
  const map = {};
  for (const part of String(raw).split("\0")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    map[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return map;
}

function extractMarked(stdout) {
  const text = String(stdout || "");
  const start = text.indexOf(START);
  const end = text.indexOf(END);
  if (start < 0 || end < 0 || end <= start) return null;
  return text.slice(start + START.length, end);
}

function nvmBinDirs(home, existsSync, readdirSync) {
  const root = path.join(home, ".nvm", "versions", "node");
  if (!existsSync(root)) return [];
  let names = [];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  return names
    .filter((name) => /^v?\d/.test(name))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map((name) => path.join(root, name, "bin"))
    .filter((dir) => existsSync(dir));
}

function extraPathDirs(opts = {}) {
  const home = opts.home || os.homedir();
  const platform = opts.platform || process.platform;
  const existsSync = opts.existsSync || fs.existsSync;
  const readdirSync = opts.readdirSync || fs.readdirSync;
  const dirs = [];
  if (platform === "win32") {
    const local = opts.env?.LOCALAPPDATA || path.join(home, "AppData", "Local");
    const roaming = opts.env?.APPDATA || path.join(home, "AppData", "Roaming");
    dirs.push(
      path.join(local, "pnpm"),
      path.join(roaming, "npm"),
      path.join(local, "Programs", "Git", "cmd"),
      "C:\\Program Files\\nodejs",
      "C:\\Program Files\\Git\\cmd",
    );
  } else {
    dirs.push(
      path.join(home, "Library", "pnpm"),
      path.join(home, ".local", "share", "pnpm"),
      path.join(home, ".bun", "bin"),
      path.join(home, ".local", "bin"),
      path.join(home, ".cargo", "bin"),
      path.join(home, ".fnm", "aliases", "default", "bin"),
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
      "/usr/local/bin",
    );
    dirs.push(...nvmBinDirs(home, existsSync, readdirSync));
  }
  return dirs.filter((dir) => dir && existsSync(dir));
}

function augmentPath(pathValue, opts = {}) {
  const platform = opts.platform || process.platform;
  const sep = platform === "win32" ? ";" : ":";
  const existing = String(pathValue || "")
    .split(sep)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const keyOf = (value) => (platform === "win32" ? value.toLowerCase() : value);
  const seen = new Set(existing.map(keyOf));
  const prepend = [];
  for (const dir of extraPathDirs(opts)) {
    const key = keyOf(dir);
    if (seen.has(key)) continue;
    seen.add(key);
    prepend.push(dir);
  }
  return [...prepend, ...existing].join(sep);
}

function stripGuiVars(env) {
  const out = { ...env };
  for (const key of Object.keys(out)) {
    if (/^(ELECTRON_|VSCODE_|CHROME_)/.test(key) || key === "NODE_OPTIONS") {
      delete out[key];
    }
  }
  delete out.ELECTRON_RUN_AS_NODE;
  return out;
}

function fallbackLang(locale) {
  return String(locale || "").toLowerCase().startsWith("zh") ? "zh_CN.UTF-8" : "en_US.UTF-8";
}

function mergeUserEnv(loginEnv, opts = {}) {
  const platform = opts.platform || process.platform;
  const home = opts.home || os.homedir();
  const processEnv = opts.processEnv || process.env;
  const merged = stripGuiVars({ ...processEnv, ...loginEnv });
  const pathKey = platform === "win32" && merged.Path && !merged.PATH ? "Path" : "PATH";
  merged[pathKey] = augmentPath(merged[pathKey] || merged.PATH || merged.Path || "", {
    ...opts,
    home,
    platform,
    env: merged,
  });
  merged.HOME = merged.HOME || home;
  merged.SHELL = merged.SHELL || opts.shell || processEnv.SHELL;
  merged.USER = merged.USER || processEnv.USER || processEnv.USERNAME || os.userInfo().username;
  merged.LOGNAME = merged.LOGNAME || merged.USER;
  if (!merged.LANG && !merged.LC_ALL) merged.LANG = fallbackLang(opts.locale);
  merged.TERM = "xterm-256color";
  merged.COLORTERM = "truecolor";
  return merged;
}

function captureLoginEnv(opts = {}) {
  const platform = opts.platform || process.platform;
  const home = opts.home || os.homedir();
  const processEnv = opts.processEnv || process.env;
  const run = opts.execFile || execFile;
  const shellPath = opts.shell || processEnv.SHELL || (platform === "darwin" ? "/bin/zsh" : "/bin/bash");
  const fallback = mergeUserEnv({}, { ...opts, home, platform, processEnv, shell: shellPath });
  if (platform === "win32") return Promise.resolve(fallback);

  return new Promise((resolve) => {
    run(
      shellPath,
      ["-ilc", DUMP_SCRIPT],
      {
        cwd: home,
        env: { ...processEnv, TERM: "dumb", SHELL: shellPath, HOME: home },
        timeout: opts.timeoutMs || 12000,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout) => {
        const marked = extractMarked(stdout || "");
        if (error || !marked) {
          resolve(fallback);
          return;
        }
        resolve(mergeUserEnv(parseNulEnv(marked), { ...opts, home, platform, processEnv, shell: shellPath }));
      },
    );
  });
}

function loginArgv0(shellPath, platform = process.platform) {
  if (platform === "win32" || !shellPath) return "";
  const base = path.basename(String(shellPath));
  return base.startsWith("-") ? base : `-${base}`;
}

module.exports = {
  START,
  END,
  DUMP_SCRIPT,
  parseNulEnv,
  extractMarked,
  extraPathDirs,
  augmentPath,
  mergeUserEnv,
  captureLoginEnv,
  loginArgv0,
  stripGuiVars,
};
