<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useNotes } from './stores/use-notes'
import NoteList from './components/NoteList.vue'
import NoteEditor from './components/NoteEditor.vue'
import HistoryView from './components/HistoryView.vue'

const {
  view,
  status,
  refresh,
  onGlobalKeydown,
  startPolling,
  stopPolling
} = useNotes()

onMounted(() => {
  void refresh()
  startPolling()
  window.addEventListener('keydown', onGlobalKeydown)
})

onUnmounted(() => {
  stopPolling()
  window.removeEventListener('keydown', onGlobalKeydown)
})
</script>

<template>
  <div class="h-full">
    <NoteList v-if="view === 'list'" />
    <NoteEditor v-else-if="view === 'note'" />
    <HistoryView v-else />

    <!-- transient status toast -->
    <transition name="fade">
      <div
        v-if="status"
        class="pointer-events-none absolute bottom-3 left-1/2 z-30 -translate-x-1/2 rounded-full bg-ink/70 px-3 py-1 text-[12px] text-paper shadow-lg"
      >
        {{ status }}
      </div>
    </transition>
  </div>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.18s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
