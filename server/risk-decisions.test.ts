/**
 * #108 风险处置契约测试。
 *
 * 直接驱动 `createRiskDecision`（校验 / 404 / 409 / 评论失败 502 / 成功落库 /
 * 倒序查询）与 `handleRiskDecisionsRoute` 的真实 http 路径（同源放行、跨源 403、
 * 错 token 401、未配置 token 503）。临时目录只用于 jsonl，不碰真实 WEB_DATA_ROOT。
 */
import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { handleRiskDecisionsRoute, type RiskDecisionsDeps } from './api'
import {
  createRiskDecision,
  listRiskDecisions,
  RiskDecisionError,
  riskDecisionFile,
  validateRiskDecision,
  type RiskComment,
  type RiskTask
} from './risk-decisions'

let root = ''
before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'risk108-'))
})
after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function freshRoot(): string {
  return fs.mkdtempSync(path.join(root, 'case-'))
}

const INPUT = { task_id: 'T-VID-072', action: '同意了继续' as const, actor: '张三', note: '' }
const TASK: RiskTask = { id: 'T-VID-072', title: 'B 轨 S0 定稿', issue_number: 67 }

function jsonlLines(dataRoot: string): any[] {
  try {
    return fs
      .readFileSync(riskDecisionFile(dataRoot), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

test('validateRiskDecision 覆盖必填 / 长度 / 备注动作', () => {
  assert.equal(validateRiskDecision(null).ok, false)
  assert.equal(validateRiskDecision({ ...INPUT, task_id: '' }).ok, false)
  assert.equal(validateRiskDecision({ ...INPUT, action: '随便' }).ok, false)
  assert.equal(validateRiskDecision({ ...INPUT, actor: '  ' }).ok, false)
  assert.equal(validateRiskDecision({ ...INPUT, actor: '一'.repeat(41) }).ok, false)
  assert.equal(validateRiskDecision({ ...INPUT, note: '一'.repeat(501) }).ok, false)
  assert.equal(validateRiskDecision({ ...INPUT, action: '暂停等开发' }).ok, false)
  assert.equal(validateRiskDecision({ ...INPUT, action: '改期' }).ok, false)

  const ok = validateRiskDecision({ ...INPUT, actor: '  李四  ', note: ' 备注 ' })
  assert.deepEqual(ok, {
    ok: true,
    value: { task_id: 'T-VID-072', action: '同意了继续', actor: '李四', note: '备注' }
  })
})

test('createRiskDecision 成功：先发评论，再落一行完整 jsonl', async () => {
  const dataRoot = freshRoot()
  let seenIssue = 0
  let seenBody = ''
  const addComment = async (issueNumber: number, body: string): Promise<RiskComment> => {
    seenIssue = issueNumber
    seenBody = body
    return { id: '9001', url: 'http://gitea.test/c/9001' }
  }
  const decision = await createRiskDecision({
    dataRoot,
    input: { ...INPUT, action: '暂停等开发', note: '等开发修 B2 噪声' },
    task: TASK,
    addComment,
    now: () => new Date('2026-11-13T07:00:00.000Z')
  })

  assert.equal(seenIssue, 67)
  assert.match(seenBody, /风险处置 · 暂停等开发/)
  assert.match(seenBody, /T-VID-072 B 轨 S0 定稿/)
  assert.match(seenBody, /操作者：张三/)
  assert.match(seenBody, /备注：等开发修 B2 噪声/)
  assert.equal(decision.id.startsWith('rd-'), true)
  assert.equal(decision.issue_number, 67)
  assert.equal(decision.comment_id, '9001')
  assert.equal(decision.comment_url, 'http://gitea.test/c/9001')

  const lines = jsonlLines(dataRoot)
  assert.equal(lines.length, 1)
  for (const key of [
    'id',
    'ts',
    'task_id',
    'action',
    'actor',
    'note',
    'issue_number',
    'comment_id',
    'comment_url'
  ]) {
    assert.ok(key in lines[0], `jsonl 缺字段 ${key}`)
  }
  assert.equal(lines[0].task_id, 'T-VID-072')
  assert.equal(lines[0].action, '暂停等开发')
})

test('task 不存在 404，且不写库', async () => {
  const dataRoot = freshRoot()
  let called = false
  await assert.rejects(
    createRiskDecision({
      dataRoot,
      input: INPUT,
      task: null,
      addComment: async () => {
        called = true
        return { id: '1', url: null }
      }
    }),
    (err: unknown) => err instanceof RiskDecisionError && err.status === 404
  )
  assert.equal(called, false)
  assert.equal(jsonlLines(dataRoot).length, 0)
})

test('任务无 issue_number 409，且不发评论', async () => {
  const dataRoot = freshRoot()
  let called = false
  await assert.rejects(
    createRiskDecision({
      dataRoot,
      input: INPUT,
      task: { id: 'T-VID-072', title: 'x', issue_number: null },
      addComment: async () => {
        called = true
        return { id: '1', url: null }
      }
    }),
    (err: unknown) => err instanceof RiskDecisionError && err.status === 409
  )
  assert.equal(called, false)
  assert.equal(jsonlLines(dataRoot).length, 0)
})

test('评论失败 502，且不落库', async () => {
  const dataRoot = freshRoot()
  await assert.rejects(
    createRiskDecision({
      dataRoot,
      input: INPUT,
      task: TASK,
      addComment: async () => {
        throw new Error('gitea unavailable')
      }
    }),
    (err: unknown) =>
      err instanceof RiskDecisionError && err.status === 502 && /通知开发失败/.test(err.message)
  )
  assert.equal(jsonlLines(dataRoot).length, 0)
})

test('listRiskDecisions 按时间倒序并支持 task 过滤', () => {
  const dataRoot = freshRoot()
  const write = (id: string, ts: string, task_id: string) => {
    fs.mkdirSync(path.dirname(riskDecisionFile(dataRoot)), { recursive: true })
    fs.appendFileSync(
      riskDecisionFile(dataRoot),
      `${JSON.stringify({
        id,
        ts,
        task_id,
        action: '同意了继续',
        actor: '张三',
        note: '',
        issue_number: 1,
        comment_id: null,
        comment_url: null
      })}\n`
    )
  }
  write('rd-1', '2026-11-13T01:00:00.000Z', 'T-VID-072')
  write('rd-2', '2026-11-13T03:00:00.000Z', 'T-VID-073')
  write('rd-3', '2026-11-13T02:00:00.000Z', 'T-VID-072')

  assert.deepEqual(
    listRiskDecisions(dataRoot).map((d) => d.id),
    ['rd-2', 'rd-3', 'rd-1']
  )
  assert.deepEqual(
    listRiskDecisions(dataRoot, 'T-VID-072').map((d) => d.id),
    ['rd-3', 'rd-1']
  )
})

// ---------------------------------------------------------------------------
// HTTP 路由：守卫 + 201 + GET 倒序
// ---------------------------------------------------------------------------

let server: http.Server
let base = ''
let dataRoot = ''
let deps: RiskDecisionsDeps
let tasks: RiskTask[]
let commentError: Error | null
let comments: Array<{ issue: number; body: string }> = []

before(async () => {
  dataRoot = freshRoot()
  tasks = [TASK]
  commentError = null
  deps = {
    dataRoot,
    env: { WEB_WRITE_TOKEN: 'risk108-token' },
    listTasks: async () => tasks,
    addComment: async (issue, body) => {
      if (commentError) throw commentError
      comments.push({ issue, body })
      return { id: String(8000 + comments.length), url: `http://gitea.test/c/${8000 + comments.length}` }
    }
  }
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    handleRiskDecisionsRoute(req, res, url, decodeURIComponent(url.pathname), deps)
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

beforeEach(() => {
  tasks = [TASK]
  commentError = null
  comments = []
  deps.env = { WEB_WRITE_TOKEN: 'risk108-token' }
})

after(() => {
  server.close()
})

async function post(body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/api/risk-decisions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

test('同源 POST 201，并可由 GET 读回', async () => {
  const origin = base
  const res = await post(
    { task_id: 'T-VID-072', action: '接受风险（已知）', actor: '王五', note: '已知' },
    { Origin: origin }
  )
  assert.equal(res.status, 201)
  assert.equal(res.body.decision.task_id, 'T-VID-072')
  assert.equal(comments.length, 1)
  assert.match(comments[0].body, /风险处置 · 接受风险（已知）/)

  const list = await fetch(`${base}/api/risk-decisions?task=T-VID-072`, { headers: { Origin: origin } })
  assert.equal(list.status, 200)
  const body = (await list.json()) as any
  assert.equal(body.decisions.length, 1)
  assert.equal(body.decisions[0].comment_id, res.body.decision.comment_id)
})

test('跨源无 token 403', async () => {
  const res = await post({ ...INPUT }, { Origin: 'http://evil.example' })
  assert.equal(res.status, 403)
  assert.match(String(res.body.error), /same-origin|X-Web-Token/)
})

test('错 token 401', async () => {
  const res = await post({ ...INPUT }, { Origin: 'http://evil.example', 'X-Web-Token': 'wrong' })
  assert.equal(res.status, 401)
})

test('未配置 token 且带 token 头 503', async () => {
  deps.env = {}
  const res = await post({ ...INPUT }, { Origin: base, 'X-Web-Token': 'anything' })
  assert.equal(res.status, 503)
})

test('校验失败 400', async () => {
  const res = await post({ ...INPUT, actor: '' }, { Origin: base })
  assert.equal(res.status, 400)
})

test('task 不存在 404', async () => {
  const res = await post({ ...INPUT, task_id: 'T-VID-999' }, { Origin: base })
  assert.equal(res.status, 404)
})

test('无 issue_number 409', async () => {
  tasks = [{ id: 'T-VID-072', title: 'x', issue_number: null }]
  const res = await post({ ...INPUT }, { Origin: base })
  assert.equal(res.status, 409)
  assert.match(res.body.error, /未关联 Gitea issue/)
})

test('评论失败 502 且不写库', async () => {
  commentError = new Error('upstream down')
  const before = jsonlLines(dataRoot).length
  const res = await post({ ...INPUT }, { Origin: base })
  assert.equal(res.status, 502)
  assert.match(res.body.error, /通知开发失败/)
  assert.equal(jsonlLines(dataRoot).length, before)
})
