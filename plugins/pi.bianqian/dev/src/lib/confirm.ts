import { createApp, h } from 'vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'

export interface ConfirmOptions {
  /** Dialog title — defaults to 「提醒」 */
  title?: string
  message: string
  confirmText?: string
  cancelText?: string
  /** Red confirm button (default true) */
  danger?: boolean
}

/**
 * App-styled confirmation dialog (replaces window.confirm, which is
 * unreliable in the sandboxed panel).
 */
export function confirm(options: ConfirmOptions | string): Promise<boolean> {
  const opts: ConfirmOptions =
    typeof options === 'string' ? { message: options } : options

  return new Promise((resolve) => {
    const host = document.createElement('div')
    document.body.appendChild(host)

    let settled = false
    const finish = (result: boolean): void => {
      if (settled) return
      settled = true
      // allow leave transition to paint before unmount
      setTimeout(() => {
        app.unmount()
        host.remove()
      }, 160)
      resolve(result)
    }

    const app = createApp({
      render() {
        return h(ConfirmDialog, {
          title: opts.title ?? '提醒',
          message: opts.message,
          confirmText: opts.confirmText ?? '确定',
          cancelText: opts.cancelText ?? '取消',
          danger: opts.danger ?? true,
          onConfirm: () => finish(true),
          onCancel: () => finish(false)
        })
      }
    })

    app.mount(host)
  })
}
