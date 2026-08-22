/** 相对时间格式化（移植自桌面版 HistoryPanel） */
export function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffMin = Math.floor(diffMs / 60000)
  if (diffMin < 1) return '刚刚'
  if (diffMin < 60) return `${diffMin} 分钟前`
  if (diffMin < 60 * 24 && d.getDate() === now.getDate()) {
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }
  const diffDays = Math.floor(diffMs / 86400000)
  if (diffDays === 1 || (diffDays === 0 && d.getDate() !== now.getDate())) {
    return '昨天'
  }
  if (diffDays < 7) return `${diffDays} 天前`
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
  }
  return d.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  })
}

/** 非空白字符数（字数统计，与桌面版一致） */
export function charCount(content: string): number {
  return content.replace(/\s/g, '').length
}
