import { useCallback, useEffect, useMemo, useState } from 'react'
import type { GateStatus, JobsResponse, StudioJobsResponse, StudioJobStatus, StudioJobSummary } from '../types'
import { useJson, useLiveJson } from '../api'
import { Link } from '../router'
import { StatusChip } from '../components/StatusChip'
import { StudioStatusChip } from '../components/StudioStatusChip'
import { SnapshotStatusStage } from '../components/SnapshotStatusStage'
import { ChevronRight, Clapper, Film, Refresh } from '../components/icons'
import { formatResolution, formatStamp } from '../format'
import { jobIdDisplay, jobReadable, matchesJobQuery } from '../job-label'
import { formatJobDuration } from '../image-workbench'
import { readSearchParam, updateSearchParams } from '../url'
import { SelectMenu } from '../components/SelectMenu'
import { FilterChipGroup } from '../components/ui'
import { useInfiniteScrollBatch } from '../hooks'

type JobsTab = 'b' | 'studio'
type BVerdictFilter = 'all' | 'PASS' | 'FAIL' | 'CONDITIONAL'
type StudioStatusFilter = 'all' | StudioJobStatus
type SortMode = 'default' | 'status' | 'recent'

const TABS: Array<{ key: JobsTab; label: string }> = [
  { key: 'b', label: 'B 轨产物' },
  { key: 'studio', label: '创作工坊任务' }
]

/** 读 `?tab=studio`；缺失、`tab=b` 或非法值都归一为 B 轨。 */
function readTab(): { tab: JobsTab; dirty: boolean } {
  const raw = readSearchParam('tab')
  const tab: JobsTab = raw === 'studio' ? 'studio' : 'b'
  return { tab, dirty: raw !== null && raw !== 'studio' }
}

function writeTab(tab: JobsTab, mode: 'push' | 'replace') {
  updateSearchParams({ tab: tab === 'studio' ? 'studio' : null }, mode)
}

const VERDICT_RANK: Record<GateStatus, number> = {
  FAIL: 0,
  CONDITIONAL: 1,
  UNKNOWN: 2,
  PASS: 3
}

const STUDIO_STATUS_RANK: Record<StudioJobStatus, number> = {
  failed: 0,
  running: 1,
  queued: 2,
  succeeded: 3,
  canceled: 4
}

function studioArtifactUrl(id: string, name: string): string {
  return `/api/studio/jobs/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(name)}`
}

/** #159: 视频缩略取帧位置；未知时长按 0.4s，极短片取一半避免越界。 */
export function studioVideoPreviewSeek(duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0.4
  return Math.min(0.4, duration / 2)
}

/** #159: 行缩略类型；媒体加载失败（onError）时一律退回图标，不显示破图。 */
export function studioJobThumbKind(
  job: StudioJobSummary,
  mediaFailed: boolean
): 'video' | 'image' | 'icon' {
  if (job.status !== 'succeeded' || mediaFailed) return 'icon'
  return job.type === 'image' ? 'image' : 'video'
}

/** #159: /jobs 工坊行左侧真实缩略（失败/未完成任务用图标占位）。 */
function StudioJobThumb({ job }: { job: StudioJobSummary }) {
  const [mediaFailed, setMediaFailed] = useState(false)
  const kind = studioJobThumbKind(job, mediaFailed)
  return (
    <span
      data-testid={`studio-job-thumb-${job.id}`}
      data-thumb-kind={kind}
      className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-black/[0.06] text-apple-subtext sm:h-16 sm:w-16"
    >
      {kind === 'video' && (
        <video
          src={studioArtifactUrl(job.id, 'final.mp4')}
          className="h-full w-full object-cover"
          muted
          playsInline
          preload="metadata"
          aria-hidden="true"
          onLoadedMetadata={(event) => {
            const video = event.currentTarget
            video.currentTime = studioVideoPreviewSeek(video.duration)
          }}
          onError={() => setMediaFailed(true)}
        />
      )}
      {kind === 'image' && (
        <img
          src={studioArtifactUrl(job.id, 'image-01.png')}
          alt=""
          loading="lazy"
          className="h-full w-full object-cover"
          onError={() => setMediaFailed(true)}
        />
      )}
      {kind === 'icon' && <Film className="h-6 w-6" aria-hidden="true" />}
    </span>
  )
}

/** #154: /jobs 工坊任务行主体（不含 Link 外壳），导出以便 SSR 断言耗时展示。 */
export function StudioJobRowContent({ job }: { job: StudioJobSummary }) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <StudioJobThumb job={job} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span
            className="min-w-0 flex-1 truncate text-[13px] font-medium"
            title={`${jobReadable(job)}（任务 ID ${job.id}）`}
          >
            {jobReadable(job)}
          </span>
          <span className="shrink-0 text-[11px] font-medium text-apple-blueInk">{job.rail} 轨</span>
          <span data-testid={`snapshot-status-${job.id}`} data-snapshot-status={job.status}>
            <StudioStatusChip status={job.status} />
          </span>
        </div>
        <p className="mt-1 break-words text-[11px] leading-relaxed text-apple-subtext">
          <span className="num" title={job.id} data-job-id={job.id}>
            {jobIdDisplay(job.id)}
          </span>{' '}
          · {formatStamp(job.created_at)} · Brief <span className="num">{job.brief_id ?? '—'}</span>
          {' · '}
          <span
            data-testid={`snapshot-stage-${job.id}`}
            data-snapshot-stage={job.stage ?? ''}
            title={job.stage ? `阶段 ${job.stage}` : '阶段不可用：studio 未返回 stage'}
          >
            {job.stage ? `阶段 ${job.stage}` : '阶段 —'}
          </span>
          {' · '}
          <span className="num" data-testid={`studio-job-duration-${job.id}`}>
            {formatJobDuration(job.duration_ms)}
          </span>
          {job.error ? ` · ${job.error}` : ''}
        </p>
      </div>
    </div>
  )
}

/** 创作工坊 tab：只在挂载时轮询；切回 B 轨即卸载并停止请求。 */
function StudioJobsTab({ query }: { query: string }) {
  const { status, data, error, refreshing, retry, refresh } = useLiveJson<StudioJobsResponse>(
    '/api/studio/jobs?limit=50',
    4000
  )
  const [statusFilter, setStatusFilter] = useState<StudioStatusFilter>('all')
  const [sortMode, setSortMode] = useState<SortMode>('default')

  const items = data?.items ?? []

  const visibleItems = useMemo(() => {
    const filtered = items.filter((job) => {
      if (statusFilter !== 'all' && job.status !== statusFilter) return false
      return matchesJobQuery(job, query)
    })
    if (sortMode === 'status') {
      return [...filtered].sort((a, b) => STUDIO_STATUS_RANK[a.status] - STUDIO_STATUS_RANK[b.status])
    }
    if (sortMode === 'recent') {
      return [...filtered].sort((a, b) => Date.parse(b.updated_at || b.created_at) - Date.parse(a.updated_at || a.created_at))
    }
    return filtered
  }, [items, query, statusFilter, sortMode])

  const batch = useInfiniteScrollBatch(
    visibleItems.length,
    15,
    15,
    `${query}|${statusFilter}|${sortMode}`
  )
  const pagedItems = visibleItems.slice(0, batch.visibleCount)

  const count = data ? Math.max(data.count, items.length) : null

  const statusCounts = useMemo(
    () => ({
      all: items.length,
      queued: items.filter((j) => j.status === 'queued').length,
      running: items.filter((j) => j.status === 'running').length,
      succeeded: items.filter((j) => j.status === 'succeeded').length,
      failed: items.filter((j) => j.status === 'failed').length,
      canceled: items.filter((j) => j.status === 'canceled').length
    }),
    [items]
  )

  return (
    <div className="mt-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <FilterChipGroup<StudioStatusFilter>
          label="按运行状态筛选"
          value={statusFilter}
          onChange={setStatusFilter}
          options={[
            { key: 'all', label: '全部', count: statusCounts.all },
            { key: 'running', label: '运行中', count: statusCounts.running },
            { key: 'queued', label: '排队', count: statusCounts.queued },
            { key: 'succeeded', label: '成功', count: statusCounts.succeeded },
            { key: 'failed', label: '失败', count: statusCounts.failed }
          ]}
        />

        <div className="flex items-center gap-2">
          <div className="w-[136px]">
            <SelectMenu
              value={sortMode}
              onChange={(val) => setSortMode(val as SortMode)}
              ariaLabel="排序方式"
              align="right"
              size="sm"
              options={[
                { value: 'default', label: '默认排序' },
                { value: 'recent', label: '最近更新优先' },
                { value: 'status', label: '异常/运行优先' }
              ]}
            />
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={refreshing}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-black/[0.08] bg-white px-2.5 text-xs font-medium text-apple-text transition-colors hover:bg-black/[0.03] focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50 disabled:opacity-60"
          >
            <Refresh className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            刷新
          </button>
        </div>
      </div>

      <p className="mt-2.5 text-xs leading-relaxed text-apple-subtext">
        {count == null
          ? '读取中…'
          : query.trim() || statusFilter !== 'all'
            ? `共 ${count} 个 · 当前显示 ${visibleItems.length} 个`
            : `共 ${count} 个`}
      </p>

      {error && data && (
        <div
          className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-[10px] bg-[#FFF4E5] px-3 py-2 text-[11px] leading-relaxed text-[#8A4B00] ring-1 ring-inset ring-[#F5DFC0]"
          role="alert"
        >
          <span className="min-w-0 break-words">刷新失败：{error}（显示上次读取的数据）</span>
          <button
            type="button"
            onClick={() => void refresh()}
            className="shrink-0 underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
          >
            重试
          </button>
        </div>
      )}

      {status === 'loading' && !data && (
        <div className="card mt-3 p-0" aria-busy="true" aria-label="正在加载创作工坊任务">
          <ul className="divide-y divide-black/[0.06]">
            {[0, 1, 2].map((i) => (
              <li key={i} className="animate-pulse px-4 py-4 motion-reduce:animate-none">
                <div className="flex items-center gap-3">
                  <span className="h-5 w-16 rounded-full bg-black/[0.06]" />
                  <span className="h-3.5 w-40 max-w-[50%] rounded bg-black/[0.06]" />
                </div>
                <div className="mt-2 h-3 w-56 max-w-[70%] rounded bg-black/[0.04]" />
              </li>
            ))}
          </ul>
        </div>
      )}

      {status === 'error' && !data && (
        <div className="card mt-3 flex flex-wrap items-center justify-between gap-3 p-5" role="alert">
          <div className="min-w-0">
            <p className="text-sm font-medium">创作工坊任务读取失败</p>
            <p className="mt-1 break-words text-xs text-apple-subtext">{error}</p>
          </div>
          <button
            type="button"
            onClick={() => void retry()}
            className="shrink-0 rounded-lg bg-apple-text px-3 py-1.5 text-xs font-medium text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
          >
            重试
          </button>
        </div>
      )}

      {status === 'ready' && data && items.length === 0 && (
        <div className="card mt-3 p-6">
          <div className="flex items-center gap-2 text-apple-subtext">
            <Clapper className="h-4 w-4" aria-hidden="true" />
            <h2 className="text-sm font-medium text-apple-text">还没有创作工坊任务</h2>
          </div>
          <p className="mt-2 max-w-[60ch] text-sm leading-relaxed text-apple-subtext">
            去创作工坊上传素材并提交第一个任务，任务会出现在这里。
          </p>
          <Link
            to="/studio"
            className="mt-4 inline-flex items-center gap-0.5 rounded-lg bg-apple-text px-3 py-1.5 text-xs font-medium text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
          >
            去创作工坊
            <ChevronRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      )}

      {status === 'ready' && data && items.length > 0 && visibleItems.length === 0 && (
        <div className="card mt-3 p-6" role="status">
          <h2 className="text-sm font-medium">没有匹配的任务</h2>
          <p className="mt-2 text-sm text-apple-subtext">
            当前筛选条件下没有命中任务，切换状态或清空关键词可查看全部。
          </p>
        </div>
      )}

      {status === 'ready' && data && visibleItems.length > 0 && (
        <>
          <div className="card mt-3 overflow-hidden p-0">
            <ul className="min-w-0 divide-y divide-black/[0.06]">
              {pagedItems.map((job) => (
                <li key={job.id}>
                  <Link
                    to={`/studio?job=${encodeURIComponent(job.id)}`}
                    className="flex min-w-0 items-center gap-3 px-4 py-3 transition-colors hover:bg-black/[0.02] focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-apple-blue/50"
                  >
                    <StudioJobRowContent job={job} />
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-apple-subtext" aria-hidden="true" />
                  </Link>
                </li>
              ))}
            </ul>
          </div>
          <div
            ref={batch.sentinelRef}
            data-testid="studio-jobs-lazy-sentinel"
            className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-apple-subtext"
          >
            <span className="num">
              已加载 {pagedItems.length} / {visibleItems.length} 个工坊任务
              {batch.hasMore ? ' · 向下滚动自动懒加载' : ' · 已全部加载'}
            </span>
            {batch.hasMore && (
              <button
                type="button"
                onClick={batch.loadMore}
                className="rounded-lg border border-black/[0.08] bg-white px-2.5 py-1 text-xs font-medium text-apple-text transition-colors hover:bg-black/[0.03]"
              >
                加载更多
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function BTrackTab({ query }: { query: string }) {
  const { status, data, error, refreshing, retry, refresh } = useJson<JobsResponse>('/api/jobs')
  const [verdictFilter, setVerdictFilter] = useState<BVerdictFilter>('all')
  const [sortMode, setSortMode] = useState<'default' | 'verdict' | 'pass_rate'>('default')

  const jobs = data?.jobs ?? []

  const visibleJobs = useMemo(() => {
    const filtered = jobs.filter((job) => {
      if (verdictFilter !== 'all' && job.verdict !== verdictFilter) return false
      return matchesJobQuery(job, query)
    })
    if (sortMode === 'verdict') {
      return [...filtered].sort((a, b) => VERDICT_RANK[a.verdict ?? 'UNKNOWN'] - VERDICT_RANK[b.verdict ?? 'UNKNOWN'])
    }
    if (sortMode === 'pass_rate') {
      const rate = (j: (typeof jobs)[number]) => (j.judged > 0 ? j.passed / j.judged : -1)
      return [...filtered].sort((a, b) => rate(a) - rate(b))
    }
    return filtered
  }, [jobs, query, verdictFilter, sortMode])

  const batch = useInfiniteScrollBatch(
    visibleJobs.length,
    10,
    10,
    `${query}|${verdictFilter}|${sortMode}`
  )
  const pagedJobs = visibleJobs.slice(0, batch.visibleCount)

  const counts = useMemo(
    () => ({
      all: jobs.length,
      PASS: jobs.filter((j) => j.verdict === 'PASS').length,
      CONDITIONAL: jobs.filter((j) => j.verdict === 'CONDITIONAL').length,
      FAIL: jobs.filter((j) => j.verdict === 'FAIL').length
    }),
    [jobs]
  )

  return (
    <div className="mt-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <FilterChipGroup<BVerdictFilter>
          label="按门禁结果筛选"
          value={verdictFilter}
          onChange={setVerdictFilter}
          options={[
            { key: 'all', label: '全部', count: counts.all },
            { key: 'PASS', label: 'PASS', count: counts.PASS },
            { key: 'CONDITIONAL', label: '有条件', count: counts.CONDITIONAL },
            { key: 'FAIL', label: 'FAIL', count: counts.FAIL }
          ]}
        />
        <div className="flex items-center gap-2">
          <div className="w-[136px]">
            <SelectMenu
              value={sortMode}
              onChange={(val) => setSortMode(val as 'default' | 'verdict' | 'pass_rate')}
              ariaLabel="排序方式"
              align="right"
              size="sm"
              options={[
                { value: 'default', label: '默认排序' },
                { value: 'verdict', label: '未通过优先' },
                { value: 'pass_rate', label: '通过率低优先' }
              ]}
            />
          </div>
          <button
            type="button"
            onClick={refresh}
            disabled={refreshing}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-black/[0.08] bg-white px-2.5 text-xs font-medium text-apple-text transition-colors hover:bg-black/[0.03] focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50 disabled:opacity-60"
          >
            <Refresh className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            刷新
          </button>
        </div>
      </div>

      {data && (
        <p className="mb-3 text-xs leading-relaxed text-apple-subtext">
          共 {jobs.length} 个任务 · {counts.FAIL} 个 FAIL · {counts.CONDITIONAL} 个有条件 PASS
          {query.trim() || verdictFilter !== 'all' ? ` · 筛选后 ${visibleJobs.length} 个` : ''}
        </p>
      )}

      {status === 'loading' && (
        <div className="grid gap-4 md:grid-cols-2" aria-busy="true" aria-label="正在加载任务">
          {[0, 1].map((i) => (
            <div key={i} className="card h-[196px] animate-pulse p-5">
              <div className="h-3 w-24 rounded bg-[#ECECEF]" />
              <div className="mt-4 h-5 w-2/3 rounded bg-[#ECECEF]" />
              <div className="mt-3 h-3 w-1/2 rounded bg-[#ECECEF]" />
              <div className="mt-8 h-8 w-full rounded bg-[#F2F2F4]" />
            </div>
          ))}
        </div>
      )}

      {status === 'error' && (
        <div className="card flex flex-wrap items-center justify-between gap-3 p-5" role="alert">
          <div className="min-w-0">
            <p className="text-sm font-medium">任务列表读取失败</p>
            <p className="mt-1 break-words text-xs text-apple-subtext">{error}</p>
          </div>
          <button
            type="button"
            onClick={retry}
            className="shrink-0 rounded-lg bg-apple-text px-3 py-1.5 text-xs font-medium text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
          >
            重试
          </button>
        </div>
      )}

      {status === 'ready' && jobs.length === 0 && (
        <div className="card p-6">
          <h2 className="text-sm font-medium">还没有 B 轨评测任务</h2>
          <p className="mt-2 max-w-[60ch] text-sm leading-relaxed text-apple-subtext">
            可前往创作工坊提交剧本生图任务或上传视频进行 AI 拆画与美化调色，产出结果将自动进入质量评测队列。
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link
              to="/studio?rail=a"
              className="inline-flex items-center gap-1 rounded-lg bg-apple-text px-3 py-1.5 text-xs font-medium text-white"
            >
              进入轨道 A · 剧本生图
            </Link>
            <Link
              to="/studio?rail=b"
              className="inline-flex items-center gap-1 rounded-lg border border-black/[0.1] bg-white px-3 py-1.5 text-xs font-medium text-apple-text hover:bg-[#FAFAFB]"
            >
              进入轨道 B · 上传视频美化
            </Link>
          </div>
        </div>
      )}

      {status === 'ready' && jobs.length > 0 && visibleJobs.length === 0 && (
        <div className="card p-6" role="status">
          <h2 className="text-sm font-medium">没有匹配的任务</h2>
          <p className="mt-2 text-sm text-apple-subtext">
            当前筛选条件下没有命中任务，切换状态或清空关键词可查看全部。
          </p>
        </div>
      )}

      {status === 'ready' && visibleJobs.length > 0 && (
        <>
          <div className="grid gap-4 md:grid-cols-2" data-equal-grid>
            {pagedJobs.map((job) => (
              <Link
                key={job.id}
                to={`/job/${job.id}`}
                className="card group block min-w-0 p-4 transition-shadow hover:shadow-lift focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50 sm:p-5"
              >
                <div className="flex gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-semibold text-apple-blueInk">
                        {job.track} 轨
                      </span>
                      <span
                        className="num break-all text-[11px] text-apple-subtext"
                        title={job.id}
                        data-job-id={job.id}
                      >
                        {jobIdDisplay(job.id)}
                      </span>
                    </div>

                    <h2
                      className="mt-2 truncate text-[15px] font-semibold leading-snug"
                      title={`${jobReadable(job)}（任务 ID ${job.id}）`}
                    >
                      {jobReadable(job)}
                    </h2>

                    <p className="mt-1.5 text-xs leading-relaxed text-apple-subtext">
                      {formatResolution(job.width, job.height)} ·{' '}
                      {job.fps ? `${job.fps}fps` : '无数据'} · {job.frames ?? '—'} 帧
                    </p>

                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <StatusChip status={job.verdict ?? 'UNKNOWN'} label={job.statusLabel} />
                      <SnapshotStatusStage source="b-track" jobId={job.id} className="text-apple-subtext" />
                      <span className="text-xs text-apple-subtext">
                        {job.verdict === 'CONDITIONAL'
                          ? `${job.passed}/${job.judged} 项明确通过 · ${job.total - job.judged} 项仅报数`
                          : `${job.passed}/${job.judged} 判据通过`}
                      </span>
                    </div>

                    <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-apple-subtext">{job.statusNote}</p>

                    <span className="mt-3 inline-flex items-center gap-0.5 text-xs font-medium text-apple-blue">
                      查看详情
                      <ChevronRight className="h-3.5 w-3.5" />
                    </span>
                  </div>

                  <div className="relative aspect-[9/16] w-[76px] shrink-0 overflow-hidden rounded-lg bg-[#0B0B0C] sm:w-[84px]">
                    {job.media.poster ? (
                      <img
                        src={job.media.poster}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        className="h-full w-full object-cover"
                      />
                    ) : job.media.output ? (
                      <video
                        src={job.media.output}
                        muted
                        playsInline
                        preload="metadata"
                        aria-hidden="true"
                        tabIndex={-1}
                        onLoadedMetadata={(event) => {
                          event.currentTarget.currentTime = Math.min(0.4, (event.currentTarget.duration || 0) / 3)
                        }}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <span className="grid h-full w-full place-items-center text-white/40">
                        <Film className="h-5 w-5" />
                      </span>
                    )}
                  </div>
                </div>
              </Link>
            ))}
          </div>
          <div
            ref={batch.sentinelRef}
            data-testid="b-jobs-lazy-sentinel"
            className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-black/[0.06] pt-3 text-xs text-apple-subtext"
          >
            <span className="num">
              已加载 {pagedJobs.length} / {visibleJobs.length} 个任务
              {batch.hasMore ? ' · 向下滚动自动懒加载' : ' · 已全部加载'}
            </span>
            {batch.hasMore && (
              <button
                type="button"
                onClick={batch.loadMore}
                className="rounded-lg border border-black/[0.08] bg-white px-2.5 py-1 text-xs font-medium text-apple-text transition-colors hover:bg-black/[0.03]"
              >
                加载更多
              </button>
            )}
          </div>
        </>
      )}

      {data && (
        <p className="mt-6 text-xs leading-relaxed text-apple-subtext">
          数据根目录：<span className="num break-all">{data.dataRoot}</span>
          {data.original && (
            <>
              {' '}
              · 原片：<span className="num">{data.original}</span>
            </>
          )}
        </p>
      )}
    </div>
  )
}

export function JobsPage() {
  const [tab, setTab] = useState<JobsTab>(() => readTab().tab)
  const [query, setQuery] = useState(() => readSearchParam('q') ?? '')

  // 直接打开 / popstate：URL 决定 tab，非法值就地归一化（replaceState）。
  useEffect(() => {
    const apply = () => {
      const next = readTab()
      if (next.dirty) writeTab(next.tab, 'replace')
      setTab(next.tab)
      setQuery(readSearchParam('q') ?? '')
    }
    apply()
    window.addEventListener('popstate', apply)
    return () => window.removeEventListener('popstate', apply)
  }, [])

  const select = useCallback(
    (next: JobsTab) => {
      if (next === tab) return
      writeTab(next, 'push')
      setTab(next)
    },
    [tab]
  )

  const handleQueryChange = (val: string) => {
    setQuery(val)
    updateSearchParams({ q: val.trim() || null }, 'replace')
  }

  return (
    <div>
      <div className="max-w-[64ch]">
        <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em] sm:text-[34px]">任务中心</h1>
        <p className="mt-1.5 text-sm leading-relaxed text-apple-subtext">
          按来源查看任务：<span className="num">B 轨产物</span> 是自动流水线跑出的成片与报告，
          <span className="num">创作工坊任务</span> 是你在创作工坊提交的创作队列。文件还没产出时显示「无数据」，不做补值。
        </p>
      </div>

      <div
        role="tablist"
        aria-label="任务中心视图"
        className="mt-5 inline-flex items-center gap-0.5 rounded-[10px] bg-black/[0.04] p-1"
      >
        {TABS.map((entry) => {
          const active = tab === entry.key
          return (
            <button
              key={entry.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => select(entry.key)}
              className={`inline-flex h-8 items-center rounded-[8px] px-3 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50 ${
                active ? 'bg-white text-apple-text shadow-soft' : 'text-apple-subtext hover:text-apple-text'
              }`}
            >
              {entry.label}
            </button>
          )
        })}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={query}
          onChange={(event) => handleQueryChange(event.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && query) handleQueryChange('')
          }}
          aria-label="按任务 ID、标题或页面上的文字筛选"
          placeholder="按任务 ID、标题或页面上的文字筛选，如 3ef5f3 / 工具链 / 有条件"
          className="h-9 w-full max-w-[420px] rounded-lg border border-black/[0.08] bg-white px-3 text-xs text-apple-text shadow-soft outline-none transition-colors placeholder:text-apple-subtext focus:border-apple-blue focus:ring-2 focus:ring-apple-blue/20"
        />
        {query.trim() && (
          <button
            type="button"
            onClick={() => handleQueryChange('')}
            className="h-9 rounded-lg px-2.5 text-xs font-medium text-apple-subtext transition-colors hover:bg-black/[0.04] hover:text-apple-text focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
          >
            清空筛选
          </button>
        )}
      </div>

      {tab === 'b' ? <BTrackTab query={query} /> : <StudioJobsTab query={query} />}
    </div>
  )
}
