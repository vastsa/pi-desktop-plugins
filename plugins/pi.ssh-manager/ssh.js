"use strict";

/**
 * SSH transport primitives for pi.ssh-manager.
 *
 * The plugin deliberately delegates authentication to the user's OpenSSH
 * config, agent, or an identity file path. It never reads or stores private
 * key contents, passwords, command output, or a remote transcript.
 */

const { execFile } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_TIMEOUT_SECONDS = 20;
const MAX_TIMEOUT_SECONDS = 60;
const DEFAULT_MAX_OUTPUT_CHARS = 64 * 1024;
const MAX_OUTPUT_CHARS = 256 * 1024;
const MAX_COMMAND_CHARS = 16 * 1024;
const MAX_EXEC_BUFFER = 512 * 1024;
const MAX_PASSWORD_CHARS = 4096;

let execFileImpl = execFile;

function fail(message) {
  const error = new Error(message);
  error.code = "INVALID_INPUT";
  return error;
}

function text(value, field, maxLength) {
  const result = String(value ?? "").trim();
  if (!result) throw fail(`${field} is required`);
  if (result.length > maxLength) throw fail(`${field} is too long`);
  if(/[\u0000\r\n]/.test(result)) throw fail(`${field} contains a control character`);
  return result;
}

function optionalText(value, field, maxLength) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  return text(value, field, maxLength);
}

function normalizeId(value) {
  const id = value ? String(value).trim() : `host-${crypto.randomUUID()}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) {
    throw fail("profile id must contain only letters, numbers, dot, underscore, or hyphen");
  }
  return id;
}

function normalizeHost(value) {
  const host = text(value, "host", 253);
  if (
    host.startsWith("-") ||
    !/^[A-Za-z0-9_.:%\-[\]]+$/.test(host) ||
    host.includes("..")
  ) {
    throw fail("host contains unsupported characters");
  }
  return host;
}

function normalizeUsername(value) {
  const username = text(value, "username", 128);
  if (!/^[A-Za-z0-9._-]+$/.test(username) || username.startsWith("-")) {
    throw fail("username contains unsupported characters");
  }
  return username;
}

function normalizePath(value, field) {
  const path = optionalText(value, field, 1024);
  if (!path) return null;
  const absolute =
    path.startsWith("/") ||
    path === "~" ||
    path.startsWith("~/") ||
    path.startsWith("~\\") ||
    /^[A-Za-z]:[\\/]/.test(path);
  if (!absolute) throw fail(`${field} must be an absolute path or start with ~`);
  return path;
}

function normalizePort(value) {
  const port = value === undefined || value === null || value === "" ? 22 : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw fail("port must be 1-65535");
  return port;
}

function normalizeHostKeyPolicy(value) {
  const policy = value === undefined || value === null || value === "" ? "yes" : String(value);
  if (policy !== "yes" && policy !== "accept-new") {
    throw fail("host key policy must be yes or accept-new");
  }
  return policy;
}

function normalizePassword(value) {
  if (value === undefined || value === null || value === "") return null;
  const password = String(value);
  if (password.length > MAX_PASSWORD_CHARS || /[\u0000\r\n]/.test(password)) {
    throw fail("password is invalid or too long");
  }
  return password;
}

function normalizeProfile(input = {}, existing = {}) {
  const source = input && typeof input === "object" ? input : {};
  const previous = existing && typeof existing === "object" ? existing : {};
  const now = new Date().toISOString();
  const profile = {
    id: normalizeId(source.id ?? previous.id),
    name: text(source.name ?? previous.name, "name", 80),
    host: normalizeHost(source.host ?? previous.host),
    port: normalizePort(source.port ?? previous.port),
    username: normalizeUsername(source.username ?? previous.username),
    identityFile: normalizePath(
      source.identityFile ?? previous.identityFile,
      "identityFile",
    ),
    agentSocket: normalizePath(source.agentSocket ?? previous.agentSocket, "agentSocket"),
    strictHostKeyChecking: normalizeHostKeyPolicy(
      source.strictHostKeyChecking ?? previous.strictHostKeyChecking,
    ),
    createdAt: previous.createdAt || now,
    updatedAt: now,
  };
  return profile;
}

function normalizeStore(value) {
  const source = value && typeof value === "object" ? value : {};
  const profiles = [];
  const seen = new Set();
  for (const candidate of Array.isArray(source.profiles) ? source.profiles : []) {
    try {
      const profile = normalizeProfile(candidate);
      if (seen.has(profile.id)) continue;
      seen.add(profile.id);
      profiles.push(profile);
    } catch {
      // A malformed old profile must not prevent the plugin from loading.
    }
  }
  return { version: 1, profiles };
}

function profileForPanel(profile) {
  return profile ? { ...profile } : null;
}

function profileForAgent(profile) {
  if (!profile) return null;
  return {
    id: profile.id,
    name: profile.name,
    host: profile.host,
    port: profile.port,
    username: profile.username,
    identityConfigured: Boolean(profile.identityFile),
    agentConfigured: Boolean(profile.agentSocket),
    strictHostKeyChecking: profile.strictHostKeyChecking,
    updatedAt: profile.updatedAt,
  };
}

function clampNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(number)));
}

function normalizeTimeout(value) {
  return clampNumber(value, DEFAULT_TIMEOUT_SECONDS, 1, MAX_TIMEOUT_SECONDS);
}

function normalizeMaxOutput(value) {
  return clampNumber(value, DEFAULT_MAX_OUTPUT_CHARS, 1024, MAX_OUTPUT_CHARS);
}

function expandUserPath(value) {
  if (!value || !value.startsWith("~")) return value;
  return `${os.homedir()}${value.slice(1)}`;
}

function buildTarget(profile) {
  return `${profile.username}@${profile.host}`;
}

function buildSshArgs(profile, options = {}) {
  const timeoutSeconds = normalizeTimeout(options.timeoutSeconds);
  const hasPassword = Boolean(options.password);
  const hostKeyPolicy = options.acceptNewHostKey === true
    ? "accept-new"
    : profile.strictHostKeyChecking;
  const args = [
    "-o",
    `BatchMode=${hasPassword ? "no" : "yes"}`,
    "-o",
    `ConnectTimeout=${timeoutSeconds}`,
    "-o",
    "ServerAliveInterval=10",
    "-o",
    "ServerAliveCountMax=2",
    "-o",
    "RequestTTY=no",
    "-o",
    "LogLevel=ERROR",
    "-o",
    `StrictHostKeyChecking=${hostKeyPolicy}`,
  ];
  if (hasPassword) {
    args.push(
      "-o",
      "NumberOfPasswordPrompts=1",
      "-o",
      "PasswordAuthentication=yes",
      "-o",
      "KbdInteractiveAuthentication=yes",
      "-o",
      "PreferredAuthentications=password,keyboard-interactive",
    );
  }
  if (profile.identityFile) args.push("-i", expandUserPath(profile.identityFile));
  if (profile.port !== 22) args.push("-p", String(profile.port));
  args.push(buildTarget(profile));
  if (options.remoteCommand !== undefined) {
    const command = String(options.remoteCommand);
    if (!command.trim()) throw fail("remote command is required");
    if (command.length > MAX_COMMAND_CHARS || /[\u0000\r\n]/.test(command)) {
      throw fail("remote command is invalid or too long");
    }
    // Keep the entire remote command as one execFile argument. The remote
    // shell may interpret it, but it can never alter the local argv boundary.
    args.push(command);
  }
  return args;
}

function buildEnvironment(profile, options = {}) {
  const home = os.homedir();
  const env = {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: home,
    USERPROFILE: home,
    LANG: process.env.LANG || "en_US.UTF-8",
  };
  const socket = profile.agentSocket
    ? expandUserPath(profile.agentSocket)
    : process.env.SSH_AUTH_SOCK;
  if (socket) env.SSH_AUTH_SOCK = socket;
  if (options.askpassPath) {
    env.SSH_ASKPASS = options.askpassPath;
    env.SSH_ASKPASS_REQUIRE = "force";
    env.DISPLAY = "pi-ssh-manager";
    env.PI_SSH_ASKPASS_PASSWORD = options.password;
  }
  return env;
}

function clip(value, maxLength) {
  const output = String(value || "");
  if (output.length <= maxLength) return { text: output, truncated: false };
  return {
    text: `${output.slice(0, Math.max(0, maxLength - 32)).trimEnd()}\n… [output truncated]`,
    truncated: true,
  };
}

function redactLocalPaths(value, profile) {
  let output = String(value || "");
  for (const candidate of [
    profile.identityFile,
    profile.agentSocket,
    profile.identityFile ? expandUserPath(profile.identityFile) : null,
    profile.agentSocket ? expandUserPath(profile.agentSocket) : null,
  ]) {
    if (candidate) output = output.split(candidate).join("[local credential path]");
  }
  return output;
}

function createAskpassHelper(password) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ssh-"));
  const file = path.join(directory, process.platform === "win32" ? "askpass.cmd" : "askpass.sh");
  const source = process.platform === "win32"
    ? "@echo off\r\necho %PI_SSH_ASKPASS_PASSWORD%\r\n"
    : "#!/bin/sh\nprintf '%s\\n' \"$PI_SSH_ASKPASS_PASSWORD\"\n";
  fs.writeFileSync(file, source, { encoding: "utf8", mode: 0o700 });
  return {
    file,
    cleanup() {
      try {
        fs.unlinkSync(file);
      } catch {
        // Best effort: the directory is private and contains no user data.
      }
      try {
        fs.rmdirSync(directory);
      } catch {
        // Best effort cleanup after the short-lived ssh process exits.
      }
    },
  };
}

function runProcess(file, args, options) {
  return new Promise((resolve) => {
    let child = null;
    let finished = false;
    let timedOut = false;
    let timer = null;

    const finish = (error, stdout = "", stderr = "") => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      resolve({ error, stdout: String(stdout || ""), stderr: String(stderr || ""), timedOut });
    };

    timer = setTimeout(() => {
      timedOut = true;
      try {
        child?.kill?.("SIGTERM");
      } catch {
        // The callback below still completes the operation if the process is gone.
      }
      finish(new Error("SSH command timed out"), "", "SSH command timed out");
    }, options.timeoutSeconds * 1000);

    try {
      child = execFileImpl(
        file,
        args,
        {
          shell: false,
          windowsHide: true,
          maxBuffer: MAX_EXEC_BUFFER,
          env: options.env,
        },
        finish,
      );
    } catch (error) {
      finish(error, "", "");
    }
  });
}

async function runSsh(profile, options = {}) {
  const normalized = normalizeProfile(profile, profile);
  const password = normalizePassword(options.password);
  const timeoutSeconds = normalizeTimeout(options.timeoutSeconds);
  const maxOutputChars = normalizeMaxOutput(options.maxOutputChars);
  const askpass = password ? createAskpassHelper(password) : null;
  try {
    const args = buildSshArgs(normalized, {
      remoteCommand: options.remoteCommand,
      timeoutSeconds,
      acceptNewHostKey: options.acceptNewHostKey,
      password,
    });
    const result = await runProcess("ssh", args, {
      timeoutSeconds: timeoutSeconds + 5,
      env: buildEnvironment(normalized, {
        askpassPath: askpass?.file,
        password,
      }),
    });
    const stdout = clip(result.stdout, maxOutputChars);
    const stderr = clip(redactLocalPaths(result.stderr, normalized), maxOutputChars);
    const exitCode = result.error && Number.isInteger(result.error.code)
      ? result.error.code
      : result.error
        ? null
        : 0;
    const error = result.timedOut
      ? "SSH command timed out"
      : result.error && typeof result.error.code === "string"
        ? `Unable to start ssh: ${result.error.code}`
        : result.error && exitCode !== null
          ? `ssh exited with code ${exitCode}`
          : result.error
            ? String(result.error.message || result.error)
            : null;
    return {
      ok: !result.error,
      exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
      outputTruncated:
        stdout.truncated ||
        stderr.truncated ||
        result.error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      timedOut: result.timedOut,
      error,
    };
  } finally {
    askpass?.cleanup();
  }
}

const COMMAND_RISK_RULES = [
  { pattern: /\brm\s+-[^\s]*r/i, reason: "recursive deletion" },
  { pattern: /\b(mkfs|fdisk|parted)\b/i, reason: "disk repartitioning" },
  { pattern: /\b(shutdown|reboot|poweroff|halt)\b/i, reason: "host power operation" },
  { pattern: /\bdd\s+[^\n]*\bif=/i, reason: "raw disk write" },
  { pattern: /\b(curl|wget)\b[^\n]*\|\s*(sh|bash|zsh)\b/i, reason: "shell pipe from the network" },
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:/i, reason: "fork bomb" },
  { pattern: /\bchmod\s+(?:-R\s+)?777\b/i, reason: "world-writable permission change" },
];

function findCommandRisk(command) {
  const value = String(command || "");
  const match = COMMAND_RISK_RULES.find((rule) => rule.pattern.test(value));
  return match ? `Blocked by default: ${match.reason}. Ask the user for explicit approval and set allow_destructive=true.` : null;
}

function createSessionId() {
  return `ssh-${crypto.randomUUID()}`;
}

module.exports = {
  DEFAULT_TIMEOUT_SECONDS,
  MAX_TIMEOUT_SECONDS,
  DEFAULT_MAX_OUTPUT_CHARS,
  MAX_OUTPUT_CHARS,
  buildSshArgs,
  createSessionId,
  findCommandRisk,
  normalizePassword,
  normalizeMaxOutput,
  normalizeProfile,
  normalizeStore,
  normalizeTimeout,
  profileForAgent,
  profileForPanel,
  runSsh,
  __test: {
    setExecFile(value) {
      execFileImpl = value;
    },
    resetExecFile() {
      execFileImpl = execFile;
    },
    clip,
    buildEnvironment,
  },
};
