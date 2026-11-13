import { useMemo, useState, type ReactNode } from 'react'
import type {
  PlanResponse,
  PlanTask,
  RiskDecision,
  RiskDecisionListResponse,
  RiskDecisionResponse,
  WeeklyReportResponse,
  WeeklyRisk
} from '../types'
import { postJson, useJson } from '../api'
import { Link } from '../router'
import { DataTable, type Column } from '../components/DataTable'
import { RiskDecisionDialog } from '../components/RiskDecisionDialog'
import { Calendar, Chart, Check, Clock, Film, Refresh, TriangleAlert } from '../components/icons'

const TONE = {
  blue: { tile: 'bg-[#EAF2FF] text-[#0A6CD8] ring-[#D8E6FE]', accent: '#0071E3' },
  green: { tile: 'bg-[#EAF8EE] text-[#1E7A3C] ring-[#D5EFDC]', accent: '#30A14E' },
  gray: { tile: 'bg-[#F2F2F7] text-[#6B6B70] ring-[#E5E5EA]', accent: '#8E8E93' },
  orange: { tile: 'bg-[#FFF3E4] text-[#B25E00] ring-[#F8E2C8]', accent: '#C77700' },
  red: { tile: 'bg-[#FDECEB] text-[#B3261E] ring-[#F7D4D1]', accent: '#FF3B30' }
} as const

const PLAN_STATUS: Record<string, { label: string; className: string }> = {
  done: { label: '完成', className: 'bg-[#EAF8EE] text-[#1E7A3C] ring-[#D5EFDC]' },
  running: { label: '执行中', className: 'bg-[#EAF2FF] text-[#0A6CD8] ring-[#D8E6FE]' },
  pending: { label: '待排队', className: 'bg-[#F2F2F7] text-[#6B6B70] ring-[#E5E5EA]' },
  blocked: { label: '阻塞', className: 'bg-[#FFF3E4] text-[#B25E00] ring-[#F8E2C8]' }
}

const MILESTONE_STATE: Record<string, string> = {
  done: '已完成',
  in_progress: '进行中',
  pending: '未开始'
}

function stamp(value: string | null | undefined): string {
  if (!value) return '无数据'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value.slice(0, 16).replace('T', ' ')
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function pct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '无数据'
  return `${(value * 100).toFixed(1)}%`
}

function railText(rail: string | null | undefined): string {
  if (!rail) return '未标注'
  if (rail === 'both') return '双轨'
  if (rail === 'A' || rail === 'B') return `${rail} 轨`
  return rail
}

function csvCell(value: string | number | null | undefined): string {
  if (value == null) return ''
  const text = String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

type CsvValue = string | number | null | undefined

function downloadCsv(weekly: WeeklyReportResponse | null, tasks: PlanTask[]) {
  const lines: CsvValue[][] = []
  const period = weekly?.period
  lines.push(['周报周期', period ? `${period.from} ~ ${period.to}` : '无数据', period ? `${period.days} 天` : ''])
  lines.push([])
  const summary = weekly?.summary
  lines.push(['任务统计', '总数', '完成', '执行中', '待排队', '阻塞', '完成率', '交付数', '已修复'])
  lines.push([
    '本周',
    summary?.tasks.total ?? '',
    summary?.tasks.done ?? '',
    summary?.tasks.running ?? '',
    summary?.tasks.pending ?? '',
    summary?.tasks.blocked ?? '',
    summary ? pct(summary.completion_rate) : '',
    summary?.deliveries.count ?? '',
    summary?.deliveries.repaired ?? ''
  ])
  lines.push([])
  lines.push(['任务', 'task_id', 'title', 'owner', 'rail', 'status', 'end_ts', 'progress'])
  for (const task of tasks) {
    lines.push([`${task.id}`, task.id, task.title, task.owner, task.rail, task.status, task.end, `${task.progress}`])
  }
  lines.push([])
  lines.push(['偏差', 'task_id', 'title', 'owner', 'status', 'end_ts', 'overdue_days', 'progress'])
  for (const row of weekly?.deviations ?? []) {
    lines.push([
      '偏差',
      row.task_id,
      row.title,
      row.owner,
      row.status,
      row.end_ts,
      row.overdue_days,
      row.progress == null ? '' : `${row.progress}`
    ])
  }

  const csv = lines.map((line) => line.map(csvCell).join(',')).join('\r\n')
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  anchor.href = url
  anchor.download = `weekly-report-${day}.csv`
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
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

function StatCard({
  label,
  icon,
  tone,
  note,
  kpi,
  children
}: {
  label: string
  icon: ReactNode
  tone: keyof typeof TONE
  note: string
  kpi: string
  children: ReactNode
}) {
  const colors = TONE[tone]
  return (
    <div className="card relative flex h-full min-w-0 flex-col overflow-hidden p-4">
      <span aria-hidden="true" className="absolute inset-x-0 top-0 h-[3px]" style={{ backgroundColor: colors.accent }} />
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-normal leading-5 text-apple-subtext">{label}</span>
        <span className={`grid h-9 w-9 place-items-center rounded-[10px] ring-1 ring-inset ${colors.tile}`}>{icon}</span>
      </div>
      <div className="mt-2.5 flex-1">
        <p className="flex items-baseline gap-1.5" data-kpi={kpi}>
          {children}
        </p>
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-apple-subtext">{note}</p>
    </div>
  )
}

function Distribution({ title, id, hint, rows, testId }: { title: string; id: string; hint: string; rows: { key: string; label: string; count: number }[]; testId: string }) {
  const max = Math.max(1, ...rows.map((row) => row.count))
  const total = rows.reduce((sum, row) => sum + row.count, 0)
  return (
    <section className="card flex h-full flex-col p-4 sm:p-5" aria-labelledby={id}>
      <div className="flex items-baseline justify-between gap-2">
        <h2 id={id} className="text-[15px] font-semibold tracking-tight">
          {title}
        </h2>
        <span className="num text-[11px] text-apple-subtext">{rows.length} 组</span>
      </div>
      <p className="mt-0.5 text-[11px] leading-relaxed text-apple-subtext">{hint}</p>
      <div className="mt-3 flex-1" data-testid={testId}>
        {rows.length === 0 ? (
          <p className="text-xs text-apple-subtext">任务计划不可用，无法分组。</p>
        ) : (
          <ul className="space-y-2.5">
            {rows.map((row) => (
              <li key={row.key} className="min-w-0" data-key={row.key} data-count={row.count}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 break-words text-[12px] leading-5">{row.label}</span>
                  <span className="flex shrink-0 items-baseline justify-end gap-1.5">
                    <span className="num text-sm font-semibold">{row.count}</span>
                    <span className="num w-9 text-right text-[11px] text-apple-subtext">
                      {total > 0 ? `${Math.round((row.count / total) * 100)}%` : '—'}
                    </span>
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-black/[0.05]">
                  <span
                    className="block h-full rounded-full transition-[width] duration-300 ease-apple"
                    style={{ width: `${(row.count / max) * 100}%`, backgroundColor: '#0071E3' }}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

function RiskRow({
  risk,
  decision,
  onDispose
}: {
  risk: WeeklyRisk
  decision?: RiskDecision
  onDispose: (taskId: string) => void
}) {
  const blocked = risk.level === 'blocked'
  const tone = blocked ? 'bg-[#FFF3E4] text-[#8A4B00] ring-[#F0D9BC]' : 'bg-[#FDECEB] text-[#B3261E] ring-[#F7D4D1]'
  const surface = blocked ? 'bg-yellow-50/50 ring-yellow-100' : 'bg-red-50/50 ring-red-100'
  return (
    <li
      className={`rounded-lg px-2.5 py-2 ring-1 ring-inset ${surface}`}
      data-level={risk.level}
      data-task={risk.task_id ?? ''}
    >
      <div className="flex items-start gap-2">
        <span className={`num mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset ${tone}`}>
          {risk.level}
        </span>
        <span className="min-w-0 flex-1 break-words text-xs leading-5">{risk.text}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 pl-0.5">
        {decision ? (
          <span
            data-testid="risk-decision-badge"
            title={decision.note || undefined}
            className="inline-flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded-full bg-[#EAF2FF] px-2 py-0.5 text-[11px] font-medium text-[#0A6CD8] ring-1 ring-inset ring-[#D8E6FE]"
          >
            <span className="break-words">{decision.action}</span>
            <span className="num font-normal text-apple-subtext">{stamp(decision.ts)}</span>
            <span className="font-normal text-apple-subtext">· {decision.actor}</span>
          </span>
        ) : (
          <span className="text-[11px] text-apple-subtext">尚未处置</span>
        )}
        <button
          type="button"
          data-testid="risk-dispose"
          data-task={risk.task_id ?? ''}
          disabled={!risk.task_id}
          onClick={() => risk.task_id && onDispose(risk.task_id)}
          className="h-7 shrink-0 rounded-full border border-black/[0.1] px-3 text-[11px] font-medium text-apple-text transition-colors hover:bg-black/[0.03] focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50 disabled:cursor-not-allowed disabled:opacity-40"
        >
          处置
        </button>
      </div>
      {decision?.note && (
        <p className="mt-1 break-words pl-0.5 text-[11px] leading-relaxed text-apple-subtext">{decision.note}</p>
      )}
    </li>
  )
}

function Burndown({ weekly }: { weekly: WeeklyReportResponse }) {
  const points = (weekly.burndown ?? []).filter((point) => Number.isFinite(point.remaining))
  const note = weekly.meta?.note

  if (points.length < 2) {
    return (
      <div data-testid="burndown" data-points={points.length}>
        <p className="text-[20px] font-semibold leading-none tracking-tight text-apple-subtext">数据不足</p>
        <p className="mt-2 text-xs leading-relaxed text-apple-subtext">
          {note ?? '无历史快照（DB 未启用）'}；燃尽需要至少 2 个快照，不以 0 或模拟值补点。
        </p>
      </div>
    )
  }

  const W = 520
  const H = 170
  const P = 34
  const values = points.map((point) => point.remaining)
  const lo = Math.min(0, ...values)
  const hi = Math.max(1, ...values)
  const x = (index: number) => P + (index / (points.length - 1)) * (W - P * 2)
  const y = (value: number) => P + (1 - (value - lo) / (hi - lo || 1)) * (H - P * 2)
  const polyline = points.map((point, index) => `${x(index)},${y(point.remaining)}`).join(' ')

  return (
    <div data-testid="burndown" data-points={points.length}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`燃尽剩余任务：${points.map((point) => `${point.date} ${point.remaining}`).join('，')}`}
        className="w-full"
      >
        <line x1={P} y1={H - P} x2={W - P} y2={H - P} stroke="#E5E5EA" strokeWidth="1" />
        <line x1={P} y1={P} x2={P} y2={H - P} stroke="#E5E5EA" strokeWidth="1" />
        <text x={P - 4} y={P + 3} textAnchor="end" fontSize="9" fill="#6E6E73">
          {hi}
        </text>
        <text x={P - 4} y={H - P + 3} textAnchor="end" fontSize="9" fill="#6E6E73">
          {lo}
        </text>
        <polyline
          points={polyline}
          fill="none"
          stroke="#0071E3"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
          className="chart-line"
        />
        {points.map((point, index) => (
          <g key={point.date}>
            <circle cx={x(index)} cy={y(point.remaining)} r="3.5" fill="#0071E3" stroke="#fff" strokeWidth="1.5" />
            <text x={x(index)} y={H - 12} textAnchor="middle" fontSize="9" fill="#6E6E73">
              {point.date.slice(5)}
            </text>
            <text x={x(index)} y={y(point.remaining) - 8} textAnchor="middle" fontSize="9" fill="#1D1D1F" className="num">
              {point.remaining}
            </text>
          </g>
        ))}
      </svg>
      <p className="mt-1 text-[11px] leading-relaxed text-apple-subtext">
        {weekly.velocity ? `速度 ${weekly.velocity.completed_per_day} 任务/天 · ` : ''}
        数据来自 {weekly.meta?.source ?? '无数据'}，仅绘制真实快照。
      </p>
    </div>
  )
}

export function ReportsPage() {
  const weekly = useJson<WeeklyReportResponse>('/api/reports/weekly?days=7')
  const plan = useJson<PlanResponse>('/api/plan')
  const report = weekly.data
  const tasks = plan.data?.data?.tasks ?? []

  const summary = report?.summary
  const deviations = report?.deviations ?? []
  const risks = report?.risks ?? []
  const milestones = report?.milestones ?? []

  // #108 处置记录：接口已按时间倒序，每个 task 取第一条即最新。
  const decisions = useJson<RiskDecisionListResponse>('/api/risk-decisions')
  const latestDecision = useMemo(() => {
    const map = new Map<string, RiskDecision>()
    for (const decision of decisions.data?.decisions ?? []) {
      if (!map.has(decision.task_id)) map.set(decision.task_id, decision)
    }
    return map
  }, [decisions.data])
  const tasksById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks])
  const [dispose, setDispose] = useState<{ taskId: string; title: string } | null>(null)

  const ownerRows = useMemo(() => {
    const counts = new Map<string, number>()
    for (const task of tasks) {
      const key = task.owner || '未标注'
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return [...counts.entries()]
      .map(([label, count]) => ({ key: label, label, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
  }, [tasks])

  const railRows = useMemo(() => {
    const counts = new Map<string, number>()
    for (const task of tasks) {
      const key = task.rail || '未标注'
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return [...counts.entries()]
      .map(([key, count]) => ({ key, label: railText(key === '未标注' ? null : key), count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
  }, [tasks])

  const columns: Column<(typeof deviations)[number]>[] = [
    {
      key: 'task_id',
      label: 'task_id',
      cell: (row) => (
        <Link
          to="/status"
          className="num inline-flex items-center gap-0.5 font-medium text-apple-blue focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
        >
          {row.task_id ?? '无数据'}
        </Link>
      )
    },
    { key: 'title', label: '标题', cell: (row) => <span className="break-words">{row.title ?? '无数据'}</span> },
    { key: 'owner', label: 'owner', className: 'num whitespace-nowrap', cell: (row) => row.owner ?? '无数据' },
    {
      key: 'status',
      label: '状态',
      cell: (row) => {
        const meta = row.status ? PLAN_STATUS[row.status] : undefined
        return (
          <span
            data-status={row.status ?? ''}
            className={`inline-flex whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset ${
              meta?.className ?? 'bg-[#F2F2F7] text-[#6B6B70] ring-[#E5E5EA]'
            }`}
          >
            {meta?.label ?? row.status ?? '无数据'}
          </span>
        )
      }
    },
    {
      key: 'end_ts',
      label: '截止',
      className: 'num whitespace-nowrap',
      cell: (row) => stamp(row.end_ts)
    },
    {
      key: 'overdue_days',
      label: '超期天数',
      className: 'num whitespace-nowrap text-right',
      cell: (row) => row.overdue_days
    },
    {
      key: 'progress',
      label: '进度',
      className: 'num whitespace-nowrap text-right',
      cell: (row) => (row.progress == null ? '无数据' : `${row.progress}%`)
    }
  ]

  if (weekly.status === 'error') {
    return (
      <div>
        <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em] sm:text-[32px]">报表与周报</h1>
        <div className="card mt-4 flex flex-wrap items-center justify-between gap-3 p-5" role="alert">
          <div>
            <p className="text-sm font-medium">周报读取失败</p>
            <p className="mt-1 text-xs text-apple-subtext">{weekly.error}</p>
          </div>
          <button
            type="button"
            onClick={weekly.retry}
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
    <div data-print-reports>
      <style>{`@media print {
  [data-print-reports] .overflow-x-auto { overflow: visible !important; width: 100% !important; }
  [data-print-reports] table { font-size: 10px; }
}`}</style>

      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em] sm:text-[32px]">报表与周报</h1>
          <p className="mt-1.5 max-w-[76ch] text-sm leading-relaxed text-apple-subtext">
            本周任务节奏、负责人与轨别分布、偏差与风险；全部数值来自真实数据，缺失时显示无数据。
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <p className="num text-[11px] leading-relaxed text-apple-subtext">
            {report?.period ? `${stamp(report.period.from)} ~ ${stamp(report.period.to)} · ${report.period.days} 天` : '周期无数据'}
            <br />
            数据 /api/reports/weekly · /api/plan · 来源 {report?.meta?.source ?? '无数据'}
          </p>
          <div className="flex items-center gap-2" data-print-hide>
            <ToolButton onClick={() => downloadCsv(report, tasks)}>导出 CSV</ToolButton>
            <ToolButton onClick={() => window.print()}>打印</ToolButton>
          </div>
        </div>
      </header>

      {weekly.status === 'loading' && (
        <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-3" aria-busy="true" aria-label="正在读取周报">
          {[0, 1, 2, 3, 4, 5].map((index) => (
            <div key={index} className="card h-[150px] animate-pulse" />
          ))}
        </div>
      )}

      {weekly.status === 'ready' && report && !report.available && (
        <div className="card mt-5 p-5">
          <p className="text-sm font-medium">周报不可用</p>
          <p className="mt-1 text-xs leading-relaxed text-apple-subtext">
            {report.reason ?? '数据源未就绪'}；不以 0 或模拟值填充。
          </p>
        </div>
      )}

      {weekly.status === 'ready' && report?.available && (
        <>
          <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-3" data-equal-grid data-stagger>
            <StatCard label="本周任务总数" icon={<Calendar className="h-4 w-4" />} tone="blue" note="来自 /api/reports/weekly 的 summary.tasks" kpi="total">
              <span className="num text-kpi" data-value={summary?.tasks.total ?? 0}>
                {summary?.tasks.total ?? 0}
              </span>
              <span className="text-xs text-apple-subtext">项</span>
            </StatCard>
            <StatCard label="完成" icon={<Check className="h-4 w-4" />} tone="green" note={`完成率 ${summary ? pct(summary.completion_rate) : '无数据'}`} kpi="done">
              <span className="num text-kpi" data-value={summary?.tasks.done ?? 0}>
                {summary?.tasks.done ?? 0}
              </span>
              <span className="text-xs text-apple-subtext">项</span>
            </StatCard>
            <StatCard label="执行中" icon={<Clock className="h-4 w-4" />} tone="blue" note="status = running" kpi="running">
              <span className="num text-kpi" data-value={summary?.tasks.running ?? 0}>
                {summary?.tasks.running ?? 0}
              </span>
              <span className="text-xs text-apple-subtext">项</span>
            </StatCard>
            <StatCard label="待排队" icon={<Clock className="h-4 w-4" />} tone="gray" note="status = pending" kpi="pending">
              <span className="num text-kpi" data-value={summary?.tasks.pending ?? 0}>
                {summary?.tasks.pending ?? 0}
              </span>
              <span className="text-xs text-apple-subtext">项</span>
            </StatCard>
            <StatCard label="阻塞" icon={<TriangleAlert className="h-4 w-4" />} tone="orange" note="status = blocked" kpi="blocked">
              <span className="num text-kpi" data-value={summary?.tasks.blocked ?? 0}>
                {summary?.tasks.blocked ?? 0}
              </span>
              <span className="text-xs text-apple-subtext">项</span>
            </StatCard>
            <StatCard
              label="交付"
              icon={<Film className="h-4 w-4" />}
              tone="green"
              note={`其中已修复 ${summary?.deliveries.repaired ?? 0} 个`}
              kpi="deliveries"
            >
              <span className="num text-kpi" data-value={summary?.deliveries.count ?? 0}>
                {summary?.deliveries.count ?? 0}
              </span>
              <span className="text-xs text-apple-subtext">个成片</span>
            </StatCard>
          </div>

          <div className="mt-3 grid gap-3 lg:grid-cols-2" data-equal-grid data-stagger>
            <Distribution
              title="owner 分布"
              id="reports-owner-title"
              hint="按 /api/plan 任务的 owner 原值分组，不重命名、不合并。"
              rows={ownerRows}
              testId="owner-dist"
            />
            <Distribution
              title="轨别分布"
              id="reports-rail-title"
              hint="rail = A / B / both（双轨）；缺失归入未标注，未知值保留原文。"
              rows={railRows}
              testId="rail-dist"
            />
          </div>

          <section className="card mt-3 p-4 sm:p-5" aria-labelledby="reports-deviations-title">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <h2 id="reports-deviations-title" className="text-[15px] font-semibold tracking-tight">
                  偏差任务
                </h2>
                <p className="mt-0.5 text-[11px] leading-relaxed text-apple-subtext">
                  未完成且 end_ts 已过的任务；overdue_days 取整，按接口原值展示。
                </p>
              </div>
              <span className="num text-[11px] text-apple-subtext">{deviations.length} 项</span>
            </div>
            <div
              className={`mt-3 ${deviations.length > 0 ? 'rounded-xl bg-red-50/50 p-2 ring-1 ring-red-100' : ''}`}
              data-testid="reports-deviations"
            >
              <DataTable
                columns={columns}
                rows={deviations}
                rowKey={(row, index) => row.task_id ?? `row-${index}`}
                empty="无偏差任务（未完成且已超期的任务为 0）。"
              />
            </div>
          </section>

          <div className="mt-3 grid gap-3 lg:grid-cols-2" data-equal-grid data-stagger>
            <section className="card flex h-full flex-col p-4 sm:p-5" aria-labelledby="reports-risks-title">
              <div className="flex items-baseline justify-between gap-2">
                <h2 id="reports-risks-title" className="text-[15px] font-semibold tracking-tight">
                  风险清单
                </h2>
                <span className="num text-[11px] text-apple-subtext">{risks.length} 项</span>
              </div>
              <p className="mt-0.5 text-[11px] leading-relaxed text-apple-subtext">
                blocked / overdue 按接口 level 原文分组，不重命名；每条可直接处置并通知开发。
              </p>
              {decisions.status === 'error' && (
                <p className="mt-1 break-words text-[11px] leading-relaxed text-apple-subtext">
                  处置记录读取失败：{decisions.error}
                </p>
              )}
              <div className="mt-3 flex-1" data-testid="risk-list">
                {risks.length === 0 ? (
                  <p className="text-xs text-apple-subtext">本周无风险项</p>
                ) : (
                  <ul className="space-y-2.5">
                    {risks.map((risk, index) => (
                      <RiskRow
                        key={`${risk.level}-${risk.task_id ?? index}`}
                        risk={risk}
                        decision={risk.task_id ? latestDecision.get(risk.task_id) : undefined}
                        onDispose={(taskId) =>
                          setDispose({
                            taskId,
                            title: tasksById.get(taskId)?.title ?? risk.text
                          })
                        }
                      />
                    ))}
                  </ul>
                )}
              </div>
            </section>

            <section className="card flex h-full flex-col p-4 sm:p-5" aria-labelledby="reports-milestones-title">
              <div className="flex items-baseline justify-between gap-2">
                <h2 id="reports-milestones-title" className="text-[15px] font-semibold tracking-tight">
                  里程碑
                </h2>
                <span className="num text-[11px] text-apple-subtext">{milestones.length} 个</span>
              </div>
              <p className="mt-0.5 text-[11px] leading-relaxed text-apple-subtext">
                /api/plan 的 milestones；无数据时显示空态。
              </p>
              <div className="mt-3 flex-1" data-testid="milestone-list">
                {milestones.length === 0 ? (
                  <p className="text-xs text-apple-subtext">无里程碑数据</p>
                ) : (
                  <ul className="space-y-1.5 text-xs">
                    {milestones.map((milestone) => (
                      <li key={milestone.id} className="flex items-baseline gap-2" data-state={milestone.state}>
                        <span className="num w-8 shrink-0 text-[11px] text-apple-subtext">{milestone.id}</span>
                        <span className="min-w-0 flex-1 break-words">{milestone.label}</span>
                        <span className="num shrink-0 text-[11px] text-apple-subtext">{stamp(milestone.at)}</span>
                        <span className="shrink-0 text-[11px] text-apple-subtext">
                          {MILESTONE_STATE[milestone.state] ?? milestone.state}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          </div>

          <section className="card mt-3 p-4 sm:p-5" aria-labelledby="reports-burndown-title">
            <div className="flex items-baseline justify-between gap-2">
              <h2 id="reports-burndown-title" className="text-[15px] font-semibold tracking-tight">
                燃尽
              </h2>
              <span className="num text-[11px] text-apple-subtext">{report.burndown?.length ?? 0} 个快照</span>
            </div>
            <p className="mt-0.5 text-[11px] leading-relaxed text-apple-subtext">
              来自 acceptance.snapshots 的真实快照；无历史数据时明确标注，不画模拟曲线。
            </p>
            <div className="mt-3">
              <Burndown weekly={report} />
            </div>
          </section>

          <p className="mt-4 flex items-center gap-1.5 text-[11px] leading-relaxed text-apple-subtext">
            <Chart className="h-3.5 w-3.5" />
            导出 CSV 含任务与偏差两段，UTF-8 BOM，可直接用表格软件打开。
          </p>
        </>
      )}

      <RiskDecisionDialog
        open={dispose !== null}
        taskId={dispose?.taskId ?? null}
        taskTitle={dispose?.title ?? ''}
        onClose={() => setDispose(null)}
        onSubmit={async (input) => {
          await postJson<RiskDecisionResponse>('/api/risk-decisions', input)
          decisions.refresh()
        }}
      />
    </div>
  )
}
