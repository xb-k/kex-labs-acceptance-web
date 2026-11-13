/**
 * #122/#127 制片总台处置接口契约测试。
 *
 * 覆盖 `validateDecision` / `appendDecision` 的校验与 jsonl 追加语义，
 * 真实 http 路由的四条守卫分支（同源 201 / 跨源 403 / 错 token 401 /
 * 非法 action 或缺失 job 400），以及 `insights` 的双目录合并排序去重。
 * 临时目录只用于 jsonl，不碰真实 WEB_DATA_ROOT。
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { authorizeTaskWrite } from './api'
import {
  appendDecision,
  decisionFile,
  handleDecisionsRoute,
  validateDecision,
  type DecisionsDeps
} from './decisions'
import { mergeDecisions, readDecisions } from './insights'

let root = ''
before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'decisions122-'))
})
after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function freshRoot(): string {
  return fs.mkdtempSync(path.join(root, 'case-'))
}

function jsonlLines(dataRoot: string, job: string): any[] {
  try {
    return fs
      .readFileSync(decisionFile(dataRoot, job), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

const INPUT = {
  job: 'studio-job-1',
  action: 'adopt' as const,
  actor: '制片总台',
  note: 'B2 已完成',
  stage: 'B2',
  tool: 'ltxv'
}

test('validateDecision 覆盖合法输入 / 非法 action / 缺 job / 不安全文件名', () => {
  const ok = validateDecision({ ...INPUT, actor: '  制片总台  ', note: '  B2 已完成  ' })
  assert.deepEqual(ok, {
    ok: true,
    value: { ...INPUT, actor: '制片总台', note: 'B2 已完成' }
  })

  assert.equal(validateDecision(null).ok, false)
  assert.equal(validateDecision([]).ok, false)
  assert.equal(validateDecision({ ...INPUT, action: 'approve' }).ok, false)
  assert.equal(validateDecision({ ...INPUT, job: '' }).ok, false)
  assert.equal(validateDecision({ job: undefined, action: 'adopt', actor: 'x' }).ok, false)
  assert.equal(validateDecision({ ...INPUT, job: '../etc/passwd' }).ok, false)
  assert.equal(validateDecision({ ...INPUT, job: 'a..b' }).ok, false)
  assert.equal(validateDecision({ ...INPUT, actor: '' }).ok, false)
  assert.equal(validateDecision({ ...INPUT, actor: '一'.repeat(41) }).ok, false)
  assert.equal(validateDecision({ ...INPUT, note: '一'.repeat(501) }).ok, false)
})

test('appendDecision 单行追加且不覆盖既有历史', () => {
  const dataRoot = freshRoot()
  const first = appendDecision(dataRoot, INPUT, () => new Date('2026-11-14T01:00:00.000Z'))
  const second = appendDecision(
    dataRoot,
    { ...INPUT, action: 'reject', note: '噪声' },
    () => new Date('2026-11-14T02:00:00.000Z')
  )

  assert.equal(first.at, '2026-11-14T01:00:00.000Z')
  assert.equal(second.at, '2026-11-14T02:00:00.000Z')

  const lines = jsonlLines(dataRoot, INPUT.job)
  assert.equal(lines.length, 2)
  assert.deepEqual(lines[0], first)
  assert.deepEqual(lines[1], second)
  assert.equal(lines[1].action, 'reject')
})

// ---------------------------------------------------------------------------
// HTTP 路由：真实 authorizeTaskWrite 守卫 + 201 + 400
// ---------------------------------------------------------------------------

let server: http.Server
let base = ''
let dataRoot = ''
let deps: DecisionsDeps

before(async () => {
  dataRoot = freshRoot()
  deps = {
    dataRoot,
    env: { WEB_WRITE_TOKEN: 'decisions-token' },
    authorize: authorizeTaskWrite,
    sendJson: (res, status, body) => {
      res.statusCode = status
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(body))
    }
  }
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    handleDecisionsRoute(req, res, url, decodeURIComponent(url.pathname), deps)
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
  const port = (server.address() as AddressInfo).port
  base = `http://127.0.0.1:${port}`
})

after(() => {
  server.close()
})

async function post(body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/api/decisions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

test('同源 POST 201，服务端生成 at 并追加一行', async () => {
  const res = await post({ ...INPUT, job: 'job-http' }, { Origin: base })
  assert.equal(res.status, 201)
  assert.equal(res.body.decision.job, 'job-http')
  assert.equal(res.body.decision.action, 'adopt')
  assert.match(String(res.body.decision.at), /^\d{4}-\d{2}-\d{2}T/)

  const lines = jsonlLines(dataRoot, 'job-http')
  assert.equal(lines.length, 1)
  assert.equal(lines[0].note, 'B2 已完成')
})

test('非法 action 400 且不写库', async () => {
  const res = await post({ ...INPUT, job: 'job-bad-action', action: 'approve' }, { Origin: base })
  assert.equal(res.status, 400)
  assert.match(String(res.body.error), /action/)
  assert.equal(jsonlLines(dataRoot, 'job-bad-action').length, 0)
})

test('缺 job 400 且不写库', async () => {
  const res = await post({ action: 'adopt', actor: '制片总台' }, { Origin: base })
  assert.equal(res.status, 400)
  assert.match(String(res.body.error), /job/)
})

test('跨源无 token 403', async () => {
  const res = await post(INPUT, { Origin: 'http://evil.example' })
  assert.equal(res.status, 403)
  assert.match(String(res.body.error), /same-origin|X-Web-Token/)
})

test('错 token 401', async () => {
  const res = await post(INPUT, { Origin: 'http://evil.example', 'X-Web-Token': 'wrong' })
  assert.equal(res.status, 401)
})

test('正确 token 允许跨源写入', async () => {
  const res = await post({ ...INPUT, job: 'job-token' }, {
    Origin: 'http://evil.example',
    'X-Web-Token': 'decisions-token'
  })
  assert.equal(res.status, 201)
  assert.equal(jsonlLines(dataRoot, 'job-token').length, 1)
})

// ---------------------------------------------------------------------------
// insights 合并读取：两处目录 → 去重 → 按 at 升序 → 取最新 limit 条
// ---------------------------------------------------------------------------

function writeDecisionFile(dir: string, job: string, rows: any[]): void {
  const file = decisionFile(dir, job)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, rows.map((row) => `${JSON.stringify(row)}\n`).join(''), 'utf8')
}

test('mergeDecisions 去重、按 at 升序并截断最新 limit 条', () => {
  const shared = { job: 'j', action: 'adopt', at: '2026-11-14T02:00:00.000Z' }
  const groups = [
    [shared, { job: 'j', action: 'reject', at: '2026-11-14T03:00:00.000Z' }],
    [
      shared,
      { job: 'j', action: 'adopt', at: '2026-11-14T01:00:00.000Z' }
    ],
    [{ job: 'j', action: 'reject', at: '2026-11-14T04:00:00.000Z' }]
  ]

  const merged = mergeDecisions(groups)
  assert.deepEqual(
    merged.map((d) => d.at),
    [
      '2026-11-14T01:00:00.000Z',
      '2026-11-14T02:00:00.000Z',
      '2026-11-14T03:00:00.000Z',
      '2026-11-14T04:00:00.000Z'
    ]
  )
  assert.deepEqual(mergeDecisions(groups, 2).map((d) => d.at), [
    '2026-11-14T03:00:00.000Z',
    '2026-11-14T04:00:00.000Z'
  ])
})

test('readDecisions 合并只读根与可写根，坏行只告警', () => {
  const readonlyRoot = freshRoot()
  const writableRoot = freshRoot()
  const dup = { job: 'job-merge', action: 'adopt', at: '2026-11-14T02:00:00.000Z' }
  writeDecisionFile(readonlyRoot, 'job-merge', [
    { job: 'job-merge', action: 'reject', at: '2026-11-14T01:00:00.000Z' },
    dup
  ])
  const writableFile = decisionFile(writableRoot, 'job-merge')
  fs.mkdirSync(path.dirname(writableFile), { recursive: true })
  fs.writeFileSync(
    writableFile,
    `${JSON.stringify(dup)}\nnot-json\n${JSON.stringify({
      job: 'job-merge',
      action: 'adopt',
      at: '2026-11-14T03:00:00.000Z'
    })}\n`,
    'utf8'
  )

  const warnings: string[] = []
  const merged = readDecisions(readonlyRoot, 'job-merge', warnings, writableRoot)
  assert.deepEqual(merged.map((d) => d.at), [
    '2026-11-14T01:00:00.000Z',
    '2026-11-14T02:00:00.000Z',
    '2026-11-14T03:00:00.000Z'
  ])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /bad decision line/)

  // 同一个根不重复读。
  const same = readDecisions(readonlyRoot, 'job-merge', [], readonlyRoot)
  assert.deepEqual(same.map((d) => d.at), [
    '2026-11-14T01:00:00.000Z',
    '2026-11-14T02:00:00.000Z'
  ])
})
