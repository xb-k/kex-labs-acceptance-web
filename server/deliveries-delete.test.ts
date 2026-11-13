/**
 * #107 contract tests: `DELETE /api/deliveries/:id`（软删到回收站）。
 *
 * 生产代码路径 `handleDeliveryDelete` 直接挂到真实 http.Server 上跑，`dataRoot`
 * 指向系统临时目录（不碰真实 WEB_DATA_ROOT）。覆盖：
 *  - auth 四态：同源 200 / 跨源 403 / 错 token 401 / 未配置 token 却带 token 503；
 *  - 非法 id 400、不存在 404、`..` 与 symlink 越界 400（目录外文件零改动）；
 *  - 成功移动：out 目录无 mp4、回收站文件可回读、移回后原文件内容一致；
 *  - 重复删除 → 404。
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { handleDeliveryDelete } from './api'

const TOKEN = 'deliveries107-test-token'

let root = ''
let server: http.Server
let base = ''

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'deliveries107-'))
  process.env.WEB_WRITE_TOKEN = TOKEN
  server = http.createServer((req, res) => {
    if (!handleDeliveryDelete(req, res, root, process.env)) {
      res.statusCode = 404
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ error: 'not found' }))
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  base = `http://127.0.0.1:${address.port}`
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(root, { recursive: true, force: true })
})

type Reply = { status: number; headers: Headers; body: any }

async function del(id: string, headers: Record<string, string> = {}): Promise<Reply> {
  const res = await fetch(`${base}/api/deliveries/${id}`, {
    method: 'DELETE',
    headers: { origin: base, ...headers }
  })
  const text = await res.text()
  let body: any = text
  try {
    body = JSON.parse(text)
  } catch {
    /* 非 JSON（405 空 body） */
  }
  return { status: res.status, headers: res.headers, body }
}

function makeJob(id: string, size = 4096): { outDir: string; mp4: Buffer } {
  const outDir = path.join(root, 'issue-19', `b-track-${id}`, 'out')
  fs.mkdirSync(outDir, { recursive: true })
  const mp4 = Buffer.alloc(size, 7)
  fs.writeFileSync(path.join(outDir, 'final.mp4'), mp4)
  fs.writeFileSync(path.join(outDir, 'cover_16x9.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
  return { outDir, mp4 }
}

function findTrashDir(id: string): string {
  const parent = path.join(root, '.trash', 'deliveries')
  const hit = fs.existsSync(parent) ? fs.readdirSync(parent).find((name) => name.startsWith(`${id}-`)) : undefined
  assert.ok(hit, `expected .trash/deliveries/${id}-* to exist`)
  return path.join(parent, hit as string)
}

test('同源 DELETE 成功：200 + movedTo/bytes/files，out 目录不再有 mp4', async () => {
  const { outDir, mp4 } = makeJob('job-ok')
  const reply = await del('job-ok')
  assert.equal(reply.status, 200)
  assert.equal(reply.body.ok, true)
  assert.equal(reply.body.jobId, 'job-ok')
  assert.equal(reply.body.bytes, mp4.length + 4)
  assert.deepEqual([...reply.body.files].sort(), ['cover_16x9.jpg', 'final.mp4'])
  assert.ok(fs.existsSync(path.join(root, reply.body.movedTo, 'final.mp4')))
  assert.equal(fs.readdirSync(outDir).some((name) => name.endsWith('.mp4')), false)
})

test('回收站文件内容可回读；移回原目录后恢复原始字节', async () => {
  const { outDir, mp4 } = makeJob('job-restore')
  const first = await del('job-restore')
  assert.equal(first.status, 200)
  const trashed = path.join(root, first.body.movedTo, 'final.mp4')
  assert.deepEqual(fs.readFileSync(trashed), mp4)

  // 人工恢复：从 .trash 移回 out 目录（AC3 的恢复路径）。
  fs.renameSync(trashed, path.join(outDir, 'final.mp4'))
  assert.deepEqual(fs.readFileSync(path.join(outDir, 'final.mp4')), mp4)
  assert.equal(fs.existsSync(trashed), false)
})

test('重复删除 / 无 mp4 的 job → 404 且错误文案可读', async () => {
  makeJob('job-repeat')
  const first = await del('job-repeat')
  assert.equal(first.status, 200)
  const second = await del('job-repeat')
  assert.equal(second.status, 404)
  assert.equal(typeof second.body.error, 'string')
  assert.ok(second.body.error.length > 0)
})

test('不存在的 job → 404', async () => {
  const reply = await del('missing-job')
  assert.equal(reply.status, 404)
  assert.match(reply.body.error, /has no output|no output video/)
})

test('跨源无 token → 403', async () => {
  const reply = await del('job-ok', { origin: 'http://evil.example' })
  assert.equal(reply.status, 403)
})

test('错 token → 401', async () => {
  const reply = await del('job-ok', { 'x-web-token': 'wrong-token' })
  assert.equal(reply.status, 401)
})

test('服务端未配置 token 却带 token → 503', async () => {
  const previous = process.env.WEB_WRITE_TOKEN
  delete process.env.WEB_WRITE_TOKEN
  try {
    const reply = await del('job-ok', { 'x-web-token': 'anything' })
    assert.equal(reply.status, 503)
  } finally {
    process.env.WEB_WRITE_TOKEN = previous
  }
})

test('非法 id（解码后含 ..）→ 400', async () => {
  const reply = await del('bad%2e%2eid')
  assert.equal(reply.status, 400)
  assert.match(reply.body.error, /invalid delivery id/)
})

test('out 目录内 symlink 指向目录外 → 400，目录外文件零改动', async () => {
  makeJob('job-symlink')
  const outsideDir = path.join(root, '..', `deliveries107-outside-${process.pid}`)
  fs.mkdirSync(outsideDir, { recursive: true })
  const outside = path.join(outsideDir, 'outside.mp4')
  fs.writeFileSync(outside, Buffer.from('outside-payload'))
  const link = path.join(root, 'issue-19', 'b-track-job-symlink', 'out', 'link.mp4')
  fs.symlinkSync(outside, link)

  const before = fs.readFileSync(outside)
  const reply = await del('job-symlink')
  assert.equal(reply.status, 400)
  assert.match(reply.body.error, /symlink outside/)
  assert.deepEqual(fs.readFileSync(outside), before)
  assert.equal(fs.existsSync(path.join(root, 'issue-19', 'b-track-job-symlink', 'out', 'final.mp4')), true)

  fs.rmSync(outsideDir, { recursive: true, force: true })
})

test('非 DELETE 方法 → 405 + Allow: DELETE', async () => {
  const res = await fetch(`${base}/api/deliveries/job-ok`, { method: 'POST', headers: { origin: base } })
  assert.equal(res.status, 405)
  assert.equal(res.headers.get('allow'), 'DELETE')
  await res.text()
})

test('回收站目录命名含 job id 与时间戳', async () => {
  makeJob('job-naming')
  const reply = await del('job-naming')
  assert.equal(reply.status, 200)
  const name = path.basename(findTrashDir('job-naming'))
  assert.match(name, /^job-naming-\d{8}-\d{6}/)
})
