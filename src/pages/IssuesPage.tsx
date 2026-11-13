import { useCallback, useEffect, useRef, useState } from 'react'
import { useIssues, type IssueFilter } from '../issues'
import type { IssueItem, IssueLabel } from '../types'
import { Skeleton } from '../components/lazy'
import { DEFAULT_PAGE_SIZE, Pagination } from '../components/Pagination'
import { Check, ChevronRight, Plus, Refresh } from '../components/icons'
import { IssueDetailDrawer } from '../components/IssueDetailDrawer'
import {
  ManualVerifyBadge,
  ManualVerifyControls,
  summarizeIssueBody
} from '../components/ManualVerify'

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

const subtleBadge = 'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset'
const neutralBadge = `${subtleBadge} bg-black/[0.03] text-apple-subtextAlt ring-black/[0.06]`

const FILTERS: { key: IssueFilter; label: string }[] = [
  { key: 'open', label: 'Open' },
  { key: 'all', label: '全部' },
  { key: 'closed', label: '已关闭' }
]

function formatShortDate(value: string | null): string {
  if (!value) return '无数据'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value.slice(0, 10)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function formatFullDate(value: string | null): string | undefined {
  if (!value) return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

/** 只认 API 给的 6 位 hex；其余按中性灰处理，不猜颜色。 */
function hexColor(color: string): string | null {
  const value = color.trim().replace(/^#/, '')
  return /^[0-9a-f]{6}$/i.test(value) ? `#${value}` : null
}

function LabelChip({ label }: { label: IssueLabel }) {
  const hex = hexColor(label.color)
  return (
    <span
      className={`${subtleBadge} max-w-full text-apple-text ring-black/[0.08]`}
      style={hex ? { backgroundColor: `${hex}14`, boxShadow: `inset 0 0 0 1px ${hex}33` } : undefined}
      title={label.name}
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

/** 从 labels 派生轨道 / 优先级；没有对应标签就不显示，不编造。 */
function derivePriority(item: IssueItem): string | null {
  const match = item.labels?.map((label) => label.name).find((name) => /^priority\/p[0-9]$/i.test(name))
  return match ? match.split('/')[1].toUpperCase() : null
}

function deriveRail(item: IssueItem): string | null {
  const names = item.labels?.map((label) => label.name) ?? []
  const rail = names.find((name) => /^rail\/.+/i.test(name))
  if (rail) return rail.split('/')[1]
  return names.find((name) => name === 'A轨' || name === 'B轨' || name === '双轨') ?? null
}

function IssueRow({
  item,
  highlighted,
  onOpen
}: {
  item: IssueItem
  highlighted: boolean
  onOpen: (number: number, trigger: HTMLElement) => void
}) {
  const { refresh } = useIssues()
  const status = item.status ?? 'open'
  const meta = STATUS_META[status]
  const labels = item.labels ?? []
  const hasPriorityLabel = labels.some((label) => /^priority\//i.test(label.name))
  const hasRailLabel = labels.some((label) => /^rail\//i.test(label.name))
  const priority = hasPriorityLabel ? null : derivePriority(item)
  const rail = hasRailLabel ? null : deriveRail(item)
  const summary = summarizeIssueBody(item.description)
  const href = item.url || null
  // #110：整卡打开详情抽屉（不再默认跳外链），键盘 Enter / Space 同效。
  const openDetail = (trigger: HTMLElement) => onOpen(item.number, trigger)

  return (
    <li data-testid="issue-row" data-issue-number={item.number}>
      <article
        role="button"
        tabIndex={0}
        aria-label={`查看 issue #${item.number} ${item.title}`}
        data-testid="issue-open"
        onClick={(event) => openDetail(event.currentTarget)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          openDetail(event.currentTarget)
        }}
        className={`card card-interactive cursor-pointer p-4 transition-[background-color,box-shadow] duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50 sm:p-5 ${
          highlighted ? 'highlight-flash ring-2 ring-apple-blue/40' : ''
        }`}
      >
        <div className="flex items-start gap-3">
          <span className="num shrink-0 rounded-md bg-[#F0F6FF] px-1.5 py-0.5 text-[11px] font-medium text-apple-blueInk">
            #{item.number}
          </span>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
              <h2 className="min-w-0 flex-1 break-words text-[15px] font-semibold leading-snug tracking-[-0.01em]">
                {item.title}
              </h2>
              <span className="flex shrink-0 items-center gap-1.5">
                {item.manual_verify && <ManualVerifyBadge state={item.manual_verify} />}
                <span className={`${subtleBadge} shrink-0 ${meta.className}`}>
                  <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
                  {meta.label}
                </span>
              </span>
            </div>

            {summary && (
              <p className="mt-1.5 line-clamp-2 break-words text-[12px] leading-relaxed text-apple-subtext">
                {summary}
              </p>
            )}

            {(labels.length > 0 || priority || rail) && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {labels.map((label) => (
                  <LabelChip key={label.name} label={label} />
                ))}
                {priority && <span className={neutralBadge}>优先级 {priority}</span>}
                {rail && <span className={neutralBadge}>{rail}</span>}
              </div>
            )}

            <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-apple-subtext">
              {item.owner && (
                <span className="inline-flex items-center gap-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-black/[0.18]" aria-hidden="true" />
                  {item.owner}
                </span>
              )}
              <span title={formatFullDate(item.updated_at)}>
                更新 <span className="num">{formatShortDate(item.updated_at ?? item.created_at)}</span>
              </span>
              {item.comments > 0 && (
                <span className="num">{item.comments} 条评论</span>
              )}
              {href ? (
                <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-apple-subtextAlt">
                  查看详情
                  <ChevronRight className="h-3 w-3" aria-hidden="true" />
                </span>
              ) : (
                <span className="ml-auto text-apple-subtext">无 Gitea 链接</span>
              )}
            </div>

            {item.manual_verify_key && (
              <div
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
              >
                <ManualVerifyControls
                  verifyKey={item.manual_verify_key}
                  number={item.number}
                  state={item.manual_verify}
                  note={item.manual_verify_note}
                  onSaved={() => refresh()}
                />
              </div>
            )}
          </div>
        </div>
      </article>
    </li>
  )
}

function FilterTabs() {
  const { filter, setFilter, counts, classification, showTaskCards } = useIssues()
  const countFor = (key: IssueFilter): number | null => {
    // 计数与服务端分类对齐：默认只算真实 issue，打开任务卡时再加任务卡。
    if (classification) {
      const real = classification.real
      const tasks = showTaskCards ? classification.task_cards : { open: 0, closed: 0, total: 0 }
      if (key === 'open') return real.open + tasks.open
      if (key === 'closed') return real.closed + tasks.closed
      return real.total + tasks.total
    }
    if (!counts) return null
    if (key === 'open') return counts.open
    if (key === 'closed') return counts.closed
    return counts.total
  }
  return (
    <div
      role="tablist"
      aria-label="Issue 状态筛选"
      className="inline-flex items-center gap-0.5 rounded-full bg-black/[0.04] p-0.5"
    >
      {FILTERS.map((entry) => {
        const active = filter === entry.key
        const count = countFor(entry.key)
        return (
          <button
            key={entry.key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => setFilter(entry.key)}
            className={`inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50 ${
              active
                ? 'bg-white text-apple-text shadow-soft'
                : 'text-apple-subtext hover:text-apple-text'
            }`}
          >
            {entry.label}
            {count != null && (
              <span className={`num text-[11px] ${active ? 'text-apple-subtext' : 'text-apple-subtextAlt'}`}>
                {count}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

function EmptyState() {
  const { filter, openDialog } = useIssues()
  const copy =
    filter === 'open'
      ? ['没有打开的 issue', '仓库当前没有待处理项；切换「已关闭」查看历史。']
      : filter === 'closed'
        ? ['没有已关闭的 issue', '关闭的 issue 会出现在这里。']
        : ['仓库里还没有 issue', '创建第一条，记录要跟进的问题。']
  return (
    <div className="card mt-5 p-8 text-center">
      <p className="text-sm font-medium text-apple-text">{copy[0]}</p>
      <p className="mt-1 text-xs leading-relaxed text-apple-subtext">{copy[1]}</p>
      {filter !== 'closed' && (
        <button
          type="button"
          onClick={openDialog}
          className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-full bg-apple-blue px-3.5 text-xs font-medium text-white transition-colors hover:bg-[#0062C4] focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
        >
          <Plus className="h-3.5 w-3.5" />
          新建 issue
        </button>
      )}
    </div>
  )
}

type IssueKindParam = 'real' | 'all'

type UrlFilters = { filter: IssueFilter; kind: IssueKindParam; page: number }

const URL_FILTERS: IssueFilter[] = ['open', 'closed', 'all']

/**
 * 读 URL 上的筛选状态：`state=open|closed|all`、`kind=real|all`、`page=N`。
 * 非法值归一化为默认值（open / real / 1），`dirty` 表示 URL 需要 replaceState 清理。
 */
function parseUrlFilters(): { filters: UrlFilters; dirty: boolean } {
  const params = new URLSearchParams(window.location.search)
  const rawState = params.get('state')
  const rawKind = params.get('kind')
  const rawPage = params.get('page')
  const filter = URL_FILTERS.find((value) => value === rawState) ?? 'open'
  const kind: IssueKindParam = rawKind === 'all' ? 'all' : 'real'
  const parsedPage = rawPage === null ? 1 : Number(rawPage)
  const page = Number.isInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1
  const dirty =
    (rawState !== null && rawState !== filter) ||
    (rawKind !== null && rawKind !== kind) ||
    (rawPage !== null && page !== parsedPage)
  return { filters: { filter, kind, page }, dirty }
}

/** 写筛选状态到 URL；只动这三个参数，保留其它 query 与 hash。page=1 时省略。 */
function writeUrlFilters(next: UrlFilters, mode: 'push' | 'replace'): void {
  const url = new URL(window.location.href)
  url.searchParams.set('state', next.filter)
  url.searchParams.set('kind', next.kind)
  if (next.page <= 1) url.searchParams.delete('page')
  else url.searchParams.set('page', String(next.page))
  const target = `${url.pathname}${url.search}${url.hash}`
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`
  if (target === current) return
  if (mode === 'push') window.history.pushState({}, '', target)
  else window.history.replaceState({}, '', target)
}

export function IssuesPage() {
  const {
    status,
    data,
    error,
    retry,
    refresh,
    openDialog,
    highlightId,
    counts,
    classification,
    showTaskCards,
    setShowTaskCards,
    repo,
    lastCreated,
    filter,
    setFilter
  } = useIssues()
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)
  const [page, setPage] = useState<number>(() => parseUrlFilters().filters.page)
  // #110：详情抽屉 —— 记住触发项，关闭时把焦点还回去。
  const [detail, setDetail] = useState<{ number: number; trigger: HTMLElement | null } | null>(null)
  const openDetail = useCallback((number: number, trigger: HTMLElement) => {
    setDetail({ number, trigger })
  }, [])
  // 首次挂载时 URL→状态的同步不算「筛选变化」，不回写 URL、也不重置页码。
  const firstFilterSync = useRef(true)

  const items = status === 'ready' ? data.items : []
  const total = items.length
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const currentPage = Math.min(Math.max(1, page), totalPages)
  const startIndex = total === 0 ? 0 : (currentPage - 1) * pageSize
  const endIndex = Math.min(startIndex + pageSize, total)
  const pageItems = items.slice(startIndex, endIndex)
  const highlightIndex =
    status === 'ready' && highlightId ? data.items.findIndex((item) => item.id === highlightId) : -1

  // 直接打开 / popstate：URL 同时恢复 filter / kind / page（非法值就地归一化）。
  useEffect(() => {
    const apply = () => {
      const { filters, dirty } = parseUrlFilters()
      if (dirty) writeUrlFilters(filters, 'replace')
      setFilter(filters.filter)
      setShowTaskCards(filters.kind === 'all')
      setPage(filters.page)
    }
    apply()
    window.addEventListener('popstate', apply)
    return () => window.removeEventListener('popstate', apply)
  }, [setFilter, setShowTaskCards])

  // 点击筛选/任务卡开关：URL 跟上，页码回 1；URL 已一致（恢复场景）则不动。
  useEffect(() => {
    const kind: IssueKindParam = showTaskCards ? 'all' : 'real'
    if (firstFilterSync.current) {
      firstFilterSync.current = false
      return
    }
    const current = parseUrlFilters().filters
    if (current.filter === filter && current.kind === kind) return
    setPage(1)
    writeUrlFilters({ filter, kind, page: 1 }, 'push')
  }, [filter, showTaskCards])

  // 越界/非法页码钳到合法页；用 replace 避免污染历史。
  useEffect(() => {
    if (status !== 'ready' || page === currentPage) return
    setPage(currentPage)
    writeUrlFilters({ filter, kind: showTaskCards ? 'all' : 'real', page: currentPage }, 'replace')
  }, [status, page, currentPage, filter, showTaskCards])

  // 新建 issue 后跳到它所在页并高亮。
  useEffect(() => {
    if (highlightIndex < 0) return
    const target = Math.floor(highlightIndex / pageSize) + 1
    if (target === currentPage) return
    setPage(target)
    writeUrlFilters({ filter, kind: showTaskCards ? 'all' : 'real', page: target }, 'replace')
  }, [highlightIndex, pageSize, currentPage, filter, showTaskCards])

  const goToPage = useCallback(
    (next: number) => {
      const target = Math.min(Math.max(1, next), totalPages)
      if (target === currentPage) return
      setPage(target)
      writeUrlFilters({ filter, kind: showTaskCards ? 'all' : 'real', page: target }, 'push')
    },
    [currentPage, totalPages, filter, showTaskCards]
  )

  const changePageSize = useCallback(
    (size: number) => {
      setPageSize(size)
      setPage(1)
      writeUrlFilters({ filter, kind: showTaskCards ? 'all' : 'real', page: 1 }, 'replace')
    },
    [filter, showTaskCards]
  )

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em] sm:text-[34px]">Issue 收件箱</h1>
          <p className="mt-1.5 max-w-[64ch] text-sm leading-relaxed text-apple-subtext">
            实时读取 Gitea 仓库 <span className="num">{repo ?? 'gitadmin/kex-labs-video'}</span> 的 issue，
            状态、标签与链接以 Gitea 为准；不可用时如实报错，不回退本地数据。
          </p>
        </div>

        <div className="flex items-center gap-3">
          {status === 'ready' && (classification || counts) && (
            <p className="text-xs text-apple-subtext" data-testid="issues-counts">
              真实 issue{' '}
              <span className="num text-sm font-medium text-apple-text">
                {classification?.real.open ?? counts?.open ?? 0}
              </span>
              <span className="mx-1 text-apple-line">/</span>
              任务卡{' '}
              <span className="num text-sm font-medium text-apple-text">
                {classification?.task_cards.open ?? 0}
              </span>
            </p>
          )}
          <button
            type="button"
            onClick={openDialog}
            className="inline-flex h-9 items-center gap-1.5 rounded-full bg-apple-blue px-4 text-[13px] font-medium text-white transition-colors hover:bg-[#0062C4] focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
          >
            <Plus className="h-4 w-4" />
            新建 issue
          </button>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <FilterTabs />
        <label className="inline-flex cursor-pointer items-center gap-2 text-[11px] text-apple-subtext">
          <input
            type="checkbox"
            role="switch"
            checked={showTaskCards}
            onChange={(event) => setShowTaskCards(event.target.checked)}
            data-testid="show-task-cards"
            className="h-3.5 w-3.5 rounded border-black/[0.2] accent-apple-blue focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
          />
          显示任务卡
          {classification && (
            <span className="num text-apple-subtextAlt">{classification.task_cards.total}</span>
          )}
        </label>
        {status === 'ready' && total > 0 && (
          <span className="text-[11px] text-apple-subtext" data-testid="issues-range">
            第 {startIndex + 1}–{endIndex} 条 / 共 {total} 条
          </span>
        )}
      </div>

      {lastCreated && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-5 left-1/2 z-[70] flex -translate-x-1/2 items-center gap-2 rounded-full bg-apple-text px-3.5 py-2 text-[13px] font-medium text-white shadow-lift"
        >
          <Check className="h-4 w-4" />
          已创建 #{lastCreated.number}
        </div>
      )}

      {status === 'loading' && (
        <div className="mt-5 space-y-2.5" aria-busy="true" aria-label="加载 issue 列表">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className="h-[92px] w-full" />
          ))}
        </div>
      )}

      {status === 'error' && (
        <div className="card mt-5 p-6">
          <p className="text-sm font-medium text-apple-text">Gitea issue 列表不可用</p>
          <p className="mt-1 break-words text-xs leading-relaxed text-apple-subtext">{error}</p>
          <p className="mt-1 text-[11px] leading-relaxed text-apple-subtextAlt">
            页面只展示 Gitea 数据，不会退回本地 issue 目录。
          </p>
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

      {status === 'ready' && data.count === 0 && <EmptyState />}

      {status === 'ready' && total > 0 && (
        <>
          <ul className="mt-5 space-y-2.5" aria-label="issue 列表">
            {pageItems.map((item) => (
              <IssueRow
                key={item.id}
                item={item}
                highlighted={highlightId === item.id}
                onOpen={openDetail}
              />
            ))}
          </ul>
          <Pagination
            page={currentPage}
            pageSize={pageSize}
            total={total}
            onPageChange={goToPage}
            onPageSizeChange={changePageSize}
          />
        </>
      )}

      <IssueDetailDrawer
        issueNumber={detail?.number ?? null}
        returnFocus={detail?.trigger ?? null}
        onClose={() => setDetail(null)}
        onCommented={() => refresh()}
      />
    </div>
  )
}
