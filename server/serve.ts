/**
 * Standalone production server for the acceptance UI.
 *
 * Serves the built SPA from `dist/` and delegates `/api/*` + `/media/*` to the
 * same middleware used by `vite` dev/preview (server/api.ts). Bundled into
 * `server/serve.mjs` by `npm run build:server` so the runtime machine only
 * needs Node — no node_modules.
 */
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { handler, startStudioRetentionSweep } from './api'
import { closeDb, dbEnabled } from './db'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DIST_DIR = path.resolve(process.env.WEB_DIST_DIR || path.join(HERE, '..', 'dist'))
const PORT = Number(process.env.PORT || 8088)
const HOST = process.env.HOST || '0.0.0.0'

/**
 * Optional reverse-proxy mode (`UPSTREAM_URL=http://host:port`): every request
 * is streamed to the upstream instead of served locally. Used on studio, which
 * keeps its public URL while the data lives behind the NAS container.
 */
const UPSTREAM_RAW = process.env.UPSTREAM_URL?.trim() || null
const UPSTREAM_URL = UPSTREAM_RAW ? new URL(UPSTREAM_RAW) : null
/** Connect + first-byte budget only; the piping phase has no socket timeout. */
const UPSTREAM_TIMEOUT_MS = 30_000

/** Hop-by-hop headers (RFC 9110 §7.6.1) plus `proxy-*`, never forwarded. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
])

const forwardable = (name: string) => !HOP_BY_HOP.has(name) && !name.startsWith('proxy-')

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8'
}

const INDEX = path.join(DIST_DIR, 'index.html')

function sendFile(req: http.IncomingMessage, res: http.ServerResponse, file: string, cache: boolean) {
  const stat = fs.statSync(file)
  res.statusCode = 200
  res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream')
  res.setHeader('Content-Length', stat.size)
  res.setHeader('Cache-Control', cache ? 'public, max-age=31536000, immutable' : 'no-cache')
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  fs.createReadStream(file).pipe(res)
}

function sendIndex(req: http.IncomingMessage, res: http.ServerResponse) {
  if (!fs.existsSync(INDEX)) {
    res.statusCode = 503
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.end(`dist/index.html missing at ${INDEX} — run npm run build\n`)
    return
  }
  sendFile(req, res, INDEX, false)
}

/** Final middleware: static files under dist/, SPA fallback to index.html. */
function serveStatic(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  let pathname: string
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    res.statusCode = 400
    res.end('bad path\n')
    return
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405
    res.setHeader('Allow', 'GET, HEAD')
    res.end('method not allowed\n')
    return
  }
  if (pathname.includes('\0')) {
    res.statusCode = 400
    res.end('bad path\n')
    return
  }
  const file = path.resolve(DIST_DIR, '.' + pathname)
  if (file !== DIST_DIR && !file.startsWith(DIST_DIR + path.sep)) {
    res.statusCode = 403
    res.end('forbidden\n')
    return
  }
  if (pathname !== '/' && fs.existsSync(file) && fs.statSync(file).isFile()) {
    // Vite emits hashed filenames under assets/, safe to cache forever.
    sendFile(req, res, file, pathname.startsWith('/assets/'))
    return
  }
  sendIndex(req, res)
}

/**
 * Stream `req` to `UPSTREAM_URL` and pipe the response back untouched: method,
 * path + query, request body, status, and headers (minus hop-by-hop). A 30s
 * budget covers TCP connect + response headers only, so large downloads are
 * not cut off mid-transfer. Failures answer 502/504 with a generic text body;
 * the reason is logged server-side only.
 */
function proxyRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  const upstream = UPSTREAM_URL as URL
  const headers: http.OutgoingHttpHeaders = {}
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    const name = key.toLowerCase()
    if (forwardable(name)) headers[name] = value
  }
  const priorXff = req.headers['x-forwarded-for']
  const remote = req.socket.remoteAddress ?? 'unknown'
  const chain = Array.isArray(priorXff) ? priorXff.join(', ') : priorXff
  headers['x-forwarded-for'] = chain ? `${chain}, ${remote}` : remote
  headers['x-forwarded-proto'] = 'http'
  headers['x-forwarded-host'] = req.headers.host ?? ''
  headers.host = upstream.host

  const client = upstream.protocol === 'https:' ? https : http
  let timer: NodeJS.Timeout | undefined
  let failed = false
  const fail = (err: NodeJS.ErrnoException) => {
    if (failed) return
    failed = true
    if (timer) clearTimeout(timer)
    const timedOut = err.code === 'ETIMEDOUT' || /timeout/i.test(err.message)
    console.error(
      `[proxy] ${req.method} ${req.url} -> ${timedOut ? 504 : 502} (${err.message || err.code || 'error'})`
    )
    if (res.headersSent) {
      res.destroy()
      return
    }
    res.statusCode = timedOut ? 504 : 502
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.end('upstream unavailable\n')
  }

  const upstreamReq = client.request(
    {
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: req.url ?? '/',
      headers
    },
    (upstreamRes) => {
      if (timer) clearTimeout(timer)
      upstreamRes.on('error', (err) => {
        console.error(`[proxy] ${req.method} ${req.url} response stream error: ${err.message}`)
        res.destroy()
      })
      res.statusCode = upstreamRes.statusCode ?? 502
      for (const [key, value] of Object.entries(upstreamRes.headers)) {
        if (value === undefined) continue
        if (forwardable(key.toLowerCase())) res.setHeader(key, value)
      }
      upstreamRes.pipe(res)
    }
  )
  timer = setTimeout(() => upstreamReq.destroy(new Error('upstream timeout')), UPSTREAM_TIMEOUT_MS)
  upstreamReq.on('error', fail)
  req.on('aborted', () => upstreamReq.destroy())
  res.on('close', () => {
    if (!res.writableEnded) upstreamReq.destroy()
  })
  req.pipe(upstreamReq)
}

const server = http.createServer((req, res) => {
  res.on('error', (err) => console.error('[res error]', (err as Error).message))
  if (UPSTREAM_URL) {
    proxyRequest(req, res)
    return
  }
  Promise.resolve(handler(req, res, () => serveStatic(req, res))).catch((err: Error) => {
    console.error('[handler error]', err.stack || err.message)
    if (!res.headersSent) {
      res.statusCode = 500
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ error: 'internal error' }))
    } else {
      res.destroy()
    }
  })
})

server.on('clientError', (_err, socket) => {
  socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
})

server.listen(PORT, HOST, () => {
  console.log(
    `[acceptance-web] listening on http://${HOST}:${PORT} (dist=${DIST_DIR}, dataSource=${dbEnabled() ? 'postgres' : 'files'}, upstream=${UPSTREAM_RAW ?? 'local'})`
  )
  // #140: image-job retention runs once at boot, then hourly (proxy mode has no data root).
  if (!UPSTREAM_URL) startStudioRetentionSweep()
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`[acceptance-web] ${signal}, closing`)
    server.close(() => {
      void closeDb().finally(() => process.exit(0))
    })
    setTimeout(() => process.exit(0), 5000).unref()
  })
}
