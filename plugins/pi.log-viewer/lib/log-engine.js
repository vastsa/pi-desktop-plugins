"use strict";

/*
 * LogEngine — plugin-process (utilityProcess) core of the large log viewer.
 *
 * File IO is supplied by the host adapter. The plugin runtime uses the host's
 * permission-gated fs.stat/fs.readRange APIs; node:fs is used only for the
 * plugin-owned state file.
 *
 * Design:
 *  - Line splitting happens on raw bytes (0x0A). Safe for UTF-8 / GBK /
 *    GB18030: none of these encodings can produce 0x0A inside a multi-byte
 *    sequence, so byte offsets are encoding independent.
 *  - A sequential cursor (seq*) indexes the file block by block, counting
 *    log levels and recording one byte offset per BLOCK_LINES lines
 *    (coarse index: KB-scale memory even for billions of lines).
 *  - readOffset is the physical read cursor (may sit inside a trailing
 *    partial line); seqOffset/seqLines track only complete lines.
 *  - Jump reads (paging anywhere, search) count lines locally and
 *    may fill sparse block offsets ahead of the sequential cursor; they
 *    never move the cursor.
 *  - A ring buffer keeps the most recent lines so tail polls can hand out
 *    appended lines without re-reading; a client that falls behind the ring
 *    gets a catchup signal and re-pages.
 */

const fsp = require("node:fs/promises");
const path = require("node:path");
const { detectLevel } = require("../renderer/level.js");
const { compileQuery, matchesLevelFilter, normaliseLevelFilter } = require("../renderer/query.js");

const BLOCK_LINES = 512;
const CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_PENDING_BYTES = 16 * 1024 * 1024;
const MAX_LINE_CHARS = 4000;
const RING_CAP = 4000;
const MAX_STORED_MATCHES = 5000;
const MAX_PAGE_SCAN_LINES = 150000;
const MAX_OPEN_FILES = 12;
const POLL_CHUNK_BUDGET = 8;
const DRIVER_CHUNK_BUDGET = 64;
const MAX_JOBS = 20;

const ENCODINGS = new Set(["utf-8", "gbk", "gb18030"]);

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (Buffer.isBuffer(value)) return new Uint8Array(value);
  if (Array.isArray(value)) return Uint8Array.from(value);
  if (!value || typeof value !== "object") return new Uint8Array();
  return Uint8Array.from(
    Object.entries(value)
      .filter(([key]) => /^\d+$/.test(key))
      .sort(([left], [right]) => Number(left) - Number(right))
      .map(([, byte]) => Number(byte)),
  );
}

class HostFileHandle {
  constructor(fsApi, filePath, grantId) {
    this.fsApi = fsApi;
    this.path = filePath;
    this.grantId = grantId;
  }

  async stat() {
    return this.fsApi.stat(this.path, this.grantId);
  }

  async read(buffer, offset, length, position) {
    const result = await this.fsApi.readRange(
      this.path,
      position,
      length,
      this.grantId,
    );
    const bytes = asBytes(result && result.bytes);
    const count = Math.min(bytes.length, length);
    buffer.set(bytes.subarray(0, count), offset);
    return { bytesRead: count, buffer };
  }

  async close() {}
}

function createHostFileSystem(fsApi) {
  return {
    host: true,
    async setRoot() {
      return { root: "userSelected" };
    },
    stat: (filePath, grantId) => fsApi.stat(filePath, grantId),
    open: async (filePath, grantId) => new HostFileHandle(fsApi, filePath, grantId),
    list: async (dirPath) => ({
      path: dirPath || "",
      entries: await fsApi.list(dirPath || ""),
    }),
  };
}

class ApiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function clipLine(text) {
  return text.length > MAX_LINE_CHARS ? text.slice(0, MAX_LINE_CHARS) : text;
}

function makeDecoder(encoding) {
  try {
    return new TextDecoder(encoding);
  } catch {
    throw new ApiError("INVALID_ARGUMENT", `unsupported encoding: ${encoding}`);
  }
}

/** All newline (0x0A) byte positions in buf, relative to buf. */
function newlinePositions(buf, limit) {
  const positions = [];
  let idx = buf.indexOf(0x0a);
  while (idx !== -1) {
    positions.push(idx);
    if (limit && positions.length > limit) break;
    idx = buf.indexOf(0x0a, idx + 1);
  }
  return positions;
}

class Ring {
  constructor(cap) {
    this.cap = cap;
    this.items = [];
  }
  push(item) {
    this.items.push(item);
    if (this.items.length > this.cap + (this.cap >> 2)) {
      this.items.splice(0, this.items.length - this.cap);
    }
  }
  /** Items with .no strictly greater than lineNo, ascending. */
  after(lineNo) {
    let lo = 0;
    let hi = this.items.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.items[mid].no <= lineNo) lo = mid + 1;
      else hi = mid;
    }
    return this.items.slice(lo);
  }
  firstNo() {
    return this.items.length ? this.items[0].no : null;
  }
}

class LogFile {
  constructor(id, absPath, handle, st) {
    this.id = id;
    this.path = absPath;
    this.handle = handle; // fs.promises FileHandle
    this.encoding = "utf-8";
    this.ino = Number(st.ino) || 0;
    this.birthMs = Number(st.birthtimeMs) || 0;
    this.rawSize = st.size;
    this.epoch = 1;
    this.closed = false;
    /** In-flight reads; tokens pin the handle they started against. */
    this.readers = new Set();

    this.readOffset = 0; // physical read cursor (bytes consumed)
    this.seqOffset = 0; // offset after the last complete indexed line
    this.seqLines = 0; // count of complete lines indexed sequentially
    this.seqDone = false;
    this.blockOffsets = new Map(); // blockIndex -> byte offset of its first line
    this.blockOffsets.set(0, 0);
    this.stats = { error: 0, warn: 0, info: 0, debug: 0 };
    this.ring = new Ring(RING_CAP);
    this.pendingRaw = null; // raw bytes after the last complete line

    this.follow = false;
    this.scanChain = Promise.resolve(); // serializes sequential scans
    this.driverStarted = false;
    this.currentJob = null;
  }

  acquireRead() {
    const token = { handle: this.handle, epoch: this.epoch };
    this.readers.add(token);
    return token;
  }

  releaseRead(token) {
    this.readers.delete(token);
  }

  isStale(token) {
    return this.closed || token.epoch !== this.epoch;
  }

  /** Close a retired handle once no in-flight read still holds it. */
  async retireHandle(handle) {
    if (!handle) return;
    await handle.close().catch(() => {});
  }

  /** Index one trailing line that arrived without a final newline (EOF). */
  indexTrailingLine(buf, bufStart) {
    if (!buf || !buf.length) return;
    const line = clipLine(makeDecoder(this.encoding).decode(buf));
    const lineNo = this.seqLines + 1;
    if (lineNo === 1 || (lineNo - 1) % BLOCK_LINES === 0) {
      this.blockOffsets.set(Math.floor((lineNo - 1) / BLOCK_LINES), bufStart);
    }
    const level = detectLevel(line);
    if (level) this.stats[level] += 1;
    this.ring.push({ no: lineNo, text: line });
    this.seqOffset += buf.length;
    this.seqLines += 1;
    this.pendingRaw = null;
  }

  resetForReload(handle, st) {
    this.epoch += 1;
    const oldHandle = this.handle;
    this.handle = handle;
    this.ino = Number(st.ino) || 0;
    this.birthMs = Number(st.birthtimeMs) || 0;
    this.rawSize = st.size;
    this.readOffset = 0;
    this.seqOffset = 0;
    this.seqLines = 0;
    this.seqDone = false;
    this.blockOffsets = new Map();
    this.blockOffsets.set(0, 0);
    this.stats = { error: 0, warn: 0, info: 0, debug: 0 };
    this.ring = new Ring(RING_CAP);
    this.pendingRaw = null;
    this.currentJob = null;
    if (oldHandle) void this.retireHandle(oldHandle);
    this.startDriver();
  }

  startDriver() {
    if (this.driverStarted) return;
    this.driverStarted = true;
    this.enqueue(async () => {
      while (!this.closed && !this.seqDone) {
        const advanced = await this.seqStep(DRIVER_CHUNK_BUDGET);
        if (!advanced) break;
      }
    }).catch(() => {});
  }

  /** Serialize sequential (cursor-moving) scans. */
  enqueue(fn) {
    const run = this.scanChain.then(fn, fn);
    this.scanChain = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Advance the sequential cursor by at most `budget` chunks. */
  async seqStep(budget) {
    let advanced = false;
    for (let i = 0; i < budget; i += 1) {
      if (this.closed || this.seqDone) break;
      const readFrom = this.readOffset;
      const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
      let bytesRead = 0;
      try {
        ({ bytesRead } = await this.handle.read(buffer, 0, CHUNK_BYTES, readFrom));
      } catch (err) {
        this.seqDone = true;
        this.seqError = err.message;
        break;
      }
      if (bytesRead === 0) {
        // EOF: a trailing partial line (no final newline) is still a line.
        if (this.pendingRaw && this.pendingRaw.length) {
          this.indexTrailingLine(this.pendingRaw, readFrom - this.pendingRaw.length);
        }
        this.seqDone = true;
        break;
      }
      const prevPendingLen = this.pendingRaw ? this.pendingRaw.length : 0;
      let buf = buffer.subarray(0, bytesRead);
      if (prevPendingLen) buf = Buffer.concat([this.pendingRaw, buf]);
      const bufStart = readFrom - prevPendingLen;
      this.readOffset = readFrom + bytesRead;

      const lastNl = buf.lastIndexOf(0x0a);
      if (lastNl === -1) {
        if (bytesRead < CHUNK_BYTES) {
          // Short read means EOF. Flush the unfinished line as complete.
          this.indexTrailingLine(buf, bufStart);
          this.seqDone = true;
        } else if (buf.length > MAX_PENDING_BYTES) {
          // Pathological giant line: force-flush it to keep the cursor moving.
          this.seqOffset += buf.length;
          this.seqLines += 1;
        } else {
          this.pendingRaw = Buffer.from(buf);
        }
        advanced = true;
        continue;
      }
      const regionEnd = this.consumeRegion(buf, bufStart, this.seqLines + 1, {
        ring: this.ring,
        stats: true,
        recordBlocks: true,
      });
      this.seqOffset = bufStart + regionEnd.consumed;
      this.seqLines = regionEnd.nextLineNo - 1;
      const rest = buf.subarray(lastNl + 1);
      this.pendingRaw = rest.length ? Buffer.from(rest) : null;
      advanced = true;
      await new Promise((resolve) => setImmediate(resolve));
    }
    return advanced;
  }

  /**
   * Consume every complete line in buf (raw bytes starting at absolute
   * offset bufStart; first line numbered startLineNo). Returns
   * { nextLineNo, consumed, completeLines }. Never crosses the final
   * newline of buf.
   */
  consumeRegion(buf, bufStart, startLineNo, { ring, stats, recordBlocks, match, collect, collectCap }) {
    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl === -1) {
      return { nextLineNo: startLineNo, consumed: 0, completeLines: 0 };
    }
    const nls = newlinePositions(buf);
    const region = buf.subarray(0, lastNl + 1);
    const text = makeDecoder(this.encoding).decode(region);
    const parts = text.split("\n");
    parts.pop(); // trailing empty after the final \n
    let lineNo = startLineNo;
    for (let i = 0; i < parts.length && i < nls.length; i += 1) {
      let line = parts[i];
      if (line.endsWith("\r")) line = line.slice(0, -1);
      line = clipLine(line);
      const absStart = bufStart + (i === 0 ? 0 : nls[i - 1] + 1);
      if (recordBlocks && (lineNo === 1 || (lineNo - 1) % BLOCK_LINES === 0)) {
        this.blockOffsets.set(Math.floor((lineNo - 1) / BLOCK_LINES), absStart);
      }
      if (stats) {
        const level = detectLevel(line);
        if (level) this.stats[level] += 1;
      }
      if (ring) ring.push({ no: lineNo, text: line });
      if (match && collect && match(line, lineNo) && collect.length < (collectCap || MAX_STORED_MATCHES)) {
        collect.push({ line: lineNo, text: line.length > 300 ? line.slice(0, 300) : line });
      }
      lineNo += 1;
    }
    return { nextLineNo: startLineNo + Math.min(parts.length, nls.length), consumed: lastNl + 1, completeLines: Math.min(parts.length, nls.length) };
  }

  /** Ensure the sequential index has reached `lineNo` (or EOF). */
  async ensureIndexedTo(lineNo) {
    let guard = 0;
    while (!this.seqDone && this.seqLines < lineNo && guard < 4096) {
      const advanced = await this.enqueue(() => this.seqStep(DRIVER_CHUNK_BUDGET));
      if (!advanced) break;
      guard += 1;
    }
    return this.seqDone || this.seqLines >= lineNo;
  }

  /** Byte offset of a 1-based line via sparse blocks; may await the index. */
  async offsetOfLine(lineNo) {
    if (lineNo <= 1) return { offset: 0, blockFirstLine: 1 };
    const b = Math.floor((lineNo - 1) / BLOCK_LINES);
    let off = this.blockOffsets.get(b);
    if (off === undefined) {
      await this.ensureIndexedTo(b * BLOCK_LINES + 1);
      off = this.blockOffsets.get(b);
      if (off === undefined) return null; // beyond indexed region (EOF)
    }
    return { offset: off, blockFirstLine: b * BLOCK_LINES + 1 };
  }

  wants(line, levelFilter, textMatch) {
    if (!matchesLevelFilter(line, levelFilter)) return false;
    if (textMatch && !textMatch(line)) return false;
    return true;
  }

  /**
   * Jump read from the block containing fromLine; counts lines locally and
   * collects into `collect` (cap `count`). May record sparse block offsets
   * ahead of the sequential cursor (idempotent with the driver).
   */
  async jumpScan({ fromLine, count, levelFilter, textMatch, collect, maxScanLines }) {
    const start = await this.offsetOfLine(fromLine);
    if (!start) return { eof: true, scanned: 0, partial: null, nextLine: fromLine };
    const token = this.acquireRead();
    try {
      let readFrom = start.offset; // physical read cursor (past all bytes read)
      let lineNo = start.blockFirstLine;
      let pending = null;
      let scanned = 0;
      let partial = null;
      while (collect.length < count && scanned < maxScanLines) {
        if (this.isStale(token)) {
          return { eof: true, scanned, partial, nextLine: lineNo, stale: true };
        }
        const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
        let bytesRead = 0;
        try {
          ({ bytesRead } = await token.handle.read(buffer, 0, CHUNK_BYTES, readFrom));
        } catch {
          break;
        }
        if (bytesRead === 0) {
          if (pending && pending.length) {
            // EOF without a trailing newline: the partial line is complete.
            const line = clipLine(makeDecoder(this.encoding).decode(pending));
            scanned += 1;
            if (lineNo >= fromLine && this.wants(line, levelFilter, textMatch) && collect.length < count) {
              collect.push({ no: lineNo, text: line });
            }
            lineNo += 1;
            pending = null;
          }
          break;
        }
        const prevPendingLen = pending ? pending.length : 0;
        let buf = buffer.subarray(0, bytesRead);
        if (prevPendingLen) buf = Buffer.concat([pending, buf]);
        const bufStart = readFrom - prevPendingLen;
        readFrom += bytesRead;
        const lastNl = buf.lastIndexOf(0x0a);
        if (lastNl === -1) {
          if (bytesRead < CHUNK_BYTES) {
            // Short read at EOF: finish the trailing line.
            const line = clipLine(makeDecoder(this.encoding).decode(buf));
            scanned += 1;
            if (lineNo >= fromLine && this.wants(line, levelFilter, textMatch) && collect.length < count) {
              collect.push({ no: lineNo, text: line });
            }
            lineNo += 1;
            pending = null;
            break;
          }
          if (buf.length > MAX_PENDING_BYTES) {
            scanned += 1;
            const line = clipLine(makeDecoder(this.encoding).decode(buf));
            if (lineNo >= fromLine && this.wants(line, levelFilter, textMatch) && collect.length < count) collect.push({ no: lineNo, text: line });
            lineNo += 1;
          } else {
            pending = Buffer.from(buf);
          }
          continue;
        }
        const nls = newlinePositions(buf);
        const region = buf.subarray(0, lastNl + 1);
        const parts = makeDecoder(this.encoding).decode(region).split("\n");
        parts.pop();
        const n = Math.min(parts.length, nls.length);
        for (let i = 0; i < n; i += 1) {
          let line = parts[i];
          if (line.endsWith("\r")) line = line.slice(0, -1);
          line = clipLine(line);
          const absStart = bufStart + (i === 0 ? 0 : nls[i - 1] + 1);
          if (lineNo === 1 || (lineNo - 1) % BLOCK_LINES === 0) {
            this.blockOffsets.set(Math.floor((lineNo - 1) / BLOCK_LINES), absStart);
          }
          scanned += 1;
          if (lineNo >= fromLine && this.wants(line, levelFilter, textMatch) && collect.length < count) {
            collect.push({ no: lineNo, text: line });
          }
          lineNo += 1;
        }
        const rest = buf.subarray(lastNl + 1);
        pending = rest.length ? Buffer.from(rest) : null;
        await new Promise((resolve) => setImmediate(resolve));
      }
      return {
        eof: collect.length < count && scanned < maxScanLines && !pending,
        scanned,
        partial,
        nextLine: lineNo,
      };
    } finally {
      this.releaseRead(token);
    }
  }
}

class LogEngine {
  constructor({ dataPath, capabilities, fileSystem }) {
    this.dataPath = dataPath || null;
    this.capabilities = capabilities || {};
    this.fileSystem = fileSystem || null;
    this.files = new Map(); // fileId -> LogFile
    this.jobs = new Map(); // jobId -> job
    this.nextFileId = 1;
    this.nextJobId = 1;
    /** Session grant: directory the user picked via fs.requestDirectory. */
    this.userRoot = null;
  }

  // ---- dispatch -----------------------------------------------------------

  async handle(channel, p) {
    try {
      switch (channel) {
        case "ping":
          return { ok: true, capabilities: this.capabilities, userRoot: this.userRoot };
        case "setRoot":
          return await this.setRoot(p);
        case "restoreState":
          return await this.restoreState();
        case "saveState":
          return await this.saveState(p);
        case "listDir":
          return await this.listDir(String(p.path || ""));
        case "openFile":
          return await this.openFile(String(p.path || ""));
        case "openDropped":
          return await this.openDropped(p);
        case "page":
          return await this.page(p);
        case "poll":
          return await this.poll(p);
        case "setFollow":
          return this.setFollow(p);
        case "setEncoding":
          return this.setEncoding(p);
        case "stats":
          return this.statsOf(p);
        case "searchStart":
          return this.searchStart(p);
        case "searchStatus":
          return this.searchStatus(p);
        case "searchMatches":
          return this.searchMatches(p);
        case "searchCancel":
          return this.searchCancel(p);
        case "close":
          return this.closeFile(p);
        default:
          throw new ApiError("UNSUPPORTED", `unknown channel: ${channel}`);
      }
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError("IO", err && err.message ? err.message : String(err));
    }
  }

  fileOf(p) {
    const id = Number(p && p.fileId);
    const f = this.files.get(id);
    if (!f) throw new ApiError("NOT_FOUND", "file not open");
    return f;
  }

  // ---- path grant -----------------------------------------------------------

  /**
   * Bind the session to the directory the user just picked. Replaces any
   * earlier grant — same as the host's `userRoot` (one root at a time).
   */
  async setRoot(p) {
    if (!this.fileSystem) throw new ApiError("UNSUPPORTED", "host file API unavailable");
    this.userRoot = true;
    return this.fileSystem.setRoot(p);
  }

  // ---- files --------------------------------------------------------------

  async listDir(dirPath) {
    if (!this.fileSystem?.list) throw new ApiError("UNSUPPORTED", "host file API unavailable");
    const listed = await this.fileSystem.list(dirPath);
    return {
      path: listed.path,
      entries: listed.entries.filter((entry) => !entry.isDirectory),
    };
  }

  async openHandle(filePath, grantId) {
    if (!this.fileSystem) throw new ApiError("UNSUPPORTED", "host file API unavailable");
    return this.fileSystem.open(filePath, grantId);
  }

  /** Open after the caller has already resolved or received a host grant. */
  async openFileInternal(filePath, grantId) {
    if (!filePath) throw new ApiError("INVALID_ARGUMENT", "path required");
    for (const f of this.files.values()) {
      if (f.path === filePath && f.grantId === grantId) return this.snapshot(f);
    }
    if (this.files.size >= MAX_OPEN_FILES) {
      throw new ApiError("LIMIT_EXCEEDED", `at most ${MAX_OPEN_FILES} files can stay open`);
    }
    let handle;
    let st;
    try {
      handle = await this.openHandle(filePath, grantId);
      st = await handle.stat();
    } catch (err) {
      throw new ApiError("NOT_FOUND", `cannot open file: ${err.message}`);
    }
    if (typeof st.isFile === "function" && !st.isFile()) {
      await handle.close().catch(() => {});
      throw new ApiError("INVALID_ARGUMENT", "not a regular file");
    }
    const id = this.nextFileId++;
    const file = new LogFile(id, filePath, handle, st);
    file.grantId = grantId;
    file.fileSystem = this.fileSystem;
    this.files.set(id, file);
    file.startDriver();
    return this.snapshot(file);
  }

  async openFile(filePath) {
    if (!this.fileSystem) throw new ApiError("UNSUPPORTED", "host file API unavailable");
    return this.openFileInternal(filePath);
  }

  async openDropped(p) {
    if (!this.fileSystem) throw new ApiError("UNSUPPORTED", "dropped-file host API unavailable");
    const filePath = String(p.path || "");
    const grantId = String(p.grantId || "");
    if (!filePath || !grantId) {
      throw new ApiError("INVALID_ARGUMENT", "dropped file path and grant are required");
    }
    return this.openFileInternal(filePath, grantId);
  }

  snapshot(f) {
    return {
      fileId: f.id,
      path: f.path,
      name: path.basename(f.path),
      size: f.rawSize,
      epoch: f.epoch,
      encoding: f.encoding,
      totalLines: f.seqLines,
      indexDone: f.seqDone,
      stats: { ...f.stats },
      follow: f.follow,
    };
  }

  closeFile(p) {
    const f = this.fileOf(p);
    this.files.delete(f.id);
    f.closed = true;
    f.epoch += 1;
    if (f.currentJob) f.currentJob.cancelled = true;
    if (f.handle) void f.retireHandle(f.handle);
    return { ok: true };
  }

  setFollow(p) {
    const f = this.fileOf(p);
    f.follow = Boolean(p.follow);
    return { ok: true, follow: f.follow };
  }

  setEncoding(p) {
    const f = this.fileOf(p);
    const enc = String(p.encoding || "utf-8");
    if (!ENCODINGS.has(enc)) {
      throw new ApiError("INVALID_ARGUMENT", `encoding must be one of ${[...ENCODINGS].join("/")}`);
    }
    makeDecoder(enc); // validate early
    f.encoding = enc;
    return { ok: true, encoding: f.encoding };
  }

  statsOf(p) {
    const f = this.fileOf(p);
    return { fileId: f.id, stats: { ...f.stats }, indexDone: f.seqDone, totalLines: f.seqLines, size: f.rawSize };
  }

  // ---- paging -------------------------------------------------------------

  /** Compile optional text filter; returns null or a per-line predicate. */
  buildTextMatch(p) {
    const filter = p && p.filter;
    if (!filter || !String(filter.query || "").trim()) return null;
    const matcher = this.buildMatcher(filter);
    const invert = Boolean(filter.invert);
    return (line) => (invert ? !matcher.test(line) : matcher.test(line));
  }

  async page(p) {
    const f = this.fileOf(p);
    const fromLine = Math.max(1, Math.floor(Number(p.fromLine) || 1));
    const count = Math.min(2000, Math.max(1, Math.floor(Number(p.count) || 500)));
    const levelFilter = normaliseLevelFilter(p.levels);
    const textMatch = this.buildTextMatch(p);
    const collect = [];
    const result = await f.jumpScan({ fromLine, count, levelFilter, textMatch, collect, maxScanLines: MAX_PAGE_SCAN_LINES });
    return {
      fileId: f.id,
      epoch: f.epoch,
      lines: collect,
      requested: fromLine,
      eof: result.eof,
      partial: result.partial,
      scanned: result.scanned,
      scanEndLine: result.nextLine,
      hasMore: result.scanned >= MAX_PAGE_SCAN_LINES && collect.length >= count,
      totalLines: f.seqLines,
      indexDone: f.seqDone,
      size: f.rawSize,
      stats: { ...f.stats },
    };
  }

  async poll(p) {
    const f = this.fileOf(p);
    const sinceLine = Math.max(0, Math.floor(Number(p.sinceLine) || 0));
    let st = null;
    try {
      st = await f.handle.stat();
    } catch {
      return { fileId: f.id, epoch: f.epoch, missing: true };
    }
    let rotated = false;
    const replaced =
      st.size < f.rawSize ||
      (f.ino && Number(st.ino) && Number(st.ino) !== f.ino) ||
      (f.birthMs && st.birthtimeMs && Math.abs(st.birthtimeMs - f.birthMs) > 1500);
    if (replaced) {
      const handle = await this.openHandle(f.path, f.grantId).catch(() => null);
      if (handle) {
        const nst = await handle.stat();
        await f.enqueue(async () => {
          f.resetForReload(handle, nst);
        });
        rotated = true;
      }
    } else {
      f.rawSize = st.size;
      if (f.seqDone && st.size > f.readOffset) f.seqDone = false; // new data arrived
    }
    if (!f.seqDone) {
      await f.enqueue(() => f.seqStep(POLL_CHUNK_BUDGET));
    }
    const totalLines = f.seqLines;
    const events = [];
    if (rotated) {
      events.push({ type: "rotated", epoch: f.epoch });
    } else if (sinceLine < totalLines) {
      const fresh = f.ring.after(sinceLine);
      if (fresh.length && fresh[0].no === sinceLine + 1) {
        events.push({ type: "append", lines: fresh, totalLines });
      } else {
        events.push({ type: "catchup", totalLines });
      }
    }
    return {
      fileId: f.id,
      epoch: f.epoch,
      rotated,
      events,
      size: f.rawSize,
      totalLines,
      indexDone: f.seqDone,
      stats: { ...f.stats },
    };
  }

  // ---- search -------------------------------------------------------------

  buildMatcher(p) {
    const query = String(p.query || "");
    try {
      return compileQuery({ query, isRegex: Boolean(p.isRegex), caseSensitive: Boolean(p.caseSensitive) });
    } catch (err) {
      throw new ApiError("INVALID_ARGUMENT", err.message);
    }
  }

  searchStart(p) {
    const f = this.fileOf(p);
    const matcher = this.buildMatcher(p);
    if (f.currentJob && f.currentJob.status === "running") f.currentJob.status = "cancelled";
    const job = {
      id: this.nextJobId++,
      file: f,
      status: "running",
      matcher,
      scannedBytes: 0,
      matchCount: 0,
      matches: [],
      error: null,
      cancelled: false,
    };
    this.jobs.set(job.id, job);
    f.currentJob = job;
    this.pruneJobs();
    (async () => {
      const token = f.acquireRead();
      try {
        let offset = 0;
        let lineNo = 1;
        let pending = null;
        let pendingLen = 0;
        const decoder = makeDecoder(f.encoding);
        while (!job.cancelled) {
          if (f.isStale(token)) {
            job.status = "cancelled";
            return;
          }
          const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
          const { bytesRead } = await token.handle.read(buffer, 0, CHUNK_BYTES, offset);
          if (bytesRead === 0) {
            if (pendingLen && pending) {
              this.searchLine(job, clipLine(decoder.decode(pending)), lineNo);
              lineNo += 1;
            }
            break;
          }
          let buf = buffer.subarray(0, bytesRead);
          if (pendingLen) buf = Buffer.concat([pending, buf]);
          const bufStart = offset - pendingLen;
          offset += bytesRead;
          const lastNl = buf.lastIndexOf(0x0a);
          if (lastNl === -1) {
            if (bytesRead < CHUNK_BYTES) {
              this.searchLine(job, clipLine(decoder.decode(buf)), lineNo);
              lineNo += 1;
              pending = null;
              pendingLen = 0;
              break;
            }
            if (buf.length > MAX_PENDING_BYTES) {
              this.searchLine(job, clipLine(decoder.decode(buf)), lineNo);
              lineNo += 1;
              pending = null;
              pendingLen = 0;
            } else {
              pending = Buffer.from(buf);
              pendingLen = buf.length;
            }
            continue;
          }
          const region = buf.subarray(0, lastNl + 1);
          const parts = decoder.decode(region).split("\n");
          parts.pop();
          for (let i = 0; i < parts.length; i += 1) {
            let line = parts[i];
            if (line.endsWith("\r")) line = line.slice(0, -1);
            this.searchLine(job, clipLine(line), lineNo);
            lineNo += 1;
          }
          job.scannedBytes = bufStart + lastNl + 1;
          const rest = buf.subarray(lastNl + 1);
          pending = rest.length ? Buffer.from(rest) : null;
          pendingLen = rest.length;
          await new Promise((resolve) => setImmediate(resolve));
        }
        job.status = job.cancelled ? "cancelled" : "done";
      } catch (err) {
        job.status = "error";
        job.error = err.message;
      } finally {
        f.releaseRead(token);
      }
    })();
    return { jobId: job.id };
  }

  searchLine(job, line, lineNo) {
    if (job.matcher.test(line)) {
      job.matchCount += 1;
      if (job.matches.length < MAX_STORED_MATCHES) {
        job.matches.push({ line: lineNo, text: line.length > 300 ? line.slice(0, 300) : line });
      }
    }
  }

  pruneJobs() {
    if (this.jobs.size <= MAX_JOBS) return;
    const done = [...this.jobs.values()].filter((j) => j.status !== "running").sort((a, b) => a.id - b.id);
    for (const j of done) {
      if (this.jobs.size <= MAX_JOBS) break;
      this.jobs.delete(j.id);
    }
  }

  jobOf(p) {
    const id = Number(p && p.jobId);
    const job = this.jobs.get(id);
    if (!job) throw new ApiError("NOT_FOUND", "job not found");
    return job;
  }

  searchStatus(p) {
    const job = this.jobOf(p);
    return {
      jobId: job.id,
      status: job.status,
      scannedBytes: job.scannedBytes,
      fileSize: job.file.rawSize,
      matchCount: job.matchCount,
      storedMatches: job.matches.length,
      error: job.error,
    };
  }

  searchMatches(p) {
    const job = this.jobOf(p);
    const offset = Math.max(0, Math.floor(Number(p.offset) || 0));
    const limit = Math.min(500, Math.max(1, Math.floor(Number(p.limit) || 100)));
    return {
      jobId: job.id,
      matches: job.matches.slice(offset, offset + limit),
      matchCount: job.matchCount,
      stored: job.matches.length,
      status: job.status,
    };
  }

  searchCancel(p) {
    const job = this.jobOf(p);
    if (job.status === "running") job.cancelled = true;
    return { ok: true, status: job.status };
  }

  // ---- persisted state ----------------------------------------------------

  stateFile() {
    return this.dataPath ? path.join(this.dataPath, "state.json") : null;
  }

  async saveState(p) {
    const file = this.stateFile();
    if (!file) return { ok: false };
    try {
      await fsp.mkdir(this.dataPath, { recursive: true });
      const tabs = Array.isArray(p.tabs) ? p.tabs.slice(0, MAX_OPEN_FILES) : [];
      const slim = tabs.map((t) => ({
        path: t.path ? String(t.path) : null,
        name: String(t.name || ""),
        size: Number(t.size) || 0,
        line: Math.max(1, Math.floor(Number(t.line) || 1)),
        encoding: ENCODINGS.has(t.encoding) ? t.encoding : "utf-8",
        follow: Boolean(t.follow),
        levels: Array.isArray(t.levels) ? t.levels.map(String) : [],
        excludeLevels: Array.isArray(t.excludeLevels) ? t.excludeLevels.map(String) : [],
        mode: t.mode === "drop" ? "drop" : "native",
        filterQuery: t.filterQuery ? String(t.filterQuery) : "",
        filterIsRegex: Boolean(t.filterIsRegex),
        filterCaseSensitive: Boolean(t.filterCaseSensitive),
        filterInvert: Boolean(t.filterInvert),
      }));
      await fsp.writeFile(
        file,
        JSON.stringify({ version: 1, active: Math.floor(Number(p.active) || 0), tabs: slim }, null, 2),
        "utf-8",
      );
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async restoreState() {
    const file = this.stateFile();
    if (!file) return { tabs: [], active: 0 };
    let data;
    try {
      data = JSON.parse(await fsp.readFile(file, "utf-8"));
    } catch {
      return { tabs: [], active: 0 };
    }
    const tabs = [];
    for (const t of Array.isArray(data.tabs) ? data.tabs : []) {
      if (t.mode === "drop" || !t.path) {
        tabs.push({ ...t, restorable: false });
        continue;
      }
      try {
        // Restore uses the path the user already picked last session; the
        // grant root may not be set yet on panel boot.
        const opened = await this.openFileInternal(t.path);
        if (t.encoding) await this.setEncoding({ fileId: opened.fileId, encoding: t.encoding });
        if (t.follow) await this.setFollow({ fileId: opened.fileId, follow: true });
        tabs.push({ ...t, restorable: true, fileId: opened.fileId, size: opened.size });
      } catch {
        tabs.push({ ...t, restorable: false });
      }
    }
    return { tabs, active: Math.floor(Number(data.active) || 0) };
  }

  // ---- lifecycle ----------------------------------------------------------

  dispose() {
    for (const f of this.files.values()) {
      f.closed = true;
      f.epoch += 1;
      if (f.currentJob) f.currentJob.cancelled = true;
      if (f.handle) void f.retireHandle(f.handle);
    }
    this.files.clear();
    for (const j of this.jobs.values()) j.cancelled = true;
    this.jobs.clear();
  }
}

module.exports = { LogEngine, ApiError, ENCODINGS, createHostFileSystem };
