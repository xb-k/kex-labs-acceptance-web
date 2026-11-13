import assert from 'node:assert/strict'
import test from 'node:test'
import { buildDailyEfficiencyData } from './components/production/daily-efficiency'
import { buildPipelineNodes, buildStoryboard } from './components/production/production-data'
import type { FlowJob, PlanTask, StudioJobSummary } from './types'

const SAMPLE_JOB: FlowJob = {
  id: '20261113_vlog_cafe_002',
  stage: 'D',
  updated_at: '2026-11-13T13:44:01.686Z',
  duration_s: 18.6,
  stages: [
    { key: 'A', status: 'done', duration_s: 3.9, updated_at: null, tools: [{ name: 'probe_video', status: 'done', duration_ms: 390, attempts: 1, error: null, cached: false, skipped: false, artifact: null }] },
    { key: 'B', status: 'done', duration_s: 9.2, updated_at: null, tools: [{ name: 'describe_frames', status: 'done', duration_ms: 9200, attempts: 1, error: null, cached: false, skipped: false, artifact: null }] },
    { key: 'C', status: 'done', duration_s: 21, updated_at: null, tools: [{ name: 'render_frames', status: 'done', duration_ms: 21000, attempts: 1, error: null, cached: false, skipped: false, artifact: null }] },
    { key: 'D', status: 'running', duration_s: 64, updated_at: null, tools: [{ name: 'generate_clips', status: 'running', duration_ms: 64000, attempts: 2, error: null, cached: false, skipped: false, artifact: null }] },
    { key: 'E', status: 'pending', duration_s: null, updated_at: null, tools: [] },
    { key: 'F', status: 'pending', duration_s: null, updated_at: null, tools: [] }
  ],
  shots: [{ shot_id: 1, start: 0, end: 4.1, duration_s: 4.1 }],
  frames: [],
  semantics: null,
  shot_semantics: null,
  profile: { name: 'vlog_warm_film' },
  probe: null,
  cold_warm: { free_mem_gb: 31.2 },
  quality: null,
  quality_gate: null,
  artifacts: [],
  decisions: [],
  reports: { render: null, assemble: null, interpolate: null }
}

const SAMPLE_TASKS: PlanTask[] = [
  { id: 'T-PIPE-101', title: '阶段 A · PySceneDetect', owner: 'dev', rail: '双轨', status: 'done', start: '2026-11-10', end: '2026-11-11', progress: 100 },
  { id: 'T-ORCH-105', title: '阶段 D · LTX-2B 多采样筛选', owner: 'runner', rail: 'B', status: 'running', start: '2026-11-12', end: '2026-11-15', progress: 55 },
  { id: 'T-AUDIO-106', title: '阶段 F · Kokoro-82M 混音', owner: 'dev', rail: 'A', status: 'blocked', start: '2026-11-13', end: '2026-11-16', progress: 20 }
]

const SAMPLE_STUDIO_JOBS: StudioJobSummary[] = [
  { id: 'st-1', type: 'aigc', rail: 'A', status: 'succeeded', brief_id: null, created_at: '2026-11-13T10:00:00Z', updated_at: '2026-11-13T10:05:00Z', error: null, stage: 'F' },
  { id: 'st-2', type: 'optimize', rail: 'B', status: 'running', brief_id: null, created_at: '2026-11-13T11:00:00Z', updated_at: '2026-11-13T11:02:00Z', error: null, stage: 'D' }
]

test('buildDailyEfficiencyData computes bounded completion rates and stage/agent trends from live state', () => {
  const nodes = buildPipelineNodes(SAMPLE_JOB)
  const storyboard = buildStoryboard(SAMPLE_JOB, null)

  const result = buildDailyEfficiencyData({
    job: SAMPLE_JOB,
    nodes,
    storyboard,
    tasks: SAMPLE_TASKS,
    studioJobs: SAMPLE_STUDIO_JOBS,
    deliveriesCount: 2,
    memPct: 35
  })

  assert.equal(result.timelineSeries.length, nodes.length)
  assert.equal(result.agentLoadSeries.length, 6)
  assert.ok(result.summary.overallCompletionRate > 0 && result.summary.overallCompletionRate <= 100)
  assert.equal(result.summary.doneTasks, 1)
  assert.equal(result.summary.runningTasks, 1)
  assert.equal(result.summary.blockedTasks, 1)
  assert.ok(result.summary.peakAgentLoad >= result.summary.avgAgentLoad)
  assert.ok(result.summary.peakAgentLoad <= 100)

  const stageD = result.timelineSeries.find((p) => p.key === 'D')
  assert.ok(stageD)
  assert.equal(stageD.statusLabel, '处理中')
  assert.ok(stageD.agentLoad > 50, 'active rendering stage D should reflect elevated agent load')

  const editorRole = result.agentLoadSeries.find((r) => r.roleId === 'editor')
  assert.ok(editorRole)
  assert.equal(editorRole.activeStatus, '执行中')
})

test('buildDailyEfficiencyData handles empty job and empty task list safely', () => {
  const result = buildDailyEfficiencyData({
    job: null,
    nodes: [],
    storyboard: [],
    tasks: [],
    studioJobs: [],
    deliveriesCount: 0,
    memPct: 0
  })

  assert.equal(result.timelineSeries.length, 0)
  assert.equal(result.agentLoadSeries.length, 6)
  assert.equal(result.summary.overallCompletionRate, 0)
  assert.equal(result.summary.totalRenderDurationS, 0)
})
