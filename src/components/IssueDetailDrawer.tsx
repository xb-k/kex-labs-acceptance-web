import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { getJson, HttpError, postJson } from '../api'
import { validateComment } from '../issue-markdown'
import type { IssueDetailResponse, IssueCommentResponse, IssueItem, IssueLabel } from '../types'
import { IssueMarkdown } from './IssueMarkdown'
import { Close, ExternalLink, Refresh } from './icons'

type LoadState =
  | { status: 'loading'; data: null; error: null }
  | { status: 'ready'; data: IssueDetailResponse; error: null }
  | { status: 'error'; data: null; error: string }

const STATUS_META: Record<'open' | 'closed', { label: string; className: string; dot: string }> = {
  open: {
    label: 'Open',
    className: 'bg-[#E9F1ED] text-[#1E7A3C] ring-[#CDE5D6]',
    dot: 'bg-[#30A14E]'
  },
  closed: {
    label: 'Closed',
    className: 'bg-black/[0.04] text-apple-subtextAlt ring-black/[0.07]',
    dot: 'bg-[#8E8E93]'
  }
}

function stamp(value: string | null): string {
  if (!value) return '无数据'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', { hour12: false })
}

function hexColor(color: string): string | null {
  const value = color.trim().replace(/^#/, '')
  return /^[0-9a-f]{6}$/i.test(value) ? `#${value}` : null
}

function LabelChip({ label }: { label: IssueLabel }) {
  const hex = hexColor(label.color)
  return (
    <span
      className="inline-flex max-w-full items-center gap-1 rounded-md bg-black/[0.03] px-1.5 py-0.5 text-[11px] font-medium text-apple-text ring-1 ring-inset ring-black/[0.08]"
      title={label.name}
      style={hex ? { boxShadow: `inset 0 0 0 1px ${hex}33` } : undefined}
    >
      <span
        aria-hidden="true"
        className="h-1.5 w-1.5 shrink-0 rounded-full bg-apple-statusPending"
        style={hex ? { backgroundColor: hex } : undefined}
      />
      <span className="truncate">{label.name}</span>
    </span>
  )
}

function writeErrorText(err: unknown): string {
  if (err instanceof HttpError) {
    if (err.status === 401) return '写入鉴权失败（401）：请刷新页面后重试。'
    if (err.status === 403) return '没有写入权限（403）：只允许本站页面或有效 token。'
    if (err.status === 503) return '服务端未配置写入凭据（503），暂时不能回复。'
    if (err.status === 404) return 'issue 不存在（404），可能已被删除。'
    return err.message || `提交失败（HTTP ${err.status}）`
  }
  if (err instanceof TypeError) return '网络不可达：检查连接后重试。'
  return err instanceof Error ? err.message : '提交失败'
}

function CommentItem({ comment }: { comment: IssueDetailResponse['comments'][number] }) {
  const author = comment.author ?? '未知作者'
  return (
    <li className="border-t border-apple-line/70 py-3 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className="text-[12px] font-medium text-apple-text">{author}</span>
        <span className="num text-[11px] text-apple-subtext" title={stamp(comment.updated_at)}>
          {stamp(comment.created_at)}
        </span>
      </div>
      <div className="mt-1.5">
        <IssueMarkdown source={comment.body} />
      </div>
    </li>
  )
}

export function IssueDetailDrawer({
  issueNumber,
  returnFocus,
  onClose,
  onCommented
}: {
  issueNumber: number | null
  returnFocus: HTMLElement | null
  onClose: () => void
  onCommented?: () => void
}) {
  const open = issueNumber !== null
  const titleId = useId()
  const descId = useId()
  const panelRef = useRef<HTMLDivElement | null>(null)
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const [state, setState] = useState<LoadState>({ status: 'loading', data: null, error: null })
  const [nonce, setNonce] = useState(0)
  const [reply, setReply] = useState('')
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const retry = useCallback(() => setNonce((value) => value + 1), [])

  // Load (or silently refresh) the detail. Keeping the old ready data while a
  // refresh is in flight avoids flashing the skeleton after posting.
  useEffect(() => {
    if (issueNumber === null) return
    const ac = new AbortController()
    setState((prev) =>
      prev.status === 'ready' && prev.data.item.number === issueNumber
        ? prev
        : { status: 'loading', data: null, error: null }
    )
    getJson<IssueDetailResponse>(`/api/issues/${issueNumber}`, ac.signal)
      .then((data) => setState({ status: 'ready', data, error: null }))
      .catch((err: unknown) => {
        if (ac.signal.aborted) return
        setState({
          status: 'error',
          data: null,
          error: err instanceof Error ? err.message : '请求失败'
        })
      })
    return () => ac.abort()
  }, [issueNumber, nonce])

  useEffect(() => {
    if (!open) return
    setReply('')
    setSubmitError(null)
    setNotice('')
    setSubmitting(false)
    closeRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
        return
      }
      if (event.key !== 'Tab' || !panelRef.current) return
      const nodes = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
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
      returnFocus?.focus()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const submit = async () => {
    if (issueNumber === null || submitting) return
    const validated = validateComment(reply)
    if (!validated.ok) {
      setSubmitError(validated.error)
      return
    }
    setSubmitting(true)
    setSubmitError(null)
    setNotice('')
    try {
      const res = await postJson<IssueCommentResponse>(
        `/api/issues/${issueNumber}/comments`,
        { body: validated.body }
      )
      setState((prev) => {
        if (prev.status !== 'ready') return prev
        const next: IssueItem = { ...prev.data.item, comments: prev.data.item.comments + 1 }
        return {
          status: 'ready',
          data: { ...prev.data, item: next, comments: [...prev.data.comments, res.comment] },
          error: null
        }
      })
      setReply('')
      setNotice('回复已发布')
      onCommented?.()
      // Re-read so a server-side change (other comments, edited body) converges.
      setNonce((value) => value + 1)
    } catch (err) {
      setSubmitError(writeErrorText(err))
    } finally {
      setSubmitting(false)
    }
  }

  if (!open) return null

  const item = state.status === 'ready' ? state.data.item : null
  const status = item?.status ?? 'open'
  const meta = STATUS_META[status]
  const comments = state.status === 'ready' ? state.data.comments : []
  const replyLength = reply.trim().length

  return createPortal(
    <div
      className="dialog-overlay fixed inset-0 z-[70] bg-black/25 backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        data-testid="issue-drawer"
        className="drawer-panel fixed inset-x-0 bottom-0 flex max-h-[92dvh] flex-col overflow-hidden rounded-t-[20px] border border-black/[0.08] bg-white shadow-lift sm:inset-y-0 sm:left-auto sm:right-0 sm:h-[100dvh] sm:max-h-none sm:w-[560px] sm:max-w-[92vw] sm:rounded-none sm:border-y-0 sm:border-r-0"
      >
        <div className="flex items-start justify-between gap-3 border-b border-apple-line px-5 py-4">
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-2 text-[11px] text-apple-subtext">
              <span className="num font-medium text-apple-blueInk">#{issueNumber}</span>
              <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium ring-1 ring-inset ${meta.className}`}>
                <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
                {meta.label}
              </span>
              {item && <span className="num">{item.comments} 条评论</span>}
            </p>
            <h2 id={titleId} className="mt-1 break-words text-[17px] font-semibold leading-snug tracking-[-0.01em]">
              {item?.title ?? '加载 issue…'}
            </h2>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {item?.url && (
              <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-[11px] font-medium text-apple-subtext transition-colors hover:bg-black/[0.03] hover:text-apple-text focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
                title="在 Gitea 打开"
              >
                Gitea
                <ExternalLink className="h-3 w-3" aria-hidden="true" />
              </a>
            )}
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              aria-label="关闭详情"
              className="inline-flex h-8 w-8 items-center justify-center rounded-full text-apple-subtext transition-colors hover:bg-black/[0.04] hover:text-apple-text focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
            >
              <Close className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">
          {state.status === 'loading' && (
            <div className="space-y-2.5" aria-busy="true" aria-label="加载 issue 详情">
              {[0, 1, 2].map((index) => (
                <div key={index} className="h-4 w-full animate-pulse rounded bg-black/[0.05]" />
              ))}
            </div>
          )}

          {state.status === 'error' && (
            <div className="rounded-card border border-black/[0.06] p-4">
              <p className="text-sm font-medium text-apple-text">issue 详情不可用</p>
              <p className="mt-1 break-words text-xs leading-relaxed text-apple-subtext">{state.error}</p>
              <button
                type="button"
                onClick={retry}
                className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-full border border-black/[0.1] px-3 text-xs font-medium transition-colors hover:bg-black/[0.03] focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
              >
                <Refresh className="h-3.5 w-3.5" />
                重试
              </button>
            </div>
          )}

          {state.status === 'ready' && item && (
            <>
              <dl id={descId} className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1.5 text-[11px] leading-5">
                <dt className="text-apple-subtext">作者</dt>
                <dd className="min-w-0 break-words font-medium">{item.author ?? '未知'}</dd>
                <dt className="text-apple-subtext">创建</dt>
                <dd className="num">{stamp(item.created_at)}</dd>
                <dt className="text-apple-subtext">更新</dt>
                <dd className="num">{stamp(item.updated_at)}</dd>
                {item.labels.length > 0 && (
                  <>
                    <dt className="text-apple-subtext">标签</dt>
                    <dd className="flex min-w-0 flex-wrap gap-1.5">
                      {item.labels.map((label) => (
                        <LabelChip key={label.name} label={label} />
                      ))}
                    </dd>
                  </>
                )}
              </dl>

              <section className="mt-4 rounded-card border border-black/[0.06] bg-apple-bg/60 p-4">
                <h3 className="sr-only">正文</h3>
                <IssueMarkdown source={item.description} />
              </section>

              <section className="mt-5">
                <h3 className="flex items-baseline justify-between gap-3 text-[13px] font-semibold">
                  回复
                  <span className="num text-[11px] font-normal text-apple-subtext">{comments.length}</span>
                </h3>
                <ul data-testid="issue-comments" className="mt-2">
                  {comments.length === 0 ? (
                    <li className="rounded-card border border-dashed border-black/[0.1] px-4 py-5 text-center text-[12px] text-apple-subtext">
                      暂无回复
                    </li>
                  ) : (
                    comments.map((comment) => <CommentItem key={comment.id} comment={comment} />)
                  )}
                </ul>
              </section>

              <section className="mt-5 border-t border-apple-line pt-4">
                <label htmlFor={`${titleId}-reply`} className="text-[13px] font-semibold">
                  写回复
                </label>
                <textarea
                  id={`${titleId}-reply`}
                  data-testid="issue-reply"
                  value={reply}
                  onChange={(event) => {
                    setReply(event.target.value)
                    if (submitError) setSubmitError(null)
                    if (notice) setNotice('')
                  }}
                  onKeyDown={(event) => {
                    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                      event.preventDefault()
                      void submit()
                    }
                  }}
                  disabled={submitting}
                  rows={4}
                  maxLength={8000}
                  placeholder="写下你的回复…（⌘/Ctrl + Enter 提交）"
                  className="mt-1.5 w-full resize-y rounded-lg border border-apple-line bg-white px-3 py-2.5 text-[13px] leading-relaxed text-apple-text placeholder:text-apple-subtextAlt focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50 disabled:bg-black/[0.02] disabled:text-apple-subtext"
                />
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[11px] text-apple-subtext" role={submitError ? 'alert' : undefined}>
                    {submitError ? (
                      <span className="text-apple-red">{submitError}</span>
                    ) : notice ? (
                      <span className="text-[#1E7A3C]">{notice}</span>
                    ) : (
                      `${replyLength} / 8000`
                    )}
                  </p>
                  <div className="flex items-center gap-2">
                    {replyLength > 0 && !submitting && (
                      <button
                        type="button"
                        onClick={() => {
                          setReply('')
                          setSubmitError(null)
                          setNotice('')
                        }}
                        className="inline-flex h-8 items-center rounded-lg px-2.5 text-xs font-medium text-apple-subtext transition-colors hover:bg-black/[0.03] hover:text-apple-text focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
                      >
                        清空
                      </button>
                    )}
                    <button
                      type="button"
                      data-testid="issue-submit"
                      onClick={() => void submit()}
                      disabled={submitting || replyLength === 0}
                      className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-apple-blue px-3.5 text-xs font-medium text-white transition-colors hover:bg-[#0062C4] focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50 disabled:cursor-not-allowed disabled:bg-apple-blue/40"
                    >
                      {submitting ? '发布中…' : '发布回复'}
                    </button>
                  </div>
                </div>
              </section>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
