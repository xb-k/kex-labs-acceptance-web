import type { QcSummaryJob } from './types'

/**
 * #135 QC 图表的数据派生层。
 *
 * 只做「取字段 + 归一化坐标」，不补点、不造分：
 * - 饼图切片来自 `/api/qc/summary` 每个 job 的 `status`（PASS / CONDITIONAL / FAIL）；
 * - 条形图数值来自 `ssim` / `noiseChangePct` / `netGain` / `ghostRatio` 原字段；
 * - 趋势点只接受 `/api/snapshot` 返回的真实时间，少于 2 个带时间的任务就不连线。
 */

export type GateSliceKey = 'pass' | 'warn' | 'fail'

export type GateSlice = {
  key: GateSliceKey
  label: string
  hint: string
  color: string
  count: number
}

export type GateSummary = {
  total: number
  slices: GateSlice[]
}

export const GATE_COLORS: Record<GateSliceKey, string> = {
  pass: '#30A14E',
  warn: '#C77700',
  fail: '#D93830'
}

const SLICE_LABEL: Record<GateSliceKey, { label: string; hint: string }> = {
  pass: { label: '通过', hint: 'PASS' },
  warn: { label: '待复查', hint: 'CONDITIONAL / UNKNOWN' },
  fail: { label: '未通过', hint: 'FAIL' }
}

const sliceOf = (status: QcSummaryJob['status']): GateSliceKey => {
  if (status === 'PASS') return 'pass'
  if (status === 'FAIL') return 'fail'
  return 'warn'
}

/** 只统计 `hasQc=true` 的真实质检任务；没有样本时三个切片都为 0。 */
export function buildGateSummary(jobs: QcSummaryJob[]): GateSummary {
  const qcJobs = jobs.filter((job) => job.hasQc)
  const counts: Record<GateSliceKey, number> = { pass: 0, warn: 0, fail: 0 }
  for (const job of qcJobs) counts[sliceOf(job.status)] += 1
  return {
    total: qcJobs.length,
    slices: (['pass', 'warn', 'fail'] as const).map((key) => ({
      key,
      ...SLICE_LABEL[key],
      color: GATE_COLORS[key],
      count: counts[key]
    }))
  }
}

export type QcMetricKey = 'ssim' | 'noiseChangePct' | 'netGain' | 'ghostRatio'

export type QcMetricRow = {
  jobId: string
  value: number | null
}

export type QcMetricGroup = {
  key: QcMetricKey
  label: string
  ruleId: string
  unit: string
  digits: number
  threshold: number | null
  /** 组内最大刻度（含阈值，最小 1），用于条形宽度。 */
  scaleMax: number
  rows: QcMetricRow[]
}

export type ThresholdItems = { key: string; threshold: string }[]
export type RuleItems = { id: string; threshold: number | null }[]

type MetricDef = {
  key: QcMetricKey
  label: string
  ruleId: string
  unit: string
  digits: number
}

const METRIC_DEFS: MetricDef[] = [
  { key: 'ssim', label: 'B1 · SSIM 结构相似度', ruleId: 'B1_ssim_mean', unit: '', digits: 4 },
  { key: 'noiseChangePct', label: 'B2 · 平坦区噪声变化', ruleId: 'B2_noise_change_pct', unit: '%', digits: 1 },
  { key: 'netGain', label: 'B2 · 锐度净增益', ruleId: 'B2_net_gain_vs_baseline_ratio', unit: '×', digits: 2 },
  { key: 'ghostRatio', label: 'B3 · 插帧鬼影比', ruleId: 'B3_ghost_ratio_median', unit: '', digits: 3 }
]

export const QC_METRIC_DEFS = METRIC_DEFS

const firstNumber = (text: string): number | null => {
  const match = text.match(/[-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?/i)
  if (!match) return null
  const value = Number(match[0])
  return Number.isFinite(value) ? value : null
}

/** 阈值来源优先 `/api/qc/summary` 的 thresholds.items，其次 rules；都没有就返回 null。 */
export function metricThreshold(
  ruleId: string,
  thresholds: ThresholdItems,
  rules: RuleItems
): number | null {
  const item = thresholds.find((entry) => entry.key === ruleId)
  if (item) {
    const value = firstNumber(item.threshold)
    if (value != null) return value
  }
  const rule = rules.find((entry) => entry.id === ruleId)
  return rule?.threshold != null && Number.isFinite(rule.threshold) ? rule.threshold : null
}

/**
 * 分项条形图：每个指标一行组，组内是各 job 的真实数值。
 * `limit` 限制展示的 job 数量，超出部分在 UI 里注明，不做抽样或补值。
 */
export function buildMetricGroups(
  jobs: QcSummaryJob[],
  thresholds: ThresholdItems,
  rules: RuleItems,
  limit = 6
): QcMetricGroup[] {
  const qcJobs = jobs.filter((job) => job.hasQc).slice(0, limit)
  return METRIC_DEFS.map((def) => {
    const rows = qcJobs.map((job) => {
      const raw = job[def.key]
      return { jobId: job.jobId, value: raw != null && Number.isFinite(raw) ? raw : null }
    })
    const threshold = metricThreshold(def.ruleId, thresholds, rules)
    const values = rows.map((row) => row.value).filter((value): value is number => value != null)
    const scaleMax = Math.max(1, threshold ?? 0, ...values) * 1.08
    return { ...def, threshold, scaleMax, rows }
  })
}

export type QcTrendPoint = {
  jobId: string
  iso: string
  at: number
  rate: number
  passed: number
  judged: number
}

export type QcTrend = {
  points: QcTrendPoint[]
  /** 无法绘图时的说明；能画就是 null。 */
  note: string | null
}

export type JobTimes = Record<string, string | null | undefined>

/**
 * 趋势折线：只取带真实时间（finished / updated / started / created）且 judged>0 的任务，
 * 按时间升序取最近 `limit` 个，绘制「通过 / 已判定」通过率。
 * 少于 2 个点不连线，返回 note（无时间序列）。
 */
export function buildQcTrend(jobs: QcSummaryJob[], times: JobTimes, limit = 8): QcTrend {
  const dated: QcTrendPoint[] = []
  for (const job of jobs) {
    if (!job.hasQc) continue
    if (!Number.isFinite(job.judged) || job.judged <= 0) continue
    const raw = times[job.jobId]
    const at = typeof raw === 'string' ? Date.parse(raw) : Number.NaN
    if (!Number.isFinite(at)) continue
    dated.push({
      jobId: job.jobId,
      iso: new Date(at).toISOString(),
      at,
      rate: (job.passed / job.judged) * 100,
      passed: job.passed,
      judged: job.judged
    })
  }
  dated.sort((a, b) => a.at - b.at)
  const points = dated.slice(-limit)
  if (points.length >= 2) return { points, note: null }
  return {
    points,
    note:
      points.length === 0
        ? '无时间序列：API 未返回任务时间，不绘制趋势。'
        : '无时间序列：只有 1 个任务带时间，无法连线。'
  }
}

/** 饼图切片路径用的累计比例（不含 0 值切片）。 */
export function pieSegments(summary: GateSummary): { key: GateSliceKey; ratio: number; offset: number }[] {
  if (summary.total <= 0) return []
  let offset = 0
  const out: { key: GateSliceKey; ratio: number; offset: number }[] = []
  for (const slice of summary.slices) {
    if (slice.count <= 0) continue
    const ratio = slice.count / summary.total
    out.push({ key: slice.key, ratio, offset })
    offset += ratio
  }
  return out
}

export const formatMetricValue = (value: number | null, digits: number): string =>
  value == null ? '—' : value.toFixed(digits)
