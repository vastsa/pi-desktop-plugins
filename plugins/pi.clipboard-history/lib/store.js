"use strict";

/**
 * Storage layer for pi.clipboard-history.
 *
 * Layout: <dataPath>/history/YYYY-MM-DD.jsonl — one JSON object per line:
 *   { id, text, hash, capturedAt, truncated }
 *
 * In-memory model: Map<dateKey, record[]> with records appended newest-last
 * (the last element of a day's array is that day's newest record). Served
 * lists are always sorted newest-first.
 *
 * Write path: mutate the model first, then persist. Appends use
 * fs.appendFileSync; structural rewrites (touch / remove / clearDay / cap
 * enforcement) use a temp file + rename for atomicity.
 *
 * The model is loaded lazily on the first request (service start defers all
 * file IO until the first history.* call). Corrupt lines are skipped.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MAX_TEXT_BYTES = 102400; // 100 KiB UTF-8 per record
const DAY_CAP_BYTES = 5 * 1024 * 1024; // 5 MiB per day file
const RETENTION_DAYS = 30;
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

class Store {
  constructor(dataPath) {
    this.root = path.join(dataPath, "history");
    this.records = new Map(); // dateKey -> records[], oldest first
    this.loaded = false;
  }

  /* ------------------------------- helpers ------------------------------ */

  /** Local calendar date key, e.g. "2026-08-21". */
  localDateKey(ts = Date.now()) {
    const d = new Date(ts);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  dayFilePath(dateKey) {
    return path.join(this.root, `${dateKey}.jsonl`);
  }

  hashText(text) {
    return crypto.createHash("sha256").update(text, "utf8").digest("hex");
  }

  makeId() {
    return Date.now().toString(36) + "-" + crypto.randomBytes(4).toString("hex");
  }

  /**
   * Truncate to at most MAX_TEXT_BYTES UTF-8 bytes without splitting a
   * multibyte sequence: Buffer.subarray then toString("utf8") decodes an
   * incomplete trailing sequence into a U+FFFD replacement char, which can
   * overshoot the cap by a couple of bytes — trim it back until the byte
   * length fits. (Loop runs at most once in practice: overshoot <= 2 bytes.)
   */
  truncateText(text) {
    const buf = Buffer.from(text, "utf8");
    if (buf.byteLength <= MAX_TEXT_BYTES) return { text, truncated: false };
    let out = buf.subarray(0, MAX_TEXT_BYTES).toString("utf8");
    while (Buffer.byteLength(out, "utf8") > MAX_TEXT_BYTES) {
      out = out.slice(0, -1);
    }
    return { text: out, truncated: true };
  }

  makeRecord(text, hash, capturedAt) {
    const t = this.truncateText(text);
    return { id: this.makeId(), text: t.text, hash, capturedAt, truncated: t.truncated };
  }

  lineBytes(record) {
    return Buffer.byteLength(JSON.stringify(record), "utf8") + 1; // + "\n"
  }

  /* ------------------------------ lazy load ----------------------------- */

  ensureLoaded() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      fs.mkdirSync(this.root, { recursive: true });
    } catch {
      /* root exists or is uncreatable — readdir below will surface it */
    }
    let names = [];
    try {
      names = fs.readdirSync(this.root);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const dateKey = name.slice(0, -6);
      const filePath = path.join(this.root, name);
      const records = [];
      try {
        const content = fs.readFileSync(filePath, "utf8");
        for (const line of content.split(/\r?\n/)) {
          if (!line.trim()) continue;
          try {
            const rec = JSON.parse(line);
            if (rec && typeof rec.id === "string" && typeof rec.text === "string") {
              records.push(rec);
            }
          } catch {
            // tolerate corrupt lines: skip them
          }
        }
      } catch {
        // unreadable file: skip the whole day
        continue;
      }
      if (records.length) this.records.set(dateKey, records);
    }
  }

  /* ------------------------------ lookups ------------------------------- */

  /** Search newest day first, newest record first within a day. */
  findEntry(predicate) {
    this.ensureLoaded();
    for (const dateKey of this.records.keys()) {
      const arr = this.records.get(dateKey);
      for (let i = arr.length - 1; i >= 0; i--) {
        if (predicate(arr[i])) return { rec: arr[i], dateKey, arr };
      }
    }
    return null;
  }

  findById(id) {
    const entry = this.findEntry((r) => r.id === id);
    return entry ? entry.rec : null;
  }

  findByHash(hash) {
    const entry = this.findEntry((r) => r.hash === hash);
    return entry ? entry.rec : null;
  }

  /** Newest record across all days (by capturedAt), or null. */
  getNewest() {
    this.ensureLoaded();
    let newest = null;
    for (const arr of this.records.values()) {
      for (const rec of arr) {
        if (!newest || rec.capturedAt > newest.capturedAt) newest = rec;
      }
    }
    return newest;
  }

  /* ------------------------------- writes ------------------------------- */

  /**
   * Append a new record and persist. Enforces the per-day 5 MiB soft cap:
   * if the file plus the new line would exceed it, drop the day's oldest
   * records until it fits, then rewrite the file atomically.
   */
  append(text, hash, capturedAt = new Date().toISOString()) {
    this.ensureLoaded();
    const dateKey = this.localDateKey(Date.parse(capturedAt));
    const rec = this.makeRecord(text, hash, capturedAt);
    let arr = this.records.get(dateKey);
    if (!arr) {
      arr = [];
      this.records.set(dateKey, arr);
    }
    arr.push(rec);

    const filePath = this.dayFilePath(dateKey);
    let fileBytes = 0;
    try {
      fileBytes = fs.statSync(filePath).size;
    } catch {
      /* new day file — size 0 */
    }
    const newBytes = this.lineBytes(rec);
    if (fileBytes + newBytes > DAY_CAP_BYTES) {
      let droppedBytes = 0;
      while (arr.length > 1 && fileBytes - droppedBytes + newBytes > DAY_CAP_BYTES) {
        droppedBytes += this.lineBytes(arr.shift());
      }
      this.writeDayFile(dateKey);
    } else {
      try {
        fs.appendFileSync(filePath, JSON.stringify(rec) + "\n", "utf8");
      } catch {
        // append failed (e.g. file vanished) — fall back to full rewrite
        this.writeDayFile(dateKey);
      }
    }
    return rec;
  }

  /**
   * Move a record into another day's array and persist both files. Used by
   * the touch helpers when a re-capture/copy-back happens on a later calendar
   * day: the card must surface under the new day ("置顶"), not stay under a
   * stale date showing today's clock time.
   */
  migrateToDay(entry, dateKey) {
    const idx = entry.arr.indexOf(entry.rec);
    if (idx >= 0) entry.arr.splice(idx, 1);
    this.writeDayFile(entry.dateKey); // persists removal / removes empty file
    let arr = this.records.get(dateKey);
    if (!arr) {
      arr = [];
      this.records.set(dateKey, arr);
    }
    arr.push(entry.rec); // newest-last convention
    this.writeDayFile(dateKey);
    return dateKey;
  }

  /**
   * Touch a record (refresh capturedAt) by id or hash. When the new timestamp
   * falls on a different calendar day than the record's file, the record is
   * migrated to that day's file so it groups and ranks correctly.
   * Returns the record, or null when not found.
   */
  touchById(id, capturedAt = new Date().toISOString()) {
    const entry = this.findEntry((r) => r.id === id);
    if (!entry) return null;
    entry.rec.capturedAt = capturedAt;
    const newKey = this.localDateKey(Date.parse(capturedAt));
    if (newKey !== entry.dateKey) {
      entry.dateKey = this.migrateToDay(entry, newKey);
    } else {
      this.writeDayFile(entry.dateKey);
    }
    return entry.rec;
  }

  touchByHash(hash, capturedAt = new Date().toISOString()) {
    const entry = this.findEntry((r) => r.hash === hash);
    if (!entry) return null;
    entry.rec.capturedAt = capturedAt;
    const newKey = this.localDateKey(Date.parse(capturedAt));
    if (newKey !== entry.dateKey) {
      entry.dateKey = this.migrateToDay(entry, newKey);
    } else {
      this.writeDayFile(entry.dateKey);
    }
    return entry.rec;
  }

  removeById(id) {
    this.ensureLoaded();
    for (const dateKey of this.records.keys()) {
      const arr = this.records.get(dateKey);
      const idx = arr.findIndex((r) => r.id === id);
      if (idx >= 0) {
        arr.splice(idx, 1);
        this.writeDayFile(dateKey); // removes file + map entry when day empties
        return true;
      }
    }
    return false;
  }

  clearDay(dateKey) {
    this.ensureLoaded();
    if (!DATE_KEY_RE.test(dateKey)) return false;
    const existed = this.records.delete(dateKey);
    this.removeDayFile(dateKey);
    return existed;
  }

  clearAll() {
    this.ensureLoaded();
    this.records.clear();
    try {
      fs.rmSync(this.root, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    try {
      fs.mkdirSync(this.root, { recursive: true });
    } catch {
      /* best effort */
    }
  }

  /** Drop days strictly older than `retentionDays` local calendar days. */
  purge(retentionDays = RETENTION_DAYS) {
    this.ensureLoaded();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);
    const cutoffKey = this.localDateKey(cutoff.getTime());
    let purged = 0;
    for (const dateKey of [...this.records.keys()]) {
      if (dateKey < cutoffKey) {
        this.records.delete(dateKey);
        this.removeDayFile(dateKey);
        purged++;
      }
    }
    return purged;
  }

  /* ----------------------------- persistence ---------------------------- */

  /** Atomic whole-file rewrite: temp file + rename. */
  writeDayFile(dateKey) {
    if (!DATE_KEY_RE.test(dateKey)) return;
    const arr = this.records.get(dateKey);
    if (!arr || !arr.length) {
      this.removeDayFile(dateKey);
      this.records.delete(dateKey);
      return;
    }
    const filePath = this.dayFilePath(dateKey);
    const tmp = filePath + ".tmp";
    const content = arr.map((r) => JSON.stringify(r)).join("\n") + "\n";
    try {
      fs.writeFileSync(tmp, content, "utf8");
      fs.renameSync(tmp, filePath);
    } catch (err) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  removeDayFile(dateKey) {
    try {
      fs.unlinkSync(this.dayFilePath(dateKey));
    } catch {
      /* not found is fine */
    }
  }

  /* ------------------------------ serving ------------------------------- */

  /** Days sorted dateKey DESC, items sorted capturedAt DESC, non-empty days only. */
  getList() {
    this.ensureLoaded();
    const days = [];
    for (const dateKey of [...this.records.keys()].sort().reverse()) {
      const arr = this.records.get(dateKey);
      if (!arr || !arr.length) continue;
      const items = [...arr]
        .sort((a, b) => (a.capturedAt < b.capturedAt ? 1 : a.capturedAt > b.capturedAt ? -1 : 0))
        .map((r) => ({
          id: r.id,
          text: r.text,
          hash: r.hash,
          capturedAt: r.capturedAt,
          truncated: r.truncated,
        }));
      days.push({ dateKey, items });
    }
    return days;
  }
}

module.exports = { Store, MAX_TEXT_BYTES, DAY_CAP_BYTES, RETENTION_DAYS };
