'use strict';

/**
 * 便签 — PI-Desktop 插件（主进程）。
 *
 * 插件 id: pi.bianqian
 * 命令 id: bianqian.open / bianqian.new
 * agent 工具: list_notes / get_note / search_notes / create_note / update_note /
 *             delete_note / restore_note / purge_note（宿主侧前缀 plugin_bianqian_）
 *
 * 数据模型（与面板/技能文档共享）：
 *   settings.json = { version: 1, rev, defaultColor, notes: [...] }
 * 权威数据源 = 插件数据目录 settings.json（pi.plugin.getSettings/setSettings）。
 * 面板与 agent 工具共用同一 store 实例；每次变更 rev+1 并全量写盘，
 * 写操作经 promise 队列串行化（防 whole-file read-modify-write 丢更新）。
 *
 * 面板通道（宿主限定：面板 → 插件进程唯一通道是 skill.setEnabled，
 * 见 normalizeChannel）：notes.list / notes.search / note.get / note.create /
 * note.save / note.duplicate / note.delete / note.restore / note.purge /
 * notes.purgeAll。shell.openExternal、app.getAppearance 等宿主通道由宿主
 * 直接处理，不会到达 onPanelInvoke。
 *
 * 权限说明：
 * - ui.panel：面板入口（manifest.ui.panel）
 * - agent.tool.register：注册 agent 工具
 * - agent.prompt.inject：contributes.skills 索引需要
 * - shell.openExternal：点击便签内链接经宿主打开系统浏览器
 */

const { createNoteStore, sanitizeState } = require('./store');

/** 写队列：所有 setSettings 串行执行，避免并发 whole-file 覆盖 */
let writeChain = Promise.resolve();

let store = null;

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * 宿主把面板桥接的 skill.* 通道原样转发到这里：
 * 面板 invoke("skill.setEnabled", { id: "note.save", ... }) 时，
 * 本函数收到 channel="skill.setEnabled"、payload.id="note.save"；
 * 同时兼容宿主未来直接传自定义通道名的形式。
 */
function normalizeChannel(channel, payload) {
  if (
    channel === 'skill.setEnabled' &&
    payload &&
    typeof payload.id === 'string' &&
    payload.id
  ) {
    return payload.id;
  }
  return channel;
}

/** 全量落盘（串行化） */
function persist(state) {
  writeChain = writeChain.then(() => pi.plugin.setSettings(state));
  return writeChain;
}

async function loadState() {
  try {
    return sanitizeState(await pi.plugin.getSettings());
  } catch {
    return sanitizeState(null);
  }
}

// ---------------------------------------------------------------------------
// agent tools（与面板共享同一 store）
// ---------------------------------------------------------------------------

function toolListNotes(args) {
  const includeDeleted = args?.includeDeleted === true;
  const { rev, notes } = store.list();
  return {
    ok: true,
    rev,
    notes: includeDeleted ? notes : notes.filter((n) => !n.deleted),
  };
}

function toolGetNote(args) {
  const note = store.get(String(args?.id || ''));
  return { ok: true, note };
}

function toolSearchNotes(args) {
  const { rev, notes } = store.search(args?.query);
  return {
    ok: true,
    rev,
    notes: notes.filter((n) => !n.deleted),
  };
}

async function toolCreateNote(args) {
  const note = store.create({ content: args?.content, color: args?.color });
  await store.flush();
  return { ok: true, note };
}

async function toolUpdateNote(args) {
  const patch = {};
  if (args?.content !== undefined) patch.content = args.content;
  if (args?.color !== undefined) patch.color = args.color;
  if (args?.mode !== undefined) patch.mode = args.mode;
  const note = store.update(String(args?.id || ''), patch);
  await store.flush();
  return { ok: true, note };
}

async function toolDeleteNote(args) {
  store.remove(String(args?.id || ''));
  await store.flush();
  return { ok: true };
}

async function toolRestoreNote(args) {
  store.restore(String(args?.id || ''));
  await store.flush();
  return { ok: true };
}

async function toolPurgeNote(args) {
  store.purge(String(args?.id || ''));
  await store.flush();
  return { ok: true };
}

const TOOLS = [
  {
    name: 'list_notes',
    description:
      'List all sticky notes with title, snippet, color and timestamps; deleted notes are included only when includeDeleted is true.',
    risk: 'low',
    schema: {
      type: 'object',
      properties: {
        includeDeleted: { type: 'boolean', description: 'Include soft-deleted notes' },
      },
    },
    execute: toolListNotes,
  },
  {
    name: 'get_note',
    description: "Read one sticky note's full markdown content by id.",
    risk: 'low',
    schema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Note id' } },
      required: ['id'],
    },
    execute: toolGetNote,
  },
  {
    name: 'search_notes',
    description: 'Search sticky notes by title, snippet or content (case-insensitive substring).',
    risk: 'low',
    schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search text' } },
      required: ['query'],
    },
    execute: toolSearchNotes,
  },
  {
    name: 'create_note',
    description:
      'Create a new sticky note with optional markdown content and color. The title is derived from the content first heading or line.',
    risk: 'medium',
    schema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Markdown content (default: empty note)' },
        color: {
          type: 'string',
          enum: ['yellow', 'pink', 'blue', 'green', 'purple', 'gray'],
          description: 'Note color',
        },
      },
    },
    execute: toolCreateNote,
  },
  {
    name: 'update_note',
    description: "Update a sticky note's content, color or mode. Content changes re-derive the title automatically.",
    risk: 'medium',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        content: { type: 'string', description: 'New markdown content' },
        color: {
          type: 'string',
          enum: ['yellow', 'pink', 'blue', 'green', 'purple', 'gray'],
        },
        mode: { type: 'string', enum: ['preview', 'edit'] },
      },
      required: ['id'],
    },
    execute: toolUpdateNote,
  },
  {
    name: 'delete_note',
    description: 'Move a sticky note to the recycle bin (soft delete; restorable via restore_note).',
    risk: 'medium',
    schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    execute: toolDeleteNote,
  },
  {
    name: 'restore_note',
    description: 'Restore a soft-deleted sticky note from the recycle bin.',
    risk: 'medium',
    schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    execute: toolRestoreNote,
  },
  {
    name: 'purge_note',
    description: 'Permanently delete a sticky note. This cannot be undone.',
    risk: 'high',
    schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    execute: toolPurgeNote,
  },
];

// ---------------------------------------------------------------------------
// panel bridge (onPanelInvoke)
// ---------------------------------------------------------------------------

async function onPanelInvoke(channel, payload) {
  const name = normalizeChannel(channel, payload);
  const args = payload || {};

  switch (name) {
    case 'notes.list': {
      const { rev, notes } = store.list();
      return { ok: true, rev, notes };
    }
    case 'notes.search': {
      const { rev, notes } = store.search(args.query);
      return { ok: true, rev, notes };
    }
    case 'note.get': {
      const note = store.get(String(args.noteId || ''));
      return { ok: true, note };
    }
    case 'note.create': {
      const note = store.create({ content: args.content, color: args.color });
      await store.flush();
      return { ok: true, note };
    }
    case 'note.save': {
      const patch = args.patch && typeof args.patch === 'object' ? args.patch : {};
      const note = store.update(String(args.noteId || ''), patch);
      await store.flush();
      return { ok: true, note };
    }
    case 'note.duplicate': {
      const note = store.duplicate(String(args.noteId || ''));
      await store.flush();
      return { ok: true, note };
    }
    case 'note.delete': {
      store.remove(String(args.noteId || ''));
      await store.flush();
      return { ok: true };
    }
    case 'note.restore': {
      store.restore(String(args.noteId || ''));
      await store.flush();
      return { ok: true };
    }
    case 'note.purge': {
      store.purge(String(args.noteId || ''));
      await store.flush();
      return { ok: true };
    }
    case 'notes.purgeAll': {
      store.purgeAll();
      await store.flush();
      return { ok: true };
    }
    default:
      throw fail('UNSUPPORTED', 'unsupported panel channel: ' + channel);
  }
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

async function registerCommands() {
  await pi.commands.register({
    id: 'bianqian.open',
    title: '便签：打开面板',
    keywords: ['sticky', 'note', '便签', '记事', 'markdown'],
    category: 'Productivity',
    run: async () => {
      // 不传 title：让宿主解析 manifest.ui.title 的本地化标题
      await pi.ui.openPanel();
    },
  });
  await pi.commands.register({
    id: 'bianqian.new',
    title: '便签：新建便签',
    keywords: ['sticky', 'note', '新建便签', '新建记事'],
    category: 'Productivity',
    run: async () => {
      store.create({});
      await store.flush();
      await pi.ui.openPanel();
    },
  });
}

async function registerTools() {
  for (const tool of TOOLS) {
    await pi.agent.registerTool({
      name: tool.name,
      description: tool.description,
      risk: tool.risk,
      schema: tool.schema,
      execute: tool.execute,
    });
  }
}

async function onLoad() {
  store = createNoteStore({ state: await loadState(), persist });
  await registerCommands();
  await registerTools();
}

async function onUnload() {
  const commands = ['bianqian.open', 'bianqian.new'];
  const tools = TOOLS.map((t) => t.name);
  await Promise.all([
    ...commands.map((id) => pi.commands.unregister(id).catch(() => {})),
    ...tools.map((name) => pi.agent.unregisterTool(name).catch(() => {})),
  ]);
}

module.exports = { onLoad, onUnload, onPanelInvoke };
