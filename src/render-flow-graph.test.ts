import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MACRO_STAGES,
  RENDER_FLOW_EDGES,
  buildEdgeGeometry,
  buildRenderFlowGraphData,
  describeEdgeState,
  nodeIdForStageKey
} from './components/flow/render-flow-graph-model'
import type { FlowJob } from './types'

function makeJob(overrides: Partial<FlowJob> = {}): FlowJob {
  return {
    id: 'test_job',
    stage: 'D',
    updated_at: null,
    duration_s: 120,
    probe: { width: 1920, height: 1080, fps: 30 },
    cold_warm: null,
    shots: [{ shot_id: 1, start: 0, end: 3.5, duration_s: 3.5 }],
    frames: [{ shot_id: 1, frame_ts: 1.2, path: 'frames/shot_01.png', exists: true }],
    semantics: null,
    shot_semantics: null,
    profile: { name: 'ad_teal_orange' },
    profile_prompt: null,
    quality: null,
    quality_gate: null,
    artifacts: [],
    stages: [
      { key: 'A', status: 'done', duration_s: 8, updated_at: null, tools: [], artifacts: [] },
      { key: 'B', status: 'done', duration_s: 12, updated_at: null, tools: [], artifacts: [] },
      { key: 'C', status: 'done', duration_s: 30, updated_at: null, tools: [], artifacts: [] },
      { key: 'D', status: 'running', duration_s: 70, updated_at: null, tools: [], artifacts: [] },
      { key: 'E', status: 'pending', duration_s: null, updated_at: null, tools: [], artifacts: [] },
      { key: 'F', status: 'pending', duration_s: null, updated_at: null, tools: [], artifacts: [] }
    ],
    decisions: [],
    reports: { render: null, assemble: null, interpolate: null },
    ...overrides
  }
}

test('render flow graph defines all 4 macro stages: ingest, slice, agents, compose', () => {
  assert.deepEqual(
    MACRO_STAGES.map((m) => m.label),
    ['入库', '切片', 'Agent 处理', '合成']
  )
})

test('buildRenderFlowGraphData maps 8 job stages including video script node and valid SVG edges', () => {
  const nodes = buildRenderFlowGraphData(makeJob())
  assert.equal(nodes.length, 8)

  const byId = new Map(nodes.map((n) => [n.id, n]))
  assert.equal(byId.get('ingest')?.status, 'done')
  assert.equal(byId.get('slice')?.status, 'done')
  assert.equal(byId.get('director')?.status, 'done')
  assert.equal(byId.get('script')?.status, 'done')
  assert.equal(byId.get('writer')?.status, 'done')
  assert.equal(byId.get('editor')?.status, 'running')
  assert.equal(byId.get('colorist')?.status, 'pending')
  assert.equal(byId.get('final')?.status, 'pending')

  for (const edge of RENDER_FLOW_EDGES) {
    const geom = buildEdgeGeometry(edge, byId)
    assert.ok(geom, `missing geometry for edge ${edge.id}`)
    assert.match(geom.d, /^M /)
  }
})

test('describeEdgeState flags edges touching running editor or script generation node as processing', () => {
  const nodes = buildRenderFlowGraphData(makeJob())
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const activeSet = new Set<'slice'>(['slice'])

  const processingEdgeIds = RENDER_FLOW_EDGES.filter(
    (edge) => describeEdgeState(edge, byId, activeSet).isProcessing
  ).map((edge) => edge.id)
  assert.deepEqual(processingEdgeIds, ['script-editor', 'writer-editor', 'editor-colorist'])

  const scriptRunningNodes = buildRenderFlowGraphData(makeJob(), undefined, { scriptStatus: 'running' })
  const scriptById = new Map(scriptRunningNodes.map((n) => [n.id, n]))
  const scriptProcessingEdges = RENDER_FLOW_EDGES.filter(
    (edge) => describeEdgeState(edge, scriptById, activeSet).isProcessing
  ).map((edge) => edge.id)
  assert.ok(scriptProcessingEdges.includes('slice-script'))
  assert.ok(scriptProcessingEdges.includes('director-script'))
  assert.ok(scriptProcessingEdges.includes('script-writer'))
  assert.ok(scriptProcessingEdges.includes('script-editor'))
})

test('nodeIdForStageKey maps A/B/B2/SCRIPT/C/D/E/F cleanly while preserving ingest vs slice choice', () => {
  assert.equal(nodeIdForStageKey('A', 'ingest'), 'ingest')
  assert.equal(nodeIdForStageKey('A', 'slice'), 'slice')
  assert.equal(nodeIdForStageKey('B2'), 'director')
  assert.equal(nodeIdForStageKey('SCRIPT'), 'script')
  assert.equal(nodeIdForStageKey('C'), 'writer')
  assert.equal(nodeIdForStageKey('D'), 'editor')
  assert.equal(nodeIdForStageKey('E'), 'colorist')
  assert.equal(nodeIdForStageKey('F'), 'final')
})

test('buildEdgeGeometry places all edge labels without colliding with nodes or each other', async () => {
  const { NODE_W, NODE_H } = await import('./components/flow/render-flow-graph-model')
  const nodes = buildRenderFlowGraphData(makeJob())
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const geoms = RENDER_FLOW_EDGES.map((e) => buildEdgeGeometry(e, byId)!).filter(Boolean)

  // Check label-to-node clearance
  for (const g of geoms) {
    const lx1 = g.labelX - g.labelW / 2
    const lx2 = g.labelX + g.labelW / 2
    const ly1 = g.labelY - g.labelH / 2
    const ly2 = g.labelY + g.labelH / 2
    for (const n of nodes) {
      const overlapX = lx1 < n.x + NODE_W && lx2 > n.x
      const overlapY = ly1 < n.y + NODE_H && ly2 > n.y
      assert.equal(
        overlapX && overlapY,
        false,
        `edge label ${g.edge.id} overlaps node ${n.id}`
      )
    }
  }

  // Check label-to-label clearance
  for (let i = 0; i < geoms.length; i += 1) {
    for (let j = i + 1; j < geoms.length; j += 1) {
      const a = geoms[i]
      const b = geoms[j]
      const overlapX =
        Math.abs(a.labelX - b.labelX) < (a.labelW + b.labelW) / 2 - 2
      const overlapY =
        Math.abs(a.labelY - b.labelY) < (a.labelH + b.labelH) / 2 - 2
      assert.equal(
        overlapX && overlapY,
        false,
        `edge labels ${a.edge.id} and ${b.edge.id} overlap`
      )
    }
  }
})
