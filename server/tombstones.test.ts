/**
 * #163 contract tests: a deleted delivery / media job must be invisible
 * everywhere, not just on the page that triggered the delete.
 *
 * Every HTTP case runs through the production `handler` (same dispatch as vite),
 * against a temp `WEB_DATA_ROOT`, a stub intake and a temp `KEX_REPO_ROOT`.
 * `WEB_DATA_ROOT` is set before `./api` is imported so the production filters
 * read the same tree the fixtures write.
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { isTombstoned, readTombstones, tombstone, tombstonePath } from './tombstones'

const TOKEN = 'tombstone-test-token'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tombstones-'))

const INTAKE = [
  { id: 'j-media', state: 'succeeded', updated_at: '2026-11-01T00:00:00.000Z' },
  { id: 'j-img', state: 'succeeded', updated_at: '2026-11-01T00:00:00.000Z' },
  { id: 'j-keep', state: 'succeeded', updated_at: '2026-11-01T00:00:00.000Z' },
  { id: 'j-job', state: 'failed', updated_at: '2026-11-01T00:00:00.000Z' }
]

function write(rel: string, content: string | Buffer): void {
  const file = path.join(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

function seedFixtures(): void {
  write('media/jobs/j-media/clip.mp4', Buffer.alloc(512, 1))
  write('media/jobs/j-img/1.png', Buffer.alloc(64, 2))
  write('media/jobs/j-keep/keep.png', Buffer.alloc(64, 3))
  for (const id of ['j-img', 'j-keep']) {
    write(
      `studio/jobs/${id}.json`,
      JSON.stringify({ id, type: 'image', rail: 'B', brief_id: null, created_at: '2026-11-01T00:00:00.000Z' })
    )
  }
  write(
    'studio/jobs/j-job.json',
    JSON.stringify({ id: 'j-job', type: 'image', rail: 'B', brief_id: null, created_at: '2026-11-01T00:00:00.000Z' })
  )
  write('jobs/j-job/output/final.png', Buffer.alloc(16, 4))
  // One b-track delivery so `deliveriesData` has both row kinds.
  write('issue-19/b-track-s1/out/summary.json', JSON.stringify({ task_id: 'T-1', verdict: 'PASS' }))
  write('issue-19/b-track-s1/out/final.mp4', Buffer.alloc(256, 5))
  write('issue-19/b-track-s1/out/cover_16x9.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
  write('issue-19/b-track-s1/report.md', '# s1\n')
  for (const id of ['j-media', 'j-img', 'j-job', 'j-keep', 's1']) {
    write(`kex-repo/state/${id}.json`, JSON.stringify({ status: 'failed', updated_at: '2026-11-01T00:00:00.000Z' }))
  }
}

seedFixtures()

const intake = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  if (url.pathname === '/intake/jobs') {
    res.end(JSON.stringify({ items: INTAKE }))
    return
  }
  const match = url.pathname.match(/^\/intake\/jobs\/([^/]+)$/)
  const item = match ? INTAKE.find((entry) => entry.id === decodeURIComponent(match[1])) : undefined
  if (!item) {
    res.statusCode = 404
    res.end(JSON.stringify({ error: 'job not found' }))
    return
  }
  res.end(JSON.stringify({ id: item.id, state: item.state, updated_at: item.updated_at }))
})
await new Promise<void>((resolve) => intake.listen(0, '127.0.0.1', resolve))
const intakePort = (intake.address() as AddressInfo).port

process.env.WEB_DATA_ROOT = root
process.env.WEB_WRITE_TOKEN = TOKEN
process.env.STUDIO_INTAKE_URL = `http://127.0.0.1:${intakePort}`
process.env.KEX_REPO_ROOT = path.join(root, 'kex-repo')

const api = await import('./api')

let server: http.Server | null = null
let base = ''
await new Promise<void>((resolve) => {
  const created = http.createServer((req, res) => {
    void api.handler(req, res, () => {
      res.statusCode = 404
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ error: 'not found' }))
    })
  })
  server = created
  created.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${(created.address() as AddressInfo).port}`
    resolve()
  })
})

after(async () => {
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()))
  await new Promise<void>((resolve) => intake.close(() => resolve()))
  fs.rmSync(root, { recursive: true, force: true })
})

async function request(
  method: string,
  pathname: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${pathname}`, { method, headers })
  const text = await res.text()
  let body: any = text
  try {
    body = JSON.parse(text)
  } catch {
    /* 405 空 body 等非 JSON */
  }
  return { status: res.status, body }
}

function entries(job: string) {
  return readTombstones({ dataRoot: root }).filter((entry) => entry.job_id === job)
}

test('损坏的 tombstones.json → 读为空 + warning，列表照常返回', async () => {
  fs.writeFileSync(tombstonePath(root), '{this is not json')
  assert.deepEqual(readTombstones({ dataRoot: root }), [])
  assert.equal(isTombstoned('j-media', { dataRoot: root }), false)
  const reply = await request('GET', '/api/deliveries')
  assert.equal(reply.status, 200)
  assert.ok(reply.body.deliveries.some((row: any) => row.jobId === 'j-media'))
  fs.rmSync(tombstonePath(root), { force: true })
})

test('未删除的 job 在各入口可见', async () => {
  const list = await request('GET', '/api/studio/jobs')
  assert.ok(list.body.items.some((job: any) => job.id === 'j-keep'))
  const gallery = await request('GET', '/api/studio/gallery?limit=50')
  assert.ok(gallery.body.items.some((job: any) => job.id === 'j-keep'))
  const deliveries = await request('GET', '/api/deliveries')
  assert.ok(deliveries.body.deliveries.some((row: any) => row.jobId === 'j-keep'))
  assert.ok(deliveries.body.deliveries.some((row: any) => row.jobId === 's1'))
  const flow = await request('GET', '/api/flow')
  assert.ok(flow.body.jobs.some((job: any) => job.id === 'j-keep'))
  const snap = await request('GET', '/api/snapshot?source=b-track&job=s1')
  assert.equal(snap.status, 200)
  assert.equal(snap.body.available, true)
})

test('DELETE /api/deliveries/media:<job> → 物理删 + tombstone(delivery) + 全系统不可见', async () => {
  const before = await request('GET', '/api/flow')
  assert.ok(before.body.jobs.some((job: any) => job.id === 'j-media'))

  const reply = await request('DELETE', '/api/deliveries/media:j-media', { 'X-Web-Token': TOKEN })
  assert.equal(reply.status, 200)
  assert.equal(reply.body.deleted, 1)
  assert.equal(fs.existsSync(path.join(root, 'media', 'jobs', 'j-media')), false)

  const entry = entries('j-media')[0]
  assert.equal(entry?.source, 'delivery')
  assert.deepEqual(entry?.files, ['media/jobs/j-media/clip.mp4'])

  const deliveries = await request('GET', '/api/deliveries')
  assert.equal(deliveries.body.deliveries.some((row: any) => row.jobId === 'j-media'), false)
  const flow = await request('GET', '/api/flow')
  assert.equal(flow.body.jobs.some((job: any) => job.id === 'j-media'), false)
  assert.equal((await request('GET', '/api/flow?job=j-media')).status, 404)
  const list = await request('GET', '/api/studio/jobs')
  assert.equal(list.body.items.some((job: any) => job.id === 'j-media'), false)
  assert.equal((await request('GET', '/api/studio/jobs/j-media')).status, 404)
  assert.equal((await request('GET', '/api/snapshot?source=studio&job=j-media')).status, 404)

  const audit = fs
    .readFileSync(path.join(root, 'media-delete.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .find((line) => line.action === 'tombstone' && line.job === 'j-media')
  assert.equal(audit?.source, 'delivery')
  assert.equal(audit?.fileCount, 1)

  // Idempotent: a second delete returns 200 and keeps exactly one entry.
  const again = await request('DELETE', '/api/deliveries/media:j-media', { 'X-Web-Token': TOKEN })
  assert.equal(again.status, 200)
  assert.equal(again.body.deleted, 0)
  assert.equal(entries('j-media').length, 1)
})

test('DELETE /api/media/jobs/:job/:name 删空目录 → tombstone(media)，重复删除不重复记账', async () => {
  const before = await request('GET', '/api/studio/gallery?limit=50')
  assert.ok(before.body.items.some((job: any) => job.id === 'j-img'))

  const reply = await request('DELETE', '/api/media/jobs/j-img/1.png', { 'X-Web-Token': TOKEN })
  assert.equal(reply.status, 200)
  assert.equal(reply.body.jobDirRemoved, true)

  const entry = entries('j-img')[0]
  assert.equal(entry?.source, 'media')
  assert.deepEqual(entry?.files, ['media/jobs/j-img/1.png'])

  const again = await request('DELETE', '/api/media/jobs/j-img/1.png', { 'X-Web-Token': TOKEN })
  assert.equal(again.status, 404)
  assert.equal(entries('j-img').length, 1)

  const gallery = await request('GET', '/api/studio/gallery?limit=50')
  assert.equal(gallery.body.items.some((job: any) => job.id === 'j-img'), false)
  assert.equal((await request('GET', '/api/studio/jobs/j-img')).status, 404)
})

test('DELETE /api/studio/jobs/:id → 即使本地删失败也先隐藏（tombstone job）', async () => {
  const before = await request('GET', '/api/studio/jobs/j-job')
  assert.equal(before.status, 200)

  // Simulate a partial removal: only the intake record is left.
  fs.rmSync(path.join(root, 'jobs', 'j-job'), { recursive: true, force: true })
  fs.rmSync(path.join(root, 'studio', 'jobs', 'j-job.json'), { force: true })

  const reply = await request('DELETE', '/api/studio/jobs/j-job', { 'X-Web-Token': TOKEN })
  assert.equal(reply.status, 404)

  const entry = entries('j-job')[0]
  assert.equal(entry?.source, 'job')

  assert.equal((await request('GET', '/api/studio/jobs/j-job')).status, 404)
  const list = await request('GET', '/api/studio/jobs')
  assert.equal(list.body.items.some((job: any) => job.id === 'j-job'), false)
  assert.equal((await request('GET', '/api/flow?job=j-job')).status, 404)
})

test('tombstone 一个 b-track job → deliveries 与 snapshot 同时隐藏', async () => {
  const before = await request('GET', '/api/snapshot?source=b-track&job=s1')
  assert.equal(before.status, 200)

  tombstone('s1', 'delivery', [], { dataRoot: root })

  assert.equal((await request('GET', '/api/snapshot?source=b-track&job=s1')).status, 404)
  const deliveries = await request('GET', '/api/deliveries')
  assert.equal(deliveries.body.deliveries.some((row: any) => row.jobId === 's1'), false)
  const flow = await request('GET', '/api/flow')
  assert.equal(flow.body.jobs.some((job: any) => job.id === 's1'), false)
})
