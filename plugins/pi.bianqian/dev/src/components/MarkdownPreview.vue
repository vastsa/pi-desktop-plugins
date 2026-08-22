<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, onUnmounted, ref } from 'vue'
import { renderMarkdown } from '../lib/markdown'
import { wrapHighlightLines } from '../lib/highlight'
import { api } from '../api'
import HighlightMenu from './HighlightMenu.vue'

const props = defineProps<{
  content: string
}>()

const emit = defineEmits<{
  dblclick: []
  pasteImage: [files: { file: File; mime: string }[]]
  status: [message: string | null]
  updateContent: [value: string]
}>()

const html = computed(() => renderMarkdown(props.content))
const dragging = ref(false)
let dragDepth = 0

/* —— 右键标记颜色：DOM 选区 → 源码范围映射 —— */

interface PreviewMenuState {
  x: number
  y: number
  /** 选区映射出的源码范围（不含标记语法） */
  selStart: number
  selEnd: number
  /** 选区对应的源码原文（含 ** 等格式语法，用于包裹） */
  selText: string
  /** 选区若处于某条标记内：完整标记（含 ==…==）的源码范围，用于移除 */
  markRange: { start: number; end: number } | null
}

const menu = ref<PreviewMenuState | null>(null)

function closeMenu(): void {
  menu.value = null
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && menu.value) closeMenu()
}

/** GFM task marker: "- [ ]" / "* [x]" / "1. [X]" (leading indent kept) */
const TASK_ITEM_RE = /^(\s*(?:[-*+]|\d+\.)\s+)\[([ xX])\](\s+)/

/**
 * 行内 markdown 语法剥离器：把块源码中的语法标记去掉，得到与渲染文本近似
 * 的纯文本 + 每个字符对应的源码偏移。规则与 markdown-it 的 inline 渲染对齐：
 * ==标记==、**粗体**、__粗体__、*斜体*、_斜体_、`代码`、[链接](url)、
 * ![图片](url)（保留显示文本）、反斜杠转义。剥离不完美的场景（如单词内下划线）
 * 由「匹配失败 → 降级提示」兜底。
 */
const STRIP_INLINE_RE =
  /==(?:[a-z]+:)?([^=\s][^=]*?)==|!\[([^\]]*)\]\(([^)]*)\)|\[([^\]]*)\]\(([^)]*)\)|`([^`]+)`|\*\*([^*\s][^*]*?)\*\*|__([^_\s][^_]*?)__|\*([^*\s][^*]*?)\*|_([^_\s][^_]*?)_|\\(.)/g

interface Stripped {
  text: string
  offsets: number[]
}

function stripInline(src: string): Stripped {
  const text: string[] = []
  const offsets: number[] = []
  let last = 0
  for (const m of src.matchAll(STRIP_INLINE_RE)) {
    for (let k = last; k < m.index; k++) {
      text.push(src[k])
      offsets.push(k)
    }
    const idx = m.index
    let keep: string | undefined
    let keepStart = 0
    if (m[1] !== undefined) {
      keep = m[1]
      keepStart = idx + m[0].length - m[1].length - 2 // ==…== / ==色:…==
    } else if (m[2] !== undefined) {
      keep = m[2]
      keepStart = idx + 2 // ![alt](url)
    } else if (m[4] !== undefined) {
      keep = m[4]
      keepStart = idx + 1 // [text](url)
    } else if (m[6] !== undefined) {
      keep = m[6]
      keepStart = idx + 1 // `code`
    } else if (m[7] !== undefined || m[8] !== undefined) {
      keep = m[7] ?? m[8]
      keepStart = idx + 2 // **bold** / __bold__
    } else if (m[9] !== undefined || m[10] !== undefined) {
      keep = m[9] ?? m[10]
      keepStart = idx + 1 // *italic* / _italic_
    } else if (m[11] !== undefined) {
      keep = m[11]
      keepStart = idx + 1 // \x
    }
    if (keep !== undefined) {
      for (let k = 0; k < keep.length; k++) {
        text.push(keep[k])
        offsets.push(keepStart + k)
      }
    }
    last = m.index + m[0].length
  }
  for (let k = last; k < src.length; k++) {
    text.push(src[k])
    offsets.push(k)
  }
  return { text: text.join(''), offsets }
}

/** 第 line 行在源码中的字符起始偏移（行号从 0 计） */
function lineStartChar(lines: string[], line: number): number {
  let n = 0
  for (let i = 0; i < line; i++) n += lines[i].length + 1
  return n
}

/** 节点所在的 [data-line] 块元素（Text 节点先取父元素） */
function blockElOf(node: Node | null): HTMLElement | null {
  if (!node) return null
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement)
  return el?.closest?.('[data-line]') ?? null
}

/** 从 blockEl 起点到 (target, offset) 的累计渲染文本长度 */
function renderedOffsetOf(blockEl: HTMLElement, target: Node, offset: number): number {
  const walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT)
  let count = 0
  let n: Node | null
  while ((n = walker.nextNode())) {
    if (n === target) return count + offset
    count += (n.textContent || '').length
  }
  return count
}

/**
 * 选区是否被一条 `==…==` 标记完全包裹（块内偏移坐标系）。
 * 返回完整标记区间（含 == 与颜色前缀），否则 null。
 * 校验与渲染规则一致（内容首字符非空白/非 =、不含 =），避免误删普通文本。
 */
function markedRangeOf(
  blockSrc: string,
  selStart: number,
  selEnd: number
): { start: number; end: number } | null {
  const markStart = blockSrc.lastIndexOf('==', selStart)
  if (markStart === -1) return null
  const close = blockSrc.indexOf('==', selEnd)
  if (close === -1) return null
  const inner = blockSrc.slice(markStart + 2, close)
  if (!/^(?:[a-z]+:)?[^=\s][^=]*$/.test(inner)) return null
  const colorMatch = inner.match(/^([a-z]+):/)
  const innerStart = markStart + 2 + (colorMatch ? colorMatch[1].length + 1 : 0)
  if (selStart < innerStart || selEnd > close) return null
  return { start: markStart, end: close + 2 }
}

/**
 * 把 DOM 选区映射回源码字符范围。选区起点/终点必须在同一 [data-line] 块内。
 * 返回 null 表示剥离文本中找不到选区文本（无法映射）。
 */
function srcRangeFromSelection(
  sel: Selection,
  blockEl: HTMLElement
): { start: number; end: number; text: string; blockSrc: string; blockStartChar: number } | null {
  const lineRange = blockEl.dataset.line
  if (!lineRange) return null
  const [startLine, endLine] = lineRange.split('-').map(Number)
  if (Number.isNaN(startLine) || Number.isNaN(endLine)) return null

  const lines = props.content.split('\n')
  if (endLine > lines.length) return null
  const blockStartChar = lineStartChar(lines, startLine)
  const blockSrc = lines.slice(startLine, endLine).join('\n')

  const stripped = stripInline(blockSrc)
  const text = sel.toString()
  if (!text || stripped.text.indexOf(text) === -1) return null

  // 多个匹配时选「DOM 渲染偏移」最近的（重复文本场景）
  const anchorOff = Math.min(
    renderedOffsetOf(blockEl, sel.anchorNode!, sel.anchorOffset),
    renderedOffsetOf(blockEl, sel.focusNode!, sel.focusOffset)
  )
  let best = stripped.text.indexOf(text)
  let from = best
  while (from !== -1) {
    if (Math.abs(from - anchorOff) < Math.abs(best - anchorOff)) best = from
    from = stripped.text.indexOf(text, from + 1)
  }
  if (best + text.length > stripped.offsets.length) return null

  const start = stripped.offsets[best]
  const end = stripped.offsets[best + text.length - 1] + 1
  // start/end 是 blockSrc 的块内坐标；text 取块内原文，消费方负责转全文档坐标
  return { start, end, text: blockSrc.slice(start, end), blockSrc, blockStartChar }
}

function onContextMenu(e: MouseEvent): boolean {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || !sel.toString().trim()) return false

  const startBlock = blockElOf(sel.anchorNode)
  const endBlock = blockElOf(sel.focusNode)
  if (!startBlock || startBlock !== endBlock) return false // 跨块 → 原生菜单

  const range = srcRangeFromSelection(sel, startBlock)
  if (!range) {
    emit('status', '无法标记该选区')
    return false
  }
  e.preventDefault()

  // range.start/end 是 blockSrc 块内坐标：mark 检测直接用块内坐标；
  // menu 中 selStart/selEnd/markRange 统一转成全文档坐标（apply 时按 content 切片）
  const mark = markedRangeOf(range.blockSrc, range.start, range.end)
  const blockStartChar = range.blockStartChar

  menu.value = {
    x: e.clientX,
    y: e.clientY,
    selStart: range.start + blockStartChar,
    selEnd: range.end + blockStartChar,
    selText: range.text,
    markRange: mark
      ? { start: mark.start + blockStartChar, end: mark.end + blockStartChar }
      : null
  }
  return true
}

function applyPreviewHighlight(color: string): void {
  const { selStart, selEnd, selText, markRange } = menu.value ?? {}
  // 选区内已有标记（markRange）：替换颜色前缀、保留内容，避免嵌套出 `==green:==x==`
  if (markRange) {
    const content = props.content
    const inner = content.slice(markRange.start + 2, markRange.end - 2)
    const colorMatch = inner.match(/^([a-z]+):/)
    const prefixLen = colorMatch ? colorMatch[1].length + 1 : 0
    const kept = inner.slice(prefixLen)
    emit('updateContent', content.slice(0, markRange.start + 2) + `${color}:${kept}` + content.slice(markRange.end - 2))
    closeMenu()
    return
  }
  // 逐行包裹：行首尾空白保留在标记外，保证渲染规则能识别（含跨行选区）
  const wrapped = wrapHighlightLines(selText ?? '', color)
  emit('updateContent', props.content.slice(0, selStart!) + wrapped + props.content.slice(selEnd!))
  closeMenu()
}

function removePreviewHighlight(): void {
  const { markRange } = menu.value ?? {}
  if (markRange) {
    const content = props.content
    const inner = content.slice(markRange.start + 2, markRange.end - 2)
    const colorMatch = inner.match(/^([a-z]+):/)
    const prefixLen = colorMatch ? colorMatch[1].length + 1 : 0
    const kept = content.slice(markRange.start + 2 + prefixLen, markRange.end - 2)
    emit('updateContent', content.slice(0, markRange.start) + kept + content.slice(markRange.end))
  }
  // 选区未标记时点击取消色块：仅关闭菜单
  closeMenu()
}

/**
 * Set the Nth task-list checkbox in markdown source (0-based) to checked/unchecked.
 * Skips fenced code blocks so example tasks in ``` don't shift the index.
 * Returns null if the index is out of range.
 */
function setTaskAt(source: string, index: number, checked: boolean): string | null {
  const lines = source.split('\n')
  let seen = 0
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    // Toggle fence on ``` / ~~~ open/close lines
    if (/^\s*(```|~~~)/.test(lines[i])) {
      inFence = !inFence
      continue
    }
    if (inFence) continue

    const m = lines[i].match(TASK_ITEM_RE)
    if (!m) continue
    if (seen === index) {
      const mark = checked ? 'x' : ' '
      lines[i] = lines[i].replace(TASK_ITEM_RE, `$1[${mark}]$3`)
      return lines.join('\n')
    }
    seen += 1
  }
  return null
}

function taskCheckboxes(root: ParentNode): HTMLInputElement[] {
  return Array.from(
    root.querySelectorAll('li.task-list-item input[type="checkbox"]')
  ) as HTMLInputElement[]
}

/**
 * change fires after the checkbox is toggled (including when activated via
 * its <label>), so target.checked is the desired new state.
 */
function onTaskChange(e: Event): void {
  const target = e.target
  if (!(target instanceof HTMLInputElement) || target.type !== 'checkbox') return
  if (!target.closest('li.task-list-item')) return

  e.stopPropagation()
  const root = (e.currentTarget as HTMLElement).querySelector('.md-preview-body')
  if (!root) return

  const index = taskCheckboxes(root).indexOf(target)
  if (index < 0) return

  const next = setTaskAt(props.content, index, target.checked)
  if (next != null && next !== props.content) {
    emit('updateContent', next)
  }
}

function onClick(e: MouseEvent): void {
  const target = e.target as HTMLElement

  // Keep task interactions from bubbling (e.g. selection quirks)
  if (
    (target instanceof HTMLInputElement && target.type === 'checkbox') ||
    target.closest('li.task-list-item label')
  ) {
    e.stopPropagation()
  }

  const anchor = target.closest('a')
  if (anchor && (anchor as HTMLAnchorElement).href) {
    e.preventDefault()
    // 面板没有自己的窗口：优先走宿主通道用系统浏览器打开；宿主不支持时降级 window.open
    const href = (anchor as HTMLAnchorElement).href
    void api.openExternal(href).catch(() => window.open(href, '_blank'))
  }
}

function onDblClick(e: MouseEvent): void {
  // Don't enter edit mode when double-clicking a checkbox / task label
  const target = e.target as HTMLElement
  if (
    (target instanceof HTMLInputElement && target.type === 'checkbox') ||
    target.closest('li.task-list-item input[type="checkbox"]') ||
    target.closest('li.task-list-item label')
  ) {
    e.preventDefault()
    e.stopPropagation()
    return
  }
  emit('dblclick')
}

function collectImages(list: DataTransferItemList | FileList | null | undefined): {
  file: File
  mime: string
}[] {
  if (!list) return []
  const out: { file: File; mime: string }[] = []
  if (list instanceof FileList || Array.isArray(list)) {
    for (const file of Array.from(list as FileList)) {
      if (file.type.startsWith('image/')) {
        out.push({ file, mime: file.type || 'image/png' })
      }
    }
    return out
  }
  // Clipboard often lists the same bitmap under several MIME types
  // (png + bmp …). Prefer one best format so paste never doubles.
  const preferred = [
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
    'image/bmp',
    'image/svg+xml'
  ]
  const byMime = new Map<string, { file: File; mime: string }>()
  for (const item of Array.from(list as DataTransferItemList)) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile()
      if (file && !byMime.has(item.type)) {
        byMime.set(item.type, { file, mime: item.type })
      }
    }
  }
  if (byMime.size === 0) return []
  for (const mime of preferred) {
    const hit = byMime.get(mime)
    if (hit) return [hit]
  }
  return [byMime.values().next().value!]
}

function onPaste(e: ClipboardEvent): void {
  const images = collectImages(e.clipboardData?.items)
  if (images.length === 0) return
  e.preventDefault()
  e.stopPropagation()
  emit('pasteImage', images)
}

function onDragEnter(e: DragEvent): void {
  if (!e.dataTransfer?.types?.includes('Files')) return
  e.preventDefault()
  dragDepth += 1
  dragging.value = true
}

function onDragLeave(e: DragEvent): void {
  if (!e.dataTransfer?.types?.includes('Files')) return
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) dragging.value = false
}

function onDragOver(e: DragEvent): void {
  if (!e.dataTransfer?.types?.includes('Files')) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
}

function onDrop(e: DragEvent): void {
  dragDepth = 0
  dragging.value = false
  const images = collectImages(e.dataTransfer?.files)
  if (images.length === 0) return
  e.preventDefault()
  emit('pasteImage', images)
}

onMounted(() => {
  window.addEventListener('keydown', onKeyDown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeyDown)
})

onUnmounted(() => {
  dragDepth = 0
})
</script>

<template>
  <div
    class="note-content note-scroll md-preview relative h-full overflow-auto px-3.5 py-3"
    title="双击进入编辑 · 可粘贴/拖入图片 · 可勾选任务"
    @dblclick="onDblClick"
    @click="onClick"
    @change="onTaskChange"
    @paste="onPaste"
    @dragenter="onDragEnter"
    @dragleave="onDragLeave"
    @dragover="onDragOver"
    @drop="onDrop"
    @contextmenu="onContextMenu"
  >
    <div class="md-preview-body" v-html="html" />

    <div
      v-if="dragging"
      class="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-ink/25 bg-paper/70 text-[13px] font-medium text-ink/55 backdrop-blur-[1px]"
    >
      松开以插入图片
    </div>

    <HighlightMenu
      v-if="menu"
      :x="menu.x"
      :y="menu.y"
      :has-mark="menu.markRange !== null"
      @select="applyPreviewHighlight"
      @remove="removePreviewHighlight"
      @close="closeMenu"
    />
  </div>
</template>
