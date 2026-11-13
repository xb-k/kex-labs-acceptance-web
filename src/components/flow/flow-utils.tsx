import type { ReactNode } from 'react'
import { formatClockMs, formatFullStamp } from '../../format'
import type { FlowJob, FlowStage } from '../../types'

export const STAGE_LABEL: Record<string, string> = {
  A: '素材处理',
  B: '抽帧',
  B2: '帧语义',
  C: '关键帧重绘',
  D: 'I2V 生成',
  E: '调色 · 插帧 · 超分',
  F: '音频 · 封装'
}

export type Tone = { label: string; chip: string; text: string; dot: string; bar: string }

const TONES: Record<string, Tone> = {
  done: {
    label: '完成',
    chip: 'bg-[#EAF8EE] text-apple-greenInk ring-[#CDEED6]',
    text: 'text-apple-greenInk',
    dot: 'bg-apple-statusDone',
    bar: 'bg-apple-statusDone'
  },
  running: {
    label: '执行中',
    chip: 'bg-[#E8F1FB] text-apple-blueInk ring-[#CFE2F8]',
    text: 'text-apple-blueInk',
    dot: 'bg-apple-statusRunning',
    bar: 'bg-apple-statusRunning'
  },
  failed: {
    label: '失败',
    chip: 'bg-[#FCEDEB] text-[#B3261E] ring-[#F3D3CF]',
    text: 'text-[#B3261E]',
    dot: 'bg-apple-red',
    bar: 'bg-apple-red'
  },
  pending: {
    label: '待排队',
    chip: 'bg-[#F0F0F2] text-apple-subtextAlt ring-[#E2E2E6]',
    text: 'text-apple-subtextAlt',
    dot: 'bg-apple-statusPending',
    bar: 'bg-apple-statusPending'
  },
  skipped: {
    label: '已跳过',
    chip: 'bg-[#F0F0F2] text-apple-subtextAlt ring-[#E2E2E6]',
    text: 'text-apple-subtextAlt',
    dot: 'bg-[#A1A1AA]',
    bar: 'bg-[#A1A1AA]'
  },
  missing: {
    label: '文件缺失',
    chip: 'bg-[#FBF1E4] text-[#8A4B00] ring-[#F0D9BC]',
    text: 'text-[#8A4B00]',
    dot: 'bg-[#C77700]',
    bar: 'bg-[#DDA45C]'
  },
  empty: {
    label: '无产物',
    chip: 'bg-[#F0F0F2] text-apple-subtextAlt ring-[#E2E2E6]',
    text: 'text-apple-subtextAlt',
    dot: 'bg-[#C7C7CC]',
    bar: 'bg-[#D8D8DD]'
  }
}

const NEUTRAL: Tone = {
  label: '无数据',
  chip: 'bg-[#F0F0F2] text-apple-subtextAlt ring-[#E2E2E6]',
  text: 'text-apple-subtextAlt',
  dot: 'bg-[#C7C7CC]',
  bar: 'bg-[#D8D8DD]'
}

export function toneOf(status: string | null | undefined): Tone {
  return (status && TONES[status]) || NEUTRAL
}

export function StatusPill({ status }: { status: string | null | undefined }) {
  const tone = toneOf(status)
  return (
    <span className={`inline-flex items-center gap-1.5 text-[11px] font-medium leading-4 ${tone.text}`}>
      <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`} />
      {status ? tone.label : '—'}
    </span>
  )
}

export function text(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (typeof value === 'string') return value
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '—'
  if (Array.isArray(value)) return value.length ? value.map(text).join(' · ') : '—'
  try {
    return JSON.stringify(value)
  } catch {
    return '—'
  }
}

export function boolText(value: boolean | null): string {
  if (value === null) return '—'
  return value ? '是' : '否'
}

export function formatMs(ms: number | null): string {
  if (ms === null) return '—'
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`
}

export function formatTime(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return `${formatFullStamp(value)}:${String(date.getSeconds()).padStart(2, '0')}`
}

export function clockOf(ms: number | null): string {
  return formatClockMs(ms)
}

export function stageName(key: string): string {
  return `${key} · ${STAGE_LABEL[key] ?? '未命名环节'}`
}

export function stageDisplayStatus(stage: FlowStage): string | null {
  const recorded = (stage.artifacts ?? []).filter((a) => Boolean(a.path))
  if (stage.status === 'done' && recorded.length > 0 && recorded.every((a) => !a.exists)) return 'missing'
  if (stage.status === 'done' && recorded.length === 0) return 'empty'
  return stage.status
}

export function missingCountOf(stage: FlowStage): number {
  return (stage.artifacts ?? []).filter((a) => Boolean(a.path) && !a.exists).length
}

export function focusStageIndex(stages: FlowJob['stages']): number {
  const running = stages.findIndex((stage) => stage.status === 'running')
  if (running >= 0) return running
  const failed = stages.findIndex((stage) => stage.status === 'failed')
  if (failed >= 0) return failed
  return Math.max(0, stages.length - 1)
}

export function nested(value: unknown, ...path: string[]): unknown {
  let cursor: unknown = value
  for (const key of path) {
    if (!cursor || typeof cursor !== 'object') return null
    cursor = (cursor as Record<string, unknown>)[key]
  }
  return cursor ?? null
}

export function fileBase(p: string): string {
  const parts = p.split('/')
  return parts[parts.length - 1] || p
}

export function Section({
  title,
  hint,
  action,
  children,
  testId
}: {
  title: string
  hint?: ReactNode
  action?: ReactNode
  children: ReactNode
  testId?: string
}) {
  return (
    <section className="card p-4" data-testid={testId}>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-[13px] font-semibold leading-5">{title}</h2>
        <div className="flex items-center gap-2 text-[10px] leading-4 text-apple-subtext">
          {hint}
          {action}
        </div>
      </div>
      {children}
    </section>
  )
}

export function Stat({
  label,
  value,
  note,
  accent
}: {
  label: string
  value: ReactNode
  note: string
  accent?: string
}) {
  return (
    <div className="card relative flex h-full min-w-0 flex-col overflow-hidden p-4" data-stat={label}>
      <span
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-[3px]"
        style={{ backgroundColor: accent ?? 'rgba(29,29,31,0.10)' }}
      />
      <p className="label">{label}</p>
      <p className="num mt-2 text-[24px] font-semibold leading-none tracking-[-0.02em]">{value}</p>
      <p className="mt-auto truncate pt-2 text-[11px] leading-4 text-apple-subtext" title={note}>
        {note}
      </p>
    </div>
  )
}

export function Kv({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="space-y-1 text-[11px] leading-5">
      {rows.map(([key, value]) => (
        <div key={key} className="flex items-start justify-between gap-3">
          <dt className="shrink-0 text-apple-subtext">{key}</dt>
          <dd className="min-w-0 break-words text-right">{value}</dd>
        </div>
      ))}
    </dl>
  )
}
