/**
 * #140 contract tests: `DELETE /api/studio/jobs/:id` and the image retention
 * sweep. Every HTTP case runs through the production `handleStudioRoute`; the
 * intake is a local stub and the data root is a temp directory.
 *
 * Run with `npm run test:server`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  handleStudioRoute,
  resolveImageRetentionDays,
  sweepExpiredImageJobs
} from './studio'
import type { StudioContext } from './studio'

const TOKEN = 'delete-test-token'
const DAY_MS = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-11-14T00:00:00.000Z')

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

function readJsonFile(file: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function atomicWriteJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value))
}

function makeCtx(dataRoot: string, intakeUrl: string): StudioContext {
  return {
    dataRoot,
    intakeUrl,
    timeoutMs: 2000,
    webToken: TOKEN,
    isSameOrigin: (req: IncomingMessage) => req.headers['x-test-same-origin'] === '1',
    sendJson,
    readJson: readJsonFile,
    atomicWriteJson,
    readBody: async () => ({})
  }
}

function seedJob(root: string, id: string, type: 'image' | 'aigc' = 'image'): void {
  fs.mkdirSync(path.join(root, 'jobs', id, 'output'), { recursive: true })
  fs.writeFileSync(path.join(root, 'jobs', id, 'output', 'final.png'), 'bytes')
  fs.mkdirSync(path.join(root, 'studio', 'jobs'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'studio', 'jobs', `${id}.json`),
    JSON.stringify({
      id,
      type,
      rail: 'B',
      brief_id: null,
      model: null,
      input: null,
      created_at: '2026-11-01T00:00:00.000Z'
    })
  )
}

/** Audit trail paths that deletion must keep. */
function seedAuditTrail(root: string, id: string): void {
  fs.mkdirSync(path.join(root, 'state'), { recursive: true })
  fs.writeFileSync(path.join(root, 'state', `${id}.json`), '{"state":"failed"}')
  fs.mkdirSync(path.join(root, 'reports'), { recursive: true })
  fs.writeFileSync(path.join(root, 'reports', `${id}.md`), 'audit report')
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('server did not bind')
  return `http://127.0.0.1:${addr.port}`
}

type Fixture = {
  root: string
  ctx: StudioContext
  base: string
  close: () => Promise<void>
}

async function withFixture(
  opts: { details?: Record<string, any>; list?: any[] },
  fn: (fixture: Fixture) => Promise<void>
): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-delete-'))
  const details = opts.details ?? {}
  const list = opts.list ?? []
  const intake = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/intake/jobs') {
      sendJson(res, 200, { items: list })
      return
    }
    const match = url.pathname.match(/^\/intake\/jobs\/([^/]+)$/)
    if (match) {
      const body = details[decodeURIComponent(match[1])]
      if (!body) {
        sendJson(res, 404, { error: 'job not found' })
        return
      }
      sendJson(res, 200, body)
      return
    }
    sendJson(res, 404, { error: 'not found' })
  })
  const intakeUrl = await listen(intake)
  const ctx = makeCtx(root, intakeUrl)
  const web = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const handled = await handleStudioRoute(req, res, url, url.pathname, ctx)
    if (!handled) {
      res.statusCode = 404
      res.end()
    }
  })
  const base = await listen(web)
  try {
    await fn({ root, ctx, base, close: async () => {} })
  } finally {
    await new Promise<void>((resolve) => web.close(() => resolve()))
    await new Promise<void>((resolve) => intake.close(() => resolve()))
    fs.rmSync(root, { recursive: true, force: true })
  }
}

/** Direct route call for raw pathnames the WHATWG URL parser would normalise. */
async function invokeDelete(
  ctx: StudioContext,
  pathname: string,
  headers: Record<string, string>
): Promise<{ status: number; body: any }> {
  let status = 0
  let body: any = null
  const local: StudioContext = {
    ...ctx,
    sendJson: (_res, code, payload) => {
      status = code
      body = payload
    }
  }
  const req = { method: 'DELETE', headers, socket: {} } as unknown as IncomingMessage
  await handleStudioRoute(req, {} as ServerResponse, new URL('http://x/api/studio/'), pathname, local)
  return { status, body }
}

test('DELETE without token and without same-origin → 401', async () => {
  await withFixture({ details: { j1: { state: 'canceled' } } }, async ({ root, base }) => {
    seedJob(root, 'j1')
    const res = await fetch(`${base}/api/studio/jobs/j1`, { method: 'DELETE' })
    assert.equal(res.status, 401)
    assert.ok(fs.existsSync(path.join(root, 'studio', 'jobs', 'j1.json')))
  })
})

test('DELETE with a wrong token → 403', async () => {
  await withFixture({ details: { j1: { state: 'canceled' } } }, async ({ root, base }) => {
    seedJob(root, 'j1')
    const res = await fetch(`${base}/api/studio/jobs/j1`, {
      method: 'DELETE',
      headers: { 'X-Web-Token': 'wrong' }
    })
    assert.equal(res.status, 403)
    assert.ok(fs.existsSync(path.join(root, 'studio', 'jobs', 'j1.json')))
  })
})

test('DELETE a succeeded job → 409 and nothing is removed', async () => {
  await withFixture({ details: { j1: { state: 'succeeded' } } }, async ({ root, base }) => {
    seedJob(root, 'j1')
    const res = await fetch(`${base}/api/studio/jobs/j1`, {
      method: 'DELETE',
      headers: { 'X-Web-Token': TOKEN }
    })
    assert.equal(res.status, 409)
    assert.ok(fs.existsSync(path.join(root, 'jobs', 'j1')))
    assert.ok(fs.existsSync(path.join(root, 'studio', 'jobs', 'j1.json')))
  })
})

test('DELETE an unknown job → 404', async () => {
  await withFixture({}, async ({ base }) => {
    const res = await fetch(`${base}/api/studio/jobs/missing`, {
      method: 'DELETE',
      headers: { 'X-Web-Token': TOKEN }
    })
    assert.equal(res.status, 404)
  })
})

test('DELETE with a traversal / absolute-looking id → 400', async () => {
  await withFixture({ details: { '..': { state: 'failed' } } }, async ({ ctx }) => {
    for (const pathname of ['/api/studio/jobs/..', '/api/studio/jobs/..%5C..']) {
      const res = await invokeDelete(ctx, pathname, { 'x-web-token': TOKEN })
      assert.equal(res.status, 400, pathname)
    }
  })
})

test('DELETE a canceled job → 200, job dir + meta gone, state/reports kept, audit written', async () => {
  await withFixture({ details: { j1: { state: 'canceled' } } }, async ({ root, base }) => {
    seedJob(root, 'j1')
    seedAuditTrail(root, 'j1')
    const res = await fetch(`${base}/api/studio/jobs/j1`, {
      method: 'DELETE',
      headers: { 'X-Web-Token': TOKEN }
    })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { deleted: true, id: 'j1' })
    assert.equal(fs.existsSync(path.join(root, 'jobs', 'j1')), false)
    assert.equal(fs.existsSync(path.join(root, 'studio', 'jobs', 'j1.json')), false)
    assert.ok(fs.existsSync(path.join(root, 'state', 'j1.json')))
    assert.ok(fs.existsSync(path.join(root, 'reports', 'j1.md')))

    const lines = fs
      .readFileSync(path.join(root, 'logs', 'audit.log'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    const entry = lines.find((line) => line.action === 'job_delete' && line.id === 'j1')
    assert.ok(entry, 'job_delete audit entry')
    assert.equal(entry.status, 200)
    assert.equal(typeof entry.ts, 'string')
    assert.equal(typeof entry.ip, 'string')
  })
})

test('retention: 7.1d old image job is deleted, 6.9d is retained', async () => {
  const list = [
    { id: 'img-old', state: 'failed', updated_at: new Date(NOW - 7.1 * DAY_MS).toISOString() },
    { id: 'img-new', state: 'failed', updated_at: new Date(NOW - 6.9 * DAY_MS).toISOString() },
    { id: 'aigc-old', state: 'failed', updated_at: new Date(NOW - 30 * DAY_MS).toISOString() }
  ]
  await withFixture({ list }, async ({ root, ctx }) => {
    seedJob(root, 'img-old', 'image')
    seedJob(root, 'img-new', 'image')
    seedJob(root, 'aigc-old', 'aigc')

    const result = await sweepExpiredImageJobs(ctx, { now: NOW, days: 7 })
    assert.deepEqual(result.deleted, ['img-old'])
    assert.equal(result.retained, 1)
    assert.equal(fs.existsSync(path.join(root, 'jobs', 'img-old')), false)
    assert.equal(fs.existsSync(path.join(root, 'studio', 'jobs', 'img-old.json')), false)
    assert.ok(fs.existsSync(path.join(root, 'jobs', 'img-new')))
    // Only image jobs are ever swept.
    assert.ok(fs.existsSync(path.join(root, 'jobs', 'aigc-old')))

    const entries = fs
      .readFileSync(path.join(root, 'logs', 'audit.log'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    const summary = entries.find((line) => line.action === 'job_retention' && line.status === 200)
    assert.ok(summary, 'retention summary entry')
    assert.equal(summary.deleted, 1)
    assert.equal(summary.retained, 1)
  })
})

test('retention: WEB_IMAGE_RETENTION_DAYS=0 disables the sweep', async () => {
  const list = [
    { id: 'img-old', state: 'failed', updated_at: new Date(NOW - 100 * DAY_MS).toISOString() }
  ]
  await withFixture({ list }, async ({ root, ctx }) => {
    seedJob(root, 'img-old', 'image')
    const result = await sweepExpiredImageJobs(ctx, { now: NOW, days: 0 })
    assert.deepEqual(result.deleted, [])
    assert.equal(result.skipped, 'disabled')
    assert.ok(fs.existsSync(path.join(root, 'jobs', 'img-old')))
  })
})

test('retention days: default 7, 0 stays disabled, invalid falls back to 7', () => {
  assert.equal(resolveImageRetentionDays({}), 7)
  assert.equal(resolveImageRetentionDays({ WEB_IMAGE_RETENTION_DAYS: '0' }), 0)
  assert.equal(resolveImageRetentionDays({ WEB_IMAGE_RETENTION_DAYS: '3' }), 3)
  assert.equal(resolveImageRetentionDays({ WEB_IMAGE_RETENTION_DAYS: 'abc' }), 7)
  assert.equal(resolveImageRetentionDays({ WEB_IMAGE_RETENTION_DAYS: '-1' }), 7)
})
