/**
 * #124 contract tests: `POST /api/issues` write guard + payload validation.
 *
 * Both data-source branches (Gitea / files) call `authorizeIssueWrite` and
 * `validateIssue`; this file pins those two seams plus the 20KB body cap.
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import {
  ISSUE_BODY_MAX_BYTES,
  ISSUE_CREATE_LIMIT_PER_HOUR,
  authorizeIssueWrite,
  readRequestBody,
  resetIssueWriteRateLimit,
  validateIssue
} from './api'

const TOKEN = 'issue-write-test-token'

function req(headers: Record<string, string>, remoteAddress = '10.0.0.1'): IncomingMessage {
  return {
    method: 'POST',
    headers,
    socket: { remoteAddress }
  } as unknown as IncomingMessage
}

const SAME_ORIGIN = { host: '100.123.73.123:8088', origin: 'http://100.123.73.123:8088' }

beforeEach(() => resetIssueWriteRateLimit())

test('未设置 WEB_ISSUE_TOKEN：没有 Origin/Referer 的写请求 403', () => {
  // Given no token is configured and a script posts without Origin
  // When the guard runs
  const verdict = authorizeIssueWrite(req({ host: '100.123.73.123:8088' }), {})

  // Then the write is rejected as cross-origin
  assert.deepEqual(verdict, {
    ok: false,
    status: 403,
    error: 'same-origin browser request or X-Web-Token required'
  })
})

test('未设置 WEB_ISSUE_TOKEN：同源浏览器写请求放行且每 IP 限 10/h', () => {
  // Given no token, same-origin browser requests from one IP
  // When 10 creates happen
  for (let i = 0; i < ISSUE_CREATE_LIMIT_PER_HOUR; i += 1) {
    assert.deepEqual(authorizeIssueWrite(req(SAME_ORIGIN), {}, 1_000 + i), { ok: true })
  }

  // Then the 11th within the window is rate limited
  const blocked = authorizeIssueWrite(req(SAME_ORIGIN), {}, 1_100)
  assert.equal(blocked.ok, false)
  assert.equal(!blocked.ok && blocked.status, 429)

  // And a different IP still has its own budget
  assert.deepEqual(authorizeIssueWrite(req(SAME_ORIGIN, '10.0.0.2'), {}, 1_100), { ok: true })
})

test('未设置 WEB_ISSUE_TOKEN：限流窗口过期后恢复', () => {
  // Given one IP used up the hourly budget
  for (let i = 0; i < ISSUE_CREATE_LIMIT_PER_HOUR; i += 1) {
    authorizeIssueWrite(req(SAME_ORIGIN), {}, 1_000 + i)
  }
  assert.equal(authorizeIssueWrite(req(SAME_ORIGIN), {}, 2_000).ok, false)

  // When an hour has passed
  // Then the next create is accepted again
  assert.deepEqual(authorizeIssueWrite(req(SAME_ORIGIN), {}, 60 * 60 * 1000 + 5_000), { ok: true })
})

test('设置 WEB_ISSUE_TOKEN：缺 token / 错 token 401，正确 token 放行且不计限流', () => {
  // Given a configured token
  const env = { WEB_ISSUE_TOKEN: TOKEN }

  // When the header is missing or wrong
  // Then both are 401
  assert.equal(authorizeIssueWrite(req(SAME_ORIGIN), env).ok, false)
  assert.equal((authorizeIssueWrite(req(SAME_ORIGIN), env) as { status: number }).status, 401)
  const wrong = authorizeIssueWrite(req({ ...SAME_ORIGIN, 'x-web-token': 'nope' }), env)
  assert.equal(!wrong.ok && wrong.status, 401)

  // When the correct token is sent (even cross-origin), 11 times
  // Then every call is accepted (token mode has no per-IP budget)
  for (let i = 0; i < ISSUE_CREATE_LIMIT_PER_HOUR + 1; i += 1) {
    assert.deepEqual(
      authorizeIssueWrite(
        req({ host: 'example.test', origin: 'http://evil.test', 'x-web-token': TOKEN }),
        env
      ),
      { ok: true }
    )
  }
})

test('payload：title 必填且 ≤200', () => {
  // Given an empty / over-long title
  // When validated
  // Then both are rejected
  assert.deepEqual(validateIssue({ title: '  ' }), { error: 'title: 必填' })
  assert.deepEqual(validateIssue({ title: 'x'.repeat(201) }), { error: 'title: 长度需 1..200' })

  // And a 200-char title passes
  const ok = validateIssue({ title: 'x'.repeat(200) })
  assert.equal('fields' in ok && ok.fields.title.length, 200)
})

test('payload：labels 只接受白名单内的字符串数组', () => {
  // Given labels outside the whitelist / wrong shape
  // When validated
  // Then they are rejected
  assert.deepEqual(validateIssue({ title: 't', labels: 'P1' }), {
    error: 'labels: 必须是字符串数组'
  })
  assert.deepEqual(validateIssue({ title: 't', labels: [1] }), {
    error: 'labels: 必须是字符串数组'
  })
  assert.deepEqual(validateIssue({ title: 't', labels: ['not-a-label'] }), {
    error: 'labels: 不支持的标签 not-a-label'
  })

  // And whitelisted labels are deduplicated and returned
  const ok = validateIssue({ title: 't', labels: ['P1', 'rail/A', 'P1'] })
  assert.deepEqual('fields' in ok && ok.fields.labels, ['P1', 'rail/A'])
})

test('payload：description 仍限 2000 字（原有契约不回退）', () => {
  assert.deepEqual(validateIssue({ title: 't', description: 'x'.repeat(2001) }), {
    error: 'description: 长度不能超过 2000'
  })
})

test('payload：超过 20KB 的请求体返回 PAYLOAD_TOO_LARGE', async () => {
  // Given a JSON body larger than the issue cap
  const body = Buffer.from(JSON.stringify({ title: 't', description: 'x'.repeat(ISSUE_BODY_MAX_BYTES) }))
  const stream = Readable.from([body]) as unknown as IncomingMessage

  // When read with the issue-specific cap
  // Then it rejects with the 413 marker instead of a generic 400
  await assert.rejects(readRequestBody(stream, ISSUE_BODY_MAX_BYTES), (err: NodeJS.ErrnoException) => {
    assert.equal(err.code, 'PAYLOAD_TOO_LARGE')
    return true
  })
})
