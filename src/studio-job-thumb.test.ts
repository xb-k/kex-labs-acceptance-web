import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { StudioJobRowContent, studioJobThumbKind, studioVideoPreviewSeek } from './pages/JobsPage'
import type { StudioJobSummary } from './types'

/** #159 SSR 用：工坊任务摘要，状态/类型可覆盖。 */
function summary(overrides: Partial<StudioJobSummary> = {}): StudioJobSummary {
  return {
    id: 'web-20261114120000-abcd12',
    type: 'aigc',
    rail: 'A',
    status: 'succeeded',
    brief_id: 'brief_1',
    created_at: '2026-11-14T12:00:00.000Z',
    updated_at: '2026-11-14T12:05:00+0800',
    error: null,
    stage: 'F',
    duration_ms: 120000,
    ...overrides
  }
}

function renderRow(overrides: Partial<StudioJobSummary> = {}): string {
  return renderToStaticMarkup(createElement(StudioJobRowContent, { job: summary(overrides) }))
}

test('#159 成功视频任务行渲染 final.mp4 缩略（静音 + 预载元数据）', () => {
  const html = renderRow()
  assert.match(html, /data-testid="studio-job-thumb-web-20261114120000-abcd12"/)
  assert.match(html, /data-thumb-kind="video"/)
  assert.match(html, /src="\/api\/studio\/jobs\/web-20261114120000-abcd12\/artifacts\/final\.mp4"/)
  assert.match(html, /muted/)
  assert.match(html, /playsinline/)
  assert.match(html, /preload="metadata"/)
  assert.doesNotMatch(html, /image-01\.png/)
})

test('#159 成功图片任务行渲染 image-01.png 缩略', () => {
  const html = renderRow({ type: 'image' })
  assert.match(html, /data-thumb-kind="image"/)
  assert.match(html, /src="\/api\/studio\/jobs\/web-20261114120000-abcd12\/artifacts\/image-01\.png"/)
  assert.doesNotMatch(html, /final\.mp4/)
})

test('#159 失败任务行不出媒体，回退 Film 图标', () => {
  const html = renderRow({ status: 'failed', error: 'B2_net_gain' })
  assert.match(html, /data-thumb-kind="icon"/)
  assert.match(html, /<svg/)
  assert.doesNotMatch(html, /final\.mp4/)
  assert.doesNotMatch(html, /image-01\.png/)
})

test('#159 进行中任务行不做假预览', () => {
  const html = renderRow({ status: 'running' })
  assert.match(html, /data-thumb-kind="icon"/)
  assert.doesNotMatch(html, /final\.mp4/)
  assert.doesNotMatch(html, /image-01\.png/)
})

test('#159 onError 后缩略类型退回图标', () => {
  assert.equal(studioJobThumbKind(summary(), true), 'icon')
  assert.equal(studioJobThumbKind(summary({ type: 'image' }), true), 'icon')
  assert.equal(studioJobThumbKind(summary({ status: 'failed' }), false), 'icon')
  assert.equal(studioJobThumbKind(summary({ type: 'image' }), false), 'image')
  assert.equal(studioJobThumbKind(summary(), false), 'video')
})

test('#159 视频取帧 0.4s，极短片不越界', () => {
  assert.equal(studioVideoPreviewSeek(10), 0.4)
  assert.equal(studioVideoPreviewSeek(0.5), 0.25)
  assert.equal(studioVideoPreviewSeek(0), 0.4)
  assert.equal(studioVideoPreviewSeek(Number.NaN), 0.4)
})
