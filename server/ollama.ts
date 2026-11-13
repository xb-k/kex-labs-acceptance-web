/**
 * Shared Ollama transport (#120).
 *
 * The studio keeps Ollama bound to loopback; any caller that is not on the
 * studio host reaches it through the relay (`OLLAMA_URL`, e.g. …:11437), which
 * requires `X-Relay-Token`. The token comes from `OLLAMA_TOKEN` and is attached
 * only when configured, so loopback dev/test stays header-free.
 *
 * Route these calls through `ollamaFetch` instead of bare `fetch` so a new
 * Ollama call site cannot silently omit the relay token.
 */
export function ollamaHeaders(init?: HeadersInit): Headers {
  const headers = new Headers(init)
  const token = process.env.OLLAMA_TOKEN?.trim()
  if (token) headers.set('X-Relay-Token', token)
  return headers
}

export function ollamaFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, headers: ollamaHeaders(init.headers) })
}
