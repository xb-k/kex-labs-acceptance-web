/**
 * #160 一句话 → 写实增强（规则 + 模板 v1）。
 *
 * 覆盖：场景识别 / 未知场景 / 空与超长 / negative 合并去重 / 鉴权 / 确定性。
 * HTTP 用例走真实 `authorizeTaskWrite` + 真实路由，不 mock 鉴权。
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { after, before, test } from 'node:test'
import type { AddressInfo } from 'node:net'

import { authorizeTaskWrite, readRequestBody } from './api'
import {
  GLOBAL_NEGATIVE,
  PROMPT_MAX,
  detectScene,
  enhancePrompt,
  handlePromptEnhancerRoute,
  mergeNegative,
  validateEnhanceInput,
  type PromptEnhancerDeps
} from './prompt-enhancer'

const TOKEN = 'prompt-enhancer-token'

// ---------------------------------------------------------------------------
// 纯函数：场景识别 / 增强 / negative / 校验
// ---------------------------------------------------------------------------

test('场景识别：自然/人像/室内/夜景/古风/动作，关键词命中最多者胜出', () => {
  assert.equal(detectScene('雪山日出，长焦压缩，金色逆光'), '自然')
  assert.equal(detectScene('女孩侧脸肖像，柔和窗光'), '人像')
  assert.equal(detectScene('客厅沙发与书架，午后窗边'), '室内')
  assert.equal(detectScene('城市夜景，霓虹与车流'), '夜景')
  assert.equal(detectScene('汉服侠客站在古风庭院，水墨质感'), '古风')
  assert.equal(detectScene('运动员冲刺腾空，快门凝固动态'), '动作')
  assert.equal(detectScene('一只陶瓷杯子放在桌上'), 'general')
})

test('未知场景：显式 scene 不在场景包内 → 400 scene_invalid', () => {
  const bad = validateEnhanceInput({ prompt: '雪山日出', scene: '不存在的场景' })
  assert.equal(bad.ok, false)
  if (!bad.ok) assert.equal(bad.error, 'scene_invalid')

  const alias = validateEnhanceInput({ prompt: '雪山日出', scene: 'nature' })
  assert.equal(alias.ok, true)
  if (alias.ok) assert.equal(alias.value.scene, '自然')
})

test('空 / 超长 / 非对象：prompt 空或 >500 字 → prompt_invalid', () => {
  for (const body of [null, 'x', []]) {
    const result = validateEnhanceInput(body)
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.error, 'invalid_body')
  }
  for (const body of [{ prompt: '' }, { prompt: '   ' }, { prompt: '字'.repeat(PROMPT_MAX + 1) }]) {
    const result = validateEnhanceInput(body)
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.error, 'prompt_invalid')
  }

  const boundary = validateEnhanceInput({ prompt: '字'.repeat(PROMPT_MAX) })
  assert.equal(boundary.ok, true)
})

test('增强：原句保留在最前，追加 ≤8 条去重子句，且不重复原句已有内容', () => {
  const result = enhancePrompt({ prompt: '雪山日出' })
  assert.equal(result.scene, '自然')
  assert.equal(result.source, 'rules')
  assert.equal(result.version, 'v1')
  assert.ok(result.prompt.startsWith('雪山日出，'))
  assert.ok(result.clauses.length > 0 && result.clauses.length <= 8)
  for (const clause of result.clauses) assert.ok(result.prompt.includes(clause))
  assert.equal(new Set(result.clauses).size, result.clauses.length)
  assert.equal(new Set(result.prompt.split('，')).size, result.prompt.split('，').length)

  const already = enhancePrompt({ prompt: '雪山日出，细腻胶片颗粒' })
  assert.equal(already.clauses.includes('细腻胶片颗粒'), false)
})

test('确定性：同输入同输出（含场景/negative/clauses）', () => {
  const input = { prompt: '女孩侧脸肖像，柔和窗光', negative: '低清, 水印' }
  assert.deepEqual(enhancePrompt(input), enhancePrompt(input))
  const explicit = enhancePrompt({ prompt: '雪山日出', scene: '夜景' })
  assert.equal(explicit.scene, '夜景')
})

test('negative：全局默认 + 用户输入合并去重（忽略大小写与分隔符）', () => {
  const merged = mergeNegative(GLOBAL_NEGATIVE, 'cgi, CGI，低清、低清\n水印')
  const parts = merged.split(', ')
  assert.equal(parts.filter((part) => part.toLowerCase() === 'cgi').length, 1)
  assert.equal(parts.filter((part) => part === '低清').length, 1)
  assert.equal(parts.includes('水印'), true)
  assert.equal(parts[0], '3d render')
  assert.equal(
    merged,
    '3d render, cgi, video game, plastic skin, oversaturated, unrealistic lighting, smooth synthetic textures, lowres, bad anatomy, cartoon, anime, 低清, 水印'
  )
})

// ---------------------------------------------------------------------------
// HTTP：真实 authorizeTaskWrite + 真实路由
// ---------------------------------------------------------------------------

let server: http.Server
let base = ''
let deps: PromptEnhancerDeps

before(async () => {
  const env = { WEB_WRITE_TOKEN: TOKEN } as NodeJS.ProcessEnv
  deps = {
    readBody: readRequestBody,
    authorize: (req) => authorizeTaskWrite(req, env),
    sendJson: (res, status, body) => {
      res.statusCode = status
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(body))
    }
  }
  server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    handlePromptEnhancerRoute(req, res, pathname, deps)
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

async function request(
  method: string,
  body?: unknown,
  headers: Record<string, string> = { 'X-Web-Token': TOKEN }
) {
  const res = await fetch(`${base}/api/prompts/enhance`, {
    method,
    headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await res.text()
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null }
}

test('HTTP 鉴权：跨源无 token 403、错 token 401、正确 token 200', async () => {
  const denied = await request('POST', { prompt: '雪山日出' }, { Origin: 'http://evil.example' })
  assert.equal(denied.status, 403)

  const wrong = await request(
    'POST',
    { prompt: '雪山日出' },
    { Origin: 'http://evil.example', 'X-Web-Token': 'wrong' }
  )
  assert.equal(wrong.status, 401)

  const ok = await request(
    'POST',
    { prompt: '雪山日出' },
    { Origin: 'http://evil.example', 'X-Web-Token': TOKEN }
  )
  assert.equal(ok.status, 200)
  assert.equal(ok.body.scene, '自然')
  assert.equal(ok.body.source, 'rules')
  assert.equal(ok.body.version, 'v1')
})

test('HTTP 契约：200 返回 prompt/negative/scene/clauses；400 错误码；非 POST 405', async () => {
  const ok = await request('POST', { prompt: '女孩侧脸肖像', negative: '3D RENDER, 水印' })
  assert.equal(ok.status, 200)
  assert.match(ok.body.prompt, /^女孩侧脸肖像，/)
  assert.deepEqual(Object.keys(ok.body).sort(), [
    'clauses',
    'negative',
    'prompt',
    'scene',
    'source',
    'version'
  ])
  assert.equal(ok.body.negative.split(', ').filter((part: string) => part.toLowerCase() === '3d render').length, 1)
  assert.ok(ok.body.negative.includes('水印'))

  const badScene = await request('POST', { prompt: '雪山日出', scene: '不存在' })
  assert.equal(badScene.status, 400)
  assert.equal(badScene.body.error, 'scene_invalid')

  const empty = await request('POST', { prompt: '   ' })
  assert.equal(empty.status, 400)
  assert.equal(empty.body.error, 'prompt_invalid')

  const long = await request('POST', { prompt: '字'.repeat(PROMPT_MAX + 1) })
  assert.equal(long.status, 400)
  assert.equal(long.body.error, 'prompt_invalid')

  const badBody = await request('POST', { prompt: 42 })
  assert.equal(badBody.status, 400)
  assert.equal(badBody.body.error, 'prompt_invalid')

  const method = await request('GET')
  assert.equal(method.status, 405)
  assert.equal(method.headers.get('allow'), 'POST')
})
