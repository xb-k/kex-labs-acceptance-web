import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { StudioJobDetail } from './components/studio/StudioJobDetail'
import { StudioJobRowContent } from './pages/JobsPage'
import type { StudioJob, StudioJobSummary } from './types'

/** #154 SSR 用：A 轨 job 摘要，duration_ms 可覆盖。 */
function summary(durationMs: number | null): StudioJobSummary {
  return {
    id: 'web-20261114040236-03db66',
    type: 'aigc',
    rail: 'A',
    status: 'succeeded',
    brief_id: 'brief_1794584902126_c3ac0e',
    created_at: '2026-11-13T20:02:37.006Z',
    updated_at: '2026-11-14T04:06:01+0800',
    error: null,
    stage: 'F',
    duration_ms: durationMs
  }
}

function detail(durationMs: number | null): StudioJob {
  return {
    ...summary(durationMs),
    plan_id: null,
    model: null,
    inputs: [],
    outputs: [],
    assets: [],
    qc: { status: 'pending', report_id: null },
    cost: { gpu_seconds: null, credits: null },
    created_by: 'web',
    events: [],
    progress: { stage: null, stages: {} }
  }
}

function renderDetail(durationMs: number | null): string {
  return renderToStaticMarkup(
    createElement(StudioJobDetail, {
      job: summary(durationMs),
      detail: detail(durationMs),
      brief: null,
      loading: false,
      error: null,
      onRetry: () => {}
    })
  )
}

test('#154 job 详情渲染真实耗时：203994ms → 耗时 3m 24s', () => {
  const html = renderDetail(203_994)
  assert.match(html, /data-testid="studio-job-duration"/)
  assert.match(html, /耗时 3m 24s/)
  assert.doesNotMatch(html, /耗时未记录/)
})

test('#154 job 详情无 duration 时渲染「耗时未记录」', () => {
  const html = renderDetail(null)
  assert.match(html, /data-testid="studio-job-duration"/)
  assert.match(html, /耗时未记录/)
  assert.doesNotMatch(html, /耗时 3m 24s/)
})

test('#154 /jobs 工坊行渲染真实耗时：203994ms → 耗时 3m 24s', () => {
  const html = renderToStaticMarkup(createElement(StudioJobRowContent, { job: summary(203_994) }))
  assert.match(html, /data-testid="studio-job-duration-web-20261114040236-03db66"/)
  assert.match(html, /耗时 3m 24s/)
  assert.doesNotMatch(html, /耗时未记录/)
})

test('#154 /jobs 工坊行无 duration 时渲染「耗时未记录」', () => {
  const html = renderToStaticMarkup(createElement(StudioJobRowContent, { job: summary(null) }))
  assert.match(html, /data-testid="studio-job-duration-web-20261114040236-03db66"/)
  assert.match(html, /耗时未记录/)
  assert.doesNotMatch(html, /耗时 3m 24s/)
})
