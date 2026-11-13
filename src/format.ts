export type FormatBytesOptions = {
  fallback?: string
  zeroAsFallback?: boolean
  showKb?: boolean
}

export function formatBytes(
  bytes: number | null | undefined,
  options?: FormatBytesOptions
): string {
  const fallback = options?.fallback ?? '无数据'
  if (bytes == null || !Number.isFinite(bytes)) return fallback
  if (options?.zeroAsFallback && bytes <= 0) return fallback
  if (bytes < 0) return fallback
  if (options?.showKb && bytes < 1024) return `${Math.round(bytes)} B`
  if (options?.showKb && bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  const mb = bytes / 1024 / 1024
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`
}

export function formatSizeBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function formatGb(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const n = value / 1024 ** 3
  return n >= 10 ? n.toFixed(0) : n.toFixed(1)
}

export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00.0'
  const m = Math.floor(seconds / 60)
  const s = seconds - m * 60
  return `${m}:${s.toFixed(1).padStart(4, '0')}`
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '无数据'
  return `${seconds.toFixed(1)}s`
}

export function formatResolution(w: number | null, h: number | null): string {
  if (!w || !h) return '无数据'
  return `${w}×${h}`
}

export function formatFrames(frames: number | null, fps: number | null): string {
  if (frames == null || fps == null || !fps) return '无数据'
  return `${frames} 帧 @${fps}fps = ${(frames / fps).toFixed(2)}s`
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

export function formatStamp(value: string | number | null | undefined, includeSeconds = false): string {
  if (value == null || value === '') return '—'
  const ts = typeof value === 'number' ? value : Date.parse(value)
  if (!Number.isFinite(ts)) return typeof value === 'string' ? value : '—'
  const d = new Date(ts)
  const base = `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  return includeSeconds ? `${base}:${pad2(d.getSeconds())}` : base
}

export function formatFullStamp(value: string | number | null | undefined): string {
  if (value == null || value === '') return '—'
  const ts = typeof value === 'number' ? value : Date.parse(value)
  if (!Number.isFinite(ts)) return typeof value === 'string' ? value : '—'
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

export function formatClockMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—'
  const d = new Date(ms)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

export function formatAgo(value: string | number | null | undefined): string {
  if (value == null || value === '') return '—'
  const ts = typeof value === 'number' ? value : Date.parse(value)
  if (!Number.isFinite(ts)) return '—'
  const diffMin = Math.floor((Date.now() - ts) / 60_000)
  if (diffMin < 1) return '刚刚'
  if (diffMin < 60) return `${diffMin} 分钟前`
  const diffH = Math.floor(diffMin / 60)
  if (diffH < 24) return `${diffH} 小时前`
  const diffD = Math.floor(diffH / 24)
  if (diffD < 30) return `${diffD} 天前`
  return formatStamp(ts)
}

export function formatPct(value: number | null | undefined, digits = 0): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${value.toFixed(digits)}%`
}

export function csvCell(value: string | number | boolean | null | undefined): string {
  const s = value == null ? '' : String(value)
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
}

export function downloadCsvFile(filename: string, rows: Array<Array<string | number | boolean | null | undefined>>): void {
  const csv = rows.map((row) => row.map(csvCell).join(',')).join('\n')
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function gateToneClass(gate: string | null | undefined): string {
  const normalized = (gate ?? '').toUpperCase()
  if (normalized === 'PASS') return 'bg-[#E9F7EF] text-apple-green'
  if (normalized === 'FAIL') return 'bg-[#FDEDEC] text-apple-red'
  if (normalized === 'CONDITIONAL') return 'bg-[#FEF5E7] text-apple-amber'
  return 'bg-[#F2F2F7] text-apple-subtext'
}
