// @ts-check
/**
 * Tests for the extensibility layer's format drivers.
 *
 * Each driver is exercised against a real on-disk fixture (a JSONL transcript,
 * a JSON session tree, and a SQLite database shaped like OpenCode/ZCode), so
 * these cover the actual mapping code paths rather than mocks.
 *
 * Run:
 *   node --test test/drivers.test.mjs
 */
"use strict";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const PLUGIN_DIR = "/Users/blackevil/dev/pi-desktop-session-import";

const jsonl = require(`${PLUGIN_DIR}/lib/drivers/jsonl-transcript.js`);
const jsonTree = require(`${PLUGIN_DIR}/lib/drivers/json-tree.js`);
const sqliteSession = require(`${PLUGIN_DIR}/lib/drivers/sqlite-session.js`);
const drivers = require(`${PLUGIN_DIR}/lib/drivers/index.js`);
const { makeDeclarativeSource } = require(`${PLUGIN_DIR}/lib/sources/declarative.js`);

let tmpRoot;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sidrv-"));
});
after(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

function makeDir(name) {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/* ------------------------------------------------------------------ *
 * jsonl-transcript
 * ------------------------------------------------------------------ */

describe("driver: jsonl-transcript", () => {
  // Each call gets its own directory: scans are recursive, so sharing one
  // would let later tests see earlier fixtures.
  let seq = 0;
  const dir = () => makeDir(`jsonl-${++seq}`);

  test("scans a transcript and derives title/count/project", async () => {
    const root = dir();
    const file = path.join(root, "proj-a", "sess-1.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      [
        JSON.stringify({
          role: "user",
          message: { content: [{ type: "text", text: "fix the build" }] },
          timestamp: 1700000000000,
        }),
        JSON.stringify({
          role: "assistant",
          message: { content: [{ type: "text", text: "on it" }] },
          timestamp: 1700000001000,
        }),
      ].join("\n") + "\n",
    );

    const spec = {
      driver: "jsonl-transcript",
      root,
      extension: ".jsonl",
      session: { idFrom: "filename", titleFrom: "firstUser", projectFrom: "parentDir" },
      entry: {
        rolePath: "role",
        content: {
          blocks: { path: "message.content", typeField: "type", types: ["text"], textField: "text" },
        },
        tsPath: "timestamp",
      },
    };

    const summaries = await jsonl.scan(spec, "mytest");
    assert.equal(summaries.length, 1);
    const s = summaries[0];
    assert.equal(s.source, "mytest");
    assert.equal(s.externalId, "sess-1");
    assert.equal(s.messageCount, 2);
    assert.equal(s.title, "fix the build"); // titleFrom: firstUser
    assert.ok(s.projectName); // parentDir derived
    assert.equal(s.filePath, file);
    assert.ok(s.createdAt);
  });

  test("maps tool entries into tool messages", async () => {
    const root = dir();
    const file = path.join(root, "sess-2.jsonl");
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ role: "user", content: "run ls", timestamp: 1700000000000 }),
        JSON.stringify({
          type: "tool_use",
          name: "bash",
          input: { cmd: "ls" },
          output: "file.txt",
          status: "completed",
          timestamp: 1700000001000,
        }),
        JSON.stringify({ role: "assistant", content: "done", timestamp: 1700000002000 }),
      ].join("\n") + "\n",
    );

    const spec = {
      driver: "jsonl-transcript",
      root,
      entry: {
        rolePath: "role",
        content: { path: "content" },
        tsPath: "timestamp",
        tool: {
          typePath: "type",
          toolTypes: ["tool_use"],
          namePath: "name",
          argsPath: "input",
          resultPath: "output",
          statusPath: "status",
        },
      },
    };

    const summaries = await jsonl.scan(spec, "mytest");
    assert.equal(summaries.length, 1);
    const { messages } = await jsonl.convert(spec, summaries[0]);
    assert.equal(messages.length, 3);
    assert.deepEqual(
      messages.map((m) => m.role),
      ["user", "tool", "assistant"],
    );
    const tool = messages[1];
    assert.equal(tool.toolName, "bash");
    assert.equal(tool.toolStatus, "success");
    assert.equal(tool.content, "file.txt");
    assert.deepEqual(tool.toolArgs, { cmd: "ls" });
  });

  test("idFromEntry keeps a per-item id from shadowing the session id", async () => {
    const root = dir();
    // Codex: every response_item carries its own id, so a naive "first id wins"
    // would name the session after an item instead of the session_meta line.
    fs.writeFileSync(
      path.join(root, "sess-3.jsonl"),
      [
        JSON.stringify({ timestamp: 1, type: "response_item", payload: { id: "item-1", type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] } }),
        JSON.stringify({ timestamp: 2, type: "session_meta", payload: { id: "sess-real", cwd: "/tmp" } }),
      ].join("\n") + "\n",
    );

    const spec = {
      driver: "jsonl-transcript",
      root,
      entry: {
        unwrapPath: "payload",
        rolePath: "role",
        content: { blocks: { path: "content", typeField: "type", types: ["input_text"], textField: "text" } },
        tsPath: "timestamp",
      },
      session: {
        idFrom: { first: [{ path: "payload.id" }, { path: "id" }] },
        idFromEntry: { path: "type", in: ["session_meta"] },
        titleFrom: "firstUser",
      },
    };

    const summaries = await jsonl.scan(spec, "mytest");
    assert.equal(summaries[0].externalId, "sess-real");
  });

  test("ignores malformed lines and returns [] for a missing root", async () => {
    const root = dir();
    fs.writeFileSync(path.join(root, "bad.jsonl"), "{not json\n\n" + JSON.stringify({ role: "user", content: "ok" }) + "\n");
    const spec = {
      driver: "jsonl-transcript",
      root,
      entry: { rolePath: "role", content: { path: "content" } },
    };
    const summaries = await jsonl.scan(spec, "mytest");
    assert.equal(summaries.length, 1); // bad line skipped, good line kept
    assert.equal(summaries[0].messageCount, 1);

    const missing = await jsonl.scan({ ...spec, root: path.join(root, "nope") }, "mytest");
    assert.deepEqual(missing, []);
  });
});

/* ------------------------------------------------------------------ *
 * json-tree
 * ------------------------------------------------------------------ */

describe("driver: json-tree", () => {
  test("reads one JSON file per session", async () => {
    const root = makeDir("tree");
    fs.writeFileSync(
      path.join(root, "sess.json"),
      JSON.stringify({
        id: "t1",
        title: "Tree Session",
        createdAt: "2026-01-01T00:00:00Z",
        directory: "/tmp/some-project",
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi" },
        ],
      }),
    );

    const spec = {
      driver: "json-tree",
      root,
      extension: ".json",
      session: { idPath: "id", titlePath: "title", tsPath: "createdAt", pathPath: "directory", messagesPath: "messages" },
      message: { rolePath: "role", content: { path: "content" } },
    };

    const summaries = await jsonTree.scan(spec, "mytree");
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].externalId, "t1");
    assert.equal(summaries[0].title, "Tree Session");
    assert.equal(summaries[0].messageCount, 2);

    const { session, messages } = await jsonTree.convert(spec, summaries[0]);
    assert.ok(session);
    assert.equal(messages.length, 2);
    assert.equal(messages[0].content, "hello");
  });
});

/* ------------------------------------------------------------------ *
 * sqlite-session
 * ------------------------------------------------------------------ */

describe("driver: sqlite-session", () => {
  const specFor = (db) => ({
    driver: "sqlite-session",
    db,
    session: { table: "session", idCol: "id", titleCol: "title", pathCol: "directory", createdCol: "time_created", updatedCol: "time_updated" },
    message: { table: "message", idCol: "id", sessionIdCol: "session_id", createdCol: "time_created", dataCol: "data", rolePath: "role", tsPath: "time.created" },
    part: {
      table: "part",
      messageIdCol: "message_id",
      sessionIdCol: "session_id",
      createdCol: "time_created",
      dataCol: "data",
      textTypes: ["text"],
      toolType: "tool",
      toolNamePath: "tool",
      argsPath: "state.input",
      resultPath: "state.output",
      statusPath: "state.status",
    },
  });

  function buildDb(dbPath) {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
    `);
    db.prepare("INSERT INTO session VALUES (?,?,?,?,?)").run("s1", "/tmp/sqlite-proj", "SQLite Session", 1700000000000, 1700000002000);
    db.prepare("INSERT INTO message VALUES (?,?,?,?)").run(
      "m1", "s1", 1700000000000,
      JSON.stringify({ role: "user", time: { created: 1700000000000 } }),
    );
    db.prepare("INSERT INTO message VALUES (?,?,?,?)").run(
      "m2", "s1", 1700000001000,
      JSON.stringify({ role: "assistant", time: { created: 1700000001000 }, modelID: "test-model" }),
    );
    db.prepare("INSERT INTO part VALUES (?,?,?,?,?)").run(
      "p1", "m1", "s1", 1, JSON.stringify({ type: "text", text: "user asks" }),
    );
    db.prepare("INSERT INTO part VALUES (?,?,?,?,?)").run(
      "p2", "m2", "s1", 2, JSON.stringify({ type: "tool", tool: "bash", state: { status: "completed", input: { cmd: "ls" }, output: "file.txt" } }),
    );
    db.prepare("INSERT INTO part VALUES (?,?,?,?,?)").run(
      "p3", "m2", "s1", 3, JSON.stringify({ type: "text", text: "all done" }),
    );
    db.close();
  }

  test("scans sessions with message counts", async () => {
    const dir = makeDir("sqlite");
    const dbPath = path.join(dir, "test.db");
    buildDb(dbPath);

    const summaries = await sqliteSession.scan(specFor(dbPath), "mysqlite");
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].externalId, "s1");
    assert.equal(summaries[0].title, "SQLite Session");
    assert.equal(summaries[0].messageCount, 2);
  });

  test("rebuilds messages: text flush, tool payload, assistant tail", async () => {
    const dir = makeDir("sqlite2");
    const dbPath = path.join(dir, "test.db");
    buildDb(dbPath);

    const summaries = await sqliteSession.scan(specFor(dbPath), "mysqlite");
    const { session, messages } = await sqliteSession.convert(specFor(dbPath), summaries[0]);
    assert.deepEqual(
      messages.map((m) => m.role),
      ["user", "tool", "assistant"],
    );
    assert.equal(messages[0].content, "user asks");
    assert.equal(messages[1].toolName, "bash");
    assert.equal(messages[1].toolStatus, "success");
    assert.equal(messages[1].content, "file.txt");
    assert.equal(messages[2].content, "all done");
    assert.equal(session.modelId, "test-model");
  });

  test("orders by the app's own sequence column when it exists", async () => {
    // ZCode writes a monotonic `sequence`; OpenCode has no such column. Rows
    // here are inserted with deliberately misleading timestamps so only the
    // sequence column can produce the right order.
    const dir = makeDir("sqlite4");
    const dbPath = path.join(dir, "seq.db");
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT, sequence INTEGER);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT, sequence INTEGER);
    `);
    db.prepare("INSERT INTO session VALUES (?,?,?,?,?)").run("s1", "/tmp/seq", "Seq", 1, 2);
    db.prepare("INSERT INTO message VALUES (?,?,?,?,?)").run("m2", "s1", 500, JSON.stringify({ role: "assistant", time: { created: 500 } }), 2);
    db.prepare("INSERT INTO message VALUES (?,?,?,?,?)").run("m1", "s1", 900, JSON.stringify({ role: "user", time: { created: 900 } }), 1);
    db.prepare("INSERT INTO part VALUES (?,?,?,?,?,?)").run("p1", "m1", "s1", 1, JSON.stringify({ type: "text", text: "first by sequence" }), 1);
    db.prepare("INSERT INTO part VALUES (?,?,?,?,?,?)").run("p2", "m2", "s1", 2, JSON.stringify({ type: "text", text: "second by sequence" }), 2);
    db.close();

    const summaries = await sqliteSession.scan(specFor(dbPath), "mysqlite");
    const { messages } = await sqliteSession.convert(specFor(dbPath), summaries[0]);
    assert.deepEqual(
      messages.map((m) => m.content),
      ["first by sequence", "second by sequence"],
      "sequence wins over the out-of-order time_created",
    );
  });

  test("returns [] when the database is absent", async () => {
    const dir = makeDir("sqlite3");
    const summaries = await sqliteSession.scan(specFor(path.join(dir, "missing.db")), "mysqlite");
    assert.deepEqual(summaries, []);
  });
});

/* ------------------------------------------------------------------ *
 * driver registry + declarative adapter
 * ------------------------------------------------------------------ */

describe("extensibility: registry + declarative source", () => {
  test("registers exactly the three shipped drivers", () => {
    assert.deepEqual(drivers.driverNames().sort(), ["json-tree", "jsonl-transcript", "sqlite-session"]);
    assert.ok(drivers.getDriver("jsonl-transcript"));
    assert.equal(drivers.getDriver("does-not-exist"), null);
  });

  test("makeDeclarativeSource builds an adapter with the built-in contract", async () => {
    const root = makeDir("decl");
    fs.writeFileSync(
      path.join(root, "a.jsonl"),
      JSON.stringify({ role: "user", content: "hi" }) + "\n" +
        JSON.stringify({ role: "assistant", content: "yo" }) + "\n",
    );

    const adapter = makeDeclarativeSource({
      id: "mycustom",
      label: "My Custom Tool",
      driver: "jsonl-transcript",
      root,
      entry: { rolePath: "role", content: { path: "content" } },
    });

    assert.equal(adapter.source, "mycustom");
    assert.equal(adapter.label, "My Custom Tool");
    assert.equal(adapter.custom, true);
    assert.equal(typeof adapter.scan, "function");
    assert.equal(typeof adapter.convert, "function");

    const summaries = await adapter.scan();
    assert.equal(summaries.length, 1);
    const { session, messages } = await adapter.convert(summaries[0]);
    assert.ok(session);
    assert.equal(messages.length, 2);
    assert.ok(session.id.startsWith("import-mycustom-"));
  });

  test("makeDeclarativeSource rejects an unknown driver", () => {
    assert.throws(() => makeDeclarativeSource({ id: "x", label: "X", driver: "nope" }), /unknown driver/);
  });

  test("a broken spec degrades to empty results instead of throwing", async () => {
    const adapter = makeDeclarativeSource({
      id: "broken",
      label: "Broken",
      driver: "jsonl-transcript",
      root: "/nonexistent/path/for/testing",
      entry: {},
    });
    assert.deepEqual(await adapter.scan(), []);
    const out = await adapter.convert({ source: "broken", externalId: "z", filePath: "/nope" });
    assert.equal(out.session, null);
  });
});

describe("extract: content rules against real-world shapes", () => {
  const { extractText } = require(`${PLUGIN_DIR}/lib/drivers/extract.js`);
  const rule = {
    blocks: { path: "message.content", typeField: "type", types: ["text"], textField: "text" },
  };

  test("blocks rule returns a plain string when content is not an array", () => {
    assert.equal(extractText(rule, { message: { content: "plain text" } }), "plain text");
  });

  test("blocks rule never dumps raw JSON when no text block matches", () => {
    // Real Claude entries carry thinking/tool_use-only content arrays.
    assert.equal(extractText(rule, { message: { content: [{ type: "thinking", thinking: "x" }] } }), "");
    assert.equal(extractText(rule, { message: { content: [{ type: "tool_use", name: "Read" }] } }), "");
  });

  test("blocks rule joins only the matching text blocks", () => {
    const entry = {
      message: {
        content: [
          { type: "thinking", thinking: "ignored" },
          { type: "text", text: "hello" },
          { type: "text", text: "world" },
        ],
      },
    };
    assert.equal(extractText(rule, entry), "hello\nworld");
  });
});

describe("fsutil: maxDepth keeps scans out of nested non-session dirs", () => {
  const { listFiles } = require(`${PLUGIN_DIR}/lib/drivers/fsutil.js`);

  test("maxDepth 2 collects <root>/<dir>/<file> and nothing deeper", async () => {
    const root = makeDir("depth");
    fs.mkdirSync(path.join(root, "proj", ".timelines", "deep"), { recursive: true });
    fs.writeFileSync(path.join(root, "proj", "session.jsonl"), "x");
    fs.writeFileSync(path.join(root, "proj", ".timelines", "deep", "messages.jsonl"), "y");

    const shallow = await listFiles(root, { extension: ".jsonl", maxDepth: 2 });
    assert.deepEqual(shallow.map((f) => path.relative(root, f)), [path.join("proj", "session.jsonl")]);

    const deep = await listFiles(root, { extension: ".jsonl" });
    assert.equal(deep.length, 2, "unbounded recursion does reach the nested file");
  });
});
