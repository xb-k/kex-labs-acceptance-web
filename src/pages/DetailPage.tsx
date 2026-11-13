import { useMemo, useState } from 'react'
import type {
  BMetricCheck,
  BMetrics,
  DetailResponse,
  JobHistoryResponse,
  JobLogContentResponse,
  JobLogItem,
  JobLogsResponse,
  JobSnapshot
} from '../types'
import { getJson, useJson } from '../api'
import { formatBytes, formatFullStamp } from '../format'
import { formatHttpError, useCopyToClipboard } from '../hooks'
import { jobReadable } from '../job-label'
import { Link } from '../router'
import { StatusChip } from '../components/StatusChip'
import { snapshotReasonText } from '../components/SnapshotStatusStage'
import { ArrowLeft, Chart, Check, Flow, Refresh } from '../components/icons'
import { CoverKeyframeCard } from '../components/CoverKeyframeCard'
import { CriteriaGrid } from '../components/CriteriaGrid'
import { PipelineCard } from '../components/PipelineCard'
import { VideoCompare } from '../components/VideoCompare'
import { ToolButton } from '../components/ui'

export function DetailPage({ id }: { id: string }) {
  const { status, data, error, refreshing, retry, refresh } = useJson<DetailResponse>(
    `/api/metrics/${encodeURIComponent(id)}`
  )
  const { status: copyStatus, copy } = useCopyToClipboard()

  if (status === 'loading') {
    return <SkeletonDetail />
  }

  if (status === 'error') {
    return (
      <div>
        <BackLink />
        <div className="card mt-5 p-6" role="alert">
          <h1 className="text-base font-semibold">任务读取失败：{id}</h1>
          <p className="mt-2 text-sm text-apple-subtext">{error}</p>
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={retry}
              className="rounded-lg bg-apple-text px-3 py-1.5 text-xs font-medium text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
            >
              重试
            </button>
            <Link to="/jobs" className="rounded-lg border border-apple-line px-3 py-1.5 text-xs font-medium">
              返回任务中心
            </Link>
          </div>
        </div>
      </div>
    )
  }

  const { job, criteria, dataSources, notes } = data
  const bMetrics = data.bMetrics ?? null
  const failed = criteria.filter((c) => c.pass === false)
  // #102：标题优先可读标签；任务 id 降为下方「任务 ID」次要行，排障仍可复制。
  const heading = jobReadable(job)

  const anchors = [
    { href: '#video-compare', label: '视频对比' },
    { href: '#sec-criteria', label: bMetrics ? 'B 轨指标' : '判据' },
    { href: '#sec-pipeline', label: '链条' },
    ...(!bMetrics ? [{ href: '#sec-logs', label: '日志' }] : []),
    { href: '#sec-decisions', label: '决策' }
  ]

  return (
    <div>
      <BackLink />

      <header className="mt-4">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="text-xs font-semibold text-apple-blueInk">
            {job.rail ?? job.track} 轨任务
          </span>
          <StatusChip status={job.verdict ?? 'UNKNOWN'} label={job.statusLabel} />
        </div>

        <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
          <h1
            className="max-w-[26ch] text-[26px] font-semibold leading-tight tracking-[-0.02em] sm:text-[32px]"
            title={heading}
          >
            {heading}
          </h1>
          <div className="flex flex-wrap items-center gap-2">
            <ToolButton onClick={refresh} disabled={refreshing} title="刷新当前任务详情">
              <Refresh className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
              {refreshing ? '刷新中' : '刷新'}
            </ToolButton>
            <Link
              to={`/?job=${encodeURIComponent(job.id)}`}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-black/[0.08] bg-white px-3.5 text-xs font-medium text-apple-text transition-colors hover:bg-apple-bg focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
            >
              <Flow className="h-3.5 w-3.5 text-apple-subtext" />
              节点流转
            </Link>
            {job.hasQc && (
              <Link
                to={`/job/${job.id}/qc`}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-black/[0.08] bg-white px-3.5 text-xs font-medium text-apple-text transition-colors hover:bg-apple-bg focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
              >
                <Chart className="h-3.5 w-3.5 text-apple-subtext" />
                QC 曲线
              </Link>
            )}
          </div>
        </div>

        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs leading-relaxed text-apple-subtext">
          <span className="num break-all">
            任务 ID · {job.id}
            {job.taskId ? (
              <>
                {' '}
                · Brief <span>{job.taskId}</span>
              </>
            ) : null}
          </span>
          <button
            type="button"
            onClick={() => void copy(job.id)}
            className="inline-flex items-center gap-1 rounded-md border border-black/[0.08] bg-white px-2 py-0.5 text-[11px] font-medium text-apple-text transition-colors hover:bg-apple-bg focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
          >
            {copyStatus === 'copied' && <Check className="h-3 w-3 text-apple-green" />}
            {copyStatus === 'copied' ? '已复制 ID' : copyStatus === 'manual' ? '请手动复制' : '复制 ID'}
          </button>
        </div>

        <p className="mt-2 max-w-[80ch] text-sm leading-relaxed text-apple-subtext">{job.statusNote}</p>

        <nav aria-label="详情快捷跳转" className="mt-3 flex flex-wrap items-center gap-2 border-b border-black/[0.06] pb-2">
          {anchors.map((a) => (
            <a
              key={a.href}
              href={a.href}
              className="rounded-lg px-2.5 py-1 text-xs font-medium text-apple-subtext transition-colors hover:bg-black/[0.04] hover:text-apple-text focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
            >
              {a.label}
            </a>
          ))}
        </nav>
      </header>

      {failed.length > 0 && (
        <div
          role="status"
          className="mt-4 rounded-xl border border-[#F3D3CF] bg-[#FCEDEB] px-4 py-3 text-xs leading-relaxed text-[#8A1F18]"
        >
          <span className="font-medium">未过项：</span>
          {failed.map((f) => `${f.name}（${f.value}，阈值 ${f.threshold}）`).join('；')}。报告未改 gate、未放宽阈值，如实标记 FAIL。
        </div>
      )}

      <div className="mt-5 space-y-5">
        <CoverKeyframeCard job={job} />
        <div id="video-compare" className="scroll-mt-16">
          <VideoCompare job={job} />
        </div>
        <div id="sec-criteria" className="scroll-mt-16">
          {bMetrics ? <BMetricsTable metrics={bMetrics} /> : <CriteriaGrid criteria={criteria} />}
        </div>
        <div id="sec-pipeline" className="scroll-mt-16">
          <PipelineCard detail={data} />
        </div>
        {!bMetrics && (
          <div id="sec-logs" className="scroll-mt-16">
            <LogsSection id={job.id} />
          </div>
        )}
        {!bMetrics && <HistorySection id={job.id} />}
        <div id="sec-decisions" className="scroll-mt-16">
          <DecisionsSection id={job.id} />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <section className="card p-4 sm:p-5">
            <h2 className="text-base font-semibold tracking-tight">数据来源</h2>
            <p className="mt-0.5 text-xs text-apple-subtext">所有数值与文件均从下列路径实读。</p>
            <ul className="mt-3 divide-y divide-apple-line">
              {dataSources.map((src) => (
                <li key={src.label} className="flex items-start gap-2 py-2.5">
                  <span
                    className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${src.exists ? 'bg-apple-green' : 'bg-apple-red'}`}
                    aria-hidden="true"
                  />
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-apple-text">
                      {src.label}
                      {!src.exists && <span className="ml-1 font-normal text-apple-subtext">（缺失 → 页面显示无数据）</span>}
                    </p>
                    <p className="num mt-0.5 break-all text-xs leading-relaxed text-apple-subtext">{src.path}</p>
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <section className="card p-4 sm:p-5">
            <h2 className="text-base font-semibold tracking-tight">备注 · 未验证</h2>
            <p className="mt-0.5 text-xs text-apple-subtext">原样取自 summary.unverified 与 look 警告，不删减。</p>
            {notes.length > 0 ? (
              <ul className="mt-3 space-y-2">
                {notes.map((note) => (
                  <li key={note} className="flex gap-2 text-xs leading-relaxed text-[#4A4A4F]">
                    <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-[#C9C9CF]" aria-hidden="true" />
                    <span className="min-w-0 break-words">{note}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-sm text-apple-subtext">无备注。</p>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}

function LogsSection({ id }: { id: string }) {
  const { status, data, error, retry } = useJson<JobLogsResponse>(`/api/jobs/${encodeURIComponent(id)}/logs`)

  return (
    <section className="card p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold tracking-tight">日志</h2>
        <p className="text-xs text-apple-subtext">只读 · 点击文件名展开尾部 200 行</p>
      </div>

      {status === 'loading' && <p className="mt-3 text-sm text-apple-subtext">正在读取日志…</p>}

      {status === 'error' && (
        <div className="mt-3" role="alert">
          <p className="text-sm text-apple-subtext">{error}</p>
          <button
            type="button"
            onClick={retry}
            className="mt-3 rounded-lg bg-apple-text px-3 py-1.5 text-xs font-medium text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
          >
            重试
          </button>
        </div>
      )}

      {status === 'ready' &&
        (data.items.length === 0 ? (
          <div className="mt-3 rounded-lg bg-[#FAFAFB] p-3">
            <p className="text-sm text-apple-subtext">未找到日志</p>
            <p className="mt-1.5 text-xs text-apple-subtext">探测目录（实读，非 mock）：</p>
            <ul className="mt-1 space-y-0.5">
              {(data.scanned.length > 0 ? data.scanned : ['无可探测目录']).map((dir) => (
                <li key={dir} className="num break-all text-[11px] leading-relaxed text-apple-subtext">
                  {dir}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <ul className="mt-3 divide-y divide-apple-line">
            {data.items.map((item) => (
              <LogRow key={item.path} jobId={id} item={item} />
            ))}
          </ul>
        ))}
    </section>
  )
}

function LogRow({ jobId, item }: { jobId: string; item: JobLogItem }) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [content, setContent] = useState<JobLogContentResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [keyword, setKeyword] = useState('')
  const { status: copyStatus, copy } = useCopyToClipboard()

  const toggle = async () => {
    if (open) {
      setOpen(false)
      return
    }
    setOpen(true)
    if (content || loading) return
    setLoading(true)
    setError(null)
    try {
      const body = await getJson<JobLogContentResponse>(
        `/api/jobs/${encodeURIComponent(jobId)}/logs/content?path=${encodeURIComponent(item.path)}`
      )
      setContent(body)
    } catch (err) {
      setError(formatHttpError(err, '读取失败'))
    } finally {
      setLoading(false)
    }
  }

  const filteredText = useMemo(() => {
    if (!content) return ''
    const q = keyword.trim().toLowerCase()
    if (!q) return content.content
    return content.content
      .split(/\r?\n/)
      .filter((line) => line.toLowerCase().includes(q))
      .join('\n')
  }, [content, keyword])

  return (
    <li className="py-2.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={toggle}
        className="flex w-full flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
      >
        <span className="num min-w-0 break-all text-xs font-medium text-apple-text">{item.name}</span>
        <span className="num shrink-0 text-[11px] text-apple-subtext">
          {formatBytes(item.size)} · {formatFullStamp(item.mtime)}
        </span>
      </button>
      {open && loading && <p className="mt-2 text-xs text-apple-subtext">正在读取尾部内容…</p>}
      {open && error && (
        <p className="mt-2 text-xs text-apple-red" role="alert">
          {error}
        </p>
      )}
      {open && content && (
        <div className="mt-2">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <input
              type="search"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="过滤日志关键字（如 error / warn）"
              aria-label={`过滤 ${item.name} 日志`}
              className="h-7 w-full max-w-[260px] rounded-lg border border-black/[0.09] bg-white px-2.5 text-[11px] text-apple-text placeholder:text-apple-subtext focus:border-apple-blue focus:outline-none"
            />
            <button
              type="button"
              onClick={() => void copy(filteredText || content.content)}
              className="inline-flex h-7 items-center gap-1 rounded-lg border border-black/[0.08] bg-white px-2.5 text-[11px] font-medium text-apple-text transition-colors hover:bg-apple-bg focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
            >
              {copyStatus === 'copied' && <Check className="h-3 w-3 text-apple-green" />}
              {copyStatus === 'copied' ? '已复制' : '复制内容'}
            </button>
          </div>
          <pre className="num max-h-80 max-w-full overflow-auto rounded-lg bg-[#FAFAFB] p-3 text-[11px] leading-relaxed text-[#4A4A4F]">
            {filteredText || '没有匹配当前关键字的日志行。'}
          </pre>
          <p className="mt-1 text-[11px] text-apple-subtext">
            尾部最多 200 行 / 64KB{content.truncated ? '，已截断' : ''} · {content.path}
          </p>
        </div>
      )}
    </li>
  )
}

/** #97 契约 §4：decisions 只读 snapshot，无数据显「未记录」，>20 条标「已截断」。 */
function DecisionsSection({ id }: { id: string }) {
  const { status, data, error, retry } = useJson<JobSnapshot>(
    `/api/snapshot?source=b-track&job=${encodeURIComponent(id)}`
  )
  const decisions = data?.decisions ?? []

  return (
    <section className="card p-4 sm:p-5" data-testid="decisions-section">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold tracking-tight">决策记录</h2>
        <p className="text-xs text-apple-subtext">snapshot decisions · 只读</p>
      </div>

      {status === 'loading' && <p className="mt-3 text-sm text-apple-subtext">正在读取决策记录…</p>}

      {status === 'error' && (
        <div className="mt-3" role="alert">
          <p className="text-sm text-apple-subtext">决策记录读取失败：{error}</p>
          <button
            type="button"
            onClick={retry}
            className="mt-3 rounded-lg bg-apple-text px-3 py-1.5 text-xs font-medium text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
          >
            重试
          </button>
        </div>
      )}

      {data && (
        <>
          {decisions.length === 0 ? (
            <p className="mt-3 text-sm text-apple-subtext">
              未记录
              {!data.available && snapshotReasonText(data) ? `（${snapshotReasonText(data)}）` : ''}
            </p>
          ) : (
            <ol className="mt-3 space-y-2">
              {decisions.map((item, index) => (
                <li key={`${item.at ?? 'na'}-${item.kind ?? 'na'}-${index}`} className="flex gap-2 text-xs leading-relaxed">
                  <span className="num shrink-0 text-apple-subtext">{item.at ?? '—'}</span>
                  <span className="rounded bg-[#F5F5F7] px-1.5 py-0.5 text-[10px] text-apple-subtext">
                    {item.kind ?? '—'}
                  </span>
                  <span className="min-w-0 break-words text-[#4A4A4F]">{item.summary ?? '无数据'}</span>
                </li>
              ))}
            </ol>
          )}
          <p className="mt-3 text-[11px] text-apple-subtext">
            {data.decisions_truncated ? '已截断（仅显示最近 20 条）' : `共 ${decisions.length} 条`}
            {data.decisions_state === 'unavailable' ? ' · decisions 来源不可用' : ''}
          </p>
        </>
      )}
    </section>
  )
}

function HistorySection({ id }: { id: string }) {
  const { status, data, error, retry } = useJson<JobHistoryResponse>(
    `/api/jobs/${encodeURIComponent(id)}/history`
  )

  return (
    <section className="card p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold tracking-tight">历史</h2>
        <p className="text-xs text-apple-subtext">快照 / 事件时间线 · 只读</p>
      </div>

      {status === 'loading' && <p className="mt-3 text-sm text-apple-subtext">正在读取历史…</p>}

      {status === 'error' && (
        <div className="mt-3" role="alert">
          <p className="text-sm text-apple-subtext">{error}</p>
          <button
            type="button"
            onClick={retry}
            className="mt-3 rounded-lg bg-apple-text px-3 py-1.5 text-xs font-medium text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
          >
            重试
          </button>
        </div>
      )}

      {status === 'ready' &&
        (data.items.length === 0 ? (
          <p className="mt-3 text-sm text-apple-subtext">暂无历史记录</p>
        ) : (
          <ol className="mt-3 space-y-2">
            {data.items.map((item, index) => (
              <li key={`${item.ts ?? 'na'}-${item.kind}-${index}`} className="flex gap-2 text-xs leading-relaxed">
                <span className="num shrink-0 text-apple-subtext">
                  {item.ts ? formatFullStamp(item.ts) : '—'}
                </span>
                <span className="rounded bg-[#F5F5F7] px-1.5 py-0.5 text-[10px] text-apple-subtext">
                  {item.kind}
                </span>
                <span className="min-w-0 break-words text-[#4A4A4F]">{item.summary}</span>
              </li>
            ))}
          </ol>
        ))}
      {status === 'ready' && (
        <p className="mt-3 text-[11px] text-apple-subtext">来源：{data.source}</p>
      )}
    </section>
  )
}

function BackLink() {
  return (
    <Link
      to="/jobs"
      className="inline-flex items-center gap-1.5 rounded-lg py-1 text-xs font-medium text-apple-subtext transition-colors hover:text-apple-text focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
    >
      <ArrowLeft className="h-3.5 w-3.5" />
      返回任务中心
    </Link>
  )
}

function SkeletonDetail() {
  return (
    <div aria-busy="true" aria-label="正在加载任务详情">
      <BackLink />
      <div className="mt-4 space-y-5">
        <div className="h-8 w-1/3 animate-pulse rounded bg-[#ECECEF]" />
        <div className="card h-[420px] animate-pulse" />
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="card h-[180px] animate-pulse" />
          ))}
        </div>
      </div>
    </div>
  )
}

/** #86b2: B1/B2/B3 指标表 —— 值/阈值/结果/来源全部来自上游，不补默认阈值。 */
function BMetricsTable({ metrics }: { metrics: BMetrics }) {
  const [onlyFailed, setOnlyFailed] = useState(false)
  const groups: Array<BMetricCheck['group']> = ['B1', 'B2', 'B3', '输出']
  const failCount = metrics.checks.filter((c) => c.pass === false).length

  return (
    <section className="card p-4 sm:p-5" data-testid="b-metrics">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold tracking-tight">B1 / B2 质量指标</h2>
          <p className="mt-0.5 text-xs text-apple-subtext">
            来源 {metrics.source} · 阈值与 PASS/FAIL 只读上游，缺失显示「未记录」
          </p>
        </div>
        <button
          type="button"
          aria-pressed={onlyFailed}
          onClick={() => setOnlyFailed((v) => !v)}
          className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50 ${
            onlyFailed
              ? 'border-apple-text bg-apple-text text-white'
              : 'border-apple-line bg-white text-apple-text hover:bg-[#FAFAFB]'
          }`}
        >
          仅看未过项
          <span className={`num ${onlyFailed ? 'text-white/80' : 'text-apple-subtext'}`}>{failCount}</span>
        </button>
      </div>

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-apple-subtext">
        <span>
          门禁 <span className="font-medium text-apple-text">{metrics.status ?? metrics.verdict}</span>
        </span>
        <span>正向项 {metrics.positiveCount ?? '未记录'}</span>
        <span>未过项 {metrics.failed.length ? metrics.failed.join('、') : '无'}</span>
        <span className="num">
          fps in/out {metrics.fpsIn ?? '未记录'} / {metrics.fpsOut ?? '未记录'}
        </span>
      </div>

      {metrics.error && (
        <p role="alert" className="mt-2 text-xs leading-relaxed text-apple-red">
          {metrics.error}
        </p>
      )}

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-left text-xs">
          <caption className="sr-only">B1/B2/B3 指标：值、阈值、结果与来源</caption>
          <thead>
            <tr className="border-b border-apple-line text-apple-subtext">
              <th scope="col" className="py-2 pr-3 font-medium">组</th>
              <th scope="col" className="py-2 pr-3 font-medium">指标</th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">值</th>
              <th scope="col" className="py-2 pr-3 font-medium">阈值</th>
              <th scope="col" className="py-2 pr-3 font-medium">结果</th>
              <th scope="col" className="py-2 font-medium">来源</th>
            </tr>
          </thead>
          {groups.map((group) => {
            const rows = metrics.checks.filter(
              (c) => c.group === group && (!onlyFailed || c.pass === false)
            )
            if (onlyFailed && rows.length === 0) return null
            return (
              <tbody key={group} className="divide-y divide-apple-line">
                <tr className="bg-black/[0.015]">
                  <th scope="colgroup" colSpan={6} className="py-1.5 text-left text-[11px] font-semibold text-apple-text">
                    {group}
                  </th>
                </tr>
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-2 text-apple-subtext">未记录</td>
                  </tr>
                ) : (
                  rows.map((c) => (
                    <tr key={c.key}>
                      <td className="py-2 pr-3 text-apple-subtext">{c.group}</td>
                      <td className="py-2 pr-3">{c.label}</td>
                      <td className="num py-2 pr-3 text-right">{fmtBValue(c.value)}</td>
                      <td className="num py-2 pr-3">
                        {c.threshold === null ? '未记录' : `${c.op ?? ''}${c.threshold}`}
                      </td>
                      <td className="py-2 pr-3"><BPass pass={c.pass} /></td>
                      <td className="py-2 text-apple-subtext">{c.source}</td>
                    </tr>
                  ))
                )}
              </tbody>
            )
          })}
          {onlyFailed && failCount === 0 && (
            <tbody>
              <tr>
                <td colSpan={6} className="py-4 text-center text-apple-subtext">
                  当前没有未过项。
                </td>
              </tr>
            </tbody>
          )}
        </table>
      </div>
    </section>
  )
}

function fmtBValue(value: number | null): string {
  if (value === null) return '未记录'
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)))
}

function BPass({ pass }: { pass: boolean | null }) {
  if (pass === null) return <span className="text-apple-subtext">未记录</span>
  return (
    <span className={`font-medium ${pass ? 'text-apple-green' : 'text-apple-red'}`}>
      {pass ? 'PASS' : 'FAIL'}
    </span>
  )
}
