import { useMemo, type ReactNode } from 'react'
import type { GateStatus, QcSummaryJob, QcSummaryResponse } from '../types'
import { useJson } from '../api'
import { Link } from '../router'
import { StatusChip } from '../components/StatusChip'
import { DataTable, type Column } from '../components/DataTable'
import { QcRuleList } from '../components/QcRuleList'
import { Chart, ChevronRight, Refresh, Shield, Sliders } from '../components/icons'

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

function numText(value: number | null | undefined, digits: number): string | null {
  if (value == null || !Number.isFinite(value)) return null
  return value.toFixed(digits)
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function csvCell(value: string | number | null): string {
  if (value == null) return '无数据'
  const text = String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function downloadCsv(rows: QcSummaryJob[]) {
  const header = ['jobId', 'taskId', '状态', 'passed', 'judged', 'SSIM', '噪声变化%', '净增益', '鬼影比', 'hasQc']
  const lines = [
    header.join(','),
    ...rows.map((row) =>
      [
        csvCell(row.jobId),
        csvCell(row.taskId),
        csvCell(row.status),
        csvCell(row.passed),
        csvCell(row.judged),
        csvCell(row.ssim),
        csvCell(row.noiseChangePct),
        csvCell(row.netGain),
        csvCell(row.ghostRatio),
        csvCell(row.hasQc ? 'true' : 'false')
      ].join(',')
    )
  ]
  const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  anchor.href = url
  anchor.download = `qc-summary-${stamp}.csv`
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
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

function ToolButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-print-hide
      className="press flex h-8 items-center gap-1.5 rounded-lg border border-black/[0.07] bg-white/85 px-2.5 text-xs font-medium shadow-soft transition-colors hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
    >
      {children}
    </button>
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
        .map((job) => ({ jobId: job.jobId, value: job.noiseChangePct }))
        .filter((point): point is { jobId: string; value: number } => point.value != null && Number.isFinite(point.value)),
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

  const W = 360
  const H = 150
  const P = 30
  const values = points.map((point) => point.value)
  const lo = Math.min(0, ...values, limit?.value ?? Infinity)
  const hi = Math.max(1, ...values, limit?.value ?? -Infinity)
  const x = (index: number) => P + (index / (points.length - 1)) * (W - P * 2)
  const y = (value: number) => P + (1 - (value - lo) / (hi - lo || 1)) * (H - P * 2)

  // Catmull-Rom → 三次贝塞尔：Apple Health 风格平滑曲线，只连真实点。
  const curve = (() => {
    const px = points.map((_, index) => x(index))
    const py = points.map((point) => y(point.value))
    let d = `M${px[0].toFixed(2)},${py[0].toFixed(2)}`
    for (let i = 0; i < points.length - 1; i += 1) {
      const x0 = px[i - 1] ?? px[i]
      const y0 = py[i - 1] ?? py[i]
      const x1 = px[i]
      const y1 = py[i]
      const x2 = px[i + 1]
      const y2 = py[i + 1]
      const x3 = px[i + 2] ?? x2
      const y3 = py[i + 2] ?? py[i + 1]
      d += ` C${(x1 + (x2 - x0) / 6).toFixed(2)},${(y1 + (y2 - y0) / 6).toFixed(2)} ${(x2 - (x3 - x1) / 6).toFixed(2)},${(
        y2 - (y3 - y1) / 6
      ).toFixed(2)} ${x2.toFixed(2)},${y2.toFixed(2)}`
    }
    return d
  })()
  const area = `${curve} L${x(points.length - 1).toFixed(2)},${H - P} L${x(0).toFixed(2)},${H - P} Z`
  const mid = (lo + hi) / 2

  return (
    <div data-testid="qc-trend" data-points={points.length}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`噪声变化趋势：${points.map((point) => `${point.jobId} ${point.value}%`).join('，')}`}
        className="w-full max-w-[420px]"
      >
        <line x1={P} y1={H - P} x2={W - P} y2={H - P} stroke="#E5E5EA" strokeWidth="1" />
        <line x1={P} y1={P} x2={P} y2={H - P} stroke="#E5E5EA" strokeWidth="1" />
        {[lo, mid, hi].map((tick) => (
          <line
            key={tick}
            x1={P}
            y1={y(tick)}
            x2={W - P}
            y2={y(tick)}
            stroke="#F0F0F3"
            strokeWidth="1"
            strokeDasharray={tick === 0 ? undefined : '2 4'}
          />
        ))}
        <text x={P - 4} y={P + 3} textAnchor="end" fontSize="9" fill="#6E6E73">
          {hi.toFixed(1)}%
        </text>
        <text x={P - 4} y={H - P + 3} textAnchor="end" fontSize="9" fill="#6E6E73">
          {lo.toFixed(1)}%
        </text>
        <defs>
          <linearGradient id="qc-noise-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#30A14E" stopOpacity="0.16" />
            <stop offset="100%" stopColor="#30A14E" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#qc-noise-fill)" />
        <path
          d={curve}
          fill="none"
          stroke="#30A14E"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
          className="chart-line"
        />
        {limit && (
          <g>
            <line
              x1={P}
              y1={y(limit.value)}
              x2={W - P}
              y2={y(limit.value)}
              stroke="#C77700"
              strokeWidth="1"
              strokeDasharray="4 3"
            />
            <text x={W - P} y={y(limit.value) - 4} textAnchor="end" fontSize="9" fill="#B25000">
              阈值 {limit.label}
            </text>
          </g>
        )}
        {points.map((point, index) => (
          <g key={point.jobId}>
            <circle cx={x(index)} cy={y(point.value)} r="3.5" fill="#30A14E" stroke="#fff" strokeWidth="1.5" />
            <text x={x(index)} y={H - 12} textAnchor="middle" fontSize="9" fill="#6E6E73">
              {point.jobId}
            </text>
            <text x={x(index)} y={y(point.value) - 8} textAnchor="middle" fontSize="9" fill="#1D1D1F" className="num">
              {point.value.toFixed(1)}%
            </text>
          </g>
        ))}
      </svg>
      <p className="mt-1 text-[11px] leading-relaxed text-apple-subtext">折线按 /api/qc/summary 返回顺序绘制，仅含真实值。</p>
    </div>
  )
}

export function QcOverviewPage() {
  const { status, data, error, retry } = useJson<QcSummaryResponse>('/api/qc/summary')
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
      label: 'jobId',
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
    { key: 'taskId', label: 'taskId', className: 'num whitespace-nowrap', cell: (row) => row.taskId },
    {
      key: 'status',
      label: '状态',
      cell: (row) => (
        <span data-status={row.status} title={row.status}>
          <StatusChip status={row.status} label={STATUS_LABEL[row.status]} />
        </span>
      )
    },
    {
      key: 'passed',
      label: 'passed / judged',
      className: 'num tabular-nums whitespace-nowrap text-right',
      cell: (row) => (
        <span data-passed={row.passed} data-judged={row.judged}>
          {row.passed} / {row.judged}
        </span>
      )
    },
    {
      key: 'ssim',
      label: 'SSIM',
      className: 'num tabular-nums whitespace-nowrap text-right',
      cell: (row) => <span data-ssim={row.ssim ?? ''}>{numText(row.ssim, 4) ?? '无数据'}</span>
    },
    {
      key: 'noise',
      label: '噪声变化 %',
      className: 'num tabular-nums whitespace-nowrap text-right',
      cell: (row) => (
        <span data-noise={row.noiseChangePct ?? ''}>
          {row.noiseChangePct == null ? '无数据' : `${row.noiseChangePct > 0 ? '+' : ''}${row.noiseChangePct.toFixed(1)}%`}
        </span>
      )
    },
    {
      key: 'netGain',
      label: '净增益',
      className: 'num tabular-nums whitespace-nowrap text-right',
      cell: (row) => <span data-net-gain={row.netGain ?? ''}>{numText(row.netGain, 2) ?? '无数据'}</span>
    },
    {
      key: 'ghost',
      label: '鬼影比',
      className: 'num tabular-nums whitespace-nowrap text-right',
      cell: (row) => <span data-ghost={row.ghostRatio ?? ''}>{numText(row.ghostRatio, 3) ?? '无数据'}</span>
    },
    {
      key: 'hasQc',
      label: 'hasQc',
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

  if (status === 'error') {
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
            汇总所有任务的真实 QC 指标、门禁判定与噪声变化；缺失一律显示无数据，不以 0 冒充。
          </p>
        </div>
        <p className="num text-[11px] leading-relaxed text-apple-subtext">
          数据 /api/qc/summary · 来源 {data?.meta.source ?? '无数据'}
        </p>
      </header>

      <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4" data-equal-grid data-stagger>
        <StatCard
          label="受检 job 数"
          icon={<Shield className="h-4 w-4" />}
          tone="blue"
          note={`共 ${jobs.length} 个任务 · hasQc=true 才计入`}
        >
          <p className="flex items-baseline gap-1.5" data-kpi="inspected">
            <span className="num text-kpi" data-value={kpi.inspected}>
              {kpi.inspected}
            </span>
            <span className="text-xs text-apple-subtext">个</span>
          </p>
        </StatCard>

        <StatCard
          label="PASS / FAIL / 待判"
          icon={<Shield className="h-4 w-4" />}
          tone="green"
          note="按 status 真实分组 · 待判 = 非 PASS 且非 FAIL"
        >
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1" data-kpi="gate">
            <span className="inline-flex items-baseline gap-1" data-gate="PASS" data-value={kpi.pass}>
              <span className="num text-[22px] font-semibold leading-none">{kpi.pass}</span>
              <span className="text-[11px] text-apple-subtext">PASS</span>
            </span>
            <span className="inline-flex items-baseline gap-1" data-gate="FAIL" data-value={kpi.fail}>
              <span className="num text-[22px] font-semibold leading-none">{kpi.fail}</span>
              <span className="text-[11px] text-apple-subtext">FAIL</span>
            </span>
            <span className="inline-flex items-baseline gap-1" data-gate="PENDING" data-value={kpi.pending}>
              <span className="num text-[22px] font-semibold leading-none">{kpi.pending}</span>
              <span className="text-[11px] text-apple-subtext">待判</span>
            </span>
          </div>
        </StatCard>

        <StatCard
          label="平均 SSIM"
          icon={<Chart className="h-4 w-4" />}
          tone="purple"
          note={`仅统计有值项 · n=${kpi.ssimCount}`}
        >
          <p className="flex items-baseline gap-1.5" data-kpi="ssim">
            <span className="num text-kpi" data-value={kpi.meanSsim?.toFixed(4) ?? ''}>
              {kpi.meanSsim == null ? '无数据' : kpi.meanSsim.toFixed(4)}
            </span>
          </p>
        </StatCard>

        <StatCard
          label="噪声变化"
          icon={<Sliders className="h-4 w-4" />}
          tone="orange"
          note={`有效值 n=${kpi.noiseValues.length} · 低于 2 个不绘图`}
        >
          <div data-kpi="noise" data-value={kpi.noiseInsufficient ? 'insufficient' : kpi.noiseMedian?.toFixed(1) ?? ''}>
            {kpi.noiseInsufficient ? (
              <p className="text-[20px] font-semibold leading-none tracking-tight text-apple-subtext">数据不足</p>
            ) : (
              <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="num text-kpi">{kpi.noiseMedian?.toFixed(1)}%</span>
                <span className="num text-xs text-apple-subtext">中位数 · 最大 {kpi.noiseMax?.toFixed(1)}%</span>
              </p>
            )}
          </div>
        </StatCard>
      </div>

      <section className="card mt-5 p-4 sm:p-5" aria-labelledby="qc-rules-title">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h2 id="qc-rules-title" className="text-[15px] font-semibold tracking-tight">
              门禁规则清单
            </h2>
            <p className="mt-0.5 text-[11px] leading-relaxed text-apple-subtext">
              名称 / 阈值（op / unit）/ 实际值 / 判定；actual 为 null 显示「无数据」，不造数。
            </p>
          </div>
          <span className="num text-[11px] text-apple-subtext" data-testid="qc-rules-count">
            {data?.rules.length ?? 0} 条
          </span>
        </div>
        <QcRuleList rules={data?.rules ?? []} source={data?.rulesSource} />
      </section>

      <section className="card mt-5 p-4 sm:p-5" aria-labelledby="qc-jobs-title">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 id="qc-jobs-title" className="text-[15px] font-semibold tracking-tight">
              逐 job 指标
            </h2>
            <p className="mt-0.5 text-[11px] leading-relaxed text-apple-subtext">
              jobId 链到 /job/:id/qc 明细；null 显示无数据。
            </p>
          </div>
          <div className="flex items-center gap-2" data-print-hide>
            <ToolButton onClick={() => downloadCsv(jobs)}>导出 CSV</ToolButton>
            <ToolButton onClick={() => window.print()}>打印</ToolButton>
          </div>
        </div>
        <div className="mt-3" data-testid="qc-jobs">
          <DataTable
            columns={columns}
            rows={jobs}
            rowKey={(row) => row.jobId}
            rowAlign="middle"
            rowHeightClass="h-[54px]"
            rowClassName={(row) => (row.status === 'PASS' ? '' : 'bg-[rgba(255,59,48,0.04)] hover:bg-[rgba(255,59,48,0.06)]')}
            empty="无 QC 任务数据（/api/qc/summary 返回 0 个 job）。"
          />
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
            按 /api/qc/summary 的 status 原始值分组，不重命名、不合并。
          </p>
          <div className="mt-3 flex-1" data-testid="qc-dist">
            {failureBuckets.length === 0 ? (
              <p className="text-xs text-apple-subtext">无失败或待判项。</p>
            ) : (
              <ul className="space-y-2.5">
                {failureBuckets.map((bucket) => (
                  <li key={bucket.value} className="flex items-center justify-between gap-3" data-status={bucket.value} data-count={bucket.count}>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="num rounded bg-apple-bg px-1.5 py-0.5 text-[11px] font-medium text-apple-subtextAlt">
                          {bucket.value}
                        </span>
                        <span className="num text-sm font-semibold">{bucket.count}</span>
                      </div>
                      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-black/[0.05]">
                        <span
                          className="block h-full rounded-full bg-[#C77700]"
                          style={{ width: `${(bucket.count / Math.max(1, jobs.length)) * 100}%` }}
                        />
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <section className="card flex h-full flex-col p-4 sm:p-5" aria-labelledby="qc-trend-title">
          <div className="flex items-baseline justify-between gap-2">
            <h2 id="qc-trend-title" className="text-[15px] font-semibold tracking-tight">
              噪声趋势
            </h2>
            <span className="num text-[11px] text-apple-subtext">B2 · noiseChangePct</span>
          </div>
          <p className="mt-0.5 text-[11px] leading-relaxed text-apple-subtext">
            仅当真实值 ≥2 个时绘制折线；无阈值线时只画数据点。
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
