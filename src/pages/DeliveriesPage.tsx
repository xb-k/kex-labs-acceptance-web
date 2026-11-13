import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode, RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { DeliveriesResponse, Delivery, DeliveryRepair, DeliveryTrashResponse } from '../types'
import { HttpError, deleteJson, useJson } from '../api'
import { Link } from '../router'
import { ChevronDown, Close, More, Play, Refresh, Share, Trash } from '../components/icons'
import { ShareButton } from '../components/ShareDialog'
import { formatDuration, formatResolution } from '../format'

function stamp(value: string | null): string {
  if (!value) return '无数据'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value.slice(0, 16).replace('T', ' ')
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function withDownload(url: string): string {
  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}download=1`
}

function gateTone(gate: string): string {
  if (gate.includes('有条件')) return 'bg-[#FFF4E5] text-apple-amber ring-[#F5DFC0]'
  if (gate.startsWith('FAIL')) return 'bg-[#FCEDEB] text-[#B3261E] ring-[#F3D3CF]'
  if (gate.startsWith('PASS')) return 'bg-[#EAF8EE] text-[#1E7A3C] ring-[#CDEED6]'
  return 'bg-[#F0F0F2] text-apple-subtextAlt ring-[#E2E2E6]'
}

function Cover({ sources, title }: { sources: string[]; title: string }) {
  const [index, setIndex] = useState(0)
  const src = sources[index]

  if (!src) {
    return (
      <div
        data-testid="delivery-cover-placeholder"
        className="flex h-full w-full flex-col items-center justify-center gap-1.5 bg-[#F0F0F2] text-apple-subtext"
      >
        <svg
          viewBox="0 0 32 32"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="h-[30px] w-[30px] text-[#86868B]"
        >
          <rect x="3.75" y="8.5" width="17.5" height="15" rx="3" />
          <path d="M21.25 13.75l5-2.75a.9.9 0 0 1 1.35.78v8.44a.9.9 0 0 1-1.35.78l-5-2.75" />
        </svg>
        <span className="text-[11px] font-medium">无封面</span>
      </div>
    )
  }


  return (
    <img
      src={src}
      alt={`${title} 封面`}
      data-testid="delivery-cover"
      data-source={src}
      className="h-full w-full object-cover"
      onError={() => setIndex((current) => current + 1)}
    />
  )
}

function RepairPanel({ repair, jobId }: { repair: DeliveryRepair; jobId: string }) {
  const { latest } = repair
  return (
    <div
      id={`repair-${jobId}`}
      data-testid="repair-panel"
      className="border-t border-apple-line/70 bg-[#FAFAFC] px-4 py-3"
    >
      <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-[11px] leading-5">
        <dt className="text-apple-subtext">修复次数</dt>
        <dd className="num font-medium" data-testid="repair-count">
          {repair.count}
        </dd>
        <dt className="text-apple-subtext">工具</dt>
        <dd className="num break-all" data-testid="repair-tool">
          {latest.tool ?? '无数据'}
        </dd>
        <dt className="text-apple-subtext">问题</dt>
        <dd className="num break-all" data-testid="repair-issue">
          {latest.issue ?? '无数据'}
        </dd>
        <dt className="text-apple-subtext">生成时间</dt>
        <dd className="num" data-testid="repair-generated-at">
          {stamp(latest.generatedAt)}
        </dd>
      </dl>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] font-medium">
        {latest.reportUrl ? (
          <a
            href={latest.reportUrl}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="repair-report-link"
            className="text-apple-blue focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
          >
            修复报告<span className="sr-only">（新窗口）</span>
          </a>
        ) : (
          <span className="text-apple-subtext">修复报告 无数据</span>
        )}
        {latest.compareUrl ? (
          <a
            href={latest.compareUrl}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="repair-compare-link"
            className="text-apple-blue focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
          >
            对比图<span className="sr-only">（新窗口）</span>
          </a>
        ) : (
          <span className="text-apple-subtext">对比图 无数据</span>
        )}
      </div>
    </div>
  )
}

const MENU_ESTIMATED_HEIGHT = 48

/** 字节 → 人类可读（#107 删除确认框）；未知/0 显示「大小未知」。 */
function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return '大小未知'
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** Esc 关闭 + Tab 焦点锁在 panel 内 + 背景不滚动（与 ShareDialog 同规格）。 */
function useModalA11y(
  open: boolean,
  panelRef: RefObject<HTMLElement>,
  onClose: () => void,
  initialFocusRef?: RefObject<HTMLElement>
) {
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    if (!open) return
    initialFocusRef?.current?.focus()
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closeRef.current()
        return
      }
      if (event.key !== 'Tab' || !panelRef.current) return
      const nodes = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], video, [tabindex]:not([tabindex="-1"])'
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
  }, [open, panelRef, initialFocusRef])
}

/** 播放弹层：原生 <video controls>，服务端 /media/out 已支持 Range。 */
function PlayerDialog({ item, onClose }: { item: Delivery; onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const closingRef = useRef(false)
  const [closing, setClosing] = useState(false)
  const titleId = useId()
  const metaId = useId()

  const close = useCallback(() => {
    if (closingRef.current) return
    closingRef.current = true
    setClosing(true)
    window.setTimeout(onClose, 140)
  }, [onClose])

  useModalA11y(true, panelRef, close, closeButtonRef)

  const poster = item.coverUrl ?? item.poster ?? undefined

  return createPortal(
    <div
      className={`fixed inset-0 z-[70] flex items-center justify-center bg-apple-text/45 backdrop-blur-[2px] ${
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
        aria-describedby={metaId}
        data-testid="delivery-player"
        className={`relative flex max-h-[100dvh] w-full flex-col overflow-hidden bg-white sm:max-h-[90dvh] sm:max-w-[min(1100px,92vw)] sm:rounded-card ${
          closing ? 'dialog-panel-closing' : 'dialog-panel'
        }`}
      >
        <div className="flex min-h-0 flex-1 items-center justify-center bg-black">
          <video
            src={item.mp4}
            poster={poster}
            controls
            playsInline
            preload="metadata"
            data-testid="delivery-player-video"
            className="max-h-[62dvh] w-full bg-black sm:max-h-[74dvh]"
          >
            当前浏览器不支持内嵌视频，请直接下载 MP4。
          </video>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
          <div className="min-w-0">
            <h2 id={titleId} className="truncate text-[15px] font-semibold tracking-tight" title={item.title}>
              {item.title}
            </h2>
            <p id={metaId} className="num mt-0.5 text-[11px] leading-relaxed text-apple-subtext">
              {formatDuration(item.durationS)} · {formatResolution(item.width, item.height)} · {item.gate} · 任务 ID{' '}
              {item.jobId}
            </p>
          </div>
          <a
            href={withDownload(item.mp4)}
            download={`${item.jobId}.mp4`}
            className="press inline-flex h-8 items-center rounded-lg bg-apple-bg px-2.5 text-xs font-medium text-apple-text transition-colors hover:bg-[#ECECEF] focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
          >
            下载 MP4
          </a>
        </div>
        <button
          ref={closeButtonRef}
          type="button"
          onClick={close}
          aria-label="关闭播放器"
          data-testid="delivery-player-close"
          className="absolute right-2 top-2 grid h-9 w-9 place-items-center rounded-full bg-black/55 text-white transition-colors hover:bg-black/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
        >
          <Close className="h-[18px] w-[18px]" />
        </button>
      </div>
    </div>,
    document.body
  )
}

/** 删除确认：显示 job id + 大小；处理中禁用，失败留在框内显示原因。 */
function DeleteDialog({
  item,
  busy,
  error,
  onCancel,
  onConfirm
}: {
  item: Delivery
  busy: boolean
  error: string | null
  onCancel: () => void
  onConfirm: () => void
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const close = useCallback(() => {
    if (!busy) onCancel()
  }, [busy, onCancel])

  useModalA11y(true, panelRef, close, cancelRef)

  return createPortal(
    <div
      className="dialog-overlay fixed inset-0 z-[70] flex items-end justify-center bg-apple-text/30 backdrop-blur-[2px] sm:items-center sm:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="delivery-delete-dialog"
        className="dialog-panel w-full rounded-t-[20px] border border-black/[0.08] bg-white p-5 shadow-lift sm:max-w-[420px] sm:rounded-card"
      >
        <h2 id={titleId} className="text-[17px] font-semibold tracking-[-0.01em]">
          移入回收站？
        </h2>
        <p className="mt-1.5 text-sm leading-relaxed text-apple-subtext">
          交付文件会移到 NAS 回收站，可人工移回恢复；不会永久删除内容。
        </p>
        <dl className="num mt-3 grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 rounded-xl bg-apple-bg px-3 py-2.5 text-xs">
          <dt className="text-apple-subtext">任务 ID</dt>
          <dd className="truncate font-medium" data-testid="delivery-delete-id">
            {item.jobId}
          </dd>
          <dt className="text-apple-subtext">文件大小</dt>
          <dd className="font-medium" data-testid="delivery-delete-size">
            {formatBytes(item.bytes)}
          </dd>
        </dl>
        {error && (
          <p
            role="alert"
            data-testid="delivery-delete-error"
            className="mt-3 rounded-lg bg-[#FCEDEB] px-3 py-2 text-xs leading-relaxed text-[#B3261E] ring-1 ring-inset ring-[#F3D3CF]"
          >
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={close}
            disabled={busy}
            className="press inline-flex h-9 items-center rounded-lg bg-apple-bg px-3.5 text-xs font-medium text-apple-text transition-colors hover:bg-[#ECECEF] focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50 disabled:opacity-60"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            aria-busy={busy}
            data-testid="delivery-delete-confirm"
            className="press inline-flex h-9 items-center gap-1.5 rounded-lg bg-[#B3261E] px-3.5 text-xs font-medium text-white transition-colors hover:bg-[#98200F] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#B3261E]/50 disabled:opacity-60"
          >
            <Trash className="h-3.5 w-3.5" />
            {busy ? '正在移入…' : '移入回收站'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

/**
 * 卡片右下角的「…」次要操作菜单。用 portal + fixed 定位，避免被卡片的
 * overflow-hidden 裁切；键盘：Enter/Space 打开、↑↓/Home/End 移动、Esc 关闭。
 */
function MoreMenu({
  label,
  triggerRef,
  children
}: {
  label: string
  triggerRef?: RefObject<HTMLButtonElement>
  children: (close: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ top: number; right: number } | null>(null)
  const localButtonRef = useRef<HTMLButtonElement>(null)
  const buttonRef = triggerRef ?? localButtonRef
  const menuRef = useRef<HTMLDivElement>(null)

  const close = (restoreFocus = false) => {
    setOpen(false)
    setPosition(null)
    if (restoreFocus) buttonRef.current?.focus()
  }

  const openMenu = () => {
    const rect = buttonRef.current?.getBoundingClientRect()
    if (!rect) return
    const openUp = rect.bottom + 6 + MENU_ESTIMATED_HEIGHT > window.innerHeight
    setPosition({
      top: openUp ? Math.max(8, rect.top - 6 - MENU_ESTIMATED_HEIGHT) : rect.bottom + 6,
      right: Math.max(8, window.innerWidth - rect.right)
    })
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    const frame = window.requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    })
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return
      close()
    }
    const dismiss = () => close()
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target as Node
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return
      close()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('focusin', onFocusIn)
    window.addEventListener('resize', dismiss)
    window.addEventListener('scroll', dismiss, true)
    return () => {
      window.cancelAnimationFrame(frame)
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('focusin', onFocusIn)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('scroll', dismiss, true)
    }
  }, [open])

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
    if (event.key === 'Escape') {
      event.preventDefault()
      close(true)
      return
    }
    if (items.length === 0) return
    const current = items.indexOf(document.activeElement as HTMLElement)
    const focusAt = (index: number) => {
      event.preventDefault()
      items[(index + items.length) % items.length]?.focus()
    }
    if (event.key === 'ArrowDown') focusAt(current + 1)
    else if (event.key === 'ArrowUp') focusAt(current - 1)
    else if (event.key === 'Home') focusAt(0)
    else if (event.key === 'End') focusAt(items.length - 1)
    else if (event.key === 'Tab') close()
  }

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        data-testid="delivery-more"
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault()
            openMenu()
          }
        }}
        className="press grid h-8 w-8 place-items-center rounded-lg text-apple-subtext transition-colors hover:bg-black/[0.04] hover:text-apple-text focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
      >
        <More className="h-4 w-4" />
      </button>
      {open &&
        position &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label={label}
            data-testid="delivery-more-menu"
            style={{ position: 'fixed', top: position.top, right: position.right }}
            onKeyDown={onMenuKeyDown}
            className="z-50 min-w-[148px] rounded-xl border border-black/[0.08] bg-white p-1 shadow-lift"
          >
            {children(() => close())}
          </div>,
          document.body
        )}
    </div>
  )
}

function DeliveryCard({
  item,
  onDeleted
}: {
  item: Delivery
  onDeleted: (item: Delivery, result: DeliveryTrashResponse) => void
}) {
  const [open, setOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [playOpen, setPlayOpen] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const moreRef = useRef<HTMLButtonElement>(null)
  const playRef = useRef<HTMLButtonElement>(null)
  const repair = item.repair ?? null
  const sources = [item.coverUrl, item.poster].filter((value): value is string => Boolean(value))

  const deleteFailure = (err: unknown): string => {
    if (err instanceof HttpError) {
      if (err.status === 401) return `需要写入令牌（401）：${err.message}`
      if (err.status === 403) return `同源限制（403）：${err.message}`
      return err.message
    }
    return err instanceof Error ? err.message : '删除失败，请稍后重试。'
  }

  const confirmDelete = async () => {
    if (deleting) return
    setDeleting(true)
    setDeleteError(null)
    try {
      const result = await deleteJson<DeliveryTrashResponse>(
        `/api/deliveries/${encodeURIComponent(item.jobId)}`
      )
      setConfirmOpen(false)
      onDeleted(item, result)
    } catch (err) {
      setDeleteError(deleteFailure(err))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <>
      <article
      data-testid="delivery-card"
      data-job-id={item.jobId}
      data-created-at={item.createdAt ?? ''}
      data-repaired={repair?.repaired ? 'true' : 'false'}
      className="card card-interactive flex h-full flex-col overflow-hidden"
    >
      <div className="relative aspect-video w-full overflow-hidden bg-[#ECECEF]">
        <Cover sources={sources} title={item.title} />
        <span
          data-testid="delivery-duration"
          className="num pointer-events-none absolute bottom-2 right-2 inline-flex h-6 items-center rounded-full bg-black/60 px-2 text-[11px] font-medium text-white backdrop-blur-md"
        >
          {formatDuration(item.durationS)}
        </span>
      </div>

      <div className="flex flex-1 flex-col p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span
            data-gate={item.gate}
            className={`rounded px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset ${gateTone(item.gate)}`}
          >
            {item.gate}
          </span>
          {repair?.repaired && (
            <span
              data-testid="repaired-badge"
              className="rounded bg-[#EAF8EE] px-1.5 py-0.5 text-[11px] font-medium text-[#1E7A3C] ring-1 ring-inset ring-[#CDEED6]"
            >
              已修复
            </span>
          )}
        </div>

        <h2 className="mt-2 line-clamp-2 text-[15px] font-semibold leading-snug tracking-tight" title={item.title}>
          {item.title}
        </h2>

        <p className="num mt-1 text-xs text-apple-subtext">
          {formatDuration(item.durationS)} · {formatResolution(item.width, item.height)}
        </p>

        <p className="mt-2 text-xs text-apple-subtext" data-testid="delivery-score" data-score={item.score ?? ''}>
          <span className="text-apple-subtext">判定 </span>
          <span className="num font-medium text-apple-text">{item.score != null ? item.score : '仅报数'}</span>
        </p>

        <p className="num mt-1 text-[11px] text-apple-subtext" data-testid="delivery-created-at">
          {stamp(item.createdAt)}
        </p>

        {/* #102：成片标题保持可读；原始 jobId 降为底部小号等宽，仍可点进详情排障。 */}
        <Link
          to={`/job/${item.jobId}`}
          className="num mt-1 inline-block max-w-full truncate text-[10px] leading-relaxed text-apple-subtext underline-offset-2 hover:text-apple-text hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
          title={`任务 ID ${item.jobId}`}
        >
          任务 ID {item.jobId}
        </Link>

        <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-apple-line/70 pt-3">
          <button
            ref={playRef}
            type="button"
            onClick={() => setPlayOpen(true)}
            data-testid="delivery-play"
            className="press inline-flex h-8 items-center gap-1.5 rounded-lg bg-apple-text px-2.5 text-xs font-medium text-white transition-colors hover:bg-black focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
          >
            <Play className="h-3.5 w-3.5" />
            播放
          </button>
          <a
            href={withDownload(item.mp4)}
            download={`${item.jobId}.mp4`}
            data-testid="download-mp4"
            className="press inline-flex h-8 items-center rounded-lg bg-apple-bg px-2.5 text-xs font-medium text-apple-text transition-colors hover:bg-[#ECECEF] focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
          >
            下载 MP4
          </a>
          {item.report ? (
            <a
              href={withDownload(item.report)}
              download={`${item.jobId}-report.md`}
              data-testid="download-report"
              className="press inline-flex h-8 items-center rounded-lg bg-apple-bg px-2.5 text-xs font-medium text-apple-text transition-colors hover:bg-[#ECECEF] focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
            >
              下载报告
            </a>
          ) : (
            <span className="text-xs text-apple-subtext">报告 无数据</span>
          )}
          <div className="ml-auto flex items-center gap-2">
            {repair && (
              <button
                type="button"
                onClick={() => setOpen((value) => !value)}
                aria-expanded={open}
                aria-controls={`repair-${item.jobId}`}
                data-testid="repair-toggle"
                className="inline-flex items-center gap-1 text-xs font-medium text-apple-blue focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
              >
                修复记录
                <ChevronDown className={`h-3.5 w-3.5 transition-transform duration-200 ease-apple ${open ? 'rotate-180' : ''}`} />
              </button>
            )}
            <MoreMenu label={`更多操作：${item.title}`} triggerRef={moreRef}>
              {(close) => (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    data-testid="share-menu-item"
                    onClick={() => {
                      close()
                      setShareOpen(true)
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs font-medium text-apple-text transition-colors hover:bg-black/[0.04] focus:outline-none focus-visible:bg-black/[0.05] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-apple-blue/50"
                  >
                    <Share className="h-3.5 w-3.5 text-apple-subtext" />
                    分享
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    data-testid="delivery-delete"
                    onClick={() => {
                      close()
                      setDeleteError(null)
                      setConfirmOpen(true)
                    }}
                    className="mt-0.5 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs font-medium text-[#B3261E] transition-colors hover:bg-[#FCEDEB] focus:outline-none focus-visible:bg-[#FCEDEB] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#B3261E]/40"
                  >
                    <Trash className="h-3.5 w-3.5" />
                    删除（移入回收站）
                  </button>
                </>
              )}
            </MoreMenu>            <ShareButton
              path={item.mp4}
              name={item.title}
              hideTrigger
              open={shareOpen}
              onOpenChange={setShareOpen}
              returnFocusRef={moreRef}
            />
          </div>
        </div>
      </div>

      {open && repair && <RepairPanel repair={repair} jobId={item.jobId} />}
      </article>

      {playOpen && (
        <PlayerDialog
          item={item}
          onClose={() => {
            setPlayOpen(false)
            // AC1：关闭后焦点回到触发按钮（等 portal 卸载后再聚焦）。
            window.setTimeout(() => playRef.current?.focus(), 0)
          }}
        />
      )}
      {confirmOpen && (
        <DeleteDialog
          item={item}
          busy={deleting}
          error={deleteError}
          onCancel={() => {
            if (deleting) return
            setConfirmOpen(false)
            setDeleteError(null)
          }}
          onConfirm={confirmDelete}
        />
      )}
    </>
  )
}

export function DeliveriesPage() {
  const { status, data, error, retry } = useJson<DeliveriesResponse>('/api/deliveries')
  const [removedIds, setRemovedIds] = useState<ReadonlySet<string>>(() => new Set())
  const [toast, setToast] = useState<{ message: string; tone: 'success' | 'error' } | null>(null)
  const deliveries = (data?.deliveries ?? []).filter((item) => !removedIds.has(item.jobId))

  const onDeleted = useCallback((item: Delivery, result: DeliveryTrashResponse) => {
    setRemovedIds((current) => new Set(current).add(item.jobId))
    setToast({
      tone: 'success',
      message: `已将 ${item.jobId} 移入回收站（${formatBytes(result.bytes)}），可人工移回恢复。`
    })
  }, [])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 4000)
    return () => window.clearTimeout(timer)
  }, [toast])

  return (
    <div>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em] sm:text-[32px]">交付与资产</h1>
          <p className="mt-1.5 max-w-[76ch] text-sm leading-relaxed text-apple-subtext">
            真实成片、封面裁切、AI 修复记录与下载入口；可在线播放，删除会移入 NAS 回收站（可人工恢复）。
          </p>
        </div>
        <p className="num text-[11px] leading-relaxed text-apple-subtext">
          数据 /api/deliveries · 来源 {data?.meta.source ?? '无数据'} · {deliveries.length} 个成片
        </p>
      </header>

      {status === 'loading' && (
        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-busy="true" aria-label="正在读取交付">
          {[0, 1, 2, 3].map((index) => (
            <div key={index} className="card h-[330px] animate-pulse" />
          ))}
        </div>
      )}

      {status === 'error' && (
        <div className="card mt-5 flex flex-wrap items-center justify-between gap-3 p-5" role="alert">
          <div>
            <p className="text-sm font-medium">交付读取失败</p>
            <p className="mt-1 text-xs text-apple-subtext">{error}</p>
          </div>
          <button
            type="button"
            onClick={retry}
            className="press flex h-8 items-center gap-1.5 rounded-lg bg-apple-text px-3 text-xs font-medium text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
          >
            <Refresh className="h-3.5 w-3.5" />
            重试
          </button>
        </div>
      )}

      {status === 'ready' && deliveries.length === 0 && (
        <div className="card mt-5 p-5">
          <p className="text-sm font-medium">暂无交付产物</p>
          <p className="mt-1 text-xs leading-relaxed text-apple-subtext">
            /api/deliveries 返回 0 个成片；/media/out 下还没有可交付的 mp4。
          </p>
        </div>
      )}

      {deliveries.length > 0 && (
        <>
          <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4" data-equal-grid data-stagger>
            {deliveries.map((item) => (
              <DeliveryCard key={item.jobId} item={item} onDeleted={onDeleted} />
            ))}
          </div>
          <p className="mt-4 text-[11px] leading-relaxed text-apple-subtext">
            封面优先 cover_16x9.jpg，缺失时回退 poster，再缺显示灰底占位；封面统一 object-cover 裁切。
          </p>
        </>
      )}

      <div
        className="pointer-events-none fixed inset-x-0 bottom-5 z-[80] flex justify-center px-4"
        aria-live="polite"
        role="status"
      >
        {toast && (
          <p
            data-testid="delivery-toast"
            data-tone={toast.tone}
            className="pointer-events-auto max-w-[min(560px,100%)] rounded-xl bg-apple-text px-4 py-2.5 text-center text-xs font-medium leading-relaxed text-white shadow-lift"
          >
            {toast.message}
          </p>
        )}
      </div>
    </div>
  )
}
