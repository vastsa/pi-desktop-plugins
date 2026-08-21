"use strict";

/**
 * Clipboard watcher service for pi.clipboard-history.
 *
 * Polls pi.clipboard.readText() every pollIntervalMs (clamped to
 * 1000–10000 ms, default 2000). Deduplicates by sha256: the same text on
 * the clipboard only refreshes the existing record's capturedAt (touch);
 * new text is appended as a new record. Empty text is skipped entirely.
 *
 * On PERMISSION_DENIED the poller stops and a 60 s retry timer takes over;
 * a successful retry resumes normal polling.
 *
 * All file IO (Store) is lazy — it happens on the first history.* request
 * or the first capture, keeping service start well under its 5 s budget.
 */

const { Store, RETENTION_DAYS } = require("./store");

const MIN_INTERVAL = 1000;
const MAX_INTERVAL = 10000;
const DEFAULT_INTERVAL = 2000;
const RETRY_DELAY_MS = 60000;

function errMessage(err) {
  return err && err.message ? err.message : String(err);
}

class CaptureService {
  constructor(pi, dataPath) {
    this.pi = pi;
    this.store = new Store(dataPath);
    this.settings = { paused: false, pollIntervalMs: DEFAULT_INTERVAL };
    this.lastHash = null;
    this.lastId = null;
    this.lastDateKey = null;
    this.suppressedHash = null; // one-shot copy-back suppression
    this.permissionDenied = false;
    this.timer = null;
    this.retryTimer = null;
    this.ticking = false;
    this.log = (...args) => console.log("[clipboard-history]", ...args);
  }

  /* ------------------------------ lifecycle ----------------------------- */

  async start({ log } = {}) {
    if (log) this.log = log;
    let settings = {};
    try {
      settings = (await this.pi.plugin.getSettings()) || {};
    } catch (err) {
      this.log("load settings failed:", errMessage(err));
    }
    this.settings = {
      paused: !!settings.paused,
      pollIntervalMs: this.clampInterval(settings.pollIntervalMs),
    };
    this.store.purge(RETENTION_DAYS);
    const newest = this.store.getNewest();
    if (newest) {
      this.lastHash = newest.hash;
      this.lastId = newest.id;
      this.lastDateKey = this.store.localDateKey(Date.parse(newest.capturedAt));
    }
    this.startPolling();
    this.log(
      `started: interval=${this.settings.pollIntervalMs}ms paused=${this.settings.paused}`
    );
  }

  stop() {
    this.clearTimers();
    this.permissionDenied = false;
  }

  clearTimers() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  startPolling() {
    this.clearTimers();
    this.timer = setInterval(() => {
      this.tick();
    }, this.settings.pollIntervalMs);
  }

  /* -------------------------------- tick -------------------------------- */

  async tick() {
    if (this.ticking || this.settings.paused || this.permissionDenied) return;
    this.ticking = true;
    try {
      const nowIso = new Date().toISOString();
      const todayKey = this.store.localDateKey(Date.parse(nowIso));

      // Local-date rollover: purge expired days once per new day.
      if (this.lastDateKey && this.lastDateKey !== todayKey) {
        this.lastDateKey = todayKey;
        this.store.purge(RETENTION_DAYS);
      }

      let text;
      try {
        text = await this.pi.clipboard.readText();
      } catch (err) {
        if (err && err.code === "PERMISSION_DENIED") {
          this.handlePermissionDenied();
        } else {
          this.log("clipboard read failed:", errMessage(err));
        }
        return;
      }

      if (typeof text !== "string" || text === "") return;

      const hash = this.store.hashText(text);

      // One-shot suppression: the copy-back handler already touched the
      // record; the immediate next tick must not churn its timestamp.
      if (hash === this.suppressedHash) {
        this.suppressedHash = null;
        return;
      }

      if (hash === this.lastHash) {
        const touched = this.store.touchByHash(hash, nowIso);
        if (!touched) {
          // Record was removed meanwhile — re-capture it.
          const rec = this.store.append(text, hash, nowIso);
          this.lastHash = hash;
          this.lastId = rec.id;
        }
        return;
      }

      const rec = this.store.append(text, hash, nowIso);
      this.lastHash = hash;
      this.lastId = rec.id;
      this.lastDateKey = todayKey;
    } catch (err) {
      this.log("tick failed:", errMessage(err));
    } finally {
      this.ticking = false;
    }
  }

  handlePermissionDenied() {
    this.permissionDenied = true;
    this.log("clipboard permission denied; retrying in 60s");
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryOnce();
    }, RETRY_DELAY_MS);
  }

  async retryOnce() {
    this.retryTimer = null;
    let text;
    try {
      text = await this.pi.clipboard.readText();
    } catch (err) {
      if (err && err.code === "PERMISSION_DENIED") {
        this.retryTimer = setTimeout(() => {
          this.retryOnce();
        }, RETRY_DELAY_MS);
      } else {
        this.permissionDenied = false;
        this.startPolling();
      }
      return;
    }
    this.permissionDenied = false;
    this.startPolling();
    if (typeof text === "string" && text !== "") {
      const hash = this.store.hashText(text);
      if (hash !== this.lastHash && hash !== this.suppressedHash) {
        const nowIso = new Date().toISOString();
        const rec = this.store.append(text, hash, nowIso);
        this.lastHash = hash;
        this.lastId = rec.id;
        this.lastDateKey = this.store.localDateKey(Date.parse(nowIso));
      }
    }
    this.log("clipboard permission restored");
  }

  /** One-shot flag: the next tick seeing `hash` does nothing. */
  suppress(hash) {
    this.suppressedHash = hash;
  }

  /* --------------------------- RPC-facing API --------------------------- */

  getState() {
    return {
      paused: this.settings.paused,
      pollIntervalMs: this.settings.pollIntervalMs,
      permissionDenied: this.permissionDenied,
    };
  }

  getList() {
    return this.store.getList();
  }

  async copyById(id) {
    const rec = this.store.findById(id);
    if (!rec) {
      const err = new Error(`History record not found: ${id}`);
      err.code = "NOT_FOUND";
      throw err;
    }
    await this.pi.clipboard.writeText(rec.text);
    this.store.touchById(id, new Date().toISOString()); // becomes newest
    this.suppress(rec.hash); // one-shot: skip the next tick's touch churn
    this.lastHash = rec.hash;
    this.lastId = rec.id;
    return { ok: true };
  }

  removeById(id) {
    this.store.removeById(id);
    return { ok: true };
  }

  clearDay(dateKey) {
    this.store.clearDay(dateKey);
    return { ok: true };
  }

  clearAll() {
    this.store.clearAll();
    this.lastHash = null;
    this.lastId = null;
    this.lastDateKey = null;
    this.suppressedHash = null;
    return { ok: true };
  }

  async setPaused(paused) {
    this.settings.paused = !!paused;
    await this.persistSettings();
    return this.settings.paused;
  }

  async setIntervalMs(ms) {
    this.settings.pollIntervalMs = this.clampInterval(ms);
    await this.persistSettings();
    if (!this.permissionDenied) this.startPolling();
    return this.settings.pollIntervalMs;
  }

  async persistSettings() {
    try {
      await this.pi.plugin.setSettings({
        paused: this.settings.paused,
        pollIntervalMs: this.settings.pollIntervalMs,
      });
    } catch (err) {
      this.log("persist settings failed:", errMessage(err));
    }
  }

  clampInterval(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n)) return DEFAULT_INTERVAL;
    return Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, Math.round(n)));
  }
}

module.exports = { CaptureService, MIN_INTERVAL, MAX_INTERVAL, DEFAULT_INTERVAL };
