import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { HttpError } from '../api'
import type { RiskAction } from '../types'
import { Close } from './icons'

const ACTIONS: readonly RiskAction[] = ['同意了继续', '暂停等开发', '改期', '接受风险（已知）']
const NOTE_REQUIRED: readonly RiskAction[] = ['暂停等开发', '改期']
const ACTOR_MAX = 40
const NOTE_MAX = 500
const ACTOR_STORAGE_KEY = 'acceptance.risk.actor'

function readSavedActor(): string {
  try {
    return window.localStorage.getItem(ACTOR_STORAGE_KEY) ?? ''
  } catch {
    return ''
  }
}

function saveActor(actor: string): void {
  try {
    window.localStorage.setItem(ACTOR_STORAGE_KEY, actor)
  } catch {
    /* localStorage 不可用（隐私模式）时静默降级 */
  }
}

function errorText(err: unknown): string {
  if (err instanceof HttpError) {
    if (err.status === 400) return err.message || '输入不合法（400），请检查操作者与备注。'
    if (err.status === 401) return '写入鉴权失败（401）：请刷新页面后重试。'
    if (err.status === 403) return '没有写入权限（403）：只允许本站页面或有效 token。'
    if (err.status === 404) return '任务不存在（404），可能已从计划中移除。'
    if (err.status === 409) return err.message || '该任务未关联 Gitea issue。'
    if (err.status === 502) return err.message || '通知开发失败（502），本次未落库。'
    if (err.status === 503) return err.message || '服务暂不可用（503），本次未落库。'
    return err.message || `提交失败（HTTP ${err.status}）`
  }
  if (err instanceof TypeError) return '网络不可达：检查连接后重试。'
  return err instanceof Error ? err.message : '提交失败'
}

const inputClass =
  'h-10 w-full rounded-[10px] border border-black/[0.1] bg-white px-3 text-sm text-apple-text transition-colors placeholder:text-apple-subtext/70 focus:border-apple-blue focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/25'

export function RiskDecisionDialog({
  open,
  taskId,
  taskTitle,
  onClose,
  onSubmit
}: {
  open: boolean
  taskId: string | null
  taskTitle: string
  onClose: () => void
  onSubmit: (input: { task_id: string; action: RiskAction; actor: string; note: string }) => Promise<void>
}) {
  const titleId = useId()
  const descId = useId()
  const panelRef = useRef<HTMLDivElement | null>(null)
  const firstRef = useRef<HTMLButtonElement | null>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const [action, setAction] = useState<RiskAction>('同意了继续')
  const [actor, setActor] = useState('')
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setAction('同意了继续')
    setActor(readSavedActor())
    setNote('')
    setSubmitting(false)
    setError(null)
    const timer = window.setTimeout(() => firstRef.current?.focus(), 30)
    return () => {
      window.clearTimeout(timer)
      returnFocus.current?.focus()
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        if (!submitting) onClose()
        return
      }
      if (event.key !== 'Tab' || !panelRef.current) return
      const nodes = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(
          'input, textarea, button:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((node) => node.offsetParent !== null)
      if (nodes.length === 0) return
      const first = nodes[0]
      const last = nodes[nodes.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey, true)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.body.style.overflow = previousOverflow
    }
  }, [open, submitting, onClose])

  if (!open || !taskId) return null

  const noteRequired = NOTE_REQUIRED.includes(action)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (submitting) return
    const name = actor.trim()
    if (!name) {
      setError('操作者必填（1~40 字）。')
      return
    }
    if (name.length > ACTOR_MAX) {
      setError(`操作者最多 ${ACTOR_MAX} 字。`)
      return
    }
    const text = note.trim()
    if (text.length > NOTE_MAX) {
      setError(`备注最多 ${NOTE_MAX} 字。`)
      return
    }
    if (noteRequired && !text) {
      setError(`「${action}」必须填写备注。`)
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await onSubmit({ task_id: taskId, action, actor: name, note: text })
      saveActor(name)
      setSubmitting(false)
      onClose()
    } catch (err) {
      setError(errorText(err))
      setSubmitting(false)
    }
  }

  return (
    <div
      className="dialog-overlay fixed inset-0 z-[60] flex items-end justify-center bg-apple-text/25 p-0 backdrop-blur-[2px] sm:items-center sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !submitting) onClose()
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        className="dialog-panel flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-[20px] border border-black/[0.08] bg-white shadow-lift sm:max-h-[90dvh] sm:max-w-[520px] sm:rounded-card"
      >
        <div className="flex items-start justify-between gap-3 border-b border-black/[0.06] px-5 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-[17px] font-semibold tracking-[-0.01em]">
              处置风险
            </h2>
            <p id={descId} className="mt-0.5 break-words text-xs leading-relaxed text-apple-subtext">
              <span className="num font-medium text-apple-text">{taskId}</span> · {taskTitle}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            aria-label="关闭"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-black/[0.1] text-apple-subtext transition-colors hover:bg-black/[0.03] focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50 disabled:opacity-50"
          >
            <Close className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
            <fieldset>
              <legend className="text-[12px] font-medium text-apple-text">动作</legend>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {ACTIONS.map((option, index) => {
                  const checked = action === option
                  return (
                    <button
                      key={option}
                      ref={index === 0 ? firstRef : undefined}
                      type="button"
                      role="radio"
                      aria-checked={checked}
                      onClick={() => {
                        setAction(option)
                        setError(null)
                      }}
                      className={`flex min-h-[44px] items-center gap-2 rounded-[12px] border px-3 py-2 text-left text-[13px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50 ${
                        checked
                          ? 'border-apple-blue bg-apple-blue/[0.06] text-apple-text'
                          : 'border-black/[0.1] text-apple-text hover:bg-black/[0.03]'
                      }`}
                    >
                      <span
                        aria-hidden="true"
                        className={`h-3.5 w-3.5 shrink-0 rounded-full border ${
                          checked ? 'border-apple-blue bg-apple-blue' : 'border-black/20 bg-white'
                        }`}
                      />
                      {option}
                    </button>
                  )
                })}
              </div>
            </fieldset>

            <div>
              <label htmlFor="risk-actor" className="text-[12px] font-medium text-apple-text">
                操作者
              </label>
              <input
                id="risk-actor"
                value={actor}
                onChange={(event) => setActor(event.target.value)}
                maxLength={ACTOR_MAX}
                disabled={submitting}
                placeholder="你的名字（1~40 字）"
                className={`mt-1.5 ${inputClass}`}
              />
            </div>

            <div>
              <div className="flex items-baseline justify-between gap-2">
                <label htmlFor="risk-note" className="text-[12px] font-medium text-apple-text">
                  备注{noteRequired && <span className="ml-1 text-[#B3261E]">必填</span>}
                </label>
                <span className="num text-[11px] text-apple-subtext">
                  {note.length}/{NOTE_MAX}
                </span>
              </div>
              <textarea
                id="risk-note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                maxLength={NOTE_MAX}
                disabled={submitting}
                rows={3}
                placeholder={noteRequired ? '说明原因，开发需要据此执行' : '可选：补充上下文'}
                className={`mt-1.5 min-h-[88px] w-full resize-y rounded-[10px] border border-black/[0.1] bg-white px-3 py-2 text-sm leading-relaxed text-apple-text transition-colors placeholder:text-apple-subtext/70 focus:border-apple-blue focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/25`}
              />
            </div>

            {error && (
              <p
                role="alert"
                className="rounded-lg bg-[#FFF4E5] px-3 py-2 text-xs leading-relaxed text-[#8A4B00] ring-1 ring-inset ring-[#F0D9BC]"
              >
                {error}
              </p>
            )}
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-black/[0.06] px-5 py-3.5">
            <span className="text-[11px] leading-relaxed text-apple-subtext">
              提交后会在 Gitea issue 下发评论
            </span>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={submitting}
                className="h-9 rounded-full border border-black/[0.1] px-4 text-[13px] font-medium text-apple-text transition-colors hover:bg-black/[0.03] focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50 disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={submitting}
                data-testid="risk-dispose-submit"
                className="h-9 rounded-full bg-apple-blue px-4 text-[13px] font-medium text-white transition-colors hover:bg-[#0062C4] focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting ? '提交中…' : '提交处置'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}
