/**
 * #86b2 contract tests: studio optimize job → DetailResponse fallback.
 * Values come from `summary.json` / `quality_b.json`; missing thresholds stay
 * null and are never replaced by guessed defaults.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { buildBMetrics, mapStudioJobToDetail, studioFallbackDetail } from './api'
import type { StudioContext } from './studio'

const summary = {
  job: 'i86_real_fix_20261113033839',
  rail: 'B',
  status: 'FAIL',
  verdict: 'FAIL',
  generated_at: '2026-11-13T03:38:48+08:00',
  metrics: {
    B1_ssim_mean: 0.9054,
    B1_ssim_min: 0.8877,
    B2_lapvar_flat_gain_pct: -37.889,
    B2_lapvar_gain_pct: -4.685,
    B2_net_gain_vs_baseline_ratio: 0.9531,
    B2_noise_change_pct: -33.973,
    color_p95_delta_e2000: 1.5474
  },
  failed: ['B2_net_gain'],
  positives: ['noise_down', 'color_convergence'],
  fps_in: 59.9572,
  fps_out: 59.957,
  quality: { status: 'FAIL', error: null, report: '/jobs/x/quality_b.json' },
  output: {
    path: '/jobs/x/output/final.mp4',
    probe: { duration_s: 10.01, fps: 59.957, width: 1920, height: 1080, video_codec: 'h264' }
  },
  source: {
    effective_path: '/jobs/x/work/source_trimmed.mp4',
    probe: { duration_s: 35.008, fps: 59.9572, width: 1920, height: 1080 }
  },
  stage_ms: { probe: 10, trim: 1362, metrics: 1124 },
  elapsed_s: 8.533
}

const quality = {
  checks: [
    { name: 'B1_ssim', value: 0.9054, threshold: 0.8, op: '>=', pass: true, hard: true },
    { name: 'B2_net_gain', value: 0.9531, threshold: 1.5, op: '>=', pass: false, hard: true },
    { name: 'B2_noise', value: -33.973, threshold: 15.0, op: '<=', pass: true, hard: true },
    { name: 'B2_positives', value: 2, threshold: 2, op: '>=', pass: true, hard: true },
    { name: 'color_p95_delta_e2000', value: 1.5474, threshold: 6.0, op: '<=', pass: true, hard: false }
  ],
  failed: ['B2_net_gain']
}

const studioJob = {
  id: 'i86_real_fix_20261113033839',
  type: 'optimize',
  rail: 'B',
  status: 'failed',
  brief_id: 'brief_abc',
  plan_id: null,
  model: null,
  inputs: [],
  outputs: [],
  assets: [],
  qc: { status: 'fail', report_id: null },
  cost: { gpu_seconds: null, credits: null },
  created_by: 'web',
  created_at: '2026-11-13T03:38:00+08:00',
  updated_at: '2026-11-13T03:38:48+08:00',
  events: [],
  error: null,
  progress: { stage: 'done', stages: {} }
} as any

test('buildBMetrics maps B1/B2 rows and keeps upstream thresholds', () => {
  const m = buildBMetrics(summary, quality)
  assert.ok(m)
  assert.equal(m?.verdict, 'FAIL')
  assert.equal(m?.status, 'FAIL')
  assert.equal(m?.positiveCount, 2)
  assert.equal(m?.fpsIn, 59.9572)
  assert.equal(m?.fpsOut, 59.957)
  assert.deepEqual(m?.failed, ['B2_net_gain'])
  assert.equal(m?.source, 'summary.json + quality_b.json')

  const byKey = new Map((m?.checks ?? []).map((c) => [c.key, c]))
  const b1 = byKey.get('B1_ssim')
  assert.equal(b1?.value, 0.9054)
  assert.equal(b1?.threshold, 0.8)
  assert.equal(b1?.pass, true)
  const b2 = byKey.get('B2_net_gain')
  assert.equal(b2?.value, 0.9531)
  assert.equal(b2?.threshold, 1.5)
  assert.equal(b2?.pass, false)
  assert.equal(byKey.get('B2_noise')?.pass, true)
  assert.equal(byKey.get('color_p95_delta_e2000')?.hard, false)
  // summary-only rows carry no threshold (never invented)
  assert.equal(byKey.get('B1_ssim_min')?.threshold, null)
  assert.equal(byKey.get('B2_lapvar_gain_pct')?.threshold, null)
})

test('buildBMetrics without quality keeps thresholds 未记录 and FAIL for listed keys', () => {
  const m = buildBMetrics(summary, null)
  assert.ok(m)
  assert.equal(m?.source, 'summary.json')
  const byKey = new Map((m?.checks ?? []).map((c) => [c.key, c]))
  assert.equal(byKey.get('B1_ssim_mean')?.threshold, null)
  assert.equal(byKey.get('B1_ssim_mean')?.pass, null)
  assert.equal(byKey.get('B2_net_gain_vs_baseline_ratio')?.pass, false)
  assert.equal(byKey.get('B2_net_gain_vs_baseline_ratio')?.threshold, null)
  assert.equal(m?.verdict, 'FAIL')
})

test('buildBMetrics returns null when summary is missing', () => {
  assert.equal(buildBMetrics(null, quality), null)
})

test('mapStudioJobToDetail assembles media, verdict and B metrics', () => {
  const detail = mapStudioJobToDetail({
    id: studioJob.id,
    job: studioJob,
    meta: { upload_id: 'abcd1234-5678', type: 'optimize', brief_id: 'brief_abc' },
    summary,
    quality
  })

  assert.equal(detail.job.id, studioJob.id)
  assert.equal(detail.job.track, 'B')
  // #102: type/rail 透传给展示层，可读标签不再依赖含 id 的 title。
  assert.equal(detail.job.type, 'optimize')
  assert.equal(detail.job.rail, 'B')
  assert.equal(detail.job.verdict, 'FAIL')
  assert.equal(detail.job.statusLabel, '未通过')
  assert.equal(detail.job.taskId, 'brief_abc')
  assert.equal(detail.job.hasQc, false)
  assert.equal(detail.job.durationS, 10.01)
  assert.equal(detail.job.fps, 59.957)
  assert.equal(detail.job.media.original, '/api/uploads/abcd1234-5678/source')
  assert.equal(
    detail.job.media.output,
    `/api/studio/jobs/${studioJob.id}/artifacts/final.mp4`
  )
  assert.equal(
    detail.job.summaryPath,
    `/api/studio/jobs/${studioJob.id}/artifacts/summary.json`
  )
  assert.equal(
    detail.job.metricsPath,
    `/api/studio/jobs/${studioJob.id}/artifacts/metrics.csv`
  )
  assert.ok(detail.bMetrics)
  assert.equal(detail.job.passed, 4)
  assert.equal(detail.job.total, detail.bMetrics?.checks.length)
  assert.equal(detail.job.judged, 5)
  assert.ok(detail.notes.some((n) => n.includes('B2_net_gain')))
  assert.equal(detail.criteria.find((c) => c.key === 'B2_net_gain')?.pass, false)
})

test('mapStudioJobToDetail shows 未记录 instead of inventing media/values', () => {
  const detail = mapStudioJobToDetail({
    id: 'job_without_meta',
    job: { ...studioJob, id: 'job_without_meta', type: 'aigc', status: 'succeeded' },
    meta: {},
    summary: null,
    quality: null
  })
  assert.equal(detail.job.media.original, null)
  assert.equal(detail.job.type, 'aigc')
  assert.equal(detail.job.rail, 'B')
  assert.equal(detail.bMetrics, null)
  assert.equal(detail.job.verdict, 'UNKNOWN')
  assert.equal(detail.criteria.length, 0)
  assert.equal(detail.job.metricsPath, null)
})

// #86e: the job had no summary.json / final.mp4, yet the old fallback claimed
// "质量门禁 FAIL（summary.verdict）" and marked the output artifact `exists:true`.
test('missing summary never cites summary.verdict and marks artifacts missing', () => {
  const detail = mapStudioJobToDetail({
    id: 'web-20261113082701-b01b92',
    job: { ...studioJob, id: 'web-20261113082701-b01b92', status: 'failed' },
    meta: { upload_id: 'up-mwe8lee5-db06b5' },
    summary: null,
    quality: null,
    readable: { original: false, output: false },
    failureReason: null
  })
  assert.match(detail.job.statusNote, /summary 未记录（产物缺失）/)
  assert.match(detail.job.statusNote, /失败原因：未记录/)
  assert.doesNotMatch(detail.job.statusNote, /summary\.verdict/)
  const byLabel = new Map(detail.dataSources.map((s) => [s.label, s]))
  assert.equal(byLabel.get('summary（代理）')?.exists, false)
  assert.equal(byLabel.get('quality_b（代理）')?.exists, false)
  assert.equal(byLabel.get('原片')?.exists, false)
  assert.equal(byLabel.get('优化片（代理）')?.exists, false)
})

test('missing summary keeps an upstream failure reason without inventing a verdict', () => {
  const detail = mapStudioJobToDetail({
    id: 'web-failed-with-reason',
    job: { ...studioJob, id: 'web-failed-with-reason', status: 'failed' },
    meta: {},
    summary: null,
    quality: null,
    failureReason: 'staging the source failed',
    readable: { original: false, output: false }
  })
  assert.match(detail.job.statusNote, /失败原因：staging the source failed/)
  assert.doesNotMatch(detail.job.statusNote, /summary\.verdict/)
})

test('dataSources exists follows actual readability flags', () => {
  const detail = mapStudioJobToDetail({
    id: 'web-readable',
    job: { ...studioJob, id: 'web-readable', status: 'succeeded' },
    meta: { upload_id: 'up-abc12345' },
    summary: null,
    quality: null,
    readable: { original: true, output: true }
  })
  const byLabel = new Map(detail.dataSources.map((s) => [s.label, s]))
  assert.equal(byLabel.get('summary（代理）')?.exists, false)
  assert.equal(byLabel.get('原片')?.exists, true)
  assert.equal(byLabel.get('优化片（代理）')?.exists, true)
})

test('summary.verdict is cited only when summary.json was actually read', () => {
  const detail = mapStudioJobToDetail({
    id: 'web-with-summary',
    job: { ...studioJob, id: 'web-with-summary', status: 'failed', error: null },
    meta: {},
    summary: { ...summary, failed: [], quality: { status: 'FAIL', error: null } },
    quality: null
  })
  assert.match(detail.job.statusNote, /summary\.verdict/)
  const byLabel = new Map(detail.dataSources.map((s) => [s.label, s]))
  assert.equal(byLabel.get('summary（代理）')?.exists, true)
})

// #89d: `/api/metrics/:id` studio projection must carry cover / keyframe read-back.
test('metrics detail exposes cover and keyframe when the studio job has them', () => {
  const detail = mapStudioJobToDetail({
    id: 'web-20261113090324-7ff855',
    job: {
      ...studioJob,
      id: 'web-20261113090324-7ff855',
      type: 'image',
      status: 'succeeded',
      cover_asset: {
        source_job: 'web-20261113090322-761b08',
        name: 'image-01.png',
        url: '/api/studio/jobs/web-20261113090322-761b08/artifacts/image-01.png'
      },
      cover_url: '/api/studio/jobs/web-20261113090322-761b08/artifacts/image-01.png',
      keyframe_asset: { source_job: 'web-20261113090322-761b08', name: 'image-01.png' },
      keyframe_source: 'web-20261113090322-761b08/image-01.png'
    },
    meta: { type: 'image' },
    summary: null,
    quality: null
  })
  assert.deepEqual(detail.job.cover_asset, {
    source_job: 'web-20261113090322-761b08',
    name: 'image-01.png',
    url: '/api/studio/jobs/web-20261113090322-761b08/artifacts/image-01.png'
  })
  assert.equal(
    detail.job.cover_url,
    '/api/studio/jobs/web-20261113090322-761b08/artifacts/image-01.png'
  )
  assert.deepEqual(detail.job.keyframe_asset, {
    source_job: 'web-20261113090322-761b08',
    name: 'image-01.png'
  })
  assert.equal(detail.job.keyframe_source, 'web-20261113090322-761b08/image-01.png')
  // The JSON response must always carry the keys, not omit them.
  const wire = JSON.parse(JSON.stringify(detail.job))
  for (const key of ['cover_asset', 'cover_url', 'keyframe_asset', 'keyframe_source']) {
    assert.equal(key in wire, true, key)
  }
})

test('metrics detail keeps cover and keyframe null when the studio job has none', () => {
  const detail = mapStudioJobToDetail({
    id: 'web-20261113082701-b01b92',
    job: { ...studioJob, id: 'web-20261113082701-b01b92', status: 'failed' },
    meta: {},
    summary: null,
    quality: null
  })
  assert.equal(detail.job.cover_asset, null)
  assert.equal(detail.job.cover_url, null)
  assert.equal(detail.job.keyframe_asset, null)
  assert.equal(detail.job.keyframe_source, null)
  const wire = JSON.parse(JSON.stringify(detail.job))
  assert.deepEqual(
    {
      cover_asset: wire.cover_asset,
      cover_url: wire.cover_url,
      keyframe_asset: wire.keyframe_asset,
      keyframe_source: wire.keyframe_source
    },
    { cover_asset: null, cover_url: null, keyframe_asset: null, keyframe_source: null }
  )
})

// ---------------------------------------------------------------------------
// #89e: A-rail aigc jobs never write summary.json. `/api/metrics/:id` must
// still return the studio projection (keyframe read-back) instead of a 404.
// ---------------------------------------------------------------------------

/**
 * Minimal intake stub: `GET /intake/jobs/:id` returns `jobs[id]`, everything
 * else 404s. `readJson` serves the web-side job metas so `type` comes from the
 * same place production reads it.
 */
async function withIntake(
  jobs: Record<string, any>,
  metas: Record<string, any>,
  fn: (ctx: StudioContext, hits: string[]) => Promise<void>
) {
  const hits: string[] = []
  const upstream = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    hits.push(url.pathname)
    const m = url.pathname.match(/^\/intake\/jobs\/([^/]+)$/)
    const body = m ? jobs[decodeURIComponent(m[1])] : undefined
    res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body ?? { error: 'not found' }))
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const { port } = upstream.address() as { port: number }
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fallback89e-'))
  const ctx: StudioContext = {
    dataRoot,
    intakeUrl: `http://127.0.0.1:${port}`,
    timeoutMs: 2000,
    webToken: 'test-token',
    isSameOrigin: () => false,
    sendJson: () => {},
    readJson: (file: string) => metas[path.basename(file, '.json')] ?? null,
    atomicWriteJson: () => {},
    readBody: async () => null
  }
  try {
    await fn(ctx, hits)
  } finally {
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
    fs.rmSync(dataRoot, { recursive: true, force: true })
  }
}

test('#89e aigc job without summary.json still resolves with keyframe_asset', async () => {
  const id = 'web-20261113093155-3ef5f3'
  await withIntake(
    {
      [id]: {
        state: 'succeeded',
        updated_at: '2026-11-13T01:31:55.723Z',
        keyframe_asset: { source_job: 'web-20261113090322-761b08', name: 'image-01.png' },
        keyframe_source: 'web-20261113090322-761b08/image-01.png'
      }
    },
    {},
    async (ctx) => {
      const detail = await studioFallbackDetail(id, ctx)
      assert.ok(detail, 'aigc detail must not be null without summary.json')
      assert.equal(detail?.job.id, id)
      assert.deepEqual(detail?.job.keyframe_asset, {
        source_job: 'web-20261113090322-761b08',
        name: 'image-01.png'
      })
      assert.equal(detail?.job.keyframe_source, 'web-20261113090322-761b08/image-01.png')
      // No summary → no invented metrics/verdict evidence.
      assert.equal(detail?.bMetrics ?? null, null)
      assert.deepEqual(detail?.criteria, [])
      assert.match(detail?.job.statusNote ?? '', /summary 未记录/)
    }
  )
})

test('#89e illegal job id stays a 404 without calling the intake', async () => {
  await withIntake({}, {}, async (ctx, hits) => {
    assert.equal(await studioFallbackDetail('../etc/passwd', ctx), null)
    assert.deepEqual(hits, [])
  })
})

test('#89e unknown studio job id stays a 404', async () => {
  await withIntake({}, {}, async (ctx) => {
    assert.equal(await studioFallbackDetail('web-20261113000000-abcdef', ctx), null)
  })
})

test('#89e image and optimize jobs without summary keep working', async () => {
  const jobs = {
    'job-image': { state: 'succeeded', updated_at: '2026-11-13T00:00:00.000Z' },
    'job-optimize': { state: 'failed', updated_at: '2026-11-13T00:00:01.000Z', error: 'quality gate failed' }
  }
  await withIntake(
    jobs,
    {
      'job-image': { id: 'job-image', type: 'image' },
      'job-optimize': { id: 'job-optimize', type: 'optimize' }
    },
    async (ctx) => {
      const image = await studioFallbackDetail('job-image', ctx)
      const optimize = await studioFallbackDetail('job-optimize', ctx)
      assert.ok(image, 'image job without summary.json must still resolve')
      assert.ok(optimize, 'optimize job without summary.json must still resolve')
      // No summary → missing metrics stay missing, never guessed.
      assert.equal(image?.bMetrics ?? null, null)
      assert.equal(optimize?.job.status, 'FAIL')
      assert.match(optimize?.job.statusNote ?? '', /失败原因：quality gate failed/)
    }
  )
})
