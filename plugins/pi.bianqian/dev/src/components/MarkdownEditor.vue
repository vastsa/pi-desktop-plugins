<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { EditorState } from '@codemirror/state'
import {
  EditorView,
  keymap,
  placeholder as cmPlaceholder
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import { tryUnwrapHighlight, wrapHighlight, wrapHighlightLines } from '../lib/highlight'
import HighlightMenu from './HighlightMenu.vue'

const props = defineProps<{
  modelValue: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  escape: []
  status: [message: string | null]
}>()

const host = ref<HTMLDivElement | null>(null)
let view: EditorView | null = null
let suppress = false
let pasteQueue = 0

interface HighlightMenuState {
  x: number
  y: number
  from: number
  to: number
  text: string
  isMarked: boolean
}

const menu = ref<HighlightMenuState | null>(null)

function closeMenu(): void {
  menu.value = null
}

const MAX_EDGE = 1600
const JPEG_QUALITY = 0.82
const COMPRESS_THRESHOLD = 400 * 1024 // 400KB

function setStatus(msg: string | null): void {
  emit('status', msg)
}

/**
 * Clipboard often exposes the same bitmap under multiple MIME types
 * (e.g. image/png + image/bmp on Windows). Prefer one best format so a
 * single paste never inserts the same picture twice.
 */
function collectClipboardImages(
  items: DataTransferItemList | undefined
): { file: File; mime: string }[] {
  if (!items) return []

  const preferred = [
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
    'image/bmp',
    'image/svg+xml'
  ]
  const byMime = new Map<string, { file: File; mime: string }>()
  for (const item of Array.from(items)) {
    if (!item.type.startsWith('image/')) continue
    const file = item.getAsFile()
    if (file && !byMime.has(item.type)) {
      byMime.set(item.type, { file, mime: item.type })
    }
  }
  if (byMime.size === 0) return []

  // One screenshot / one clipboard image → pick the best MIME only.
  // Multi-file paste still works: FileList path goes through onDrop.
  for (const mime of preferred) {
    const hit = byMime.get(mime)
    if (hit) return [hit]
  }
  return [byMime.values().next().value!]
}

function onPaste(e: ClipboardEvent): void {
  const images = collectClipboardImages(e.clipboardData?.items)
  if (images.length === 0) return

  // Stop bubble so a host-level listener (if any) cannot re-handle this paste.
  e.preventDefault()
  e.stopPropagation()
  void insertImages(images)
}

function onDrop(e: DragEvent): void {
  const files = e.dataTransfer?.files
  if (!files || files.length === 0) return

  const images: { file: File; mime: string }[] = []
  for (const file of Array.from(files)) {
    if (file.type.startsWith('image/')) {
      images.push({ file, mime: file.type || 'image/png' })
    }
  }
  if (images.length === 0) return

  e.preventDefault()
  e.stopPropagation()
  void insertImages(images)
}

function onDragOver(e: DragEvent): void {
  if (e.dataTransfer?.types?.includes('Files')) {
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  }
}

async function insertImages(images: { file: File; mime: string }[]): Promise<void> {
  pasteQueue += 1
  const total = images.length
  setStatus(total > 1 ? `正在插入 ${total} 张图片…` : '正在保存图片…')

  try {
    for (let i = 0; i < images.length; i++) {
      const { file, mime } = images[i]
      if (total > 1) setStatus(`正在插入图片 ${i + 1}/${total}…`)
      try {
        const dataUrl = await fileToDataUrl(file)
        const optimized = await maybeCompress(dataUrl, mime)
        // 插件没有 attach:// 协议与文件存储：压缩后的 data URL 直接内联进 markdown
        const uri = optimized.data
        if (view) insertMarkdownImage(view, uri, file.name)
      } catch (err) {
        console.error('Failed to save image:', err)
        setStatus('图片保存失败')
        await sleep(1400)
      }
    }
  } finally {
    pasteQueue = Math.max(0, pasteQueue - 1)
    if (pasteQueue === 0) setStatus(null)
  }
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error || new Error('read failed'))
    reader.readAsDataURL(file)
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Downscale / re-encode large screenshots so sticky notes don't bloat userData.
 * GIFs and SVGs are kept as-is (animation / vector).
 */
async function maybeCompress(
  dataUrl: string,
  mime: string
): Promise<{ data: string; mime: string }> {
  if (mime === 'image/gif' || mime === 'image/svg+xml') {
    return { data: dataUrl, mime }
  }

  // Rough size estimate from base64 payload
  const comma = dataUrl.indexOf(',')
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
  const approxBytes = Math.floor((b64.length * 3) / 4)

  const img = await loadImage(dataUrl)
  const needsResize = img.width > MAX_EDGE || img.height > MAX_EDGE
  const needsReencode = approxBytes > COMPRESS_THRESHOLD

  if (!needsResize && !needsReencode) {
    return { data: dataUrl, mime }
  }

  let tw = img.width
  let th = img.height
  if (needsResize) {
    const scale = MAX_EDGE / Math.max(tw, th)
    tw = Math.round(tw * scale)
    th = Math.round(th * scale)
  }

  const canvas = document.createElement('canvas')
  canvas.width = tw
  canvas.height = th
  const ctx = canvas.getContext('2d')
  if (!ctx) return { data: dataUrl, mime }
  ctx.drawImage(img, 0, 0, tw, th)

  // Prefer JPEG for photos/screenshots (smaller); keep PNG for images with alpha
  const hasAlpha = mime === 'image/png' && (await canvasHasAlpha(ctx, tw, th))
  if (hasAlpha) {
    const out = canvas.toDataURL('image/png')
    return { data: out, mime: 'image/png' }
  }
  const out = canvas.toDataURL('image/jpeg', JPEG_QUALITY)
  return { data: out, mime: 'image/jpeg' }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('image decode failed'))
    img.src = src
  })
}

function canvasHasAlpha(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number
): boolean {
  try {
    // Sample a coarse grid — enough to catch screenshots with transparency
    const stepX = Math.max(1, Math.floor(w / 24))
    const stepY = Math.max(1, Math.floor(h / 24))
    for (let y = 0; y < h; y += stepY) {
      for (let x = 0; x < w; x += stepX) {
        const px = ctx.getImageData(x, y, 1, 1).data
        if (px[3] < 250) return true
      }
    }
  } catch {
    // tainted / security — assume no alpha
  }
  return false
}

function insertMarkdownImage(
  editorView: EditorView,
  uri: string,
  originalName?: string
): void {
  const { state } = editorView
  const { from, to } = state.selection.main
  const alt =
    originalName
      ?.replace(/\.[a-z0-9]+$/i, '')
      .replace(/[_\-]+/g, ' ')
      .trim()
      .slice(0, 40) || 'image'

  const before = from > 0 ? state.doc.sliceString(from - 1, from) : '\n'
  const prefix = before === '\n' || before === '' ? '' : '\n'
  const insertText = `${prefix}![${alt}](${uri})\n`

  editorView.dispatch({
    changes: { from, to, insert: insertText },
    selection: { anchor: from + insertText.length },
    scrollIntoView: true
  })
  editorView.focus()
}

/**
 * 高亮标记：选区用 `==颜色:文本==` 包裹（跨行逐行包裹，
 * 每行首尾空白保留在标记外——`==` 需紧贴非空白字符才能被渲染规则识别）。
 * 选区本身已是一条标记（`==旧色:文本==`）时，替换颜色前缀，避免嵌套畸形。
 */
function applyHighlight(color: string): void {
  if (!view || !menu.value) return
  const { from, to, text } = menu.value
  const plain = tryUnwrapHighlight(text)
  const wrapped = plain !== null ? wrapHighlight(plain, color) : wrapHighlightLines(text, color)
  view.dispatch({
    changes: { from, to, insert: wrapped },
    selection: { anchor: from + wrapped.length },
    scrollIntoView: true
  })
  closeMenu()
  view.focus()
}

function removeHighlight(): void {
  if (!view || !menu.value) return
  const { from, to, text } = menu.value
  const plain = tryUnwrapHighlight(text)
  if (plain !== null) {
    view.dispatch({
      changes: { from, to, insert: plain },
      selection: { anchor: from + plain.length },
      scrollIntoView: true
    })
  }
  closeMenu()
  view.focus()
}

function createState(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      history(),
      markdown(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      cmPlaceholder('输入 Markdown… 可粘贴或拖入图片'),
      keymap.of([
        ...defaultKeymap,
        ...historyKeymap,
        indentWithTab,
        {
          key: 'Escape',
          run: () => {
            if (menu.value) {
              closeMenu()
              return true
            }
            emit('escape')
            return true
          }
        }
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !suppress) {
          emit('update:modelValue', update.state.doc.toString())
        }
      }),
      EditorView.theme({
        '&': { height: '100%', backgroundColor: 'transparent' },
        '.cm-gutters': { display: 'none' },
        '&.cm-focused': { outline: 'none' }
      }),
      EditorView.lineWrapping,
      EditorView.domEventHandlers({
        paste: (e) => {
          onPaste(e)
          // true only when we consumed an image paste (default already prevented).
          // Non-image paste: return false so CM still inserts text.
          return e.defaultPrevented
        },
        drop: (e) => {
          onDrop(e)
          return e.defaultPrevented
        },
        dragover: (e) => {
          onDragOver(e)
          return false
        },
        contextmenu: (e) => {
          if (!view) return false
          const { from, to } = view.state.selection.main
          // 无选区 → 保留原生菜单（复制/粘贴等）
          if (from === to) return false
          e.preventDefault()
          const text = view.state.doc.sliceString(from, to)
          menu.value = {
            x: e.clientX,
            y: e.clientY,
            from,
            to,
            text,
            isMarked: tryUnwrapHighlight(text) !== null
          }
          return true
        }
      })
    ]
  })
}

onMounted(() => {
  if (!host.value) return
  // Host-level drop only (padding outside CM content). Paste stays on CM —
  // a second paste listener here used to double-insert every image.
  host.value.addEventListener('drop', onDrop)
  host.value.addEventListener('dragover', onDragOver)

  view = new EditorView({
    state: createState(props.modelValue || ''),
    parent: host.value
  })
  requestAnimationFrame(() => view?.focus())
})

watch(
  () => props.modelValue,
  (value) => {
    if (!view) return
    const current = view.state.doc.toString()
    if (value !== current) {
      suppress = true
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value || '' }
      })
      suppress = false
    }
  }
)

onBeforeUnmount(() => {
  host.value?.removeEventListener('drop', onDrop)
  host.value?.removeEventListener('dragover', onDragOver)
  view?.destroy()
  view = null
})
</script>

<template>
  <div ref="host" class="note-content h-full overflow-hidden" />
  <HighlightMenu
    v-if="menu"
    :x="menu.x"
    :y="menu.y"
    :has-mark="menu.isMarked"
    @select="applyHighlight"
    @remove="removeHighlight"
    @close="closeMenu"
  />
</template>
