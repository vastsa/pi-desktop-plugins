/** 便签类型（与插件进程 store.js 的数据模型一致，去掉窗口专属字段） */

export type NoteColor = 'yellow' | 'pink' | 'blue' | 'green' | 'purple' | 'gray'

export type NoteMode = 'preview' | 'edit'

export const NOTE_COLORS: NoteColor[] = [
  'yellow',
  'pink',
  'blue',
  'green',
  'purple',
  'gray'
]

export const COLOR_LABELS: Record<NoteColor, string> = {
  yellow: '黄',
  pink: '粉',
  blue: '蓝',
  green: '绿',
  purple: '紫',
  gray: '灰'
}
