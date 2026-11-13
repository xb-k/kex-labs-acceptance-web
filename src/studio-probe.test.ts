import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildOptimizeJobPayload,
  planRiskRows,
  planStepRows,
  probeFacts
} from './studio-probe'
import type { UploadProbeResponse } from './studio-probe'
import type { StudioBrief } from './types'

/** 取自真实 probe 响应（acceptance/uploads/up-mwdyuckh-238bf2/meta.json）。 */
const PROBE: UploadProbeResponse = {
  probe: {
    duration_s: 4.84,
    width: 768,
    height: 512,
    fps: 25,
    bitrate_bps: 232099,
    codec: 'h264',
    has_audio: false,
    audio_codec: null
  },
  shots: { count: 1, items: [{ shot_id: 1, start: 0, end: 4.84 }], backend: 'pyscenedetect' },
  shots_reason: null,
  plan: {
    steps: [
      { id: 'interpolate', label: '插帧到 60fps', detail: '源片 25fps < 60fps，建议插帧补足帧率' },
      { id: 'upscale', label: '超分到短边 1080', detail: '源片短边 512 < 1080' },
      { id: 'denoise', label: '轻度降噪（提示）', detail: '码率密度偏低', hint: true }
    ],
    risks: [
      { code: 'no_audio', level: 'warn', message: '源片无音轨；B 轨将没有源音频' }
    ]
  }
}

test('probe 成功：展示分辨率/时长/帧率/码率/音轨/镜数', () => {
  const facts = Object.fromEntries(probeFacts(PROBE).map((fact) => [fact.label, fact.value]))
  assert.equal(facts.分辨率, '768×512')
  assert.equal(facts.时长, '4.84 s')
  assert.equal(facts.帧率, '25 fps')
  assert.equal(facts.码率, '0.23 Mbps')
  assert.equal(facts.音轨, '无音轨')
  assert.equal(facts.镜数, '1 镜（pyscenedetect）')
})

test('probe 缺失时仍给出六项事实且显示未知', () => {
  const facts = probeFacts({})
  assert.equal(facts.length, 6)
  assert.ok(facts.some((fact) => fact.label === '分辨率' && fact.value === '未知'))
})

test('plan.steps 映射 label/detail 与 hint', () => {
  const rows = planStepRows(PROBE)
  assert.equal(rows.length, 3)
  assert.deepEqual(
    rows.map((row) => [row.title, row.hint]),
    [
      ['插帧到 60fps', false],
      ['超分到短边 1080', false],
      ['轻度降噪（提示）', true]
    ]
  )
  assert.equal(rows[0].detail, '源片 25fps < 60fps，建议插帧补足帧率')
})

test('plan.risks 映射 level 与 message', () => {
  assert.deepEqual(planRiskRows(PROBE), [
    { level: 'warn', text: '源片无音轨；B 轨将没有源音频' }
  ])
  assert.deepEqual(planRiskRows({ plan: { risks: ['普通提示'] } }), [
    { level: 'warn', text: '普通提示' }
  ])
})

test('B 轨提交参数：type=optimize / rail=B / upload_id', () => {
  assert.deepEqual(buildOptimizeJobPayload('up-abc-123', null), {
    type: 'optimize',
    rail: 'B',
    upload_id: 'up-abc-123'
  })
})

test('B 轨提交参数：有 Brief 时带 brief_id/polished', () => {
  const polished = {
    logline: '一句话',
    script: '脚本',
    shots: [{ no: 1, duration_s: 4.84, prompt: '镜头' }]
  }
  const brief: StudioBrief = {
    id: 'brief_1',
    idea: '测试',
    audience: null,
    duration_s: null,
    aspect: null,
    tone: null,
    references: [],
    polished,
    questions_pending: [],
    status: 'confirmed',
    version: 1,
    created_at: '2026-11-13T00:00:00.000Z',
    updated_at: '2026-11-13T00:00:00.000Z'
  }
  assert.deepEqual(buildOptimizeJobPayload('up-abc-123', brief), {
    type: 'optimize',
    rail: 'B',
    upload_id: 'up-abc-123',
    brief_id: 'brief_1',
    polished
  })
})
