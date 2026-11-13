/**
 * #157: the detail drawer labels keyframe provenance from `keyframe_source`
 * instead of claiming 「未使用注入关键帧」 while showing a keyframe asset.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { StudioJobDetail } from './components/studio/StudioJobDetail'
import type { StudioJob, StudioJobSummary } from './types'

function summary(): StudioJobSummary {
  return {
    id: 'web-20261114070156-95fb77',
    type: 'aigc',
    rail: 'A',
    status: 'succeeded',
    brief_id: 'brief_1794584902126_c3ac0e',
    created_at: '2026-11-13T23:01:17.000Z',
    updated_at: '2026-11-14T07:12:18+0800',
    error: null,
    stage: 'F',
    duration_ms: 661_109
  }
}

function detail(overrides: Partial<StudioJob>): StudioJob {
  return {
    ...summary(),
    plan_id: null,
    model: null,
    inputs: [],
    outputs: [],
    assets: [],
    qc: { status: 'pending', report_id: null },
    cost: { gpu_seconds: null, credits: null },
    created_by: 'web',
    events: [],
    progress: { stage: null, stages: {} },
    ...overrides
  }
}

function render(overrides: Partial<StudioJob>): string {
  return renderToStaticMarkup(
    createElement(StudioJobDetail, {
      job: summary(),
      detail: detail(overrides),
      brief: null,
      loading: false,
      error: null,
      onRetry: () => {}
    })
  )
}

const ASSET = { source_job: 'web-20261114032741-43d3b9', name: 'image-01.png' }

test('#157 keyframe_only → 仅关键帧生成底片，不再说未使用', () => {
  const html = render({ keyframe_source: 'keyframe_only', keyframe_asset: ASSET })
  assert.match(html, /仅关键帧生成底片/)
  assert.match(html, /web-20261114032741-43d3b9\/image-01\.png/)
  assert.doesNotMatch(html, /未使用关键帧/)
  assert.doesNotMatch(html, /keyframe_source 为空/)
})

test('#157 injected → 已注入关键帧', () => {
  const html = render({ keyframe_source: 'injected', keyframe_asset: ASSET })
  assert.match(html, /已注入关键帧/)
  assert.doesNotMatch(html, /未使用关键帧/)
})

test('#157 无 source 但有资产（旧任务）→ 已注入关键帧，不矛盾', () => {
  const html = render({ keyframe_source: null, keyframe_asset: ASSET })
  assert.match(html, /已注入关键帧/)
  assert.doesNotMatch(html, /未使用关键帧/)
  assert.doesNotMatch(html, /keyframe_source 为空/)
})

test('#157 无 source 且无资产 → 未使用关键帧', () => {
  const html = render({ keyframe_source: null, keyframe_asset: null })
  assert.match(html, /未使用关键帧/)
  assert.doesNotMatch(html, /已注入关键帧/)
  assert.doesNotMatch(html, /仅关键帧生成底片/)
})
