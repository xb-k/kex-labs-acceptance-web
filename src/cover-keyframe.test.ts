/**
 * #89d: `/job/<id>` renders cover / keyframe read-back without inventing data.
 * Rendered with react-dom/server — no test-only DOM dependency is added.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { CoverKeyframeCard } from './components/CoverKeyframeCard'
import type { Job } from './types'

const base = {
  id: 'web-20261113090324-7ff855',
  track: 'B',
  taskId: '',
  title: '创作工坊任务 · web-20261113090324-7ff855',
  status: 'UNKNOWN',
  verdict: 'UNKNOWN',
  gateStatus: 'UNKNOWN',
  statusLabel: '未记录',
  statusNote: 'summary 未记录（产物缺失），判定与指标未记录。',
  passed: 0,
  total: 0,
  judged: 0,
  durationS: null,
  fps: null,
  width: null,
  height: null,
  frames: null,
  sourceStart: 0,
  hasQc: false,
  media: { original: null, output: null, poster: null, posterOriginal: null },
  summaryPath: '/api/studio/jobs/web-20261113090324-7ff855/artifacts/summary.json',
  reportPath: null,
  metricsPath: null
} as unknown as Job

const render = (job: Job) =>
  renderToStaticMarkup(createElement(CoverKeyframeCard, { job }))

test('renders cover and keyframe thumbnails plus source_job/name when set', () => {
  const url = '/api/studio/jobs/web-20261113090322-761b08/artifacts/image-01.png'
  const html = render({
    ...base,
    cover_asset: {
      source_job: 'web-20261113090322-761b08',
      name: 'image-01.png',
      url
    },
    cover_url: url,
    keyframe_asset: { source_job: 'web-20261113090322-761b08', name: 'image-01.png' },
    keyframe_source: 'web-20261113090322-761b08/image-01.png'
  })
  assert.match(html, /封面/)
  assert.match(html, /关键帧/)
  assert.match(html, /data-testid="cover-thumb"/)
  assert.match(html, /data-testid="keyframe-thumb"/)
  assert.equal(html.split(`src="${url}"`).length - 1, 2)
  assert.match(html, /web-20261113090322-761b08 \/ image-01\.png/)
  assert.doesNotMatch(html, /未设置/)
})

test('shows 未设置 for missing cover and keyframe', () => {
  const html = render({ ...base, cover_asset: null, cover_url: null, keyframe_asset: null })
  assert.match(html, /data-testid="cover-empty"/)
  assert.match(html, /data-testid="keyframe-empty"/)
  assert.equal(html.split('未设置').length - 1, 2)
  assert.doesNotMatch(html, /<img/)
})
