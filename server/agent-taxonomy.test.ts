/**
 * #109 contract tests: host / project taxonomy + same-project skill binding.
 *
 * Every assertion goes through the production `handleAgentsRoute`. Fixtures are
 * temp meta.json files under a throwaway dataRoot; the real
 * `seed-agents/classify.json` supplies the default taxonomy (cwd = repo root
 * when `npm run test:server` runs). Run with `npm run test:server`.
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { ServerResponse } from 'node:http'
import { handleAgentsRoute } from './agents'
import type { AgentsContext } from './agents'

const TOKEN = 'taxonomy109-token'
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taxonomy109-'))

/** Set per test; cross-origin requests must not inherit this. */
let sameOrigin = true
let base = ''
let web: http.Server

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

function readJsonFile(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function writeJsonFile(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
}

const iso = '2026-11-13T00:00:00.000Z'

function fixture(
  type: 'skill' | 'agent' | 'profile',
  id: string,
  extra: Record<string, unknown> = {},
  content = `# ${id}\n`
) {
  const dirName = type === 'skill' ? 'skills' : type === 'agent' ? 'agents' : 'profiles'
  const dir = path.join(dataRoot, 'agents', dirName, id)
  const meta = {
    id,
    type,
    name: id.replace(/^seed-/, ''),
    description: `${id} 描述`,
    namespace: 'seed',
    active: true,
    active_version: 1,
    source: { kind: 'seed', sha256: '0'.repeat(64) },
    created_at: iso,
    updated_at: iso,
    versions: [{ version: 1, sha256: '0'.repeat(64), created_at: iso, message: 'seed' }],
    ...extra
  }
  writeJsonFile(path.join(dir, 'meta.json'), meta)
  fs.mkdirSync(path.join(dir, 'versions'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'versions', 'v1.md'), content, 'utf8')
  return meta
}

before(async () => {
  // Agents: one relies on classify.json defaults, one overrides every field.
  fixture('agent', 'seed-ui-dev')
  fixture('agent', 'custom-agent', { host: 'studio', project: 'lofa', skills: ['seed-rpa-flow-fix'] })

  // Skills across three projects (project comes from classify.json).
  fixture('skill', 'seed-gsap-core')
  fixture('skill', 'seed-dev-cookbook')
  fixture('skill', 'seed-rpa-flow-fix')
  fixture('skill', 'seed-kex-video-pipeline')
  fixture('skill', 'user-local-skill') // not in classify.json → 未分组

  web = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const ctx: AgentsContext = {
      dataRoot,
      webToken: TOKEN,
      isSameOrigin: () => sameOrigin,
      sendJson,
      readJson: readJsonFile,
      atomicWriteJson: writeJsonFile
    }
    const handled = await handleAgentsRoute(req, res, url, url.pathname, ctx)
    if (!handled) sendJson(res, 404, { error: 'not_found' })
  })
  await new Promise<void>((resolve) => web.listen(0, '127.0.0.1', resolve))
  const address = web.address()
  if (!address || typeof address === 'string') throw new Error('mock web server did not bind a port')
  base = `http://127.0.0.1:${address.port}`
})

after(async () => {
  await new Promise<void>((resolve) => web.close(() => resolve()))
  fs.rmSync(dataRoot, { recursive: true, force: true })
})

async function post(pathname: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

async function detail(id: string) {
  const res = await fetch(`${base}/api/agents/agent/${id}`)
  assert.equal(res.status, 200)
  return (await res.json()) as any
}

test('classify 合并：meta 缺省回退，已存值优先', async () => {
  const seed = await detail('seed-ui-dev')
  assert.equal(seed.meta.host, 'macbook')
  assert.equal(seed.meta.project, '通用')
  assert.equal(seed.meta.skills.length, 8)
  assert.ok(seed.meta.skills.includes('seed-gsap-core'))

  const custom = await detail('custom-agent')
  assert.equal(custom.meta.host, 'studio')
  assert.equal(custom.meta.project, 'lofa')
  assert.deepEqual(custom.meta.skills, ['seed-rpa-flow-fix'])
})

test('bindable_skills 只列同项目技能，并带 id/name/description', async () => {
  const seed = await detail('seed-ui-dev')
  const ids = seed.bindable_skills.map((skill: any) => skill.id).sort()
  assert.deepEqual(ids, ['seed-dev-cookbook', 'seed-gsap-core'])
  assert.ok(!ids.includes('seed-rpa-flow-fix'))
  assert.ok(!ids.includes('seed-kex-video-pipeline'))
  assert.ok(!ids.includes('user-local-skill'))
  for (const skill of seed.bindable_skills) {
    assert.equal(skill.project, '通用')
    assert.equal(typeof skill.name, 'string')
    assert.equal(typeof skill.description, 'string')
  }

  const custom = await detail('custom-agent')
  assert.deepEqual(
    custom.bindable_skills.map((skill: any) => skill.id),
    ['seed-rpa-flow-fix']
  )
})

test('未知 skill → 400 unknown_skill', async () => {
  sameOrigin = true
  const res = await post('/api/agents/agent/seed-ui-dev/skills', { skills: ['seed-does-not-exist'] })
  assert.equal(res.status, 400)
  assert.equal(res.body.error, 'unknown_skill')
})

test('跨项目 skill → 400 cross_project_skill', async () => {
  sameOrigin = true
  const res = await post('/api/agents/agent/seed-ui-dev/skills', { skills: ['seed-rpa-flow-fix'] })
  assert.equal(res.status, 400)
  assert.equal(res.body.error, 'cross_project_skill')
})

test('非 agent 类型 → 400 invalid_type', async () => {
  sameOrigin = true
  const res = await post('/api/agents/skill/seed-gsap-core/skills', { skills: [] })
  assert.equal(res.status, 400)
  assert.equal(res.body.error, 'invalid_type')
})

test('绑定 / 解绑写入 meta.skills，详情刷新后保持', async () => {
  sameOrigin = true
  const bind = await post('/api/agents/agent/seed-ui-dev/skills', { skills: ['seed-gsap-core'] })
  assert.equal(bind.status, 200)
  assert.deepEqual(bind.body.meta.skills, ['seed-gsap-core'])
  assert.deepEqual((await detail('seed-ui-dev')).meta.skills, ['seed-gsap-core'])

  const unbind = await post('/api/agents/agent/seed-ui-dev/skills', { skills: [] })
  assert.equal(unbind.status, 200)
  assert.deepEqual(unbind.body.meta.skills, [])
  assert.deepEqual((await detail('seed-ui-dev')).meta.skills, [])
})

test('写守卫：同源 200，跨源无 token 401，跨源错 token 403，跨源对 token 200', async () => {
  sameOrigin = true
  const same = await post('/api/agents/agent/seed-ui-dev/skills', { skills: ['seed-gsap-core'] })
  assert.equal(same.status, 200)

  sameOrigin = false
  const missing = await post('/api/agents/agent/seed-ui-dev/skills', { skills: ['seed-gsap-core'] })
  assert.equal(missing.status, 401)

  const wrong = await post(
    '/api/agents/agent/seed-ui-dev/skills',
    { skills: ['seed-gsap-core'] },
    { 'X-Web-Token': 'wrong-token' }
  )
  assert.equal(wrong.status, 403)

  const right = await post(
    '/api/agents/agent/seed-ui-dev/skills',
    { skills: [] },
    { 'X-Web-Token': TOKEN }
  )
  assert.equal(right.status, 200)
})
