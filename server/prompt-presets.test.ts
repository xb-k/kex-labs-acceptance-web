/**
 * #137 提示词模板版本化后端：校验矩阵 / CRUD / 版本递增 / 并发写 / 去重 /
 * 上限 / 引用校验 / 鉴权 / 原子写。
 *
 * HTTP 用例走真实的 `authorizeTaskWrite` + 真实文件读写（临时目录），
 * 路由与生产共用 `handlePromptPresetsRoute`。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import type { AddressInfo } from 'node:net'

import { authorizeTaskWrite, readJson } from './api'
import { writeJsonAtomic } from './pose-library'
import {
  appendPresetVersion,
  createPreset,
  deletePreset,
  handlePromptPresetsRoute,
  promptPresetsDir,
  promptPresetsFile,
  readPromptPresets,
  selectVersion,
  validateCreateInput,
  validatePresetReference,
  validateVersionInput,
  type PromptPreset,
  type PromptPresetsDeps
} from './prompt-presets'

const TOKEN = 'preset-token'

function freshRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-presets-'))
}

function seedPreset(overrides: Partial<PromptPreset> = {}): PromptPreset {
  return {
    id: 'preset_seed',
    name: '种子模板',
    current_version: 1,
    created_at: '2026-11-14T00:00:00.000Z',
    updated_at: '2026-11-14T00:00:00.000Z',
    versions: [
      {
        version: 1,
        prompt: '第一版提示词',
        params: {},
        note: '',
        created_at: '2026-11-14T00:00:00.000Z'
      }
    ],
    ...overrides
  }
}

// ---------------------------------------------------------------------------
// 纯函数：校验矩阵 / 版本选择 / 引用校验
// ---------------------------------------------------------------------------

test('创建校验：name/prompt/params/note 的非法矩阵', () => {
  const cases: Array<{ name: string; body: any; error: string }> = [
    { name: '非对象 body', body: 'x', error: 'invalid_body' },
    { name: '缺 name', body: { prompt: 'x' }, error: 'name_invalid' },
    { name: '空 name', body: { name: '   ', prompt: 'x' }, error: 'name_invalid' },
    { name: 'name 超 60 字', body: { name: '名'.repeat(61), prompt: 'x' }, error: 'name_invalid' },
    { name: '缺 prompt', body: { name: '模板' }, error: 'prompt_invalid' },
    { name: '空 prompt', body: { name: '模板', prompt: '  ' }, error: 'prompt_invalid' },
    { name: 'prompt 超 8000 字', body: { name: '模板', prompt: '字'.repeat(8001) }, error: 'prompt_invalid' },
    { name: 'params 是数组', body: { name: '模板', prompt: 'x', params: [] }, error: 'params_invalid' },
    { name: 'params 是字符串', body: { name: '模板', prompt: 'x', params: 'nope' }, error: 'params_invalid' },
    { name: 'note 非字符串', body: { name: '模板', prompt: 'x', note: 1 }, error: 'note_invalid' }
  ]

  for (const item of cases) {
    const result = validateCreateInput(item.body)
    assert.equal(result.ok, false, item.name)
    if (!result.ok) assert.equal(result.error, item.error, item.name)
  }
})

test('合法创建：name 去空白、params 缺省 {}、prompt 保留原格式、边界 60/8000 通过', () => {
  const result = validateCreateInput({
    name: '  模板 A  ',
    prompt: '第一行\n第二行',
    note: '说明'
  })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.value.name, '模板 A')
    assert.deepEqual(result.value.params, {})
    assert.equal(result.value.prompt, '第一行\n第二行')
    assert.equal(result.value.note, '说明')
  }

  const boundary = validateCreateInput({
    name: '名'.repeat(60),
    prompt: '字'.repeat(8000),
    params: { temperature: 0.6, seed: 137 }
  })
  assert.equal(boundary.ok, true)
  if (boundary.ok) assert.equal(boundary.value.params.seed, 137)
})

test('追加版本校验：必须给 prompt；可选改名同样受 60 字限制', () => {
  assert.equal(validateVersionInput({}).ok, false)
  const renamed = validateVersionInput({ prompt: 'v2', name: '新名字' })
  assert.equal(renamed.ok, true)
  if (renamed.ok) assert.equal(renamed.value.name, '新名字')

  const badName = validateVersionInput({ prompt: 'v2', name: '名'.repeat(61) })
  assert.equal(badName.ok, false)
  if (!badName.ok) assert.equal(badName.error, 'name_invalid')
})

test('selectVersion：显式版本不存在的返回 null，不静默回退 current', () => {
  const preset = seedPreset()
  assert.equal(selectVersion(preset)?.version, 1)
  assert.equal(selectVersion(preset, 1)?.version, 1)
  assert.equal(selectVersion(preset, 2), null)
})

test('validatePresetReference：不存在 400 preset_not_found / 版本不存在 400 preset_version_not_found', () => {
  const root = freshRoot()
  writeJsonAtomic(promptPresetsFile(root), { presets: [seedPreset()] })

  const ok = validatePresetReference({ dataRoot: root, id: 'preset_seed', readJson })
  assert.equal(ok.ok, true)
  if (ok.ok) {
    assert.equal(ok.version.version, 1)
    assert.equal(ok.is_current, true)
  }

  const missingPreset = validatePresetReference({ dataRoot: root, id: 'preset_nope', readJson })
  assert.equal(missingPreset.ok, false)
  if (!missingPreset.ok) assert.equal(missingPreset.error, 'preset_not_found')

  const missingVersion = validatePresetReference({
    dataRoot: root,
    id: 'preset_seed',
    version: 9,
    readJson
  })
  assert.equal(missingVersion.ok, false)
  if (!missingVersion.ok) assert.equal(missingVersion.error, 'preset_version_not_found')
})

// ---------------------------------------------------------------------------
// 直接调用：CRUD / 版本递增 / 去重 / 并发
// ---------------------------------------------------------------------------

test('createPreset：生成 v1、current_version=1、id/时间戳由服务端派生', async () => {
  const root = freshRoot()
  const created = await createPreset({
    dataRoot: root,
    input: { name: '首版', prompt: 'hello', params: { cfg: 7 }, note: '' },
    readJson,
    atomicWriteJson: writeJsonAtomic
  })
  assert.equal(created.ok, true)
  if (created.ok) {
    assert.match(created.preset.id, /^preset_/)
    assert.equal(created.preset.current_version, 1)
    assert.equal(created.version.version, 1)
    assert.equal(created.version.prompt, 'hello')
  }

  const raw = JSON.parse(fs.readFileSync(promptPresetsFile(root), 'utf8'))
  assert.equal(raw.presets.length, 1)
  assert.equal(raw.presets[0].versions[0].version, 1)
  assert.equal(raw.presets[0].versions[0].params.cfg, 7)
})

test('名称去重：大小写/空白归一后重复返回 409 duplicate_name，库内仍一条', async () => {
  const root = freshRoot()
  const first = await createPreset({
    dataRoot: root,
    input: { name: 'Hero Shot', prompt: 'a', params: {}, note: '' },
    readJson,
    atomicWriteJson: writeJsonAtomic
  })
  assert.equal(first.ok, true)

  const dup = await createPreset({
    dataRoot: root,
    input: { name: '  hero shot  ', prompt: 'b', params: {}, note: '' },
    readJson,
    atomicWriteJson: writeJsonAtomic
  })
  assert.equal(dup.ok, false)
  if (!dup.ok) assert.equal(dup.error, 'duplicate_name')
  assert.equal(readPromptPresets(root, readJson).length, 1)
})

test('appendPresetVersion：version+1、current 推进、旧版本内容不变', async () => {
  const root = freshRoot()
  const created = await createPreset({
    dataRoot: root,
    input: { name: '迭代', prompt: 'v1 prompt', params: {}, note: '初版' },
    readJson,
    atomicWriteJson: writeJsonAtomic
  })
  assert.equal(created.ok, true)
  if (!created.ok) return

  const appended = await appendPresetVersion({
    dataRoot: root,
    id: created.preset.id,
    input: { prompt: 'v2 prompt', params: { cfg: 9 }, note: '二版' },
    readJson,
    atomicWriteJson: writeJsonAtomic
  })
  assert.equal(appended.ok, true)
  if (!appended.ok) return
  assert.equal(appended.version.version, 2)
  assert.equal(appended.preset.current_version, 2)

  const stored = readPromptPresets(root, readJson)[0]
  assert.equal(stored.versions.length, 2)
  assert.equal(stored.versions[0].prompt, 'v1 prompt')
  assert.equal(stored.versions[1].prompt, 'v2 prompt')
  assert.equal(stored.versions[1].params.cfg, 9)
})

test('版本上限：50 个版本后再追加 409 version_limit，文件不变', async () => {
  const root = freshRoot()
  const preset = seedPreset({
    current_version: 50,
    versions: Array.from({ length: 50 }, (_, i) => ({
      version: i + 1,
      prompt: `prompt-${i + 1}`,
      params: {},
      note: '',
      created_at: '2026-11-14T00:00:00.000Z'
    }))
  })
  writeJsonAtomic(promptPresetsFile(root), { presets: [preset] })

  const overflow = await appendPresetVersion({
    dataRoot: root,
    id: preset.id,
    input: { prompt: '第 51 版', params: {}, note: '' },
    readJson,
    atomicWriteJson: writeJsonAtomic
  })
  assert.equal(overflow.ok, false)
  if (!overflow.ok) {
    assert.equal(overflow.status, 409)
    assert.equal(overflow.error, 'version_limit')
  }
  const stored = readPromptPresets(root, readJson)[0]
  assert.equal(stored.versions.length, 50)
  assert.equal(stored.current_version, 50)
})

test('并发 append：8 个 PUT 并发后版本连续 1..9，无丢失', async () => {
  const root = freshRoot()
  const created = await createPreset({
    dataRoot: root,
    input: { name: '并发', prompt: 'v1', params: {}, note: '' },
    readJson,
    atomicWriteJson: writeJsonAtomic
  })
  assert.equal(created.ok, true)
  if (!created.ok) return

  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      appendPresetVersion({
        dataRoot: root,
        id: created.preset.id,
        input: { prompt: `并发-${i}`, params: {}, note: '' },
        readJson,
        atomicWriteJson: writeJsonAtomic
      })
    )
  )
  assert.equal(results.every((result) => result.ok), true)

  const stored = readPromptPresets(root, readJson)[0]
  assert.equal(stored.versions.length, 9)
  assert.equal(stored.current_version, 9)
  assert.deepEqual(
    stored.versions.map((entry) => entry.version),
    [1, 2, 3, 4, 5, 6, 7, 8, 9]
  )
})

test('并发 create 同名：一个成功一个 409，库内仍一条', async () => {
  const root = freshRoot()
  const [a, b] = await Promise.all([
    createPreset({
      dataRoot: root,
      input: { name: '同名', prompt: 'a', params: {}, note: '' },
      readJson,
      atomicWriteJson: writeJsonAtomic
    }),
    createPreset({
      dataRoot: root,
      input: { name: '同名', prompt: 'b', params: {}, note: '' },
      readJson,
      atomicWriteJson: writeJsonAtomic
    })
  ])
  assert.equal([a.ok, b.ok].filter(Boolean).length, 1)
  assert.equal([a.ok, b.ok].filter((ok) => !ok).length, 1)
  assert.equal(readPromptPresets(root, readJson).length, 1)
})

test('原子写：落盘为完整 {presets:[...]}，无临时文件残留', async () => {
  const root = freshRoot()
  const created = await createPreset({
    dataRoot: root,
    input: { name: '原子', prompt: 'a', params: {}, note: '' },
    readJson,
    atomicWriteJson: writeJsonAtomic
  })
  assert.equal(created.ok, true)
  if (created.ok) {
    await appendPresetVersion({
      dataRoot: root,
      id: created.preset.id,
      input: { prompt: 'b', params: {}, note: '' },
      readJson,
      atomicWriteJson: writeJsonAtomic
    })
  }

  const raw = JSON.parse(fs.readFileSync(promptPresetsFile(root), 'utf8'))
  assert.equal(Array.isArray(raw.presets), true)
  assert.equal(raw.presets.length, 1)
  assert.equal(raw.presets[0].versions.length, 2)
  assert.deepEqual(
    fs.readdirSync(promptPresetsDir(root)).filter((name) => name.includes('.tmp-')),
    []
  )
})

test('deletePreset：删除返回摘要，二次删除返回 null', async () => {
  const root = freshRoot()
  const created = await createPreset({
    dataRoot: root,
    input: { name: '待删', prompt: 'a', params: {}, note: '' },
    readJson,
    atomicWriteJson: writeJsonAtomic
  })
  assert.equal(created.ok, true)
  if (!created.ok) return

  const removed = await deletePreset({
    dataRoot: root,
    id: created.preset.id,
    readJson,
    atomicWriteJson: writeJsonAtomic
  })
  assert.notEqual(removed, null)
  assert.equal(readPromptPresets(root, readJson).length, 0)

  const again = await deletePreset({
    dataRoot: root,
    id: created.preset.id,
    readJson,
    atomicWriteJson: writeJsonAtomic
  })
  assert.equal(again, null)
})

// ---------------------------------------------------------------------------
// HTTP：真实 authorizeTaskWrite + 临时 dataRoot
// ---------------------------------------------------------------------------

let server: http.Server
let root = ''
let base = ''
let tick = 0
let deps: PromptPresetsDeps

before(async () => {
  root = freshRoot()
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
          if (!data.trim()) {
            reject(new Error('empty body'))
            return
          }
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
    now: () => new Date(Date.UTC(2026, 10, 14, 0, 0, tick++))
  }
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    handlePromptPresetsRoute(req, res, url, decodeURIComponent(url.pathname), deps)
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
})

function resetLibrary(): void {
  fs.rmSync(promptPresetsDir(root), { recursive: true, force: true })
}

async function rawRequest(
  method: string,
  pathname: string,
  body: string,
  headers: Record<string, string>
) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body
  })
  const text = await res.text()
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null }
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
  return request('POST', '/api/prompt-presets', body, headers)
}

test('HTTP 鉴权：GET 公开；POST/PUT/DELETE 跨源无 token 403、错 token 401、正确 token 通过', async () => {
  resetLibrary()

  const list = await request('GET', '/api/prompt-presets', undefined, {})
  assert.equal(list.status, 200)
  assert.deepEqual(list.body, { items: [], total: 0 })

  const denied = await post({ name: 'x', prompt: 'p' }, { Origin: 'http://evil.example' })
  assert.equal(denied.status, 403)

  const wrong = await post(
    { name: 'x', prompt: 'p' },
    { Origin: 'http://evil.example', 'X-Web-Token': 'wrong' }
  )
  assert.equal(wrong.status, 401)

  const created = await request('POST', '/api/prompt-presets', { name: 'x', prompt: 'p' }, {
    Origin: 'http://evil.example',
    'X-Web-Token': TOKEN
  })
  assert.equal(created.status, 201)
  const id = created.body.item.id

  const deniedPut = await request('PUT', `/api/prompt-presets/${id}`, { prompt: 'p2' }, {
    Origin: 'http://evil.example'
  })
  assert.equal(deniedPut.status, 403)

  const deniedDelete = await request('DELETE', `/api/prompt-presets/${id}`, undefined, {
    Origin: 'http://evil.example'
  })
  assert.equal(deniedDelete.status, 403)
})

test('HTTP CRUD + 版本：POST v1 → PUT v2 → 列表摘要 → 指定版本 → DELETE', async () => {
  resetLibrary()

  const created = await post({ name: '镜头模板', prompt: 'v1 prompt', params: { cfg: 4 } })
  assert.equal(created.status, 201)
  assert.equal(created.body.version.version, 1)
  assert.equal(created.body.item.current_version, 1)
  assert.equal(created.body.item.current.prompt, 'v1 prompt')
  const id = created.body.item.id

  const appended = await request('PUT', `/api/prompt-presets/${id}`, {
    prompt: 'v2 prompt',
    params: { cfg: 6 },
    note: '调高 cfg'
  })
  assert.equal(appended.status, 200)
  assert.equal(appended.body.version.version, 2)
  assert.equal(appended.body.item.current_version, 2)
  assert.equal(appended.body.item.versions_count, 2)

  const list = await request('GET', '/api/prompt-presets', undefined, {})
  assert.equal(list.status, 200)
  assert.equal(list.body.total, 1)
  assert.equal(list.body.items[0].name, '镜头模板')
  assert.equal(list.body.items[0].versions, undefined)
  assert.equal(list.body.items[0].current.prompt, 'v2 prompt')

  const current = await request('GET', `/api/prompt-presets/${id}`, undefined, {})
  assert.equal(current.status, 200)
  assert.equal(current.body.version.version, 2)
  assert.equal(current.body.is_current, true)

  const first = await request('GET', `/api/prompt-presets/${id}?version=1`, undefined, {})
  assert.equal(first.status, 200)
  assert.equal(first.body.version.prompt, 'v1 prompt')
  assert.equal(first.body.is_current, false)

  const removed = await request('DELETE', `/api/prompt-presets/${id}`)
  assert.equal(removed.status, 200)
  assert.equal(removed.body.ok, true)
  assert.equal(readPromptPresets(root, readJson).length, 0)

  const missing = await request('GET', `/api/prompt-presets/${id}`, undefined, {})
  assert.equal(missing.status, 404)
  assert.equal(missing.body.error, 'preset_not_found')
})

test('HTTP 去重：重复 name 409 duplicate_name，且不落库', async () => {
  resetLibrary()
  const first = await post({ name: '去重模板', prompt: 'a' })
  assert.equal(first.status, 201)

  const dup = await post({ name: ' 去重模板 ', prompt: 'b' })
  assert.equal(dup.status, 409)
  assert.equal(dup.body.error, 'duplicate_name')
  assert.equal(readPromptPresets(root, readJson).length, 1)
})

test('HTTP 版本上限：第 51 次 PUT 409 version_limit，库内仍 50', async () => {
  resetLibrary()
  const preset = seedPreset({
    current_version: 50,
    versions: Array.from({ length: 50 }, (_, i) => ({
      version: i + 1,
      prompt: `prompt-${i + 1}`,
      params: {},
      note: '',
      created_at: '2026-11-14T00:00:00.000Z'
    }))
  })
  writeJsonAtomic(promptPresetsFile(root), { presets: [preset] })

  const overflow = await request('PUT', `/api/prompt-presets/${preset.id}`, { prompt: '51' })
  assert.equal(overflow.status, 409)
  assert.equal(overflow.body.error, 'version_limit')
  assert.equal(readPromptPresets(root, readJson)[0].versions.length, 50)
})

test('HTTP GET 版本不存在：404 preset_version_not_found；非法版本号 400 invalid_version', async () => {
  resetLibrary()
  const created = await post({ name: '版本查询', prompt: 'v1' })
  const id = created.body.item.id

  const missingVersion = await request('GET', `/api/prompt-presets/${id}?version=99`, undefined, {})
  assert.equal(missingVersion.status, 404)
  assert.equal(missingVersion.body.error, 'preset_version_not_found')

  const badVersion = await request('GET', `/api/prompt-presets/${id}?version=abc`, undefined, {})
  assert.equal(badVersion.status, 400)
  assert.equal(badVersion.body.error, 'invalid_version')

  const missingId = await request('GET', '/api/prompt-presets/preset_missing', undefined, {})
  assert.equal(missingId.status, 404)
  assert.equal(missingId.body.error, 'preset_not_found')
})

test('HTTP /validate：current 通过、显式版本通过、不存在 400 且不回退', async () => {
  resetLibrary()
  const created = await post({ name: '校验模板', prompt: 'v1' })
  const id = created.body.item.id
  await request('PUT', `/api/prompt-presets/${id}`, { prompt: 'v2' })

  const current = await request(
    'POST',
    `/api/prompt-presets/${id}/validate`,
    undefined,
    {}
  )
  assert.equal(current.status, 200)
  assert.equal(current.body.ok, true)
  assert.equal(current.body.version.version, 2)
  assert.equal(current.body.is_current, true)

  const explicit = await request(
    'POST',
    `/api/prompt-presets/${id}/validate`,
    { version: 1 },
    {}
  )
  assert.equal(explicit.status, 200)
  assert.equal(explicit.body.version.prompt, 'v1')
  assert.equal(explicit.body.is_current, false)

  const badVersion = await request(
    'POST',
    `/api/prompt-presets/${id}/validate`,
    { version: 99 },
    {}
  )
  assert.equal(badVersion.status, 400)
  assert.equal(badVersion.body.error, 'preset_version_not_found')

  const badPreset = await request(
    'POST',
    '/api/prompt-presets/preset_missing/validate',
    { version: 1 },
    {}
  )
  assert.equal(badPreset.status, 400)
  assert.equal(badPreset.body.error, 'preset_not_found')

  const badFormat = await request(
    'POST',
    `/api/prompt-presets/${id}/validate`,
    { version: 'abc' },
    {}
  )
  assert.equal(badFormat.status, 400)
  assert.equal(badFormat.body.error, 'invalid_version')
})

test('HTTP 坏 JSON 400，非法方法 405 + Allow', async () => {
  resetLibrary()
  const bad = await rawRequest('POST', '/api/prompt-presets', 'not-json', {
    'X-Web-Token': TOKEN
  })
  assert.equal(bad.status, 400)

  const badCollection = await request('PATCH', '/api/prompt-presets')
  assert.equal(badCollection.status, 405)
  assert.equal(badCollection.headers.get('allow'), 'GET, HEAD, POST')

  const created = await post({ name: '方法', prompt: 'p' })
  const id = created.body.item.id

  const badItem = await request('POST', `/api/prompt-presets/${id}`)
  assert.equal(badItem.status, 405)
  assert.equal(badItem.headers.get('allow'), 'GET, HEAD, PUT, DELETE')

  const badValidate = await request('GET', `/api/prompt-presets/${id}/validate`)
  assert.equal(badValidate.status, 405)
  assert.equal(badValidate.headers.get('allow'), 'POST')
})

test('HTTP 并发 PUT：HTTP 层同样串行化，版本连续无丢失', async () => {
  resetLibrary()
  const created = await post({ name: 'HTTP 并发', prompt: 'v1' })
  const id = created.body.item.id

  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      request('PUT', `/api/prompt-presets/${id}`, { prompt: `http-${i}` })
    )
  )
  assert.equal(results.every((result) => result.status === 200), true)

  const stored = readPromptPresets(root, readJson)[0]
  assert.equal(stored.versions.length, 9)
  assert.equal(stored.current_version, 9)
  assert.deepEqual(
    stored.versions.map((entry) => entry.version),
    [1, 2, 3, 4, 5, 6, 7, 8, 9]
  )
})
