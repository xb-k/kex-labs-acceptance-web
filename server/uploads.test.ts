/**
 * #86 C4 contract tests: complete persists `studio_path`, probe proxy + errors.
 *
 * Every case goes through the real `handleUploadsRoute` over HTTP. The studio
 * intake is replaced by a local HTTP stub — the route, staging and persistence
 * code under test is the production path.
 *
 * Run (see evidence `tests.txt`):
 *   npx esbuild server/uploads.test.ts --bundle --platform=node --format=esm \
 *     --outfile=/tmp/uploads086/uploads.test.mjs
 *   node --test /tmp/uploads086/uploads.test.mjs
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleUploadsRoute } from './uploads'
import type { UploadsContext } from './uploads'

const TOKEN = 'uploads086-test-token'
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uploads086-'))

// --- the same four context helpers api.ts passes to handleUploadsRoute ------

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

function readJson(file: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function atomicWriteJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, file)
}

function readRequestBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      data += chunk
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(data))
      } catch {
        reject(new Error('invalid JSON'))
      }
    })
    req.on('error', reject)
  })
}

function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

// --- tiny HTTP harness ------------------------------------------------------

type Listener = { url: string; close: () => Promise<void> }

async function listen(handler: http.RequestListener): Promise<Listener> {
  const server = http.createServer(handler)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

function uploadsCtx(intakeUrl: string): UploadsContext {
  return {
    dataRoot,
    intakeUrl,
    intakeTimeoutMs: 2000,
    webToken: TOKEN,
    isSameOrigin: () => false,
    sendJson,
    readJson,
    atomicWriteJson,
    readBody: readRequestBody,
    maxBytes: 1024 * 1024
  }
}

async function listenWeb(ctx: UploadsContext): Promise<Listener> {
  return listen(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const handled = await handleUploadsRoute(
      req,
      res,
      url,
      decodeURIComponent(url.pathname),
      ctx
    )
    if (!handled) sendJson(res, 404, { error: 'not found' })
  })
}

// --- studio intake stub -----------------------------------------------------

const PROBE_OK = {
  ok: true,
  probe: { width: 1920, height: 1080, fps: 59.94, duration_s: 35.008, has_audio: true },
  shots: { count: 3, cuts: [0, 10.5, 22.2], backend: 'ffmpeg-scene-detect' },
  shots_reason: null,
  plan: { steps: [{ code: 'interpolate', reason: 'fps<60' }], risks: [] }
}

type IntakeStub = Listener & {
  uploadCalls: () => number
  probeCalls: () => Array<{ token: string | undefined; body: any; path: string }>
  setProbeMode: (mode: 'ok' | 'source_missing') => void
}

async function startIntake(): Promise<IntakeStub> {
  let uploads = 0
  const probes: Array<{ token: string | undefined; body: any; path: string }> = []
  let probeMode: 'ok' | 'source_missing' = 'ok'
  const listener = await listen(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (req.method === 'POST' && url.pathname === '/intake/uploads') {
      uploads += 1
      const body = await readRawBody(req)
      const id = String(req.headers['x-upload-id'] ?? '')
      const filename = String(req.headers['x-filename'] ?? 'source.mov')
      const ext = path.extname(filename)
      const digest = crypto.createHash('sha256').update(body).digest('hex')
      sendJson(res, 201, {
        upload_id: id,
        path: `/studio/uploads/${id}/source${ext}`,
        size: body.length,
        sha256: digest
      })
      return
    }
    if (req.method === 'POST' && url.pathname === '/intake/probe') {
      const body = await readRequestBody(req).catch(() => null)
      probes.push({
        token: req.headers['x-web-token'] as string | undefined,
        body,
        path: String(body?.path ?? '')
      })
      if (probeMode === 'source_missing') {
        sendJson(res, 404, { error: 'source not found', reason: 'source_missing' })
        return
      }
      sendJson(res, 200, { ...PROBE_OK, path: String(body?.path ?? '') })
      return
    }
    sendJson(res, 404, { error: 'not found' })
  })
  return {
    ...listener,
    uploadCalls: () => uploads,
    probeCalls: () => probes,
    setProbeMode: (mode) => {
      probeMode = mode
    }
  }
}

// --- request helpers --------------------------------------------------------

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { 'X-Web-Token': TOKEN, ...extra }
}

async function createUpload(
  web: Listener,
  filename = 'clip.mov',
  content = Buffer.from('not-a-real-video-but-stable-bytes')
) {
  const sha256 = crypto.createHash('sha256').update(content).digest('hex')
  const init = await fetch(`${web.url}/api/uploads/init`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ filename, size: content.length, sha256 })
  })
  assert.equal(init.status, 201)
  const initBody = (await init.json()) as any
  const put = await fetch(`${web.url}/api/uploads/${initBody.upload_id}/chunks/0`, {
    method: 'PUT',
    headers: authHeaders({ 'Content-Type': 'application/octet-stream' }),
    body: content
  })
  assert.equal(put.status, 201)
  return { id: initBody.upload_id as string, sha256 }
}

async function completeUpload(web: Listener, id: string) {
  const res = await fetch(`${web.url}/api/uploads/${id}/complete`, {
    method: 'POST',
    headers: authHeaders()
  })
  return { status: res.status, body: (await res.json()) as any }
}

// --- fixture ----------------------------------------------------------------

let intake: IntakeStub
let web: Listener

before(async () => {
  intake = await startIntake()
  web = await listenWeb(uploadsCtx(intake.url))
})

after(async () => {
  await web.close()
  await intake.close()
  fs.rmSync(dataRoot, { recursive: true, force: true })
})

// --- cases ------------------------------------------------------------------

test('C4-1 complete persists the studio_path and GET returns it', async () => {
  const { id } = await createUpload(web)
  const completed = await completeUpload(web, id)

  assert.equal(completed.status, 200)
  assert.equal(completed.body.studio_path, `/studio/uploads/${id}/source.mov`)
  assert.equal(completed.body.path, path.join(dataRoot, 'uploads', id, 'source.mov'))

  const meta = readJson(path.join(dataRoot, 'uploads', id, 'meta.json'))
  assert.equal(meta.studio_path, completed.body.studio_path)

  const got = await fetch(`${web.url}/api/uploads/${id}`, { headers: authHeaders() })
  assert.equal(got.status, 200)
  assert.equal(((await got.json()) as any).studio_path, completed.body.studio_path)

  // Idempotent: a retried complete reuses the persisted path, no second stream.
  const again = await completeUpload(web, id)
  assert.equal(again.status, 200)
  assert.equal(again.body.studio_path, completed.body.studio_path)
  assert.equal(intake.uploadCalls(), 1)
})

test('C4-2 probe success returns the same structure and persists it', async () => {
  const { id } = await createUpload(web)
  const completed = await completeUpload(web, id)

  const res = await fetch(`${web.url}/api/uploads/${id}/probe`, {
    method: 'POST',
    headers: authHeaders()
  })
  assert.equal(res.status, 200)
  const body = (await res.json()) as any
  assert.equal(body.ok, true)
  assert.equal(body.path, completed.body.studio_path)
  assert.deepEqual(body.probe, PROBE_OK.probe)
  assert.deepEqual(body.shots, PROBE_OK.shots)
  assert.deepEqual(body.plan, PROBE_OK.plan)

  const call = intake.probeCalls().at(-1)
  assert.deepEqual(call?.body, { path: completed.body.studio_path })
  assert.equal(call?.token, TOKEN)

  const meta = readJson(path.join(dataRoot, 'uploads', id, 'meta.json'))
  assert.equal(meta.studio_path, completed.body.studio_path)
  assert.deepEqual(meta.probe.probe, PROBE_OK.probe)
  assert.deepEqual(meta.probe.shots, PROBE_OK.shots)
  assert.deepEqual(meta.probe.plan, PROBE_OK.plan)
  assert.equal(typeof meta.probe.probed_at, 'string')
})

test('C4-3 studio 404 source_missing is passed through and nothing is persisted', async () => {
  const { id } = await createUpload(web)
  await completeUpload(web, id)
  intake.setProbeMode('source_missing')
  try {
    const res = await fetch(`${web.url}/api/uploads/${id}/probe`, {
      method: 'POST',
      headers: authHeaders()
    })
    assert.equal(res.status, 404)
    assert.deepEqual(await res.json(), { error: 'source not found', reason: 'source_missing' })

    const meta = readJson(path.join(dataRoot, 'uploads', id, 'meta.json'))
    assert.equal(meta.probe, undefined)
  } finally {
    intake.setProbeMode('ok')
  }
})

test('C4-4 studio unreachable surfaces as 502 studio_unreachable', async () => {
  const { id } = await createUpload(web)
  await completeUpload(web, id)

  // Same persisted upload, but the studio endpoint is a closed port.
  const offline = await listenWeb(uploadsCtx('http://127.0.0.1:1'))
  try {
    const res = await fetch(`${offline.url}/api/uploads/${id}/probe`, {
      method: 'POST',
      headers: authHeaders()
    })
    assert.equal(res.status, 502)
    const body = (await res.json()) as any
    assert.equal(body.error, 'studio_unreachable')
    assert.ok(typeof body.reason === 'string' && body.reason.length > 0)
    assert.equal(readJson(path.join(dataRoot, 'uploads', id, 'meta.json')).probe, undefined)
  } finally {
    await offline.close()
  }
})

test('C4-5 staging is retryable when the studio is down during complete', async () => {
  const { id } = await createUpload(web)
  const offline = await listenWeb(uploadsCtx('http://127.0.0.1:1'))
  try {
    const failed = await completeUpload(offline, id)
    assert.equal(failed.status, 502)
    assert.equal(failed.body.error, 'studio_unreachable')
    assert.equal(readJson(path.join(dataRoot, 'uploads', id, 'meta.json')).studio_path, undefined)
  } finally {
    await offline.close()
  }

  const retried = await completeUpload(web, id)
  assert.equal(retried.status, 200)
  assert.equal(retried.body.studio_path, `/studio/uploads/${id}/source.mov`)
})

test('C4-6 probe requires the write token (401 missing / 403 wrong)', async () => {
  const { id } = await createUpload(web)
  await completeUpload(web, id)
  const before = intake.probeCalls().length

  const wrong = await fetch(`${web.url}/api/uploads/${id}/probe`, {
    method: 'POST',
    headers: { 'X-Web-Token': 'wrong-token' }
  })
  assert.equal(wrong.status, 403)
  assert.deepEqual(await wrong.json(), { error: 'invalid X-Web-Token' })
  assert.equal(intake.probeCalls().length, before)

  const anonymous = await fetch(`${web.url}/api/uploads/${id}/probe`, { method: 'POST' })
  assert.equal(anonymous.status, 401)
  assert.deepEqual(await anonymous.json(), { error: 'same-origin or X-Web-Token required' })
  assert.equal(intake.probeCalls().length, before)
})

// #89d: upload init authorisation split — 401 without a token, 403 with a bad one.
test('init returns 401 without a token and 403 with a wrong token', async () => {
  const dirsBefore = fs.readdirSync(path.join(dataRoot, 'uploads')).length
  const payload = JSON.stringify({ filename: 'clip.mov', size: 4, sha256: null })

  const missing = await fetch(`${web.url}/api/uploads/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload
  })
  assert.equal(missing.status, 401)
  assert.deepEqual(await missing.json(), { error: 'same-origin or X-Web-Token required' })

  const wrong = await fetch(`${web.url}/api/uploads/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Web-Token': 'nope' },
    body: payload
  })
  assert.equal(wrong.status, 403)
  assert.deepEqual(await wrong.json(), { error: 'invalid X-Web-Token' })

  assert.equal(fs.readdirSync(path.join(dataRoot, 'uploads')).length, dirsBefore, 'no upload dir created')
})

// #89d: filename traversal is rejected before any directory is created.
test('init rejects path traversal filenames with 400 and creates nothing', async () => {
  const uploadsDir = path.join(dataRoot, 'uploads')
  const dirsBefore = fs.readdirSync(uploadsDir).length
  const badNames = [
    '../x.png',
    '..\\x.png',
    '/etc/x.png',
    'C:\\tmp\\x.png',
    'a/b.png',
    'a\\b.png',
    'a\x00b.png',
    '..'
  ]
  for (const filename of badNames) {
    const res = await fetch(`${web.url}/api/uploads/init`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ filename, size: 4, sha256: null })
    })
    assert.equal(res.status, 400, filename)
    const body = (await res.json()) as any
    assert.match(String(body.error), /filename/, filename)
  }
  assert.equal(fs.readdirSync(uploadsDir).length, dirsBefore, 'no upload dir created')
})

// #89d: Chinese characters and spaces are not traversal — they must still init.
test('init accepts Chinese and space filenames', async () => {
  for (const filename of ['海边 猫.png', 'clip 01.png']) {
    const res = await fetch(`${web.url}/api/uploads/init`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ filename, size: 4, sha256: null })
    })
    assert.equal(res.status, 201, filename)
    const body = (await res.json()) as any
    assert.equal(typeof body.upload_id, 'string')
    assert.equal(body.status, 'uploading')
  }
})

