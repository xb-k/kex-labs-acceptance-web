/**
 * #86b2 contract tests: studio artifact proxy.
 *
 * The intake is a local HTTP stub; the route under test is the production
 * `handleStudioRoute` path. Run with `npm run test:server` (esbuild + node --test).
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { checkArtifactName, handleStudioRoute } from './studio'
import type { StudioContext } from './studio'

const TOKEN = 'artifact86-test-token'
const hits: Array<{
  url: string
  method: string | undefined
  token: string | undefined
  range: string | undefined
}> = []
let upstream: http.Server
let web: http.Server
let base = ''
let intakeUrl = ''

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

const ctx: StudioContext = {
  dataRoot: path.join(os.tmpdir(), 'artifact86-data'),
  intakeUrl: '',
  timeoutMs: 2000,
  webToken: TOKEN,
  isSameOrigin: () => false,
  sendJson,
  readJson: () => null,
  atomicWriteJson: () => {},
  readBody: async () => ({})
}

before(async () => {
  upstream = http.createServer((req, res) => {
    hits.push({
      url: req.url ?? '',
      method: req.method,
      token: req.headers['x-web-token'] as string | undefined,
      range: req.headers.range as string | undefined
    })
    if (req.url === '/intake/jobs/j1/artifacts/clip.mp4') {
      // #86b2-fix: upstream hands back a generic type; the proxy must fix it up.
      res.setHeader('Content-Type', 'application/octet-stream')
      res.setHeader('Content-Length', '5')
      res.end('hello')
      return
    }
    if (req.url === '/intake/jobs/j1/artifacts/final.mp4') {
      res.setHeader('Content-Type', 'video/mp4')
      res.setHeader('Content-Length', '5')
      res.end(req.method === 'HEAD' ? undefined : 'hello')
      return
    }
    if (req.url === '/intake/jobs/j1/artifacts/summary.json') {
      res.setHeader('Content-Type', 'application/json')
      res.end('{"ok":true}')
      return
    }
    if (req.url === '/intake/jobs/j1/artifacts/oob.mp4') {
      // #86e: unsatisfiable Range — the proxy must keep the 416 semantics.
      res.statusCode = 416
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Content-Range', 'bytes */5')
      res.setHeader('Accept-Ranges', 'bytes')
      res.end('{"error":"range not satisfiable"}')
      return
    }
    if (req.url === '/intake/jobs/j1/artifacts/bad.mp4') {
      res.statusCode = 400
      res.setHeader('Content-Type', 'application/json')
      res.end('{"error":"bad range"}')
      return
    }
    if (req.url === '/intake/jobs/j1/artifacts/broken.mp4') {
      res.statusCode = 500
      res.setHeader('Content-Type', 'text/plain')
      res.end('boom')
      return
    }
    res.statusCode = 404
    res.end('{"error":"not found"}')
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

test('allowlist accepts artifacts and rejects traversal / directories', () => {
  for (const name of ['summary.json', 'metrics.csv', 'final.mp4', 'out_8s.png', 'quality_b.json']) {
    assert.deepEqual(checkArtifactName(name), { ok: true }, name)
  }
  for (const name of ['../secret.mp4', '..%2Fsecret.mp4', '/etc/passwd', 'output/final.mp4', 'a\\b.mp4', '.env']) {
    const r = checkArtifactName(name)
    assert.equal(r.ok, false, name)
    if (!r.ok) assert.equal(r.status, 403, name)
  }
  for (const name of ['notes.zip', 'archive.zip', '']) {
    const r = checkArtifactName(name)
    assert.equal(r.ok, false, name)
    if (!r.ok) assert.equal(r.status, 404, name)
  }
})

test('GET streams the artifact, injects X-Web-Token and keeps the short TTL', async () => {
  const r = await fetch(`${base}/api/studio/jobs/j1/artifacts/final.mp4`)
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('content-type'), 'video/mp4')
  assert.match(r.headers.get('cache-control') ?? '', /max-age=30/)
  assert.equal(await r.text(), 'hello')
  const hit = hits.at(-1)
  assert.equal(hit?.url, '/intake/jobs/j1/artifacts/final.mp4')
  assert.equal(hit?.token, TOKEN)
})

test('GET corrects a generic upstream content type using the artifact name', async () => {
  const r = await fetch(`${base}/api/studio/jobs/j1/artifacts/clip.mp4`)
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('content-type'), 'video/mp4')
  assert.equal(await r.text(), 'hello')
})

test('GET maps summary.json to application/json', async () => {
  const r = await fetch(`${base}/api/studio/jobs/j1/artifacts/summary.json`)
  assert.equal(r.status, 200)
  assert.match(r.headers.get('content-type') ?? '', /^application\/json/)
})

test('HEAD probes upstream with GET, returns headers and no body', async () => {
  const before = hits.length
  const r = await fetch(`${base}/api/studio/jobs/j1/artifacts/final.mp4`, {
    method: 'HEAD',
    headers: { Range: 'bytes=0-1' }
  })
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('content-type'), 'video/mp4')
  assert.equal(r.headers.get('content-length'), '5')
  assert.equal(await r.text(), '')
  assert.equal(hits.length, before + 1)
  assert.equal(hits.at(-1)?.method, 'GET')
  assert.equal(hits.at(-1)?.range, 'bytes=0-1')
})

test('traversal is rejected before touching the intake', async () => {
  const before = hits.length
  const r = await fetch(`${base}/api/studio/jobs/j1/artifacts/..%2Fsecret.mp4`)
  assert.equal(r.status, 403)
  const body = (await r.json()) as { error: string }
  assert.equal(body.error, 'artifact path not allowed')
  assert.equal(hits.length, before)
})

test('non-allowlisted names return 404 without an upstream call', async () => {
  const before = hits.length
  const r = await fetch(`${base}/api/studio/jobs/j1/artifacts/archive.zip`)
  assert.equal(r.status, 404)
  assert.equal(hits.length, before)
})

test('upstream 404 stays a clear 404', async () => {
  const r = await fetch(`${base}/api/studio/jobs/j1/artifacts/missing.mp4`)
  assert.equal(r.status, 404)
  const body = (await r.json()) as { error: string }
  assert.equal(body.error, 'artifact not found')
})

test('upstream 416 is forwarded with Content-Range/Accept-Ranges (not 502)', async () => {
  const r = await fetch(`${base}/api/studio/jobs/j1/artifacts/oob.mp4`, {
    headers: { Range: 'bytes=999999999-' }
  })
  assert.equal(r.status, 416)
  assert.equal(r.headers.get('content-range'), 'bytes */5')
  assert.equal(r.headers.get('accept-ranges'), 'bytes')
  assert.equal(await r.text(), '{"error":"range not satisfiable"}')
  assert.equal(hits.at(-1)?.range, 'bytes=999999999-')
})

test('other upstream 4xx pass through with status and body', async () => {
  const r = await fetch(`${base}/api/studio/jobs/j1/artifacts/bad.mp4`)
  assert.equal(r.status, 400)
  assert.equal(await r.text(), '{"error":"bad range"}')
})

test('upstream 5xx still becomes 502', async () => {
  const r = await fetch(`${base}/api/studio/jobs/j1/artifacts/broken.mp4`)
  assert.equal(r.status, 502)
  const body = (await r.json()) as { error: string; reason: string }
  assert.equal(body.error, 'artifact proxy failed')
  assert.match(body.reason, /500/)
})

test('only GET/HEAD are allowed', async () => {
  const r = await fetch(`${base}/api/studio/jobs/j1/artifacts/final.mp4`, { method: 'POST' })
  assert.equal(r.status, 405)
})

// keep the type import used so TS treats this as a server-context test
void ({} as IncomingMessage)
