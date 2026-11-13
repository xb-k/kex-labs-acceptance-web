import assert from 'node:assert/strict'
import test from 'node:test'
import {
  QC_COLOR_P95_THRESHOLD,
  buildStoryboard,
  qcBadgeLabel,
  qcBadgeState,
  qualityMetric,
  readQualityMetric
} from './components/production/production-data'
import type { FlowJob } from './types'

function makeJob(overrides: Partial<FlowJob> = {}): FlowJob {
  return {
    id: 'job-test',
    stage: 'F',
    updated_at: null,
    duration_s: null,
    stages: [],
    shots: [],
    frames: [],
    semantics: null,
    shot_semantics: null,
    profile: null,
    probe: null,
    cold_warm: null,
    quality: null,
    quality_gate: null,
    artifacts: [],
    decisions: [],
    reports: { render: null, assemble: null, interpolate: null },
    ...overrides
  }
}

/* 场景：质量指标缺失时必须返回 unknown/未记录，不得伪造通过。 */
test('缺失质量指标 → unknown / 未记录', () => {
  const job = makeJob({ quality_gate: null, quality: null })
  assert.equal(readQualityMetric(job, ['color_p95_de2000']), null)
  assert.equal(qcBadgeState(job), 'unknown')
  assert.equal(qcBadgeLabel('unknown'), '门禁判定未记录')

  const metric = qualityMetric(job, 'ΔE2000 p95', ['color_p95_de2000'], QC_COLOR_P95_THRESHOLD, 'lte')
  assert.deepEqual(metric, { label: 'ΔE2000 p95', value: '未记录', pass: 'unknown' })
})

/* 场景：真实指标存在时按阈值正常判定。 */
test('真实质量指标 → 正常 PASS/FAIL', () => {
  const passJob = makeJob({ quality_gate: { color_p95_de2000: 2.85 } })
  assert.equal(readQualityMetric(passJob, ['color_p95_de2000']), 2.85)
  assert.equal(qcBadgeState(passJob), 'pass')
  assert.equal(qcBadgeLabel('pass'), '门禁 PASS')

  const passMetric = qualityMetric(passJob, 'ΔE2000 p95', ['color_p95_de2000'], QC_COLOR_P95_THRESHOLD, 'lte')
  assert.equal(passMetric.pass, true)
  assert.match(passMetric.value, /2\.85 ≤ 6/)

  const failJob = makeJob({ quality_gate: { checks: [{ name: 'color_p95_de2000', value: '7.4' }] } })
  assert.equal(readQualityMetric(failJob, ['color_p95_de2000']), 7.4)
  assert.equal(qcBadgeState(failJob), 'fail')

  const verdictFail = makeJob({
    quality_gate: { verdict: 'FAIL', color_p95_de2000: 1.2 }
  })
  assert.equal(qcBadgeState(verdictFail), 'fail')
})

/* 场景：shot 时间/时长为空或 profile 缺失时，界面文案显示未记录。 */
test('storyboard 缺失字段 → 未记录', () => {
  const job = makeJob({ shots: [{ shot_id: 1, start: null, end: null, duration_s: null }] })
  const [shot] = buildStoryboard(job)
  assert.equal(shot.startS, null)
  assert.equal(shot.endS, null)
  assert.equal(shot.durationS, null)
  assert.equal(shot.pacingTag, '时长未记录')
  assert.match(shot.actions[0].inputFact, /未记录/)
  assert.match(shot.actions[1].actionTitle, /未记录/)

  const colorAction = shot.actions.find((a) => a.role === 'colorist')
  assert.ok(colorAction)
  assert.match(colorAction.outputSummary, /ΔE2000 未记录/)
  assert.equal(colorAction.metrics?.[0].pass, 'unknown')
})
