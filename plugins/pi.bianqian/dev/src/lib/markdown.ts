import MarkdownIt from 'markdown-it'
import taskLists from 'markdown-it-task-lists'

/**
 * @types/markdown-it 用 `export =` 导出：type-only default import 在编译期完全擦除，
 * 又能拿到命名空间（Token 类型）。与桌面版 electron-vite 构建等价。
 */
import type MarkdownItNS from 'markdown-it'

type Token = MarkdownItNS.Token
import { HIGHLIGHT_NAMES } from './highlight'
import hljs from 'highlight.js/lib/core'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import json from 'highlight.js/lib/languages/json'
import xml from 'highlight.js/lib/languages/xml'
import css from 'highlight.js/lib/languages/css'
import bash from 'highlight.js/lib/languages/bash'
import python from 'highlight.js/lib/languages/python'
import sql from 'highlight.js/lib/languages/sql'
import markdown from 'highlight.js/lib/languages/markdown'
import 'highlight.js/styles/github.css'

hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('js', javascript)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('ts', typescript)
hljs.registerLanguage('json', json)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('html', xml)
hljs.registerLanguage('css', css)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('shell', bash)
hljs.registerLanguage('sh', bash)
hljs.registerLanguage('python', python)
hljs.registerLanguage('py', python)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('md', markdown)

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  highlight(str, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return `<pre class="hljs"><code>${hljs.highlight(str, { language: lang, ignoreIllegals: true }).value}</code></pre>`
      } catch {
        // fall through
      }
    }
    const escaped = md.utils.escapeHtml(str)
    return `<pre class="hljs"><code>${escaped}</code></pre>`
  }
})

// 不启用 label：labelAfter 会把整行源码原文（含 ==标记== 语法）渲染成文字，
// 且其 children.pop() hack 会弹掉行尾嵌套语法（==标记== / *斜体* / `代码`）的闭合 token，
// 导致 <mark> 等未闭合。enabled 只生成 checkbox，任务勾选功能不受影响。
md.use(taskLists, { enabled: true })

// —— 高亮标记 `==颜色:文本==` / `==文本==`（自定义 inline 规则，仿 markdown-it-mark）——
// 颜色名来自 HIGHLIGHT_COLORS 白名单 → `<mark class="hl-x">`；无前缀/未知前缀 → 默认 `<mark>`

const EQUALS = 0x3d // '='

/**
 * markdown-it StateInline 的子集（@types/markdown-it 未导出该类型），
 * 只包含本规则用到的成员。
 */
interface InlineStateLike {
  pos: number
  posMax: number
  src: string
  push(type: string, tag: string, nesting: number): InlineTokenLike
  md: {
    utils: { isWhiteSpace(code: number): boolean }
    inline: { parse(src: string, md: unknown, env: unknown, outTokens: unknown[]): void }
  }
  env: unknown
}

/** markdown-it Token 的子集，本规则只用到 attrPush / content / children */
interface InlineTokenLike {
  attrPush(attr: [string, string]): void
  content: string
  children: unknown[]
}

function parseHighlightColor(content: string): string | null {
  const m = content.match(/^([a-z]+):/)
  if (!m || !HIGHLIGHT_NAMES.includes(m[1])) return null
  return m[1]
}

function highlightTokenizer(state: InlineStateLike, silent: boolean): boolean {
  if (silent) return false

  const start = state.pos
  if (state.src.charCodeAt(start) !== EQUALS) return false
  if (start + 1 >= state.posMax || state.src.charCodeAt(start + 1) !== EQUALS) return false

  // `==` 后必须紧贴非空白字符（`a == b` 不算标记）
  const next = state.src.charCodeAt(start + 2)
  if (next === EQUALS || state.md.utils.isWhiteSpace(next)) return false

  const close = state.src.indexOf('==', start + 2)
  if (close === -1) return false

  // 闭合 `==` 前不能是空白，且内容非空
  const prev = state.src.charCodeAt(close - 1)
  if (prev === EQUALS || state.md.utils.isWhiteSpace(prev)) return false
  const content = state.src.slice(start + 2, close)
  if (!content) return false

  const color = parseHighlightColor(content)
  const tokenOpen = state.push('mark_open', 'mark', 1)
  if (color) tokenOpen.attrPush(['class', `hl-${color}`])
  // 内容递归走 inline 解析（粗体/斜体/代码等可嵌套在标记内）。
  // 外层闭合取第一个 `==`，内容永不含 `==`，不会无限递归。
  const inner = color ? content.slice(color.length + 1) : content
  const tokenInline = state.push('inline', '', 0)
  tokenInline.content = inner
  tokenInline.children = []
  state.md.inline.parse(inner, state.md, state.env, tokenInline.children)
  state.push('mark_close', 'mark', -1)

  state.pos = close + 2
  return true
}

md.inline.ruler.before('emphasis', 'highlight', highlightTokenizer)

// `inline` token（高亮标记的嵌套内容容器）渲染 children；children 为空时兜底
// 输出转义后的 content，避免落到 renderToken 的默认分支输出空标签 `<>`。
// 仅影响标记内容这类行内级 inline token，块级 inline token 由 renderer.render 特判处理。
md.renderer.rules.inline = function (tokens, idx, options, env, self) {
  const token = tokens[idx]
  if (token.children && token.children.length) {
    return self.renderInline(token.children, options, env)
  }
  return token.content ? md.utils.escapeHtml(token.content) : ''
}

// Open links externally (panel 通过宿主 shell.openExternal 打开，见 MarkdownPreview)
const defaultRender =
  md.renderer.rules.link_open ||
  function (tokens, idx, options, _env, self) {
    return self.renderToken(tokens, idx, options)
  }

md.renderer.rules.link_open = function (tokens, idx, options, env, self) {
  const token = tokens[idx]
  const aIndex = token.attrIndex('target')
  if (aIndex < 0) {
    token.attrPush(['target', '_blank'])
  } else if (token.attrs) {
    token.attrs[aIndex][1] = '_blank'
  }
  token.attrPush(['rel', 'noopener noreferrer'])
  return defaultRender(tokens, idx, options, env, self)
}

// —— 可见空白行 ——
// markdown 会把连续空行折叠成段落间隔（编辑模式按 N 次回车 → 预览只剩一小段空隙）。
// 这里在块与块之间（含列表兄弟项之间）按源码中的空行数插入 md_blank token，
// 让编辑模式产生的空行在预览里同样可见，与 breaks: true 的「所见即所得」体验一致。

const BLANK_LINE_RE = /^\s*$/
/** 预览行高（与 .md-preview 的 line-height: 1.6 对应），md_blank 按此换算高度 */
const BLANK_LINE_EM = 1.6

interface BlankToken {
  type: 'md_blank'
  tag: 'div' | 'li'
  nesting: 0
  mdBlank: number
}

function makeBlankToken(count: number, tag: 'div' | 'li'): BlankToken {
  return { type: 'md_blank', tag, nesting: 0, mdBlank: count }
}

/** 块 map 区间 [start, end) 末尾连续的空行数（列表 li 的 map 会吸收尾部空行） */
function trailingBlankLines(lines: string[], mapEnd: number): number {
  let n = 0
  for (let i = mapEnd - 1; i >= 0 && BLANK_LINE_RE.test(lines[i]); i--) n++
  return n
}

/** 相邻两块（prev 结束行 → next 起始行）之间的空行数 */
function blankLinesBetween(lines: string[], prevEnd: number, nextStart: number): number {
  let n = trailingBlankLines(lines, prevEnd)
  for (let i = prevEnd; i < nextStart; i++) {
    if (BLANK_LINE_RE.test(lines[i])) n++
  }
  return n
}

/** 文档末尾（最后一个块之后）的空行数；结尾的 \n 产生的空行不计 */
function trailingBlankCount(
  lines: string[],
  prevEnd: number,
  totalLines: number,
  endsWithNl: boolean
): number {
  let n = trailingBlankLines(lines, prevEnd)
  for (let i = prevEnd; i < totalLines; i++) {
    if (BLANK_LINE_RE.test(lines[i])) n++
  }
  if (endsWithNl) n = Math.max(0, n - 1)
  return n
}

/**
 * 在 token 流中按嵌套深度插入空白行 token。
 * markdown-it 的块级 token 是扁平的（列表项内容与顶层块同层，靠 nesting 区分），
 * 所以每个深度各维护上一个兄弟块的结束行；进入更深的层时重置。
 * 空白行 tag 规则：下一个块是 list_item_open（列表项兄弟之间）→ li，否则 div。
 */
function renderTokensWithBlanks(
  tokens: Token[],
  lines: string[]
): { out: (Token | BlankToken)[]; lastTopLevelEnd: number | null } {
  const out: (Token | BlankToken)[] = []
  const prevEnds: (number | null)[] = [null]
  let depth = 0
  let lastTopLevelEnd: number | null = null
  for (const token of tokens) {
    if (token.map && (token.nesting > 0 || token.type === 'fence')) {
      if (depth === 0) lastTopLevelEnd = token.map[1]
      const prevEnd = prevEnds[depth]
      if (prevEnd !== null) {
        const blanks = blankLinesBetween(lines, prevEnd, token.map[0])
        if (blanks > 0) {
          const tag = token.type === 'list_item_open' ? 'li' : 'div'
          out.push(makeBlankToken(blanks, tag))
        }
      }
      prevEnds[depth] = token.map[1]
    }
    if (token.nesting > 0) {
      depth++
      prevEnds[depth] = null
    }
    out.push(token)
    if (token.nesting < 0) depth--
  }
  return { out, lastTopLevelEnd }
}

export function renderMarkdown(source: string): string {
  const text = source || ''
  const tokens = md.parse(text, {})
  const lines = text.split('\n')

  // 给块级元素注入源码行号区间（data-line="start-end"），
  // 供预览模式把 DOM 选区映射回源码位置
  for (const token of tokens) {
    if (token.map && token.nesting > 0) {
      token.attrPush(['data-line', `${token.map[0]}-${token.map[1]}`])
    }
  }

  const { out, lastTopLevelEnd } = renderTokensWithBlanks(tokens, lines)
  // 文档末尾的空行（最后一个块之后；列表尾随空行已被 li map 吸收，由 trailing 计数补回）
  if (lastTopLevelEnd !== null) {
    const blanks = trailingBlankCount(lines, lastTopLevelEnd, lines.length, text.endsWith('\n'))
    if (blanks > 0) out.push(makeBlankToken(blanks, 'div'))
  }

  return md.renderer.render(out as unknown as Token[], md.options, {})
}

// md_blank：渲染为固定行高的空白 div/li，高度按空行数累加
md.renderer.rules['md_blank'] = (tokens: Token[], idx: number): string => {
  const t = tokens[idx] as unknown as BlankToken
  const n = t.mdBlank || 1
  const height = (n * BLANK_LINE_EM).toFixed(2)
  return `<${t.tag} class="md-blank" aria-hidden="true" style="height:${height}em"></${t.tag}>`
}
