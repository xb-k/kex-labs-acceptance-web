/**
 * #165 keyframe upload → A 轨 keyframe-only 视频。
 *
 * 浏览器只提交 `{upload_id}`；web server 在把请求转给 intake 前解析成
 * `{path}`，并校验 upload 状态 / 15MB / 图片类型 / studio 路径穿越。
 * intake 是本地 HTTP stub，不真发任务。
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleStudioRoute } from './studio'
import type { StudioContext } from './studio'

const TOKEN = 'kf-upload-test-token'
const dataRoot = path.join(os.tmpdir(), 'studio-kf-upload165-data')
const MAX_BYTES = 15 * 1024 * 1024

let upstream: http.Server
let web: http.Server
let base = ''
const hits: Array<{ method: string; url: string; body: any }> = []
const uploadMetas: Record<string, any> = {}
/** #165: per-job intake state so retry can see failed/canceled. */
const jobStates: Record<string, string> = {}

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
  isSameOrigin: () => true,
  sendJson,
  readJson: (file: string) => {
    const upload = file.match(/\/uploads\/([^/]+)\/meta\.json$/)
    if (upload) return uploadMetas[upload[1]] ?? null
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return null
    }
  },
  atomicWriteJson: (file: string, value: unknown) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(value))
  },
  readBody
}

function jobMetaFile(id: string) {
  return path.join(dataRoot, 'studio', 'jobs', `${id}.json`)
}

function writeJobMetaRaw(id: string, meta: Record<string, unknown>) {
  fs.mkdirSync(path.dirname(jobMetaFile(id)), { recursive: true })
  fs.writeFileSync(jobMetaFile(id), JSON.stringify(meta))
}

function writeUpload(id: string, name: string, ext: string, studioPath: string | null, size: number) {
  uploadMetas[id] = {
    upload_id: id,
    status: 'ready',
    filename: name,
    ext,
    sha256: 'a'.repeat(64),
    size,
    ...(studioPath ? { studio_path: studioPath } : {})
  }
  const dir = path.join(dataRoot, 'uploads', id)
  fs.mkdirSync(dir, { recursive: true })
  const source = path.join(dir, `source${ext}`)
  fs.writeFileSync(source, 'pose-bytes')
  fs.truncateSync(source, size)
}

function poseVideoBody(uploadId: string) {
  return {
    type: 'aigc',
    rail: 'A',
    mode: 'keyframe_only',
    keyframe_asset: { upload_id: uploadId },
    prompt: '参考姿态「单人侧身站立」生成一个连贯镜头，保持人物动作与构图'
  }
}

async function postJob(body: unknown) {
  return fetch(`${base}/api/studio/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
}

function intakeJobPosts() {
  return hits.filter((hit) => hit.method === 'POST' && hit.url === '/intake/jobs')
}

before(async () => {
  fs.rmSync(dataRoot, { recursive: true, force: true })
  writeUpload(
    'up-pose-ok01',
    'pose-standing.png',
    '.png',
    '/studio/uploads/up-pose-ok01/pose-standing.png',
    2048
  )
  writeUpload('up-pose-big1', 'pose-big.png', '.png', '/studio/uploads/up-pose-big1/pose-big.png', MAX_BYTES + 1)
  writeUpload(
    'up-pose-trav1',
    'pose-traversal.png',
    '.png',
    '/studio/uploads/../private/pose.png',
    2048
  )
  writeUpload('up-pose-gif1', 'pose.gif', '.gif', '/studio/uploads/up-pose-gif1/pose.gif', 2048)

  upstream = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    let body: any = null
    if (req.method === 'POST') body = await readBody(req).catch(() => null)
    hits.push({ method: req.method ?? 'GET', url: url.pathname + url.search, body })

    if (url.pathname === '/intake/jobs' && req.method === 'POST') {
      sendJson(res, 201, { id: 'pose-video-1' })
      return
    }
    if (/^\/intake\/jobs\/[^/]+$/.test(url.pathname) && req.method === 'GET') {
      const id = url.pathname.split('/').pop() ?? ''
      sendJson(res, 200, {
        state: jobStates[id] ?? 'queued',
        updated_at: '2026-11-14T00:00:00.000Z'
      })
      return
    }
    sendJson(res, 404, { error: 'not found' })
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const uaddr = upstream.address()
  if (!uaddr || typeof uaddr === 'string') throw new Error('upstream did not bind')
  ;(ctx as { intakeUrl: string }).intakeUrl = `http://127.0.0.1:${uaddr.port}`

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

test('#165 upload_id → studio_path：intake 收到 {path}，mode/prompt 透传且无 input', async () => {
  const r = await postJob(poseVideoBody('up-pose-ok01'))
  assert.equal(r.status, 201)
  assert.equal(intakeJobPosts().length, 1)
  assert.equal(
    hits.some((hit) => hit.url === '/intake/uploads'),
    false,
    '已有 studio_path 时不再重新上传'
  )
  const hit = intakeJobPosts()[0]
  assert.deepEqual(hit.body, {
    type: 'aigc',
    rail: 'A',
    keyframe_asset: { path: '/studio/uploads/up-pose-ok01/pose-standing.png' },
    mode: 'keyframe_only',
    prompt: '参考姿态「单人侧身站立」生成一个连贯镜头，保持人物动作与构图'
  })
  assert.equal('input' in hit.body, false)
})

test('#165 upload 不存在 → 404，且不调用 intake', async () => {
  const before = intakeJobPosts().length
  const r = await postJob(poseVideoBody('up-pose-none1'))
  assert.equal(r.status, 404)
  const body = (await r.json()) as { error: string }
  assert.equal(body.error, 'upload not found')
  assert.equal(intakeJobPosts().length, before)
})

test('#165 图片超过 15MB → 400，且不调用 intake', async () => {
  const before = intakeJobPosts().length
  const r = await postJob(poseVideoBody('up-pose-big1'))
  assert.equal(r.status, 400)
  const body = (await r.json()) as { error: string }
  assert.match(body.error, /15MB/)
  assert.equal(intakeJobPosts().length, before)
})

test('#165 studio_path 穿越 → 400，且不调用 intake', async () => {
  const before = intakeJobPosts().length
  const r = await postJob(poseVideoBody('up-pose-trav1'))
  assert.equal(r.status, 400)
  const body = (await r.json()) as { error: string }
  assert.match(body.error, /studio 路径非法/)
  assert.equal(intakeJobPosts().length, before)
})

test('#165 非图片 upload → 400，且不调用 intake', async () => {
  const before = intakeJobPosts().length
  const r = await postJob(poseVideoBody('up-pose-gif1'))
  assert.equal(r.status, 400)
  const body = (await r.json()) as { error: string }
  assert.match(body.error, /png \/ jpg \/ jpeg \/ webp/)
  assert.equal(intakeJobPosts().length, before)
})

test('#165 keyframe-only 任务的 prompt/mode 落盘，重试 payload 仍带', async () => {
  const body = poseVideoBody('up-pose-ok01')
  const created = await postJob(body)
  assert.equal(created.status, 201)

  const meta = JSON.parse(fs.readFileSync(jobMetaFile('pose-video-1'), 'utf8'))
  assert.equal(meta.prompt, body.prompt)
  assert.equal(meta.mode, 'keyframe_only')
  assert.deepEqual(meta.keyframe_asset, { upload_id: 'up-pose-ok01' })
  assert.equal(meta.input, null)

  jobStates['pose-video-1'] = 'failed'
  const before = intakeJobPosts().length
  const retry = await fetch(`${base}/api/studio/jobs/pose-video-1/retry`, { method: 'POST' })
  assert.equal(retry.status, 201)
  assert.equal(intakeJobPosts().length, before + 1)

  const payload = intakeJobPosts().at(-1)?.body
  assert.equal(payload.mode, 'keyframe_only')
  assert.equal(payload.prompt, body.prompt)
  assert.deepEqual(payload.keyframe_asset, {
    path: '/studio/uploads/up-pose-ok01/pose-standing.png'
  })
  assert.equal('input' in payload, false)
})

test('#165 旧 meta 无 prompt/mode：重试回退原逻辑，不带这两个字段', async () => {
  writeJobMetaRaw('legacy-job-1', {
    id: 'legacy-job-1',
    type: 'aigc',
    rail: 'A',
    brief_id: null,
    model: null,
    input: '/studio/inputs/legacy.mp4',
    created_at: '2026-11-13T00:00:00.000Z'
  })
  jobStates['legacy-job-1'] = 'failed'
  const before = intakeJobPosts().length
  const retry = await fetch(`${base}/api/studio/jobs/legacy-job-1/retry`, { method: 'POST' })
  assert.equal(retry.status, 201)
  assert.equal(intakeJobPosts().length, before + 1)

  const payload = intakeJobPosts().at(-1)?.body
  assert.equal(payload.input, '/studio/inputs/legacy.mp4')
  assert.equal('prompt' in payload, false)
  assert.equal('mode' in payload, false)
})
