/**
 * #89b contract tests: image jobs (t2i / edit), the image gallery projection,
 * the cover proxy and keyframe passthrough.
 *
 * The intake is a local HTTP stub; every assertion goes through the production
 * `handleStudioRoute` path. Run with `npm run test:server`.
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleStudioRoute, validateImageRequest } from './studio'
import type { StudioContext } from './studio'

const TOKEN = 'image89-test-token'
const dataRoot = path.join(os.tmpdir(), 'image89-data')

let upstream: http.Server
let web: http.Server
let base = ''
let intakeUrl = ''

/** Every request the stub intake saw, with the parsed JSON body for POSTs. */
const hits: Array<{ method: string; url: string; body: any }> = []
/** Job metas the web server reads back (mirrors `data/studio/jobs/<id>.json`). */
const jobMetas: Record<string, any> = {}
/** Upload metas the web server reads back (mirrors `data/uploads/<id>/meta.json`). */
const uploadMetas: Record<string, any> = {}
/** Real source bytes for `readReadyUpload`'s `fs.statSync`, keyed by upload id. */
const uploadSources: Record<string, Buffer> = {}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Buffer))
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) : {}
}

const ctx: StudioContext = {
  dataRoot,
  intakeUrl: '',
  timeoutMs: 2000,
  webToken: TOKEN,
  // Writes are authorised by same-origin in these tests.
  isSameOrigin: () => true,
  sendJson,
  readJson: (file: string) => {
    const upload = file.match(/\/uploads\/([^/]+)\/meta\.json$/)
    if (upload) return uploadMetas[upload[1]] ?? null
    const id = path.basename(file, '.json')
    return jobMetas[id] ?? null
  },
  atomicWriteJson: () => {},
  readBody
}

const DETAILS: Record<string, any> = {
  'img-1': {
    state: 'succeeded',
    updated_at: '2026-11-13T00:00:00.000Z',
    image: { mode: 't2i', prompt: '海边的猫', negative: '', width: 1024, height: 1024, seed: 7, steps: 24, denoise: 1 },
    // intake reports absolute studio paths here; the gallery must sanitize them.
    artifacts: { 0: '/studio/jobs/img-1/output/a.png', 1: '/studio/jobs/img-1/output/b.webp' },
    cover_asset: '/studio/jobs/img-1/output/a.png',
    elapsed_s: 12.5
  },
  'aigc-1': {
    state: 'succeeded',
    updated_at: '2026-11-13T00:00:01.000Z',
    artifacts: { 0: '/studio/jobs/aigc-1/output/clip.mp4' }
  },
  'img-outside': {
    state: 'succeeded',
    updated_at: '2026-11-13T00:00:02.000Z',
    artifacts: {},
    // Not under jobs/<job>/output → no proxy URL may be invented.
    cover_asset: '/data/private/leak.png'
  },
  created: { state: 'queued', updated_at: '2026-11-13T00:00:03.000Z' },
  j1: {
    state: 'running',
    updated_at: '2026-11-13T00:00:04.000Z',
    cover_asset: '/studio/jobs/j1/output/pick.png'
  },
  // #89d keyframe read-back fixtures.
  'kf-path': {
    state: 'succeeded',
    updated_at: '2026-11-13T00:00:05.000Z',
    keyframe_asset: '/studio/jobs/kf-job/output/pick.png'
  },
  'kf-outside': {
    state: 'succeeded',
    updated_at: '2026-11-13T00:00:06.000Z',
    keyframe_asset: '/data/private/leak.png'
  },
  'kf-object': {
    state: 'succeeded',
    updated_at: '2026-11-13T00:00:07.000Z',
    keyframe_asset: { source_job: 'kf-obj', name: 'pick.png' }
  },
  // #159: final images are published to NAS; `a.png` also still reports an
  // artifact, `b.webp` is unpublished and only exists as a studio artifact.
  'nas-1': {
    state: 'succeeded',
    updated_at: '2026-11-13T00:00:08.000Z',
    image: { mode: 't2i', prompt: 'NAS 最终图', width: 1024, height: 1024, seed: 9, steps: 24, denoise: 1 },
    artifacts: { 0: '/studio/jobs/nas-1/output/a.png', 1: '/studio/jobs/nas-1/output/b.webp' },
    cover_asset: '/studio/jobs/nas-1/output/a.png'
  }
}

before(async () => {
  // Only image jobs are meta-backed; aigc-1 has no web meta on purpose.
  jobMetas['img-1'] = {
    id: 'img-1',
    type: 'image',
    rail: 'B',
    brief_id: null,
    model: null,
    input: null,
    created_at: '2026-11-13T00:00:00.000Z',
    image: DETAILS['img-1'].image
  }
  jobMetas['img-outside'] = {
    id: 'img-outside',
    type: 'image',
    rail: 'B',
    brief_id: null,
    model: null,
    input: null,
    created_at: '2026-11-13T00:00:02.000Z',
    image: { mode: 't2i', prompt: 'x' }
  }
  // #159 NAS media fixtures: `nas-1` is in the intake window, `nas-only` is
  // older and only reachable through its published media + web meta, and
  // `nas-nometa` must never be invented into the gallery.
  jobMetas['nas-1'] = {
    id: 'nas-1',
    type: 'image',
    rail: 'B',
    brief_id: null,
    model: null,
    input: null,
    created_at: '2026-11-13T00:00:03.000Z',
    image: DETAILS['nas-1'].image
  }
  jobMetas['nas-only'] = {
    id: 'nas-only',
    type: 'image',
    rail: 'B',
    brief_id: null,
    model: null,
    input: null,
    created_at: '2026-11-12T00:00:00.000Z',
    image: { mode: 't2i', prompt: '已发布旧图' }
  }
  const mediaRoot = path.join(dataRoot, 'media', 'jobs')
  fs.rmSync(path.join(dataRoot, 'media'), { recursive: true, force: true })
  const mediaFixtures: Record<string, string[]> = {
    'nas-1': ['a.png', 'c.png'],
    'nas-only': ['final.png'],
    'nas-nometa': ['orphan.png']
  }
  for (const [job, names] of Object.entries(mediaFixtures)) {
    fs.mkdirSync(path.join(mediaRoot, job), { recursive: true })
    for (const [index, name] of names.entries()) {
      const file = path.join(mediaRoot, job, name)
      fs.writeFileSync(file, `png-${job}-${name}`)
      const stamp = new Date(Date.parse('2026-11-13T00:00:00.000Z') + index * 1000)
      fs.utimesSync(file, stamp, stamp)
    }
  }

  // #86d: a ready upload used by the B-track (optimize) create path. The web
  // server stats `uploads/<id>/source<ext>` for real, so the byte file must exist.
  const uploadId = 'up-opt-b'
  uploadSources[uploadId] = Buffer.from('fake-mp4-bytes')
  uploadMetas[uploadId] = {
    upload_id: uploadId,
    status: 'ready',
    filename: 'b-track.mp4',
    ext: '.mp4',
    sha256: 'a'.repeat(64),
    size: uploadSources[uploadId].length
  }
  const uploadDir = path.join(dataRoot, 'uploads', uploadId)
  fs.mkdirSync(uploadDir, { recursive: true })
  fs.writeFileSync(path.join(uploadDir, 'source.mp4'), uploadSources[uploadId])

  upstream = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    let body: any = null
    if (req.method === 'POST') body = await readBody(req).catch(() => null)
    hits.push({ method: req.method ?? 'GET', url: url.pathname + url.search, body })

    if (url.pathname === '/intake/uploads' && req.method === 'POST') {
      const sha = String(req.headers['x-sha256'] ?? '')
      const uploadId = String(req.headers['x-upload-id'] ?? '')
      const size = uploadSources[uploadId]?.length ?? 0
      sendJson(res, 200, { path: `/studio/jobs/${uploadId}/source.mp4`, size, sha256: sha })
      return
    }
    if (url.pathname === '/intake/jobs' && req.method === 'POST') {
      sendJson(res, 201, { id: 'created' })
      return
    }
    if (url.pathname === '/intake/jobs' && req.method === 'GET') {
      sendJson(res, 200, {
        items: [{ id: 'img-1' }, { id: 'aigc-1' }, { id: 'img-outside' }, { id: 'nas-1' }]
      })
      return
    }
    if (url.pathname === '/intake/jobs/j-err/cover') {
      sendJson(res, 409, { error: 'cover_source_missing', reason: 'no such artifact' })
      return
    }
    const detail = url.pathname.match(/^\/intake\/jobs\/([^/]+)$/)
    if (detail) {
      const body = DETAILS[decodeURIComponent(detail[1])]
      if (!body) {
        sendJson(res, 404, { error: 'job not found' })
        return
      }
      sendJson(res, 200, body)
      return
    }
    const cover = url.pathname.match(/^\/intake\/jobs\/([^/]+)\/cover$/)
    if (cover) {
      sendJson(res, 200, { cover_asset: `/studio/jobs/${cover[1]}/output/pick.png` })
      return
    }
    sendJson(res, 404, { error: 'not found' })
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const uaddr = upstream.address()
  if (!uaddr || typeof uaddr === 'string') throw new Error('upstream did not bind')
  intakeUrl = `http://127.0.0.1:${uaddr.port}`
  ;(ctx as { intakeUrl: string }).intakeUrl = intakeUrl

  web = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const handled = await handleStudioRoute(req, res, url, url.pathname, ctx)
    if (!handled) {
      res.statusCode = 404
      res.end()
    }
  })
  await new Promise<void>((resolve) => web.listen(0, '127.0.0.1', resolve))
  const waddr = web.address()
  if (!waddr || typeof waddr === 'string') throw new Error('web did not bind')
  base = `http://127.0.0.1:${waddr.port}`
})

after(async () => {
  await new Promise<void>((resolve) => web.close(() => resolve()))
  await new Promise<void>((resolve) => upstream.close(() => resolve()))
})

const T2I = {
  mode: 't2i',
  prompt: '海边的猫',
  width: 1024,
  height: 1024,
  seed: 42,
  steps: 24,
  denoise: 1
}

// ---------------------------------------------------------------------------
// validateImageRequest — mirrors intake `_validate_image`
// ---------------------------------------------------------------------------

test('t2i accepts denoise=1.0 and normalises an omitted negative prompt', () => {
  const checked = validateImageRequest(T2I)
  assert.equal(checked.ok, true)
  if (!checked.ok) return
  assert.equal(checked.image.mode, 't2i')
  assert.equal(checked.image.denoise, 1)
  assert.equal(checked.image.negative, '')
  assert.equal(checked.image.prompt, '海边的猫')
})

test('t2i rejects denoise != 1.0', () => {
  const checked = validateImageRequest({ ...T2I, denoise: 0.6 })
  assert.equal(checked.ok, false)
  if (checked.ok) return
  assert.equal(checked.status, 400)
  assert.match(checked.error, /mode=t2i 必须为 1\.0/)
})

test('edit accepts denoise < 1.0 (only the reference is validated later)', () => {
  const checked = validateImageRequest({ ...T2I, mode: 'edit', denoise: 0.55 })
  assert.equal(checked.ok, true)
})

test('prompt is mandatory', () => {
  for (const prompt of [undefined, '', '   ']) {
    const checked = validateImageRequest({ ...T2I, prompt })
    assert.equal(checked.ok, false, String(prompt))
    if (checked.ok) continue
    assert.equal(checked.status, 400)
    assert.match(checked.error, /image\.prompt/)
  }
})

test('size whitelist rejects anything but 1536x864 / 864x1536 / 1024x1024', () => {
  for (const [width, height] of [[1024, 1024], [1536, 864], [864, 1536]]) {
    assert.equal(validateImageRequest({ ...T2I, width, height }).ok, true, `${width}x${height}`)
  }
  for (const [width, height] of [[1024, 768], [2048, 2048], [0, 0]]) {
    const checked = validateImageRequest({ ...T2I, width, height })
    assert.equal(checked.ok, false, `${width}x${height}`)
    if (checked.ok) continue
    assert.equal(checked.status, 400)
    assert.match(checked.error, /image\.size/)
  }
})

test('seed must be an integer in 0..4294967295', () => {
  assert.equal(validateImageRequest({ ...T2I, seed: 0 }).ok, true)
  assert.equal(validateImageRequest({ ...T2I, seed: 4294967295 }).ok, true)
  for (const seed of [-1, 4294967296, 1.5, '42']) {
    const checked = validateImageRequest({ ...T2I, seed })
    assert.equal(checked.ok, false, String(seed))
    if (checked.ok) continue
    assert.equal(checked.status, 400)
    assert.match(checked.error, /image\.seed/)
  }
})

// ---------------------------------------------------------------------------
// create job routes
// ---------------------------------------------------------------------------

test('edit without a reference image is rejected with 400', async () => {
  const before = hits.length
  const r = await fetch(`${base}/api/studio/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'image', image: { ...T2I, mode: 'edit', denoise: 0.5 } })
  })
  assert.equal(r.status, 400)
  const body = (await r.json()) as { error: string }
  assert.match(body.error, /image\.source_upload_id 或 image\.source_image 必填/)
  assert.equal(hits.length, before, 'intake must not be called')
})

test('image job payload carries the image object and no video input', async () => {
  const r = await fetch(`${base}/api/studio/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'image', image: T2I })
  })
  assert.equal(r.status, 201)
  const hit = hits.filter((h) => h.method === 'POST' && h.url === '/intake/jobs').at(-1)
  assert.equal(hit?.body.type, 'image')
  assert.equal(hit?.body.image.prompt, '海边的猫')
  assert.equal(hit?.body.input, undefined)
  // #86d: image jobs stay out of the video rail contract.
  assert.equal(hit?.body.rail, undefined)
})

// #86d / 86c F-01+F-02: video jobs must forward `type` + `rail`; without them
// intake falls back to `aigc` / rail A and B-track optimize jobs run A-track i2v.
test('aigc job forwards type=aigc and rail=A when rail is omitted', async () => {
  const r = await fetch(`${base}/api/studio/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'aigc', input: '/studio/jobs/j1/output/source.mp4' })
  })
  assert.equal(r.status, 201)
  const hit = hits.filter((h) => h.method === 'POST' && h.url === '/intake/jobs').at(-1)
  assert.equal(hit?.body.type, 'aigc')
  assert.equal(hit?.body.rail, 'A')
  assert.equal(hit?.body.input, '/studio/jobs/j1/output/source.mp4')
})

test('optimize rail=B job forwards type and rail to intake', async () => {
  const r = await fetch(`${base}/api/studio/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'optimize',
      rail: 'B',
      input: '/studio/jobs/j1/output/source.mp4'
    })
  })
  assert.equal(r.status, 201)
  const hit = hits.filter((h) => h.method === 'POST' && h.url === '/intake/jobs').at(-1)
  assert.equal(hit?.body.type, 'optimize')
  assert.equal(hit?.body.rail, 'B')
  assert.equal(hit?.body.input, '/studio/jobs/j1/output/source.mp4')
})

test('B-track upload job forwards type/rail and the forwarded studio path', async () => {
  const r = await fetch(`${base}/api/studio/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'optimize', rail: 'B', upload_id: 'up-opt-b' })
  })
  assert.equal(r.status, 201)
  const uploaded = hits.filter((h) => h.method === 'POST' && h.url === '/intake/uploads')
  assert.equal(uploaded.length, 1)
  const hit = hits.filter((h) => h.method === 'POST' && h.url === '/intake/jobs').at(-1)
  assert.equal(hit?.body.type, 'optimize')
  assert.equal(hit?.body.rail, 'B')
  assert.equal(hit?.body.input, '/studio/jobs/up-opt-b/source.mp4')
  assert.equal(hit?.body.upload_id, undefined)
})

test('aigc job forwards keyframe_asset as {source_job, name}', async () => {
  const r = await fetch(`${base}/api/studio/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'aigc',
      input: '/studio/jobs/j1/output/source.mp4',
      keyframe_asset: { source_job: 'j1', name: 'pick.png' }
    })
  })
  assert.equal(r.status, 201)
  const hit = hits.filter((h) => h.method === 'POST' && h.url === '/intake/jobs').at(-1)
  assert.deepEqual(hit?.body.keyframe_asset, { source_job: 'j1', name: 'pick.png' })
  assert.equal(hit?.body.input, '/studio/jobs/j1/output/source.mp4')
})

// #150: A 轨仅关键帧 —— 无 input/upload 时允许提交，intake 先用 wan_i2v 生成基础镜头。
test('#150 A 轨无素材但带关键帧 → 201，转发不带 input，保留 keyframe_asset', async () => {
  const r = await fetch(`${base}/api/studio/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'aigc',
      rail: 'A',
      keyframe_asset: { source_job: 'web-20261114032741-43d3b9', name: 'image-01.png' }
    })
  })
  assert.equal(r.status, 201)
  const hit = hits.filter((h) => h.method === 'POST' && h.url === '/intake/jobs').at(-1)
  assert.equal(hit?.body.type, 'aigc')
  assert.equal(hit?.body.rail, 'A')
  assert.equal('input' in (hit?.body ?? {}), false, '关键帧任务不转发 input')
  assert.equal('upload_id' in (hit?.body ?? {}), false)
  assert.deepEqual(hit?.body.keyframe_asset, {
    source_job: 'web-20261114032741-43d3b9',
    name: 'image-01.png'
  })
})

test('#150 无 input 且无 keyframe → 400（intake 不被调用）', async () => {
  const before = hits.length
  const r = await fetch(`${base}/api/studio/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'aigc', rail: 'A' })
  })
  assert.equal(r.status, 400)
  const body = (await r.json()) as { error: string }
  assert.match(body.error, /input 或 upload_id 必填/)
  assert.equal(hits.length, before)
})

test('#150 B 轨即使带关键帧也不能省略 input → 400', async () => {
  const before = hits.length
  for (const body of [
    { type: 'optimize', rail: 'B' },
    { type: 'aigc', rail: 'B', keyframe_asset: { source_job: 'j1', name: 'pick.png' } }
  ]) {
    const r = await fetch(`${base}/api/studio/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    assert.equal(r.status, 400, JSON.stringify(body))
  }
  assert.equal(hits.length, before)
})

test('keyframe_asset with a path is rejected with 400', async () => {
  const before = hits.length
  for (const name of ['/abs/pick.png', '..%2Fpick.png', 'pick.txt']) {
    const r = await fetch(`${base}/api/studio/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'aigc',
        input: '/studio/jobs/j1/output/source.mp4',
        keyframe_asset: { source_job: 'j1', name }
      })
    })
    assert.equal(r.status, 400, name)
  }
  assert.equal(hits.length, before, 'intake must not be called')
})

// ---------------------------------------------------------------------------
// keyframe read-back (#89d)
// ---------------------------------------------------------------------------

test('job detail reads keyframe_asset back as a non-empty {source_job, name}', async () => {
  const cases: Array<[string, { source_job: string; name: string }]> = [
    ['kf-path', { source_job: 'kf-job', name: 'pick.png' }],
    ['kf-outside', { source_job: '', name: 'leak.png' }],
    ['kf-object', { source_job: 'kf-obj', name: 'pick.png' }]
  ]
  for (const [id, expected] of cases) {
    const r = await fetch(`${base}/api/studio/jobs/${id}`)
    assert.equal(r.status, 200, id)
    const body = (await r.json()) as any
    assert.deepEqual(body.keyframe_asset, expected, id)
    const serialised = JSON.stringify(body.keyframe_asset)
    assert.equal(serialised.includes('/studio/jobs'), false, `${id}: no absolute path`)
    assert.equal(serialised.includes('/data/private'), false, `${id}: no absolute path`)
  }
})

test('job detail keeps keyframe_asset null when the job has none', async () => {
  const r = await fetch(`${base}/api/studio/jobs/aigc-1`)
  assert.equal(r.status, 200)
  const body = (await r.json()) as any
  assert.equal(body.keyframe_asset, null)
})

// ---------------------------------------------------------------------------
// gallery
// ---------------------------------------------------------------------------

test('gallery lists only image jobs with artifact proxies as the fallback', async () => {
  const r = await fetch(`${base}/api/studio/gallery`)
  assert.equal(r.status, 200)
  const text = await r.text()
  // Never leak the studio filesystem, even though intake reports absolute paths.
  assert.equal(text.includes('"/studio/jobs'), false)
  assert.equal(text.includes(dataRoot), false)
  const body = JSON.parse(text) as { items: any[]; count: number; source: string }
  assert.equal(body.count, 4)
  assert.deepEqual(body.items.map((item) => item.id).sort(), [
    'img-1',
    'img-outside',
    'nas-1',
    'nas-only'
  ])

  const item = body.items.find((it) => it.id === 'img-1')
  assert.equal(item.status, 'succeeded')
  assert.equal(item.mode, 't2i')
  assert.equal(item.prompt, '海边的猫')
  assert.equal(item.seed, 7)
  assert.equal(item.elapsed_s, 12.5)
  assert.deepEqual(item.images, [
    { name: 'a.png', url: '/api/studio/jobs/img-1/artifacts/a.png' },
    { name: 'b.webp', url: '/api/studio/jobs/img-1/artifacts/b.webp' }
  ])
  assert.equal(item.cover_url, '/api/studio/jobs/img-1/artifacts/a.png')

  // A cover path outside jobs/<job>/output cannot be turned into a proxy URL.
  const outside = body.items.find((it) => it.id === 'img-outside')
  assert.equal(outside.cover_url, null)
})

// #159: NAS media mapping, NAS-over-artifact priority + dedupe, cover fallback.
test('gallery prefers published NAS media and dedupes same-name artifacts', async () => {
  const r = await fetch(`${base}/api/studio/gallery?job=nas-1`)
  assert.equal(r.status, 200)
  const body = (await r.json()) as { items: any[]; count: number }
  assert.equal(body.count, 1)
  const item = body.items[0]
  assert.equal(item.id, 'nas-1')
  assert.deepEqual(item.images, [
    { name: 'c.png', url: '/api/media/jobs/nas-1/c.png' },
    { name: 'a.png', url: '/api/media/jobs/nas-1/a.png' },
    { name: 'b.webp', url: '/api/studio/jobs/nas-1/artifacts/b.webp' }
  ])
  // The explicit cover resolves to the NAS copy of the same file.
  assert.equal(item.cover_url, '/api/media/jobs/nas-1/a.png')
})

test('gallery keeps NAS-only jobs with meta and never invents meta-less media', async () => {
  const r = await fetch(`${base}/api/studio/gallery`)
  const body = (await r.json()) as { items: any[] }
  const nasOnly = body.items.find((item) => item.id === 'nas-only')
  assert.ok(nasOnly)
  assert.equal(nasOnly.status, 'succeeded')
  assert.deepEqual(nasOnly.images, [
    { name: 'final.png', url: '/api/media/jobs/nas-only/final.png' }
  ])
  assert.equal(nasOnly.cover_url, '/api/media/jobs/nas-only/final.png')
  // `nas-nometa` has media but no `studio/jobs/<id>.json` → skipped.
  assert.equal(body.items.some((item) => item.id === 'nas-nometa'), false)
})

test('gallery job filter still narrows NAS-backed results', async () => {
  const meta = await fetch(`${base}/api/studio/gallery?job=nas-nometa`)
  assert.equal(meta.status, 200)
  assert.deepEqual(await meta.json(), { items: [], count: 0, source: 'studio' })
  const only = await fetch(`${base}/api/studio/gallery?job=nas-only`)
  const body = (await only.json()) as { items: any[]; count: number }
  assert.equal(body.count, 1)
  assert.equal(body.items[0].id, 'nas-only')
})

test('gallery rejects an illegal job filter with 400', async () => {
  const r = await fetch(`${base}/api/studio/gallery?job=${encodeURIComponent('../etc')}`)
  assert.equal(r.status, 400)
})

// ---------------------------------------------------------------------------
// cover proxy
// ---------------------------------------------------------------------------

test('cover accepts {source_job, name} and returns the sanitized proxy URL', async () => {
  const r = await fetch(`${base}/api/studio/jobs/j1/cover`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_job: 'img-1', name: 'a.png' })
  })
  assert.equal(r.status, 200)
  const body = (await r.json()) as {
    ok: boolean
    job: string
    cover_asset: { source_job: string; name: string; url: string | null }
    cover_url: string
  }
  assert.equal(body.ok, true)
  assert.equal(body.job, 'j1')
  assert.deepEqual(body.cover_asset, {
    source_job: 'j1',
    name: 'pick.png',
    url: '/api/studio/jobs/j1/artifacts/pick.png'
  })
  assert.equal(body.cover_url, '/api/studio/jobs/j1/artifacts/pick.png')
  // The browser body is forwarded verbatim; the web token is injected server-side.
  const coverHit = hits.find((hit) => hit.url === '/intake/jobs/j1/cover')
  assert.deepEqual(coverHit?.body, { source_job: 'img-1', name: 'a.png' })
})

test('cover rejects absolute paths, traversal and non-image names before calling intake', async () => {
  const before = hits.length
  const cases = [
    { source_job: 'img-1', name: 'a.png', path: '/data/private/a.png' },
    { source_job: 'img-1', name: 'a.png', source_image: '/data/private/a.png' },
    { source_job: 'img-1', name: '/data/private/a.png' },
    { source_job: 'img-1', name: '../a.png' },
    { source_job: 'img-1', name: 'a.txt' },
    { source_job: '../j1', name: 'a.png' }
  ]
  for (const payload of cases) {
    const r = await fetch(`${base}/api/studio/jobs/j1/cover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    assert.equal(r.status, 400, JSON.stringify(payload))
  }
  assert.equal(hits.length, before, 'intake must not be called')
})

test('cover passes an upstream 4xx through', async () => {
  const r = await fetch(`${base}/api/studio/jobs/j-err/cover`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_job: 'img-1', name: 'a.png' })
  })
  assert.equal(r.status, 409)
  const body = (await r.json()) as { error: string; reason?: string }
  assert.equal(body.error, 'cover_source_missing')
  assert.equal(body.reason, 'no such artifact')
})
