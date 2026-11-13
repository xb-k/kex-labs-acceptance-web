import type { StudioJobStatus } from '../types'

const STATUS: Record<
  StudioJobStatus,
  { label: string; dot: string; bg: string; text: string; ring: string }
> = {
  queued: {
    label: '排队中',
    dot: 'bg-[#8E8E93]',
    bg: 'bg-[#F0F0F2]',
    text: 'text-apple-subtextAlt',
    ring: 'ring-[#E2E2E6]'
  },
  running: {
    label: '生成中',
    dot: 'bg-apple-statusRunning',
    bg: 'bg-[#EAF2FD]',
    text: 'text-apple-blueInk',
    ring: 'ring-[#CFE2FA]'
  },
  succeeded: {
    label: '已完成',
    dot: 'bg-apple-statusDone',
    bg: 'bg-[#EAF8EE]',
    text: 'text-[#1E7A3C]',
    ring: 'ring-[#CDEED6]'
  },
  failed: {
    label: '失败',
    dot: 'bg-apple-red',
    bg: 'bg-[#FCEDEB]',
    text: 'text-[#B3261E]',
    ring: 'ring-[#F3D3CF]'
  },
  canceled: {
    label: '已取消',
    dot: 'bg-[#B0A698]',
    bg: 'bg-[#F5F2ED]',
    text: 'text-[#6B6257]',
    ring: 'ring-[#E7E0D6]'
  }
}

export function StudioStatusChip({ status }: { status: StudioJobStatus }) {
  const s = STATUS[status]
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 ring-inset ${s.bg} ${s.text} ${s.ring}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} aria-hidden="true" />
      {s.label}
    </span>
  )
}
