/**
 * 面板全局状态（单面板单实例，模块级单例替代 Pinia）。
 * 移植桌面版 Pinia store 的「乐观保存 + 500ms 防抖」：改动先合并进本地
 * current 与 pendingPatch，防抖窗口内合并成一次 note.save；离开便签视图前
 * flushSave 落盘。宿主没有插件→面板推送通道，用 rev 指纹轮询（5s，仅页面可见时）
 * 感知面板打开期间 agent 工具对数据的修改。
 */
import { computed, ref } from 'vue'
import { api, type Note, type NotePatch, type NoteSummary } from '../api'

export type View = 'list' | 'note' | 'history'

const notes = ref<NoteSummary[]>([])
const rev = ref(0)
const current = ref<Note | null>(null)
const view = ref<View>('list')
const loading = ref(true)
const error = ref<string | null>(null)
const status = ref<string | null>(null)

let statusTimer: ReturnType<typeof setTimeout> | undefined
let saveTimer: ReturnType<typeof setTimeout> | undefined
let pendingPatch: NotePatch = {}
let pollTimer: ReturnType<typeof setInterval> | undefined

const activeCount = computed(() => notes.value.filter((n) => !n.deleted).length)
const deletedCount = computed(() => notes.value.filter((n) => n.deleted).length)

function setStatus(msg: string | null): void {
  status.value = msg
  if (statusTimer) clearTimeout(statusTimer)
  statusTimer = undefined
  if (msg) {
    statusTimer = setTimeout(() => {
      status.value = null
    }, 4000)
  }
}

/** 是否有未落盘的编辑（轮询刷新当前便签时要避开，避免覆盖输入） */
function hasPendingEdits(): boolean {
  return saveTimer !== undefined || Object.keys(pendingPatch).length > 0
}

async function refresh(silent = false): Promise<void> {
  if (!silent) {
    loading.value = true
    error.value = null
  }
  try {
    const r = await api.list()
    const changed = r.rev !== rev.value
    rev.value = r.rev
    notes.value = r.notes
    // 面板打开期间 agent 改过数据：当前便签按最新版本刷新（无未落盘编辑时）
    if (changed && current.value && view.value === 'note' && !hasPendingEdits()) {
      const fresh = await api.get(current.value.id).catch(() => null)
      if (fresh) {
        current.value = fresh
        pendingPatch = {}
      }
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : '加载失败'
  } finally {
    loading.value = false
  }
}

async function openNote(id: string): Promise<void> {
  try {
    const n = await api.get(id)
    current.value = n
    pendingPatch = {}
    view.value = 'note'
    error.value = null
  } catch (e) {
    setStatus(e instanceof Error ? e.message : '加载失败')
  }
}

async function createNote(content?: string, color?: string): Promise<void> {
  try {
    const n = await api.create(content, color)
    await refresh(true)
    await openNote(n.id)
  } catch (e) {
    setStatus(e instanceof Error ? e.message : '新建失败')
  }
}

/** 回列表视图：先落盘未保存的编辑 */
async function backToList(): Promise<void> {
  await flushSave()
  current.value = null
  view.value = 'list'
  await refresh(true)
}

/** 进入回收站视图：先落盘 */
async function openHistory(): Promise<void> {
  await flushSave()
  view.value = 'history'
}

// —— 乐观保存 + 防抖 ——

function scheduleSave(patch: NotePatch): void {
  if (!current.value) return
  current.value = {
    ...current.value,
    ...patch,
    updatedAt: new Date().toISOString()
  }
  pendingPatch = {
    ...pendingPatch,
    ...patch
  }
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = undefined
    void flushSave()
  }, 500)
}

async function flushSave(): Promise<void> {
  if (!current.value) return
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = undefined
  }
  if (Object.keys(pendingPatch).length === 0) return
  const toSave = pendingPatch
  pendingPatch = {}
  try {
    const saved = await api.save(current.value.id, toSave)
    if (current.value) current.value = { ...current.value, ...saved }
    void refresh(true) // 拉最新标题/摘要
  } catch (e) {
    pendingPatch = { ...toSave, ...pendingPatch } // 失败回滚到待存队列
    setStatus(e instanceof Error ? e.message : '保存失败')
  }
}

function setContent(value: string): void {
  scheduleSave({ content: value })
}

function setMode(next: 'preview' | 'edit'): void {
  scheduleSave({ mode: next })
}

function toggleMode(): void {
  if (!current.value) return
  setMode(current.value.mode === 'preview' ? 'edit' : 'preview')
}

function enterEdit(): void {
  if (current.value?.mode !== 'edit') setMode('edit')
}

function enterPreview(): void {
  if (current.value?.mode !== 'preview') setMode('preview')
}

function setColor(color: string): void {
  scheduleSave({ color })
}

async function duplicateCurrent(): Promise<void> {
  if (!current.value) return
  await flushSave()
  try {
    const n = await api.duplicate(current.value.id)
    await refresh(true)
    await openNote(n.id)
  } catch (e) {
    setStatus(e instanceof Error ? e.message : '复制失败')
  }
}

async function removeCurrent(): Promise<void> {
  if (!current.value) return
  await flushSave()
  const id = current.value.id
  try {
    await api.remove(id)
    await refresh(true)
    if (view.value === 'note') {
      current.value = null
      view.value = 'list'
    }
  } catch (e) {
    setStatus(e instanceof Error ? e.message : '删除失败')
  }
}

async function removeNote(id: string): Promise<void> {
  await api.remove(id)
  await refresh(true)
}

async function restoreNote(id: string): Promise<void> {
  await api.restore(id)
  await refresh(true)
}

async function purgeNote(id: string): Promise<void> {
  await api.purge(id)
  await refresh(true)
}

async function purgeAll(): Promise<void> {
  await api.purgeAll()
  await refresh(true)
}

function onGlobalKeydown(e: KeyboardEvent): void {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'e') {
    e.preventDefault()
    toggleMode()
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
    e.preventDefault()
    void createNote()
  }
}

function startPolling(ms = 5000): void {
  if (pollTimer) return
  pollTimer = setInterval(() => {
    if (!document.hidden) void refresh(true)
  }, ms)
}

function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = undefined
  }
}

export function useNotes() {
  return {
    notes,
    rev,
    current,
    view,
    loading,
    error,
    status,
    activeCount,
    deletedCount,
    setStatus,
    refresh,
    openNote,
    createNote,
    backToList,
    openHistory,
    scheduleSave,
    flushSave,
    setContent,
    setMode,
    toggleMode,
    enterEdit,
    enterPreview,
    setColor,
    duplicateCurrent,
    removeCurrent,
    removeNote,
    restoreNote,
    purgeNote,
    purgeAll,
    onGlobalKeydown,
    startPolling,
    stopPolling
  }
}
