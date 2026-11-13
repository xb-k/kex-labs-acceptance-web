import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { promisify } from 'node:util'
import { authorizeTaskWrite } from './api'
import {
  buildFfmpegVideoFilter,
  handleVideoOptimizeRoute,
  sanitizeOptimizeParams,
  type OptimizeSession
} from './video-optimize'

const execFileAsync = promisify(execFile)

let root = ''
let server: http.Server
let base = ''

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function atomicWriteJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2))
  fs.renameSync(tmp, file)
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  return raw ? JSON.parse(raw) : {}
}

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kex-optimize-test-'))
  const samplePath = path.join(root, 'issue-19', 'b-track-s0', 'out', 's0_preview.mp4')
  fs.mkdirSync(path.dirname(samplePath), { recursive: true })

  // Generate a tiny real 1.2s 360x640 MP4 clip via ffmpeg so tests stay fast and deterministic
  await execFileAsync('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=duration=1.2:size=360x640:rate=24',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    samplePath
  ])

  server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const handled = await handleVideoOptimizeRoute(req, res, url, url.pathname, {
      dataRoot: root,
      sendJson,
      readJson,
      atomicWriteJson,
      readBody,
      authorizeWrite: (r) => authorizeTaskWrite(r)
    })
    if (!handled) {
      sendJson(res, 404, { error: 'not found' })
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(root, { recursive: true, force: true })
})

test('sanitizeOptimizeParams applies profile defaults and clamps out-of-range sliders', () => {
  const defaults = sanitizeOptimizeParams({ profile: 'teal_orange' })
  assert.equal(defaults.profile, 'teal_orange')
  assert.equal(defaults.contrast, 15)
  assert.equal(defaults.warmth, -8)

  const clamped = sanitizeOptimizeParams({
    profile: 'unknown_profile',
    denoise: 500,
    sharpen: -20,
    contrast: 99,
    brightness: -99,
    saturation: 99,
    warmth: -99
  })
  assert.equal(clamped.profile, 'natural_clarity')
  assert.equal(clamped.denoise, 100)
  assert.equal(clamped.sharpen, 0)
  assert.equal(clamped.contrast, 40)
  assert.equal(clamped.brightness, -20)
  assert.equal(clamped.saturation, 50)
  assert.equal(clamped.warmth, -30)
})

test('buildFfmpegVideoFilter emits portrait 1080p upscale, hqdn3d, colorbalance, eq, unsharp, and fps', () => {
  const params = sanitizeOptimizeParams({
    profile: 'landscape_vivid',
    denoise: 30,
    sharpen: 60,
    upscale_1080p: true,
    smooth_30fps: true
  })
  const { vf, summary } = buildFfmpegVideoFilter(params, { width: 720, height: 1280, fps: 24 })
  assert.match(vf, /scale=1080:-2:flags=lanczos/)
  assert.match(vf, /hqdn3d=/)
  assert.match(vf, /colorbalance=/)
  assert.match(vf, /eq=contrast=/)
  assert.match(vf, /unsharp=5:5:/)
  assert.match(vf, /,fps=30$/)
  assert.match(summary, /1080p Lanczos 超分/)
  assert.match(summary, /30fps 帧率规整/)
})

test('Rail B session ingest, frame serving, real ffmpeg beautify, and Range/download video delivery', async () => {
  // 1. Discover samples
  const samplesRes = await fetch(`${base}/api/optimize/samples`)
  assert.equal(samplesRes.status, 200)
  const samplesJson = (await samplesRes.json()) as { items: Array<{ key: string }> }
  assert.equal(samplesJson.items.some((s) => s.key === 's0_preview'), true)

  // 2. Create session from sample
  const createRes = await fetch(`${base}/api/optimize/session?sample=s0_preview`, {
    method: 'POST',
    headers: { Origin: base }
  })
  assert.equal(createRes.status, 201)
  const session = (await createRes.json()) as OptimizeSession
  assert.match(session.id, /^opt-[a-z0-9]+$/)
  assert.equal(session.probe.width, 360)
  assert.equal(session.probe.height, 640)
  assert.equal(session.frames.length, 4)

  // 3. Fetch extracted JPEG frame
  const firstFrameRes = await fetch(`${base}${session.frames[0].url}`)
  assert.equal(firstFrameRes.status, 200)
  assert.match(firstFrameRes.headers.get('content-type') ?? '', /image\/jpeg/)
  const frameBuf = Buffer.from(await firstFrameRes.arrayBuffer())
  assert.equal(frameBuf[0], 0xff)
  assert.equal(frameBuf[1], 0xd8)

  // 4. Run real ffmpeg beautification (portrait upscale to 1080px width + teal_orange + 30fps)
  const beautifyRes = await fetch(`${base}/api/optimize/${session.id}/beautify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      params: {
        profile: 'teal_orange',
        denoise: 25,
        sharpen: 40,
        contrast: 12,
        brightness: 2,
        saturation: 10,
        warmth: -4,
        upscale_1080p: true,
        smooth_30fps: true
      }
    })
  })
  assert.equal(beautifyRes.status, 200)
  const updated = (await beautifyRes.json()) as OptimizeSession
  assert.ok(updated.enhanced_url)
  assert.ok(updated.enhanced_probe)
  assert.equal(updated.enhanced_probe!.width, 1080)
  assert.equal(updated.enhanced_probe!.fps, 30)
  assert.ok(updated.frames.every((f) => Boolean(f.after_url)))

  // 5. Verify download attachment header and HTTP 206 Range streaming
  const dlRes = await fetch(`${base}/api/optimize/${session.id}/video/enhanced?download=1`)
  assert.equal(dlRes.status, 200)
  assert.match(dlRes.headers.get('content-disposition') ?? '', /attachment; filename=.*_kex_enhanced\.mp4/)
  const dlBytes = await dlRes.arrayBuffer()
  assert.ok(dlBytes.byteLength > 1000)

  const rangeRes = await fetch(`${base}/api/optimize/${session.id}/video/enhanced`, {
    headers: { Range: 'bytes=0-127' }
  })
  assert.equal(rangeRes.status, 206)
  assert.match(rangeRes.headers.get('content-range') ?? '', /^bytes 0-127\//)
  const chunk = await rangeRes.arrayBuffer()
  assert.equal(chunk.byteLength, 128)
})

async function callSamplesRoute(dataRoot: string): Promise<{ status: number; body: any }> {
  let captured = { status: 0, body: null as any }
  const req = {
    method: 'GET',
    url: '/api/optimize/samples',
    headers: {}
  } as unknown as http.IncomingMessage
  const res = { statusCode: 0, setHeader() {}, end() {} } as unknown as http.ServerResponse
  await handleVideoOptimizeRoute(req, res, new URL('http://127.0.0.1/api/optimize/samples'), '/api/optimize/samples', {
    dataRoot,
    sendJson: (_res, status, body) => {
      captured = { status, body }
    },
    readJson,
    atomicWriteJson,
    readBody,
    authorizeWrite: (r) => authorizeTaskWrite(r)
  })
  return captured
}

test('GET /api/optimize/samples only lists real disk files and returns items:[] when empty', async () => {
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kex-optimize-empty-'))
  try {
    const empty = await callSamplesRoute(emptyRoot)
    assert.equal(empty.status, 200)
    assert.deepEqual(empty.body, { items: [] })
  } finally {
    fs.rmSync(emptyRoot, { recursive: true, force: true })
  }

  const real = await callSamplesRoute(root)
  assert.equal(real.status, 200)
  assert.ok(real.body.items.length >= 1)
  assert.equal(real.body.items.some((s: any) => s.key === 's0_preview'), true)
  for (const item of real.body.items) {
    assert.match(item.filename, /\.mp4$/)
    assert.doesNotMatch(item.label, /demo|示例|mock/i)
    assert.match(item.description, /^磁盘真实样片/)
  }
})

test('POST /api/optimize/session requires same-origin or a valid X-Web-Token', async () => {
  const savedToken = process.env.WEB_WRITE_TOKEN
  try {
    delete process.env.WEB_WRITE_TOKEN
    const crossOrigin = await fetch(`${base}/api/optimize/session`, {
      method: 'POST',
      headers: { Origin: 'http://evil.example' }
    })
    assert.equal(crossOrigin.status, 403)
    const forbidden = (await crossOrigin.json()) as any
    assert.match(String(forbidden.error), /same-origin|X-Web-Token/)

    process.env.WEB_WRITE_TOKEN = 'optimize-token'
    const wrongToken = await fetch(`${base}/api/optimize/session`, {
      method: 'POST',
      headers: { Origin: 'http://evil.example', 'X-Web-Token': 'wrong' }
    })
    assert.equal(wrongToken.status, 401)
    const unauthorized = (await wrongToken.json()) as any
    assert.match(String(unauthorized.error), /X-Web-Token/)
  } finally {
    if (savedToken === undefined) delete process.env.WEB_WRITE_TOKEN
    else process.env.WEB_WRITE_TOKEN = savedToken
  }
})
