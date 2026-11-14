/**
 * #138 姿态参考库后端：校验矩阵 / CRUD / 鉴权 / 分页与过滤 / 原子写。
 *
 * HTTP 用例走真实的 `authorizeTaskWrite` + 真实文件读写（临时目录），
 * 路由与生产共用 `handlePoseLibraryRoute`。
 */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import type { AddressInfo } from 'node:net'
import type { FetchLike } from './pose-sync'

import { authorizeTaskWrite, readJson } from './api'
import {
  addPoseEntry,
  filterPoseEntries,
  githubRawHeaders,
  handlePoseLibraryRoute,
  normalizeGithubRawUrl,
  normalizeSourceUrl,
  poseLibraryDir,
  poseLibraryFile,
  readPoseEntries,
  validatePoseInput,
  writeJsonAtomic,
  type PoseEntry,
  type PoseLibraryDeps
} from './pose-library'

const TOKEN = 'pose-token'

const BASE = {
  label_zh: '正面站姿',
  source_url: 'https://example.com/poses/standing',
  license: 'CC0',
  license_evidence_url: 'https://example.com/poses/standing/license'
}

function freshRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pose-library-'))
}

// ---------------------------------------------------------------------------
// 纯函数：校验矩阵 / 归一化 / 原子写
// ---------------------------------------------------------------------------

test('必填与格式校验：缺字段、非中文、超长、非 https、未知 license、枚举、tags', () => {
  const cases: Array<{ name: string; body: any; error: string }> = [
    { name: '缺 label', body: { ...BASE, label_zh: undefined }, error: 'label_zh_invalid' },
    { name: '空 label', body: { ...BASE, label_zh: '   ' }, error: 'label_zh_invalid' },
    { name: '非中文 label', body: { ...BASE, label_zh: 'standing pose' }, error: 'label_zh_invalid' },
    { name: 'label 超 60 字', body: { ...BASE, label_zh: '正'.repeat(61) }, error: 'label_zh_invalid' },
    { name: 'source 非 https', body: { ...BASE, source_url: 'http://example.com/a' }, error: 'source_url_invalid' },
    { name: '缺 license', body: { ...BASE, license: undefined }, error: 'license_unverified' },
    { name: '未知 license', body: { ...BASE, license: 'GPL-3.0' }, error: 'license_unverified' },
    { name: '缺 evidence', body: { ...BASE, license_evidence_url: undefined }, error: 'license_unverified' },
    { name: 'evidence 非 https', body: { ...BASE, license_evidence_url: 'http://example.com/l' }, error: 'license_unverified' },
    { name: '显式未核', body: { ...BASE, license_verified: false }, error: 'license_unverified' },
    { name: 'preview 非 https', body: { ...BASE, preview_url: 'http://example.com/p.jpg' }, error: 'preview_url_invalid' },
    { name: 'preview 协议相对', body: { ...BASE, preview_url: '//cdn.example.com/p.jpg' }, error: 'preview_url_invalid' },
    { name: '未知 shot', body: { ...BASE, suitable_shots: ['portrait'] }, error: 'suitable_shots_invalid' },
    { name: 'shot 非数组', body: { ...BASE, suitable_shots: 'closeup' }, error: 'suitable_shots_invalid' },
    { name: 'tags 超 10', body: { ...BASE, tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }, error: 'tags_invalid' },
    { name: 'tags 含空串', body: { ...BASE, tags: ['ok', ' '] }, error: 'tags_invalid' },
    { name: 'note 超 500', body: { ...BASE, note: '备'.repeat(501) }, error: 'note_invalid' }
  ]

  for (const item of cases) {
    const result = validatePoseInput(item.body)
    assert.equal(result.ok, false, item.name)
    if (!result.ok) assert.equal(result.error, item.error, item.name)
  }
})

test('合法输入：默认值、中文标签、枚举去重、可选 preview', () => {
  const minimal = validatePoseInput(BASE)
  assert.equal(minimal.ok, true)
  if (minimal.ok) {
    assert.equal(minimal.value.label_zh, '正面站姿')
    assert.equal(minimal.value.preview_url, null)
    assert.deepEqual(minimal.value.suitable_shots, [])
    assert.deepEqual(minimal.value.tags, [])
    assert.equal(minimal.value.note, '')
  }

  const full = validatePoseInput({
    ...BASE,
    preview_url: '/media/artifact?path=pose%2F1.jpg',
    suitable_shots: ['action', 'closeup', 'action'],
    tags: ['站姿', '正面', '站姿'],
    note: '参考用'
  })
  assert.equal(full.ok, true)
  if (full.ok) {
    assert.equal(full.value.preview_url, '/media/artifact?path=pose%2F1.jpg')
    assert.deepEqual(full.value.suitable_shots, ['closeup', 'action'])
    assert.deepEqual(full.value.tags, ['站姿', '正面'])
  }

  assert.equal(validatePoseInput({ ...BASE, preview_url: 'https://cdn.example.com/1.jpg' }).ok, true)
})

test('source_url 归一化：host 大小写 / 根路径尾斜杠 / hash 视为同一来源', () => {
  assert.equal(
    normalizeSourceUrl('https://Example.com/poses/A/#frag'),
    'https://example.com/poses/A'
  )
  assert.equal(normalizeSourceUrl('https://example.com/poses/A'), 'https://example.com/poses/A')
  assert.notEqual(
    normalizeSourceUrl('https://example.com/poses/A?x=1'),
    normalizeSourceUrl('https://example.com/poses/A?x=2')
  )
})

test('原子写：内容完整落盘且不残留临时文件', () => {
  const root = freshRoot()
  const file = poseLibraryFile(root)
  writeJsonAtomic(file, [{ id: 'a' }])
  writeJsonAtomic(file, [{ id: 'b' }])
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), [{ id: 'b' }])
  assert.deepEqual(
    fs.readdirSync(poseLibraryDir(root)).filter((name) => name.includes('.tmp-')),
    []
  )
})

test('addPoseEntry 去重并返回 409 语义；文件保持原样', async () => {
  const root = freshRoot()
  const opts = {
    dataRoot: root,
    readJson,
    atomicWriteJson: writeJsonAtomic,
    now: () => new Date('2026-11-14T00:00:00.000Z')
  }
  const first = await addPoseEntry({
    ...opts,
    value: {
      label_zh: '正面站姿',
      preview_url: null,
      source_url: 'https://Example.com/poses/A/#one',
      license: 'CC0',
      license_evidence_url: 'https://example.com/license',
      suitable_shots: [],
      tags: [],
      note: ''
    }
  })
  assert.equal(first.ok, true)

  const dup = await addPoseEntry({
    ...opts,
    value: {
      label_zh: '另一个',
      preview_url: null,
      source_url: 'https://example.com/poses/A',
      license: 'MIT',
      license_evidence_url: 'https://example.com/license',
      suitable_shots: [],
      tags: [],
      note: ''
    }
  })
  assert.equal(dup.ok, false)
  if (!dup.ok) assert.equal(dup.error, 'duplicate_source_url')
  assert.equal(readPoseEntries(root, readJson).length, 1)
})

test('filterPoseEntries：q / license / shot 组合过滤，非法过滤值 400', () => {
  const entries: PoseEntry[] = [
    {
      id: '1',
      label_zh: '坐姿侧面',
      preview_url: null,
      source_url: 'https://example.com/1',
      license: 'CC0',
      license_evidence_url: 'https://example.com/l1',
      license_verified: true,
      suitable_shots: ['medium'],
      tags: ['坐姿'],
      note: '',
      created_at: '2026-11-14T01:00:00.000Z'
    },
    {
      id: '2',
      label_zh: '跑步动作',
      preview_url: null,
      source_url: 'https://example.com/2',
      license: 'CC-BY-4.0',
      license_evidence_url: 'https://example.com/l2',
      license_verified: true,
      suitable_shots: ['action', 'full_body'],
      tags: ['运动'],
      note: '户外',
      created_at: '2026-11-14T02:00:00.000Z'
    }
  ]

  const all = filterPoseEntries(entries, { q: '', license: '', shot: '', limit: 20, offset: 0 })
  assert.equal(all.ok, true)
  if (all.ok) {
    assert.equal(all.total, 2)
    assert.deepEqual(all.items.map((e) => e.id), ['2', '1'])
  }

  const filtered = filterPoseEntries(entries, { q: '运动', license: 'CC-BY-4.0', shot: 'action', limit: 20, offset: 0 })
  assert.equal(filtered.ok, true)
  if (filtered.ok) assert.deepEqual(filtered.items.map((e) => e.id), ['2'])

  const badLicense = filterPoseEntries(entries, { q: '', license: 'GPL-3.0', shot: '', limit: 20, offset: 0 })
  assert.equal(badLicense.ok, false)
  if (!badLicense.ok) assert.equal(badLicense.error, 'license_invalid')

  const badShot = filterPoseEntries(entries, { q: '', license: '', shot: 'portrait', limit: 20, offset: 0 })
  assert.equal(badShot.ok, false)
  if (!badShot.ok) assert.equal(badShot.error, 'shot_invalid')
})

// ---------------------------------------------------------------------------
// HTTP：真实 authorizeTaskWrite + 临时 dataRoot
// ---------------------------------------------------------------------------

let server: http.Server
let intakeServer: http.Server
let root = ''
let base = ''
let tick = 0
let deps: PoseLibraryDeps
let previewFetch: FetchLike = async () => {
  throw new Error('preview fetch not configured for this test')
}
let intakeMode: 'ok' | 'reject' = 'ok'
let intakeCalls = 0
let poseSeq = 0

before(async () => {
  root = freshRoot()
  intakeServer = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/intake/uploads') {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const body = Buffer.concat(chunks)
        if (intakeMode === 'reject') {
          res.statusCode = 500
          res.end(JSON.stringify({ error: 'intake_boom' }))
          return
        }
        intakeCalls += 1
        const id = String(req.headers['x-upload-id'] ?? '')
        const ext = path.extname(String(req.headers['x-filename'] ?? ''))
        res.statusCode = 201
        res.setHeader('Content-Type', 'application/json')
        res.end(
          JSON.stringify({
            upload_id: id,
            path: `/studio/uploads/${id}/source${ext}`,
            size: body.length,
            sha256: crypto.createHash('sha256').update(body).digest('hex')
          })
        )
      })
      return
    }
    res.statusCode = 404
    res.end('{}')
  })
  await new Promise<void>((resolve) => intakeServer.listen(0, '127.0.0.1', resolve))
  const intakeUrl = `http://127.0.0.1:${(intakeServer.address() as AddressInfo).port}`

  const env = { WEB_WRITE_TOKEN: TOKEN } as NodeJS.ProcessEnv
  deps = {
    dataRoot: root,
    readJson,
    atomicWriteJson: writeJsonAtomic,
    readBody: (req) =>
      new Promise((resolve, reject) => {
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
      }),
    authorize: (req) => authorizeTaskWrite(req, env),
    sendJson: (res, status, body) => {
      res.statusCode = status
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(body))
    },
    now: () => new Date(Date.UTC(2026, 10, 14, 0, 0, tick++)),
    fetchImpl: (input, init) => previewFetch(input, init),
    uploads: { intakeUrl, webToken: TOKEN }
  }
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    handlePoseLibraryRoute(req, res, url, decodeURIComponent(url.pathname), deps)
      .then((handled) => {
        if (!handled) {
          res.statusCode = 404
          res.end()
        }
      })
      .catch((err: Error) => {
        res.statusCode = 500
        res.end(err.message)
      })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(() => {
  server.close()
  intakeServer.close()
})

function resetLibrary(): void {
  fs.rmSync(poseLibraryDir(root), { recursive: true, force: true })
}

async function request(
  method: string,
  pathname: string,
  body?: unknown,
  headers: Record<string, string> = { 'X-Web-Token': TOKEN }
) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await res.text()
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null }
}

async function post(body: unknown, headers?: Record<string, string>) {
  return request('POST', '/api/pose-library', body, headers)
}

test('GET 公开只读：空库 200，分页元信息完整', async () => {
  resetLibrary()
  const res = await request('GET', '/api/pose-library', undefined, {})
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { items: [], total: 0, limit: 20, offset: 0 })
})

test('鉴权：跨源无 token 403、错 token 401、正确 token 201', async () => {
  resetLibrary()
  const denied = await post(BASE, { Origin: 'http://evil.example' })
  assert.equal(denied.status, 403)

  const wrong = await post(BASE, { Origin: 'http://evil.example', 'X-Web-Token': 'wrong' })
  assert.equal(wrong.status, 401)

  const ok = await post(BASE, { Origin: 'http://evil.example', 'X-Web-Token': TOKEN })
  assert.equal(ok.status, 201)
  assert.equal(ok.body.item.license_verified, true)
  assert.equal(ok.body.item.source_url, BASE.source_url)
  assert.equal(ok.body.item.license_evidence_url, BASE.license_evidence_url)
  assert.match(String(ok.body.item.id), /^pose_/)
  assert.match(String(ok.body.item.created_at), /^\d{4}-\d{2}-\d{2}T/)
})

test('HTTP 校验失败：未核 license 400 license_unverified 且不落库', async () => {
  resetLibrary()
  const res = await post({ ...BASE, license_evidence_url: undefined })
  assert.equal(res.status, 400)
  assert.equal(res.body.error, 'license_unverified')
  assert.equal(fs.existsSync(poseLibraryFile(root)), false)
})

test('HTTP 去重：归一化后相同 source_url 409，库内仍一条', async () => {
  resetLibrary()
  const first = await post({ ...BASE, source_url: 'https://Example.com/poses/A/#one' })
  assert.equal(first.status, 201)

  const dup = await post({ ...BASE, label_zh: '另一个标签', source_url: 'https://example.com/poses/A' })
  assert.equal(dup.status, 409)
  assert.equal(dup.body.error, 'duplicate_source_url')

  const rows = JSON.parse(fs.readFileSync(poseLibraryFile(root), 'utf8'))
  assert.equal(rows.length, 1)
})

test('GET filter + 分页：q / license / shot / limit / offset', async () => {
  resetLibrary()
  await post({
    ...BASE,
    label_zh: '坐姿侧面',
    source_url: 'https://example.com/poses/sit',
    license: 'CC0',
    suitable_shots: ['medium'],
    tags: ['坐姿']
  })
  await post({
    ...BASE,
    label_zh: '跑步动作',
    source_url: 'https://example.com/poses/run',
    license: 'CC-BY-4.0',
    suitable_shots: ['action', 'full_body'],
    tags: ['运动'],
    note: '户外'
  })
  await post({
    ...BASE,
    label_zh: '全身正面',
    source_url: 'https://example.com/poses/full',
    license: 'CC-BY-4.0',
    suitable_shots: ['full_body'],
    tags: ['站姿']
  })

  const all = await request('GET', '/api/pose-library', undefined, {})
  assert.equal(all.status, 200)
  assert.equal(all.body.total, 3)
  assert.deepEqual(all.body.items.map((e: any) => e.label_zh), ['全身正面', '跑步动作', '坐姿侧面'])
  assert.equal(all.body.items[0].license_verified, true)

  const byQ = await request('GET', '/api/pose-library?q=运动', undefined, {})
  assert.deepEqual(byQ.body.items.map((e: any) => e.label_zh), ['跑步动作'])

  const byLicense = await request('GET', '/api/pose-library?license=CC-BY-4.0', undefined, {})
  assert.equal(byLicense.body.total, 2)

  const byShot = await request('GET', '/api/pose-library?shot=full_body', undefined, {})
  assert.equal(byShot.body.total, 2)

  const page = await request('GET', '/api/pose-library?limit=1&offset=1', undefined, {})
  assert.equal(page.body.total, 3)
  assert.equal(page.body.limit, 1)
  assert.equal(page.body.offset, 1)
  assert.deepEqual(page.body.items.map((e: any) => e.label_zh), ['跑步动作'])

  const badPage = await request('GET', '/api/pose-library?limit=-1', undefined, {})
  assert.equal(badPage.status, 400)
  assert.equal(badPage.body.error, 'invalid_pagination')
})

test('DELETE：无 token 403；正确 token 200 并持久化；未知 id 404；错误方法 405', async () => {
  resetLibrary()
  const created = await post({ ...BASE, source_url: 'https://example.com/poses/delete-me' })
  assert.equal(created.status, 201)
  const id = created.body.item.id

  const denied = await request('DELETE', `/api/pose-library/${id}`, undefined, {
    Origin: 'http://evil.example'
  })
  assert.equal(denied.status, 403)

  const removed = await request('DELETE', `/api/pose-library/${id}`)
  assert.equal(removed.status, 200)
  assert.equal(removed.body.ok, true)
  assert.equal(removed.body.item.id, id)
  assert.equal(readPoseEntries(root, readJson).length, 0)

  const missing = await request('DELETE', `/api/pose-library/pose_missing`)
  assert.equal(missing.status, 404)

  const wrongMethod = await request('PATCH', '/api/pose-library', undefined)
  assert.equal(wrongMethod.status, 405)
  assert.equal(wrongMethod.headers.get('allow'), 'GET, HEAD, POST')

  const wrongDelete = await post({ ...BASE, source_url: 'https://example.com/poses/x' })
  const wrongDeleteMethod = await request('POST', `/api/pose-library/${wrongDelete.body.item.id}`)
  assert.equal(wrongDeleteMethod.status, 405)
  assert.equal(wrongDeleteMethod.headers.get('allow'), 'DELETE')
})

test('落盘为完整 JSON 数组且无临时文件残留', async () => {
  resetLibrary()
  await post({ ...BASE, source_url: 'https://example.com/poses/atomic-1' })
  await post({ ...BASE, source_url: 'https://example.com/poses/atomic-2' })

  const rows = JSON.parse(fs.readFileSync(poseLibraryFile(root), 'utf8'))
  assert.equal(rows.length, 2)
  assert.equal(rows.every((row: any) => row.license_verified === true), true)
  assert.deepEqual(
    fs.readdirSync(poseLibraryDir(root)).filter((name) => name.includes('.tmp-')),
    []
  )
})

// ---------------------------------------------------------------------------
// #138 materialize：pose preview → uploads → studio intake
// ---------------------------------------------------------------------------

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02])

async function createPose(previewUrl: string | null) {
  poseSeq += 1
  const res = await post({
    ...BASE,
    source_url: `https://example.com/poses/materialize-${poseSeq}`,
    preview_url: previewUrl
  })
  assert.equal(res.status, 201)
  return res.body.item as any
}

function pngFetch(bytes = PNG): FetchLike {
  return async () =>
    new Response(bytes, { status: 200, headers: { 'Content-Type': 'image/png' } })
}

test('normalizeGithubRawUrl：raw 直链归一为 contents API，非 raw 不转换', () => {
  assert.equal(
    normalizeGithubRawUrl(
      'https://raw.githubusercontent.com/dmlc/gluon-cv/HEAD/docs/_static/action-recognition.png'
    ),
    'https://api.github.com/repos/dmlc/gluon-cv/contents/docs/_static/action-recognition.png?ref=HEAD'
  )
  // 非 raw 域名 / 非 https / 路径不足 owner+repo+ref+path 一律不转换。
  assert.equal(normalizeGithubRawUrl('https://cdn.example.com/a/b/main/x.png'), null)
  assert.equal(normalizeGithubRawUrl('https://raw.githubusercontent.com/dmlc/gluon-cv/HEAD'), null)
  assert.equal(normalizeGithubRawUrl('http://raw.githubusercontent.com/dmlc/gluon-cv/HEAD/x.png'), null)
})

test('githubRawHeaders：Accept raw；GITHUB_TOKEN 非空才加 Bearer', () => {
  const anonymous = githubRawHeaders({} as NodeJS.ProcessEnv)
  assert.equal(anonymous.Accept, 'application/vnd.github.raw')
  assert.equal(anonymous.Authorization, undefined)
  assert.equal(githubRawHeaders({ GITHUB_TOKEN: '  ' } as NodeJS.ProcessEnv).Authorization, undefined)
  assert.equal(
    githubRawHeaders({ GITHUB_TOKEN: 'tok-mock' } as NodeJS.ProcessEnv).Authorization,
    'Bearer tok-mock'
  )
})

test('materialize：raw 直链失败时用 contents API 兜底（带 raw Accept + token）', async () => {
  const raw = 'https://raw.githubusercontent.com/dmlc/gluon-cv/HEAD/docs/_static/a.png'
  const entry = await createPose(raw)
  const calls: Array<{ url: string; init?: RequestInit }> = []
  deps.env = { ...(deps.env ?? {}), GITHUB_TOKEN: 'tok-mock' }
  previewFetch = async (url, init) => {
    calls.push({ url, init })
    if (url === raw) throw new Error('raw egress blocked')
    return new Response(PNG, {
      status: 200,
      headers: { 'Content-Type': 'application/vnd.github.raw' }
    })
  }

  try {
    const res = await request('POST', `/api/pose-library/${entry.id}/materialize`)
    assert.equal(res.status, 200)
    assert.equal(res.body.filename, `pose-${entry.id}.png`)
    assert.deepEqual(fs.readFileSync(path.join(root, 'uploads', res.body.upload_id, 'source.png')), PNG)
    assert.equal(calls.length, 2)
    assert.equal(
      calls[1].url,
      'https://api.github.com/repos/dmlc/gluon-cv/contents/docs/_static/a.png?ref=HEAD'
    )
    const headers = calls[1].init?.headers as Record<string, string>
    assert.equal(headers.Accept, 'application/vnd.github.raw')
    assert.equal(headers.Authorization, 'Bearer tok-mock')
  } finally {
    deps.env = { WEB_WRITE_TOKEN: TOKEN }
  }
})

test('materialize：原 URL 与 API 兜底都失败才 400，reason 记录两段错误', async () => {
  const raw = 'https://raw.githubusercontent.com/dmlc/gluon-cv/HEAD/docs/_static/b.png'
  const entry = await createPose(raw)
  previewFetch = async (url) => {
    if (url === raw) throw new Error('raw egress blocked')
    return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } })
  }

  const res = await request('POST', `/api/pose-library/${entry.id}/materialize`)
  assert.equal(res.status, 400)
  assert.equal(res.body.error, 'preview_unavailable')
  assert.equal(res.body.reason, 'fetch_failed|github_api_status_404')
})

test('materialize：非 GitHub URL 失败不触发 API 兜底', async () => {
  const entry = await createPose('https://cdn.example.com/broken.png')
  const calls: string[] = []
  previewFetch = async (url) => {
    calls.push(url)
    throw new Error('cdn down')
  }

  const res = await request('POST', `/api/pose-library/${entry.id}/materialize`)
  assert.equal(res.status, 400)
  assert.equal(res.body.reason, 'fetch_failed')
  assert.deepEqual(calls, ['https://cdn.example.com/broken.png'])
})

test('materialize 成功：HTTPS PNG 落盘 uploads、meta ready 并转发 studio', async () => {
  const entry = await createPose('https://cdn.example.com/pose.png')
  previewFetch = pngFetch()
  const before = intakeCalls

  const res = await request('POST', `/api/pose-library/${entry.id}/materialize`)
  assert.equal(res.status, 200)
  assert.match(String(res.body.upload_id), /^up-/)
  assert.equal(res.body.filename, `pose-${entry.id}.png`)
  assert.equal(res.body.size, PNG.length)
  assert.equal(res.body.sha256, crypto.createHash('sha256').update(PNG).digest('hex'))
  assert.equal(res.body.studio_path, `/studio/uploads/${res.body.upload_id}/source.png`)
  assert.equal(intakeCalls, before + 1)

  const dir = path.join(root, 'uploads', res.body.upload_id)
  assert.deepEqual(fs.readFileSync(path.join(dir, 'source.png')), PNG)
  const meta = readJson(path.join(dir, 'meta.json'))
  assert.equal(meta.status, 'ready')
  assert.equal(meta.studio_path, res.body.studio_path)
  assert.equal(meta.pose_id, entry.id)
  assert.equal(meta.source_url, entry.source_url)
})

test('materialize 成功：站内 /media/artifact 预览路径', async () => {
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01])
  fs.mkdirSync(path.join(root, 'media'), { recursive: true })
  fs.writeFileSync(path.join(root, 'media', 'pose-local.jpg'), bytes)
  const entry = await createPose('/media/artifact?path=media%2Fpose-local.jpg')

  const res = await request('POST', `/api/pose-library/${entry.id}/materialize`)
  assert.equal(res.status, 200)
  assert.equal(res.body.filename, `pose-${entry.id}.jpg`)
  assert.equal(res.body.size, bytes.length)
  assert.deepEqual(fs.readFileSync(path.join(root, 'uploads', res.body.upload_id, 'source.jpg')), bytes)
})

test('materialize 拒绝非图片与超限：400 preview_unavailable 且不建 upload', async () => {
  const uploadsBefore = fs.existsSync(path.join(root, 'uploads'))
    ? fs.readdirSync(path.join(root, 'uploads')).length
    : 0
  const html = await createPose('https://cdn.example.com/page.html')
  previewFetch = async () =>
    new Response('<html></html>', { status: 200, headers: { 'Content-Type': 'text/html' } })
  const htmlRes = await request('POST', `/api/pose-library/${html.id}/materialize`)
  assert.equal(htmlRes.status, 400)
  assert.equal(htmlRes.body.error, 'preview_unavailable')

  const big = await createPose('https://cdn.example.com/huge.png')
  previewFetch = async () =>
    new Response(PNG, {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'Content-Length': String(15 * 1024 * 1024 + 1)
      }
    })
  const bigRes = await request('POST', `/api/pose-library/${big.id}/materialize`)
  assert.equal(bigRes.status, 400)
  assert.equal(bigRes.body.error, 'preview_unavailable')

  const uploadsAfter = fs.existsSync(path.join(root, 'uploads'))
    ? fs.readdirSync(path.join(root, 'uploads')).length
    : 0
  assert.equal(uploadsAfter, uploadsBefore)
})

test('materialize 404 / 409 / 站内路径穿越', async () => {
  const missing = await request('POST', '/api/pose-library/pose_missing/materialize')
  assert.equal(missing.status, 404)
  assert.equal(missing.body.error, 'not_found')

  const noPreview = await createPose(null)
  const empty = await request('POST', `/api/pose-library/${noPreview.id}/materialize`)
  assert.equal(empty.status, 409)
  assert.equal(empty.body.error, 'preview_missing')

  const traversal = await createPose('/media/artifact?path=..%2F..%2Fetc%2Fpasswd')
  const escaped = await request('POST', `/api/pose-library/${traversal.id}/materialize`)
  assert.equal(escaped.status, 400)
  assert.equal(escaped.body.error, 'preview_unavailable')
})

test('materialize 鉴权：跨源无 token 403、错 token 401', async () => {
  const entry = await createPose('https://cdn.example.com/auth.png')
  previewFetch = pngFetch()

  const denied = await request('POST', `/api/pose-library/${entry.id}/materialize`, undefined, {
    Origin: 'http://evil.example'
  })
  assert.equal(denied.status, 403)

  const wrong = await request('POST', `/api/pose-library/${entry.id}/materialize`, undefined, {
    'X-Web-Token': 'wrong'
  })
  assert.equal(wrong.status, 401)
})

test('materialize staging 失败：502 studio_stage_failed，本地 source/meta 保留可重试', async () => {
  const entry = await createPose('https://cdn.example.com/stage.png')
  previewFetch = pngFetch()
  intakeMode = 'reject'
  try {
    const res = await request('POST', `/api/pose-library/${entry.id}/materialize`)
    assert.equal(res.status, 502)
    assert.equal(res.body.error, 'studio_stage_failed')
    assert.match(String(res.body.upload_id), /^up-/)

    const dir = path.join(root, 'uploads', res.body.upload_id)
    assert.deepEqual(fs.readFileSync(path.join(dir, 'source.png')), PNG)
    const meta = readJson(path.join(dir, 'meta.json'))
    assert.equal(meta.status, 'ready')
    assert.equal(meta.studio_path, null)
  } finally {
    intakeMode = 'ok'
  }

  const retried = await request('POST', `/api/pose-library/${entry.id}/materialize`)
  assert.equal(retried.status, 200)
  assert.notEqual(retried.body.upload_id, undefined)
})
