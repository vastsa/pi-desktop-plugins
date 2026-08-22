<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useNotes } from '../stores/use-notes'
import { formatDate } from '../lib/format'
import { confirm } from '../lib/confirm'

const {
  notes,
  loading,
  error,
  deletedCount,
  restoreNote,
  purgeNote,
  purgeAll,
  backToList,
  refresh,
  setStatus
} = useNotes()

const query = ref('')
const busyId = ref<string | null>(null)

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  return notes.value
    .filter((n) => n.deleted)
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

async function restore(id: string): Promise<void> {
  if (busyId.value) return
  busyId.value = id
  try {
    await restoreNote(id)
    setStatus('已恢复到列表')
  } catch (e) {
    setStatus(e instanceof Error ? e.message : '恢复失败')
  } finally {
    busyId.value = null
  }
}

async function purge(id: string): Promise<void> {
  if (busyId.value) return
  const ok = await confirm({
    title: '提醒',
    message: '永久删除这条便签？此操作无法撤销。',
    confirmText: '永久删除',
    cancelText: '取消',
    danger: true
  })
  if (!ok) return
  busyId.value = id
  try {
    await purgeNote(id)
  } catch (e) {
    setStatus(e instanceof Error ? e.message : '清除失败')
  } finally {
    busyId.value = null
  }
}

async function onPurgeAll(): Promise<void> {
  if (deletedCount.value === 0) return
  const ok = await confirm({
    title: '提醒',
    message: `清空回收站？将永久删除 ${deletedCount.value} 条便签，无法撤销。`,
    confirmText: '清空',
    cancelText: '取消',
    danger: true
  })
  if (!ok) return
  await purgeAll()
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    void backToList()
    return
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    e.preventDefault()
    const input = document.getElementById('history-search') as HTMLInputElement | null
    input?.focus()
    input?.select()
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div
    class="note-yellow flex h-full flex-col overflow-hidden"
    :style="{
      background: 'var(--note-bg)',
      borderColor: 'var(--note-border)'
    }"
  >
    <!-- 面板内工具栏 -->
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
        回收站
        <span class="ml-1 text-[11px] font-normal tabular-nums text-ink/35">
          {{ deletedCount }} 条
        </span>
      </div>
      <button
        v-if="deletedCount > 0"
        class="flex h-7 items-center rounded px-2 text-[12px] text-red-700/70 hover:bg-red-500/12 hover:text-red-700"
        title="清空回收站"
        @click="onPurgeAll()"
      >
        清空
      </button>
    </header>

    <!-- 搜索 -->
    <div class="shrink-0 space-y-2 border-b px-2.5 py-2" :style="{ borderColor: 'var(--note-border)' }">
      <div class="relative">
        <span
          class="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[12px] text-ink/30"
        >⌕</span>
        <input
          id="history-search"
          v-model="query"
          type="search"
          placeholder="搜索标题或摘要…"
          class="w-full rounded-md border bg-paper/55 py-1.5 pl-7 pr-7 text-[13px] text-ink/75 outline-none transition placeholder:text-ink/30 focus:bg-paper/80"
          :style="{ borderColor: 'var(--note-border)' }"
          spellcheck="false"
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

    <!-- 已删除便签列表 -->
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
        <span class="text-[22px] opacity-35">{{ query ? '⌕' : '∅' }}</span>
        <span class="text-[13px] text-ink/35">
          <template v-if="query">没有匹配「{{ query }}」的便签</template>
          <template v-else>回收站是空的</template>
        </span>
      </div>

      <ul v-else class="space-y-1.5 p-2">
        <li v-for="note in filtered" :key="note.id">
          <!-- 每条便签 = 对应颜色的迷你色卡 -->
          <div
            class="group relative flex cursor-pointer items-stretch overflow-hidden rounded-md border shadow-sm transition hover:shadow active:scale-[0.995]"
            :class="[colorClass(note.color), busyId === note.id && 'opacity-60']"
            :style="{
              background: 'var(--note-bg)',
              borderColor: 'var(--note-border)'
            }"
          >
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
                title="恢复"
                @click="restore(note.id)"
              >
                恢复
              </button>
              <button
                class="rounded px-1.5 py-0.5 text-[11px] text-red-700/70 hover:bg-red-500/12 hover:text-red-700"
                title="永久删除"
                @click="purge(note.id)"
              >
                清除
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
      <span>Esc 返回 · Ctrl+F 搜索</span>
    </footer>
  </div>
</template>
