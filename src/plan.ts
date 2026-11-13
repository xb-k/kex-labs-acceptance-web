import type { PlanStatus } from './types'

export const PLAN_TZ = 'Asia/Shanghai'
export const DAY_MS = 86_400_000
/** Asia/Shanghai has no DST, so a fixed +08:00 offset is exact for day boundaries. */
const TZ_OFFSET = 8 * 3_600_000

const dateTimeFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: PLAN_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23'
})

const weekdayFmt = new Intl.DateTimeFormat('zh-CN', { timeZone: PLAN_TZ, weekday: 'short' })

function partsOf(ts: number): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of dateTimeFmt.formatToParts(new Date(ts))) out[part.type] = part.value
  return out
}

export function parseTs(value: string): number | null {
  const ts = Date.parse(value)
  return Number.isFinite(ts) ? ts : null
}

/** `MM-DD HH:mm`，固定 Asia/Shanghai。 */
export function fmtDateTime(value: string | number): string {
  const ts = typeof value === 'number' ? value : parseTs(value)
  if (ts === null) return '—'
  const p = partsOf(ts)
  return `${p.month}-${p.day} ${p.hour}:${p.minute}`
}

/** `MM-DD 周X`，用于甘特图日刻度。 */
export function fmtDayLabel(ts: number): string {
  const p = partsOf(ts)
  return `${p.month}-${p.day} ${weekdayFmt.format(new Date(ts))}`
}

export function localDayStart(ts: number): number {
  return Math.floor((ts + TZ_OFFSET) / DAY_MS) * DAY_MS - TZ_OFFSET
}

/** 两个时刻之间的时长，按 h / d 显示。 */
export function fmtDuration(startTs: number, endTs: number): string {
  const ms = Math.max(0, endTs - startTs)
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes} 分`
  const hours = ms / 3_600_000
  if (hours < 48) return `${hours.toFixed(1)} h`
  return `${(hours / 24).toFixed(1)} d`
}

/** 计划跨度，例如「6 天 23 小时」。 */
export function fmtSpan(startTs: number, endTs: number): string {
  const minutes = Math.max(0, Math.round((endTs - startTs) / 60_000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.round((minutes - days * 1440) / 60)
  if (days === 0) return `${hours} 小时`
  return `${days} 天${hours > 0 ? ` ${hours} 小时` : ''}`
}

export const PLAN_STATUS: Record<PlanStatus, { label: string; text: string; dot: string }> = {
  done: { label: '已完成', text: 'text-apple-subtext', dot: 'bg-[#C7C7CC]' },
  running: { label: '进行中', text: 'text-apple-blueInk', dot: 'bg-apple-blue' },
  // tasks.json 真实值域含 in_progress（与 running 同义），样式复用 running。
  in_progress: { label: '进行中', text: 'text-apple-blueInk', dot: 'bg-apple-blue' },
  pending: { label: '未开始', text: 'text-apple-subtextAlt', dot: 'bg-[#A9CBF3]' },
  blocked: { label: '阻塞', text: 'text-apple-amber', dot: 'bg-[#DDA45C]' }
}

/**
 * 状态取色兜底：接口返回未知状态时不能抛 TypeError。
 * 未知值直接显示原状态字符串，样式用中性灰。
 */
export function planStatusTone(status: string): { label: string; text: string; dot: string } {
  return PLAN_STATUS[status as PlanStatus] ?? { label: status, text: 'text-apple-subtext', dot: 'bg-[#C7C7CC]' }
}

const RAIL_LABELS: Record<string, string> = {
  A: 'A 轨',
  B: 'B 轨',
  both: '双轨',
  用户: '用户',
  master: 'Master'
}

export function railLabel(rail: string): string {
  return RAIL_LABELS[rail] ?? rail
}
