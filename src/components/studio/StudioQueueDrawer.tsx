import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { getJson, postJson, useLiveJson } from '../../api'
import { MEDIA_JOBS_URL, mediaItemsOf, type MediaJobsResponse } from '../../media-jobs'
import type { MediaJobsState } from './StudioMediaAssets'
import { formatClockMs, formatStamp } from '../../format'
import { formatHttpError, useCopyToClipboard, useInfiniteScrollBatch, useModalA11y } from '../../hooks'
import type { StudioBrief, StudioJob, StudioJobStatus, StudioJobSummary } from '../../types'
import { ChevronRight, Clapper, Plus, Refresh } from '../icons'
import { SnapshotStatusStage } from '../SnapshotStatusStage'
import { StudioStatusChip } from '../StudioStatusChip'
import { primaryButton, quietButton } from '../studio-ui'
import { FilterChipGroup } from '../ui'
import { StudioJobDetail } from './StudioJobDetail'

type QueueFilter = 'all' | StudioJobStatus

function EmptyQueue({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="px-6 py-16 text-center">
      <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-apple-bg text-apple-subtext">
        <Clapper className="h-5 w-5" />
      </span>
      <p className="mt-3 text-sm font-medium">还没有创作任务</p>
      <p className="mx-auto mt-1 max-w-[34ch] text-xs leading-relaxed text-apple-subtext">
        studio 队列为空。上传一段视频素材，即可提交第一个 A 轨任务。
      </p>
      <button type="button" onClick={onCreate} className={`${primaryButton} mt-4`}>
        创建第一个任务
      </button>
    </div>
  )
}

function LoadingRows() {
  return (
    <ul className="divide-y divide-black/[0.06]" aria-busy="true" aria-label="加载任务列表">
      {[0, 1, 2].map((index) => (
        <li key={index} className="animate-pulse px-4 py-4 motion-reduce:animate-none">
          <div className="flex items-center gap-3">
            <span className="h-5 w-16 rounded-full bg-black/[0.06]" />
            <span className="h-3.5 w-40 rounded bg-black/[0.06]" />
          </div>
          <div className="mt-2 h-3 w-56 rounded bg-black/[0.04]" />
        </li>
      ))}
    </ul>
  )
}

function JobRow({
  job,
  briefs,
  highlighted,
  defaultExpanded = false,
  focusSignal,
  onRefresh,
  media
}: {
  job: StudioJobSummary
  briefs: StudioBrief[]
  highlighted: boolean
  defaultExpanded?: boolean
  focusSignal?: number
  onRefresh: () => void
  media: MediaJobsState
}) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [detail, setDetail] = useState<StudioJob | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailNonce, setDetailNonce] = useState(0)
  const [brief, setBrief] = useState<StudioBrief | null>(
    () => briefs.find((item) => item.id === job.brief_id) ?? null
  )
  const [action, setAction] = useState<'cancel' | 'retry' | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionNote, setActionNote] = useState<string | null>(null)
  const { status: copyStatus, copy: copyId } = useCopyToClipboard(1500)

  const briefFromList = job.brief_id ? briefs.find((item) => item.id === job.brief_id) ?? null : null

  useEffect(() => {
    if (highlighted) setExpanded(true)
  }, [highlighted])

  useEffect(() => {
    if (focusSignal != null) setExpanded(true)
  }, [focusSignal])

  useEffect(() => {
    if (briefFromList) setBrief(briefFromList)
  }, [briefFromList])

  useEffect(() => {
    if (!expanded) return
    const ac = new AbortController()
    setDetailLoading(true)
    getJson<StudioJob>(`/api/studio/jobs/${encodeURIComponent(job.id)}`, ac.signal)
      .then((next) => {
        setDetail(next)
        setDetailError(null)
      })
      .catch((err: unknown) => {
        if (ac.signal.aborted) return
        setDetailError(err instanceof Error ? err.message : '请求失败')
      })
      .finally(() => {
        if (!ac.signal.aborted) setDetailLoading(false)
      })
    return () => ac.abort()
  }, [expanded, job.id, job.updated_at, job.status, detailNonce])

  useEffect(() => {
    if (!expanded || !job.brief_id || brief) return
    const ac = new AbortController()
    getJson<StudioBrief>(`/api/studio/briefs/${encodeURIComponent(job.brief_id)}`, ac.signal)
      .then((next) => setBrief(next))
      .catch(() => {
        /* Brief 读取失败时详情面板会显示 brief_id 与缺失说明 */
      })
    return () => ac.abort()
  }, [expanded, job.brief_id, brief])

  const runAction = useCallback(
    async (kind: 'cancel' | 'retry') => {
      setAction(kind)
      setActionError(null)
      setActionNote(null)
      try {
        const result = await postJson<{ id?: string; status?: string }>(
          `/api/studio/jobs/${encodeURIComponent(job.id)}/${kind}`,
          {}
        )
        setActionNote(
          kind === 'retry'
            ? `已创建重试任务 ${result.id ?? '（id 未返回）'}，旧记录保持不变。`
            : '任务已取消。'
        )
        onRefresh()
      } catch (err) {
        setActionError(formatHttpError(err))
      } finally {
        setAction(null)
      }
    },
    [job.id, onRefresh]
  )

  const canCancel = job.status === 'queued'
  const canRetry = job.status === 'failed' || job.status === 'canceled'

  return (
    <li
      id={`studio-job-${job.id}`}
      data-job-id={job.id}
      className={`border-t border-black/[0.06] first:border-t-0 ${highlighted ? 'bg-[#F5F9FF]' : ''}`}
    >
      <div className="flex items-start gap-2 px-4 py-3.5">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="min-w-0 flex-1 rounded-[8px] text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
        >
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <ChevronRight
              className={`h-3.5 w-3.5 shrink-0 text-apple-subtext transition-transform duration-200 ease-apple ${
                expanded ? 'rotate-90' : ''
              }`}
            />
            <span className="num truncate text-[13px] font-medium">{job.id}</span>
            {highlighted ? (
              <SnapshotStatusStage source="studio" jobId={job.id} className="text-apple-subtext" />
            ) : (
              <>
                <StudioStatusChip status={job.status} />
                <span className="num text-[11px] text-apple-subtext">阶段 {job.stage ?? '无数据'}</span>
              </>
            )}
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 pl-[22px] text-[11px] text-apple-subtext">
            <span className="num">更新 {formatStamp(job.updated_at, true)}</span>
            <span className="num">
              {job.type} / {job.rail} 轨
            </span>
            <span className="num truncate">
              {job.brief_id ? `Brief ${job.brief_id}` : '未关联 Brief'}
            </span>
          </span>
          {job.error && (
            <span
              className="mt-1 line-clamp-2 pl-[22px] text-[11px] leading-relaxed text-[#B3261E]"
              title={job.error}
            >
              {job.error}
            </span>
          )}
        </button>

        <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
          <button
            type="button"
            onClick={() => void copyId(job.id)}
            title="复制 Job ID"
            className="h-7 rounded-lg border border-black/[0.08] px-2 text-[10px] font-medium text-apple-subtext transition-colors hover:bg-black/[0.03] hover:text-apple-text focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
          >
            {copyStatus === 'copied' ? '已复制' : '复制'}
          </button>
          {canCancel && (
            <button
              type="button"
              onClick={() => void runAction('cancel')}
              disabled={action !== null}
              className="h-7 rounded-lg border border-black/[0.1] px-2.5 text-[11px] font-medium text-apple-text transition-colors hover:bg-black/[0.03] focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50 disabled:cursor-not-allowed disabled:opacity-55"
            >
              {action === 'cancel' ? '取消中…' : '取消'}
            </button>
          )}
          {canRetry && (
            <button
              type="button"
              onClick={() => void runAction('retry')}
              disabled={action !== null}
              className="h-7 rounded-lg bg-apple-blue px-2.5 text-[11px] font-medium text-white transition-colors hover:bg-[#0062C4] focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50 disabled:cursor-not-allowed disabled:opacity-55"
            >
              {action === 'retry' ? '重试中…' : '重试'}
            </button>
          )}
        </div>
      </div>

      {(actionError || actionNote) && (
        <div className="px-4 pb-3 pl-[38px]">
          {actionError && (
            <p
              className="break-words rounded-[10px] bg-[#FCEDEB] px-3 py-2 text-[11px] leading-relaxed text-[#B3261E] ring-1 ring-inset ring-[#F3D3CF]"
              role="alert"
            >
              {actionError}
            </p>
          )}
          {actionNote && (
            <p className="break-words rounded-[10px] bg-[#EAF8EE] px-3 py-2 text-[11px] leading-relaxed text-[#1E7A3C] ring-1 ring-inset ring-[#CDEED6]">
              {actionNote}
            </p>
          )}
        </div>
      )}

      {expanded && (
        <StudioJobDetail
          job={job}
          detail={detail}
          brief={brief}
          loading={detailLoading}
          error={detailError}
          onRetry={() => setDetailNonce((value) => value + 1)}
          media={media}
        />
      )}
    </li>
  )
}

export function StudioQueueDrawer({
  open,
  onClose,
  triggerRef,
  closeRef,
  jobsStatus,
  jobsData,
  jobsUpdatedAt,
  jobsRefreshing,
  jobsError,
  briefs,
  createdJobId,
  focusJobId,
  focusMissingId,
  focusNonce,
  onRefresh,
  onRetry,
  onCreateFromEmpty
}: {
  open: boolean
  onClose: () => void
  triggerRef: RefObject<HTMLButtonElement>
  closeRef: RefObject<HTMLButtonElement>
  jobsStatus: 'loading' | 'ready' | 'error'
  jobsData: StudioJobSummary[]
  jobsUpdatedAt: number | null
  jobsRefreshing: boolean
  jobsError: string | null
  briefs: StudioBrief[]
  createdJobId: string | null
  focusJobId: string | null
  focusMissingId: string | null
  focusNonce: number
  onRefresh: () => void
  onRetry: () => void
  onCreateFromEmpty: () => void
}) {
  const drawerRef = useRef<HTMLElement>(null)
  const [filter, setFilter] = useState<QueueFilter>('all')

  useModalA11y(open, drawerRef, onClose, closeRef, triggerRef)

  // #160: NAS 媒体列表抽屉级只拉一次（8s 刷新），行内按 job 过滤，删除后 refresh。
  const mediaState = useLiveJson<MediaJobsResponse>(open ? MEDIA_JOBS_URL : null, 8000)
  const media: MediaJobsState = {
    items: mediaItemsOf(mediaState.data),
    loading: mediaState.status === 'loading',
    error: mediaState.error,
    onRefresh: mediaState.refresh
  }

  const counts = useMemo(() => {
    const map: Record<StudioJobStatus, number> = {
      queued: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      canceled: 0
    }
    for (const j of jobsData) {
      map[j.status] += 1
    }
    return map
  }, [jobsData])

  const filteredJobs = useMemo(() => {
    if (filter === 'all') return jobsData
    return jobsData.filter((job) => job.status === filter)
  }, [filter, jobsData])

  const batch = useInfiniteScrollBatch(filteredJobs.length, 15, 15, `${filter}|${open}`)
  const pagedJobs = filteredJobs.slice(0, batch.visibleCount)

  if (!open) return null

  const showEmpty = jobsStatus === 'ready' && jobsData.length === 0
  const filterOptions: Array<{ key: QueueFilter; label: string; count: number }> = [
    { key: 'all', label: '全部', count: jobsData.length },
    { key: 'queued', label: '排队中', count: counts.queued },
    { key: 'running', label: '执行中', count: counts.running },
    { key: 'succeeded', label: '成功', count: counts.succeeded },
    { key: 'failed', label: '失败', count: counts.failed }
  ]

  return (
    <div className="fixed inset-0 z-50" data-testid="studio-queue-overlay">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} aria-hidden="true" />
      <aside
        ref={drawerRef}
        tabIndex={-1}
        className="absolute inset-y-0 right-0 flex w-full max-w-[560px] flex-col bg-white shadow-2xl focus:outline-none"
        role="dialog"
        aria-modal="true"
        aria-labelledby="studio-jobs-title"
        data-testid="studio-queue-drawer"
      >
        <section className="flex min-h-0 flex-1 flex-col overflow-y-auto" aria-labelledby="studio-jobs-title">
          <div className="sticky top-0 z-10 border-b border-black/[0.06] bg-white px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-baseline gap-2">
                <h2 id="studio-jobs-title" className="text-section">
                  任务队列
                </h2>
                <span className="num text-[11px] text-apple-subtext">
                  {jobsStatus === 'ready' ? `${jobsData.length} 个 · studio 为准` : '读取中'}
                </span>
              </div>
              <div className="flex items-center gap-2 text-[11px] text-apple-subtext">
                <span>每 4 秒更新</span>
                <span className="num">
                  · {jobsUpdatedAt ? formatClockMs(jobsUpdatedAt) : '等待首次读取'}
                </span>
                <button
                  type="button"
                  onClick={onRefresh}
                  aria-label="立即刷新任务列表"
                  className="grid h-7 w-7 place-items-center rounded-full text-apple-subtext transition-colors hover:bg-black/[0.04] hover:text-apple-text focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
                >
                  <Refresh
                    className={`h-3.5 w-3.5 ${jobsRefreshing ? 'animate-spin motion-reduce:animate-none' : ''}`}
                  />
                </button>
                <button
                  ref={closeRef}
                  type="button"
                  onClick={onClose}
                  aria-label="关闭任务队列"
                  className="grid h-7 w-7 place-items-center rounded-full text-apple-subtext transition-colors hover:bg-black/[0.04] hover:text-apple-text focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
                  data-testid="studio-queue-close"
                >
                  <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" aria-hidden="true">
                    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
            </div>

            {jobsData.length > 0 && (
              <div className="mt-2.5">
                <FilterChipGroup
                  label="任务状态筛选"
                  value={filter}
                  options={filterOptions}
                  onChange={setFilter}
                />
              </div>
            )}
          </div>

          {jobsError && (
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-black/[0.06] bg-[#FFF4E5] px-4 py-2.5">
              <p className="break-words text-[11px] leading-relaxed text-[#8A4B00]">
                刷新失败：{jobsError}
                {jobsData.length > 0 ? '（显示上次读取的数据）' : ''}
              </p>
              <button
                type="button"
                onClick={() => (jobsData.length > 0 ? onRefresh() : onRetry())}
                className="shrink-0 rounded text-[11px] font-medium text-[#8A4B00] underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
              >
                重试
              </button>
            </div>
          )}

          {focusMissingId && (
            <div
              className="break-words border-b border-black/[0.06] bg-[#FFF4E5] px-4 py-2.5 text-[11px] leading-relaxed text-[#8A4B00]"
              role="status"
            >
              未找到任务 <span className="num break-all">{focusMissingId}</span>。链接可能已失效，或该任务不在最近 50
              条内。
            </div>
          )}

          {jobsStatus === 'loading' && jobsData.length === 0 && <LoadingRows />}

          {jobsStatus === 'error' && jobsData.length === 0 && (
            <div className="px-6 py-14 text-center">
              <p className="text-sm font-medium">studio 不可用</p>
              <p className="mx-auto mt-1 max-w-[46ch] break-words text-xs leading-relaxed text-apple-subtext">
                任务列表读取失败：{jobsError}
              </p>
              <button type="button" onClick={onRetry} className={`${quietButton} mt-4`}>
                重新读取
              </button>
            </div>
          )}

          {showEmpty && <EmptyQueue onCreate={onCreateFromEmpty} />}

          {jobsData.length > 0 && filteredJobs.length === 0 && (
            <div className="px-6 py-12 text-center text-xs text-apple-subtext">
              当前筛选状态下没有匹配任务。
            </div>
          )}

          {filteredJobs.length > 0 && (
            <>
              <ul className="min-w-0">
                {pagedJobs.map((job) => (
                  <JobRow
                    key={`${job.id}-${job.status}`}
                    job={job}
                    briefs={briefs}
                    highlighted={job.id === createdJobId || job.id === focusJobId}
                    defaultExpanded={job.id === focusJobId}
                    focusSignal={job.id === focusJobId ? focusNonce : undefined}
                    onRefresh={onRefresh}
                    media={media}
                  />
                ))}
              </ul>
              <div
                ref={batch.sentinelRef}
                data-testid="studio-queue-lazy-sentinel"
                className="flex items-center justify-between gap-2 border-t border-black/[0.06] px-4 py-2 text-[11px] text-apple-subtext"
              >
                <span className="num">
                  已加载 {pagedJobs.length} / {filteredJobs.length} 条
                  {batch.hasMore ? ' · 下拉懒加载' : ''}
                </span>
                {batch.hasMore && (
                  <button
                    type="button"
                    onClick={batch.loadMore}
                    className="rounded-lg border border-black/[0.08] bg-white px-2 py-0.5 text-[11px] font-medium text-apple-text hover:bg-black/[0.03]"
                  >
                    加载更多
                  </button>
                )}
              </div>
            </>
          )}

          <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-black/[0.06] px-4 py-2.5 text-[11px] text-apple-subtext">
            <span>
              数据源 <span className="num">/api/studio/jobs?limit=50</span>
            </span>
            <span className="flex items-center gap-1.5">
              <Plus className="h-3 w-3" aria-hidden="true" />
              新任务出现在这里后自动进入轮询
            </span>
          </div>
        </section>
      </aside>
    </div>
  )
}
