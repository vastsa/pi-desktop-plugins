<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'

const props = withDefaults(
  defineProps<{
    title?: string
    message: string
    confirmText?: string
    cancelText?: string
    /** danger = red confirm button (delete actions) */
    danger?: boolean
  }>(),
  {
    title: '提醒',
    confirmText: '确定',
    cancelText: '取消',
    danger: true
  }
)

const emit = defineEmits<{
  confirm: []
  cancel: []
}>()

const visible = ref(false)

function onConfirm(): void {
  visible.value = false
  // let leave transition start; parent resolves immediately is fine
  emit('confirm')
}

function onCancel(): void {
  visible.value = false
  emit('cancel')
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    onCancel()
  } else if (e.key === 'Enter') {
    e.preventDefault()
    e.stopPropagation()
    onConfirm()
  }
}

onMounted(() => {
  // next frame so enter transition plays
  requestAnimationFrame(() => {
    visible.value = true
  })
  window.addEventListener('keydown', onKeydown, true)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown, true)
})
</script>

<template>
  <Teleport to="body">
    <div class="confirm-root" role="presentation">
      <!-- backdrop -->
      <transition name="confirm-fade">
        <div
          v-if="visible"
          class="confirm-backdrop"
          @click="onCancel"
        />
      </transition>

      <!-- panel -->
      <transition name="confirm-pop">
        <div
          v-if="visible"
          class="confirm-panel"
          role="alertdialog"
          aria-modal="true"
          :aria-labelledby="'confirm-title'"
          :aria-describedby="'confirm-msg'"
        >
          <div class="confirm-accent" />

          <div class="confirm-body">
            <div class="confirm-header">
              <span class="confirm-icon" :class="danger ? 'is-danger' : 'is-info'">
                {{ danger ? '!' : 'i' }}
              </span>
              <h2 id="confirm-title" class="confirm-title">{{ title }}</h2>
            </div>

            <p id="confirm-msg" class="confirm-message">{{ message }}</p>

            <div class="confirm-actions">
              <button type="button" class="btn btn-ghost" @click="onCancel">
                {{ cancelText }}
              </button>
              <button
                type="button"
                class="btn"
                :class="danger ? 'btn-danger' : 'btn-primary'"
                autofocus
                @click="onConfirm"
              >
                {{ confirmText }}
              </button>
            </div>
          </div>
        </div>
      </transition>
    </div>
  </Teleport>
</template>

<style scoped>
/*
 * 主题自适应：面板的浅/深色由宿主经 appearance 通道切换（html[data-theme]）。
 * 文字/底色走 --ink/--paper 变量；danger/primary 按钮与强调色条保留原色。
 */
.confirm-root {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  pointer-events: none;
}

.confirm-backdrop {
  position: absolute;
  inset: 0;
  background: rgb(var(--ink) / 0.35);
  backdrop-filter: blur(2px);
  pointer-events: auto;
}

.confirm-panel {
  position: relative;
  z-index: 1;
  width: min(300px, 100%);
  overflow: hidden;
  border-radius: 12px;
  border: 1px solid rgb(var(--ink) / 0.08);
  background: rgb(var(--paper));
  box-shadow:
    0 1px 2px rgb(var(--ink) / 0.04),
    0 12px 32px rgb(var(--ink) / 0.14),
    0 0 0 1px rgb(var(--ink) / 0.03) inset;
  pointer-events: auto;
}

.confirm-accent {
  height: 3px;
  background: linear-gradient(
    90deg,
    #f9a825 0%,
    #ffca28 45%,
    #ff8a65 100%
  );
}

.confirm-body {
  padding: 16px 16px 14px;
}

.confirm-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.confirm-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  font-size: 13px;
  font-weight: 700;
  line-height: 1;
  flex-shrink: 0;
}

.confirm-icon.is-danger {
  color: #c62828;
  background: rgba(198, 40, 40, 0.12);
}

.confirm-icon.is-info {
  color: #1565c0;
  background: rgba(21, 101, 192, 0.12);
}

.confirm-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: rgb(var(--ink) / 0.78);
  letter-spacing: 0.02em;
}

.confirm-message {
  margin: 0 0 16px;
  padding-left: 30px;
  font-size: 13px;
  line-height: 1.55;
  color: rgb(var(--ink) / 0.55);
  white-space: pre-wrap;
  word-break: break-word;
}

.confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.btn {
  min-width: 64px;
  height: 30px;
  padding: 0 14px;
  border: none;
  border-radius: 7px;
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
  transition:
    background 0.15s ease,
    box-shadow 0.15s ease,
    transform 0.1s ease;
}

.btn:active {
  transform: scale(0.97);
}

.btn-ghost {
  background: transparent;
  color: rgb(var(--ink) / 0.55);
}

.btn-ghost:hover {
  background: rgb(var(--ink) / 0.06);
  color: rgb(var(--ink) / 0.75);
}

.btn-danger {
  color: #fff;
  background: linear-gradient(180deg, #ef5350 0%, #e53935 100%);
  box-shadow: 0 1px 3px rgba(229, 57, 53, 0.35);
}

.btn-danger:hover {
  background: linear-gradient(180deg, #f44336 0%, #d32f2f 100%);
  box-shadow: 0 2px 6px rgba(229, 57, 53, 0.4);
}

.btn-primary {
  color: #fff;
  background: linear-gradient(180deg, #66bb6a 0%, #43a047 100%);
  box-shadow: 0 1px 3px rgba(67, 160, 71, 0.35);
}

.btn-primary:hover {
  background: linear-gradient(180deg, #81c784 0%, #388e3c 100%);
}

/* transitions */
.confirm-fade-enter-active,
.confirm-fade-leave-active {
  transition: opacity 0.16s ease;
}
.confirm-fade-enter-from,
.confirm-fade-leave-to {
  opacity: 0;
}

.confirm-pop-enter-active {
  transition:
    opacity 0.18s ease,
    transform 0.18s cubic-bezier(0.2, 0.9, 0.3, 1.15);
}
.confirm-pop-leave-active {
  transition:
    opacity 0.12s ease,
    transform 0.12s ease;
}
.confirm-pop-enter-from {
  opacity: 0;
  transform: scale(0.94) translateY(4px);
}
.confirm-pop-leave-to {
  opacity: 0;
  transform: scale(0.96) translateY(2px);
}
</style>
