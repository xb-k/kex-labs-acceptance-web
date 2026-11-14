import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DecisionCard } from './pages/ProductionTrackerPage'
import {
  decisionParamChips,
  decisionRawText,
  decisionResultSummary,
  decisionSummary,
  decisionTone,
  parseDecision
} from './production-decisions'

/* #162：对象与 JSON 字符串都解析成同一结构；缺字段保持 null，不编造。 */
test('#162 parseDecision 解析对象 / JSON 字符串并兼容 ts 与 args', () => {
  const fromObject = parseDecision({
    ts: '2026-11-14T10:00:00.000Z',
    role: 'director',
    action: 'choose_storyboard',
    tool: 'storyboard_runner',
    status: 'ok',
    duration_ms: 1200,
    args: { shot: 1, fps: 30 },
    result: '选定方案 B'
  })
  assert.deepEqual(fromObject, {
    timestamp: '2026-11-14T10:00:00.000Z',
    role: 'director',
    action: 'choose_storyboard',
    tool: 'storyboard_runner',
    status: 'ok',
    duration: 1200,
    params: { shot: 1, fps: 30 },
    result: '选定方案 B'
  })

  const fromString = parseDecision(
    JSON.stringify({ at: '2026-11-14T10:01:00.000Z', role: 'orchestrator', action: 'run_tool', tool: 'assemble' })
  )
  assert.equal(fromString?.timestamp, '2026-11-14T10:01:00.000Z')
  assert.equal(fromString?.role, 'orchestrator')
  assert.equal(fromString?.action, 'run_tool')
  assert.equal(fromString?.tool, 'assemble')
  assert.equal(fromString?.status, null)
  assert.equal(fromString?.duration, null)
  assert.equal(fromString?.params, null)
  assert.equal(fromString?.result, null)
})

/* #162：纯文本字符串按动作展示，空串 / 数组不可解析时返回 null。 */
test('#162 parseDecision 纯文本字符串与不可解析输入', () => {
  assert.equal(parseDecision('导演选择分镜方案')?.action, '导演选择分镜方案')
  assert.equal(parseDecision('  '), null)
  assert.equal(parseDecision(null), null)
  assert.equal(parseDecision([1, 2]), null)
  assert.equal(parseDecision('["not", "a", "record"]'), null)
})

/* #162：字段足够时生成中文动作句；未知动作不编造中文。 */
test('#162 decisionSummary 已知角色动作中文句、未知动作保留原文', () => {
  assert.equal(decisionSummary(parseDecision({ role: 'director', action: 'choose_storyboard' })), '导演选择分镜方案')
  assert.equal(
    decisionSummary(parseDecision({ role: 'orchestrator', action: 'run_tool', tool: 'render_frames' })),
    '调用工具 render_frames'
  )
  assert.equal(decisionSummary(parseDecision({ action: 'unknown_action', role: 'director' })), 'unknown_action')
  assert.equal(decisionSummary(parseDecision({ role: 'director' })), '')
  assert.equal(decisionSummary(null), '')
})

/* #162：未知 / 空状态走 neutral。 */
test('#162 decisionTone 状态映射与未知状态', () => {
  assert.equal(decisionTone('ok'), 'success')
  assert.equal(decisionTone('WARNING'), 'warn')
  assert.equal(decisionTone('failed'), 'fail')
  assert.equal(decisionTone('mystery'), 'neutral')
  assert.equal(decisionTone(null), 'neutral')
  assert.equal(decisionTone(''), 'neutral')
})

/* #162：参数最多 4 个 chip，余量 +n；超长值截断。 */
test('#162 decisionParamChips 长参数折叠', () => {
  const dec = parseDecision({
    params: {
      shot: 1,
      fps: 30,
      prompt: 'a'.repeat(120),
      seed: 42,
      retry: true,
      extra: 'x'
    }
  })
  const chips = decisionParamChips(dec)
  assert.equal(chips.labels.length, 4)
  assert.equal(chips.extra, 2)
  assert.match(chips.labels[2], /^prompt=a+…$/)
  assert.deepEqual(decisionParamChips(parseDecision({ action: 'decide' })), { labels: [], extra: 0 })
})

/* #162：对象结果只给字段摘要，不把 raw JSON / [object Object] 塞进正文。 */
test('#162 decisionResultSummary 对象结果不显示 raw JSON', () => {
  const summary = decisionResultSummary(parseDecision({ result: { output: '/tmp/a.mp4', ok: true } }))
  assert.equal(summary, '对象结果：output、ok')
  assert.doesNotMatch(summary, /[{}]/)
  assert.doesNotMatch(summary, /\[object Object\]/)
  assert.equal(decisionResultSummary(parseDecision({ result: null })), '')
})

/* #162：卡片正文结构化展示；raw JSON 进 details 且默认收起。 */
test('#162 DecisionCard 渲染结构化卡片且原始数据默认收起', () => {
  ;(globalThis as any).window ??= { location: { pathname: '/production', search: '' } }
  const raw = {
    ts: '2026-11-14T10:00:00.000Z',
    role: 'director',
    action: 'choose_storyboard',
    tool: 'storyboard_runner',
    status: 'ok',
    duration_ms: 1500,
    params: { shot: 1, fps: 30 },
    result: '选定方案 B'
  }
  const html = renderToStaticMarkup(createElement(DecisionCard, { raw }))
  assert.match(html, /导演选择分镜方案/)
  assert.match(html, /director/)
  assert.match(html, /耗时 1\.5s/)
  assert.match(html, /shot=1/)
  assert.match(html, /结果摘要：/)
  assert.match(html, /<summary[^>]*>原始数据<\/summary>/)
  assert.doesNotMatch(html, /<details[^>]*\bopen\b/)
  assert.match(html, /&quot;action&quot;: &quot;choose_storyboard&quot;/)
})

/* #162：缺字段时不出现 [object Object]，也不再把 raw JSON 当摘要。 */
test('#162 DecisionCard 缺字段显示未记录动作', () => {
  ;(globalThis as any).window ??= { location: { pathname: '/production', search: '' } }
  const html = renderToStaticMarkup(createElement(DecisionCard, { raw: { foo: 'bar' } }))
  assert.match(html, /未记录动作/)
  assert.doesNotMatch(html, /\[object Object\]/)
  assert.doesNotMatch(html, /\{"foo":"bar"\}/)
  assert.equal(decisionRawText({ foo: 'bar' }), '{\n  "foo": "bar"\n}')
})
