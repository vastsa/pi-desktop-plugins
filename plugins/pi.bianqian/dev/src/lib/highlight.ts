/**
 * 文本高亮标记（荧光笔）的共享常量与纯函数（移植自桌面版 electron/shared/highlight.ts）。
 *
 * 标记语法：`==颜色名:文本==`（如 `==yellow:重要==`），无颜色前缀的 `==文本==`
 * 渲染为默认黄色。颜色名是白名单，未知前缀视为普通内容。
 *
 * 注意：HIGHLIGHT_COLORS 的 `bg` 色值与 styles/main.css 中 `.md-preview mark` 系列
 * 样式手动对应，改一边时必须同步另一边。
 */

export interface HighlightColor {
  name: string
  label: string
  /** 荧光笔背景色，用于右键色板；与 main.css 的 mark 样式对应 */
  bg: string
}

export const HIGHLIGHT_COLORS: HighlightColor[] = [
  { name: 'yellow', label: '黄色', bg: '#fff176' },
  { name: 'green', label: '绿色', bg: '#c5e1a5' },
  { name: 'blue', label: '蓝色', bg: '#90caf9' },
  { name: 'pink', label: '粉色', bg: '#f8bbd0' },
  { name: 'orange', label: '橙色', bg: '#ffcc80' },
  { name: 'red', label: '红色', bg: '#ef9a9a' }
]

export const HIGHLIGHT_NAMES: string[] = HIGHLIGHT_COLORS.map((c) => c.name)

/** 匹配单段 `==颜色:文本==` / `==文本==`（内容不含 =，首个字符非空白） */
const MARK_FULL_RE = /^==((?:[a-z]+:)?[^=\s][^=]*?)==$/

/** 全局匹配用于剥除标题/摘要里的标记语法；内容首个字符非空白，避免误伤 `a == b` */
const MARK_STRIP_RE = /==((?:[a-z]+:)?[^=\s][^=]*?)==/g

function highlightNameOf(content: string): string | null {
  const m = content.match(/^([a-z]+):/)
  return m && HIGHLIGHT_NAMES.includes(m[1]) ? m[1] : null
}

/** 用 `==颜色:文本==` 包裹文本；未知颜色回退黄色 */
export function wrapHighlight(text: string, color: string): string {
  const c = HIGHLIGHT_NAMES.includes(color) ? color : 'yellow'
  return `==${c}:${text}==`
}

/**
 * 跨行文本逐行包裹高亮：每行首尾空白保留在标记外（`==` 需紧贴非空白字符
 * 才能被渲染规则识别），空行保持原样。编辑/预览模式的右键标记共用。
 */
export function wrapHighlightLines(text: string, color: string): string {
  return text
    .split('\n')
    .map((line) => {
      const lead = line.length - line.trimStart().length
      const trail = line.length - line.trimEnd().length
      const core = line.slice(lead, line.length - trail)
      return core
        ? line.slice(0, lead) + wrapHighlight(core, color) + line.slice(line.length - trail)
        : line
    })
    .join('\n')
}

/** 若整段文本是单条标记（`==颜色:文本==`），返回去掉标记的纯文本；否则返回 null */
export function tryUnwrapHighlight(text: string): string | null {
  const m = text.match(MARK_FULL_RE)
  if (!m) return null
  const content = m[1]
  const color = highlightNameOf(content)
  if (color) return content.slice(color.length + 1)
  return content
}

/** 删除文本中的所有 `==...==` 标记语法（标题/摘要派生用），未知颜色前缀保留原样 */
export function stripHighlightMarkup(text: string): string {
  return text.replace(MARK_STRIP_RE, (whole, content: string) => {
    const color = highlightNameOf(content)
    return color ? content.slice(color.length + 1) : whole
  })
}
