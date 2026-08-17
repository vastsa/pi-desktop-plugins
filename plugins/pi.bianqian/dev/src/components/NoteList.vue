<script setup lang="ts">
import { computed, ref } from 'vue'
import { useNotes } from '../stores/use-notes'
import { formatDate } from '../lib/format'
import { confirm } from '../lib/confirm'
import type { NoteSummary } from '../api'

const {
  notes,
  loading,
  error,
  activeCount,
  deletedCount,
  openNote,
  createNote,
  openHistory,
  removeNote,
  refresh,
  setStatus
} = useNotes()

const query = ref('')

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  return notes.value
    .filter((n) => !n.deleted)
    .filter((n) => {
      if (!q) return true
      return (
        n.title.toLowerCase().includes(q) ||
        n.snippet.toLowerCase().includes(q)
      )
    })
})

function colorClass(color: string): string {
  return `note-${color || 'yellow'}`
}

async function deleteNote(note: NoteSummary, e: Event): Promise<void> {
  e.stopPropagation()
  const ok = await confirm({
    title: '提醒',
    message: '删除这条便签？可在「回收站」中恢复。',
    confirmText: '删除',
    cancelText: '取消',
    danger: true
  })
  if (!ok) return
  try {
    await removeNote(note.id)
  } catch (err) {
    setStatus(err instanceof Error ? err.message : '删除失败')
  }
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && query.value) {
    query.value = ''
  }
}
</script>

<template>
  <div
    class="note-yellow flex h-full flex-col overflow-hidden"
    :style="{
      background: 'var(--note-bg)',
      borderColor: 'var(--note-border)'
    }"
  >
    <!-- 面板内工具栏（宿主拥有面板标题栏，这里不是窗口标题栏） -->
    <header
      class="flex h-10 shrink-0 items-center gap-1 border-b px-2"
      :style="{
        background: 'color-mix(in srgb, var(--note-bar) 18%, var(--note-bg))',
        borderColor: 'var(--note-border)'
      }"
    >
      <span
        class="mr-1 h-4 w-1.5 shrink-0 rounded-sm"
        :style="{ background: 'var(--note-bar)' }"
      />
      <div class="min-w-0 flex-1 truncate text-[13px] font-medium text-ink/70">
        便签
        <span class="ml-1 text-[11px] font-normal tabular-nums text-ink/35">
          {{ activeCount }} 条
        </span>
      </div>
      <button
        class="flex h-7 items-center gap-0.5 rounded px-1.5 text-[12px] text-ink/60 hover:bg-ink/8"
        :title="deletedCount > 0 ? `回收站（${deletedCount}）` : '回收站'"
        @click="openHistory()"
      >
        <span class="text-[14px] leading-none">🗑</span>
        <span class="hidden sm:inline">回收站</span>
        <span v-if="deletedCount > 0" class="tabular-nums text-ink/40">{{ deletedCount }}</span>
      </button>
      <button
        class="flex h-7 items-center gap-0.5 rounded px-2 text-[12px] text-ink/60 hover:bg-ink/8"
        title="新建便签 (Ctrl+N)"
        @click="createNote()"
      >
        <span class="text-[14px] leading-none">＋</span>
        <span>新建</span>
      </button>
    </header>

    <!-- 搜索 -->
    <div class="shrink-0 space-y-2 border-b px-2.5 py-2" :style="{ borderColor: 'var(--note-border)' }">
      <div class="relative">
        <span
          class="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[12px] text-ink/30"
        >⌕</span>
        <input
          v-model="query"
          type="search"
          placeholder="搜索标题或摘要…"
          class="w-full rounded-md border bg-paper/55 py-1.5 pl-7 pr-7 text-[13px] text-ink/75 outline-none transition placeholder:text-ink/30 focus:bg-paper/80"
          :style="{ borderColor: 'var(--note-border)' }"
          spellcheck="false"
          @keydown="onKeydown"
        />
        <button
          v-if="query"
          class="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-[11px] text-ink/35 hover:bg-ink/8 hover:text-ink/70"
          title="清除"
          @click="query = ''"
        >
          ✕
        </button>
      </div>
    </div>

    <!-- 便签卡片列表 -->
    <main class="note-scroll note-content min-h-0 flex-1 overflow-auto">
      <div
        v-if="loading"
        class="flex h-full items-center justify-center text-[13px] text-ink/40"
      >
        加载中…
      </div>

      <div
        v-else-if="error"
        class="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-[13px] text-red-600/80"
      >
        <span>{{ error }}</span>
        <button
          class="rounded px-3 py-1 text-[12px] text-ink/60 hover:bg-ink/8"
          @click="refresh()"
        >
          重试
        </button>
      </div>

      <div
        v-else-if="filtered.length === 0"
        class="flex h-full flex-col items-center justify-center gap-1.5 px-6 text-center"
      >
        <span class="text-[22px] opacity-35">{{ query ? '⌕' : '✎' }}</span>
        <span class="text-[13px] text-ink/35">
          <template v-if="query">没有匹配「{{ query }}」的便签</template>
          <template v-else>还没有便签，点右上角新建</template>
        </span>
      </div>

      <ul v-else class="space-y-1.5 p-2">
        <li v-for="note in filtered" :key="note.id">
          <!-- 每条便签 = 对应颜色的迷你色卡 -->
          <div
            class="group relative flex cursor-pointer items-stretch overflow-hidden rounded-md border shadow-sm transition hover:shadow active:scale-[0.995]"
            :class="colorClass(note.color)"
            :style="{
              background: 'var(--note-bg)',
              borderColor: 'var(--note-border)'
            }"
            role="button"
            tabindex="0"
            @click="openNote(note.id)"
            @keydown.enter="openNote(note.id)"
          >
            <!-- 左侧色条，与便签工具栏同款 -->
            <span
              class="w-1 shrink-0 self-stretch"
              :style="{ background: 'var(--note-bar)' }"
            />

            <div class="min-w-0 flex-1 px-2.5 py-2">
              <div class="flex items-baseline justify-between gap-2">
                <span class="truncate text-[13px] font-medium text-ink/75">
                  {{ note.title || '未命名便签' }}
                </span>
                <span class="shrink-0 text-[11px] tabular-nums text-ink/35">
                  {{ formatDate(note.updatedAt) }}
                </span>
              </div>
              <p
                v-if="note.snippet"
                class="mt-0.5 line-clamp-2 text-[12px] leading-snug text-ink/45"
              >
                {{ note.snippet }}
              </p>
            </div>

            <!-- hover 操作 -->
            <div
              class="absolute right-1.5 top-1.5 flex items-center gap-0.5 rounded border p-0.5 opacity-0 shadow-sm transition group-hover:opacity-100 group-focus-within:opacity-100"
              :style="{
                borderColor: 'var(--note-border)',
                background: 'color-mix(in srgb, var(--note-bg) 70%, rgb(var(--paper)))'
              }"
              @click.stop
            >
              <button
                class="rounded px-1.5 py-0.5 text-[11px] text-ink/55 hover:bg-ink/8 hover:text-ink/80"
                title="打开"
                @click="openNote(note.id)"
              >
                打开
              </button>
              <button
                class="rounded px-1.5 py-0.5 text-[11px] text-red-700/70 hover:bg-red-500/12 hover:text-red-700"
                title="删除"
                @click="deleteNote(note, $event)"
              >
                删除
              </button>
            </div>
          </div>
        </li>
      </ul>
    </main>

    <footer
      class="flex h-6 shrink-0 items-center justify-between border-t px-2 text-[11px] text-ink/35"
      :style="{ borderColor: 'var(--note-border)' }"
    >
      <span class="tabular-nums">{{ filtered.length }} 条</span>
      <span>双击便签编辑 · Ctrl+N 新建</span>
    </footer>
  </div>
</template>
