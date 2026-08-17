/**
 * 面板 ↔ 插件进程通信。面板窗口没有 pi 对象，唯一入口是 window.pluginBridge：
 * - invoke(channel, payload) → Promise<result>（宿主会把插件进程抛出的错误转成
 *   { ok: false, error } 结果）
 * - on(channel, handler)    → 订阅宿主事件（如 appearance:changed）
 *
 * 宿主限定：面板 → 插件进程的唯一通道是 "skill.setEnabled"，自定义通道名放在
 * payload.id 里（pi.markdown / pi.todo 同款）。main.js 的 normalizeChannel 拆包。
 * shell.openExternal、app.getAppearance 等宿主通道由宿主直接处理，无需经过插件。
 */

declare global {
  interface Window {
    pluginBridge: {
      invoke(channel: string, payload?: unknown): Promise<Record<string, unknown> | null>
      on(channel: string, handler: (payload: unknown) => void): void
    }
  }
}

interface BridgeResult {
  ok?: boolean
  error?: string
  [key: string]: unknown
}

const PANEL_CHANNEL = 'skill.setEnabled'

function bridge<T>(channel: string, payload: Record<string, unknown> = {}): Promise<T> {
  return window.pluginBridge
    .invoke(PANEL_CHANNEL, { id: channel, ...payload })
    .then((result) => {
      if (result && typeof result === 'object' && result.ok === false) {
        throw new Error(result.error || 'operation failed')
      }
      return result as T
    })
}

export interface NoteSummary {
  id: string
  title: string
  snippet: string
  color: string
  updatedAt: string
  createdAt: string
  deleted: boolean
}

export interface Note {
  id: string
  title: string
  content: string
  color: string
  mode: 'preview' | 'edit'
  createdAt: string
  updatedAt: string
  deleted: boolean
}

export interface ListResult {
  rev: number
  notes: NoteSummary[]
}

export type NotePatch = Partial<Pick<Note, 'content' | 'color' | 'mode'>>

// 注意：便签 id 统一用 noteId 键，不占 payload.id —— id 被通道名占用
// （skill.setEnabled 的 { id: <channel>, ...payload } 包装），见 bridge()。
//
// 插件进程每个通道都返回 { ok: true, ... } 的包裹结构（main.js onPanelInvoke）。
// 这里必须把包裹解掉再暴露给 store/组件 —— 直接透传会把 { ok, note } 当 Note 用，
// 导致 current.id / current.content 为 undefined（便签不存在 + 内容区渲染崩溃）。
export const api = {
  list: async (): Promise<ListResult> => {
    const r = await bridge<{ rev: number; notes: NoteSummary[] }>('notes.list')
    return { rev: r.rev, notes: r.notes }
  },
  get: async (id: string): Promise<Note> => {
    const r = await bridge<{ note: Note }>('note.get', { noteId: id })
    return r.note
  },
  create: async (content?: string, color?: string): Promise<Note> => {
    const r = await bridge<{ note: Note }>('note.create', { content, color })
    return r.note
  },
  save: async (id: string, patch: NotePatch): Promise<Note> => {
    const r = await bridge<{ note: Note }>('note.save', { noteId: id, patch })
    return r.note
  },
  duplicate: async (id: string): Promise<Note> => {
    const r = await bridge<{ note: Note }>('note.duplicate', { noteId: id })
    return r.note
  },
  remove: async (id: string): Promise<{ ok: boolean }> => {
    await bridge('note.delete', { noteId: id })
    return { ok: true }
  },
  restore: async (id: string): Promise<{ ok: boolean }> => {
    await bridge('note.restore', { noteId: id })
    return { ok: true }
  },
  purge: async (id: string): Promise<{ ok: boolean }> => {
    await bridge('note.purge', { noteId: id })
    return { ok: true }
  },
  purgeAll: async (): Promise<{ ok: boolean }> => {
    await bridge('notes.purgeAll')
    return { ok: true }
  },
  /** 宿主通道：系统浏览器打开外部链接（需 shell.openExternal 权限） */
  openExternal: (url: string): Promise<unknown> => bridge('shell.openExternal', { url })
}
