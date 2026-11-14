import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { StageNodeTrack } from './components/production/StageNodeTrack'
import { buildPipelineNodes } from './components/production/production-data'
import { RouterProvider } from './router'
import {
  MEDIA_JOBS_TRACKER_URL,
  NAS_ARTIFACT_LABEL,
  nasArtifactsForNode,
  resolveStageArtifacts,
  type MediaJobItem
} from './media-jobs'
import type { FlowArtifact, FlowJob } from './types'

const JOB = 'web-20261114120000-abcd12'

function media(
  name: string,
  kind: MediaJobItem['kind'],
  overrides: Partial<MediaJobItem> = {}
): MediaJobItem {
  return {
    job_id: JOB,
    name,
    path: `media/jobs/${JOB}/${name}`,
    url: `/api/media/jobs/${JOB}/${name}`,
    size: 1024,
    bytes: 1024,
    mtime: '2026-11-14T12:00:00.000Z',
    kind,
    ...overrides
  }
}

function makeJob(overrides: Partial<FlowJob> = {}): FlowJob {
  return {
    id: JOB,
    stage: 'F',
    updated_at: null,
    duration_s: null,
    stages: [
      { key: 'F', status: 'done', duration_s: null, updated_at: null, tools: [] }
    ],
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

/* 场景：#160 F 节点没有 state 产物时，展示该 job 的 NAS final.mp4。 */
test('#160 F 节点注入 NAS final.mp4（只取当前 job，成片排最前）', () => {
  const items = [
    media('image-01.png', 'image'),
    media('final.mp4', 'video'),
    media('other.mp4', 'video', { job_id: 'other-job' })
  ]
  const artifacts = nasArtifactsForNode(items, JOB, 'F')
  assert.equal(artifacts.length, 2)
  assert.equal(artifacts[0].url, `/api/media/jobs/${JOB}/final.mp4`)
  assert.equal(artifacts[0].kind, 'video')
  assert.equal(artifacts[0].label, NAS_ARTIFACT_LABEL)
  assert.ok(artifacts.some((art) => art.path.endsWith('/image-01.png')))
  assert.ok(artifacts.every((art) => !art.path.includes('other-job')))
})

/* 场景：#160 state 已记录真实产物时不得被 NAS 覆盖。 */
test('#160 state 产物优先于 NAS 媒体', () => {
  const state: FlowArtifact[] = [
    {
      path: 'jobs/web-1/clips/shot-01.mp4',
      exists: true,
      kind: 'video',
      label: 'clips',
      rel: null,
      url: '/media/kex?path=jobs%2Fweb-1%2Fclips%2Fshot-01.mp4'
    }
  ]
  const resolved = resolveStageArtifacts(state, [media('final.mp4', 'video')], JOB, 'F')
  assert.deepEqual(resolved, state)

  const fallback = resolveStageArtifacts([], [media('final.mp4', 'video')], JOB, 'F')
  assert.equal(fallback.length, 1)
  assert.equal(fallback[0].url, `/api/media/jobs/${JOB}/final.mp4`)
})

/* 场景：#160 只有 D/E 复用视频；A/B/C 没有 NAS 文件时保持空，不伪造。 */
test('#160 D/E 仅复用视频，早期节点不注入 NAS', () => {
  const items = [media('image-01.png', 'image'), media('final.mp4', 'video')]
  for (const key of ['D', 'E']) {
    const artifacts = nasArtifactsForNode(items, JOB, key)
    assert.equal(artifacts.length, 1)
    assert.equal(artifacts[0].kind, 'video')
  }
  for (const key of ['A', 'B', 'B2', 'SCRIPT', 'C']) {
    assert.deepEqual(nasArtifactsForNode(items, JOB, key), [])
  }
})

function renderTrack(artifacts: FlowArtifact[], activeKey = 'F'): string {
  // SSR 无浏览器全局：RouterProvider 初始化只读 window.location（effect 不执行）。
  ;(globalThis as any).window ??= { location: { pathname: '/', search: '' } }
  return renderToStaticMarkup(
    createElement(
      RouterProvider,
      null,
      createElement(StageNodeTrack, {
        job: makeJob(),
        nodes: buildPipelineNodes(makeJob()),
        activeKey,
        onSelectNode: () => {},
        stageArtifacts: artifacts
      })
    )
  )
}

/* 场景：#160 NAS 成片在节点内以可播放 video 展示，多资产横向滚动。 */
test('#160 F 节点渲染 video controls/preload/playsInline 与 NAS URL', () => {
  const artifacts = nasArtifactsForNode([media('final.mp4', 'video')], JOB, 'F')
  const html = renderTrack(artifacts)
  assert.match(html, /data-testid="stage-node-artifacts"/)
  assert.match(html, /data-testid="stage-node-video"/)
  assert.match(html, new RegExp(`src="/api/media/jobs/${JOB}/final.mp4"`))
  assert.match(html, /controls=""/)
  assert.match(html, /preload="metadata"/)
  assert.match(html, /playsinline=""/i)
  assert.match(html, /overflow-x-auto/)
  assert.equal(MEDIA_JOBS_TRACKER_URL, '/api/media/jobs?limit=200')
})

/* 场景：#160 本节点没有真实产物时显示空态，不伪造视频。 */
test('#160 无产物时显示「本节点暂无真实产物」且不渲染 video', () => {
  const html = renderTrack([])
  assert.match(html, /data-testid="stage-node-artifacts-empty"/)
  assert.match(html, /本节点暂无真实产物/)
  assert.doesNotMatch(html, /stage-node-video/)
})
