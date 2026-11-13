import type { QcSummaryJob } from '../types'
import {
  GATE_COLORS,
  buildGateSummary,
  buildMetricGroups,
  buildQcTrend,
  formatMetricValue,
  pieSegments,
  type GateSummary,
  type JobTimes,
  type QcMetricGroup,
  type RuleItems,
  type ThresholdItems
} from '../qc-charts'

const PIE_R = 52
const PIE_C = 2 * Math.PI * PIE_R

/** 门禁结论饼图（PASS / 待复查 / FAIL）；无 QC 样本时只画空态环。 */
export function QcGatePie({ jobs }: { jobs: QcSummaryJob[] }) {
  const summary = buildGateSummary(jobs)
  const segments = pieSegments(summary)
  const aria =
    summary.total === 0
      ? '门禁结论分布：无 QC 样本'
      : `门禁结论分布：通过 ${summary.slices[0].count}，待复查 ${summary.slices[1].count}，未通过 ${summary.slices[2].count}`

  return (
    <div data-testid="qc-gate-pie" data-total={summary.total} data-empty={summary.total === 0 ? 'true' : 'false'}>
      <div className="flex items-center gap-4">
        <svg
          viewBox="0 0 160 160"
          role="img"
          aria-label={aria}
          className="h-[132px] w-[132px] shrink-0"
        >
          <circle cx="80" cy="80" r={PIE_R} fill="none" stroke="#F0F0F2" strokeWidth="18" />
          {segments.map((segment) => (
            <circle
              key={segment.key}
              cx="80"
              cy="80"
              r={PIE_R}
              fill="none"
              stroke={GATE_COLORS[segment.key]}
              strokeWidth="18"
              strokeDasharray={`${(segment.ratio * PIE_C).toFixed(2)} ${PIE_C.toFixed(2)}`}
              strokeDashoffset={(-segment.offset * PIE_C).toFixed(2)}
              transform="rotate(-90 80 80)"
            />
          ))}
          {summary.total === 0 && (
            <circle cx="80" cy="80" r={PIE_R} fill="none" stroke="#D1D1D6" strokeWidth="2" strokeDasharray="5 5" />
          )}
          <text x="80" y="77" textAnchor="middle" className="fill-apple-text" fontSize="26" fontWeight="600">
            {summary.total}
          </text>
          <text x="80" y="96" textAnchor="middle" className="fill-apple-subtext" fontSize="10">
            {summary.total === 0 ? '无 QC 样本' : '个质检任务'}
          </text>
        </svg>
        <ul className="min-w-0 flex-1 space-y-2">
          {summary.slices.map((slice) => (
            <li key={slice.key} className="flex min-w-0 items-baseline justify-between gap-2 text-xs">
              <span className="flex min-w-0 items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: slice.color }}
                />
                <span className="truncate">{slice.label}</span>
                <span className="num shrink-0 text-[10px] text-apple-subtext">{slice.hint}</span>
              </span>
              <span className="num shrink-0 font-medium">
                {slice.count}
                <span className="ml-1 text-[10px] font-normal text-apple-subtext">
                  {summary.total > 0 ? `${Math.round((slice.count / summary.total) * 100)}%` : '—'}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </div>
      <p className="mt-2 text-[11px] leading-4 text-apple-subtext">
        {summary.total === 0
          ? '暂无已完成质检的任务；不以 0 或模拟值补切片。'
          : '只统计 hasQc=true 的任务；CONDITIONAL / UNKNOWN 归入待复查。'}
      </p>
    </div>
  )
}

function MetricGroupView({ group }: { group: QcMetricGroup }) {
  return (
    <div data-metric={group.key} className="min-w-0">
      <div className="flex flex-wrap items-baseline justify-between gap-1">
        <h3 className="text-xs font-medium">{group.label}</h3>
        <span className="num text-[10px] text-apple-subtext">
          {group.threshold == null ? '阈值未取得' : `阈值 ${group.threshold}${group.unit}`}
        </span>
      </div>
      <ul className="mt-1.5 space-y-1.5">
        {group.rows.map((row) => {
          const pct = row.value == null ? 0 : Math.min(100, (Math.abs(row.value) / group.scaleMax) * 100)
          const tickPct =
            group.threshold == null ? null : Math.min(100, (Math.abs(group.threshold) / group.scaleMax) * 100)
          return (
            <li key={row.jobId} className="min-w-0">
              <div className="flex items-baseline justify-between gap-2 text-[11px]">
                <span className="num min-w-0 truncate text-apple-subtext" title={row.jobId}>
                  {row.jobId}
                </span>
                <span
                  className={`num shrink-0 tabular-nums ${row.value == null ? 'text-apple-subtext' : 'font-medium'}`}
                  data-missing={row.value == null ? 'true' : 'false'}
                >
                  {formatMetricValue(row.value, group.digits)}
                  {row.value != null && group.unit ? group.unit : ''}
                </span>
              </div>
              <div className="relative mt-0.5 h-2 overflow-hidden rounded-full bg-black/[0.05]">
                {row.value != null && (
                  <span
                    className="absolute inset-y-0 left-0 rounded-full bg-[#0071E3]"
                    style={{ width: `${pct.toFixed(2)}%` }}
                  />
                )}
                {tickPct != null && (
                  <span
                    aria-hidden="true"
                    className="absolute inset-y-0 w-px bg-[#B25E00]"
                    style={{ left: `${tickPct.toFixed(2)}%` }}
                  />
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** 分项得分条形图：数值全部取 `/api/qc/summary` 的原始字段，缺失显示 —。 */
export function QcMetricBars({
  jobs,
  thresholds,
  rules,
  limit = 6
}: {
  jobs: QcSummaryJob[]
  thresholds: ThresholdItems
  rules: RuleItems
  limit?: number
}) {
  const groups = buildMetricGroups(jobs, thresholds, rules, limit)
  const qcCount = jobs.filter((job) => job.hasQc).length
  return (
    <div data-testid="qc-metric-bars" data-jobs={qcCount} data-empty={qcCount === 0 ? 'true' : 'false'}>
      {qcCount === 0 ? (
        <div className="grid h-[220px] place-items-center rounded-xl border border-dashed border-black/[0.1] px-4 text-center">
          <div>
            <p className="text-sm font-medium text-apple-subtext">无 QC 样本</p>
            <p className="mt-1 text-[11px] leading-4 text-apple-subtext">
              条形图只展示真实质检字段；没有样本时不补 0。
            </p>
          </div>
        </div>
      ) : (
        <div className="grid gap-3">
          {groups.map((group) => (
            <MetricGroupView key={group.key} group={group} />
          ))}
        </div>
      )}
      <p className="mt-2 text-[11px] leading-4 text-apple-subtext">
        {qcCount === 0
          ? '等待首个 QC 任务完成后自动出现。'
          : `按 summary 返回顺序展示${qcCount > limit ? `前 ${limit} / ${qcCount}` : `全部 ${qcCount}`}个质检任务；橙色竖线为阈值，灰条+「—」表示该任务缺此字段。`}
      </p>
    </div>
  )
}

const TREND_W = 380
const TREND_H = 148
const TREND_M = { l: 34, r: 10, t: 14, b: 26 }

/** 趋势折线：按真实任务时间升序，展示最近 N 次「通过 / 已判定」；无时间不渲染折线。 */
export function QcTrendLine({
  jobs,
  times,
  limit = 8
}: {
  jobs: QcSummaryJob[]
  times: JobTimes
  limit?: number
}) {
  const trend = buildQcTrend(jobs, times, limit)
  if (trend.note != null) {
    return (
      <div data-testid="qc-trend-line" data-points={trend.points.length} data-empty="true">
        <div className="grid h-[148px] place-items-center rounded-xl border border-dashed border-black/[0.1] px-4 text-center">
          <div>
            <p className="text-sm font-medium text-apple-subtext">无时间序列</p>
            <p className="mt-1 text-[11px] leading-4 text-apple-subtext">{trend.note}</p>
          </div>
        </div>
      </div>
    )
  }

  const points = trend.points
  const plotW = TREND_W - TREND_M.l - TREND_M.r
  const plotH = TREND_H - TREND_M.t - TREND_M.b
  const t0 = points[0].at
  const t1 = points[points.length - 1].at
  const span = Math.max(1, t1 - t0)
  const x = (at: number) => TREND_M.l + ((at - t0) / span) * plotW
  const y = (rate: number) => TREND_M.t + ((100 - Math.max(0, Math.min(100, rate))) / 100) * plotH
  const path = points.map((point) => `${x(point.at).toFixed(2)},${y(point.rate).toFixed(2)}`).join(' ')
  const firstLabel = points[0].jobId
  const lastLabel = points[points.length - 1].jobId

  return (
    <div data-testid="qc-trend-line" data-points={points.length} data-empty="false">
      <svg viewBox={`0 0 ${TREND_W} ${TREND_H}`} role="img" aria-label="QC 通过率随时间变化" className="block h-auto w-full">
        {[0, 50, 100].map((tick) => (
          <g key={tick}>
            <line
              x1={TREND_M.l}
              x2={TREND_W - TREND_M.r}
              y1={y(tick)}
              y2={y(tick)}
              stroke="rgba(0,0,0,0.06)"
              strokeDasharray="3 3"
            />
            <text x={TREND_M.l - 6} y={y(tick) + 3} textAnchor="end" fontSize="9" className="fill-apple-subtext">
              {tick}%
            </text>
          </g>
        ))}
        <polyline points={path} fill="none" stroke="#0071E3" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {points.map((point) => (
          <g key={point.jobId}>
            <circle cx={x(point.at)} cy={y(point.rate)} r="3.5" fill="#0071E3" stroke="#FFFFFF" strokeWidth="1.5">
              <title>{`${point.jobId} · ${point.passed}/${point.judged} 通过 · ${point.iso.slice(0, 10)}`}</title>
            </circle>
          </g>
        ))}
        <text x={TREND_M.l} y={TREND_H - 8} fontSize="9" textAnchor="start" className="fill-apple-subtext">
          {firstLabel}
        </text>
        <text x={TREND_W - TREND_M.r} y={TREND_H - 8} fontSize="9" textAnchor="end" className="fill-apple-subtext">
          {lastLabel}
        </text>
      </svg>
      <p className="mt-1 text-[11px] leading-4 text-apple-subtext">
        通过率 = passed / judged（原始计数），按 /api/snapshot 任务时间升序取最近 {limit} 次；时间缺失的任务不入图。
      </p>
    </div>
  )
}

export type { GateSummary }
