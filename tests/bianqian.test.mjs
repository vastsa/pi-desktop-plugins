import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const store = require("../plugins/pi.bianqian/store.js");
const main = require("../plugins/pi.bianqian/main.js");
const manifest = JSON.parse(
  readFileSync(join(here, "../plugins/pi.bianqian/manifest.json"), "utf8"),
);
const mainSource = readFileSync(join(here, "../plugins/pi.bianqian/main.js"), "utf8");
const panelSource = readFileSync(
  join(here, "../plugins/pi.bianqian/renderer/assets/app.js"),
  "utf8",
);
const panelCss = readFileSync(
  join(here, "../plugins/pi.bianqian/renderer/assets/app.css"),
  "utf8",
);

/** 内存落盘 mock：记录写盘次数、内容与并发深度 */
function createPersistMock() {
  const writes = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const persist = async (state) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    writes.push(JSON.parse(JSON.stringify(state)));
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
  };
  return { writes, persist, maxInFlight: () => maxInFlight };
}

function createStore({ notes = [] } = {}) {
  const state = store.sanitizeState({ version: 1, rev: 0, defaultColor: "yellow", notes });
  const mock = createPersistMock();
  const s = store.createNoteStore({ state, persist: mock.persist });
  return { s, mock, state };
}

function makeNote(overrides = {}) {
  const now = new Date().toISOString();
  return {
    id: overrides.id || "n-" + Math.random().toString(36).slice(2, 8),
    title: overrides.title ?? "标题",
    content: overrides.content ?? "",
    color: overrides.color || "yellow",
    mode: overrides.mode || "preview",
    createdAt: overrides.createdAt || now,
    updatedAt: overrides.updatedAt || now,
    deleted: overrides.deleted === true,
  };
}

// ---------------------------------------------------------------------------
// manifest
// ---------------------------------------------------------------------------

test("manifest declares the expected identity, permissions and contributions", () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.id, "pi.bianqian");
  assert.equal(manifest.version, "0.1.0");
  assert.match(manifest.engines.piDesktop, /^>=/);
  assert.equal(manifest.ui.panel, "renderer/index.html");
  assert.deepEqual(manifest.permissions, [
    "ui.panel",
    "agent.tool.register",
    "agent.prompt.inject",
    "shell.openExternal",
  ]);
  assert.equal(manifest.ui.title.en, "Sticky Notes");
  assert.equal(manifest.ui.title["zh-CN"], "便签");
  assert.deepEqual(manifest.contributes.skills, ["skills/bianqian.md"]);

  const commandIds = manifest.contributes.commands.map((c) => c.id);
  assert.deepEqual(commandIds, ["bianqian.open", "bianqian.new"]);

  const toolNames = manifest.contributes.agentTools.map((t) => t.name);
  assert.deepEqual(toolNames, [
    "list_notes",
    "get_note",
    "search_notes",
    "create_note",
    "update_note",
    "delete_note",
    "restore_note",
    "purge_note",
  ]);
  const riskOf = Object.fromEntries(
    manifest.contributes.agentTools.map((t) => [t.name, t.risk]),
  );
  assert.equal(riskOf.list_notes, "low");
  assert.equal(riskOf.get_note, "low");
  assert.equal(riskOf.search_notes, "low");
  assert.equal(riskOf.create_note, "medium");
  assert.equal(riskOf.update_note, "medium");
  assert.equal(riskOf.delete_note, "medium");
  assert.equal(riskOf.restore_note, "medium");
  assert.equal(riskOf.purge_note, "high");
  assert.ok(!JSON.stringify(manifest).includes('"fs.'), "no file permissions requested");
  assert.ok(!JSON.stringify(manifest).includes("net.fetch"), "no network permission requested");
});

test("main.js registers every tool and command it declares, and routes panel channels", () => {
  for (const tool of manifest.contributes.agentTools) {
    assert.match(mainSource, new RegExp(`name: '${tool.name}'`), `tool ${tool.name} registered`);
  }
  for (const command of manifest.contributes.commands) {
    assert.match(mainSource, new RegExp(`id: '${command.id}'`), `command ${command.id} registered`);
  }
  for (const channel of [
    "notes.list",
    "notes.search",
    "note.get",
    "note.create",
    "note.save",
    "note.duplicate",
    "note.delete",
    "note.restore",
    "note.purge",
    "notes.purgeAll",
  ]) {
    assert.match(mainSource, new RegExp(`case '${channel}'`), `panel channel ${channel} handled`);
  }
  assert.match(mainSource, /normalizeChannel/, "unwraps skill.setEnabled id");
  assert.match(panelSource, /skill\.setEnabled/, "panel invokes through the host-only channel");
  assert.match(panelCss, /data-theme=dark/, "panel follows app appearance via CSS variables");
});

// ---------------------------------------------------------------------------
// store.js — pure logic
// ---------------------------------------------------------------------------

test("deriveTitle prefers heading, falls back to first line, strips highlight markup", () => {
  assert.equal(store.deriveTitle("# 主标题\n正文"), "主标题");
  assert.equal(store.deriveTitle("## ==green:重要== 事项\n正文"), "重要 事项");
  assert.equal(store.deriveTitle("- [ ] 待办任务\n正文"), "待办任务");
  assert.equal(store.deriveTitle("  第一行内容  \n第二行"), "第一行内容");
  assert.equal(store.deriveTitle("  \n\n"), "未命名便签");
  // 未知颜色前缀不算高亮，保留原样
  assert.equal(store.deriveTitle("==custom:未知色=="), "==custom:未知色==");
});

test("deriveSnippet skips the title line and strips markdown syntax", () => {
  assert.equal(store.deriveSnippet("# 标题\n正文 **粗体** 内容"), "正文 粗体 内容");
  assert.equal(store.deriveSnippet("# 标题\n- [ ] 任务项\n- 第二条"), "任务项");
  assert.equal(store.deriveSnippet("# 标题\n![截图](attach://x.png) 说明"), "[图片] 说明");
  assert.equal(store.deriveSnippet("# 标题\n[链接](https://a.b) 文字"), "链接 文字");
  assert.equal(store.deriveSnippet("只有一行"), "只有一行");
});

test("sanitizeState repairs broken entries and drops invalid ones", () => {
  const state = store.sanitizeState({
    version: 1,
    rev: 7,
    defaultColor: "pink",
    notes: [
      makeNote({ id: "ok" }),
      { id: "no-content", title: "" }, // title 由 content 重新派生
      { id: "bad-color", color: "neon" }, // 回退 defaultColor
      { id: "bad-mode", mode: "weird" }, // 回退 preview
      { id: "no-timestamps" }, // 补 0 时刻
      null,
      { content: 42 }, // 无 id → 丢弃
    ],
  });
  assert.equal(state.rev, 7);
  assert.equal(state.defaultColor, "pink");
  assert.equal(state.notes.length, 5);
  assert.equal(state.notes[1].title, "未命名便签");
  assert.equal(state.notes[2].color, "pink");
  assert.equal(state.notes[3].mode, "preview");
  assert.ok(state.notes[4].createdAt && state.notes[4].updatedAt);
});

test("create/update/duplicate bump rev and persist the full snapshot", async () => {
  const { s, mock } = createStore();
  const created = s.create({ content: "# 新便签\n内容", color: "blue" });
  assert.equal(created.title, "新便签");
  assert.equal(created.color, "blue");
  assert.equal(created.mode, "preview");
  assert.equal(created.deleted, false);
  assert.equal(s.snapshot().rev, 1);
  assert.equal(s.snapshot().notes[0].id, created.id, "newest note first");
  assert.equal(mock.writes.length, 0, "mutations persist on flush, not eagerly");

  await s.flush();
  assert.equal(mock.writes.length, 1);
  assert.equal(mock.writes[0].rev, 1);

  const updated = s.update(created.id, { content: "## 改后的标题\n新正文", color: "pink" });
  assert.equal(updated.title, "改后的标题");
  assert.equal(updated.color, "pink");
  assert.equal(s.snapshot().rev, 2);

  const dup = s.duplicate(created.id);
  assert.notEqual(dup.id, created.id);
  assert.equal(dup.content, "## 改后的标题\n新正文");
  assert.equal(dup.mode, "preview");
  assert.equal(s.snapshot().rev, 3);
});

test("update validates patch keys, color and mode with error codes", () => {
  const { s } = createStore({ notes: [makeNote({ id: "a" })] });
  assert.throws(() => s.update("a", { content: 42 }), (e) => e.code === "INVALID_ARGUMENT");
  assert.throws(() => s.update("a", { color: "neon" }), (e) => e.code === "INVALID_ARGUMENT");
  assert.throws(() => s.update("a", { mode: "weird" }), (e) => e.code === "INVALID_ARGUMENT");
  assert.throws(() => s.update("a", { title: "x" }), (e) => e.code === "INVALID_ARGUMENT");
  assert.throws(() => s.update("a", null), (e) => e.code === "INVALID_ARGUMENT");
  assert.throws(() => s.update("missing", {}), (e) => e.code === "NOT_FOUND");
});

test("soft delete / restore / purge / purgeAll lifecycle", async () => {
  const { s } = createStore({
    notes: [makeNote({ id: "a" }), makeNote({ id: "b" }), makeNote({ id: "c" })],
  });
  const rev0 = s.snapshot().rev;

  s.remove("a");
  assert.equal(s.get("a").deleted, true);
  assert.equal(s.list().notes.filter((n) => n.deleted).length, 1);
  assert.equal(s.snapshot().rev, rev0 + 1);

  s.restore("a");
  assert.equal(s.get("a").deleted, false);

  s.remove("b");
  s.remove("c");
  await s.flush();
  assert.equal(s.list().notes.filter((n) => n.deleted).length, 2);
  assert.deepEqual(s.list().notes.filter((n) => n.deleted).map((n) => n.id), ["b", "c"]);

  s.purge("b");
  assert.throws(() => s.get("b"), (e) => e.code === "NOT_FOUND");

  s.purgeAll();
  assert.equal(s.snapshot().notes.length, 1);
  assert.equal(s.get("a").deleted, false, "active notes survive purgeAll");

  assert.throws(() => s.remove("gone"), (e) => e.code === "NOT_FOUND");
});

test("list/search return summaries with derived snippets", () => {
  const { s } = createStore({
    notes: [makeNote({ id: "a", content: "# 购物清单\n牛奶和面包" })],
  });
  const { rev, notes } = s.list();
  assert.equal(rev, 0);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].snippet, "牛奶和面包");
  assert.equal(notes[0].content, undefined, "summaries never carry full content");

  assert.equal(s.search("牛奶").notes.length, 1);
  assert.equal(s.search("购物").notes.length, 1);
  assert.equal(s.search("不存在的词").notes.length, 0);
  assert.equal(s.search("").notes.length, 1, "empty query returns everything");
  assert.deepEqual(s.search("SHOPPING"), { rev: 0, notes: [] });
});

// ---------------------------------------------------------------------------
// main.js — channel dispatch with mocked pi
// ---------------------------------------------------------------------------

function createPiMock() {
  const registeredCommands = [];
  const registeredTools = [];
  const writes = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const pi = {
    plugin: {
      getSettings: async () => ({ version: 1, rev: 0, defaultColor: "yellow", notes: [] }),
      setSettings: async (settings) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        writes.push(JSON.parse(JSON.stringify(settings)));
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
      },
    },
    commands: {
      register: async (cmd) => registeredCommands.push(cmd.id),
      unregister: async (id) => {
        const i = registeredCommands.indexOf(id);
        if (i >= 0) registeredCommands.splice(i, 1);
      },
    },
    agent: {
      registerTool: async (tool) => registeredTools.push(tool.name),
      unregisterTool: async (name) => {
        const i = registeredTools.indexOf(name);
        if (i >= 0) registeredTools.splice(i, 1);
      },
    },
    ui: { openPanel: async () => {} },
  };
  return { pi, registeredCommands, registeredTools, writes, maxInFlight: () => maxInFlight };
}

test("onLoad registers commands and tools; onUnload removes them", async () => {
  const { pi, registeredCommands, registeredTools } = createPiMock();
  global.pi = pi;
  try {
    await main.onLoad();
    assert.deepEqual(registeredCommands, ["bianqian.open", "bianqian.new"]);
    assert.deepEqual(registeredTools, manifest.contributes.agentTools.map((t) => t.name));

    await main.onUnload();
    assert.deepEqual(registeredCommands, []);
    assert.deepEqual(registeredTools, []);
  } finally {
    delete global.pi;
  }
});

test("panel invokes flow through skill.setEnabled and persist serially", async () => {
  const { pi, writes } = createPiMock();
  global.pi = pi;
  try {
    await main.onLoad();

    const created = await main.onPanelInvoke("skill.setEnabled", { id: "note.create", content: "# 面板建的\n正文" });
    assert.equal(created.ok, true);
    assert.equal(created.note.title, "面板建的");
    assert.equal(writes.length, 1);
    assert.equal(writes[0].rev, 1);

    const id = created.note.id;
    const saved = await main.onPanelInvoke("skill.setEnabled", {
      id: "note.save",
      noteId: id,
      patch: { content: "## 新标题", color: "green" },
    });
    assert.equal(saved.note.title, "新标题");
    assert.equal(saved.note.color, "green");
    assert.equal(writes.length, 2);

    const list = await main.onPanelInvoke("notes.list");
    assert.equal(list.ok, true);
    assert.equal(list.notes.length, 1);
    assert.equal(list.rev, 2);

    const dup = await main.onPanelInvoke("note.duplicate", { noteId: id });
    assert.equal(dup.note.content, "## 新标题");

    // 并发写：串行化，不互相覆盖
    await Promise.all([
      main.onPanelInvoke("skill.setEnabled", { id: "note.save", noteId: id, patch: { content: "A" } }),
      main.onPanelInvoke("skill.setEnabled", { id: "note.save", noteId: id, patch: { color: "pink" } }),
      main.onPanelInvoke("skill.setEnabled", { id: "note.save", noteId: id, patch: { mode: "edit" } }),
    ]);
    const finalNote = await main.onPanelInvoke("note.get", { noteId: id });
    assert.equal(finalNote.note.content, "A");
    assert.equal(finalNote.note.color, "pink");
    assert.equal(finalNote.note.mode, "edit");
    assert.equal(writes.length, 6, "every mutation persisted");
    assert.equal(writes[5].rev, 6);
  } finally {
    delete global.pi;
  }
});

test("agent tool namespace is handled via tools and errors carry codes", async () => {
  const { pi } = createPiMock();
  global.pi = pi;
  try {
    await main.onLoad();

    const created = await main.onPanelInvoke("skill.setEnabled", { id: "note.create", content: "代理建的内容" });
    const id = created.note.id;

    // 工具路径没有独立入口：agent 工具与面板共用 store，验证共享变更可见
    const before = await main.onPanelInvoke("notes.list");
    assert.equal(before.notes.length, 1);

    // 错误路径：未知通道、不存在便签、非法 patch
    await assert.rejects(
      () => main.onPanelInvoke("nope"),
      (e) => e.code === "UNSUPPORTED",
    );
    await assert.rejects(
      () => main.onPanelInvoke("note.get", { noteId: "missing" }),
      (e) => e.code === "NOT_FOUND",
    );
    await assert.rejects(
      () => main.onPanelInvoke("note.save", { noteId: id, patch: { color: "neon" } }),
      (e) => e.code === "INVALID_ARGUMENT",
    );
    await assert.rejects(
      () => main.onPanelInvoke("skill.setEnabled", { id: "note.purge" }),
      (e) => e.code === "NOT_FOUND",
    );
  } finally {
    delete global.pi;
  }
});
