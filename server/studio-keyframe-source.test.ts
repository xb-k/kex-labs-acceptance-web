/**
 * #157: keyframe provenance + detail/list duration parity.
 * The derivation is explicit intake value > derived from asset + input, and the
 * detail endpoint must carry the same `duration_ms` as the list summary.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { buildStudioJob, resolveKeyframeSource } from './studio'
import type { StudioContext } from './studio'

const DATA_ROOT = path.join(os.tmpdir(), 'keyframe157-data')

function context(meta: Record<string, unknown> | null): StudioContext {
  return {
    dataRoot: DATA_ROOT,
    intakeUrl: '',
    timeoutMs: 2000,
    webToken: 'keyframe157-token',
    isSameOrigin: () => false,
    sendJson: () => {},
    readJson: () => meta,
    atomicWriteJson: () => {},
    readBody: async () => ({})
  }
}

const KEYFRAME = '/Users/kexinbao/kex/projects/kex-labs-video/jobs/web-20261114032741-43d3b9/output/image-01.png'

test('#157 有 keyframe 且无 input → keyframe_only', () => {
  assert.equal(resolveKeyframeSource({}, null, true, false), 'keyframe_only')
})

test('#157 有 keyframe 且有 input → injected', () => {
  assert.equal(resolveKeyframeSource({}, null, true, true), 'injected')
})

test('#157 无 keyframe → null（即使有 input）', () => {
  assert.equal(resolveKeyframeSource({}, null, false, true), null)
  assert.equal(resolveKeyframeSource({}, null, false, false), null)
})

test('#157 detail/state 的显式 keyframe_source 优先于派生', () => {
  assert.equal(resolveKeyframeSource({ keyframe_source: 'explicit.png' }, null, true, true), 'explicit.png')
  assert.equal(resolveKeyframeSource({}, { keyframe_source: 'state.png' }, true, false), 'state.png')
})

test('#157 keyframe-only job 详情：keyframe_source 派生 + duration_ms 与列表一致', () => {
  const job = buildStudioJob(context(null), 'web-20261114070156-95fb77', {
    state: 'succeeded',
    stage: 'F',
    created_at: '2026-11-14T07:01:17+08:00',
    updated_at: '2026-11-14T07:12:18+08:00',
    keyframe_asset: KEYFRAME
  })
  assert.equal(job.keyframe_source, 'keyframe_only')
  assert.deepEqual(job.keyframe_asset, {
    source_job: 'web-20261114032741-43d3b9',
    name: 'image-01.png'
  })
  assert.equal(job.duration_ms, 661_000)
})

test('#157 有 upload_id 的注入关键帧 job → injected', () => {
  const meta = {
    id: 'web-20261114070156-95fb77',
    type: 'aigc',
    rail: 'A',
    brief_id: null,
    model: null,
    input: null,
    upload_id: 'upl-0001',
    created_at: '2026-11-14T07:01:17+08:00'
  }
  const job = buildStudioJob(context(meta), 'web-20261114070156-95fb77', {
    state: 'succeeded',
    updated_at: '2026-11-14T07:12:18+08:00',
    keyframe_asset: KEYFRAME
  })
  assert.equal(job.keyframe_source, 'injected')
  assert.equal(job.inputs.length, 0, 'upload 不是 video input，inputs 仍为空')
})
