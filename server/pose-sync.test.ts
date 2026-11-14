/**
 * #138 增强：姿态参考库「从 GitHub 同步」契约测试。
 *
 * 所有 GitHub 请求都是本地 mock，不触网；断言：
 *  - license 映射 / 无 license / 其它协议拒绝；
 *  - tree 路径过滤（扩展名、pose 关键词、`.github/`、测试、icon/logo）；
 *  - source_url 去重、每仓 ≤10、单次 ≤50、6 小时最小间隔（force 可跳过）；
 *  - 429 限速如实返回、鉴权、GET sync-status；
 *  - 只写外链元数据，不下载图片（不请求 raw.githubusercontent.com）。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import type { AddressInfo } from 'node:net'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { authorizeTaskWrite, readJson } from './api'
import {
  addPoseEntry,
  handlePoseLibraryRoute,
  poseLibraryFile,
  readPoseEntries,
  writeJsonAtomic
} from './pose-library'
import {
  MAX_IMAGES_PER_REPO,
  MAX_IMAGES_PER_RUN,
  POSE_SYNC_INTERVAL_MS,
  isPoseImagePath,
  mapGitHubLicense,
  poseLabelFor,
  readPoseSyncStatus,
  runPoseSync,
  type FetchLike,
  type RunPoseSyncOutcome
} from './pose-sync'

const NOW = new Date('2026-11-14T00:00:00.000Z')
const TOKEN = 'pose-sync-138-token'
const tempRoots: string[] = []

after(() => {
  for (const dir of tempRoots) fs.rmSync(dir, { recursive: true, force: true })
})

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pose-sync-138-'))
  tempRoots.push(dir)
  return dir
}

// ---------------------------------------------------------------------------
// GitHub mock
// ---------------------------------------------------------------------------

interface MockResponse {
  status?: number
  headers?: Record<string, string>
  body?: unknown
}

interface MockConfig {
  search?: (query: string) => MockResponse | Promise<MockResponse>
  tree?: (repo: string) => MockResponse | Promise<MockResponse>
}

function response(out: MockResponse): Response {
  const status = out.status ?? 200
  const body = typeof out.body === 'string' ? out.body : JSON.stringify(out.body ?? {})
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json', ...out.headers }
  })
}

function makeFetch(config: MockConfig): { fetchImpl: FetchLike; calls: string[] } {
  const calls: string[] = []
  const fetchImpl: FetchLike = async (input) => {
    calls.push(input)
    if (input.startsWith('https://api.github.com/search/repositories')) {
      const query = new URL(input).searchParams.get('q') ?? ''
      return response((await config.search?.(query)) ?? { body: { items: [] } })
    }
    if (input.includes('/git/trees/HEAD')) {
      const repo = input.slice('https://api.github.com/repos/'.length).split('/git/trees/')[0]
      return response((await config.tree?.(repo)) ?? { body: { tree: [] } })
    }
    return response({ status: 404, body: `unexpected url: ${input}` })
  }
  return { fetchImpl, calls }
}

function repoItem(
  fullName: string,
  opts: { stars?: number; license?: string | null } = {}
) {
  return {
    full_name: fullName,
    stargazers_count: opts.stars ?? 1200,
    license: opts.license === null ? null : { spdx_id: opts.license ?? 'MIT' }
  }
}

function tree(paths: string[]) {
  return {
    body: {
      tree: paths.map((p) => ({ path: p, type: 'blob', size: 1024 }))
    }
  }
}

function posePaths(repo: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `poses/${repo.split('/')[1]}-${i + 1}.png`)
}

function treeWithShas(items: Array<{ path: string; sha: string }>) {
  return {
    body: {
      tree: items.map((item) => ({ path: item.path, type: 'blob', size: 1024, sha: item.sha }))
    }
  }
}

function run(
  root: string,
  fetchImpl: FetchLike,
  opts: { now?: () => Date; force?: boolean; env?: NodeJS.ProcessEnv } = {}
): Promise<RunPoseSyncOutcome> {
  const now = opts.now ?? (() => NOW)
  return runPoseSync({
    dataRoot: root,
    readJson,
    atomicWriteJson: writeJsonAtomic,
    fetchImpl,
    env: opts.env ?? {},
    now,
    force: opts.force ?? true,
    addPoseEntry: (value) =>
      addPoseEntry({
        dataRoot: root,
        value,
        readJson,
        atomicWriteJson: writeJsonAtomic,
        now
      })
  })
}

function expectOk(outcome: RunPoseSyncOutcome) {
  if (!outcome.ok) throw new Error(outcome.error)
  return outcome.result
}

// ---------------------------------------------------------------------------
// 纯函数：license / 路径
// ---------------------------------------------------------------------------

test('license 映射：只放行白名单，无 license / GPL 等拒绝', () => {
  assert.equal(mapGitHubLicense('CC0-1.0'), 'CC0')
  assert.equal(mapGitHubLicense('cc0-1.0'), 'CC0')
  assert.equal(mapGitHubLicense('CC-BY-4.0'), 'CC-BY-4.0')
  assert.equal(mapGitHubLicense('CC-BY-SA-4.0'), 'CC-BY-SA-4.0')
  assert.equal(mapGitHubLicense('MIT'), 'MIT')
  assert.equal(mapGitHubLicense('Apache-2.0'), 'Apache-2.0')
  assert.equal(mapGitHubLicense('GPL-3.0'), null)
  assert.equal(mapGitHubLicense('BSD-3-Clause'), null)
  assert.equal(mapGitHubLicense('NOASSERTION'), null)
  assert.equal(mapGitHubLicense(null), null)
  assert.equal(mapGitHubLicense(undefined), null)
})

test('tree 过滤：只收姿态/参考/动作图片，排除 .github、测试、icon/logo', () => {
  for (const p of [
    'poses/standing.png',
    'reference/action-01.jpg',
    'actions/jump.WEBP',
    'docs/pose_reference.jpeg',
    'openpose/frame.jpg',
    'references/pose1.png'
  ]) {
    assert.equal(isPoseImagePath(p), true, p)
  }
  for (const p of [
    '.github/poses/banner.png',
    'tests/pose.png',
    'test/pose.png',
    '__tests__/pose.png',
    'assets/logo.png',
    'assets/pose-icon.png',
    'assets/favicon.png',
    'compose.jpg',
    'docs/readme.png',
    'poses/standing.gif'
  ]) {
    assert.equal(isPoseImagePath(p), false, p)
  }
})

test('中文标签：<repo 名> 姿态 <n>，repo 名过长时截断到 60 字', () => {
  assert.equal(poseLabelFor('acme/awesome-poses', 3), 'awesome-poses 姿态 3')
  const long = poseLabelFor(`acme/${'长'.repeat(80)}`, 12)
  assert.ok([...long].length <= 60)
  assert.match(long, / 姿态 12$/)
})

// ---------------------------------------------------------------------------
// 同步 run
// ---------------------------------------------------------------------------

test('同步：license / stars 过滤 + tree 找图 + 每仓 10 张上限 + 外链元数据', async () => {
  const root = tempRoot()
  const repoTrees: Record<string, string[]> = {
    'acme/awesome-poses': [
      ...posePaths('acme/awesome-poses', 12),
      '.github/poses/banner.png',
      'tests/pose.png',
      'assets/logo.png',
      'docs/readme.png',
      'docs/LICENSE.md'
    ],
    'acme/gpl-poses': posePaths('acme/gpl-poses', 3),
    'acme/low-stars': posePaths('acme/low-stars', 3),
    'acme/no-license': posePaths('acme/no-license', 3)
  }
  const { fetchImpl, calls } = makeFetch({
    search: () => ({
      body: {
        items: [
          repoItem('acme/awesome-poses', { license: 'MIT', stars: 1200 }),
          repoItem('acme/gpl-poses', { license: 'GPL-3.0', stars: 5000 }),
          repoItem('acme/low-stars', { license: 'MIT', stars: 299 }),
          repoItem('acme/no-license', { license: null, stars: 800 })
        ]
      }
    }),
    tree: (repo) => tree(repoTrees[repo] ?? [])
  })

  const result = expectOk(await run(root, fetchImpl))

  assert.equal(result.imported, MAX_IMAGES_PER_REPO)
  assert.equal(result.rate_limit.limited, false)
  assert.equal(result.rate_limit.auth, 'anonymous')
  assert.equal(result.skip_reasons.low_stars, 1)
  assert.equal(result.skip_reasons.license_not_allowed, 1)
  assert.equal(result.skip_reasons.license_missing, 1)
  assert.equal(result.repos.length, 4)
  const gpl = result.repos.find((row) => row.repo === 'acme/gpl-poses')
  assert.equal(gpl?.license, null)
  assert.equal(gpl?.reason, 'license_not_allowed')
  const low = result.repos.find((row) => row.repo === 'acme/low-stars')
  assert.equal(low?.reason, 'low_stars')

  const entries = readPoseEntries(root, readJson)
  assert.equal(entries.length, MAX_IMAGES_PER_REPO)
  const first = entries[0]
  assert.equal(first.label_zh, 'awesome-poses 姿态 1')
  assert.match(first.label_zh, /[\u4e00-\u9fa5]/)
  assert.equal(first.source_url, 'https://github.com/acme/awesome-poses/blob/HEAD/poses/awesome-poses-1.png')
  assert.equal(
    first.preview_url,
    'https://raw.githubusercontent.com/acme/awesome-poses/HEAD/poses/awesome-poses-1.png'
  )
  assert.equal(first.license, 'MIT')
  assert.equal(
    first.license_evidence_url,
    'https://github.com/acme/awesome-poses/blob/HEAD/docs/LICENSE.md'
  )
  assert.deepEqual(first.tags, ['acme/awesome-poses', 'github'])
  assert.deepEqual(first.suitable_shots, ['full_body'])
  assert.equal(first.license_verified, true)

  // 不下载图片：只有 search / tree 两类 API 请求。
  assert.equal(calls.some((url) => url.startsWith('https://raw.githubusercontent.com/')), false)
  assert.equal(calls.every((url) => url.startsWith('https://api.github.com/')), true)
})

test('去重：已存在的 source_url 跳过并计 duplicate_source_url', async () => {
  const root = tempRoot()
  const paths = posePaths('acme/awesome-poses', 3)
  const seeded = await addPoseEntry({
    dataRoot: root,
    readJson,
    atomicWriteJson: writeJsonAtomic,
    now: () => NOW,
    value: {
      label_zh: '旧条目',
      preview_url: null,
      source_url: `https://github.com/acme/awesome-poses/blob/HEAD/${paths[0]}`,
      license: 'MIT',
      license_evidence_url: 'https://github.com/acme/awesome-poses/blob/HEAD/LICENSE',
      suitable_shots: ['full_body'],
      tags: [],
      note: ''
    }
  })
  assert.equal(seeded.ok, true)

  const { fetchImpl } = makeFetch({
    search: () => ({ body: { items: [repoItem('acme/awesome-poses')] } }),
    tree: () => tree([...paths, 'LICENSE'])
  })
  const result = expectOk(await run(root, fetchImpl))
  assert.equal(result.imported, 2)
  assert.equal(result.skip_reasons.duplicate_source_url, 1)
  assert.equal(readPoseEntries(root, readJson).length, 3)
})

test('#169 内容去重：两个仓库同 blob sha 只导入 1 张，另一个计 duplicate_content', async () => {
  const root = tempRoot()
  const sha = 'f'.repeat(40)
  const { fetchImpl } = makeFetch({
    search: () => ({ body: { items: [repoItem('acme/pose-fork-a'), repoItem('acme/pose-fork-b')] } }),
    tree: (repo) =>
      treeWithShas([
        { path: `poses/${repo.split('/')[1]}-1.png`, sha },
        { path: `poses/${repo.split('/')[1]}-2.png`, sha: 'a'.repeat(40) }
      ])
  })
  const result = expectOk(await run(root, fetchImpl))
  // fork-a 导入 2 张；fork-b 的同内容 2 张全部跳过。
  assert.equal(result.imported, 2)
  assert.equal(result.skip_reasons.duplicate_content, 2)

  const entries = readPoseEntries(root, readJson)
  assert.equal(entries.length, 2)
  assert.equal(entries.every((entry) => /^[0-9a-f]{40}$/.test(String(entry.content_sha))), true)
  assert.deepEqual(
    entries.map((entry) => entry.content_sha),
    [sha, 'a'.repeat(40)]
  )
})

test('单次上限 50 张：6 个仓库各 10 张只入库 50 张', async () => {
  const root = tempRoot()
  const repos = Array.from({ length: 6 }, (_, i) => `acme/pose-pack-${i + 1}`)
  const { fetchImpl } = makeFetch({
    search: () => ({ body: { items: repos.map((repo) => repoItem(repo)) } }),
    tree: (repo) => tree(posePaths(repo, 10))
  })
  const result = expectOk(await run(root, fetchImpl))
  assert.equal(result.imported, MAX_IMAGES_PER_RUN)
  assert.equal(readPoseEntries(root, readJson).length, MAX_IMAGES_PER_RUN)
})

test('6 小时最小间隔：不带 force 返回 sync_too_soon，force 放行', async () => {
  const root = tempRoot()
  const { fetchImpl } = makeFetch({
    search: () => ({ body: { items: [repoItem('acme/awesome-poses')] } }),
    tree: () => tree(posePaths('acme/awesome-poses', 2))
  })
  const first = expectOk(await run(root, fetchImpl, { force: true }))
  assert.equal(first.imported, 2)

  const tooSoon = await run(root, fetchImpl, {
    force: false,
    now: () => new Date(NOW.getTime() + 60 * 60 * 1000)
  })
  assert.equal(tooSoon.ok, false)
  if (!tooSoon.ok) {
    assert.equal(tooSoon.error, 'sync_too_soon')
    if (tooSoon.error === 'sync_too_soon') {
      assert.equal(Date.parse(tooSoon.next_at) - NOW.getTime(), POSE_SYNC_INTERVAL_MS)
    }
  }

  const forced = expectOk(
    await run(root, fetchImpl, {
      force: true,
      now: () => new Date(NOW.getTime() + 60 * 60 * 1000)
    })
  )
  assert.equal(forced.imported, 0) // 全部重复
})

test('429：搜索被限速时 rate_limit.limited=true、零导入、状态落盘', async () => {
  const root = tempRoot()
  const { fetchImpl } = makeFetch({
    search: () => ({ status: 429, body: { message: 'API rate limit exceeded' }, headers: { 'x-ratelimit-remaining': '0' } })
  })
  const result = expectOk(await run(root, fetchImpl))
  assert.equal(result.imported, 0)
  assert.equal(result.rate_limit.limited, true)
  assert.equal(result.rate_limit.status, 429)
  assert.equal(result.errors[0].stage, 'search')
  assert.equal(result.errors[0].error, 'rate_limit')

  const stored = readPoseSyncStatus(root, readJson)
  assert.equal(stored.rate_limit.limited, true)
  assert.equal(stored.at, NOW.toISOString())
})

// ---------------------------------------------------------------------------
// HTTP 路由
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

const env = { WEB_WRITE_TOKEN: TOKEN }

async function startServer(
  root: string,
  fetchImpl: FetchLike,
  now: () => Date = () => NOW
): Promise<{ server: http.Server; base: string }> {
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
        const handled = await handlePoseLibraryRoute(req, res, url, url.pathname, {
          dataRoot: root,
          readJson,
          atomicWriteJson: writeJsonAtomic,
          readBody: (request) =>
            new Promise((resolve, reject) => {
              const chunks: Buffer[] = []
              request.on('data', (chunk: Buffer) => chunks.push(chunk))
              request.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8').trim()
                if (!text) {
                  reject(new Error('empty body'))
                  return
                }
                try {
                  resolve(JSON.parse(text))
                } catch {
                  reject(new Error('invalid JSON'))
                }
              })
              request.on('error', reject)
            }),
          authorize: (request) => authorizeTaskWrite(request, env),
          sendJson,
          fetchImpl,
          env,
          now
        })
        if (!handled) {
          res.statusCode = 404
          res.end()
        }
      } catch (err) {
        res.statusCode = 500
        res.end(String(err))
      }
    })()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { server, base: `http://127.0.0.1:${port}` }
}

test('POST /api/pose-library/sync：403 / 401 / 200 + 6h 409 + force；GET sync-status', async () => {
  const root = tempRoot()
  const { fetchImpl } = makeFetch({
    search: () => ({ body: { items: [repoItem('acme/awesome-poses')] } }),
    tree: () => tree(posePaths('acme/awesome-poses', 2))
  })
  const { server, base } = await startServer(root, fetchImpl)
  try {
    const anonymous = await fetch(`${base}/api/pose-library/sync`, { method: 'POST' })
    assert.equal(anonymous.status, 403)

    const wrong = await fetch(`${base}/api/pose-library/sync`, {
      method: 'POST',
      headers: { 'x-web-token': 'nope' }
    })
    assert.equal(wrong.status, 401)

    const ok = await fetch(`${base}/api/pose-library/sync`, {
      method: 'POST',
      headers: { 'x-web-token': TOKEN }
    })
    assert.equal(ok.status, 200)
    const body = (await ok.json()) as any
    assert.equal(body.imported, 2)
    assert.equal(body.repos[0].repo, 'acme/awesome-poses')

    const tooSoon = await fetch(`${base}/api/pose-library/sync`, {
      method: 'POST',
      headers: { 'x-web-token': TOKEN }
    })
    assert.equal(tooSoon.status, 409)
    assert.equal(((await tooSoon.json()) as any).error, 'sync_too_soon')

    const forced = await fetch(`${base}/api/pose-library/sync`, {
      method: 'POST',
      headers: { 'x-web-token': TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ force: true })
    })
    assert.equal(forced.status, 200)

    const status = await fetch(`${base}/api/pose-library/sync-status`, {
      headers: { 'x-web-token': TOKEN }
    })
    assert.equal(status.status, 200)
    const statusBody = (await status.json()) as any
    // 状态记录最近一次 run：force 那次全部重复，因此 imported=0 / skipped=2。
    assert.equal(statusBody.imported, 0)
    assert.equal(statusBody.skipped, 2)
    assert.equal(statusBody.at, NOW.toISOString())
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('POST sync：GitHub 429 时路由返回 429 且不伪造成功', async () => {
  const root = tempRoot()
  const { fetchImpl } = makeFetch({
    search: () => ({ status: 429, body: { message: 'rate limited' }, headers: { 'x-ratelimit-remaining': '0' } })
  })
  const { server, base } = await startServer(root, fetchImpl)
  try {
    const res = await fetch(`${base}/api/pose-library/sync`, {
      method: 'POST',
      headers: { 'x-web-token': TOKEN }
    })
    assert.equal(res.status, 429)
    const body = (await res.json()) as any
    assert.equal(body.error, 'github_rate_limited')
    assert.equal(body.rate_limit.limited, true)
    assert.equal(body.imported, 0)

    const status = await fetch(`${base}/api/pose-library/sync-status`, {
      headers: { 'x-web-token': TOKEN }
    })
    const statusBody = (await status.json()) as any
    assert.equal(statusBody.rate_limit.limited, true)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('GET sync-status 初始为空（at=null / imported=0）', async () => {
  const root = tempRoot()
  const { fetchImpl } = makeFetch({})
  const { server, base } = await startServer(root, fetchImpl)
  try {
    const res = await fetch(`${base}/api/pose-library/sync-status`)
    assert.equal(res.status, 200)
    const body = (await res.json()) as any
    assert.equal(body.at, null)
    assert.equal(body.imported, 0)
    assert.equal(body.rate_limit.limited, false)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('同步不覆盖既有条目：导入后旧条目仍在 entries.json', async () => {
  const root = tempRoot()
  await addPoseEntry({
    dataRoot: root,
    readJson,
    atomicWriteJson: writeJsonAtomic,
    now: () => NOW,
    value: {
      label_zh: '手工条目',
      preview_url: null,
      source_url: 'https://example.com/poses/manual',
      license: 'CC0',
      license_evidence_url: 'https://example.com/license',
      suitable_shots: ['full_body'],
      tags: [],
      note: ''
    }
  })
  const { fetchImpl } = makeFetch({
    search: () => ({ body: { items: [repoItem('acme/awesome-poses')] } }),
    tree: () => tree(posePaths('acme/awesome-poses', 1))
  })
  const result = expectOk(await run(root, fetchImpl))
  assert.equal(result.imported, 1)
  const entries = readPoseEntries(root, readJson)
  assert.equal(entries.length, 2)
  assert.ok(entries.some((entry) => entry.label_zh === '手工条目'))
  assert.equal(fs.existsSync(poseLibraryFile(root)), true)
})
