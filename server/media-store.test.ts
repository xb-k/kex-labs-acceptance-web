/**
 * #160 contract tests: NAS media store (`media/jobs/<job>/<name>`).
 *
 * Covers listing/resolution/traversal/physical delete/audit/auth, the
 * `deliveriesData` merge with b-track rows, and `DELETE /api/deliveries/:id`
 * switching to physical delete for media jobs (trash stays for issue-19).
 *
 * The data root is a temp directory; `WEB_DATA_ROOT` is set before importing
 * `./api` so `deliveriesData()` and the route dispatch read the temp tree.
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import {
  deleteMedia,
  deleteMediaJob,
  jobMeta,
  listMediaJobs,
  mediaJobExists,
  resolveMedia
} from './media-store'

const TOKEN = 'media-store-test-token'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-store-'))
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'media-store-outside-'))
process.env.WEB_DATA_ROOT = root
process.env.WEB_WRITE_TOKEN = TOKEN

const api = await import('./api')

let server: http.Server
let base = ''

after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
})

function seedMedia(job: string, name: string, size = 1024, mtime?: string): string {
  const dir = path.join(root, 'media', 'jobs', job)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, name)
  fs.writeFileSync(file, Buffer.alloc(size, 9))
  if (mtime) fs.utimesSync(file, new Date(mtime), new Date(mtime))
  return file
}

function seedMeta(job: string, meta: Record<string, unknown>): void {
  const dir = path.join(root, 'studio', 'jobs')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${job}.json`), JSON.stringify({ id: job, ...meta }))
}

function auditLines(): any[] {
  const file = path.join(root, 'media-delete.jsonl')
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

async function start(): Promise<void> {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const pathname = decodeURIComponent(url.pathname)
    if (pathname === '/api/media/jobs' || pathname.startsWith('/api/media/jobs/')) {
      api.handleMediaRoute(req, res, url, pathname, { dataRoot: root, env: process.env })
      return
    }
    if (api.handleDeliveryDelete(req, res, root, process.env)) return
    res.statusCode = 404
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ error: 'not found' }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

test('listMediaJobs 只列白名单、忽略隐藏/临时、按 mtime 倒序并返回 url/kind', () => {
  seedMedia('list-job', 'old.mp4', 100, '2026-01-01T00:00:00.000Z')
  seedMedia('list-job', 'new.webm', 200, '2026-02-01T00:00:00.000Z')
  seedMedia('list-job', 'cover.png', 50, '2026-01-15T00:00:00.000Z')
  const dir = path.join(root, 'media', 'jobs', 'list-job')
  fs.writeFileSync(path.join(dir, '.hidden.mp4'), 'x')
  fs.writeFileSync(path.join(dir, 'render.tmp'), 'x')
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x')

  const items = listMediaJobs({ dataRoot: root }).filter((i) => i.job_id === 'list-job')
  assert.deepEqual(
    items.map((i) => [i.name, i.kind]),
    [
      ['new.webm', 'video'],
      ['cover.png', 'image'],
      ['old.mp4', 'video']
    ]
  )
  assert.equal(items[0].bytes, 200)
  assert.equal(items[0].size, 200)
  assert.equal(items[0].path, 'media/jobs/list-job/new.webm')
  assert.equal(items[0].url, '/api/media/jobs/list-job/new.webm')
  assert.match(items[0].mtime, /^2026-02-01T/)
})

test('resolveMedia 正常解析；穿越/绝对路径/非法扩展 400；缺失 404；symlink 越界 400', () => {
  seedMedia('resolve-job', 'ok.mov', 12)
  const ok = resolveMedia('resolve-job', 'ok.mov', { dataRoot: root })
  assert.equal(ok.ok, true)
  if (ok.ok) assert.equal(fs.realpathSync(ok.value.file), fs.realpathSync(path.join(root, 'media', 'jobs', 'resolve-job', 'ok.mov')))

  for (const [job, name] of [
    ['../escape', 'ok.mov'],
    ['resolve-job', '../ok.mov'],
    ['resolve-job', '/etc/passwd'],
    ['resolve-job', 'notes.txt']
  ]) {
    const result = resolveMedia(job, name, { dataRoot: root })
    assert.equal(result.ok, false, `${job}/${name} must be rejected`)
    if (!result.ok) assert.equal(result.status, 400)
  }

  const missing = resolveMedia('resolve-job', 'missing.mp4', { dataRoot: root })
  assert.equal(missing.ok, false)
  if (!missing.ok) assert.equal(missing.status, 404)

  const secret = path.join(outside, 'secret.mp4')
  fs.writeFileSync(secret, 'outside-payload')
  fs.symlinkSync(secret, path.join(root, 'media', 'jobs', 'resolve-job', 'link.mp4'))
  const escaped = resolveMedia('resolve-job', 'link.mp4', { dataRoot: root })
  assert.equal(escaped.ok, false)
  if (!escaped.ok) {
    assert.equal(escaped.status, 400)
    assert.match(escaped.error, /outside media root/)
  }
  assert.equal(fs.readFileSync(secret, 'utf8'), 'outside-payload')
})

test('deleteMedia 物理 unlink、空目录 rmdir、写 media-delete.jsonl 审计', () => {
  const file = seedMedia('delete-job', 'clip.mp4', 321)
  const result = deleteMedia('delete-job', 'clip.mp4', { dataRoot: root })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.value.bytes, 321)
    assert.equal(result.value.jobDirRemoved, true)
  }
  assert.equal(fs.existsSync(file), false)
  assert.equal(fs.existsSync(path.join(root, 'media', 'jobs', 'delete-job')), false)

  const entry = auditLines().find((line) => line.job === 'delete-job')
  assert.ok(entry, 'expected audit entry')
  assert.equal(entry.name, 'clip.mp4')
  assert.equal(entry.size, 321)
  assert.ok(Date.parse(entry.at) > 0)

  const repeat = deleteMedia('delete-job', 'clip.mp4', { dataRoot: root })
  assert.equal(repeat.ok, false)
  if (!repeat.ok) assert.equal(repeat.status, 404)
})

test('deleteMediaJob 删掉一个 job 的全部发布文件；不存在 404', () => {
  seedMedia('multi-job', 'a.mp4', 10)
  seedMedia('multi-job', 'b.png', 20)
  const result = deleteMediaJob('multi-job', { dataRoot: root })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.value.deleted, 2)
    assert.equal(result.value.bytes, 30)
    assert.deepEqual(result.value.files.sort(), ['a.mp4', 'b.png'])
  }
  assert.equal(mediaJobExists('multi-job', { dataRoot: root }), false)
  const missing = deleteMediaJob('multi-job', { dataRoot: root })
  assert.equal(missing.ok, false)
  if (!missing.ok) assert.equal(missing.status, 404)
})

test('jobMeta 读 studio/jobs；非法 id 返回 null', () => {
  seedMeta('meta-job', { brief_id: 'b-77', type: 'video', rail: 'a' })
  assert.equal(jobMeta('meta-job', { dataRoot: root })?.brief_id, 'b-77')
  assert.equal(jobMeta('../meta-job', { dataRoot: root }), null)
  assert.equal(jobMeta('nope', { dataRoot: root }), null)
})

test('GET /api/media/jobs 支持 limit/offset；非法参数 400', async () => {
  await start()
  seedMedia('route-list', 'a.mp4', 10, '2026-03-02T00:00:00.000Z')
  seedMedia('route-list', 'b.mp4', 20, '2026-03-01T00:00:00.000Z')
  seedMedia('route-other', 'c.mp4', 30, '2026-03-03T00:00:00.000Z')

  const res = await fetch(`${base}/api/media/jobs?limit=2&offset=1`)
  assert.equal(res.status, 200)
  const body: any = await res.json()
  assert.ok(body.total >= 3)
  assert.equal(body.jobs.length, 2)
  assert.equal(body.limit, 2)
  assert.equal(body.offset, 1)

  const all: any = await (await fetch(`${base}/api/media/jobs?limit=1000`)).json()
  const index = all.jobs.findIndex(
    (job: any) => job.job_id === 'route-other' && job.name === 'c.mp4'
  )
  assert.ok(index >= 0)
  const sliced: any = await (await fetch(`${base}/api/media/jobs?limit=1&offset=${index}`)).json()
  assert.equal(sliced.jobs[0].job_id, 'route-other')

  const bad = await fetch(`${base}/api/media/jobs?limit=abc`)
  assert.equal(bad.status, 400)
})

test('GET 文件支持 Range 206；DELETE 需鉴权并物理删 + 审计', async () => {
  const file = path.join(root, 'media', 'jobs', 'route-file', 'clip.mp4')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, 'abcdefgh')

  const ranged = await fetch(`${base}/api/media/jobs/route-file/clip.mp4`, {
    headers: { Range: 'bytes=0-3' }
  })
  assert.equal(ranged.status, 206)
  assert.equal(await ranged.text(), 'abcd')

  const denied = await fetch(`${base}/api/media/jobs/route-file/clip.mp4`, { method: 'DELETE' })
  assert.equal(denied.status, 403)

  const deleted = await fetch(`${base}/api/media/jobs/route-file/clip.mp4`, {
    method: 'DELETE',
    headers: { 'x-web-token': TOKEN }
  })
  assert.equal(deleted.status, 200)
  const body: any = await deleted.json()
  assert.equal(body.ok, true)
  assert.equal(body.deleted, true)
  assert.equal(body.job_id, 'route-file')
  assert.equal(body.name, 'clip.mp4')
  assert.equal(body.bytes, 8)
  assert.equal(fs.existsSync(file), false)
  assert.ok(auditLines().some((line) => line.job === 'route-file' && line.name === 'clip.mp4'))

  const gone = await fetch(`${base}/api/media/jobs/route-file/clip.mp4`)
  assert.equal(gone.status, 404)
})

test('deliveriesData 合并 media 视频、与 b-track 同 job 去重、limit 在合并后生效', async () => {
  // b-track fixture (wins over the same media job id).
  const bOut = path.join(root, 'issue-19', 'b-track-s0', 'out')
  fs.mkdirSync(bOut, { recursive: true })
  fs.writeFileSync(path.join(bOut, 'final.mp4'), Buffer.alloc(64, 1))
  fs.utimesSync(
    path.join(bOut, 'final.mp4'),
    new Date('2026-01-01T00:00:00.000Z'),
    new Date('2026-01-01T00:00:00.000Z')
  )
  fs.writeFileSync(
    path.join(root, 'issue-19', 'b-track-s0', 'summary.json'),
    JSON.stringify({ task_id: 't-1', verdict: 'pass' })
  )
  seedMedia('s0', 'final-from-nas.mp4', 99, '2026-04-02T00:00:00.000Z')
  seedMedia('media-video', 'clip.mp4', 123, '2026-04-03T00:00:00.000Z')
  seedMedia('media-image', 'cover.png', 5, '2026-04-04T00:00:00.000Z')
  seedMeta('media-video', { brief_id: 'b-1', type: 'video', rail: 'a' })

  const { deliveries } = await api.deliveriesData()
  const ids = deliveries.map((row: any) => row.jobId)
  assert.ok(ids.includes('media-video'))
  assert.ok(ids.includes('s0'))
  assert.equal(ids.filter((id: string) => id === 's0').length, 1, 'b-track/media duplicate must collapse')
  assert.equal(ids.includes('media-image'), false, 'only video rows merge')

  const media = deliveries.find((row: any) => row.jobId === 'media-video')
  assert.ok(media)
  assert.equal(media.title, 'b-1 · video · a')
  assert.equal(media.mp4, '/api/media/jobs/media-video/clip.mp4')
  assert.equal(media.poster, null)
  assert.equal(media.durationS, null)
  assert.equal(media.width, null)
  assert.equal(media.height, null)
  assert.equal(media.gate, '已发布')
  assert.equal(media.bytes, 123)
  assert.equal(media.report, null)

  const bTrack = deliveries.find((row: any) => row.jobId === 's0')
  assert.ok(bTrack)
  assert.equal(bTrack.mp4, '/media/out/s0')
  assert.notEqual(bTrack.title, 'final-from-nas.mp4')

  const limited = await api.deliveriesData(1)
  assert.equal(limited.deliveries.length, 1)
  assert.equal(
    limited.deliveries[0].jobId,
    deliveries[0].jobId,
    'limit applies after mtime merge/sort'
  )
})

test('DELETE /api/deliveries/:id：media 前缀/media job 物理删，旧 b-track 仍走 trash', async () => {
  seedMedia('delivery-media', 'clip.mp4', 77)
  const plain = await fetch(`${base}/api/deliveries/delivery-media`, {
    method: 'DELETE',
    headers: { 'x-web-token': TOKEN }
  })
  assert.equal(plain.status, 200)
  const plainBody: any = await plain.json()
  assert.equal(plainBody.deleted, 1)
  assert.equal(plainBody.bytes, 77)
  assert.equal(fs.existsSync(path.join(root, 'media', 'jobs', 'delivery-media', 'clip.mp4')), false)
  assert.equal(fs.existsSync(path.join(root, '.trash', 'deliveries')), false)

  seedMedia('delivery-prefixed', 'clip2.mp4', 8)
  const prefixed = await fetch(`${base}/api/deliveries/media:delivery-prefixed`, {
    method: 'DELETE',
    headers: { 'x-web-token': TOKEN }
  })
  assert.equal(prefixed.status, 200)
  assert.equal(fs.existsSync(path.join(root, 'media', 'jobs', 'delivery-prefixed', 'clip2.mp4')), false)

  const oldOut = path.join(root, 'issue-19', 'b-track-legacy', 'out')
  fs.mkdirSync(oldOut, { recursive: true })
  fs.writeFileSync(path.join(oldOut, 'final.mp4'), Buffer.alloc(16, 3))
  const legacy = await fetch(`${base}/api/deliveries/legacy`, {
    method: 'DELETE',
    headers: { 'x-web-token': TOKEN }
  })
  assert.equal(legacy.status, 200)
  const legacyBody: any = await legacy.json()
  assert.match(legacyBody.movedTo, /^\.trash\/deliveries\/legacy-/)
  assert.equal(fs.existsSync(path.join(oldOut, 'final.mp4')), false)
})
