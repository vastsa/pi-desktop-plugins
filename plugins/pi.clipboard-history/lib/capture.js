"use strict";

/**
 * Clipboard watcher service for pi.clipboard-history.
 *
 * Two capture paths, chosen by feature detection on every tick:
 *  - Host exposes pi.clipboard.getHistory(): sync the full clipboard history
 *    (text + images, newest first) into the store. Entries are deduplicated
 *    by sha256 — existing hashes are touched (timestamp aligned to the host
 *    entry, cross-day migration included), new ones appended. Image entries
 *    are skipped when saveImages is off.
 *  - Otherwise: fall back to polling pi.clipboard.readText() (text only),
 *    unchanged from 0.1.x.
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
    this.settings = { paused: false, pollIntervalMs: DEFAULT_INTERVAL, saveImages: true };
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
      saveImages: settings.saveImages !== false, // default true
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
      `started: interval=${this.settings.pollIntervalMs}ms paused=${this.settings.paused} saveImages=${this.settings.saveImages}`
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

      if (typeof this.pi.clipboard.getHistory === "function") {
        await this.syncFromHistory();
      } else {
        await this.pollReadText();
      }
    } catch (err) {
      this.log("tick failed:", errMessage(err));
    } finally {
      this.ticking = false;
    }
  }

  /* --------------------------- getHistory sync -------------------------- */

  async syncFromHistory() {
    let entries;
    try {
      entries = await this.pi.clipboard.getHistory();
    } catch (err) {
      if (err && err.code === "PERMISSION_DENIED") {
        this.handlePermissionDenied();
      } else {
        this.log("getHistory failed:", errMessage(err));
      }
      return;
    }
    if (!Array.isArray(entries) || entries.length === 0) return;

    const nowIso = new Date().toISOString();
    let newestMerged = null;

    // Host returns newest-first; iterate oldest-first so appends keep the
    // store's oldest-first internal order (cap enforcement drops arr[0]).
    for (let i = entries.length - 1; i >= 0; i--) {
      try {
        const merged = this.mergeEntry(entries[i], nowIso);
        if (merged) newestMerged = merged;
      } catch (err) {
        this.log("merge entry failed:", errMessage(err));
      }
    }

    if (newestMerged) {
      this.lastHash = newestMerged.hash;
      this.lastId = newestMerged.id;
      this.lastDateKey = this.store.localDateKey(Date.parse(newestMerged.capturedAt));
    }
  }

  /**
   * Merge one host history entry. Returns the record (appended or touched)
   * or null when skipped. Timestamps come from the host entry when present
   * so the store stays aligned with the host's history.
   */
  mergeEntry(entry, nowIso) {
    if (!entry || typeof entry !== "object") return null;
    const type = entry.type === "image" ? "image" : "text";
    const ts = entry.capturedAt || nowIso;

    let hash;
    let data;
    if (type === "image") {
      if (!this.settings.saveImages) return null; // skip images when disabled
      data = entry.data;
      if (!data) return null;
      hash = this.store.hashBytes(Buffer.from(data));
    } else {
      if (typeof entry.text !== "string" || entry.text === "") return null;
      hash = this.store.hashText(entry.text);
    }

    // One-shot suppression: the copy-back handler already touched the
    // record; the immediate next sync must not churn its timestamp.
    if (hash === this.suppressedHash) {
      this.suppressedHash = null;
      return null;
    }

    const existing = this.store.findByHash(hash);
    if (existing) {
      if (existing.capturedAt !== ts) {
        this.store.touchByHash(hash, ts); // refresh + cross-day migrate
      }
      return existing;
    }

    let rec;
    if (type === "image") {
      rec = this.store.appendImage(
        {
          format: entry.format || "png",
          width: entry.width,
          height: entry.height,
          sizeBytes: entry.sizeBytes != null ? entry.sizeBytes : Buffer.byteLength(data),
          data: Buffer.from(data),
        },
        ts
      );
    } else {
      rec = this.store.append(entry.text, hash, ts);
    }
    return rec;
  }

  /* --------------------------- readText polling ------------------------- */

  async pollReadText() {
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

    const nowIso = new Date().toISOString();
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
    this.lastDateKey = this.store.localDateKey(Date.parse(nowIso));
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
    const useHistory = typeof this.pi.clipboard.getHistory === "function";
    let text;
    try {
      if (useHistory) {
        await this.pi.clipboard.getHistory();
      } else {
        text = await this.pi.clipboard.readText();
      }
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
    if (!useHistory && typeof text === "string" && text !== "") {
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

  /** One-shot flag: the next tick/sync seeing `hash` does nothing. */
  suppress(hash) {
    this.suppressedHash = hash;
  }

  /* --------------------------- RPC-facing API --------------------------- */

  getState() {
    return {
      paused: this.settings.paused,
      pollIntervalMs: this.settings.pollIntervalMs,
      permissionDenied: this.permissionDenied,
      saveImages: this.settings.saveImages,
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
    if (rec.type === "image") {
      const data = this.store.readImageData(rec);
      if (!data) {
        const err = new Error(`Image data missing for record: ${id}`);
        err.code = "NOT_FOUND";
        throw err;
      }
      if (typeof this.pi.clipboard.writeImage !== "function") {
        const err = new Error("Host does not support clipboard.writeImage");
        err.code = "UNSUPPORTED";
        throw err;
      }
      await this.pi.clipboard.writeImage({ format: rec.format, data });
    } else {
      await this.pi.clipboard.writeText(rec.text);
    }
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

  async setSaveImages(enabled) {
    this.settings.saveImages = !!enabled;
    await this.persistSettings();
    return this.settings.saveImages;
  }

  async persistSettings() {
    try {
      await this.pi.plugin.setSettings({
        paused: this.settings.paused,
        pollIntervalMs: this.settings.pollIntervalMs,
        saveImages: this.settings.saveImages,
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