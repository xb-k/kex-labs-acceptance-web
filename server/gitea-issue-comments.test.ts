/**
 * #110 Gitea issue detail / comment contract tests.
 *
 * Network is mocked at `fetch`; the tests pin URL, auth header, payload,
 * ordering, cache invalidation and 404 propagation.
 */
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  GiteaError,
  addIssueComment,
  issueComments,
  issueDetail
} from './gitea'
import { validateIssueComment } from './api'

const ENV_KEYS = ['GITEA_URL', 'GITEA_REPO', 'GITEA_TOKEN', 'GITEA_WEB_URL'] as const
const saved = new Map<string, string | undefined>()
const originalFetch = globalThis.fetch

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

beforeEach(() => {
  for (const key of ENV_KEYS) saved.set(key, process.env[key])
  process.env.GITEA_URL = 'http://gitea.test'
  process.env.GITEA_REPO = 'gitadmin/kex-labs-video'
  process.env.GITEA_TOKEN = 'test-token'
  delete process.env.GITEA_WEB_URL
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  globalThis.fetch = originalFetch
})

test('issueDetail maps the raw issue and authenticates server-side', async () => {
  // Given Gitea returns one issue
  let seenUrl = ''
  let seenAuth = ''
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    seenUrl = String(input)
    seenAuth = String((init?.headers as Record<string, string>)?.Authorization ?? '')
    return jsonResponse({
      number: 110,
      title: '详情与回复',
      body: '正文',
      state: 'open',
      html_url: 'http://gitea.test/gitadmin/kex-labs-video/issues/110',
      comments: 2,
      created_at: '2026-11-13T01:00:00Z',
      updated_at: '2026-11-13T02:00:00Z',
      labels: [{ name: 'P1', color: 'FF0000' }],
      assignee: { login: 'kexinbao' },
      user: { login: 'gitadmin' }
    })
  }) as typeof fetch

  // When the detail is read
  const item = await issueDetail(110)

  // Then it is mapped to the browser contract and the token never reaches the client
  assert.equal(item.number, 110)
  assert.equal(item.title, '详情与回复')
  assert.equal(item.description, '正文')
  assert.deepEqual(item.labels, [{ name: 'P1', color: 'FF0000' }])
  assert.equal(item.owner, 'kexinbao')
  // #110 修复：作者取创建者 user.login，不能再用 assignee 冒充。
  assert.equal(item.author, 'gitadmin')
  assert.equal(item.comments, 2)
  assert.equal(seenUrl, 'http://gitea.test/api/v1/repos/gitadmin/kex-labs-video/issues/110')
  assert.equal(seenAuth, 'token test-token')
})

test('issueComments maps and sorts oldest first', async () => {
  // Given Gitea returns comments newest first
  globalThis.fetch = (async () =>
    jsonResponse([
      {
        id: 12,
        body: '后来的',
        created_at: '2026-11-13T03:00:00Z',
        html_url: 'http://gitea.test/c/12',
        user: { login: 'b' }
      },
      {
        id: 11,
        body: '先来的',
        created_at: '2026-11-13T02:00:00Z',
        html_url: 'http://gitea.test/c/11',
        user: { login: 'a' }
      }
    ])) as typeof fetch

  // When both are read
  const comments = await issueComments(111)

  // Then they are oldest first with author/body/url mapped
  assert.deepEqual(
    comments.map((comment) => [comment.id, comment.body, comment.author]),
    [
      ['11', '先来的', 'a'],
      ['12', '后来的', 'b']
    ]
  )
  assert.equal(comments[0].url, 'http://gitea.test/c/11')
})

test('addIssueComment POSTs the body and invalidates the read cache', async () => {
  // Given a cached comment list and a POST creating a new comment
  let calls = 0
  let posted: unknown = null
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls += 1
    const url = String(input)
    if (init?.method === 'POST') {
      posted = JSON.parse(String(init.body))
      assert.ok(url.endsWith('/issues/112/comments'))
      return jsonResponse(
        {
          id: 21,
          body: '回复内容',
          created_at: '2026-11-13T04:00:00Z',
          html_url: 'http://gitea.test/c/21',
          user: { login: 'kexinbao' }
        },
        201
      )
    }
    return jsonResponse(
      calls === 1
        ? []
        : [
            {
              id: 21,
              body: '回复内容',
              created_at: '2026-11-13T04:00:00Z',
              html_url: 'http://gitea.test/c/21',
              user: { login: 'kexinbao' }
            }
          ]
    )
  }) as typeof fetch

  const before = await issueComments(112)
  assert.deepEqual(before, [])

  // When a comment is posted
  const created = await addIssueComment(112, '回复内容')

  // Then the payload is `{ body }` and the next read bypasses the stale cache
  assert.deepEqual(posted, { body: '回复内容' })
  assert.equal(created.id, '21')
  const after = await issueComments(112)
  assert.equal(after.length, 1)
  assert.equal(after[0].body, '回复内容')
})

test('issueDetail propagates Gitea 404 so the route can answer 404', async () => {
  globalThis.fetch = (async () => jsonResponse({ message: 'not found' }, 404)) as typeof fetch
  await assert.rejects(
    () => issueDetail(113),
    (err: unknown) =>
      err instanceof GiteaError && err.reason === 'upstream error' && err.status === 404
  )
})

test('comment body validation enforces 1..8000 after trimming', () => {
  const errorOf = (value: ReturnType<typeof validateIssueComment>) =>
    'error' in value ? value.error : undefined
  assert.equal(errorOf(validateIssueComment({ body: '   ' })), 'body: 长度需 1..8000')
  assert.equal(errorOf(validateIssueComment({ body: 1 })), 'body: 必填')
  assert.equal(errorOf(validateIssueComment({ body: 'x'.repeat(8001) })), 'body: 长度需 1..8000')
  assert.deepEqual(validateIssueComment({ body: '  收到  ' }), { body: '收到' })
})
