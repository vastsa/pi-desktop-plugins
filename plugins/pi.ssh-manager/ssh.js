"use strict";

/**
 * SSH transport primitives for pi.ssh-manager.
 *
 * The plugin deliberately delegates authentication to the user's OpenSSH
 * config, agent, or an identity file path. It never reads private-key contents
 * or persists passwords, command output, or a remote transcript.
 */

const { execFile } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_TIMEOUT_SECONDS = 20;
const MAX_TIMEOUT_SECONDS = 60;
const DEFAULT_MAX_OUTPUT_CHARS = 64 * 1024;
const MAX_OUTPUT_CHARS = 256 * 1024;
const MAX_COMMAND_CHARS = 16 * 1024;
const MAX_EXEC_BUFFER = 512 * 1024;
const MAX_PASSWORD_CHARS = 4096;
const MAX_CONFIG_FILE_BYTES = 256 * 1024;
const MAX_CONFIG_FILES = 32;
const MAX_CONFIG_TOTAL_BYTES = 1024 * 1024;
const MAX_CONFIG_INCLUDE_DEPTH = 8;
const MAX_CONFIG_INCLUDE_MATCHES = 256;
const ASKPASS_BROKER_TIMEOUT_MS = 5000;
const WINDOWS_ENV_KEEP = [
  "ALLUSERSPROFILE", "APPDATA", "LOCALAPPDATA", "ProgramData",
  "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432",
  "SYSTEMROOT", "SystemRoot", "WINDIR", "windir", "SYSTEMDRIVE", "SystemDrive",
  "COMSPEC", "ComSpec", "PATHEXT", "OS",
  "USERNAME", "USERDOMAIN", "USERDOMAIN_ROAMINGPROFILE", "COMPUTERNAME",
  "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER",
  "TEMP", "TMP", "PUBLIC", "HOMEDRIVE", "HOMEPATH", "SESSIONNAME",
  "LOGONSERVER", "USERPROFILE",
];
const SSH_DIAGNOSTIC_PATTERN = /permission denied|could not resolve|connection refused|connection timed out|host key|no matching host key|no more authentication|too many authentication|identity file|no such file|unable to negotiate|connection reset|network is unreachable|no route to host|connection closed|bad configuration|invalid argument|unknown option|not a valid private key|unprotected private key|kex_exchange|broken pipe|operation timed out|name or service not known|no address associated|connection aborted|remote host identification has changed|offending .+ key|banner exchange|protocol error|disconnected from|authentications that can continue|no supported authentication|connection to .+ port/i;

let execFileImpl = execFile;
const activeProcesses = new Set();
const activeTimers = new Set();
const activeAskpassBrokers = new Set();

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

function normalizePath(value, field, allowOpenSshTokens = false) {
  const path = optionalText(value, field, 1024);
  if (!path) return null;
  if (allowOpenSshTokens && /^%[A-Za-z%]/.test(path)) return path;
  const absolute =
    path.startsWith("/") ||
    path === "~" ||
    path.startsWith("~/") ||
    path.startsWith("~\\") ||
    /^[A-Za-z]:[\\/]/.test(path);
  if (!absolute) throw fail(`${field} must be an absolute path or start with ~`);
  return path;
}

function normalizeAgentSocket(value) {
  if (value === "SSH_AUTH_SOCK") return value;
  return normalizePath(value, "agentSocket");
}

function normalizeOptionalHostName(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const host = text(value, "hostName", 253);
  if (
    host.startsWith("-") ||
    !/^[A-Za-z0-9_.:%\-[\]]+$/.test(host) ||
    host.includes("..")
  ) {
    throw fail("hostName contains unsupported characters");
  }
  return host;
}

function normalizeConfigAlias(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  return normalizeHost(value);
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
      Boolean(source.configAlias ?? previous.configAlias),
    ),
    agentSocket: normalizeAgentSocket(source.agentSocket ?? previous.agentSocket),
    strictHostKeyChecking: normalizeHostKeyPolicy(
      source.strictHostKeyChecking ?? previous.strictHostKeyChecking,
    ),
    createdAt: previous.createdAt || now,
    updatedAt: now,
  };
  const hostName = normalizeOptionalHostName(source.hostName ?? previous.hostName);
  const configAlias = normalizeConfigAlias(source.configAlias ?? previous.configAlias);
  const sourcePath = optionalText(source.source ?? previous.source, "source", 2048);
  if (hostName) {
    profile.hostName = hostName;
    profile.hostname = hostName;
  }
  if (configAlias) profile.configAlias = configAlias;
  if (sourcePath) profile.source = sourcePath;
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

function stripConfigComment(line) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "#") {
      return line.slice(0, index);
    }
  }
  return line;
}

function configWords(value) {
  const words = [];
  let word = "";
  let quote = null;
  let escaped = false;
  const source = String(value || "");
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      // OpenSSH uses backslash to quote separators, but a Windows config also
      // legitimately contains C:\\Users\\... paths. Preserve a backslash
      // before ordinary characters while still unquoting whitespace, quotes,
      // comments, and another backslash.
      if (![" ", "\t", "#", "\\", "'", '"'].includes(character)) word += "\\";
      word += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else word += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === " " || character === "\t") {
      if (word) {
        words.push(word);
        word = "";
      }
    } else {
      word += character;
    }
  }
  if (escaped) word += "\\\\";
  if (word) words.push(word);
  return words;
}

function parseConfigDirective(line) {
  const words = configWords(stripConfigComment(String(line || "").trim()));
  if (!words.length) return null;
  const separator = words[0].indexOf("=");
  if (separator > 0) {
    const key = words[0].slice(0, separator).toLowerCase();
    const inlineValue = words[0].slice(separator + 1);
    return { key, values: inlineValue ? [inlineValue, ...words.slice(1)] : words.slice(1) };
  }
  return { key: words[0].toLowerCase(), values: words.slice(1) };
}

function hostGlobRegExp(pattern) {
  let source = "^";
  let escaped = false;
  for (const character of String(pattern || "")) {
    if (escaped) {
      source += character.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&");
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "*") {
      source += ".*";
    } else if (character === "?") {
      source += ".";
    } else {
      source += character.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&");
    }
  }
  if (escaped) source += "\\\\\\\\";
  return new RegExp(`${source}$`);
}

function hostPatternMatches(alias, patterns) {
  const positive = [];
  for (const pattern of patterns) {
    if (!pattern) continue;
    if (pattern.startsWith("!")) {
      if (hostGlobRegExp(pattern.slice(1)).test(alias)) return false;
    } else {
      positive.push(pattern);
    }
  }
  return positive.length > 0 && positive.some((pattern) => hostGlobRegExp(pattern).test(alias));
}

function usableConfigAlias(value) {
  const alias = String(value || "").trim();
  if (!alias || alias.startsWith("!") || /[*?]/.test(alias)) return false;
  return /^[A-Za-z0-9_.:%\-[\]]+$/.test(alias);
}

function firstConfigValue(values, field) {
  for (const value of values || []) {
    const candidate = String(value || "").trim();
    if (!candidate || candidate.toLowerCase() === "none") continue;
    if (field === "port" && !candidate.split("").every((character) => character >= "0" && character <= "9")) continue;
    return candidate;
  }
  return null;
}

function localOsUsername(fallback = "user") {
  let username = "";
  try {
    username = os.userInfo().username;
  } catch {
    username = process.env.USER || process.env.USERNAME || "";
  }
  const result = String(username || fallback).trim();
  return /^[A-Za-z0-9._-]+$/.test(result) && !result.startsWith("-") ? result : fallback;
}

/**
 * Parse OpenSSH config text without opening any referenced identity file.
 * The returned host is always the configured alias, not HostName, so ssh can
 * still apply the alias's complete stanza (including ProxyJump).
 */
function parseOpenSSHConfig(configText, options = {}) {
  const records = [{ patterns: null, directives: [] }];
  let current = records[0];
  const lines = String(configText || "").split(/\r?\n/);
  for (const line of lines) {
    const directive = parseConfigDirective(line);
    if (!directive) continue;
    if (directive.key === "host") {
      if (!directive.values.length) {
        current = { patterns: [], directives: [] };
        records.push(current);
        continue;
      }
      current = { patterns: directive.values, directives: [] };
      records.push(current);
    } else if (directive.key === "match") {
      // Match conditions need runtime context (local network, exec, etc.).
      // Do not attribute the following directives to the preceding Host block.
      current = { patterns: [], directives: [] };
      records.push(current);
    } else if (directive.key !== "include") {
      current.directives.push(directive);
    }
  }

  const aliases = [];
  const seen = new Set();
  for (const record of records) {
    for (const pattern of record.patterns || []) {
      if (usableConfigAlias(pattern) && !seen.has(pattern)) {
        seen.add(pattern);
        aliases.push(pattern);
      }
    }
  }

  const source = options.source ? String(options.source) : null;
  const username = options.username ? String(options.username) : localOsUsername();
  return aliases.filter((alias) =>
    records.some((record) =>
      record.patterns &&
      record.patterns.some((pattern) => usableConfigAlias(pattern)) &&
      hostPatternMatches(alias, record.patterns),
    ),
  ).map((alias) => {
    const result = {
      alias,
      configAlias: alias,
      host: alias,
      hostName: null,
      hostname: null,
      username,
      user: username,
      port: 22,
      identityFile: null,
      agentSocket: null,
      source,
    };
    const assigned = new Set();
    for (const record of records) {
      if (record.patterns && !hostPatternMatches(alias, record.patterns)) continue;
      for (const directive of record.directives) {
        const key = directive.key;
        if (key === "hostname" && !assigned.has("hostName")) {
          const value = firstConfigValue(directive.values);
          if (value) {
            result.hostName = value;
            result.hostname = value;
            assigned.add("hostName");
          }
        } else if (key === "user" && !assigned.has("username")) {
          const value = firstConfigValue(directive.values);
          if (value) {
            result.username = value;
            result.user = value;
            assigned.add("username");
          }
        } else if (key === "port" && !assigned.has("port")) {
          const value = firstConfigValue(directive.values, "port");
          const port = value ? Number(value) : NaN;
          if (Number.isInteger(port) && port >= 1 && port <= 65535) {
            result.port = port;
            assigned.add("port");
          }
        } else if (key === "identityfile" && !assigned.has("identityFile")) {
          const value = firstConfigValue(directive.values);
          if (value) {
            result.identityFile = value;
            assigned.add("identityFile");
          }
        } else if (key === "identityagent" && !assigned.has("agentSocket")) {
          const value = firstConfigValue(directive.values);
          if (value) {
            result.agentSocket = value;
            assigned.add("agentSocket");
          }
        }
      }
    }
    return result;
  });
}

function configGlobRegExp(pattern) {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") source += ".*";
    else if (character === "?") source += ".";
    else if (character === "[") {
      const end = pattern.indexOf("]", index + 1);
      if (end > index + 1) {
        const set = pattern.slice(index + 1, end).replace(/[\\\\^]/g, "\\\\$&");
        source += `[${set}]`;
        index = end;
      } else source += "\\\\[";
    } else source += character.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&");
  }
  return new RegExp(`${source}$`);
}

function configPathParts(value) {
  const normalized = String(value || "").replace(/\\/g, "/");
  const parsed = path.parse(normalized);
  const root = parsed.root || "";
  return { root: root || ".", parts: normalized.slice(root.length).split("/").filter(Boolean) };
}

function expandConfigPattern(pattern, baseDirectory, state) {
  const expanded = expandUserPath(String(pattern || "").trim());
  if (
    !expanded ||
    expanded.includes("%") ||
    expanded.includes(String.fromCharCode(0)) ||
    expanded.includes("\r") ||
    expanded.includes("\n")
  ) return [];
  const absolute = path.isAbsolute(expanded) ? expanded : path.resolve(baseDirectory, expanded);
  const { root, parts } = configPathParts(absolute);
  const matches = [];
  const visit = (directory, index, depth) => {
    if (matches.length >= MAX_CONFIG_INCLUDE_MATCHES || depth > MAX_CONFIG_INCLUDE_DEPTH + 2) return;
    const segment = parts[index];
    if (segment === undefined) {
      try {
        if (fs.statSync(directory).isFile()) matches.push(path.resolve(directory));
      } catch {
        // An unavailable optional Include is ignored.
      }
      return;
    }
    if (segment === "**") {
      visit(directory, index + 1, depth);
      try {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          if (entry.isDirectory() && !entry.isSymbolicLink()) visit(path.join(directory, entry.name), index, depth + 1);
        }
      } catch {
        // An unreadable directory fails closed.
      }
      return;
    }
    const wildcard = /[*?\[]/.test(segment);
    if (!wildcard) {
      const next = path.join(directory, segment);
      try {
        const stat = fs.lstatSync(next);
        if (index === parts.length - 1) {
          if (stat.isFile() && !stat.isSymbolicLink()) matches.push(path.resolve(next));
        } else if (stat.isDirectory() && !stat.isSymbolicLink()) visit(next, index + 1, depth);
      } catch {
        // An unavailable optional Include is ignored.
      }
      return;
    }
    try {
      const entries = fs.readdirSync(directory, { withFileTypes: true })
        .filter((entry) => configGlobRegExp(segment).test(entry.name))
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const next = path.join(directory, entry.name);
        if (index === parts.length - 1) {
          if (entry.isFile() && !entry.isSymbolicLink()) matches.push(path.resolve(next));
        } else if (entry.isDirectory() && !entry.isSymbolicLink()) visit(next, index + 1, depth);
      }
    } catch {
      // An unreadable optional Include is ignored.
    }
  };
  visit(root, 0, 0);
  const directory = path.dirname(absolute);
  const basename = path.basename(absolute);
  if (!matches.length && /[*?\[]/.test(basename)) {
    const matcher = configGlobRegExp(basename);
    try {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isFile() && !entry.isSymbolicLink() && matcher.test(entry.name)) {
          matches.push(path.resolve(directory, entry.name));
        }
      }
    } catch {
      // An unreadable optional Include is ignored.
    }
  }
  return matches.slice(0, MAX_CONFIG_INCLUDE_MATCHES);
}

function expandConfigFile(filePath, state, depth = 0) {
  if (depth > MAX_CONFIG_INCLUDE_DEPTH || state.files >= MAX_CONFIG_FILES) return "";
  let resolved;
  try {
    resolved = fs.realpathSync(filePath);
    if (state.visited.has(resolved)) return "";
    const stat = fs.statSync(resolved);
    if (!stat.isFile() || stat.size > MAX_CONFIG_FILE_BYTES) return "";
    if (state.totalBytes + stat.size > MAX_CONFIG_TOTAL_BYTES) return "";
    state.visited.add(resolved);
    state.files += 1;
    state.totalBytes += stat.size;
    const content = fs.readFileSync(resolved, "utf8");
    let output = "";
    for (const line of content.split(/\r?\n/)) {
      const directive = parseConfigDirective(line);
      if (directive?.key !== "include") {
        output += line + String.fromCharCode(10);
        continue;
      }
      for (const includePattern of directive.values) {
        for (const included of expandConfigPattern(includePattern, path.dirname(resolved), state)) {
          output += expandConfigFile(included, state, depth + 1);
        }
      }
    }
    return output;
  } catch {
    return null;
  }
}

function configProfileId(alias) {
  const digest = crypto.createHash("sha256").update(String(alias)).digest("hex").slice(0, 24);
  return `config-${digest}`;
}

function configPathValue(value) {
  const result = String(value || "").trim();
  if (!result || result.toLowerCase() === "none") return null;
  const absolute = result.startsWith("/") || result === "~" || result.startsWith("~/") || result.startsWith("~\\") || /^[A-Za-z]:[\\/]/.test(result);
  // OpenSSH expands these tokens itself. They are safe as one argv value, but
  // an unqualified path is not accepted by the manual profile validator.
  return absolute || /^%[A-Za-z%]/.test(result) ? result : null;
}

function normalizeConfigCandidate(candidate, options = {}) {
  const input = {
    id: configProfileId(candidate.alias),
    name: candidate.alias,
    host: candidate.alias,
    hostName: candidate.hostName,
    username: candidate.username || localOsUsername(),
    port: candidate.port,
    identityFile: configPathValue(candidate.identityFile),
    agentSocket: candidate.agentSocket === "SSH_AUTH_SOCK" ? candidate.agentSocket : configPathValue(candidate.agentSocket),
    configAlias: candidate.alias,
    source: candidate.source || options.source,
  };
  try {
    return normalizeProfile(input);
  } catch {
    return null;
  }
}

/** Discover normalized host profiles from the local user's OpenSSH config. */
function resolveConfigPath(value) {
  const requested = value
    ? expandUserPath(String(value).trim())
    : path.join(os.homedir(), ".ssh", "config");
  return path.resolve(requested);
}

function discoverSshProfiles(options = {}) {
  const configPath = resolveConfigPath(options.configPath);
  const state = { visited: new Set(), files: 0, totalBytes: 0 };
  const expanded = expandConfigFile(configPath, state);
  if (expanded === null) return [];
  const candidates = parseOpenSSHConfig(expanded, {
    source: configPath,
    username: options.username,
  });
  return candidates.map((candidate) => normalizeConfigCandidate(candidate, { source: configPath })).filter(Boolean);
}

function buildTarget(profile) {
  // Imported profiles deliberately use the alias as the SSH target. This lets
  // OpenSSH re-evaluate the complete Host stanza instead of flattening it into
  // a partial -p/-i override (ProxyJump, Match, multiple IdentityFile entries,
  // and other directives must keep their native semantics).
  return profile.configAlias ? profile.host : `${profile.username}@${profile.host}`;
}

function isDefaultSshConfig(value) {
  if (!value) return false;
  const comparable = (candidate) => {
    const resolved = path.resolve(expandUserPath(candidate));
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return comparable(value) === comparable(path.join(os.homedir(), ".ssh", "config"));
}

function buildSshArgs(profile, options = {}) {
  const timeoutSeconds = normalizeTimeout(options.timeoutSeconds);
  const hasPassword = Boolean(options.password);
  const hostKeyPolicy = options.acceptNewHostKey === true
    ? "accept-new"
    : profile.strictHostKeyChecking;
  const args = [
    // One-shot commands must never inherit the plugin process's stdin. An
    // attached stdin can leave OpenSSH waiting for input after the panel has
    // already timed out, especially when the remote side requests a banner.
    "-n",
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
    // Windows OpenSSH reports some transport failures (for example
    // "banner exchange: ... Connection refused") below ERROR. Suppressing
    // those lines turns a useful failure into an opaque exit 255.
    "LogLevel=INFO",
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
  if (profile.identityFile) {
    args.push("-i", expandUserPath(profile.identityFile));
    // Imported aliases keep OpenSSH config semantics (ProxyJump, extra
    // IdentityFile entries). IdentitiesOnly would flatten those away.
    if (!profile.configAlias) args.push("-o", "IdentitiesOnly=yes");
  }
  // A profile imported from a non-default config must keep using that file.
  // Do not pass -F for ~/.ssh/config: OpenSSH would then skip its system-wide
  // configuration, changing behavior compared with a normal ssh invocation.
  if (profile.configAlias && profile.source && !isDefaultSshConfig(profile.source)) {
    args.push("-F", resolveConfigPath(profile.source));
  }
  if (!profile.configAlias && profile.port !== 22) args.push("-p", String(profile.port));
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

function sshPathEntries(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === "win32") {
    const systemRoot = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows";
    const programFiles = env.ProgramFiles || "C:\\Program Files";
    return [
      path.join(systemRoot, "System32", "OpenSSH"),
      path.join(programFiles, "Git", "usr", "bin"),
      path.join(programFiles, "Git", "cmd"),
      path.join(home, "AppData", "Local", "Programs", "Git", "usr", "bin"),
    ];
  }
  return ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
}

function mergePath(existing, options = {}) {
  const platform = options.platform || process.platform;
  const sep = platform === "win32" ? ";" : ":";
  const parts = String(existing || "").split(sep).map((entry) => entry.trim()).filter(Boolean);
  const keyOf = (value) => (platform === "win32" ? value.toLowerCase() : value);
  const seen = new Set(parts.map(keyOf));
  for (const extra of sshPathEntries(platform, options.env || process.env, options.home || os.homedir())) {
    const key = keyOf(extra);
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(extra);
  }
  if (parts.length) return parts.join(sep);
  return platform === "win32" ? "" : "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
}

function inheritWindowsEnv(env, processEnv = process.env, platform = process.platform) {
  if (platform !== "win32") return env;
  for (const key of WINDOWS_ENV_KEEP) {
    if (processEnv[key] && env[key] === undefined) env[key] = processEnv[key];
  }
  const systemRoot = env.SYSTEMROOT || env.SystemRoot || env.WINDIR || env.windir || "C:\\Windows";
  if (!env.SYSTEMROOT) env.SYSTEMROOT = systemRoot;
  if (!env.SystemRoot) env.SystemRoot = systemRoot;
  if (!env.WINDIR) env.WINDIR = systemRoot;
  if (!env.windir) env.windir = systemRoot;
  if (!env.COMSPEC && !env.ComSpec) {
    env.COMSPEC = path.join(systemRoot, "System32", "cmd.exe");
    env.ComSpec = env.COMSPEC;
  }
  if (!env.PATHEXT) env.PATHEXT = ".COM;.EXE;.BAT;.CMD;.VBS;.JS;.MSC";
  if (env.PATH && !env.Path) env.Path = env.PATH;
  return env;
}

function resolveSshCommand(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== "win32") return "ssh";
  const env = options.env || process.env;
  const home = options.home || os.homedir();
  const existsSync = options.existsSync || fs.existsSync;
  for (const directory of sshPathEntries(platform, env, home)) {
    const candidate = path.join(directory, "ssh.exe");
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // Keep searching; execFile can still look up ssh.exe on PATH.
    }
  }
  return "ssh.exe";
}

function killChild(child) {
  if (!child || typeof child.kill !== "function") return;
  try {
    if (process.platform === "win32") child.kill();
    else child.kill("SIGTERM");
  } catch {
    // The process may already have exited.
  }
}

function killActiveProcesses() {
  for (const timer of [...activeTimers]) {
    clearTimeout(timer);
    activeTimers.delete(timer);
  }
  for (const child of [...activeProcesses]) {
    activeProcesses.delete(child);
    killChild(child);
  }
  for (const broker of [...activeAskpassBrokers]) broker.cleanup();
}

function buildEnvironment(profile, options = {}) {
  const home = os.homedir();
  const processEnv = options.processEnv || process.env;
  const platform = options.platform || process.platform;
  const pathValue = processEnv.PATH || processEnv.Path;
  const env = {
    PATH: mergePath(pathValue, { platform, env: processEnv, home }),
    HOME: home,
    USERPROFILE: processEnv.USERPROFILE || home,
    LANG: processEnv.LANG || "en_US.UTF-8",
  };
  inheritWindowsEnv(env, processEnv, platform);
  const configuredSocket = profile.agentSocket;
  const socket = configuredSocket && configuredSocket !== "SSH_AUTH_SOCK"
    ? expandUserPath(configuredSocket)
    : processEnv.SSH_AUTH_SOCK;
  if (socket) env.SSH_AUTH_SOCK = socket;
  if (options.askpassPath) {
    env.SSH_ASKPASS = options.askpassPath;
    env.SSH_ASKPASS_REQUIRE = "force";
    env.DISPLAY = "pi-ssh-manager";
    env.PI_SSH_ASKPASS_NODE = process.execPath;
    env.PI_SSH_ASKPASS_SCRIPT = path.join(__dirname, "askpass-client.js");
    // PI-Desktop uses its Electron executable as the plugin's Node runtime.
    // This flag is harmless under stock Node and required under Electron.
    env.ELECTRON_RUN_AS_NODE = "1";
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
    profile?.identityFile,
    profile?.agentSocket,
    profile?.source,
    profile?.identityFile ? expandUserPath(profile.identityFile) : null,
    profile?.agentSocket ? expandUserPath(profile.agentSocket) : null,
    profile?.source ? expandUserPath(profile.source) : null,
  ]) {
    if (candidate) output = output.split(candidate).join("[local credential path]");
  }
  return output;
}

function decodeProcessOutput(value) {
  if (value == null) return "";
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return String(value);
}

function extractSshDiagnostic(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^debug\d?:/i.test(line));
  const interesting = lines.filter((line) => SSH_DIAGNOSTIC_PATTERN.test(line));
  if (interesting.length) return interesting.join("\n");
  return lines.slice(-8).join("\n");
}

function formatSshFailure(result, profile) {
  const stderr = decodeProcessOutput(result?.stderr).trim();
  const stdout = decodeProcessOutput(result?.stdout).trim();
  const diagnostic = extractSshDiagnostic([stderr, stdout].filter(Boolean).join("\n"));
  const spawnCode = result?.error && typeof result.error.code === "string" ? result.error.code : null;
  const parts = [];
  if (result?.timedOut) parts.push("SSH command timed out.");
  if (spawnCode === "ENOENT") {
    parts.push("Unable to start ssh: the OpenSSH client was not found on PATH.");
    parts.push("Install OpenSSH Client (Windows optional feature) or add ssh.exe to PATH.");
  } else if (diagnostic) {
    parts.push(diagnostic);
  } else if (numericExitCode(result?.exitCode) !== null) {
    parts.push(`ssh exited with code ${numericExitCode(result.exitCode)}.`);
  } else if (result?.error) {
    parts.push(String(result.error.message || result.error));
  } else {
    parts.push("SSH connection failed.");
  }
  if (!diagnostic && !result?.timedOut && (numericExitCode(result?.exitCode) === 255 || spawnCode === "ENOENT")) {
    parts.push("Typical causes: unknown host key (use Accept new), missing identity/password, unreachable host/port, or a missing system ssh client.");
  }
  const text = redactLocalPaths(parts.join(" "), profile || {});
  return text.length > 1200 ? `${text.slice(0, 1168).trimEnd()}…` : text;
}

function numericExitCode(value) {
  if (Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

function createAskpassHelper() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ssh-"));
  const windows = process.platform === "win32";
  const file = path.join(directory, windows ? "askpass.cmd" : "askpass.sh");
  const endpoint = windows
    ? `\\\\.\\pipe\\pi-ssh-${crypto.randomUUID()}`
    : path.join(directory, "askpass.sock");
  const token = crypto.randomBytes(32).toString("hex");
  const shellQuote = (value) => `'${String(value).replace(/'/g, `'"'"'`)}'`;
  const launcher = windows
    ? [
      "@echo off",
      "setlocal DisableDelayedExpansion",
      `set "PI_SSH_ASKPASS_ENDPOINT=${endpoint}"`,
      `set "PI_SSH_ASKPASS_TOKEN=${token}"`,
      "\"%PI_SSH_ASKPASS_NODE%\" \"%PI_SSH_ASKPASS_SCRIPT%\"",
      "",
    ].join("\r\n")
    : [
      "#!/bin/sh",
      `PI_SSH_ASKPASS_ENDPOINT=${shellQuote(endpoint)}`,
      `PI_SSH_ASKPASS_TOKEN=${shellQuote(token)}`,
      "export PI_SSH_ASKPASS_ENDPOINT PI_SSH_ASKPASS_TOKEN",
      "exec \"$PI_SSH_ASKPASS_NODE\" \"$PI_SSH_ASKPASS_SCRIPT\"",
      "",
    ].join("\n");
  fs.writeFileSync(file, launcher, { encoding: "utf8", mode: 0o700 });
  return {
    directory,
    endpoint,
    file,
    token,
    cleanup() {
      try {
        fs.unlinkSync(file);
      } catch {
        // Best effort: the launcher contains no password or user credential.
      }
      try {
        fs.rmdirSync(directory);
      } catch {
        // Best effort cleanup after the short-lived ssh process exits.
      }
    },
  };
}

function askpassTokensEqual(value, expected) {
  const left = Buffer.from(String(value || ""));
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

async function createAskpassBroker(password) {
  const helper = createAskpassHelper();
  const { endpoint, token } = helper;
  const sockets = new Set();
  let served = false;
  let cleaned = false;
  let cancelListen = null;
  let broker = null;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let request = "";
    const timer = setTimeout(() => socket.destroy(), ASKPASS_BROKER_TIMEOUT_MS);
    socket.on("data", (chunk) => {
      if (served) {
        socket.destroy();
        return;
      }
      request += chunk;
      if (request.length > token.length + 2) {
        socket.destroy();
        return;
      }
      const newline = request.indexOf("\n");
      if (newline < 0) return;
      const supplied = request.slice(0, newline).replace(/\r$/, "");
      if (!askpassTokensEqual(supplied, token)) {
        socket.destroy();
        return;
      }
      served = true;
      socket.end(`${password}\n`);
      try {
        server.close();
      } catch {
        // The first authenticated request may already have closed the server.
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      clearTimeout(timer);
      sockets.delete(socket);
    });
  });
  // Prevent a late server error from escaping the plugin process. Listen-time
  // failures are still forwarded through the one-shot listener below.
  server.on("error", () => {});

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (broker) activeAskpassBrokers.delete(broker);
    if (cancelListen) cancelListen();
    for (const socket of [...sockets]) socket.destroy();
    try {
      server.close();
    } catch {
      // The one-shot broker may not be listening yet or may already be closed.
    }
    if (process.platform !== "win32") {
      try {
        fs.unlinkSync(endpoint);
      } catch {
        // Node normally removes the socket path when the server closes.
      }
    }
    helper.cleanup();
  };
  broker = { endpoint, token, cleanup };
  activeAskpassBrokers.add(broker);

  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const settle = (handler, value) => {
        if (settled) return;
        settled = true;
        cancelListen = null;
        server.off("error", onError);
        handler(value);
      };
      const onError = (error) => settle(reject, error);
      cancelListen = () => {
        const error = new Error("SSH askpass broker was cancelled");
        error.code = "ASKPASS_CANCELLED";
        settle(reject, error);
      };
      server.once("error", onError);
      server.listen(endpoint, () => settle(resolve));
    });
  } catch (error) {
    cleanup();
    throw error;
  }
  return { file: helper.file, endpoint, token, cleanup };
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
      if (timer) {
        clearTimeout(timer);
        activeTimers.delete(timer);
      }
      if (child) activeProcesses.delete(child);
      resolve({
        error,
        stdout: decodeProcessOutput(stdout),
        stderr: decodeProcessOutput(stderr),
        timedOut,
      });
    };

    timer = setTimeout(() => {
      timedOut = true;
      killChild(child);
      finish(new Error("SSH command timed out"), "", "SSH command timed out");
    }, options.timeoutSeconds * 1000);
    activeTimers.add(timer);

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
      if (child) {
        activeProcesses.add(child);
        if (typeof child.on === "function") {
          child.on("error", (error) => {
            finish(error, "", decodeProcessOutput(error?.message));
          });
        }
      }
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
  const askpass = password ? await createAskpassBroker(password) : null;
  try {
    const args = buildSshArgs(normalized, {
      remoteCommand: options.remoteCommand,
      timeoutSeconds,
      acceptNewHostKey: options.acceptNewHostKey,
      password,
    });
    const result = await runProcess(resolveSshCommand(), args, {
      timeoutSeconds: timeoutSeconds + 5,
      env: buildEnvironment(normalized, {
        askpassPath: askpass?.file,
      }),
    });
    const stdout = clip(result.stdout, maxOutputChars);
    const stderr = clip(redactLocalPaths(result.stderr, normalized), maxOutputChars);
    const numericCode = result.error ? numericExitCode(result.error.code) : null;
    const exitCode = numericCode !== null ? numericCode : result.error ? null : 0;
    const error = result.timedOut
      ? "SSH command timed out"
      : result.error
        ? formatSshFailure({
          ...result,
          stdout: stdout.text,
          stderr: stderr.text,
          exitCode,
        }, normalized)
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
  { pattern: /[\u0000\r\n]/, reason: "control characters" },
  { pattern: /`|\$\(|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/, reason: "shell substitution or variable expansion" },
  { pattern: /[;&|<>]/, reason: "shell chaining, pipeline, or redirection" },
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:/i, reason: "fork bomb" },
  { pattern: /\b(?:rm|rmdir|unlink|shred|srm|wipefs)\b/i, reason: "file deletion or wiping" },
  { pattern: /\bfind\b[^\r\n]*\s-delete\b/i, reason: "find-based deletion" },
  { pattern: /\b(?:rsync)\b[^\r\n]*\s--delete(?:-before|-during|-delay)?\b/i, reason: "synchronization deletion" },
  { pattern: /\b(?:mkfs|fdisk|sfdisk|cfdisk|parted|mount|umount|losetup)\b/i, reason: "disk or mount mutation" },
  { pattern: /\b(?:dd|truncate)\b/i, reason: "raw or truncated file write" },
  { pattern: /\b(?:shutdown|reboot|poweroff|halt)\b/i, reason: "host power operation" },
  { pattern: /\b(?:systemctl|service|rc-service)\b[^\r\n]*\b(?:stop|start|restart|reload|disable|enable|mask|unmask|kill)\b/i, reason: "service state mutation" },
  { pattern: /\b(?:kill|pkill|killall)\b/i, reason: "process termination" },
  { pattern: /\b(?:sudo|doas|su)\b/i, reason: "privilege escalation" },
  { pattern: /\b(?:passwd|useradd|usermod|userdel|groupadd|groupdel)\b/i, reason: "account or credential mutation" },
  { pattern: /\b(?:chmod|chown|chgrp|setfacl)\b/i, reason: "permission or ownership mutation" },
  { pattern: /\b(?:crontab|at)\b/i, reason: "scheduled task mutation" },
  { pattern: /\bgit\s+(?:clean\b|reset\s+--hard\b|restore\b|checkout\s+--|branch\s+-D\b|push\b|rebase\b|stash\s+(?:drop|clear)\b)/i, reason: "destructive or external Git mutation" },
  { pattern: /\b(?:docker|podman)\b[^\r\n]*\b(?:rm|rmi|system\s+prune|volume\s+(?:rm|prune)|container\s+(?:rm|prune)|image\s+prune)\b/i, reason: "container or image deletion" },
  { pattern: /\b(?:kubectl)\b[^\r\n]*\bdelete\b/i, reason: "Kubernetes resource deletion" },
  { pattern: /\b(?:helm)\b[^\r\n]*\buninstall\b/i, reason: "Helm release deletion" },
  { pattern: /\b(?:terraform|pulumi)\b[^\r\n]*\b(?:destroy|apply)\b/i, reason: "infrastructure mutation" },
  { pattern: /\b(?:apt(?:-get)?|dnf|yum|zypper|pacman|apk|brew|pip|npm|pnpm|yarn)\b[^\r\n]*\b(?:install|remove|uninstall|purge|autoremove|upgrade|dist-upgrade|erase|prune)\b/i, reason: "package or dependency mutation" },
  { pattern: /\b(?:drop|truncate)\s+(?:database|schema|table|index|view)\b/i, reason: "database structure deletion" },
  { pattern: /\bdelete\s+from\b/i, reason: "database row deletion" },
  { pattern: /\bupdate\s+[^\r\n]+\s+set\b/i, reason: "database data mutation" },
  { pattern: /\b(?:redis-cli)\b[^\r\n]*\b(?:flushall|flushdb)\b/i, reason: "database-wide deletion" },
  { pattern: /\b(?:sed|perl)\b[^\r\n]*\s-(?:i|pi)\b|\btee\b/i, reason: "in-place or redirected file write" },
  { pattern: /\b(?:curl|wget|fetch|nc|netcat|socat)\b/i, reason: "network transfer or remote execution" },
  { pattern: /\b(?:eval|exec|source)\b|\b(?:sh|bash|zsh|fish|python(?:3)?|perl|ruby|php|node)\b\s+(?:-c|--eval|-e)\b/i, reason: "dynamic code or shell execution" },
  { pattern: /\b(?:ssh|scp|sftp|ftp)\b/i, reason: "nested remote access" },
];

function findCommandRisk(command) {
  const value = String(command ?? "");
  if (!value.trim()) return "Blocked by default: command is empty. Provide a bounded read-only command.";
  if (value.length > MAX_COMMAND_CHARS) {
    return `Blocked by default: command exceeds ${MAX_COMMAND_CHARS} characters. Keep the command bounded.`;
  }
  const match = COMMAND_RISK_RULES.find((rule) => rule.pattern.test(value));
  return match
    ? `Blocked by default: ${match.reason}. Ask the user to review it in the SSH Manager panel and check the one-time approval box; AI cannot override this guard.`
    : null;
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
  parseOpenSSHConfig,
  parseSshConfig: parseOpenSSHConfig,
  discoverSshProfiles,
  scanLocalSshConfig: discoverSshProfiles,
  findCommandRisk,
  formatSshFailure,
  killActiveProcesses,
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
      killActiveProcesses();
    },
    clip,
    buildEnvironment,
    inheritWindowsEnv,
    mergePath,
    resolveSshCommand,
    parseConfigDirective,
    configGlobRegExp,
    configPathParts,
    expandConfigPattern,
    expandConfigFile,
    resolveConfigPath,
    activeProcessCount() {
      return activeProcesses.size;
    },
    activeAskpassBrokerCount() {
      return activeAskpassBrokers.size;
    },
    activeAskpassBrokerSnapshot() {
      const broker = activeAskpassBrokers.values().next().value;
      return broker ? { endpoint: broker.endpoint, token: broker.token } : null;
    },
  },
};
