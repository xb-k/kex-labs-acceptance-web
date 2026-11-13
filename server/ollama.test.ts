/**
 * #120 Ollama relay token transport: header is attached only when
 * `OLLAMA_TOKEN` is non-empty, and relay errors pass through untouched.
 */
import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import { ollamaFetch, ollamaHeaders } from './ollama'

const savedToken = process.env.OLLAMA_TOKEN

afterEach(() => {
  if (savedToken === undefined) delete process.env.OLLAMA_TOKEN
  else process.env.OLLAMA_TOKEN = savedToken
})

test('ollamaHeaders adds X-Relay-Token when OLLAMA_TOKEN is set', () => {
  process.env.OLLAMA_TOKEN = 'relay-secret'
  const headers = ollamaHeaders({ 'Content-Type': 'application/json' })
  assert.equal(headers.get('X-Relay-Token'), 'relay-secret')
  assert.equal(headers.get('Content-Type'), 'application/json')
})

test('ollamaHeaders omits X-Relay-Token when OLLAMA_TOKEN is empty', () => {
  delete process.env.OLLAMA_TOKEN
  assert.equal(ollamaHeaders().has('X-Relay-Token'), false)
  process.env.OLLAMA_TOKEN = '   '
  assert.equal(ollamaHeaders().has('X-Relay-Token'), false)
})

test('ollamaFetch sends the token and does not swallow a relay 401', async () => {
  process.env.OLLAMA_TOKEN = 'relay-secret'
  const realFetch = globalThis.fetch
  const seen: Array<{ url: string; token: string | null }> = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    seen.push({ url, token: new Headers(init?.headers).get('X-Relay-Token') })
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' }
    })
  }) as typeof fetch
  try {
    const res = await ollamaFetch('http://relay.test:11437/api/tags', {
      headers: { Accept: 'application/json' }
    })
    assert.equal(res.status, 401)
    assert.equal(seen.length, 1)
    assert.equal(seen[0].token, 'relay-secret')
  } finally {
    globalThis.fetch = realFetch
  }
})
