<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useNotes } from '../stores/use-notes'
import { NOTE_COLORS, COLOR_LABELS, type NoteColor } from '../lib/types'
import { charCount } from '../lib/format'
import { confirm } from '../lib/confirm'
import MarkdownPreview from './MarkdownPreview.vue'
import MarkdownEditor from './MarkdownEditor.vue'

const {
  current,
  backToList,
  scheduleSave,
  setContent,
  enterEdit,
  toggleMode,
  duplicateCurrent,
  removeCurrent,
  setStatus
} = useNotes()

const colorOpen = ref(false)

const noteColor = () => (current.value?.color || 'yellow') as NoteColor

function pickColor(c: NoteColor): void {
  scheduleSave({ color: c })
  colorOpen.value = false
}

async function onDelete(): Promise<void> {
  const ok = await confirm({
    title: '提醒',
    message: '删除这条便签？可在「回收站」中恢复。',
    confirmText: '删除',
    cancelText: '取消',
    danger: true
  })
  if (!ok) return
  await removeCurrent()
}

/* —— 预览模式图片粘贴/拖入：压缩后以内联 data URL 写入 markdown —— */

const MAX_EDGE = 1600
const JPEG_QUALITY = 0.82
const COMPRESS_THRESHOLD = 400 * 1024

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error || new Error('read failed'))
    reader.readAsDataURL(file)
  })
}

async function compressIfNeeded(
  dataUrl: string,
  mime: string
): Promise<{ data: string; mime: string }> {
  if (mime === 'image/gif' || mime === 'image/svg+xml') {
    return { data: dataUrl, mime }
  }
  const comma = dataUrl.indexOf(',')
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
  const approxBytes = Math.floor((b64.length * 3) / 4)

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image()
    el.onload = () => resolve(el)
    el.onerror = () => reject(new Error('decode failed'))
    el.src = dataUrl
  })

  const needsResize = img.width > MAX_EDGE || img.height > MAX_EDGE
  const needsReencode = approxBytes > COMPRESS_THRESHOLD
  if (!needsResize && !needsReencode) return { data: dataUrl, mime }

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

  // 优先 JPEG（截图/照片更小）；PNG 带透明才保留
  let hasAlpha = false
  if (mime === 'image/png') {
    try {
      const step = Math.max(1, Math.floor(Math.min(tw, th) / 24))
      for (let y = 0; y < th && !hasAlpha; y += step) {
        for (let x = 0; x < tw; x += step) {
          if (ctx.getImageData(x, y, 1, 1).data[3] < 250) {
            hasAlpha = true
            break
          }
        }
      }
    } catch {
      /* ignore */
    }
  }
  if (hasAlpha) return { data: canvas.toDataURL('image/png'), mime: 'image/png' }
  return { data: canvas.toDataURL('image/jpeg', JPEG_QUALITY), mime: 'image/jpeg' }
}

async function handlePreviewImages(
  images: { file: File; mime: string }[]
): Promise<void> {
  if (images.length === 0 || !current.value) return

  setStatus(images.length > 1 ? `正在插入 ${images.length} 张图片…` : '正在保存图片…')
  try {
    const chunks: string[] = []
    for (let i = 0; i < images.length; i++) {
      const { file, mime } = images[i]
      if (images.length > 1) setStatus(`正在插入图片 ${i + 1}/${images.length}…`)
      try {
        const dataUrl = await readAsDataUrl(file)
        const optimized = await compressIfNeeded(dataUrl, mime)
        const alt =
          file.name
            ?.replace(/\.[a-z0-9]+$/i, '')
            .replace(/[_\-]+/g, ' ')
            .trim()
            .slice(0, 40) || 'image'
        // 插件无 attach:// 协议与文件存储：data URL 直接内联进 markdown
        chunks.push(`![${alt}](${optimized.data})`)
      } catch (err) {
        console.error(err)
        setStatus('图片保存失败')
      }
    }
    if (chunks.length > 0) {
      const base = current.value.content || ''
      const sep = !base || base.endsWith('\n') ? '' : '\n'
      setContent(`${base}${sep}${chunks.join('\n')}\n`)
      enterEdit()
    }
  } finally {
    setStatus(null)
  }
}

onMounted(() => {
  document.addEventListener('click', onDocClick)
})

onUnmounted(() => {
  document.removeEventListener('click', onDocClick)
})

function onDocClick(e: MouseEvent): void {
  const target = e.target as HTMLElement
  if (!target.closest?.('[data-menu]')) {
    colorOpen.value = false
  }
}
</script>

<template>
  <div
    v-if="current"
    class="flex h-full flex-col overflow-hidden"
    :class="`note-${current.color || 'yellow'}`"
    :style="{
      background: 'var(--note-bg)',
      borderColor: 'var(--note-border)'
    }"
  >
    <!-- 面板内工具栏：返回 + 标题 + 颜色/复制/删除/切换 + 字数 -->
    <header
      class="flex h-10 shrink-0 items-center gap-1 border-b px-2"
      :style="{
        background: 'color-mix(in srgb, var(--note-bar) 18%, var(--note-bg))',
        borderColor: 'var(--note-border)'
      }"
    >
      <button
        class="flex h-7 w-7 items-center justify-center rounded text-ink/55 hover:bg-ink/8"
        title="返回列表"
        @click="backToList()"
      >
        ←
      </button>
      <span
        class="mr-1 h-4 w-1.5 shrink-0 rounded-sm"
        :style="{ background: 'var(--note-bar)' }"
      />
      <div class="min-w-0 flex-1 truncate text-[13px] font-medium text-ink/70">
        {{ current.title || '未命名便签' }}
      </div>

      <!-- 颜色 -->
      <div class="relative" data-menu>
        <button
          class="flex h-7 w-7 items-center justify-center rounded hover:bg-ink/8"
          title="颜色"
          @click.stop="colorOpen = !colorOpen"
        >
          <span
            class="h-3.5 w-3.5 rounded-full border border-ink/20"
            :style="{ background: 'var(--note-bar)' }"
          />
        </button>
        <div
          v-if="colorOpen"
          class="absolute right-0 top-8 z-50 flex gap-1.5 rounded-lg border border-ink/10 bg-paper p-2 shadow-lg"
        >
          <button
            v-for="c in NOTE_COLORS"
            :key="c"
            class="h-5 w-5 rounded-full border border-ink/15 transition hover:scale-110"
            :class="[
              c === 'yellow' && 'bg-note-yellow',
              c === 'pink' && 'bg-note-pink',
              c === 'blue' && 'bg-note-blue',
              c === 'green' && 'bg-note-green',
              c === 'purple' && 'bg-note-purple',
              c === 'gray' && 'bg-note-gray',
              noteColor() === c && 'ring-2 ring-ink/40'
            ]"
            :title="COLOR_LABELS[c]"
            @click="pickColor(c)"
          />
        </div>
      </div>

      <!-- 复制 -->
      <button
        class="flex h-7 w-7 items-center justify-center rounded text-[13px] text-ink/60 hover:bg-ink/8"
        title="复制便签"
        @click="duplicateCurrent()"
      >
        ⧉
      </button>

      <!-- 切换编辑/预览 -->
      <button
        class="flex h-7 items-center gap-1 rounded px-1.5 text-[12px] text-ink/60 hover:bg-ink/8"
        :title="current.mode === 'preview' ? '编辑 (Ctrl+E)' : '预览 (Ctrl+E)'"
        @click="toggleMode()"
      >
        {{ current.mode === 'preview' ? '✎ 编辑' : '👁 预览' }}
      </button>

      <!-- 删除 -->
      <button
        class="flex h-7 w-7 items-center justify-center rounded text-ink/50 hover:bg-red-500/15 hover:text-red-600"
        title="删除"
        @click="onDelete()"
      >
        🗑
      </button>
    </header>

    <main class="relative min-h-0 flex-1">
      <!-- v-show 作用于多根节点组件会静默失效（MarkdownEditor 是双根），
           必须用单根容器包裹，两个组件保持挂载以各自保留滚动位置。 -->
      <div v-show="current.mode === 'edit'" class="h-full">
        <MarkdownEditor
          :model-value="current.content"
          @update:model-value="setContent"
          @escape="enterPreview"
          @status="setStatus"
        />
      </div>

      <MarkdownPreview
        v-show="current.mode !== 'edit'"
        :content="current.content"
        @dblclick="enterEdit"
        @paste-image="handlePreviewImages"
        @update-content="setContent"
        @status="setStatus"
      />
    </main>

    <footer
      class="flex h-6 shrink-0 items-center justify-between border-t px-2 text-[11px] text-ink/35"
      :style="{ borderColor: 'var(--note-border)' }"
    >
      <span>
        <template v-if="current.mode === 'edit'">编辑中 · Esc 预览 · 粘贴/拖入图片</template>
        <template v-else>预览 · 双击编辑 · 可勾选任务 · 可粘贴图片</template>
      </span>
      <span class="tabular-nums">
        {{ charCount(current.content) }} 字
      </span>
    </footer>
  </div>
</template>
