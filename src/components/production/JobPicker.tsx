import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from '../../router'
import { formatTime } from '../flow/flow-utils'
import type { Delivery, FlowJobSummary } from '../../types'
import { ArrowLeft, Check, ChevronDown, ChevronRight, Film, Search } from '../icons'

export type JobStatusFilter = 'all' | 'rendering' | 'delivered'

export type EnrichedJobItem = {
  id: string
  title: string
  status: 'rendering' | 'delivered'
  statusLabel: string
  updatedAt: string
}

export function enrichAndFilterJobs(
  jobs: FlowJobSummary[],
  deliveries: Delivery[],
  query: string,
  statusFilter: JobStatusFilter,
  currentJobId?: string | null,
  currentJobStage?: string | null
): EnrichedJobItem[] {
  const deliveryById = new Map<string, Delivery>()
  for (const d of deliveries) {
    deliveryById.set(d.jobId, d)
  }

  const enriched: EnrichedJobItem[] = jobs.map((j) => {
    const deliv = deliveryById.get(j.id)
    const isCurrentDone = currentJobId === j.id && (currentJobStage === 'F' || currentJobStage === 'done')
    const isDelivered = Boolean(deliv) || isCurrentDone
    const title = deliv?.title?.trim() || j.id
    return {
      id: j.id,
      title,
      status: isDelivered ? 'delivered' : 'rendering',
      statusLabel: isDelivered ? '已成片' : '渲染中',
      updatedAt: j.updated_at
    }
  })

  // Sort newest first by updatedAt timestamp
  enriched.sort((a, b) => Date.parse(b.updatedAt || '') - Date.parse(a.updatedAt || ''))

  const needle = query.trim().toLowerCase()
  return enriched.filter((item) => {
    if (statusFilter !== 'all' && item.status !== statusFilter) return false
    if (!needle) return true
    return (
      item.id.toLowerCase().includes(needle) ||
      item.title.toLowerCase().includes(needle) ||
      item.statusLabel.toLowerCase().includes(needle)
    )
  })
}

export function JobPicker({
  jobs,
  deliveries,
  selectedJobId,
  currentJobStage,
  activeOnly = true,
  onSelectJob
}: {
  jobs: FlowJobSummary[]
  deliveries: Delivery[]
  selectedJobId: string | null
  currentJobStage?: string | null
  activeOnly?: boolean
  onSelectJob: (jobId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<JobStatusFilter>(activeOnly ? 'rendering' : 'all')
  const containerRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  const allSorted = useMemo(
    () => enrichAndFilterJobs(jobs, deliveries, '', 'all', selectedJobId, currentJobStage),
    [jobs, deliveries, selectedJobId, currentJobStage]
  )

  const renderingList = useMemo(
    () => allSorted.filter((j) => j.status === 'rendering'),
    [allSorted]
  )

  const cycleList = activeOnly ? renderingList : allSorted

  const filtered = useMemo(
    () =>
      enrichAndFilterJobs(
        jobs,
        deliveries,
        query,
        activeOnly ? 'rendering' : statusFilter,
        selectedJobId,
        currentJobStage
      ),
    [jobs, deliveries, query, activeOnly, statusFilter, selectedJobId, currentJobStage]
  )

  const activeIndex = useMemo(() => {
    const idx = cycleList.findIndex((j) => j.id === selectedJobId)
    return idx >= 0 ? idx : 0
  }, [cycleList, selectedJobId])

  const activeItem = cycleList[activeIndex] ?? null

  const renderingCount = renderingList.length
  const deliveredCount = allSorted.length - renderingCount

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
          aria-label="上一个正在渲染的视频任务"
          title="上一个正在渲染的视频任务"
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
          <span className="flex min-w-0 items-center gap-2">
            <span
              aria-hidden="true"
              className={`h-2 w-2 shrink-0 rounded-full ${
                activeItem
                  ? activeItem.status === 'delivered'
                    ? 'bg-[#30A14E]'
                    : 'bg-apple-blue flow-node-pulse'
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
          aria-label="下一个正在渲染的视频任务"
          title="下一个正在渲染的视频任务"
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
                placeholder="搜索正在渲染的任务 ID 或片名…"
                className="h-8 w-full rounded-lg border border-black/[0.08] bg-[#FAFAFB] pl-8 pr-3 text-xs text-apple-text placeholder:text-apple-subtext/70 focus:border-apple-blue focus:bg-white focus:outline-none"
              />
            </div>

            {activeOnly ? (
              <div className="mt-2 flex items-center justify-between text-[11px] text-apple-subtext">
                <span>仅展示当前正在渲染 / 执行中（{renderingCount}）</span>
                {deliveredCount > 0 && (
                  <Link
                    to="/deliveries"
                    onClick={() => setOpen(false)}
                    className="font-medium text-apple-blueInk hover:underline"
                  >
                    历史 {deliveredCount} 支 →
                  </Link>
                )}
              </div>
            ) : (
              <div className="mt-2 flex items-center gap-1 text-[11px]">
                {(
                  [
                    { key: 'all', label: `全部 ${allSorted.length}` },
                    { key: 'rendering', label: `渲染中 ${renderingCount}` },
                    { key: 'delivered', label: `已成片 ${deliveredCount}` }
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
            )}
          </div>

          {/* Scrollable List */}
          <ul role="listbox" className="max-h-[280px] divide-y divide-black/[0.05] overflow-y-auto p-1">
            {filtered.length === 0 ? (
              <li className="flex flex-col items-center justify-center px-4 py-8 text-center">
                <Film className="h-5 w-5 text-apple-subtext/60" />
                <p className="mt-1.5 text-xs text-apple-subtext">
                  {activeOnly && renderingCount === 0
                    ? '当前没有正在渲染或执行中的任务'
                    : '没有匹配当前搜索条件的活跃任务'}
                </p>
                {activeOnly && deliveredCount > 0 && (
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
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      onClick={() => {
                        onSelectJob(item.id)
                        setOpen(false)
                      }}
                      className={`flex w-full items-start justify-between gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${
                        isSelected ? 'bg-[#EAF2FF]' : 'hover:bg-[#FAFAFB]'
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span
                            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                              item.status === 'delivered' ? 'bg-[#30A14E]' : 'bg-apple-blue'
                            }`}
                          />
                          <span className="truncate text-[12.5px] font-medium text-apple-text">
                            {item.title}
                          </span>
                        </div>
                        <div className="mt-0.5 flex items-center gap-2 text-[10.5px] text-apple-subtext">
                          <span className="truncate font-mono">{item.id}</span>
                          <span>·</span>
                          <span className="num shrink-0">{formatTime(item.updatedAt)}</span>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
                        <span
                          className={`text-[10.5px] font-medium ${
                            item.status === 'delivered' ? 'text-[#1E7A3C]' : 'text-apple-blueInk'
                          }`}
                        >
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
