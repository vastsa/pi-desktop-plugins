<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { HIGHLIGHT_COLORS } from '../lib/highlight'

const props = defineProps<{
  x: number
  y: number
  /** 选中文本本身已是被标记的（显示「移除标记」项） */
  hasMark: boolean
}>()

const emit = defineEmits<{
  select: [color: string]
  remove: []
  close: []
}>()

const root = ref<HTMLDivElement | null>(null)

// 菜单约 150px 宽 / 70px 高，贴边时向内收敛
const left = computed(() => Math.max(4, Math.min(props.x, window.innerWidth - 160)))
const top = computed(() => Math.max(4, Math.min(props.y, window.innerHeight - 80)))

function onDocMouseDown(e: MouseEvent): void {
  if (root.value && e.target instanceof Node && !root.value.contains(e.target)) {
    emit('close')
  }
}

onMounted(() => document.addEventListener('mousedown', onDocMouseDown))
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocMouseDown))
</script>

<template>
  <Teleport to="body">
    <div
      ref="root"
      class="fixed z-50 rounded-lg border border-ink/10 bg-paper p-1.5 shadow-lg"
      :style="{ left: `${left}px`, top: `${top}px` }"
      role="menu"
    >
      <div class="flex items-center gap-1.5 px-1 py-0.5">
        <button
          v-for="c in HIGHLIGHT_COLORS"
          :key="c.name"
          type="button"
          role="menuitem"
          :title="c.label"
          class="h-5 w-5 rounded-full ring-1 ring-ink/10 transition-transform hover:scale-110"
          :style="{ backgroundColor: c.bg }"
          @click="emit('select', c.name)"
        />
        <button
          type="button"
          role="menuitem"
          title="取消高亮"
          class="h-5 w-5 rounded-full bg-paper ring-1 ring-ink/10 transition-transform hover:scale-110"
          :style="{
            backgroundImage:
              'linear-gradient(to bottom right, transparent 44%, #e05252 44%, #e05252 56%, transparent 56%)'
          }"
          @click="emit('remove')"
        />
      </div>
      <div v-if="hasMark" class="mt-1 border-t border-ink/10 pt-1">
        <button
          type="button"
          role="menuitem"
          class="w-full rounded-md px-2 py-1 text-left text-xs text-ink/70 hover:bg-ink/5"
          @click="emit('remove')"
        >
          移除标记
        </button>
      </div>
    </div>
  </Teleport>
</template>
