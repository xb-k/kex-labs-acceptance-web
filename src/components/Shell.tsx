import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react'
import { useSystem } from '../api'
import { formatGb } from '../format'
import { useModalA11y } from '../hooks'
import type { SystemSnapshot } from '../types'
import {
  Bot,
  Clapper,
  Close,
  Film,
  Flow,
  Folder,
  Menu,
  Refresh,
  Server,
  Shield
} from './icons'
import { Link, useRouter } from '../router'
import { BrandLockup } from './BrandLogo'
import { ErrorBoundary } from './ui'

type NavEntry = { to: string; label: string; keywords?: string; icon: ComponentType<{ className?: string }> }

const NAV_GROUPS: Array<{ id: string; title: string; items: NavEntry[] }> = [
  {
    id: 'create',
    title: '制片与创作',
    items: [
      { to: '/', label: '视频生产总台', keywords: 'production tracker overview kpi dashboard agents pipeline', icon: Flow },
      { to: '/studio', label: '双轨创作工坊', keywords: 'studio brief script image optimize upload aigc', icon: Clapper }
    ]
  },
  {
    id: 'quality',
    title: '任务与品控',
    items: [
      { to: '/jobs', label: '任务中心', keywords: 'jobs b-track studio queue', icon: Film },
      { to: '/qc', label: 'QC 质量门禁', keywords: 'qc gate ssim lapvar rules', icon: Shield }
    ]
  },
  {
    id: 'assets',
    title: '资产与策略',
    items: [
      { to: '/deliveries', label: '交付成片库', keywords: 'deliveries mp4 cover trash', icon: Folder },
      { to: '/agents', label: 'Agent 与提示词库', keywords: 'agents skills profiles lut prompts', icon: Bot }
    ]
  }
]

const ALL_NAV_ITEMS = NAV_GROUPS.flatMap((g) => g.items.map((item) => ({ ...item, group: g.title })))

function isActive(path: string, to: string): boolean {
  if (to === '/') return path === '/' || path === '' || path === '/overview'
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

const dockButtonClass = (active: boolean) =>
  `relative grid h-10 w-10 place-items-center rounded-[12px] border transition-colors duration-200 ease-apple focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50 ${
    active
      ? 'border-[#D8E6FE] bg-[#EAF2FF] text-apple-blueInk'
      : 'border-black/[0.07] bg-white/70 text-apple-subtext hover:bg-white hover:text-apple-text'
  }`

const dockPopoverClass = (closing: boolean) =>
  `${closing ? 'popover-closing' : 'popover-surface'} absolute bottom-[calc(100%+10px)] left-0 z-50 w-[300px] max-w-[calc(100vw-24px)] origin-bottom-left`

function SideDock({
  system,
  onOpenPalette
}: {
  system: ReturnType<typeof useSystem>
  onOpenPalette: () => void
}) {
  const [open, setOpen] = useState(false)
  const [closing, setClosing] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const studioRef = useRef<HTMLButtonElement>(null)
  const closeTimer = useRef<number | null>(null)

  const active = open || closing
  const isClosing = !open && closing
  const sys: SystemSnapshot | null = system.data
  const online = sys?.online ?? null
  const studioStatus = system.status === 'loading' ? '检测中' : system.status === 'error' ? '不可用' : online ? '在线' : '离线'
  const studioDot =
    system.status === 'loading' ? 'bg-[#8E8E93]' : online ? 'bg-[#30A14E]' : 'bg-[#FF3B30]'

  const vramRatio =
    sys?.vram?.used != null && sys.vram.total != null && sys.vram.total > 0
      ? Math.min(100, Math.max(0, Math.round((sys.vram.used / sys.vram.total) * 100)))
      : null

  const closeDock = (returnFocus = true) => {
    if (!open) return
    setOpen(false)
    setClosing(true)
    if (closeTimer.current) window.clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(() => setClosing(false), 140)
    if (returnFocus) {
      window.setTimeout(() => studioRef.current?.focus(), 0)
    }
  }

  const toggle = () => {
    if (open) {
      closeDock(true)
      return
    }
    if (closeTimer.current) window.clearTimeout(closeTimer.current)
    setClosing(false)
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) closeDock(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
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
    <div ref={wrapRef} className="relative flex items-center justify-between gap-2">
      <button
        ref={studioRef}
        type="button"
        onClick={toggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="dock-studio-popover"
        title={`Studio · ${studioStatus}`}
        className={dockButtonClass(open)}
      >
        <Server className="h-[18px] w-[18px]" />
        <span className="sr-only">Studio</span>
        <span
          aria-hidden="true"
          className={`absolute right-2 top-2 h-2 w-2 rounded-full ring-2 ring-white ${studioDot} ${online ? 'text-[#30A14E] live-beacon' : ''}`}
        />
      </button>

      <button
        type="button"
        onClick={onOpenPalette}
        title="快速切换页面 (⌘K / Ctrl+K)"
        className="inline-flex h-10 flex-1 items-center justify-between gap-1.5 rounded-[12px] border border-black/[0.07] bg-white/70 px-3 text-[11.5px] font-medium text-apple-subtext transition-colors hover:bg-white hover:text-apple-text focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
      >
        <span>快速跳转</span>
        <kbd className="num rounded bg-black/[0.05] px-1.5 py-0.5 text-[10px] text-apple-text">⌘K</kbd>
      </button>

      {active && (
        <div
          ref={popRef}
          id="dock-studio-popover"
          role="dialog"
          aria-label="Studio 状态"
          className={dockPopoverClass(isClosing)}
        >
          <div
            data-popover-focus
            tabIndex={-1}
            className="glass-dark rounded-[14px] p-3.5 text-white focus:outline-none"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12px] font-semibold tracking-[-0.01em]">Mac Studio</span>
              <div className="flex items-center gap-2">
                <span
                  className={`flex items-center gap-1.5 text-[11px] font-medium ${
                    online === null ? 'text-white/60' : online ? 'text-[#7BE495]' : 'text-[#FF8A80]'
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`h-1.5 w-1.5 rounded-full ${online === null ? 'bg-white/40' : online ? 'bg-[#30D158]' : 'bg-[#FF453A]'}`}
                  />
                  {studioStatus}
                </span>
                <button
                  type="button"
                  onClick={system.refresh}
                  disabled={system.refreshing}
                  aria-label="刷新 Studio 状态"
                  title="刷新 Studio 状态"
                  className="grid h-6 w-6 place-items-center rounded-full text-white/70 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-50"
                >
                  <Refresh className={`h-3.5 w-3.5 ${system.refreshing ? 'animate-spin' : ''}`} />
                </button>
              </div>
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
                        {formatGb(sys.vram.free)} <span className="text-white/60">/ {formatGb(sys.vram.total)} GB</span>
                      </>
                    ) : (
                      '无数据'
                    )}
                  </dd>
                </div>
                {vramRatio !== null && (
                  <div className="pt-0.5">
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/15">
                      <div
                        className={`h-full rounded-full transition-all duration-300 ${
                          vramRatio >= 85 ? 'bg-[#FF453A]' : vramRatio >= 65 ? 'bg-[#FF9F0A]' : 'bg-[#30D158]'
                        }`}
                        style={{ width: `${vramRatio}%` }}
                      />
                    </div>
                  </div>
                )}
                {sys.ram && (
                  <div className="flex items-baseline justify-between gap-2">
                    <dt className="text-white/60">统一内存空闲</dt>
                    <dd className="num text-white/90">
                      {sys.ram.free != null ? (
                        <>
                          {formatGb(sys.ram.free)} <span className="text-white/60">/ {formatGb(sys.ram.total)} GB</span>
                        </>
                      ) : (
                        '无数据'
                      )}
                    </dd>
                  </div>
                )}
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
              48GB Metal 上限 · 30s 刷新
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

function Brand() {
  return (
    <Link
      to="/"
      className="flex items-center rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
    >
      <BrandLockup />
    </Link>
  )
}

function Sidebar({
  system,
  onOpenPalette
}: {
  system: ReturnType<typeof useSystem>
  onOpenPalette: () => void
}) {
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
        <SideDock system={system} onOpenPalette={onOpenPalette} />
      </div>
    </aside>
  )
}

function MobileDrawer({
  open,
  onClose,
  system,
  onOpenPalette,
  restoreFocusRef
}: {
  open: boolean
  onClose: () => void
  system: ReturnType<typeof useSystem>
  onOpenPalette: () => void
  restoreFocusRef: React.RefObject<HTMLButtonElement | null>
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  useModalA11y(open, panelRef, onClose, closeRef, restoreFocusRef)

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
          <SideDock
            system={system}
            onOpenPalette={() => {
              onClose()
              onOpenPalette()
            }}
          />
        </div>
      </div>
    </div>
  )
}

function QuickRoutePalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { path, navigate } = useRouter()
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const panelRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useModalA11y(open, panelRef, onClose, inputRef)

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return ALL_NAV_ITEMS
    return ALL_NAV_ITEMS.filter(
      (item) =>
        item.label.toLowerCase().includes(q) ||
        item.to.toLowerCase().includes(q) ||
        item.group.toLowerCase().includes(q) ||
        (item.keywords && item.keywords.includes(q))
    )
  }, [query])

  useEffect(() => {
    if (open) {
      setQuery('')
      setCursor(0)
    }
  }, [open])

  useEffect(() => {
    setCursor(0)
  }, [query])

  if (!open) return null

  const go = (to: string) => {
    onClose()
    navigate(to)
  }

  return (
    <div className="dialog-overlay fixed inset-0 z-50 flex items-start justify-center bg-black/30 px-4 pt-[12vh] backdrop-blur-[2px]">
      <button type="button" aria-label="关闭快速跳转" onClick={onClose} className="fixed inset-0 cursor-default" tabIndex={-1} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="快速跳转工作台页面"
        className="dialog-panel relative z-10 w-full max-w-[480px] overflow-hidden rounded-[18px] border border-black/[0.08] bg-white shadow-lift"
      >
        <div className="flex items-center gap-2 border-b border-apple-line px-4 py-3">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setCursor((c) => (matches.length ? (c + 1) % matches.length : 0))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setCursor((c) => (matches.length ? (c - 1 + matches.length) % matches.length : 0))
              } else if (e.key === 'Enter' && matches[cursor]) {
                e.preventDefault()
                go(matches[cursor].to)
              }
            }}
            placeholder="输入页面名称或路由，例如 创作、QC、Agent…"
            className="w-full bg-transparent text-[14px] text-apple-text placeholder:text-apple-subtext/70 focus:outline-none"
          />
          <button
            type="button"
            onClick={onClose}
            className="rounded-md bg-[#F2F2F7] px-2 py-0.5 text-[11px] font-medium text-apple-subtext hover:text-apple-text"
          >
            ESC
          </button>
        </div>

        <ul className="max-h-[340px] overflow-y-auto p-2" role="listbox" aria-label="页面列表">
          {matches.map((item, idx) => {
            const Icon = item.icon
            const active = isActive(path, item.to)
            const selected = idx === cursor
            return (
              <li key={item.to}>
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onMouseEnter={() => setCursor(idx)}
                  onClick={() => go(item.to)}
                  className={`flex w-full items-center justify-between gap-3 rounded-[11px] px-3 py-2.5 text-left transition-colors ${
                    selected ? 'bg-[#EEF5FF] text-apple-blueInk' : 'text-apple-text hover:bg-[#F5F5F7]'
                  }`}
                >
                  <span className="flex items-center gap-2.5 min-w-0">
                    <Icon className={`h-4 w-4 shrink-0 ${selected ? 'text-apple-blue' : 'text-apple-subtext'}`} />
                    <span className="truncate text-[13px] font-medium">{item.label}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2 text-[11px] text-apple-subtext">
                    {active && <span className="rounded bg-black/[0.06] px-1.5 py-0.5 text-[10px]">当前</span>}
                    <span>{item.group}</span>
                  </span>
                </button>
              </li>
            )
          })}
          {matches.length === 0 && (
            <li className="px-4 py-8 text-center text-[13px] text-apple-subtext">没有匹配的页面</li>
          )}
        </ul>
      </div>
    </div>
  )
}

export function Shell({ children }: { children: ReactNode }) {
  const { path } = useRouter()
  const system = useSystem()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const menuRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    setDrawerOpen(false)
  }, [path])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPaletteOpen((prev) => !prev)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const closeDrawer = () => {
    setDrawerOpen(false)
  }

  return (
    <div className="min-h-dvh font-sans text-apple-text">
      <Sidebar system={system} onOpenPalette={() => setPaletteOpen(true)} />

      <div className="lg:pl-[236px]">
        <header className="sticky top-0 z-20 border-b border-black/[0.06] bg-white/70 backdrop-blur-xl lg:hidden">
          <div className="flex h-14 items-center justify-between gap-3 px-4">
            <Brand />
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setPaletteOpen(true)}
                aria-label="快速跳转页面"
                className="inline-flex h-9 items-center gap-1 rounded-full border border-black/[0.08] bg-white/80 px-2.5 text-[11px] font-medium text-apple-subtext"
              >
                <span className="num">⌘K</span>
              </button>
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
          </div>
        </header>

        <main
          id="main-content"
          tabIndex={-1}
          className="mx-auto w-full max-w-[1360px] px-4 py-6 focus:outline-none sm:px-6 lg:px-8 lg:py-8"
        >
          <ErrorBoundary resetKey={path}>
            <div key={path} className="page-enter">
              {children}
            </div>
          </ErrorBoundary>
        </main>

        <footer className="mx-auto w-full max-w-[1360px] px-4 pb-10 text-[11px] leading-relaxed text-apple-subtext sm:px-6 lg:px-8">
          Kex Labs · 视频工作台 · 剧本生成视频与 AI 视频美化双轨制片平台
        </footer>
      </div>

      <MobileDrawer
        open={drawerOpen}
        onClose={closeDrawer}
        system={system}
        onOpenPalette={() => setPaletteOpen(true)}
        restoreFocusRef={menuRef}
      />

      <QuickRoutePalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  )
}
