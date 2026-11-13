import type { GateStatus } from '../types'
import { Check, Cross, Minus } from './icons'

const styles: Record<GateStatus, { dot: string; text: string }> = {
  PASS: { dot: 'bg-apple-statusDone', text: 'text-[#1E7A3C]' },
  CONDITIONAL: { dot: 'bg-[#C77700]', text: 'text-apple-amber' },
  FAIL: { dot: 'bg-apple-red', text: 'text-[#B3261E]' },
  UNKNOWN: { dot: 'bg-apple-subtext', text: 'text-apple-subtextAlt' }
}

export function StatusChip({ status, label }: { status: GateStatus; label: string }) {
  const s = styles[status]
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${s.text}`}>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${s.dot}`} aria-hidden="true" />
      {label}
    </span>
  )
}

export function ResultMark({ pass, className = '' }: { pass: boolean | null; className?: string }) {
  if (pass === true) {
    return (
      <span className={`inline-flex items-center gap-1 text-xs font-medium text-[#1E7A3C] ${className}`}>
        <span className="grid h-5 w-5 place-items-center rounded-full bg-[#EAF8EE]">
          <Check className="h-3.5 w-3.5" />
        </span>
        通过
      </span>
    )
  }
  if (pass === false) {
    return (
      <span className={`inline-flex items-center gap-1 text-xs font-medium text-[#B3261E] ${className}`}>
        <span className="grid h-5 w-5 place-items-center rounded-full bg-[#FCEDEB]">
          <Cross className="h-3.5 w-3.5" />
        </span>
        未通过
      </span>
    )
  }
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium text-apple-subtext ${className}`}>
      <span className="grid h-5 w-5 place-items-center rounded-full bg-[#F0F0F2]">
        <Minus className="h-3.5 w-3.5" />
      </span>
      仅报数
    </span>
  )
}
