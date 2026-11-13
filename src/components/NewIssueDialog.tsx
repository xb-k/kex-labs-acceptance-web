import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { HttpError } from '../api'
import type { CreateIssueInput, IssueItem } from '../types'
import { Close } from './icons'

const TITLE_MAX = 120
const DESCRIPTION_MAX = 2000
const OWNER_MAX = 60

const RAIL_OPTIONS = [
  { value: '', label: '未指定' },
  { value: 'A', label: 'A 轨' },
  { value: 'B', label: 'B 轨' },
  { value: '双轨', label: '双轨' }
]

const PRIORITY_OPTIONS = ['P0', 'P1', 'P2', 'P3']

function errorText(err: unknown): string {
  if (err instanceof HttpError) {
    if (err.status === 401) return '写入需要令牌（401），当前页面没有可用的写入凭证。'
    if (err.status === 403) return '写入已关闭（403），当前服务不允许新建 issue。'
    if (err.status === 502) return 'Gitea 创建失败（502）：服务可达但写入被拒，请稍后重试。'
    if (err.status === 503) return 'Gitea 未配置或不可达（503）：请在服务端配置 GITEA_URL 与凭据。'
    return err.message
  }
  if (err instanceof Error) return err.message
  return '提交失败，请稍后重试。'
}

function Field({
  id,
  label,
  counter,
  children
}: {
  id: string
  label: string
  counter?: string
  children: ReactNode
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-[13px] font-medium text-apple-text">
          {label}
        </label>
        {counter && <span className="num text-[11px] text-apple-subtext">{counter}</span>}
      </div>
      <div className="mt-1.5">{children}</div>
    </div>
  )
}

const inputClass =
  'h-10 w-full rounded-[10px] border border-black/[0.1] bg-white px-3 text-sm text-apple-text transition-colors placeholder:text-apple-subtext/70 focus:border-apple-blue focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/25'

export function NewIssueDialog({
  open,
  onClose,
  create,
  onCreated,
  repo
}: {
  open: boolean
  onClose: () => void
  create: (input: CreateIssueInput) => Promise<IssueItem>
  onCreated: (item: IssueItem) => void
  repo?: string | null
}) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [owner, setOwner] = useState('')
  const [rail, setRail] = useState('')
  const [priority, setPriority] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mounted, setMounted] = useState(open)
  const [closing, setClosing] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setMounted(true)
      setClosing(false)
      return
    }
    if (!mounted) return
    setClosing(true)
    const timer = window.setTimeout(() => {
      setMounted(false)
      setClosing(false)
    }, 150)
    return () => window.clearTimeout(timer)
  }, [open, mounted])

  useEffect(() => {
    if (!open) return
    setTitle('')
    setDescription('')
    setOwner('')
    setRail('')
    setPriority('')
    setSubmitting(false)
    setError(null)
    titleRef.current?.focus()
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
          'input, textarea, select, button:not([disabled]), [tabindex]:not([tabindex="-1"])'
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

  if (!mounted) return null

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (submitting) return
    if (!title.trim()) {
      setError('标题必填，最多 120 字。')
      titleRef.current?.focus()
      return
    }
    if (title.trim().length > TITLE_MAX) {
      setError('标题最多 120 字。')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const item = await create({
        title: title.trim(),
        description: description.trim() || null,
        owner: owner.trim() || null,
        rail: rail || null,
        priority: priority || null
      })
      setSubmitting(false)
      onCreated(item)
    } catch (err) {
      setError(errorText(err))
      setSubmitting(false)
    }
  }

  return (
    <div
      className={`fixed inset-0 z-[60] flex items-end justify-center bg-apple-text/25 p-0 backdrop-blur-[2px] sm:items-center sm:p-6 ${
        closing ? 'dialog-overlay-closing' : 'dialog-overlay'
      }`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !submitting) onClose()
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-issue-title"
        className={`flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-[20px] border border-black/[0.08] bg-white shadow-lift sm:max-h-[90dvh] sm:max-w-[560px] sm:rounded-card ${
          closing ? 'dialog-panel-closing' : 'dialog-panel'
        }`}
      >
        <div className="flex items-start justify-between gap-3 border-b border-black/[0.06] px-5 py-4">
          <div className="min-w-0">
            <h2 id="new-issue-title" className="text-[17px] font-semibold tracking-[-0.01em]">
              新建 issue
            </h2>
            <p className="mt-0.5 text-xs leading-relaxed text-apple-subtext">
              创建到 Gitea · <span className="num">{repo ?? 'gitadmin/kex-labs-video'}</span>
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-apple-subtextAlt">
              负责人 / 轨道 / 优先级作为正文元数据写入，不再落到本地目录。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            aria-label="关闭"
            className="-mr-1 grid h-9 w-9 shrink-0 place-items-center rounded-full text-apple-subtext transition-colors hover:bg-black/[0.04] focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50 disabled:opacity-40"
          >
            <Close className="h-[18px] w-[18px]" />
          </button>
        </div>

        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
            <Field id="issue-title" label="标题" counter={`${title.length}/${TITLE_MAX}`}>
              <input
                ref={titleRef}
                id="issue-title"
                name="title"
                value={title}
                maxLength={TITLE_MAX}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="一句话说明要解决的问题"
                aria-required="true"
                className={inputClass}
              />
            </Field>

            <Field id="issue-description" label="描述" counter={`${description.length}/${DESCRIPTION_MAX}`}>
              <textarea
                id="issue-description"
                name="description"
                value={description}
                maxLength={DESCRIPTION_MAX}
                onChange={(event) => setDescription(event.target.value)}
                rows={4}
                placeholder="背景、期望结果、验收方式（可选）"
                className={`${inputClass} h-auto min-h-[96px] resize-y py-2 leading-relaxed`}
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-3">
              <Field id="issue-owner" label="负责人" counter={`${owner.length}/${OWNER_MAX}`}>
                <input
                  id="issue-owner"
                  name="owner"
                  value={owner}
                  maxLength={OWNER_MAX}
                  onChange={(event) => setOwner(event.target.value)}
                  placeholder="可选"
                  className={inputClass}
                />
              </Field>

              <Field id="issue-rail" label="轨道">
                <select
                  id="issue-rail"
                  name="rail"
                  value={rail}
                  onChange={(event) => setRail(event.target.value)}
                  className={`${inputClass} appearance-none pr-8`}
                >
                  {RAIL_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </Field>

              <Field id="issue-priority" label="优先级">
                <select
                  id="issue-priority"
                  name="priority"
                  value={priority}
                  onChange={(event) => setPriority(event.target.value)}
                  className={`${inputClass} appearance-none pr-8`}
                >
                  <option value="">未指定</option>
                  {PRIORITY_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </Field>
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
            <span className="text-[11px] text-apple-subtext">标题必填 · 最多 120 字</span>
            <div className="flex items-center gap-2">
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
                className="h-9 rounded-full bg-apple-blue px-4 text-[13px] font-medium text-white transition-colors hover:bg-[#0062C4] focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting ? '创建中…' : '创建 issue'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}
