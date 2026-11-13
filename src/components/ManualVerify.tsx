import { useEffect, useState } from 'react'
import { HttpError, setManualVerify } from '../api'
import type { ManualVerifyState, ManualVerifyView } from '../types'

export const MANUAL_VERIFY_META: Record<
  ManualVerifyState,
  { label: string; className: string; dot: string }
> = {
  pending: {
    label: '待验',
    className: 'bg-black/[0.03] text-apple-subtextAlt ring-black/[0.06]',
    dot: 'bg-[#8E8E93]'
  },
  pass: {
    label: '通过',
    className: 'bg-[#E9F1ED] text-[#1E7A3C] ring-[#CDE5D6]',
    dot: 'bg-[#30A14E]'
  },
  fail: {
    label: '不通过',
    className: 'bg-[#FCEDEB] text-[#B3261E] ring-[#F3D3CF]',
    dot: 'bg-[#E5484D]'
  }
}

export function ManualVerifyBadge({ state }: { state: ManualVerifyState }) {
  const meta = MANUAL_VERIFY_META[state]
  return (
    <span
      data-testid="manual-verify-badge"
      data-state={state}
      className={`inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset ${meta.className}`}
    >
      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
      {meta.label}
    </span>
  )
}

const BUTTONS: { state: ManualVerifyState; label: string }[] = [
  { state: 'pass', label: '通过' },
  { state: 'fail', label: '不通过' },
  { state: 'pending', label: '待验' }
]

const activeButton: Record<ManualVerifyState, string> = {
  pass: 'bg-[#1E7A3C] text-white hover:bg-[#196A33]',
  fail: 'bg-[#B3261E] text-white hover:bg-[#9A1F18]',
  pending: 'bg-apple-text text-white hover:bg-black'
}

function errorText(err: unknown): string {
  if (err instanceof HttpError) {
    if (err.status === 401) return `无写权限（401）：${err.message}`
    if (err.status === 403) return `写入被拒绝（403）：${err.message}`
    return `保存失败（${err.status}）：${err.message}`
  }
  return err instanceof Error ? err.message : '保存失败'
}

type Props = {
  verifyKey: string
  number: number
  state: ManualVerifyState
  note: string | null
  onSaved: (view: ManualVerifyView) => void
}

/** 「通过 / 不通过 / 待验」三态按钮 + 可选说明；错误态如实显示。 */
export function ManualVerifyControls({ verifyKey, number, state, note, onSaved }: Props) {
  const [draft, setDraft] = useState(note ?? '')
  const [busy, setBusy] = useState<ManualVerifyState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState('')

  useEffect(() => {
    setDraft(note ?? '')
    setError(null)
  }, [note, verifyKey])

  const submit = async (next: ManualVerifyState) => {
    setBusy(next)
    setError(null)
    setSaved('')
    try {
      const value = await setManualVerify(verifyKey, next, draft.trim() || null)
      setSaved(`已保存：#${number} ${MANUAL_VERIFY_META[value.state].label}`)
      onSaved(value)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="mt-3" onClick={(event) => event.stopPropagation()}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] text-apple-subtextAlt">人工验证</span>
        {BUTTONS.map((entry) => {
          const active = entry.state === state
          return (
            <button
              key={entry.state}
              type="button"
              data-testid={`manual-verify-${entry.state}`}
              aria-pressed={active}
              disabled={busy !== null}
              onClick={() => submit(entry.state)}
              className={`inline-flex h-7 items-center rounded-full px-2.5 text-[11px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50 disabled:cursor-wait disabled:opacity-60 ${
                active
                  ? activeButton[entry.state]
                  : 'border border-black/[0.1] text-apple-text hover:bg-black/[0.03]'
              }`}
            >
              {busy === entry.state ? '保存中…' : entry.label}
            </button>
          )
        })}
      </div>
      <input
        type="text"
        value={draft}
        data-testid="manual-verify-note"
        maxLength={500}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="验证说明（可选，≤500 字；通过时服务端不保存说明）"
        className="mt-2 h-8 w-full max-w-[560px] rounded-lg border border-black/[0.1] bg-white px-2.5 text-[12px] text-apple-text placeholder:text-apple-subtextAlt focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
      />
      {error && (
        <p role="alert" className="mt-1.5 text-[11px] leading-relaxed text-[#B3261E]">
          {error}
        </p>
      )}
      {saved && !error && (
        <p role="status" className="mt-1.5 text-[11px] leading-relaxed text-[#1E7A3C]">
          {saved}
        </p>
      )}
    </div>
  )
}

const TASK_META_RE = /^<!--\s*acceptance:task\s+\{.*\}\s*-->$/
const TASK_NOTE_RE = /^>\s*由 acceptance 看板自动维护/

/** Same rule as `taskBodySummary` on the server; never invents text. */
export function summarizeIssueBody(body: string | null | undefined): string | null {
  if (typeof body !== 'string' || !body.trim()) return null
  const lines = body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !TASK_META_RE.test(line) && !TASK_NOTE_RE.test(line) && !/^---+$/.test(line))
    .map((line) => line.replace(/^#+\s*/, ''))
  const text = lines.join(' ').replace(/\s+/g, ' ').trim()
  if (!text) return null
  return text.length > 240 ? `${text.slice(0, 240)}…` : text
}
