import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { QcSummaryJob } from './types'
import {
  buildGateSummary,
  buildMetricGroups,
  buildQcTrend,
  metricThreshold
} from './qc-charts'
import { QcGatePie, QcMetricBars, QcTrendLine } from './components/QcCharts'

/* #135 QC 图表：只断言真实字段派生 + 空态/缺字段/无时间，不造样本值。 */

const job = (over: Partial<QcSummaryJob> = {}): QcSummaryJob => ({
  jobId: 'j1',
  taskId: 'T-1',
  status: 'PASS',
  passed: 6,
  judged: 7,
  ssim: 0.9012,
  noiseChangePct: 12.5,
  netGain: 1.88,
  ghostRatio: 1.369,
  hasQc: true,
  ...over
})

test('#135 规则通过率饼图：PASS / CONDITIONAL / FAIL 映射到 pass / warn / fail', () => {
  const jobs = [
    job({ jobId: 'a', status: 'PASS' }),
    job({ jobId: 'b', status: 'CONDITIONAL' }),
    job({ jobId: 'c', status: 'FAIL' })
  ]
  const summary = buildGateSummary(jobs)
  assert.equal(summary.total, 3)
  assert.deepEqual(
    summary.slices.map((slice) => [slice.key, slice.count]),
    [
      ['pass', 1],
      ['warn', 1],
      ['fail', 1]
    ]
  )

  const html = renderToStaticMarkup(<QcGatePie jobs={jobs} />)
  assert.match(html, /data-testid="qc-gate-pie"/)
  assert.match(html, /data-total="3"/)
  assert.match(html, /通过/)
  assert.match(html, /待复查/)
  assert.match(html, /未通过/)
})

test('#135 饼图空态：没有 QC 任务时不补切片', () => {
  const html = renderToStaticMarkup(<QcGatePie jobs={[]} />)
  assert.match(html, /data-empty="true"/)
  assert.match(html, /无 QC 样本/)
  assert.match(html, /不以 0 或模拟值补切片/)

  const noQc = buildGateSummary([job({ hasQc: false })])
  assert.equal(noQc.total, 0)
})

test('#135 分项条形图：缺字段显示 —，阈值来自 thresholds / rules，缺阈值标注未取得', () => {
  const jobs = [job({ jobId: 'ok' }), job({ jobId: 'missing', ssim: null, netGain: null })]
  const thresholds = [{ key: 'B1_ssim_mean', threshold: '>= 0.8' }]
  const groups = buildMetricGroups(jobs, thresholds, [{ id: 'B2_net_gain_vs_baseline_ratio', threshold: 1.5 }])
  const ssim = groups.find((group) => group.key === 'ssim')
  assert.equal(ssim?.threshold, 0.8)
  assert.deepEqual(ssim?.rows, [
    { jobId: 'ok', value: 0.9012 },
    { jobId: 'missing', value: null }
  ])
  assert.equal(groups.find((group) => group.key === 'netGain')?.threshold, 1.5)
  assert.equal(groups.find((group) => group.key === 'ghostRatio')?.threshold, null)
  assert.equal(metricThreshold('B1_ssim_mean', [], []), null)

  const html = renderToStaticMarkup(<QcMetricBars jobs={jobs} thresholds={thresholds} rules={[]} />)
  assert.match(html, /data-testid="qc-metric-bars"/)
  assert.match(html, /data-missing="true"/)
  assert.match(html, /阈值未取得/)
})

test('#135 条形图空态：无 QC 样本', () => {
  const html = renderToStaticMarkup(<QcMetricBars jobs={[]} thresholds={[]} rules={[]} />)
  assert.match(html, /data-empty="true"/)
  assert.match(html, /无 QC 样本/)
})

test('#135 趋势：没有任务时间时不渲染折线并标注无时间序列', () => {
  const jobs = [job({ jobId: 'a' }), job({ jobId: 'b' })]
  const trend = buildQcTrend(jobs, {})
  assert.equal(trend.points.length, 0)
  assert.match(trend.note ?? '', /无时间序列/)

  const html = renderToStaticMarkup(<QcTrendLine jobs={jobs} times={{}} />)
  assert.match(html, /data-empty="true"/)
  assert.match(html, /无时间序列/)
  assert.doesNotMatch(html, /<polyline/)
})

test('#135 趋势：按真实时间升序取最近 N 次，通过率来自 passed/judged', () => {
  const jobs = [
    job({ jobId: 'old', passed: 1, judged: 2 }),
    job({ jobId: 'new', passed: 6, judged: 7 }),
    job({ jobId: 'mid', passed: 0, judged: 4 })
  ]
  const times = {
    old: '2026-11-10T06:00:00.000Z',
    mid: '2026-11-11T06:00:00.000Z',
    new: '2026-11-12T06:00:00.000Z'
  }
  const trend = buildQcTrend(jobs, times, 2)
  assert.deepEqual(
    trend.points.map((point) => point.jobId),
    ['mid', 'new']
  )
  assert.equal(trend.points[1].rate, (6 / 7) * 100)
  assert.equal(trend.note, null)

  const html = renderToStaticMarkup(<QcTrendLine jobs={jobs} times={times} limit={2} />)
  assert.match(html, /data-points="2"/)
  assert.match(html, /<polyline/)
  assert.match(html, /passed \/ judged/)
})

test('#135 趋势：judged=0 或时间非法时不入图', () => {
  const jobs = [job({ jobId: 'a', judged: 0 }), job({ jobId: 'b' }), job({ jobId: 'c' })]
  const trend = buildQcTrend(jobs, { a: '2026-11-10T00:00:00Z', b: 'not-a-date' }, 8)
  assert.equal(trend.points.length, 0)
  assert.match(trend.note ?? '', /无时间序列/)
})
