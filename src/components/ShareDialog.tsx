import { useEffect, useId, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { createPortal } from 'react-dom'
import { HttpError, postJson } from '../api'
import { Check, Close } from './icons'

type ShareCreated = {
  token: string
  url: string
  path: string
  name: string
  expiresAt: string
}

function ShareIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden className={className}>
      <path
        d="M10 3v9m0-9 3 3m-3-3L7 6M5 10.5V15a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 15 15v-4.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function stamp(value: string | null): string {
  if (!value) return '无数据'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 401 → 需要 token；403 → 同源限制；其余原样显示服务端文案。 */
function errorText(err: unknown): string {
  if (err instanceof HttpError) {
    if (err.status === 401) return `需要写入令牌（401）：${err.message}。请在服务端配置 WEB_WRITE_TOKEN 后重试。`
    if (err.status === 403) return `同源限制（403）：${err.message}。请从本站页面发起分享。`
    return err.message
  }
  return err instanceof Error ? err.message : '分享失败，请稍后重试。'
}

export function ShareButton({
  path,
  name,
  open: controlledOpen,
  onOpenChange,
  hideTrigger = false,
  returnFocusRef
}: {
  path: string
  name: string
  /** 受控开关：由外层（如交付页「…」菜单）驱动时传入。 */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** 外部已提供菜单项时，不再渲染自带触发按钮。 */
  hideTrigger?: boolean
  /** 关闭后把焦点还给的元素（默认是自带触发按钮）。 */
  returnFocusRef?: RefObject<HTMLElement>
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const open = controlledOpen ?? uncontrolledOpen
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setUncontrolledOpen(next)
    onOpenChange?.(next)
  }
  const [closing, setClosing] = useState(false)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [created, setCreated] = useState<ShareCreated | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [noticeTone, setNoticeTone] = useState<'info' | 'warn'>('info')
  const [retryNonce, setRetryNonce] = useState(0)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const linkRef = useRef<HTMLInputElement>(null)
  const titleId = useId()
  const descId = useId()

  const close = () => {
    if (closing) return
    setClosing(true)
    window.setTimeout(() => {
      setOpen(false)
      setClosing(false)
      ;(returnFocusRef ?? triggerRef).current?.focus()
    }, 140)
  }

  useEffect(() => {
    if (!open) return
    setPhase('loading')
    setCreated(null)
    setError(null)
    setNotice(null)
    let alive = true
    postJson<ShareCreated>('/api/share', { path, name })
      .then((res) => {
        if (!alive) return
        setCreated(res)
        setPhase('ready')
      })
      .catch((err: unknown) => {
        if (!alive) return
        setError(errorText(err))
        setPhase('error')
      })
    return () => {
      alive = false
    }
  }, [open, path, name, retryNonce])

  useEffect(() => {
    if (!open) return
    closeRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        close()
        return
      }
      if (event.key !== 'Tab' || !panelRef.current) return
      const nodes = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input, a[href], [tabindex]:not([tabindex="-1"])'
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, closing])

  const fullUrl = created ? `${window.location.origin}${created.url}` : ''

  const copy = async () => {
    if (!created) return
    try {
      await navigator.clipboard.writeText(fullUrl)
      setNoticeTone('info')
      setNotice('已复制到剪贴板')
    } catch {
      setNoticeTone('warn')
      setNotice('浏览器不允许自动复制，已选中链接，请按 ⌘C / Ctrl+C 手动复制。')
      linkRef.current?.focus()
      linkRef.current?.select()
    }
  }

  return (
    <>
      {!hideTrigger && (
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen(true)}
          data-testid="share-button"
          className="press inline-flex h-8 items-center gap-1.5 rounded-lg bg-apple-bg px-2.5 text-xs font-medium text-apple-text transition-colors hover:bg-[#ECECEF] focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
        >
          <ShareIcon className="h-3.5 w-3.5" />
          分享
        </button>
      )}

      {open &&
        createPortal(
          <div
          className={`fixed inset-0 z-[60] flex items-end justify-center bg-apple-text/30 backdrop-blur-[2px] sm:items-center sm:p-4 ${
            closing ? 'dialog-overlay-closing' : 'dialog-overlay'
          }`}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) close()
          }}
        >
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={descId}
            data-testid="share-dialog"
            className={`flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-[20px] border border-black/[0.08] bg-white shadow-lift sm:max-h-[90dvh] sm:max-w-[460px] sm:rounded-card ${
              closing ? 'dialog-panel-closing' : 'dialog-panel'
            }`}
          >
            <div className="flex items-start justify-between gap-3 border-b border-black/[0.06] px-5 py-4">
              <div className="min-w-0">
                <h2 id={titleId} className="text-[17px] font-semibold tracking-[-0.01em]">
                  分享交付
                </h2>
                <p id={descId} className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-apple-subtext" title={name}>
                  {name}
                </p>
              </div>
              <button
                ref={closeRef}
                type="button"
                onClick={close}
                aria-label="关闭"
                className="-mr-1 grid h-9 w-9 shrink-0 place-items-center rounded-full text-apple-subtext transition-colors hover:bg-black/[0.04] focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
              >
                <Close className="h-[18px] w-[18px]" />
              </button>
            </div>

            <div className="space-y-4 px-5 py-4">
              {phase === 'loading' && (
                <div aria-busy="true" className="space-y-2.5">
                  <p className="text-xs text-apple-subtext">正在生成分享链接…</p>
                  <div className="h-9 animate-pulse rounded-lg bg-apple-bg" />
                  <div className="h-4 w-2/3 animate-pulse rounded bg-apple-bg" />
                </div>
              )}

              {phase === 'error' && (
                <div role="alert" data-testid="share-error" className="space-y-3">
                  <p className="rounded-lg bg-[#FCEDEB] px-3 py-2 text-xs leading-relaxed text-[#B3261E] ring-1 ring-inset ring-[#F3D3CF]">
                    {error}
                  </p>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setRetryNonce((n) => n + 1)}
                      className="press inline-flex h-8 items-center rounded-lg bg-apple-text px-3 text-xs font-medium text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
                    >
                      重试
                    </button>
                    <button
                      type="button"
                      onClick={close}
                      className="press inline-flex h-8 items-center rounded-lg bg-apple-bg px-3 text-xs font-medium text-apple-text focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
                    >
                      关闭
                    </button>
                  </div>
                </div>
              )}

              {phase === 'ready' && created && (
                <>
                  <div>
                    <label htmlFor={`${titleId}-link`} className="text-[11px] font-medium text-apple-subtext">
                      分享链接
                    </label>
                    <input
                      ref={linkRef}
                      id={`${titleId}-link`}
                      data-testid="share-link"
                      readOnly
                      value={fullUrl}
                      onFocus={(event) => event.currentTarget.select()}
                      aria-describedby={descId}
                      className="mt-1.5 w-full rounded-lg border border-apple-line bg-apple-bg px-3 py-2 text-xs text-apple-text focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
                    />
                  </div>

                  <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-[11px] leading-5">
                    <dt className="text-apple-subtext">过期时间</dt>
                    <dd className="num font-medium">{stamp(created.expiresAt)}</dd>
                    <dt className="text-apple-subtext">文件</dt>
                    <dd className="num break-all text-apple-subtext">{created.path}</dd>
                  </dl>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={copy}
                      data-testid="share-copy"
                      className="press inline-flex h-8 items-center gap-1.5 rounded-lg bg-apple-blue px-3 text-xs font-medium text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
                    >
                      <Check className="h-3.5 w-3.5" />
                      复制链接
                    </button>
                    <button
                      type="button"
                      onClick={close}
                      className="press inline-flex h-8 items-center rounded-lg bg-apple-bg px-3 text-xs font-medium text-apple-text transition-colors hover:bg-[#ECECEF] focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
                    >
                      完成
                    </button>
                  </div>

                  {notice && (
                    <p
                      role="status"
                      aria-live="polite"
                      className={`text-[11px] leading-relaxed ${
                        noticeTone === 'warn' ? 'text-[#8A4B00]' : 'text-apple-subtext'
                      }`}
                    >
                      {notice}
                    </p>
                  )}
                </>
              )}
            </div>
          </div>
        </div>,
          document.body
        )}
    </>
  )
}
