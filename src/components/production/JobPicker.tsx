import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from '../../router'
import { formatTime } from '../flow/flow-utils'
import type { Delivery, FlowJobStatus, FlowJobSummary } from '../../types'
import { ArrowLeft, Check, ChevronDown, ChevronRight, Film, Search } from '../icons'

export type JobDisplayStatus = FlowJobStatus | 'stale'
export type JobStatusFilter = 'all' | 'active' | 'done' | 'attention'

export type EnrichedJobItem = {
  id: string
  title: string
  status: JobDisplayStatus
  statusLabel: string
  statusTitle: string
  updatedAt: string
}

export const JOB_STATUS_LABEL: Record<JobDisplayStatus, string> = {
  queued: '排队中',
  running: '渲染中',
  succeeded: '已完成',
  failed: '失败',
  canceled: '已取消',
  stale: '状态停滞',
  unknown: '状态未知'
}

const SOURCE_LABEL = {
  state: '状态文件',
  intake: 'intake 队列',
  unknown: '无状态来源'
} as const

/** Stale only applies to jobs that still claim to be active. */
export function resolveJobDisplayStatus(
  job: Pick<FlowJobSummary, 'status' | 'stale'>
): JobDisplayStatus {
  const status = job.status ?? 'unknown'
  if (job.stale && (status === 'running' || status === 'queued')) return 'stale'
  return status
}

export function isActiveJobStatus(status: JobDisplayStatus): boolean {
  return status === 'running' || status === 'queued'
}

export function jobStatusHint(
  job: Pick<FlowJobSummary, 'status' | 'stale' | 'status_source' | 'updated_at'>
): string {
  const display = resolveJobDisplayStatus(job)
  const source = SOURCE_LABEL[job.status_source] ?? SOURCE_LABEL.unknown
  const updated = job.updated_at ? `最后更新 ${formatTime(job.updated_at)}` : '最后更新时间未知'
  const reason =
    display === 'stale'
      ? '；超过停滞阈值仍无新状态，按「状态停滞」展示'
      : display === 'unknown'
        ? '；未记录状态，不推断为渲染中'
        : ''
  return `${JOB_STATUS_LABEL[display]} · 来源：${source} · ${updated}${reason}`
}

function matchesFilter(status: JobDisplayStatus, filter: JobStatusFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'active') return isActiveJobStatus(status)
  if (filter === 'done') return status === 'succeeded'
  return status === 'stale' || status === 'unknown' || status === 'failed' || status === 'canceled'
}

export function enrichAndFilterJobs(
  jobs: FlowJobSummary[],
  deliveries: Delivery[],
  query: string,
  statusFilter: JobStatusFilter
): EnrichedJobItem[] {
  const deliveryById = new Map<string, Delivery>()
  for (const d of deliveries) {
    deliveryById.set(d.jobId, d)
  }

  const enriched: EnrichedJobItem[] = jobs.map((j) => {
    // Delivery only supplies a readable title; it never decides runtime status.
    const deliv = deliveryById.get(j.id)
    const status = resolveJobDisplayStatus(j)
    return {
      id: j.id,
      title: deliv?.title?.trim() || j.id,
      status,
      statusLabel: JOB_STATUS_LABEL[status],
      statusTitle: jobStatusHint(j),
      updatedAt: j.updated_at
    }
  })

  // Sort newest first by updatedAt timestamp
  enriched.sort((a, b) => Date.parse(b.updatedAt || '') - Date.parse(a.updatedAt || ''))

  return enriched.filter(
    (item) => matchesFilter(item.status, statusFilter) && jobMatchesQuery(item, query)
  )
}

export function jobMatchesQuery(item: EnrichedJobItem, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return (
    item.id.toLowerCase().includes(needle) ||
    item.title.toLowerCase().includes(needle) ||
    item.statusLabel.toLowerCase().includes(needle)
  )
}

/** #96：activeOnly 下拉里附带的「已结束 · 历史查看」项，不参与活跃计数。 */
export const HISTORY_VIEW_BADGE = '已结束 · 历史查看'

/**
 * #96：总台只追踪活跃任务，但 URL `?job=<历史 id>` 仍需可查看。
 * 选中的非活跃任务作为单独一项追加到 cycleList 末尾，避免下拉计数为 0 / 空白。
 */
export function selectCycleJobs(
  allSorted: EnrichedJobItem[],
  activeItems: EnrichedJobItem[],
  selectedJobId: string | null,
  activeOnly: boolean
): { cycleList: EnrichedJobItem[]; selectedHistoryItem: EnrichedJobItem | null } {
  if (!activeOnly) return { cycleList: allSorted, selectedHistoryItem: null }
  const selected = selectedJobId
    ? allSorted.find((item) => item.id === selectedJobId) ?? null
    : null
  const selectedHistoryItem =
    selected && !isActiveJobStatus(selected.status) ? selected : null
  return {
    cycleList: selectedHistoryItem ? [...activeItems, selectedHistoryItem] : activeItems,
    selectedHistoryItem
  }
}

export type JobPickerModel = {
  allSorted: EnrichedJobItem[]
  activeList: EnrichedJobItem[]
  cycleList: EnrichedJobItem[]
  filtered: EnrichedJobItem[]
  selectedHistoryItem: EnrichedJobItem | null
  activeCount: number
  doneCount: number
  staleCount: number
  unknownCount: number
  attentionCount: number
  emptyMessage: string
}

export function buildJobPickerModel(
  jobs: FlowJobSummary[],
  deliveries: Delivery[],
  selectedJobId: string | null,
  activeOnly: boolean,
  query = '',
  statusFilter: JobStatusFilter = 'all'
): JobPickerModel {
  const allSorted = enrichAndFilterJobs(jobs, deliveries, '', 'all')
  const activeList = allSorted.filter((item) => isActiveJobStatus(item.status))
  const { cycleList, selectedHistoryItem } = selectCycleJobs(
    allSorted,
    activeList,
    selectedJobId,
    activeOnly
  )

  const baseFiltered = enrichAndFilterJobs(
    jobs,
    deliveries,
    query,
    activeOnly ? 'active' : statusFilter
  )
  const filtered =
    activeOnly &&
    selectedHistoryItem &&
    jobMatchesQuery(selectedHistoryItem, query) &&
    !baseFiltered.some((item) => item.id === selectedHistoryItem.id)
      ? [...baseFiltered, selectedHistoryItem]
      : baseFiltered

  const activeCount = activeList.length
  const doneCount = allSorted.filter((item) => item.status === 'succeeded').length
  const staleCount = allSorted.filter((item) => item.status === 'stale').length
  const unknownCount = allSorted.filter((item) => item.status === 'unknown').length
  const emptyMessage =
    activeOnly && activeCount === 0 && !selectedHistoryItem
      ? '当前没有正在渲染或执行中的任务'
      : '没有匹配当前搜索条件的活跃任务'

  return {
    allSorted,
    activeList,
    cycleList,
    filtered,
    selectedHistoryItem,
    activeCount,
    doneCount,
    staleCount,
    unknownCount,
    attentionCount: allSorted.length - activeCount - doneCount,
    emptyMessage
  }
}

export type TrackerHeadline = {
  isActive: boolean
  historyView: boolean
  headline: string
}

/**
 * #96：总台头部只显示活跃任务；`?job=` 指向已完成 / 不存在时不冒充「正在渲染」，
 * 改为明确的历史查看状态。
 */
export function resolveTrackerHeadline(
  jobs: FlowJobSummary[],
  selectedJobId: string | null | undefined,
  loading: boolean
): TrackerHeadline {
  const summary = selectedJobId
    ? jobs.find((item) => item.id === selectedJobId) ?? null
    : null
  const isActive = summary ? isActiveJobStatus(resolveJobDisplayStatus(summary)) : false
  if (isActive && summary) {
    return { isActive: true, historyView: false, headline: summary.id }
  }
  return {
    isActive: false,
    historyView: Boolean(selectedJobId) && !loading,
    headline: loading ? '读取中…' : '当前无渲染中任务'
  }
}

function statusDotClass(status: JobDisplayStatus): string {
  if (status === 'succeeded') return 'bg-[#30A14E]'
  if (status === 'failed') return 'bg-apple-red'
  if (status === 'running' || status === 'queued') return 'bg-apple-blue'
  return 'bg-apple-subtext/40'
}

function statusTextClass(status: JobDisplayStatus): string {
  if (status === 'succeeded') return 'text-[#1E7A3C]'
  if (status === 'failed') return 'text-[#B3261E]'
  if (status === 'running' || status === 'queued') return 'text-apple-blueInk'
  return 'text-apple-subtext'
}

export function JobPicker({
  jobs,
  deliveries,
  selectedJobId,
  activeOnly = true,
  onSelectJob
}: {
  jobs: FlowJobSummary[]
  deliveries: Delivery[]
  selectedJobId: string | null
  activeOnly?: boolean
  onSelectJob: (jobId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<JobStatusFilter>(activeOnly ? 'active' : 'all')
  const containerRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  const {
    allSorted,
    cycleList,
    filtered,
    selectedHistoryItem,
    activeCount,
    doneCount,
    staleCount,
    unknownCount,
    attentionCount,
    emptyMessage
  } = useMemo(
    () => buildJobPickerModel(jobs, deliveries, selectedJobId, activeOnly, query, statusFilter),
    [jobs, deliveries, selectedJobId, activeOnly, query, statusFilter]
  )

  const activeIndex = useMemo(() => {
    const idx = cycleList.findIndex((j) => j.id === selectedJobId)
    return idx >= 0 ? idx : 0
  }, [cycleList, selectedJobId])

  const activeItem = cycleList[activeIndex] ?? null

  useEffect(() => {
    if (!open) return
    const timer = window.setTimeout(() => searchInputRef.current?.focus(), 30)
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    const onPointerDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('mousedown', onPointerDown)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('mousedown', onPointerDown)
    }
  }, [open])

  const stepPrev = () => {
    if (cycleList.length <= 1) return
    const nextIdx = (activeIndex - 1 + cycleList.length) % cycleList.length
    onSelectJob(cycleList[nextIdx].id)
  }

  const stepNext = () => {
    if (cycleList.length <= 1) return
    const nextIdx = (activeIndex + 1) % cycleList.length
    onSelectJob(cycleList[nextIdx].id)
  }

  return (
    <div ref={containerRef} className="relative flex items-center gap-1">
      <div className="flex items-center rounded-[10px] border border-black/[0.08] bg-white p-0.5 shadow-sm">
        <button
          type="button"
          onClick={stepPrev}
          disabled={cycleList.length <= 1}
          aria-label="上一个活跃视频任务"
          title="上一个活跃视频任务"
          className="grid h-8 w-7 place-items-center rounded-lg text-apple-subtext transition-colors hover:bg-apple-bg hover:text-apple-text disabled:opacity-35"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>

        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          aria-expanded={open}
          aria-haspopup="listbox"
          data-testid="production-job-picker-trigger"
          className="flex h-8 min-w-[210px] max-w-[300px] items-center justify-between gap-2 rounded-lg px-2.5 text-left transition-colors hover:bg-apple-bg"
        >
          <span className="flex min-w-0 items-center gap-2" title={activeItem?.statusTitle}>
            <span
              aria-hidden="true"
              className={`h-2 w-2 shrink-0 rounded-full ${
                activeItem
                  ? `${statusDotClass(activeItem.status)} ${
                      isActiveJobStatus(activeItem.status) ? 'flow-node-pulse' : ''
                    }`
                  : 'bg-apple-subtext/40'
              }`}
            />
            <span className="truncate text-xs font-medium text-apple-text">
              {activeItem
                ? activeItem.title
                : jobs.length === 0
                  ? '读取视频任务…'
                  : '暂无正在渲染的任务'}
            </span>
            {activeItem && !isActiveJobStatus(activeItem.status) && (
              <span className="shrink-0 rounded bg-[#F5F5F7] px-1 py-0.5 text-[9.5px] font-medium text-apple-subtext">
                已结束
              </span>
            )}
          </span>
          <span className="flex shrink-0 items-center gap-1 text-[11px] text-apple-subtext">
            <span className="num">
              {cycleList.length > 0 ? `${activeIndex + 1}/${cycleList.length}` : '0'}
            </span>
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
          </span>
        </button>

        <button
          type="button"
          onClick={stepNext}
          disabled={cycleList.length <= 1}
          aria-label="下一个活跃视频任务"
          title="下一个活跃视频任务"
          className="grid h-8 w-7 place-items-center rounded-lg text-apple-subtext transition-colors hover:bg-apple-bg hover:text-apple-text disabled:opacity-35"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>

      {open && (
        <div
          role="dialog"
          aria-label="切换追踪的活跃视频任务"
          data-testid="production-job-picker-popover"
          className="absolute right-0 top-[calc(100%+6px)] z-40 w-[350px] max-w-[92vw] overflow-hidden rounded-[14px] border border-black/[0.08] bg-white shadow-xl"
        >
          {/* Search Input */}
          <div className="border-b border-black/[0.06] p-2.5">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-apple-subtext" />
              <input
                ref={searchInputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索任务 ID 或片名…"
                className="h-8 w-full rounded-lg border border-black/[0.08] bg-[#FAFAFB] pl-8 pr-3 text-xs text-apple-text placeholder:text-apple-subtext/70 focus:border-apple-blue focus:bg-white focus:outline-none"
              />
            </div>

            {activeOnly ? (
              <div className="mt-2 space-y-1 text-[11px] text-apple-subtext">
                <div className="flex items-center justify-between">
                  <span>仅展示运行中 / 排队中（{activeCount}）</span>
                  {doneCount > 0 && (
                    <Link
                      to="/deliveries"
                      onClick={() => setOpen(false)}
                      className="font-medium text-apple-blueInk hover:underline"
                    >
                      历史成片 {doneCount} 支 →
                    </Link>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span>状态停滞 {staleCount}</span>
                  <span aria-hidden="true">·</span>
                  <span>状态未知 {unknownCount}</span>
                </div>
                {selectedHistoryItem && (
                  <div
                    data-testid="production-job-picker-history-note"
                    className="text-[11px] text-apple-subtext"
                  >
                    另附历史查看 1（{selectedHistoryItem.id}）· 不计入活跃队列
                  </div>
                )}
              </div>
            ) : (
              <div className="mt-2 space-y-1.5 text-[11px]">
                <div className="flex items-center gap-1">
                  {(
                    [
                      { key: 'all', label: `全部 ${allSorted.length}` },
                      { key: 'active', label: `渲染中 ${activeCount}` },
                      { key: 'done', label: `已完成 ${doneCount}` },
                      { key: 'attention', label: `需关注 ${attentionCount}` }
                    ] as const
                  ).map((tab) => (
                    <button
                      key={tab.key}
                      type="button"
                      onClick={() => setStatusFilter(tab.key)}
                      className={`rounded-md px-2 py-1 font-medium transition-colors ${
                        statusFilter === tab.key
                          ? 'bg-apple-text text-white'
                          : 'bg-[#F5F5F7] text-apple-subtext hover:text-apple-text'
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-2 text-apple-subtext">
                  <span>状态停滞 {staleCount}</span>
                  <span aria-hidden="true">·</span>
                  <span>状态未知 {unknownCount}</span>
                </div>
              </div>
            )}
          </div>

          {/* Scrollable List */}
          <ul role="listbox" className="max-h-[280px] divide-y divide-black/[0.05] overflow-y-auto p-1">
            {filtered.length === 0 ? (
              <li className="flex flex-col items-center justify-center px-4 py-8 text-center">
                <Film className="h-5 w-5 text-apple-subtext/60" />
                <p className="mt-1.5 text-xs text-apple-subtext">{emptyMessage}</p>
                {activeOnly && doneCount > 0 && (
                  <Link
                    to="/deliveries"
                    onClick={() => setOpen(false)}
                    className="mt-2 text-xs font-medium text-apple-blueInk hover:underline"
                  >
                    前往交付与资产查看历史成片 →
                  </Link>
                )}
              </li>
            ) : (
              filtered.map((item) => {
                const isSelected = item.id === activeItem?.id
                const isHistoryView = activeOnly && !isActiveJobStatus(item.status)
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      data-history-view={isHistoryView || undefined}
                      onClick={() => {
                        onSelectJob(item.id)
                        setOpen(false)
                      }}
                      className={`flex w-full items-start justify-between gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${
                        isSelected ? 'bg-[#EAF2FF]' : 'hover:bg-[#FAFAFB]'
                      }`}
                    >
                      <div className="min-w-0 flex-1" title={item.statusTitle}>
                        <div className="flex items-center gap-1.5">
                          <span
                            className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDotClass(item.status)}`}
                          />
                          <span className="truncate text-[12.5px] font-medium text-apple-text">
                            {item.title}
                          </span>
                          {isHistoryView && (
                            <span className="shrink-0 rounded-full bg-[#F5F5F7] px-1.5 py-0.5 text-[9.5px] font-medium text-apple-subtext">
                              {HISTORY_VIEW_BADGE}
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 flex items-center gap-2 text-[10.5px] text-apple-subtext">
                          <span className="truncate font-mono">{item.id}</span>
                          <span aria-hidden="true">·</span>
                          <span className="num shrink-0">{formatTime(item.updatedAt)}</span>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5 pt-0.5" title={item.statusTitle}>
                        <span className={`text-[10.5px] font-medium ${statusTextClass(item.status)}`}>
                          {item.statusLabel}
                        </span>
                        {isSelected && <Check className="h-3.5 w-3.5 text-apple-blueInk" />}
                      </div>
                    </button>
                  </li>
                )
              })
            )}
          </ul>
        </div>
      )}
    </div>
  )
}
