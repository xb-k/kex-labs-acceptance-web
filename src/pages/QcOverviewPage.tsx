import { useMemo, useState, type ReactNode } from 'react'
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts'
import type { GateStatus, QcSummaryJob, QcSummaryResponse } from '../types'
import { useLiveJson } from '../api'
import { downloadCsvFile, formatClockMs } from '../format'
import { Link } from '../router'
import { StatusChip } from '../components/StatusChip'
import { DataTable, type Column } from '../components/DataTable'
import { QcRuleList } from '../components/QcRuleList'
import { SelectMenu } from '../components/SelectMenu'
import { FilterChipGroup, ToolButton } from '../components/ui'
import { Chart, ChevronRight, Pause, Play, Refresh, Shield, Sliders } from '../components/icons'
import { useInfiniteScrollBatch } from '../hooks'
import { explainJobSummaryRow } from '../qc-explain'

const QC_POLL_MS = 4000
const PAGE_LIMIT = 15

const STATUS_LABEL: Record<GateStatus, string> = {
  PASS: '通过',
  CONDITIONAL: '有条件通过',
  FAIL: '未通过',
  UNKNOWN: '无判定'
}

const TONE = {
  blue: { tile: 'bg-[#EAF2FF] text-[#0A6CD8] ring-[#D8E6FE]', accent: '#0071E3' },
  green: { tile: 'bg-[#EAF8EE] text-[#1E7A3C] ring-[#D5EFDC]', accent: '#30A14E' },
  purple: { tile: 'bg-[#F3EEFD] text-[#6D48BF] ring-[#E6DCF8]', accent: '#5E4AC7' },
  orange: { tile: 'bg-[#FFF3E4] text-[#B25E00] ring-[#F8E2C8]', accent: '#C77700' }
} as const

type GateFilter = 'all' | 'PASS' | 'FAIL' | 'PENDING'
type QcSortKey = 'default' | 'fail_first' | 'ssim_asc' | 'noise_desc'

const SORT_OPTIONS: Array<{ value: QcSortKey; label: string }> = [
  { value: 'default', label: '默认顺序' },
  { value: 'fail_first', label: '未通过 / 待判优先' },
  { value: 'ssim_asc', label: 'SSIM 从低到高' },
  { value: 'noise_desc', label: '噪声变化从高到低' }
]

function numText(value: number | null | undefined, digits: number): string | null {
  if (value == null || !Number.isFinite(value)) return null
  return value.toFixed(digits)
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function exportSummaryCsv(rows: QcSummaryJob[]) {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  downloadCsvFile(`qc-summary-${stamp}.csv`, [
    ['jobId', 'taskId', '状态', 'passed', 'judged', 'SSIM', '噪声变化%', '净增益', '鬼影比', 'hasQc'],
    ...rows.map((row) => [
      row.jobId,
      row.taskId,
      row.status,
      row.passed,
      row.judged,
      row.ssim ?? '无数据',
      row.noiseChangePct ?? '无数据',
      row.netGain ?? '无数据',
      row.ghostRatio ?? '无数据',
      row.hasQc ? 'true' : 'false'
    ])
  ])
}

function StatCard({
  label,
  icon,
  tone,
  note,
  children
}: {
  label: string
  icon: ReactNode
  tone: keyof typeof TONE
  note: string
  children: ReactNode
}) {
  const colors = TONE[tone]
  return (
    <div className="card relative flex h-full min-w-0 flex-col overflow-hidden p-4">
      <span aria-hidden="true" className="absolute inset-x-0 top-0 h-[3px]" style={{ backgroundColor: colors.accent }} />
      <div className="flex items-center justify-between gap-2">
        <span className="label">{label}</span>
        <span className={`grid h-9 w-9 place-items-center rounded-[10px] ring-1 ring-inset ${colors.tile}`}>
          {icon}
        </span>
      </div>
      <div className="mt-2.5 flex-1">{children}</div>
      <p className="mt-2 truncate text-[11px] leading-4 text-apple-subtext" title={note}>
        {note}
      </p>
    </div>
  )
}

function NoiseTrend({
  jobs,
  limit
}: {
  jobs: QcSummaryJob[]
  limit: { value: number; label: string } | null
}) {
  const points = useMemo(
    () =>
      jobs
        .map((job) => ({
          jobId: job.jobId,
          shortId: job.jobId.length > 14 ? `${job.jobId.slice(0, 6)}…${job.jobId.slice(-5)}` : job.jobId,
          value: job.noiseChangePct
        }))
        .filter((point): point is { jobId: string; shortId: string; value: number } => point.value != null && Number.isFinite(point.value)),
    [jobs]
  )

  if (points.length < 2) {
    return (
      <div data-testid="qc-trend" data-points={points.length}>
        <p className="text-[20px] font-semibold leading-none tracking-tight text-apple-subtext">数据不足</p>
        <p className="mt-2 text-xs leading-relaxed text-apple-subtext">
          仅 {points.length} 个真实的 noiseChangePct 值；绘制趋势需要至少 2 个，不以 0 或模拟值补点。
        </p>
      </div>
    )
  }

  const values = points.map((point) => point.value)
  const lo = Math.floor(Math.min(0, ...values, limit?.value ?? Infinity) - 1)
  const hi = Math.ceil(Math.max(2, ...values, limit?.value ?? -Infinity) + 1)

  return (
    <div data-testid="qc-trend" data-points={points.length}>
      <div className="h-[190px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={points} margin={{ top: 12, right: 12, left: -12, bottom: 4 }}>
            <defs>
              <linearGradient id="qc-noise-area" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#30A14E" stopOpacity={0.2} />
                <stop offset="100%" stopColor="#30A14E" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" vertical={false} />
            <XAxis
              dataKey="shortId"
              tick={{ fontSize: 10, fill: '#6E6E73' }}
              axisLine={{ stroke: '#E5E5EA' }}
              tickLine={false}
            />
            <YAxis
              domain={[lo, hi]}
              tick={{ fontSize: 10, fill: '#6E6E73' }}
              tickFormatter={(val: number) => `${val}%`}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: '#FFFFFF',
                border: '1px solid rgba(0,0,0,0.08)',
                borderRadius: '10px',
                fontSize: '12px',
                boxShadow: '0 8px 24px rgba(0,0,0,0.08)'
              }}
              labelFormatter={(_, payload) => {
                const first = payload?.[0]?.payload as { jobId?: string } | undefined
                return first?.jobId ? `任务 ${first.jobId}` : ''
              }}
              formatter={(value) => [`${Number(value).toFixed(2)}%`, '噪声变化']}
            />
            {limit && (
              <ReferenceLine
                y={limit.value}
                stroke="#C77700"
                strokeDasharray="4 3"
                label={{
                  value: `门禁阈值 ${limit.label}`,
                  position: 'insideTopRight',
                  fill: '#B25E00',
                  fontSize: 10
                }}
              />
            )}
            <Area type="monotone" dataKey="value" fill="url(#qc-noise-area)" stroke="none" isAnimationActive={false} />
            <Line
              type="monotone"
              dataKey="value"
              stroke="#30A14E"
              strokeWidth={2}
              dot={{ r: 3.5, fill: '#30A14E', stroke: '#FFFFFF', strokeWidth: 1.5 }}
              activeDot={{ r: 5, fill: '#30A14E', stroke: '#FFFFFF', strokeWidth: 2 }}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-apple-subtext">
        折线按 /api/qc/summary 返回顺序绘制，仅含真实检测样本（共 {points.length} 组）。
      </p>
    </div>
  )
}

export function QcOverviewPage() {
  const [liveSync, setLiveSync] = useState(true)
  const { status, data, error, refreshing, updatedAt, retry, refresh } = useLiveJson<QcSummaryResponse>(
    '/api/qc/summary',
    liveSync ? QC_POLL_MS : 0
  )
  const [gateFilter, setGateFilter] = useState<GateFilter>('all')
  const [sortBy, setSortBy] = useState<QcSortKey>('default')
  const [query, setQuery] = useState('')
  const jobs = data?.jobs ?? []

  const kpi = useMemo(() => {
    const inspected = jobs.filter((job) => job.hasQc)
    const pass = jobs.filter((job) => job.status === 'PASS').length
    const fail = jobs.filter((job) => job.status === 'FAIL').length
    const pending = jobs.length - pass - fail
    const ssimValues = jobs
      .map((job) => job.ssim)
      .filter((value): value is number => value != null && Number.isFinite(value))
    const meanSsim = ssimValues.length ? ssimValues.reduce((sum, value) => sum + value, 0) / ssimValues.length : null
    const noiseValues = jobs
      .map((job) => job.noiseChangePct)
      .filter((value): value is number => value != null && Number.isFinite(value))
    return {
      inspected: inspected.length,
      pass,
      fail,
      pending,
      meanSsim,
      ssimCount: ssimValues.length,
      noiseValues,
      noiseMedian: noiseValues.length ? median(noiseValues) : null,
      noiseMax: noiseValues.length ? Math.max(...noiseValues) : null,
      noiseInsufficient: noiseValues.length < 2
    }
  }, [jobs])

  const filteredJobs = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matched = jobs.filter((job) => {
      if (gateFilter === 'PASS' && job.status !== 'PASS') return false
      if (gateFilter === 'FAIL' && job.status !== 'FAIL') return false
      if (gateFilter === 'PENDING' && (job.status === 'PASS' || job.status === 'FAIL')) return false
      if (!q) return true
      return job.jobId.toLowerCase().includes(q) || job.taskId.toLowerCase().includes(q)
    })
    if (sortBy === 'default') return matched
    const sorted = [...matched]
    if (sortBy === 'fail_first') {
      const rank = (s: GateStatus) => (s === 'FAIL' ? 0 : s === 'CONDITIONAL' || s === 'UNKNOWN' ? 1 : 2)
      sorted.sort((a, b) => rank(a.status) - rank(b.status))
    } else if (sortBy === 'ssim_asc') {
      sorted.sort((a, b) => (a.ssim ?? Infinity) - (b.ssim ?? Infinity))
    } else if (sortBy === 'noise_desc') {
      sorted.sort((a, b) => (b.noiseChangePct ?? -Infinity) - (a.noiseChangePct ?? -Infinity))
    }
    return sorted
  }, [jobs, gateFilter, query, sortBy])

  const lazyBatch = useInfiniteScrollBatch(
    filteredJobs.length,
    PAGE_LIMIT,
    PAGE_LIMIT,
    `${gateFilter}|${sortBy}|${query}`
  )

  const visibleJobs = useMemo(
    () => filteredJobs.slice(0, lazyBatch.visibleCount),
    [filteredJobs, lazyBatch.visibleCount]
  )

  const noiseLimit = useMemo(() => {
    const item = data?.thresholds.items.find((entry) => entry.key === 'B2_noise_change_pct')
    if (!item) return null
    const match = item.threshold.match(/[-+]?\d+(?:\.\d+)?/)
    const value = match ? Number(match[0]) : Number.NaN
    return Number.isFinite(value) ? { value, label: item.threshold } : null
  }, [data])

  const failureBuckets = useMemo(() => {
    const map = new Map<string, number>()
    for (const job of jobs) {
      if (job.status === 'PASS') continue
      map.set(job.status, (map.get(job.status) ?? 0) + 1)
    }
    return [...map.entries()].map(([value, count]) => ({ value, count }))
  }, [jobs])

  const columns: Column<QcSummaryJob>[] = [
    {
      key: 'jobId',
      label: '任务 ID',
      cell: (row) => (
        <Link
          to={`/job/${row.jobId}/qc`}
          className="num inline-flex items-center gap-0.5 font-medium text-apple-blue focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
        >
          {row.jobId}
          <ChevronRight className="h-3 w-3" />
        </Link>
      )
    },
    { key: 'taskId', label: '关联任务', className: 'num whitespace-nowrap', cell: (row) => row.taskId },
    {
      key: 'status',
      label: '门禁结论',
      cell: (row) => (
        <span data-status={row.status} title={row.status}>
          <StatusChip status={row.status} label={STATUS_LABEL[row.status]} />
        </span>
      )
    },
    {
      key: 'passed',
      label: '通过 / 总判定',
      className: 'num tabular-nums whitespace-nowrap text-right',
      cell: (row) => (
        <span data-passed={row.passed} data-judged={row.judged}>
          {row.passed} / {row.judged}
        </span>
      )
    },
    {
      key: 'verdictExplain',
      label: '一眼看懂结论（白话）',
      cell: (row) => {
        const diag = explainJobSummaryRow(row)
        const headlineTone =
          diag.tone === 'pass'
            ? 'text-[#1E7A3C]'
            : diag.tone === 'fail'
              ? 'text-[#B3261E]'
              : diag.tone === 'warn'
                ? 'text-[#9A5B00]'
                : 'text-apple-subtext'
        return (
          <div className="max-w-[230px] leading-snug">
            <span className={`block text-[12px] font-semibold ${headlineTone}`}>{diag.headline}</span>
            <span className="mt-0.5 block truncate text-[11px] text-apple-subtext" title={diag.detail}>
              {diag.detail}
            </span>
          </div>
        )
      }
    },
    {
      key: 'ssim',
      label: '清晰度还原 (SSIM)',
      className: 'num tabular-nums whitespace-nowrap text-right',
      cell: (row) => (
        <span data-ssim={row.ssim ?? ''} title="1.0 最好，≥0.80 为肉眼高清不糊">
          {numText(row.ssim, 4) ?? '无数据'}
        </span>
      )
    },
    {
      key: 'noise',
      label: '雪花噪点变化',
      className: 'num tabular-nums whitespace-nowrap text-right',
      cell: (row) => (
        <span data-noise={row.noiseChangePct ?? ''} title="负值表示噪点减少画面更干净，≤+15% 为合格">
          {row.noiseChangePct == null ? '无数据' : `${row.noiseChangePct > 0 ? '+' : ''}${row.noiseChangePct.toFixed(1)}%`}
        </span>
      )
    },
    {
      key: 'netGain',
      label: '细节提升 (净增益)',
      className: 'num tabular-nums whitespace-nowrap text-right',
      cell: (row) => (
        <span data-net-gain={row.netGain ?? ''} title="≥1.5× 说明画面边缘更清晰立体">
          {numText(row.netGain, 2) ?? '无数据'}
        </span>
      )
    },
    {
      key: 'ghost',
      label: '运动重影 (鬼影比)',
      className: 'num tabular-nums whitespace-nowrap text-right',
      cell: (row) => (
        <span data-ghost={row.ghostRatio ?? ''} title="越低越好，≤1.5 表示快速动作不拖影">
          {numText(row.ghostRatio, 3) ?? '无数据'}
        </span>
      )
    },
    {
      key: 'hasQc',
      label: '完整报告',
      className: 'num tabular-nums whitespace-nowrap text-right',
      cell: (row) => <span data-has-qc={row.hasQc ? 'true' : 'false'}>{row.hasQc ? '有' : '无'}</span>
    }
  ]

  if (status === 'loading') {
    return (
      <div aria-busy="true" aria-label="正在读取 QC 总览">
        <div className="h-8 w-56 animate-pulse rounded-lg bg-black/[0.06]" />
        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4" data-equal-grid>
          {[0, 1, 2, 3].map((index) => (
            <div key={index} className="card h-[150px] animate-pulse" />
          ))}
        </div>
        <div className="card mt-5 h-[320px] animate-pulse" />
      </div>
    )
  }

  if (status === 'error' && !data) {
    return (
      <div>
        <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em] sm:text-[32px]">QC 质量门禁</h1>
        <div className="card mt-4 flex flex-wrap items-center justify-between gap-3 p-5" role="alert">
          <div>
            <p className="text-sm font-medium">QC 总览读取失败</p>
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
      </div>
    )
  }

  return (
    <div>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em] sm:text-[32px]">QC 质量门禁</h1>
          <p className="mt-1.5 max-w-[76ch] text-sm leading-relaxed text-apple-subtext">
            汇总全平台视频渲染任务的真实 QC 指标、门禁判定、失败异常分布与噪声变化趋势；缺失项如实显示「无数据」。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5" data-print-hide>
          <span className="num text-[11px] leading-relaxed text-apple-subtext">
            来源 {data?.meta.source ?? '无数据'}
            {updatedAt != null && ` · 同步于 ${formatClockMs(updatedAt)}`}
          </span>
          <ToolButton onClick={() => setLiveSync((v) => !v)} aria-pressed={liveSync}>
            {liveSync ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            {liveSync ? '实时巡检 4s' : '已暂停'}
          </ToolButton>
          <ToolButton onClick={refresh} disabled={refreshing}>
            <Refresh className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            {refreshing ? '刷新中' : '刷新'}
          </ToolButton>
        </div>
      </header>

      <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4" data-equal-grid data-stagger>
        <StatCard
          label="已完成质检视频"
          icon={<Shield className="h-4 w-4" />}
          tone="blue"
          note={`全平台共 ${jobs.length} 个视频任务，已完成自动体检并出报告`}
        >
          <p className="flex items-baseline gap-1.5" data-kpi="inspected">
            <span className="num text-kpi" data-value={kpi.inspected}>
              {kpi.inspected}
            </span>
            <span className="text-xs text-apple-subtext">支</span>
          </p>
        </StatCard>

        <StatCard
          label="可发布 / 需重修 / 待复查"
          icon={<Shield className="h-4 w-4" />}
          tone="green"
          note="PASS 可直接交付 · FAIL 建议调参重跑 · 点击下方可筛选"
        >
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1" data-kpi="gate">
            <span className="inline-flex items-baseline gap-1" data-gate="PASS" data-value={kpi.pass}>
              <span className="num text-[22px] font-semibold leading-none">{kpi.pass}</span>
              <span className="text-[11px] text-apple-subtext">可直接发</span>
            </span>
            <span className="inline-flex items-baseline gap-1" data-gate="FAIL" data-value={kpi.fail}>
              <span className="num text-[22px] font-semibold leading-none">{kpi.fail}</span>
              <span className="text-[11px] text-apple-subtext">需重修</span>
            </span>
            <span className="inline-flex items-baseline gap-1" data-gate="PENDING" data-value={kpi.pending}>
              <span className="num text-[22px] font-semibold leading-none">{kpi.pending}</span>
              <span className="text-[11px] text-apple-subtext">待复查</span>
            </span>
          </div>
        </StatCard>

        <StatCard
          label="画面清晰度均分 (SSIM)"
          icon={<Chart className="h-4 w-4" />}
          tone="purple"
          note={`满分 1.0，≥0.80 即肉眼高清不糊 · 实测 ${kpi.ssimCount} 支`}
        >
          <p className="flex items-baseline gap-1.5" data-kpi="ssim">
            <span className="num text-kpi" data-value={kpi.meanSsim?.toFixed(4) ?? ''}>
              {kpi.meanSsim == null ? '无数据' : kpi.meanSsim.toFixed(4)}
            </span>
            {kpi.meanSsim != null && (
              <span className={`text-[11px] font-medium ${kpi.meanSsim >= 0.8 ? 'text-[#1E7A3C]' : 'text-[#B3261E]'}`}>
                {kpi.meanSsim >= 0.8 ? '清晰达标' : '偏糊需检查'}
              </span>
            )}
          </p>
        </StatCard>

        <StatCard
          label="画面雪花噪点变化"
          icon={<Sliders className="h-4 w-4" />}
          tone="orange"
          note={`负数表示噪点变少画面更干净 · 实测 ${kpi.noiseValues.length} 支（不足2支不绘图）`}
        >
          <div data-kpi="noise" data-value={kpi.noiseInsufficient ? 'insufficient' : kpi.noiseMedian?.toFixed(1) ?? ''}>
            {kpi.noiseInsufficient ? (
              <p className="text-[20px] font-semibold leading-none tracking-tight text-apple-subtext">数据不足</p>
            ) : (
              <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="num text-kpi">{kpi.noiseMedian?.toFixed(1)}%</span>
                <span className="num text-xs text-apple-subtext">
                  {(kpi.noiseMedian ?? 0) <= 0 ? '噪点减少 · 更干净' : `中位数 · 最差 ${kpi.noiseMax?.toFixed(1)}%`}
                </span>
              </p>
            )}
          </div>
        </StatCard>
      </div>

      <section className="card mt-5 p-4 sm:p-5" aria-labelledby="qc-rules-title">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h2 id="qc-rules-title" className="text-[15px] font-semibold tracking-tight">
              质量体检标准（通俗解读）
            </h2>
            <p className="mt-0.5 text-[11px] leading-relaxed text-apple-subtext">
              把专业画面参数翻译为日常可理解的含义与处理建议；未实测指标如实显示「无数据」。
            </p>
          </div>
          <span className="num text-[11px] text-apple-subtext" data-testid="qc-rules-count">
            {data?.rules.length ?? 0} 条标准
          </span>
        </div>
        <QcRuleList rules={data?.rules ?? []} source={data?.rulesSource} explain />
      </section>

      <section className="card mt-5 p-4 sm:p-5" aria-labelledby="qc-jobs-title">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 id="qc-jobs-title" className="text-[15px] font-semibold tracking-tight">
              逐 job 指标与质量诊断
            </h2>
            <p className="mt-0.5 text-[11px] leading-relaxed text-apple-subtext">
              点击任务 ID 进入单片深度 QC 明细页（帧级对比、波形与音频门禁结果）。
            </p>
          </div>
          <div className="flex items-center gap-2" data-print-hide>
            <ToolButton onClick={() => exportSummaryCsv(filteredJobs)}>导出 CSV</ToolButton>
            <ToolButton onClick={() => window.print()}>打印</ToolButton>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2.5" data-print-hide>
          <FilterChipGroup
            label="按 QC 状态筛选"
            value={gateFilter}
            onChange={(next) => {
              setGateFilter(next)
            }}
            options={[
              { key: 'all', label: '全部', count: jobs.length },
              { key: 'PASS', label: '可直接发 (PASS)', count: kpi.pass },
              { key: 'FAIL', label: '需重修 (FAIL)', count: kpi.fail },
              { key: 'PENDING', label: '待复查', count: kpi.pending }
            ]}
          />
          <div className="flex flex-wrap items-center gap-2">
            <SelectMenu
              ariaLabel="排序方式"
              value={sortBy}
              onChange={(val) => setSortBy(val as QcSortKey)}
              options={SORT_OPTIONS}
              size="sm"
              align="right"
              className="w-[152px]"
            />
            <input
              type="search"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && query) setQuery('')
              }}
              placeholder="搜索 jobId / taskId"
              aria-label="搜索 jobId 或 taskId"
              className="h-8 w-full rounded-lg border border-black/[0.09] bg-white px-3 text-xs text-apple-text placeholder:text-apple-subtext focus:border-apple-blue focus:outline-none sm:w-52"
            />
          </div>
        </div>

        <div className="mt-3" data-testid="qc-jobs">
          <DataTable
            columns={columns}
            rows={visibleJobs}
            rowKey={(row) => row.jobId}
            rowAlign="middle"
            rowHeightClass="h-[58px]"
            rowClassName={(row) => (row.status === 'PASS' ? '' : 'bg-[rgba(255,59,48,0.04)] hover:bg-[rgba(255,59,48,0.06)]')}
            empty={
              jobs.length === 0
                ? '无 QC 任务数据（/api/qc/summary 返回 0 个 job）。'
                : '当前筛选条件下无匹配的 QC 任务。'
            }
          />
          {filteredJobs.length > 0 && (
            <div
              ref={lazyBatch.sentinelRef}
              className="mt-3 flex items-center justify-between border-t border-black/[0.06] pt-3 text-[11px] text-apple-subtext"
            >
              <span className="num">
                已显示 {visibleJobs.length} / {filteredJobs.length} 条质检记录
                {lazyBatch.hasMore ? ' · 向下滚动自动加载更多' : ' · 已全部加载'}
              </span>
              {lazyBatch.hasMore && (
                <button
                  type="button"
                  onClick={lazyBatch.loadMore}
                  className="press rounded-lg border border-black/[0.08] bg-white px-3 py-1 text-[11px] font-medium text-apple-text hover:bg-[#FAFAFC]"
                >
                  再加载 {Math.min(PAGE_LIMIT, filteredJobs.length - visibleJobs.length)} 条
                </button>
              )}
            </div>
          )}
        </div>
      </section>

      <div className="mt-3 grid gap-3 lg:grid-cols-2" data-equal-grid data-stagger>
        <section className="card flex h-full flex-col p-4 sm:p-5" aria-labelledby="qc-dist-title">
          <div className="flex items-baseline justify-between gap-2">
            <h2 id="qc-dist-title" className="text-[15px] font-semibold tracking-tight">
              失败 / 待判项分布
            </h2>
            <span className="num text-[11px] text-apple-subtext">{failureBuckets.reduce((sum, bucket) => sum + bucket.count, 0)} 项</span>
          </div>
          <p className="mt-0.5 text-[11px] leading-relaxed text-apple-subtext">
            按门禁状态原始值分布（点击状态行可立即筛选对应任务列表）。
          </p>
          <div className="mt-3 flex-1" data-testid="qc-dist">
            {failureBuckets.length === 0 ? (
              <p className="text-xs text-apple-subtext">无失败或待判项，全部受检任务均已 PASS。</p>
            ) : (
              <ul className="space-y-2.5">
                {failureBuckets.map((bucket) => {
                  const targetFilter: GateFilter = bucket.value === 'FAIL' ? 'FAIL' : 'PENDING'
                  const isActive = gateFilter === targetFilter
                  return (
                    <li
                      key={bucket.value}
                      data-status={bucket.value}
                      data-count={bucket.count}
                    >
                      <button
                        type="button"
                        onClick={() => setGateFilter(isActive ? 'all' : targetFilter)}
                        className={`w-full rounded-[10px] border p-2.5 text-left transition-colors ${
                          isActive
                            ? 'border-[#F3D3CF] bg-[#FFF8F6]'
                            : 'border-black/[0.06] bg-white hover:bg-[#FAFAFC]'
                        }`}
                      >
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="num text-xs font-medium text-apple-text">
                            {bucket.value}
                            <span className="ml-1.5 text-[10px] font-normal text-apple-subtext">
                              ({STATUS_LABEL[bucket.value as GateStatus] ?? bucket.value})
                            </span>
                          </span>
                          <span className="num text-sm font-semibold">{bucket.count}</span>
                        </div>
                        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-black/[0.05]">
                          <span
                            className={`block h-full rounded-full ${
                              bucket.value === 'FAIL' ? 'bg-[#D93830]' : 'bg-[#C77700]'
                            }`}
                            style={{ width: `${(bucket.count / Math.max(1, jobs.length)) * 100}%` }}
                          />
                        </div>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </section>

        <section className="card flex h-full flex-col p-4 sm:p-5" aria-labelledby="qc-trend-title">
          <div className="flex items-baseline justify-between gap-2">
            <h2 id="qc-trend-title" className="text-[15px] font-semibold tracking-tight">
              画面雪花噪点变化趋势
            </h2>
            <span className="num text-[11px] text-apple-subtext">绿线越靠下越干净 · 橙色虚线为警戒线</span>
          </div>
          <p className="mt-0.5 text-[11px] leading-relaxed text-apple-subtext">
            绿点在橙色警戒线下方且为负数，说明噪点比原片明显减少、画质更纯净；超出橙线说明颗粒变重建议调参。
          </p>
          <div className="mt-3 flex-1">
            <NoiseTrend jobs={jobs} limit={noiseLimit} />
          </div>
        </section>
      </div>

      {data && (
        <p className="mt-4 text-[11px] leading-relaxed text-apple-subtext">
          阈值口径：<span className="num break-all">{data.thresholds.source}</span>
        </p>
      )}
    </div>
  )
}
