/**
 * #87a contract tests (I1–I4, I6): Brief polish → confirm → enqueue gate.
 *
 * Every case goes through the real `handleStudioRoute` over HTTP. Ollama and the
 * studio intake are replaced by local HTTP stubs — the fetch/route/schema code
 * under test is the production path, only the external services are stubbed.
 * One extra I1 case calls the ambient `OLLAMA_URL` and SKIPs (with a reason)
 * when no local model is reachable.
 *
 * Run (see evidence `tests.txt`):
 *   npx esbuild server/brief.test.ts --bundle --platform=node --format=esm \
 *     --outfile=/tmp/brief087/brief.test.mjs
 *   OLLAMA_URL=http://127.0.0.1:11435 node --test /tmp/brief087/brief.test.mjs
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleStudioRoute, validatePolished } from './studio'
import type { StudioContext } from './studio'

const TOKEN = 'brief087-test-token'
const AMBIENT_OLLAMA = (process.env.OLLAMA_URL?.trim() || 'http://127.0.0.1:11434').replace(/\/+$/, '')

// --- the same four context helpers api.ts passes to handleStudioRoute --------

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

function readJson(file: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function atomicWriteJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, file)
}

function readRequestBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
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
  })
}

// --- tiny HTTP harness ------------------------------------------------------

type Listener = { url: string; close: () => Promise<void> }

async function listen(handler: http.RequestListener): Promise<Listener> {
  const server = http.createServer(handler)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

function studioCtx(dataRoot: string, intakeUrl: string): StudioContext {
  return {
    dataRoot,
    intakeUrl,
    timeoutMs: 5000,
    webToken: TOKEN,
    isSameOrigin: () => false,
    sendJson,
    readJson,
    atomicWriteJson,
    readBody: readRequestBody
  }
}

type IntakeStub = Listener & { posts: () => number; bodies: () => any[] }

async function startIntake(): Promise<IntakeStub> {
  let posts = 0
  const bodies: any[] = []
  const listener = await listen((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (req.method === 'POST' && url.pathname === '/intake/jobs') {
      posts += 1
      readRequestBody(req).then(
        (body) => {
          bodies.push(body)
          sendJson(res, 201, { id: `job087_${posts}`, state: 'queued', updated_at: new Date().toISOString() })
        },
        () => sendJson(res, 400, { error: 'bad body' })
      )
      return
    }
    if (req.method === 'GET' && url.pathname.startsWith('/intake/jobs/')) {
      const id = decodeURIComponent(url.pathname.split('/').pop() ?? '')
      sendJson(res, 200, { id, state: 'queued', updated_at: new Date().toISOString() })
      return
    }
    sendJson(res, 404, { error: 'not found' })
  })
  return { ...listener, posts: () => posts, bodies: () => bodies }
}

type OllamaReply = { polished?: unknown; questions?: string[]; raw?: string; status?: number }
type OllamaStub = Listener & {
  requests: Array<{ path: string; body: any }>
  setReply: (reply: OllamaReply) => void
}

async function startOllama(): Promise<OllamaStub> {
  let reply: OllamaReply = {}
  const requests: Array<{ path: string; body: any }> = []
  const listener = await listen((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (req.method === 'GET' && url.pathname === '/api/tags') {
      sendJson(res, 200, {
        models: [{ name: 'qwen2.5:7b' }, { name: 'nomic-embed-text:latest' }]
      })
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/generate') {
      readRequestBody(req).then(
        (body) => {
          requests.push({ path: url.pathname, body })
          if (reply.status && reply.status >= 400) {
            sendJson(res, reply.status, { error: 'boom' })
            return
          }
          const polished = reply.polished ?? {}
          const text =
            reply.raw !== undefined
              ? reply.raw
              : JSON.stringify({ ...(polished as Record<string, unknown>), questions: reply.questions ?? [] })
          sendJson(res, 200, { response: text, model: 'qwen2.5:7b' })
        },
        () => sendJson(res, 400, { error: 'bad body' })
      )
      return
    }
    sendJson(res, 404, { error: 'not found' })
  })
  return { ...listener, requests, setReply: (next) => (reply = next) }
}

async function call(base: string, method: string, pathname: string, body?: unknown) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Web-Token': TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await res.text()
  let parsed: any = text
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = text
  }
  return { status: res.status, body: parsed }
}

async function withOllama<T>(url: string, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.OLLAMA_URL
  process.env.OLLAMA_URL = url
  try {
    return await fn()
  } finally {
    if (saved === undefined) delete process.env.OLLAMA_URL
    else process.env.OLLAMA_URL = saved
  }
}

const MINIMAL_POLISHED = {
  logline: '一杯手冲咖啡的清晨仪式',
  script: '开场：磨豆声与晨光；中段：注水特写；结尾：第一口。',
  shots: [{ no: 1, duration_s: 3, prompt: '近景手冲咖啡液滴落', camera: '俯拍' }]
}

async function newBrief(idea = '拍一条 30 秒的咖啡店探店短视频') {
  const res = await call(studioUrl, 'POST', '/api/studio/briefs', { idea, duration_s: 30 })
  assert.equal(res.status, 201)
  return res.body as any
}

async function polishedBrief(stub: OllamaStub, idea?: string) {
  stub.setReply({ polished: MINIMAL_POLISHED, questions: [] })
  const brief = await newBrief(idea)
  const res = await withOllama(stub.url, () =>
    call(studioUrl, 'POST', `/api/studio/briefs/${brief.id}/polish`, {})
  )
  assert.equal(res.status, 200)
  return res.body.brief as any
}

// --- shared fixtures --------------------------------------------------------

const closers: Array<() => Promise<void>> = []
let dataRoot = ''
let intake: IntakeStub
let studioUrl = ''
let stub: OllamaStub

before(async () => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brief087-'))
  intake = await startIntake()
  stub = await startOllama()
  closers.push(intake.close, stub.close)
  const studio = await listen((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    void handleStudioRoute(req, res, url, decodeURIComponent(url.pathname), studioCtx(dataRoot, intake.url)).catch(
      (err) => sendJson(res, 500, { error: 'test_server_error', reason: err instanceof Error ? err.message : String(err) })
    )
  })
  closers.push(studio.close)
  studioUrl = studio.url
})

after(async () => {
  for (const close of closers.reverse()) await close()
  fs.rmSync(dataRoot, { recursive: true, force: true })
})

// --- cases ------------------------------------------------------------------

test('I1 polish calls a real HTTP LLM, persists polished and questions (draft, version+1)', async () => {
  stub.setReply({ polished: MINIMAL_POLISHED, questions: ['目标受众？', '期望时长？'] })
  const brief = await newBrief()
  const res = await withOllama(stub.url, () =>
    call(studioUrl, 'POST', `/api/studio/briefs/${brief.id}/polish`, {})
  )
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.questions, ['目标受众？', '期望时长？'])
  assert.equal(res.body.brief.status, 'draft')
  assert.equal(res.body.brief.version, 2)
  assert.equal(res.body.brief.polished.logline, MINIMAL_POLISHED.logline)
  assert.equal(res.body.brief.polished.shots[0].prompt, '近景手冲咖啡液滴落')
  assert.equal(res.body.llm.model, 'qwen2.5:7b')
  assert.ok(typeof res.body.llm.elapsed_ms === 'number' && res.body.llm.elapsed_ms >= 0)

  // The stub saw the wire request (real fetch path, not a mocked business fn).
  const generate = stub.requests.filter((r) => r.path === '/api/generate')
  assert.equal(generate.length, 1)
  assert.equal(generate[0].body.model, 'qwen2.5:7b')
  assert.equal(generate[0].body.stream, false)
  assert.match(String(generate[0].body.prompt), /咖啡店探店/)

  const got = await call(studioUrl, 'GET', `/api/studio/briefs/${brief.id}`)
  assert.equal(got.status, 200)
  assert.deepEqual(got.body.questions_pending, ['目标受众？', '期望时长？'])
})

test('I1 Ollama unreachable -> 503 polish_unavailable (no template fallback)', async () => {
  const brief = await newBrief()
  const res = await withOllama('http://127.0.0.1:1', () =>
    call(studioUrl, 'POST', `/api/studio/briefs/${brief.id}/polish`, {})
  )
  assert.equal(res.status, 503)
  assert.equal(res.body.error, 'polish_unavailable')
  assert.equal(typeof res.body.reason, 'string')
  assert.ok(res.body.reason.length > 0)
  const got = await call(studioUrl, 'GET', `/api/studio/briefs/${brief.id}`)
  assert.equal(got.body.polished, null)
  assert.equal(got.body.version, 1)
})

test('I1 real local Ollama (ambient OLLAMA_URL) or explicit SKIP', async (t) => {
  let textModel = ''
  try {
    const res = await fetch(`${AMBIENT_OLLAMA}/api/tags`, { signal: AbortSignal.timeout(3000) })
    if (res.ok) {
      const body = (await res.json()) as { models?: Array<{ name?: string }> }
      textModel =
        (body.models ?? [])
          .map((m) => (typeof m.name === 'string' ? m.name : ''))
          .find((name) => name && !/embed|bge|nomic/i.test(name)) ?? ''
    }
  } catch {
    textModel = ''
  }
  if (!textModel) {
    t.skip(`SKIP: no local text model reachable at ${AMBIENT_OLLAMA}/api/tags`)
    return
  }
  const brief = await newBrief('拍一条 20 秒的成都火锅店探店短视频')
  const res = await withOllama(AMBIENT_OLLAMA, () =>
    call(studioUrl, 'POST', `/api/studio/briefs/${brief.id}/polish`, {})
  )
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.ok(res.body.llm.model)
  assert.ok(res.body.llm.elapsed_ms > 0)
  const schema = validatePolished(res.body.brief.polished)
  assert.equal(schema.ok, true)
  assert.equal(res.body.brief.status, 'draft')
  console.log(
    `I1 real LLM: model=${res.body.llm.model} elapsed_ms=${res.body.llm.elapsed_ms} questions=${res.body.questions.length}`
  )
})

test('I2 draft brief is gated (409, intake untouched); confirm opens the gate (201)', async () => {
  const brief = await polishedBrief(stub)
  assert.equal(brief.status, 'draft')
  const postsBefore = intake.posts()
  const blocked = await call(studioUrl, 'POST', '/api/studio/jobs', {
    input: '/data/upload.mp4',
    brief_id: brief.id
  })
  assert.equal(blocked.status, 409)
  assert.equal(blocked.body.error, 'brief_not_confirmed')
  assert.equal(intake.posts(), postsBefore)

  const confirmed = await call(studioUrl, 'POST', `/api/studio/briefs/${brief.id}/confirm`, { ack: true })
  assert.equal(confirmed.status, 200)
  assert.equal(confirmed.body.brief.status, 'confirmed')
  assert.equal(confirmed.body.job_gate, 'open')

  const created = await call(studioUrl, 'POST', '/api/studio/jobs', {
    input: '/data/upload.mp4',
    brief_id: brief.id
  })
  assert.equal(created.status, 201)
  assert.equal(created.body.brief_id, brief.id)
  assert.equal(intake.posts(), postsBefore + 1)
})

test('I3 polished schema rejects each invalid branch with its path; minimal valid object passes', async () => {
  const brief = await newBrief()
  const cases: Array<[unknown, string]> = [
    [{ ...MINIMAL_POLISHED, logline: '' }, 'logline'],
    [{ ...MINIMAL_POLISHED, shots: [] }, 'shots'],
    [
      {
        ...MINIMAL_POLISHED,
        shots: [
          { no: 1, duration_s: 1, prompt: 'a' },
          { no: 3, duration_s: 1, prompt: 'b' }
        ]
      },
      'shots[1].no'
    ],
    [{ ...MINIMAL_POLISHED, shots: [{ no: 1, duration_s: 1, prompt: 'x'.repeat(501) }] }, 'shots[0].prompt']
  ]
  for (const [polished, expectedPath] of cases) {
    stub.setReply({ polished, questions: [] })
    const res = await withOllama(stub.url, () =>
      call(studioUrl, 'POST', `/api/studio/briefs/${brief.id}/polish`, {})
    )
    assert.equal(res.status, 422, JSON.stringify(res.body))
    assert.equal(res.body.error, 'brief_schema_invalid')
    assert.equal(res.body.path, expectedPath)
  }

  stub.setReply({
    polished: { logline: '极简', script: '一镜到底', shots: [{ no: 1, duration_s: 1, prompt: '空镜' }] },
    questions: []
  })
  const ok = await withOllama(stub.url, () =>
    call(studioUrl, 'POST', `/api/studio/briefs/${brief.id}/polish`, {})
  )
  assert.equal(ok.status, 200)
  assert.equal(ok.body.brief.polished.logline, '极简')
})

test('I4 PATCH cannot bypass /confirm; confirm needs ack; confirmed -> draft allowed', async () => {
  const draft = await newBrief()
  const bypass = await call(studioUrl, 'PATCH', `/api/studio/briefs/${draft.id}`, { status: 'confirmed' })
  assert.equal(bypass.status, 400)
  assert.equal(bypass.body.error, 'use /confirm')

  const noAck = await call(studioUrl, 'POST', `/api/studio/briefs/${draft.id}/confirm`, { ack: false })
  assert.equal(noAck.status, 400)
  assert.equal(noAck.body.error, 'ack_required')

  const notReady = await call(studioUrl, 'POST', `/api/studio/briefs/${draft.id}/confirm`, { ack: true })
  assert.equal(notReady.status, 409)
  assert.equal(notReady.body.error, 'brief_not_ready')

  const confirmed = await polishedBrief(stub)
  await call(studioUrl, 'POST', `/api/studio/briefs/${confirmed.id}/confirm`, { ack: true })
  const reopen = await call(studioUrl, 'PATCH', `/api/studio/briefs/${confirmed.id}`, { status: 'draft' })
  assert.equal(reopen.status, 200)
  assert.equal(reopen.body.status, 'draft')
})

test('I6 confirmed polished brief is consumable as job input (brief_id linked, no GPU)', async () => {
  const brief = await polishedBrief(stub)
  const before = await call(studioUrl, 'GET', `/api/studio/briefs/${brief.id}`)
  assert.equal(validatePolished(before.body.polished).ok, true)

  const confirmed = await call(studioUrl, 'POST', `/api/studio/briefs/${brief.id}/confirm`, { ack: true })
  assert.equal(confirmed.status, 200)

  const created = await call(studioUrl, 'POST', '/api/studio/jobs', {
    input: '/data/upload.mp4',
    brief_id: brief.id,
    type: 'aigc'
  })
  assert.equal(created.status, 201)
  const detail = await call(studioUrl, 'GET', `/api/studio/jobs/${created.body.id}`)
  assert.equal(detail.status, 200)
  assert.equal(detail.body.brief_id, brief.id)
  assert.equal(detail.body.status, 'queued')
})

// --- #98 I1: Brief polished is forwarded to studio intake -------------------

test('I1 job without brief_id keeps the legacy payload shape', async () => {
  const before = intake.bodies().length
  const created = await call(studioUrl, 'POST', '/api/studio/jobs', {
    input: '/data/upload.mp4',
    type: 'aigc'
  })
  assert.equal(created.status, 201)
  assert.equal(intake.bodies().length, before + 1)
  const sent = intake.bodies()[intake.bodies().length - 1]
  assert.deepEqual(Object.keys(sent).sort(), ['input'])
  assert.equal(sent.input, '/data/upload.mp4')
})

test('I1 confirmed brief forwards brief_id + polished verbatim', async () => {
  const brief = await polishedBrief(stub)
  await call(studioUrl, 'POST', `/api/studio/briefs/${brief.id}/confirm`, { ack: true })

  const before = intake.bodies().length
  const created = await call(studioUrl, 'POST', '/api/studio/jobs', {
    input: '/data/upload.mp4',
    brief_id: brief.id,
    type: 'aigc'
  })
  assert.equal(created.status, 201)
  assert.equal(intake.bodies().length, before + 1)
  const sent = intake.bodies()[intake.bodies().length - 1]
  assert.equal(sent.brief_id, brief.id)
  assert.deepEqual(sent.polished, MINIMAL_POLISHED)
})

test('I1 invalid polished on a confirmed brief -> 409 brief_polished_invalid (no intake call)', async () => {
  const brief = await polishedBrief(stub)
  await call(studioUrl, 'POST', `/api/studio/briefs/${brief.id}/confirm`, { ack: true })

  const file = path.join(dataRoot, 'studio', 'briefs', `${brief.id}.json`)
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  doc.polished.logline = 123
  fs.writeFileSync(file, JSON.stringify(doc), 'utf8')

  const before = intake.bodies().length
  const created = await call(studioUrl, 'POST', '/api/studio/jobs', {
    input: '/data/upload.mp4',
    brief_id: brief.id,
    type: 'aigc'
  })
  assert.equal(created.status, 409)
  assert.equal(created.body.error, 'brief_polished_invalid')
  assert.equal(created.body.path, 'logline')
  assert.equal(intake.bodies().length, before)
})
