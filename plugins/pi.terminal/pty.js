"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const shell = require("./shell");

const DEFAULT_MAX_SESSIONS = 8;
const DEFAULT_SCROLLBACK_BYTES = 512 * 1024;
const DRAIN_LIMIT = 256 * 1024;
const DEFAULT_WAIT_MS = 250;

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function createPtyHost(options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const fsMod = options.fs || fs;
  const spawnFn = options.spawn || spawn;
  const pluginRoot = options.pluginRoot || __dirname;
  const helperOverride = options.helperPath || null;
  let maxSessions = options.maxSessions || DEFAULT_MAX_SESSIONS;
  let scrollbackBytes = options.scrollbackBytes || DEFAULT_SCROLLBACK_BYTES;
  const drainLimit = options.drainLimit || DRAIN_LIMIT;
  const homedir = options.homedir || os.homedir();

  let child = null;
  let starting = null;
  const sessions = new Map();
  let stdoutBuf = "";

  function helperBin() {
    if (helperOverride) return helperOverride;
    const resolved = shell.helperPath(pluginRoot, platform, arch);
    if (!resolved) {
      throw new Error(`Interactive PTY is not available on ${platform}/${arch}`);
    }
    return resolved;
  }

  function ensureExecutable(bin) {
    if (platform === "win32") return;
    try {
      fsMod.chmodSync(bin, 0o755);
    } catch {
      /* spawn will fail with a clearer error */
    }
  }

  function appendOutput(session, chunk) {
    const next = Buffer.concat([session.buffer, chunk]);
    session.endSeq += chunk.length;
    if (next.length <= scrollbackBytes) {
      session.buffer = next;
      return;
    }
    const overflow = next.length - scrollbackBytes;
    session.buffer = next.subarray(overflow);
    session.baseSeq += overflow;
  }

  function wake(session) {
    const waiters = session.waiters.splice(0, session.waiters.length);
    for (const waiter of waiters) waiter();
  }

  function handleEvent(event) {
    if (!event || typeof event !== "object") return;
    if (event.type === "data") {
      const session = sessions.get(event.id);
      if (!session) return;
      appendOutput(session, Buffer.from(String(event.data || ""), "base64"));
      wake(session);
      return;
    }
    if (event.type === "exit") {
      const session = sessions.get(event.id);
      if (!session) return;
      session.exited = true;
      session.exitCode = typeof event.code === "number" ? event.code : 0;
      wake(session);
      return;
    }
    if (event.type === "error") {
      const session = event.id ? sessions.get(event.id) : null;
      if (session) {
        session.lastError = event.message || "PTY helper error";
        wake(session);
      }
    }
  }

  function onStdout(chunk) {
    stdoutBuf += chunk;
    let index;
    while ((index = stdoutBuf.indexOf("\n")) >= 0) {
      const line = stdoutBuf.slice(0, index);
      stdoutBuf = stdoutBuf.slice(index + 1);
      if (!line.trim()) continue;
      try {
        handleEvent(JSON.parse(line));
      } catch {
        /* ignore a malformed helper line */
      }
    }
  }

  function send(message) {
    if (!child || !child.stdin || child.stdin.destroyed) {
      throw new Error("PTY helper is not running");
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function markHelperDead(error) {
    child = null;
    for (const session of sessions.values()) {
      if (session.exited) continue;
      session.exited = true;
      session.exitCode = 1;
      session.lastError = error || "PTY helper exited";
      wake(session);
    }
  }

  async function start() {
    if (child && child.exitCode == null && !child.killed) return;
    if (starting) return starting;
    starting = (async () => {
      const bin = helperBin();
      if (!fsMod.existsSync(bin)) {
        throw new Error(`PTY helper is missing: ${bin}`);
      }
      ensureExecutable(bin);
      const spawned = spawnFn(bin, [], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        windowsVerbatimArguments: platform === "win32",
      });
      child = spawned;
      stdoutBuf = "";
      spawned.stdout.setEncoding("utf8");
      spawned.stdout.on("data", onStdout);
      spawned.stderr.setEncoding("utf8");
      spawned.on("exit", () => markHelperDead("PTY helper exited"));
      spawned.on("error", (error) => markHelperDead(error.message));
    })();
    try {
      await starting;
    } finally {
      starting = null;
    }
  }

  async function stop() {
    for (const id of sessions.keys()) {
      try {
        send({ type: "kill", id });
      } catch {
        /* helper may already be gone */
      }
    }
    if (child) {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      child = null;
    }
    for (const session of sessions.values()) {
      session.exited = true;
      wake(session);
    }
    sessions.clear();
  }

  function listSessions(filter = {}) {
    const wanted = filter.workspace;
    return [...sessions.values()]
      .filter((session) => wanted == null || session.workspace === wanted)
      .map((session) => ({
        id: session.id,
        title: session.title,
        profileId: session.profileId,
        cwd: session.cwd,
        workspace: session.workspace,
        shell: session.shell,
        cols: session.cols,
        rows: session.rows,
        exited: session.exited,
        exitCode: session.exitCode,
        seq: session.endSeq,
      }));
  }

  function scopedSession(id, workspace) {
    const session = sessions.get(String(id || ""));
    if (!session) return null;
    if (workspace != null && session.workspace !== workspace) return null;
    return session;
  }

  async function spawnSession(input = {}) {
    await start();
    const workspace = shell.workspaceKey(input.workspace, { platform, path });
    const live = [...sessions.values()].filter(
      (session) => !session.exited && session.workspace === workspace,
    ).length;
    if (live >= maxSessions) {
      return { ok: false, error: `Maximum of ${maxSessions} sessions reached` };
    }
    const id = String(input.id || uid());
    if (sessions.has(id)) return { ok: false, error: "session already exists" };
    let cwd;
    try {
      cwd = shell.resolveAllowedCwd(input.cwd, {
        workspace: input.workspace,
        home: homedir,
        platform,
        path,
      });
    } catch (error) {
      return { ok: false, error: error.message };
    }
    const sh = String(input.shell || "");
    if (!sh) return { ok: false, error: "shell is required" };
    const cols = Math.max(2, Number(input.cols) || 80);
    const rows = Math.max(1, Number(input.rows) || 24);
    const args = Array.isArray(input.args) ? input.args.map((value) => String(value)) : [];
    const argv0 = input.argv0 ? String(input.argv0) : "";
    const env = input.env && typeof input.env === "object" ? input.env : {};
    const session = {
      id,
      title: input.title || path.basename(cwd) || path.basename(sh) || "Terminal",
      profileId: input.profileId || "default",
      cwd,
      workspace,
      shell: sh,
      args,
      argv0,
      cols,
      rows,
      buffer: Buffer.alloc(0),
      baseSeq: 0,
      endSeq: 0,
      waiters: [],
      exited: false,
      exitCode: null,
      lastError: null,
    };
    sessions.set(id, session);
    send({
      type: "spawn",
      id,
      cols,
      rows,
      shell: sh,
      args,
      argv0,
      cwd,
      env,
    });
    return { ok: true, session: listSessions().find((item) => item.id === id) };
  }

  function write(id, data, opts = {}) {
    const session = scopedSession(id, opts.workspace);
    if (!session || session.exited) return { ok: false, error: "session is not running" };
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data ?? ""), "utf8");
    send({ type: "write", id: session.id, data: payload.toString("base64") });
    return { ok: true };
  }

  function resize(id, cols, rows, opts = {}) {
    const session = scopedSession(id, opts.workspace);
    if (!session || session.exited) return { ok: false, error: "session is not running" };
    session.cols = Math.max(2, Number(cols) || session.cols);
    session.rows = Math.max(1, Number(rows) || session.rows);
    send({ type: "resize", id: session.id, cols: session.cols, rows: session.rows });
    return { ok: true };
  }

  function kill(id, opts = {}) {
    const session = scopedSession(id, opts.workspace);
    if (!session) return { ok: true, killed: false };
    try {
      send({ type: "kill", id: session.id });
    } catch {
      session.exited = true;
      wake(session);
    }
    return { ok: true, killed: true };
  }

  function drain(id, opts = {}) {
    const session = scopedSession(id, opts.workspace);
    if (!session) return Promise.resolve({ ok: false, error: "unknown session" });
    const afterSeq = Number.isFinite(opts.afterSeq) ? Math.max(0, Number(opts.afterSeq)) : session.endSeq;
    const waitMs = Number.isFinite(opts.waitMs)
      ? Math.min(5000, Math.max(0, Number(opts.waitMs)))
      : DEFAULT_WAIT_MS;

    const snapshot = () => {
      const from = Math.max(afterSeq, session.baseSeq);
      let data = session.buffer.subarray(Math.max(0, from - session.baseSeq));
      if (data.length > drainLimit) data = data.subarray(0, drainLimit);
      return {
        ok: true,
        seq: from + data.length,
        data: data.toString("base64"),
        exited: session.exited,
        exitCode: session.exitCode,
        baseSeq: session.baseSeq,
        error: session.lastError,
      };
    };

    const from = Math.max(afterSeq, session.baseSeq);
    if (session.endSeq > from || session.exited || session.lastError || waitMs === 0) {
      return Promise.resolve(snapshot());
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const index = session.waiters.indexOf(onWake);
        if (index >= 0) session.waiters.splice(index, 1);
        resolve(snapshot());
      }, waitMs);
      const onWake = () => {
        clearTimeout(timer);
        resolve(snapshot());
      };
      session.waiters.push(onWake);
    });
  }

  function configure(next = {}) {
    if (Number.isFinite(next.maxSessions)) {
      maxSessions = Math.min(32, Math.max(1, Number(next.maxSessions)));
    }
    if (Number.isFinite(next.scrollbackBytes)) {
      scrollbackBytes = Math.min(8 * 1024 * 1024, Math.max(16 * 1024, Number(next.scrollbackBytes)));
    }
  }

  return {
    start,
    stop,
    spawn: spawnSession,
    write,
    resize,
    kill,
    drain,
    list: listSessions,
    configure,
    helperPath: helperBin,
  };
}

module.exports = {
  createPtyHost,
  DRAIN_LIMIT,
  DEFAULT_MAX_SESSIONS,
  DEFAULT_SCROLLBACK_BYTES,
};
