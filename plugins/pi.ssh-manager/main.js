"use strict";

/**
 * pi.ssh-manager plugin process.
 *
 * Profiles contain connection metadata only. The plugin delegates auth to
 * OpenSSH, ssh-agent, the user's SSH config, an identity-file path, or a
 * user-entered password held in memory for a short time. A
 * "session" is intentionally logical: each command starts a bounded ssh
 * process, so no private key or remote transcript remains in a long-lived
 * plugin object.
 */

const ssh = require("./ssh");

const COMMAND_ID = "pi.ssh-manager.open";
const TOOL_NAMES = ["ssh_list_hosts", "ssh_connect", "ssh_execute", "ssh_disconnect"];
const SESSION_TTL_MS = 30 * 60 * 1000;
const PASSWORD_TTL_MS = 30 * 60 * 1000;
const sessions = new Map();
const profilePasswords = new Map();
let store = ssh.normalizeStore({});
let loaded = false;
let persistQueue = Promise.resolve();

function now() {
  return Date.now();
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || "Unknown SSH error");
}

function requiredText(value, field) {
  const result = String(value ?? "").trim();
  if (!result) throw new Error(`${field} is required`);
  return result;
}

async function loadStore() {
  if (loaded) return store;
  let settings = {};
  try {
    settings = (await pi.plugin.getSettings()) || {};
  } catch {
    settings = {};
  }
  store = ssh.normalizeStore(settings);
  loaded = true;
  pruneSessions();
  return store;
}

async function persistStore() {
  const snapshot = {
    version: 1,
    profiles: store.profiles.map((profile) => ({ ...profile })),
  };
  persistQueue = persistQueue
    .catch(() => {})
    .then(() => pi.plugin.setSettings(snapshot));
  return persistQueue;
}

function setProfilePassword(profileId, value) {
  const password = ssh.normalizePassword(value);
  if (!password) return;
  profilePasswords.set(profileId, { value: password, updatedAt: now() });
}

function clearProfilePassword(profileId) {
  profilePasswords.delete(profileId);
}

function getProfilePassword(profileId) {
  const record = profilePasswords.get(profileId);
  if (!record) return null;
  if (record.updatedAt + PASSWORD_TTL_MS < now()) {
    profilePasswords.delete(profileId);
    return null;
  }
  record.updatedAt = now();
  return record.value;
}

function passwordConfigured(profileId) {
  return Boolean(getProfilePassword(profileId));
}

function panelProfile(profile) {
  return {
    ...ssh.profileForPanel(profile),
    passwordConfigured: passwordConfigured(profile.id),
  };
}

function agentProfile(profile) {
  return {
    ...ssh.profileForAgent(profile),
    passwordConfigured: passwordConfigured(profile.id),
  };
}

function findProfile(id) {
  const profileId = requiredText(id, "profile_id");
  return store.profiles.find((profile) => profile.id === profileId) || null;
}

function profileNotFound(id) {
  return { ok: false, error: `SSH profile not found: ${String(id || "")}` };
}

function sessionView(session) {
  const profile = store.profiles.find((item) => item.id === session.profileId);
  if (!profile) return null;
  return {
    id: session.id,
    profileId: profile.id,
    name: profile.name,
    host: profile.host,
    port: profile.port,
    username: profile.username,
    connectedAt: session.connectedAt,
    lastUsedAt: session.lastUsedAt,
  };
}

function pruneSessions() {
  const cutoff = now() - SESSION_TTL_MS;
  for (const [id, session] of sessions) {
    if (session.lastUsedAt < cutoff || !store.profiles.some((profile) => profile.id === session.profileId)) {
      sessions.delete(id);
    }
  }
  for (const [profileId, record] of profilePasswords) {
    if (
      record.updatedAt + PASSWORD_TTL_MS < now() ||
      !store.profiles.some((profile) => profile.id === profileId)
    ) {
      profilePasswords.delete(profileId);
    }
  }
}

function getSession(id) {
  pruneSessions();
  const session = sessions.get(String(id || ""));
  if (!session) return null;
  session.lastUsedAt = now();
  return session;
}

function sshFailure(result) {
  const detail = String(result.stderr || result.error || "SSH connection failed").trim();
  return detail.length > 1200 ? `${detail.slice(0, 1168).trimEnd()}…` : detail;
}

async function connectProfile(profile, options = {}) {
  const password = options.password || getProfilePassword(profile.id);
  const result = await ssh.runSsh(profile, {
    remoteCommand: "true",
    timeoutSeconds: options.timeoutSeconds,
    acceptNewHostKey: options.acceptNewHostKey === true,
    maxOutputChars: 4096,
    password,
  });
  if (!result.ok) {
    return {
      ok: false,
      error: sshFailure(result),
      exit_code: result.exitCode,
      timed_out: result.timedOut,
    };
  }
  const timestamp = new Date().toISOString();
  const session = {
    id: ssh.createSessionId(),
    profileId: profile.id,
    connectedAt: timestamp,
    lastUsedAt: now(),
  };
  sessions.set(session.id, session);
  return {
    ok: true,
    session: sessionView(session),
    session_id: session.id,
    profile_id: profile.id,
    host: profile.host,
    port: profile.port,
    username: profile.username,
  };
}

function resolveExecutionProfile(args = {}) {
  if (args.session_id) {
    const session = getSession(args.session_id);
    if (!session) return { error: "SSH session is missing or expired" };
    const profile = store.profiles.find((item) => item.id === session.profileId);
    if (!profile) return { error: "SSH profile for this session no longer exists" };
    return { profile, session };
  }
  if (args.profile_id) {
    const profile = findProfile(args.profile_id);
    if (!profile) return { error: `SSH profile not found: ${String(args.profile_id)}` };
    return { profile, session: null };
  }
  return { error: "Provide session_id or profile_id" };
}

async function executeProfile(args = {}) {
  const command = requiredText(args.command, "command");
  const target = resolveExecutionProfile(args);
  if (target.error) return { ok: false, error: target.error };

  const risk = ssh.findCommandRisk(command);
  if (risk && args.allow_destructive !== true) {
    return { ok: false, blocked: true, error: risk };
  }

  const result = await ssh.runSsh(target.profile, {
    remoteCommand: command,
    timeoutSeconds: args.timeout_seconds,
    maxOutputChars: args.max_output_chars,
    acceptNewHostKey: args.accept_new_host_key === true,
    password: getProfilePassword(target.profile.id),
  });
  if (target.session) target.session.lastUsedAt = now();
  return {
    ok: result.ok,
    session_id: target.session?.id || null,
    profile_id: target.profile.id,
    command,
    exit_code: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    output_truncated: result.outputTruncated,
    timed_out: result.timedOut,
    error: result.ok ? null : sshFailure(result),
  };
}

async function toolListHosts() {
  await loadStore();
  pruneSessions();
  return {
    ok: true,
    hosts: store.profiles.map(agentProfile),
    sessions: [...sessions.values()].map(sessionView).filter(Boolean),
    note: store.profiles.length
      ? "Host profiles expose metadata only; credentials remain in the local OpenSSH setup."
      : "No SSH host is configured. Ask the user to add one in the SSH Manager panel.",
  };
}

async function toolConnect(args = {}) {
  await loadStore();
  const profile = findProfile(args.profile_id);
  if (!profile) return profileNotFound(args.profile_id);
  return connectProfile(profile, {
    timeoutSeconds: args.timeout_seconds,
    acceptNewHostKey: args.accept_new_host_key === true,
  });
}

async function toolExecute(args = {}) {
  await loadStore();
  try {
    return await executeProfile(args);
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

async function toolDisconnect(args = {}) {
  await loadStore();
  const id = String(args.session_id || "");
  const existed = sessions.delete(id);
  return { ok: true, disconnected: existed, session_id: id || null };
}

async function safeTool(handler, args) {
  try {
    return await handler(args || {});
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

async function registerTools() {
  await pi.agent.registerTool({
    name: "ssh_list_hosts",
    description:
        "List the SSH host profiles configured in PI-Desktop. Returns only host metadata and whether an identity file, agent socket, or in-memory password is configured; never returns passwords, private-key contents, or local credential paths.",
    risk: "low",
    schema: { type: "object", properties: {} },
    execute: (args) => safeTool(toolListHosts, args),
  });

  await pi.agent.registerTool({
    name: "ssh_connect",
    description:
      "Connect to a configured SSH host using the user's local OpenSSH config, ssh-agent, identity file, or a transient password entered in the panel. This performs a real network login and is high risk. Host-key verification is strict by default; only set accept_new_host_key when the user explicitly accepts adding a new host key.",
    risk: "high",
    schema: {
      type: "object",
      properties: {
        profile_id: {
          type: "string",
          description: "The profile id returned by ssh_list_hosts.",
        },
        timeout_seconds: {
          type: "integer",
          minimum: 1,
          maximum: 60,
          description: "Connection timeout in seconds (default 20).",
        },
        accept_new_host_key: {
          type: "boolean",
          description: "Allow OpenSSH to add a previously unseen host key. Use only after explicit user approval.",
        },
      },
      required: ["profile_id"],
    },
    execute: (args) => safeTool(toolConnect, args),
  });

  await pi.agent.registerTool({
    name: "ssh_execute",
    description:
      "Execute one bounded command on a configured SSH host. Provide session_id from ssh_connect or profile_id for a one-off run. The command runs remotely through the user's shell, so treat it as high risk; destructive patterns are blocked unless the user explicitly approves and allow_destructive=true. Output is truncated and never persisted by the plugin.",
    risk: "high",
    schema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Logical session id from ssh_connect." },
        profile_id: { type: "string", description: "Profile id for a one-off command when no session_id is used." },
        command: { type: "string", description: "The remote shell command to execute." },
        timeout_seconds: { type: "integer", minimum: 1, maximum: 60, description: "Command timeout (default 20 seconds)." },
        max_output_chars: { type: "integer", minimum: 1024, maximum: 262144, description: "Maximum returned stdout/stderr characters." },
        allow_destructive: { type: "boolean", description: "Must be true only after explicit user approval for a blocked destructive command." },
        accept_new_host_key: { type: "boolean", description: "Allow a new host key for this run, only with explicit user approval." },
      },
      required: ["command"],
    },
    execute: (args) => safeTool(toolExecute, args),
  });

  await pi.agent.registerTool({
    name: "ssh_disconnect",
    description: "Forget a PI-Desktop SSH logical session. No remote process is left running because each command is bounded and one-shot.",
    risk: "low",
    schema: {
      type: "object",
      properties: { session_id: { type: "string", description: "Logical session id from ssh_connect." } },
      required: ["session_id"],
    },
    execute: (args) => safeTool(toolDisconnect, args),
  });
}

async function onLoad() {
  await loadStore();
  await pi.commands.register({
    id: COMMAND_ID,
    title: "SSH Manager: Open",
    keywords: ["ssh", "remote", "server", "terminal", "远程", "服务器", "SSH"],
    category: "Developer",
    run: async () => pi.ui.openPanel(),
  });
  await registerTools();
}

async function onPanelInvoke(channel, payload = {}) {
  await loadStore();
  const args = payload && typeof payload === "object" ? payload : {};
  switch (channel) {
    case "ssh.snapshot":
      pruneSessions();
      return {
        ok: true,
        profiles: store.profiles.map(panelProfile),
        sessions: [...sessions.values()].map(sessionView).filter(Boolean),
      };

    case "ssh.profile.save": {
      const input = args.profile && typeof args.profile === "object" ? args.profile : args;
      const existing = input.id ? store.profiles.find((profile) => profile.id === input.id) : null;
      const profile = ssh.normalizeProfile(input, existing || {});
      if (input.clearPassword === true) clearProfilePassword(profile.id);
      if (Object.prototype.hasOwnProperty.call(input, "password") && input.password !== "") {
        setProfilePassword(profile.id, input.password);
      }
      const index = store.profiles.findIndex((item) => item.id === profile.id);
      if (index >= 0) store.profiles[index] = profile;
      else store.profiles.push(profile);
      await persistStore();
      return { ok: true, profile: panelProfile(profile) };
    }

    case "ssh.profile.delete": {
      const id = requiredText(args.id, "profile id");
      const before = store.profiles.length;
      store.profiles = store.profiles.filter((profile) => profile.id !== id);
      for (const [sessionId, session] of sessions) {
        if (session.profileId === id) sessions.delete(sessionId);
      }
      clearProfilePassword(id);
      if (store.profiles.length !== before) await persistStore();
      return { ok: true, deleted: store.profiles.length !== before };
    }

    case "ssh.connect": {
      const profile = findProfile(args.profile_id);
      if (!profile) return profileNotFound(args.profile_id);
      return connectProfile(profile, {
        timeoutSeconds: args.timeout_seconds,
        acceptNewHostKey: args.accept_new_host_key === true,
      });
    }

    case "ssh.execute":
      return executeProfile(args);

    case "ssh.disconnect":
      return toolDisconnect(args);

    default: {
      const error = new Error(`Unsupported SSH panel channel: ${channel}`);
      error.code = "UNSUPPORTED";
      throw error;
    }
  }
}

async function onUnload() {
  sessions.clear();
  profilePasswords.clear();
  await pi.commands.unregister(COMMAND_ID);
  for (const name of TOOL_NAMES) await pi.agent.unregisterTool(name);
  loaded = false;
}

module.exports = {
  onLoad,
  onUnload,
  onPanelInvoke,
  __test: {
    async resetState() {
      sessions.clear();
      profilePasswords.clear();
      store = ssh.normalizeStore({});
      loaded = false;
      persistQueue = Promise.resolve();
    },
    getState() {
      return {
        profiles: store.profiles.map(panelProfile),
        sessions: [...sessions.values()].map(sessionView).filter(Boolean),
      };
    },
  },
};
