import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ShotAgentMatrix } from './components/production/ShotAgentMatrix'
import {
  QC_COLOR_P95_THRESHOLD,
  SINGLE_SHOT_SCENE_LABEL,
  buildStoryboard,
  formatDurationMs,
  groupShotActionsByRole,
  qcBadgeLabel,
  qcBadgeState,
  qualityMetric,
  readQualityMetric
} from './components/production/production-data'
import type { FlowArtifact, FlowJob, FlowStage, FlowTool } from './types'

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

/* 场景 #161：A 轨 keyframe-only / 单镜成片无 shots → 合成 1 镜，不伪造分镜数。 */
test('无 shots 时合成 1 镜：shotId=1 / start=0 / end=duration_s / 单镜标签', () => {
  const job = makeJob({ duration_s: 12.5, shots: [] })
  const board = buildStoryboard(job)
  assert.equal(board.length, 1)
  const [shot] = board
  assert.equal(shot.shotId, 1)
  assert.equal(shot.label, 'Shot 01')
  assert.equal(shot.startS, 0)
  assert.equal(shot.endS, 12.5)
  assert.equal(shot.durationS, 12.5)
  assert.equal(shot.sceneSummary, SINGLE_SHOT_SCENE_LABEL)
  assert.match(shot.sceneSummary, /单镜成片（未记录分镜）/)
})

test('无 shots 且时长缺失 → 时长/结束时间显示未记录，不伪造数值', () => {
  const job = makeJob({ duration_s: null, shots: [] })
  const [shot] = buildStoryboard(job)
  assert.equal(shot.endS, null)
  assert.equal(shot.durationS, null)
  assert.equal(shot.pacingTag, '时长未记录')
})

/* 场景 #161：从 stages[].tools 还原角色 / 工具 / 状态 / 耗时 / artifact。 */
test('无 shots 时 actions 按阶段工具生成并映射 6 角色，缺失角色留空组', () => {
  const tool = (over: Partial<FlowTool>): FlowTool => ({
    name: 'tool',
    status: 'done',
    duration_ms: null,
    attempts: 1,
    error: null,
    cached: false,
    skipped: false,
    artifact: null,
    ...over
  })
  const stage = (key: string, tools: FlowTool[], artifacts: FlowArtifact[] = []): FlowStage => ({
    key,
    status: 'done',
    duration_s: null,
    updated_at: null,
    tools,
    artifacts
  })

  const job = makeJob({
    duration_s: 8.4,
    shots: [],
    stages: [
      stage('A', [tool({ name: 'probe_video', duration_ms: 120, artifact: 'frames/a.png' })], [
        { path: 'frames/a.png', exists: true, kind: 'image', url: '/media/a.png' }
      ]),
      stage('B', [tool({ name: 'describe_frames', status: 'running', duration_ms: 3000 })]),
      stage('C', [tool({ name: 'render_frames', duration_ms: 500, artifact: 'rendered/c.png' })], [
        { path: 'rendered/c.png', exists: true, kind: 'image', url: '/media/c.png' }
      ]),
      stage('D', [tool({ name: 'generate_clips', duration_ms: 4000, artifact: 'clips/d.mp4' })], [
        { path: 'clips/d.mp4', exists: true, kind: 'video', url: '/media/d.mp4' }
      ]),
      stage('E', [tool({ name: 'interpolate', duration_ms: 800, artifact: 'graded/e.mp4' })]),
      stage('F', [tool({ name: 'assemble', duration_ms: 200, artifact: 'final/f.mp4' })], [
        { path: 'final/f.mp4', exists: true, kind: 'video', url: '/media/f.mp4' }
      ])
    ]
  })

  const [shot] = buildStoryboard(job)
  assert.deepEqual(
    shot.actions.map((action) => action.role),
    ['director', 'director', 'cinematographer', 'editor', 'colorist', 'audio']
  )
  assert.deepEqual(
    shot.actions.map((action) => action.tool),
    ['probe_video', 'describe_frames', 'render_frames', 'generate_clips', 'interpolate', 'assemble']
  )
  assert.equal(shot.actions[1].status, 'running')
  assert.equal(shot.actions[1].durationMs, 3000)
  assert.equal(shot.actions[1].artifact, null)
  assert.equal(shot.actions[2].artifact, 'rendered/c.png')
  assert.equal(formatDurationMs(shot.actions[0].durationMs), '120ms')
  assert.equal(formatDurationMs(shot.actions[1].durationMs), '3.0s')
  assert.equal(formatDurationMs(null), '未记录')

  // 6 角色占位：writer 无对应阶段动作 → 空组，UI 渲染「未参与本镜」。
  const groups = groupShotActionsByRole(shot)
  assert.equal(groups.length, 6)
  assert.equal(groups.find((group) => group.role.id === 'writer')?.actions.length, 0)
  assert.equal(groupShotActionsByRole(shot, 'writer').length, 1)
  assert.equal(groupShotActionsByRole(shot, 'writer')[0].actions.length, 0)

  // 媒体索引 0：A/B 首图、C 关键帧、D 视频、F 成片。
  assert.equal(shot.media.originalFrame, '/media/a.png')
  assert.equal(shot.media.redrawnFrame, '/media/c.png')
  assert.equal(shot.media.i2vClip, '/media/d.mp4')
  assert.equal(shot.media.gradedClip, '/media/f.mp4')
})

/* 场景 #161：有 shots 的 job 输出保持现状（不回归成单镜合成）。 */
test('有 shots 时保持原有分镜输出', () => {
  const job = makeJob({ duration_s: 20, shots: [{ shot_id: 1, start: 0, end: 4, duration_s: 4 }] })
  const board = buildStoryboard(job)
  assert.equal(board.length, 1)
  assert.equal(board[0].sceneSummary, '主体未记录 · 主视角定场')
  assert.notEqual(board[0].sceneSummary, SINGLE_SHOT_SCENE_LABEL)
  assert.equal(board[0].actions.length, 7)
  assert.equal(board[0].endS, 4)
})

/* 场景 #161：单镜 storyboard 在 ShotAgentMatrix 中仍渲染时间线 + 6 角色明细。 */
test('单镜 storyboard → 矩阵渲染 1 镜时间线与 6 角色占位', () => {
  const job = makeJob({ duration_s: 5, shots: [], stages: [] })
  const html = renderToStaticMarkup(
    createElement(ShotAgentMatrix, {
      shots: buildStoryboard(job),
      selectedShotId: 1,
      onSelectShot: () => {},
      roleFilter: 'all' as const,
      onRoleFilter: () => {}
    })
  )
  assert.match(html, /单镜成片（未记录分镜）/)
  assert.match(html, /共 1 镜/)
  assert.match(html, /角色动作未记录/)
  assert.equal((html.match(/未参与本镜/g) ?? []).length, 6)
})
