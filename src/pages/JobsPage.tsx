import { useCallback, useEffect, useState } from 'react'
import type { JobsResponse, StudioJobsResponse } from '../types'
import { useJson, useLiveJson } from '../api'
import { Link } from '../router'
import { StatusChip } from '../components/StatusChip'
import { StudioStatusChip } from '../components/StudioStatusChip'
import { SnapshotStatusStage } from '../components/SnapshotStatusStage'
import { ChevronRight, Clapper, Film } from '../components/icons'
import { formatResolution } from '../format'
import { jobIdShort, jobReadable, matchesJobQuery } from '../job-label'

type JobsTab = 'b' | 'studio'

const TABS: Array<{ key: JobsTab; label: string }> = [
  { key: 'b', label: 'B 轨产物' },
  { key: 'studio', label: '创作工坊任务' }
]

/** 读 `?tab=studio`；缺失、`tab=b` 或非法值都归一为 B 轨。 */
function readTab(): { tab: JobsTab; dirty: boolean } {
  const raw = new URLSearchParams(window.location.search).get('tab')
  const tab: JobsTab = raw === 'studio' ? 'studio' : 'b'
  return { tab, dirty: raw !== null && raw !== 'studio' }
}

function writeTab(tab: JobsTab, mode: 'push' | 'replace') {
  const url = new URL(window.location.href)
  if (tab === 'studio') url.searchParams.set('tab', 'studio')
  else url.searchParams.delete('tab')
  const target = `${url.pathname}${url.search}${url.hash}`
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`
  if (target === current) return
  window.history[mode === 'push' ? 'pushState' : 'replaceState'](
    { ...(window.history.state ?? {}) },
    '',
    target
  )
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function formatStamp(value: string | null | undefined): string {
  if (!value) return '无数据'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes()
  )}`
}

/** 创作工坊 tab：只在挂载时轮询；切回 B 轨即卸载并停止请求。 */
function StudioJobsTab({ query }: { query: string }) {
  const { status, data, error, retry, refresh } = useLiveJson<StudioJobsResponse>(
    '/api/studio/jobs?limit=50',
    4000
  )
  const items = data?.items ?? []
  const visibleItems = items.filter((job) => matchesJobQuery(job, query))
  const count = data ? Math.max(data.count, items.length) : null

  return (
    <div className="mt-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs leading-relaxed text-apple-subtext">
          {count == null
            ? '读取中…'
            : query.trim()
              ? `共 ${count} 个 · 筛选后 ${visibleItems.length} 个`
              : `共 ${count} 个`}
        </p>
        <button
          type="button"
          onClick={refresh}
          className="rounded-lg px-2 py-1 text-xs font-medium text-apple-subtext transition-colors hover:bg-black/[0.04] hover:text-apple-text focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
        >
          刷新
        </button>
      </div>

      {error && data && (
        <div
          className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-[10px] bg-[#FFF4E5] px-3 py-2 text-[11px] leading-relaxed text-[#8A4B00] ring-1 ring-inset ring-[#F5DFC0]"
          role="alert"
        >
          <span className="min-w-0 break-words">刷新失败：{error}（显示上次读取的数据）</span>
          <button
            type="button"
            onClick={refresh}
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
            onClick={retry}
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
            当前筛选「{query.trim()}」没有命中任务 ID、标题或页面上的文字，清空筛选可看全部。
          </p>
        </div>
      )}

      {status === 'ready' && data && visibleItems.length > 0 && (
        <div className="card mt-3 overflow-hidden p-0">
          <ul className="min-w-0 divide-y divide-black/[0.06]">
            {visibleItems.map((job) => (
              <li key={job.id}>
                <Link
                  to={`/studio?job=${encodeURIComponent(job.id)}`}
                  className="flex min-w-0 items-center gap-3 px-4 py-3 transition-colors hover:bg-black/[0.02] focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-apple-blue/50"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                      <span
                        className="min-w-0 flex-1 truncate text-[13px] font-medium"
                        title={`${jobReadable(job)}（任务 ID ${job.id}）`}
                      >
                        {jobReadable(job)}
                      </span>
                      <span className="shrink-0 rounded-md bg-black/[0.03] px-1.5 py-0.5 text-[11px] font-medium text-apple-subtextAlt">
                        {job.rail} 轨
                      </span>
                      <span data-testid={`snapshot-status-${job.id}`} data-snapshot-status={job.status}>
                        <StudioStatusChip status={job.status} />
                      </span>
                    </div>
                    <p className="mt-1 truncate text-[11px] leading-relaxed text-apple-subtext">
                      <span className="num" title={job.id}>
                        {jobIdShort(job.id)}
                      </span>{' '}
                      · {formatStamp(job.created_at)} · Brief{' '}
                      <span className="num">{job.brief_id ?? '—'}</span>
                      {' · '}
                      <span
                        data-testid={`snapshot-stage-${job.id}`}
                        data-snapshot-stage={job.stage ?? ''}
                        title={job.stage ? `阶段 ${job.stage}` : '阶段不可用：studio 未返回 stage'}
                      >
                        {job.stage ? `阶段 ${job.stage}` : '阶段 —'}
                      </span>
                      {job.error ? ` · ${job.error}` : ''}
                    </p>
                  </div>
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-apple-subtext" aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function BTrackTab({ query }: { query: string }) {
  const { status, data, error, retry } = useJson<JobsResponse>('/api/jobs')
  const jobs = data?.jobs ?? []
  const visibleJobs = jobs.filter((job) => matchesJobQuery(job, query))

  return (
    <div className="mt-6">
      {data && (
        <p className="mb-3 text-xs leading-relaxed text-apple-subtext">
          共 {jobs.length} 个任务 ·{' '}
          {jobs.filter((j) => j.verdict === 'FAIL').length} 个 FAIL ·{' '}
          {jobs.filter((j) => j.verdict === 'CONDITIONAL').length} 个有条件 PASS
          {query.trim() ? ` · 筛选后 ${visibleJobs.length} 个` : ''}
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
          <h2 className="text-sm font-medium">还没有可展示的任务</h2>
          <p className="mt-2 max-w-[60ch] text-sm leading-relaxed text-apple-subtext">
            在 acceptance 下新建 <span className="num">issue-19/b-track-s&lt;编号&gt;/</span>，放入 summary JSON、report.md
            和 out/*.mp4 后刷新。字段约定见 web/README.md。
          </p>
        </div>
      )}

      {status === 'ready' && jobs.length > 0 && visibleJobs.length === 0 && (
        <div className="card p-6" role="status">
          <h2 className="text-sm font-medium">没有匹配的任务</h2>
          <p className="mt-2 text-sm text-apple-subtext">
            当前筛选「{query.trim()}」没有命中任务 ID、标题或页面上的文字，清空筛选可看全部。
          </p>
        </div>
      )}

      {status === 'ready' && visibleJobs.length > 0 && (
        <div className="grid gap-4 md:grid-cols-2" data-equal-grid>
          {visibleJobs.map((job) => (
            <Link
              key={job.id}
              to={`/job/${job.id}`}
              className="card group block min-w-0 p-4 transition-shadow hover:shadow-lift focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50 sm:p-5"
            >
              <div className="flex gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-md bg-[#F0F6FF] px-1.5 py-0.5 text-xs font-medium text-apple-blueInk">
                      {job.track} 轨
                    </span>
                    <span className="num truncate text-[11px] text-apple-subtext" title={job.id}>
                      {jobIdShort(job.id)}
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
                    <img src={job.media.poster} alt="" className="h-full w-full object-cover" />
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
  const [query, setQuery] = useState('')

  // 直接打开 / popstate：URL 决定 tab，非法值就地归一化（replaceState）。
  useEffect(() => {
    const apply = () => {
      const next = readTab()
      if (next.dirty) writeTab(next.tab, 'replace')
      setTab(next.tab)
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
        className="mt-5 inline-flex items-center gap-0.5 rounded-full bg-black/[0.04] p-0.5"
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
              className={`inline-flex h-8 items-center rounded-full px-3 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50 ${
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
          onChange={(event) => setQuery(event.target.value)}
          aria-label="按任务 ID、标题或页面上的文字筛选"
          placeholder="按任务 ID、标题或页面上的文字筛选，如 3ef5f3 / 工具链 / 有条件"
          className="h-9 w-full max-w-[420px] rounded-lg border border-black/[0.08] bg-white px-3 text-xs text-apple-text shadow-soft outline-none transition-colors placeholder:text-apple-subtext focus:border-apple-blue focus:ring-2 focus:ring-apple-blue/20"
        />
        {query.trim() && (
          <button
            type="button"
            onClick={() => setQuery('')}
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
