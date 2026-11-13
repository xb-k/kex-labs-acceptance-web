import assert from 'node:assert/strict'
import test from 'node:test'
import type { SnapshotRule } from './types'
import { explainRule, overallVerdict } from './qc-explain'

function rule(partial: Partial<SnapshotRule> & Pick<SnapshotRule, 'id'>): SnapshotRule {
  return {
    id: partial.id,
    name: partial.name ?? partial.id,
    op: partial.op ?? '>',
    threshold: partial.threshold ?? 1,
    unit: partial.unit ?? null,
    actual: partial.actual ?? null,
    verdict: partial.verdict ?? null,
    source: partial.source ?? 'policy/quality_thresholds.json'
  }
}

test('#106 全 pass → 通过，计数与逐行判定一致', () => {
  const verdict = overallVerdict([
    rule({ id: 'a', verdict: 'pass', actual: 2 }),
    rule({ id: 'b', verdict: 'pass', actual: 3 })
  ])
  assert.equal(verdict.kind, 'pass')
  assert.equal(verdict.label, '通过')
  assert.deepEqual(verdict.counts, { pass: 2, fail: 0, unavailable: 0, total: 2 })
  assert.match(verdict.plain, /全部达标/)
})

test('#106 任一 fail → 未通过，优先于缺失项，并点名失败规则', () => {
  const verdict = overallVerdict([
    rule({ id: 'a', name: '规则甲', verdict: 'pass', actual: 2 }),
    rule({ id: 'b', name: '规则乙', verdict: 'fail', actual: 0.2 }),
    rule({ id: 'c', verdict: null, actual: null })
  ])
  assert.equal(verdict.kind, 'fail')
  assert.equal(verdict.label, '未通过')
  assert.deepEqual(verdict.counts, { pass: 1, fail: 1, unavailable: 1, total: 3 })
  assert.match(verdict.plain, /规则乙/)
  assert.match(verdict.plain, /未达标/)
})

test('#106 全 unavailable → 数据不足，不编造通过/未通过', () => {
  const verdict = overallVerdict([
    rule({ id: 'a' }),
    rule({ id: 'b' })
  ])
  assert.equal(verdict.kind, 'insufficient')
  assert.equal(verdict.label, '数据不足')
  assert.deepEqual(verdict.counts, { pass: 0, fail: 0, unavailable: 2, total: 2 })
  assert.match(verdict.plain, /没有实测值/)
})

test('#106 空规则 → 数据不足，不抛错', () => {
  const verdict = overallVerdict([])
  assert.equal(verdict.kind, 'insufficient')
  assert.deepEqual(verdict.counts, { pass: 0, fail: 0, unavailable: 0, total: 0 })
  assert.match(verdict.plain, /没有拿到门禁规则清单/)
})

test('#106 有 pass 也有 unavailable → 需要注意', () => {
  const verdict = overallVerdict([
    rule({ id: 'a', verdict: 'pass', actual: 2 }),
    rule({ id: 'b', actual: null, verdict: null })
  ])
  assert.equal(verdict.kind, 'attention')
  assert.equal(verdict.label, '需要注意')
  assert.match(verdict.plain, /1 条规则通过/)
  assert.match(verdict.plain, /1 条暂无实测值/)
})

test('#106 未知 ruleId 回退中性文案，不猜含义、不输出 undefined', () => {
  const explanation = explainRule('never_registered_rule')
  assert.equal(explanation.plain, '这项规则暂无白话说明。')
  assert.equal(/undefined|null|NaN/.test(JSON.stringify(explanation)), false)
  assert.match(explanation.action, /联系项目维护者/)
})

test('#106 本页 7 条 policy 规则都有白话与建议动作', () => {
  const ids = [
    'skin_texture_energy',
    'bgm_loop_peak_8s',
    'shot_duration_stddev_s',
    'motion_variance',
    'audio_dynamic_range_lu',
    'color_mean_delta_e2000',
    'color_p95_delta_e2000'
  ]
  for (const id of ids) {
    const explanation = explainRule(id)
    assert.ok(explanation.plain.length >= 8, `${id} 缺少白话`)
    assert.ok(explanation.why.length >= 8, `${id} 缺少原因`)
    assert.ok(explanation.action.length >= 8, `${id} 缺少建议动作`)
  }
})
