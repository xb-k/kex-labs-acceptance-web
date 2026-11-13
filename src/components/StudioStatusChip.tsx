import type { StudioJobStatus } from '../types'

const STATUS: Record<
  StudioJobStatus,
  { label: string; dot: string; text: string }
> = {
  queued: {
    label: '排队中',
    dot: 'bg-[#8E8E93]',
    text: 'text-apple-subtextAlt'
  },
  running: {
    label: '生成中',
    dot: 'bg-apple-statusRunning',
    text: 'text-apple-blueInk'
  },
  succeeded: {
    label: '已完成',
    dot: 'bg-apple-statusDone',
    text: 'text-[#1E7A3C]'
  },
  failed: {
    label: '失败',
    dot: 'bg-apple-red',
    text: 'text-[#B3261E]'
  },
  canceled: {
    label: '已取消',
    dot: 'bg-[#B0A698]',
    text: 'text-[#6B6257]'
  }
}

export function StudioStatusChip({ status }: { status: StudioJobStatus }) {
  const s = STATUS[status]
  return (
    <span className={`inline-flex items-center gap-1.5 text-[11px] font-medium ${s.text}`}>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${s.dot}`} aria-hidden="true" />
      {s.label}
    </span>
  )
}
