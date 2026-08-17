'use strict';

/**
 * 便签数据仓库（纯逻辑层，不依赖 pi API —— 可单测，见 tests/bianqian.test.mjs）。
 *
 * 数据形态（settings.json，whole-file 读写）：
 *   { version: 1, rev: <number>, defaultColor: 'yellow',
 *     notes: [{ id, title, content, color, mode, createdAt, updatedAt, deleted }] }
 *
 * 权威数据 = 内存中的 state；每次变更 rev+1，调用方（main.js）经 persist(state)
 * 全量落盘。persist 由 main.js 注入并用 promise 队列串行化，避免并发
 * read-modify-write 互相覆盖。
 *
 * title/snippet 派生、高亮标记语法剥离移植自桌面版 electron/shared/types.ts
 * 与 electron/shared/highlight.ts，规则保持一致。
 */

const crypto = require('node:crypto');

/** 便签颜色白名单（与面板 dev/src/lib/types.ts 的 NOTE_COLORS 一致） */
const NOTE_COLORS = ['yellow', 'pink', 'blue', 'green', 'purple', 'gray'];

/** 荧光笔颜色白名单（==颜色:文本==，与 dev/src/lib/highlight.ts 的 HIGHLIGHT_COLORS 一致） */
const HIGHLIGHT_NAMES = ['yellow', 'green', 'blue', 'pink', 'orange', 'red'];

const MARK_STRIP_RE = /==((?:[a-z]+:)?[^=\s][^=]*?)==/g;

function highlightNameOf(content) {
  const m = content.match(/^([a-z]+):/);
  return m && HIGHLIGHT_NAMES.includes(m[1]) ? m[1] : null;
}

/** 删除文本中的 ==颜色:文本== 标记语法（未知颜色前缀保留原样） */
function stripHighlightMarkup(text) {
  return String(text).replace(MARK_STRIP_RE, (whole, content) => {
    const color = highlightNameOf(content);
    return color ? content.slice(color.length + 1) : whole;
  });
}

/** 从内容派生标题（桌面版 deriveTitle）：首个标题行，其次首个非空行 */
function deriveTitle(content) {
  const lines = String(content || '').split(/\r?\n/);
  for (const line of lines) {
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading) {
      return stripHighlightMarkup(heading[1]).trim().slice(0, 40);
    }
    const text = stripHighlightMarkup(line.trim());
    if (text) {
      return text.replace(/^[#>*\-\d.\s\[\]xX]+/, '').trim().slice(0, 20) || '未命名便签';
    }
  }
  return '未命名便签';
}

/** 首个非空行之后的正文片段（桌面版 deriveSnippet），供列表预览 */
function deriveSnippet(content, max = 72) {
  const lines = String(content || '').split(/\r?\n/);
  let skippedTitle = false;
  for (const line of lines) {
    const raw = line.trim();
    if (!raw) continue;
    if (!skippedTitle) {
      skippedTitle = true;
      continue;
    }
    const cleaned = raw
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '[图片]')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[`*_~#>|]/g, '')
      .replace(/^\s*[-*+]\s+(\[[ xX]\])?\s*/, '')
      .replace(/^\s*\d+\.\s+/, '')
      .trim();
    if (cleaned) return cleaned.slice(0, max);
  }
  // 只有一行内容时回退到该行本身
  const only = lines.map((l) => l.trim()).find(Boolean) || '';
  const cleanedOnly = only
    .replace(/^#{1,6}\s+/, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '[图片]')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~]/g, '')
    .trim();
  return cleanedOnly.slice(0, max);
}

/**
 * 持久化数据的字段级净化：损坏/缺字段的便签逐条修复或丢弃，
 * 防止旧版本数据或手动编辑的 settings.json 破坏运行时。
 */
function sanitizeState(raw) {
  const state = { version: 1, rev: 0, defaultColor: 'yellow', notes: [] };
  if (raw && typeof raw === 'object') {
    if (NOTE_COLORS.includes(raw.defaultColor)) state.defaultColor = raw.defaultColor;
    if (Number.isInteger(raw.rev) && raw.rev >= 0) state.rev = raw.rev;
    if (Array.isArray(raw.notes)) {
      for (const n of raw.notes) {
        if (!n || typeof n !== 'object' || typeof n.id !== 'string' || !n.id) continue;
        const content = typeof n.content === 'string' ? n.content : '';
        state.notes.push({
          id: n.id,
          title: typeof n.title === 'string' && n.title ? n.title : deriveTitle(content),
          content,
          color: NOTE_COLORS.includes(n.color) ? n.color : state.defaultColor,
          mode: n.mode === 'edit' ? 'edit' : 'preview',
          createdAt: typeof n.createdAt === 'string' ? n.createdAt : new Date(0).toISOString(),
          updatedAt: typeof n.updatedAt === 'string' ? n.updatedAt : new Date(0).toISOString(),
          deleted: n.deleted === true
        });
      }
    }
  }
  return state;
}

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function cloneNote(note) {
  return {
    id: note.id,
    title: note.title,
    content: note.content,
    color: note.color,
    mode: note.mode,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    deleted: note.deleted
  };
}

/**
 * 创建便签仓库。state 为内存权威数据（已 sanitize），persist 由调用方注入：
 *   persist(snapshot) → Promise<void>（main.js 里串行化落盘）。
 * 变更方法同步更新内存并返回结果；调用方 await store.flush() 确认落盘。
 */
function createNoteStore({ state, persist }) {
  function snapshot() {
    return state;
  }

  /** 把当前内存状态全量落盘（调用方注入的 persist 自带串行化） */
  function flush() {
    return persist(state);
  }

  function summaryOf(note) {
    return {
      id: note.id,
      title: note.title,
      snippet: deriveSnippet(note.content),
      color: note.color,
      updatedAt: note.updatedAt,
      createdAt: note.createdAt,
      deleted: note.deleted
    };
  }

  function requireNote(id) {
    const note = state.notes.find((n) => n.id === id);
    if (!note) throw fail('NOT_FOUND', '便签不存在: ' + id);
    return note;
  }

  function list() {
    return { rev: state.rev, notes: state.notes.map(summaryOf) };
  }

  function search(query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return list();
    const notes = state.notes.filter((n) => {
      return (
        n.title.toLowerCase().includes(q) ||
        deriveSnippet(n.content).toLowerCase().includes(q) ||
        n.content.toLowerCase().includes(q)
      );
    });
    return { rev: state.rev, notes: notes.map(summaryOf) };
  }

  function get(id) {
    return cloneNote(requireNote(id));
  }

  /** 新建便签：默认色来自 defaultColor，mode 固定 preview，插入列表顶部 */
  function create({ content, color } = {}) {
    const now = new Date().toISOString();
    const note = {
      id: crypto.randomUUID(),
      title: deriveTitle(content),
      content: String(content || ''),
      color: NOTE_COLORS.includes(color) ? color : state.defaultColor,
      mode: 'preview',
      createdAt: now,
      updatedAt: now,
      deleted: false
    };
    state.notes.unshift(note);
    state.rev += 1;
    return cloneNote(note);
  }

  const PATCH_KEYS = ['content', 'color', 'mode'];

  /** 局部更新（NotePatch 语义，见面板 dev/src/api.ts）；content 变更自动重派生 title */
  function update(id, patch) {
    const note = requireNote(id);
    if (!patch || typeof patch !== 'object') {
      throw fail('INVALID_ARGUMENT', 'patch 必须是对象');
    }
    for (const key of Object.keys(patch)) {
      if (!PATCH_KEYS.includes(key)) {
        throw fail('INVALID_ARGUMENT', '不支持的字段: ' + key);
      }
    }
    if (patch.content !== undefined) {
      if (typeof patch.content !== 'string') {
        throw fail('INVALID_ARGUMENT', 'content 必须是字符串');
      }
      note.content = patch.content;
      note.title = deriveTitle(patch.content);
    }
    if (patch.color !== undefined) {
      if (!NOTE_COLORS.includes(patch.color)) {
        throw fail('INVALID_ARGUMENT', '未知颜色: ' + patch.color);
      }
      note.color = patch.color;
    }
    if (patch.mode !== undefined) {
      if (patch.mode !== 'preview' && patch.mode !== 'edit') {
        throw fail('INVALID_ARGUMENT', 'mode 必须是 preview 或 edit');
      }
      note.mode = patch.mode;
    }
    note.updatedAt = new Date().toISOString();
    state.rev += 1;
    return cloneNote(note);
  }

  /** 复制便签：内容/颜色同源，mode 重置为 preview，插入列表顶部 */
  function duplicate(id) {
    const src = requireNote(id);
    const now = new Date().toISOString();
    const note = {
      id: crypto.randomUUID(),
      title: src.title,
      content: src.content,
      color: src.color,
      mode: 'preview',
      createdAt: now,
      updatedAt: now,
      deleted: false
    };
    state.notes.unshift(note);
    state.rev += 1;
    return cloneNote(note);
  }

  /** 软删除：移入回收站（deleted=true），列表不再显示 */
  function remove(id) {
    const note = requireNote(id);
    note.deleted = true;
    note.updatedAt = new Date().toISOString();
    state.rev += 1;
  }

  function restore(id) {
    const note = requireNote(id);
    note.deleted = false;
    note.updatedAt = new Date().toISOString();
    state.rev += 1;
  }

  /** 永久删除 */
  function purge(id) {
    requireNote(id);
    state.notes = state.notes.filter((n) => n.id !== id);
    state.rev += 1;
  }

  /** 清空回收站（永久删除全部已删除便签） */
  function purgeAll() {
    const before = state.notes.length;
    state.notes = state.notes.filter((n) => !n.deleted);
    if (state.notes.length !== before) state.rev += 1;
  }

  return {
    snapshot,
    flush,
    list,
    search,
    get,
    create,
    update,
    duplicate,
    remove,
    restore,
    purge,
    purgeAll
  };
}

module.exports = {
  createNoteStore,
  sanitizeState,
  deriveTitle,
  deriveSnippet,
  stripHighlightMarkup,
  NOTE_COLORS
};
