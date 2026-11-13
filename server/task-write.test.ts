/**
 * #105 contract tests: `PATCH /api/tasks/:id` write guard.
 *
 * The browser never holds `WEB_WRITE_TOKEN`; the guard allows same-origin page
 * writes while keeping the token authoritative for scripts / cross-origin
 * callers. Every branch is exercised through the exported `authorizeTaskWrite`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage } from 'node:http'
import { authorizeTaskWrite } from './api'

function req(headers: Record<string, string>): IncomingMessage {
  return { method: 'PATCH', headers } as unknown as IncomingMessage
}

const TOKEN = 'task-write-test-token'

test('same-origin browser PATCH (no token header) is allowed', () => {
  // Given the deployed host behind serve.ts (public host kept in x-forwarded-host)
  // When a browser PATCHes from the same origin
  const verdict = authorizeTaskWrite(
    req({ 'x-forwarded-host': '100.123.73.123:8088', origin: 'http://100.123.73.123:8088' }),
    { WEB_WRITE_TOKEN: TOKEN }
  )
  // Then it is authorised without the browser knowing the token
  assert.deepEqual(verdict, { ok: true })
})

test('same-origin PATCH on the local dev port is allowed', () => {
  const verdict = authorizeTaskWrite(
    req({ host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173' }),
    { WEB_WRITE_TOKEN: TOKEN }
  )
  assert.deepEqual(verdict, { ok: true })
})

test('cross-origin PATCH without token is rejected with 403', () => {
  const verdict = authorizeTaskWrite(
    req({ host: '100.123.73.123:8088', origin: 'http://evil.example' }),
    { WEB_WRITE_TOKEN: TOKEN }
  )
  assert.equal(verdict.ok, false)
  if (!verdict.ok) assert.equal(verdict.status, 403)
})

test('no Origin / no token is rejected with 403', () => {
  const verdict = authorizeTaskWrite(req({ host: '100.123.73.123:8088' }), {
    WEB_WRITE_TOKEN: TOKEN
  })
  assert.equal(verdict.ok, false)
  if (!verdict.ok) assert.equal(verdict.status, 403)
})

test('valid X-Web-Token wins even from a cross-origin caller', () => {
  const verdict = authorizeTaskWrite(
    req({ host: '100.123.73.123:8088', origin: 'http://script.example', 'x-web-token': TOKEN }),
    { WEB_WRITE_TOKEN: TOKEN }
  )
  assert.deepEqual(verdict, { ok: true })
})

test('invalid X-Web-Token is 401 even on a same-origin request (token wins)', () => {
  const verdict = authorizeTaskWrite(
    req({ host: '100.123.73.123:8088', origin: 'http://100.123.73.123:8088', 'x-web-token': 'nope' }),
    { WEB_WRITE_TOKEN: TOKEN }
  )
  assert.equal(verdict.ok, false)
  if (!verdict.ok) assert.equal(verdict.status, 401)
})

test('X-Web-Token when the server has none configured is 503', () => {
  const verdict = authorizeTaskWrite(req({ host: '127.0.0.1:8088', 'x-web-token': TOKEN }), {})
  assert.equal(verdict.ok, false)
  if (!verdict.ok) assert.equal(verdict.status, 503)
})

test('same-origin without a configured token still works (local dev)', () => {
  const verdict = authorizeTaskWrite(req({ host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173' }), {})
  assert.deepEqual(verdict, { ok: true })
})

test('cross-origin without a configured token is 403, never 503', () => {
  const verdict = authorizeTaskWrite(
    req({ host: '127.0.0.1:5173', origin: 'http://evil.example' }),
    {}
  )
  assert.equal(verdict.ok, false)
  if (!verdict.ok) assert.equal(verdict.status, 403)
})
