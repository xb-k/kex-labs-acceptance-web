import { useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react'
import { useSystem } from '../api'
import { useIssues } from '../issues'
import type { SystemSnapshot } from '../types'
import { Bot, Chart, Clapper, Close, ExternalLink, Film, Flow, Folder, Grid, Inbox, Menu, Plus, Server, Shield, Sliders } from './icons'
import { Link, useRouter } from '../router'
import { needsIntranet } from '../url'

type NavEntry = { to: string; label: string; icon: ComponentType<{ className?: string }> }

/**
 * 导航按用户任务心智分组（#104）：概览 → 创作 → 任务与质量 → 交付与协作。
 * 同一路由只出现一次；分组标题仅作视觉/语义分隔，不额外制造焦点。
 */
const NAV_GROUPS: Array<{ id: string; title: string; items: NavEntry[] }> = [
  {
    id: 'overview',
    title: '概览',
    items: [
      { to: '/', label: '工作台总览', icon: Grid },
      { to: '/status', label: '项目状态', icon: Server }
    ]
  },
  {
    id: 'create',
    title: '创作',
    items: [
      { to: '/studio', label: '创作工坊', icon: Clapper },
      { to: '/flow', label: '自动编排监看', icon: Flow },
      { to: '/pipeline', label: '渲染工作台与契约', icon: Sliders }
    ]
  },
  {
    id: 'quality',
    title: '任务与质量',
    items: [
      { to: '/jobs', label: '任务中心', icon: Film },
      { to: '/qc', label: 'QC 质量门禁', icon: Shield }
    ]
  },
  {
    id: 'handoff',
    title: '交付与协作',
    items: [
      { to: '/deliveries', label: '交付与资产', icon: Folder },
      { to: '/reports', label: '报表与周报', icon: Chart },
      { to: '/issues', label: 'Issue 收件箱', icon: Inbox },
      { to: '/agents', label: 'Agent 库', icon: Bot }
    ]
  }
]

function isActive(path: string, to: string): boolean {
  if (to === '/') return path === '/' || path === ''
  if (to === '/jobs') return path === '/jobs' || path.startsWith('/job/')
  return path === to || path.startsWith(`${to}/`)
}

function NavItem({ entry, onNavigate }: { entry: NavEntry; onNavigate?: () => void }) {
  const { path } = useRouter()
  const active = isActive(path, entry.to)
  const Icon = entry.icon
  return (
    <Link
      to={entry.to}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      className={`group flex h-10 items-center gap-2.5 rounded-[11px] px-3 text-[13px] transition-all duration-200 ease-apple focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50 ${
        active
          ? 'bg-white font-medium text-apple-text shadow-nav'
          : 'font-normal text-apple-subtext/80 hover:bg-white/55 hover:text-apple-text'
      }`}
    >
      <Icon
        className={`h-4 w-4 shrink-0 transition-colors duration-200 ${
          active ? 'text-apple-blue' : 'text-apple-subtext/80 group-hover:text-apple-text'
        }`}
      />
      <span className="truncate">{entry.label}</span>
    </Link>
  )
}

function NavGroup({
  group,
  scope,
  onNavigate
}: {
  group: (typeof NAV_GROUPS)[number]
  scope: 'desktop' | 'drawer'
  onNavigate?: () => void
}) {
  const { path } = useRouter()
  const active = group.items.some((entry) => isActive(path, entry.to))
  const titleId = `nav-group-${group.id}-${scope}`
  return (
    <div
      role="group"
      aria-labelledby={titleId}
      className="pb-1 pt-3 first:pt-0"
      data-nav-group={group.id}
      data-nav-group-active={active ? 'true' : 'false'}
    >
      <p
        id={titleId}
        className={`px-3 pb-1 text-[10.5px] font-semibold uppercase leading-4 tracking-[0.1em] transition-colors duration-200 ${
          active ? 'text-apple-text' : 'text-apple-subtext/65'
        }`}
      >
        {group.title}
      </p>
      <div className="space-y-0.5">
        {group.items.map((entry) => (
          <NavItem key={entry.to} entry={entry} onNavigate={onNavigate} />
        ))}
      </div>
    </div>
  )
}

function gb(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const n = value / 1024 ** 3
  return n >= 10 ? n.toFixed(0) : n.toFixed(1)
}

type DockKey = 'issue' | 'studio'

const dockButtonClass = (active: boolean) =>
  `relative grid h-10 w-10 place-items-center rounded-[12px] border transition-colors duration-200 ease-apple focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50 ${
    active
      ? 'border-[#D8E6FE] bg-[#EAF2FF] text-apple-blueInk'
      : 'border-black/[0.07] bg-white/70 text-apple-subtext hover:bg-white hover:text-apple-text'
  }`

const dockPopoverClass = (closing: boolean) =>
  `${closing ? 'popover-closing' : 'popover-surface'} absolute bottom-[calc(100%+10px)] left-0 z-50 w-[300px] max-w-[calc(100vw-24px)] origin-bottom-left`

function SideDock({ system }: { system: ReturnType<typeof useSystem> }) {
  const { status, data, error, retry, openDialog, counts, webUrl } = useIssues()
  const [open, setOpen] = useState<DockKey | null>(null)
  const [closing, setClosing] = useState<DockKey | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const issueRef = useRef<HTMLButtonElement>(null)
  const studioRef = useRef<HTMLButtonElement>(null)
  const closeTimer = useRef<number | null>(null)

  const active = open ?? closing
  const isClosing = open === null && closing !== null
  const openCount = status === 'ready' ? counts?.open ?? null : null
  const totalCount = status === 'ready' ? counts?.total ?? null : null
  const latest = status === 'ready' ? data.latest : null
  const sys: SystemSnapshot | null = system.data
  const online = sys?.online ?? null
  const studioStatus = system.status === 'loading' ? '检测中' : system.status === 'error' ? '不可用' : online ? '在线' : '离线'
  const studioDot =
    system.status === 'loading' ? 'bg-[#8E8E93]' : online ? 'bg-[#30A14E]' : 'bg-[#FF3B30]'

  const closeDock = (returnFocus = true) => {
    if (!open) return
    const key = open
    setOpen(null)
    setClosing(key)
    if (closeTimer.current) window.clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(() => setClosing(null), 140)
    if (returnFocus) {
      const target = key === 'issue' ? issueRef.current : studioRef.current
      window.setTimeout(() => target?.focus(), 0)
    }
  }

  const toggle = (key: DockKey) => {
    if (open === key) {
      closeDock(true)
      return
    }
    if (closeTimer.current) window.clearTimeout(closeTimer.current)
    setClosing(null)
    setOpen(key)
  }

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) closeDock(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      // 捕获阶段拦下，避免同时把移动端抽屉一起关掉（一次 Esc 只关 popover）。
      // 抽屉的 Esc 监听也挂在 document 上，同节点需 stopImmediatePropagation。
      event.stopImmediatePropagation()
      closeDock(true)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const timer = window.setTimeout(() => {
      const first = popRef.current?.querySelector<HTMLElement>('[data-popover-focus]')
      first?.focus()
    }, 30)
    return () => window.clearTimeout(timer)
  }, [open])

  useEffect(
    () => () => {
      if (closeTimer.current) window.clearTimeout(closeTimer.current)
    },
    []
  )

  return (
    <div ref={wrapRef} className="relative flex items-center gap-2">
      <button
        ref={issueRef}
        type="button"
        onClick={() => toggle('issue')}
        aria-haspopup="dialog"
        aria-expanded={open === 'issue'}
        aria-controls="dock-issue-popover"
        title={openCount != null ? `Issues · ${openCount} 打开` : 'Issues'}
        className={dockButtonClass(open === 'issue')}
      >
        <Inbox className="h-[18px] w-[18px]" />
        <span className="sr-only">Issues</span>
        {openCount != null && (
          <span
            data-testid="dock-issue-badge"
            className="num absolute -right-1 -top-1 grid h-4 min-w-[16px] place-items-center rounded-full bg-apple-blue px-1 text-[10px] font-semibold leading-none text-white ring-2 ring-white"
          >
            {openCount > 99 ? '99+' : openCount}
          </span>
        )}
      </button>

      <button
        ref={studioRef}
        type="button"
        onClick={() => toggle('studio')}
        aria-haspopup="dialog"
        aria-expanded={open === 'studio'}
        aria-controls="dock-studio-popover"
        title={`Studio · ${studioStatus}`}
        className={dockButtonClass(open === 'studio')}
      >
        <Server className="h-[18px] w-[18px]" />
        <span className="sr-only">Studio</span>
        <span
          aria-hidden="true"
          className={`absolute right-2 top-2 h-2 w-2 rounded-full ring-2 ring-white ${studioDot}`}
        />
      </button>

      {active && (
        <div
          ref={popRef}
          id={`dock-${active}-popover`}
          role="dialog"
          aria-label={active === 'issue' ? 'Issues 概览' : 'Studio 状态'}
          className={dockPopoverClass(isClosing)}
        >
          {active === 'issue' ? (
            <div className="rounded-[14px] border border-black/[0.08] bg-white p-3.5 text-apple-text shadow-lift">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[13px] font-semibold tracking-[-0.01em]">Issues</span>
                <span className="text-[11px] text-apple-subtext">
                  {status === 'loading'
                    ? '检测中'
                    : status === 'error'
                      ? '不可用'
                      : counts
                        ? `共 ${counts.total} 条`
                        : '无数据'}
                </span>
              </div>

              {status === 'ready' ? (
                <Link
                  to="/issues"
                  onClick={() => closeDock(false)}
                  data-popover-focus
                  className="-mx-2 mt-2 block rounded-lg p-2 transition-colors hover:bg-apple-bg/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
                >
                  <span className="flex items-baseline gap-1">
                    <span
                      data-testid="dock-issue-open-count"
                      className="num text-[22px] font-semibold leading-none tracking-[-0.02em]"
                    >
                      {openCount ?? 0}
                    </span>
                    <span className="text-[11px] text-apple-subtext">打开</span>
                    {totalCount != null && (
                      <span className="num ml-1 text-[11px] text-apple-subtext">/ {totalCount}</span>
                    )}
                  </span>
                  <span
                    className="mt-1 block truncate text-[12px] leading-5 text-apple-subtext"
                    title={latest?.title ?? undefined}
                  >
                    {latest ? `最近 · ${latest.title}` : openCount === 0 ? '没有打开的 issue' : '无数据'}
                  </span>
                  <span className="mt-0.5 block text-[11px] font-medium text-apple-blueInk">查看全部 →</span>
                </Link>
              ) : status === 'loading' ? (
                <p className="mt-2 text-[12px] leading-5 text-apple-subtext">读取 /api/issues…</p>
              ) : status === 'error' ? (
                <div className="mt-2">
                  <p className="text-[12px] leading-5 text-apple-subtext">Gitea 不可用</p>
                  <p className="mt-0.5 line-clamp-2 break-words text-[11px] leading-4 text-apple-subtext" title={error ?? undefined}>
                    {error ?? '请求失败'}
                  </p>
                  <button
                    type="button"
                    data-popover-focus
                    onClick={retry}
                    className="mt-1 rounded text-[11px] font-medium text-apple-blueInk underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
                  >
                    重试
                  </button>
                </div>
              ) : (
                <p className="mt-2 text-[12px] leading-5 text-apple-subtext">暂无 issue</p>
              )}

              <div className="mt-2.5 space-y-2 border-t border-black/[0.06] pt-2">
                {webUrl && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <a
                      href={webUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      data-popover-focus
                      className="inline-flex items-center gap-1 rounded text-[11px] font-medium text-apple-blueInk underline-offset-2 transition-colors hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
                    >
                      在 Gitea 查看
                      <ExternalLink className="h-3 w-3" />
                    </a>
                    {needsIntranet(webUrl) && (
                      <span
                        data-testid="gitea-intranet-hint"
                        className="rounded bg-black/[0.05] px-1 py-0.5 text-[10px] leading-4 text-apple-subtext"
                      >
                        需内网/Tailscale
                      </span>
                    )}
                  </div>
                )}
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] text-apple-subtext">数据 /api/issues</span>
                  <button
                    type="button"
                    data-popover-focus
                    onClick={() => {
                      closeDock(false)
                      openDialog()
                    }}
                    className="inline-flex items-center gap-1 rounded-full bg-apple-blue px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-[#0062C4] focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
                  >
                    <Plus className="h-3 w-3" />
                    新建
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div
              data-popover-focus
              tabIndex={-1}
              className="glass-dark rounded-[14px] p-3.5 text-white focus:outline-none"
            >
              <div className="flex items-start justify-between gap-2">
                <span className="text-[12px] font-semibold tracking-[-0.01em]">Mac Studio</span>
                <span
                  className={`flex items-center gap-1.5 text-[11px] font-medium ${
                    online === null ? 'text-white/60' : online ? 'text-[#7BE495]' : 'text-[#FF8A80]'
                  }`}
                >
                  <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${online === null ? 'bg-white/40' : online ? 'bg-[#30D158]' : 'bg-[#FF453A]'}`} />
                  {studioStatus}
                </span>
              </div>

              {sys && (
                <dl className="mt-3 space-y-1.5 text-[11px] leading-4">
                  <div className="flex items-baseline justify-between gap-2">
                    <dt className="text-white/60">延迟</dt>
                    <dd className="num text-white/90">{sys.latencyMs != null ? `${sys.latencyMs} ms` : '无数据'}</dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-2">
                    <dt className="text-white/60">VRAM 空闲</dt>
                    <dd className="num text-white/90">
                      {sys.vram?.free != null ? (
                        <>
                          {gb(sys.vram.free)} <span className="text-white/60">/ {gb(sys.vram.total)} GB</span>
                        </>
                      ) : (
                        '无数据'
                      )}
                    </dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-2">
                    <dt className="text-white/60">队列</dt>
                    <dd className="num text-white/90">
                      {sys.queue ? `${sys.queue.running} 执行 · ${sys.queue.pending} 待排` : '无数据'}
                    </dd>
                  </div>
                </dl>
              )}

              {system.status === 'error' && <p className="mt-2 text-[11px] leading-4 text-white/55">状态接口不可用</p>}
              {system.status === 'loading' && <p className="mt-2 text-[11px] leading-4 text-white/55">读取 /api/system…</p>}
              {sys?.error && online === false && (
                <p className="mt-2 line-clamp-2 text-[11px] leading-4 text-white/55" title={sys.error}>
                  {sys.error}
                </p>
              )}
              <p className="mt-2 border-t border-white/[0.07] pt-2 text-[11px] leading-4 text-white/55">
                数据 /api/system · 30s 刷新
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Brand() {
  return (
    <Link
      to="/"
      className="flex items-center gap-2.5 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
    >
      <span className="grid h-6 w-6 place-items-center rounded-[7px] bg-gradient-to-br from-apple-accentBlue to-apple-accentPurple text-white">
        <Film className="h-3.5 w-3.5" />
      </span>
      <span className="leading-tight">
        <span className="block text-[14px] font-semibold tracking-[-0.02em]">Kex Labs</span>
        <span className="mt-0.5 block text-[11px] text-apple-subtext">视频工作台</span>
      </span>
    </Link>
  )
}

function Sidebar({ system }: { system: ReturnType<typeof useSystem> }) {
  return (
    <aside className="glass-sidebar fixed inset-y-0 left-0 z-30 hidden w-[236px] flex-col lg:flex">
      <div className="px-4 pb-5 pt-6">
        <Brand />
      </div>
      <nav aria-label="主导航" className="min-h-0 flex-1 overflow-y-auto px-3 pb-1">
        {NAV_GROUPS.map((group) => (
          <NavGroup key={group.id} group={group} scope="desktop" />
        ))}
      </nav>
      <div className="p-3">
        <SideDock system={system} />
      </div>
    </aside>
  )
}

function MobileDrawer({
  open,
  onClose,
  system
}: {
  open: boolean
  onClose: () => void
  system: ReturnType<typeof useSystem>
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    closeRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab' || !panelRef.current) return
      const nodes = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')
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
    document.addEventListener('keydown', onKey)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previousOverflow
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 lg:hidden">
      <button
        type="button"
        aria-label="关闭导航"
        onClick={onClose}
        className="absolute inset-0 h-full w-full bg-apple-text/25 backdrop-blur-[2px]"
        tabIndex={-1}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="主导航"
        className="absolute inset-y-0 left-0 flex w-[280px] max-w-[85vw] flex-col border-r border-black/[0.06] bg-white/95 shadow-lift backdrop-blur-2xl"
      >
        <div className="flex items-center justify-between px-4 pb-2 pt-4">
          <Brand />
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="关闭导航"
            className="grid h-10 w-10 place-items-center rounded-full text-apple-subtext transition-colors hover:bg-apple-bg focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
          >
            <Close className="h-[18px] w-[18px]" />
          </button>
        </div>
        <nav aria-label="主导航（移动端）" className="flex-1 overflow-y-auto px-3 py-2">
          {NAV_GROUPS.map((group) => (
            <NavGroup key={group.id} group={group} scope="drawer" onNavigate={onClose} />
          ))}
        </nav>
        <div className="p-3">
          <SideDock system={system} />
        </div>
      </div>
    </div>
  )
}

export function Shell({ children }: { children: ReactNode }) {
  const { path } = useRouter()
  const system = useSystem()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const menuRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    setDrawerOpen(false)
  }, [path])

  const closeDrawer = () => {
    setDrawerOpen(false)
    window.setTimeout(() => menuRef.current?.focus(), 0)
  }

  return (
    <div className="min-h-dvh font-sans text-apple-text">
      <Sidebar system={system} />

      <div className="lg:pl-[236px]">
        <header className="sticky top-0 z-20 border-b border-black/[0.06] bg-white/70 backdrop-blur-xl lg:hidden">
          <div className="flex h-14 items-center justify-between gap-3 px-4">
            <Brand />
            <button
              ref={menuRef}
              type="button"
              aria-label="打开导航"
              aria-expanded={drawerOpen}
              aria-haspopup="dialog"
              onClick={() => setDrawerOpen(true)}
              className="grid h-10 w-10 place-items-center rounded-full text-apple-text transition-colors hover:bg-white/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
            >
              <Menu className="h-5 w-5" />
            </button>
          </div>
        </header>

        <main
          id="main-content"
          tabIndex={-1}
          className="mx-auto w-full max-w-[1360px] px-4 py-6 focus:outline-none sm:px-6 lg:px-8 lg:py-8"
        >
          <div key={path} className="page-enter">
            {children}
          </div>
        </main>

        <footer className="mx-auto w-full max-w-[1360px] px-4 pb-10 text-[11px] leading-relaxed text-apple-subtext sm:px-6 lg:px-8">
          Kex Labs · 实验中的视频工作台（设计态）。页面数字全部读取自 acceptance 仓库真实产物（plan / jobs / status /
          system / deliveries），不含模拟数据。
        </footer>
      </div>

      <MobileDrawer open={drawerOpen} onClose={closeDrawer} system={system} />
    </div>
  )
}
