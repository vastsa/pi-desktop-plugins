"use strict";

const os = require("node:os");
const path = require("node:path");
const { createPtyHost } = require("./pty");
const shell = require("./shell");
const env = require("./env");

const COMMAND_ID = "pi.terminal.open";
const SERVICE_ID = "pty-host";

const host = createPtyHost({ pluginRoot: __dirname });
let loginEnvPromise = null;

function clamp(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

async function workspacePath() {
  try {
    const workspace = await pi.workspace.get();
    return workspace && workspace.path ? workspace.path : null;
  } catch {
    return null;
  }
}

async function currentScope() {
  const workspace = await workspacePath();
  return {
    workspace,
    key: shell.workspaceKey(workspace),
  };
}

async function appLocale() {
  try {
    return (await pi.app.getLocale()) || "en";
  } catch {
    return "en";
  }
}

function loginEnv() {
  if (!loginEnvPromise) {
    loginEnvPromise = (async () => {
      const locale = await appLocale();
      return env.captureLoginEnv({ locale });
    })();
  }
  return loginEnvPromise;
}

async function loadConfig() {
  let settings = {};
  try {
    settings = (await pi.plugin.getSettings()) || {};
  } catch {
    settings = {};
  }
  const fontSize = clamp(settings.fontSize, 10, 24, 13);
  const scrollback = clamp(settings.scrollback, 200, 20000, 5000);
  const maxSessions = clamp(settings.maxSessions, 1, 32, 8);
  host.configure({
    maxSessions,
    scrollbackBytes: scrollback * 256,
  });
  const builtin = shell.discoverBuiltinProfiles();
  const user = shell.normalizeUserProfiles(settings.profiles);
  return {
    fontSize,
    scrollback,
    maxSessions,
    profiles: shell.mergeProfiles(builtin, user),
  };
}

async function openWorkView() {
  let locale = "en";
  try {
    locale = await pi.app.getLocale();
  } catch {
    locale = "en";
  }
  const zh = String(locale || "").toLowerCase().startsWith("zh");
  const toast = zh
    ? "终端只在右侧工作面板中打开。按 Mod+J，再选择「终端」。"
    : "Terminal lives in the work panel. Press Mod+J, then choose Terminal.";
  await pi.ui.showToast(toast, "info").catch(() => {});
}

async function onLoad() {
  loginEnv();
  await pi.commands.register({
    id: COMMAND_ID,
    title: "Terminal: Open",
    keywords: ["terminal", "shell", "pty", "otty", "console", "终端", "命令行", "控制台"],
    category: "Developer",
    run: () => openWorkView(),
  });
  pi.services.register({
    id: SERVICE_ID,
    start: async () => {
      await host.start();
    },
    stop: async () => {
      await host.stop();
    },
  });
}

async function onPanelInvoke(channel, payload = {}) {
  const args = payload && typeof payload === "object" ? payload : {};
  const sessionId = String(args.sessionId || args.id || "");
  switch (channel) {
    case "pty.bootstrap": {
      const config = await loadConfig();
      const userEnv = await loginEnv();
      const scope = await currentScope();
      return {
        ok: true,
        ...config,
        sessions: host.list({ workspace: scope.key }),
        workspace: scope.workspace,
        workspaceKey: scope.key,
        home: os.homedir(),
        platform: process.platform,
        pathPreview: String(userEnv.PATH || userEnv.Path || "")
          .split(process.platform === "win32" ? ";" : ":")
          .slice(0, 6),
      };
    }
    case "pty.list": {
      const scope = await currentScope();
      return {
        ok: true,
        workspace: scope.workspace,
        workspaceKey: scope.key,
        sessions: host.list({ workspace: scope.key }),
      };
    }
    case "pty.spawn": {
      const config = await loadConfig();
      const profile =
        config.profiles.find((item) => item.id === (args.profileId || "default")) || config.profiles[0];
      if (!profile) return { ok: false, error: "no shell profile available" };
      const userEnv = await loginEnv();
      const cwd = args.cwd || profile.cwd;
      const scope = await currentScope();
      const resolvedCwd = (() => {
        try {
          return shell.resolveAllowedCwd(cwd, { workspace: scope.workspace, home: os.homedir() });
        } catch {
          return scope.workspace || os.homedir();
        }
      })();
      return host.spawn({
        profileId: profile.id,
        title: path.basename(resolvedCwd) || profile.name,
        shell: profile.shell,
        args: profile.args,
        argv0: profile.argv0 || env.loginArgv0(profile.shell),
        env: { ...userEnv, ...(profile.env || {}) },
        cwd: resolvedCwd,
        workspace: scope.workspace,
        cols: args.cols,
        rows: args.rows,
      });
    }
    case "pty.write": {
      const scope = await currentScope();
      return host.write(sessionId, args.data || "", { workspace: scope.key });
    }
    case "pty.resize": {
      const scope = await currentScope();
      return host.resize(sessionId, args.cols, args.rows, { workspace: scope.key });
    }
    case "pty.kill": {
      const scope = await currentScope();
      return host.kill(sessionId, { workspace: scope.key });
    }
    case "pty.drain": {
      const scope = await currentScope();
      return host.drain(sessionId, {
        afterSeq: args.afterSeq,
        waitMs: args.waitMs,
        workspace: scope.key,
      });
    }
    case "pty.setPref": {
      const patch = {};
      if (Number.isFinite(args.fontSize)) patch.fontSize = clamp(args.fontSize, 10, 24, 13);
      if (Object.keys(patch).length) {
        try {
          await pi.plugin.setSettings(patch);
        } catch {
          /* generated settings UI is the other writer */
        }
      }
      return { ok: true, ...patch };
    }
    default: {
      const error = new Error(`Unsupported terminal channel: ${channel}`);
      error.code = "UNSUPPORTED";
      throw error;
    }
  }
}

async function onUnload() {
  await host.stop();
  loginEnvPromise = null;
  try {
    await pi.services.unregister(SERVICE_ID);
  } catch {
    /* host may already have stopped the service */
  }
  try {
    await pi.commands.unregister(COMMAND_ID);
  } catch {
    /* ignore */
  }
}

module.exports = {
  onLoad,
  onUnload,
  onPanelInvoke,
  __test: { host, loadConfig, COMMAND_ID, SERVICE_ID },
};
