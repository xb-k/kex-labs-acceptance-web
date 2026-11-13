/**
 * Shared read-only file serving with HTTP Range (issue #86b2).
 *
 * Used by the upload source proxy (`uploads.ts`) and the studio artifact proxy
 * (`studio.ts`). `api.ts` keeps its own `serveMedia`; this module stays free of
 * that import so the two leaf modules can share it without a cycle.
 */
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'

const MEDIA_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4v': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp'
}

export function contentTypeFor(file: string): string {
  return MEDIA_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
}

/** Streams `filePath` (200 or 206). The caller has already checked existence/allowlist. */
export function serveFile(req: IncomingMessage, res: ServerResponse, filePath: string): void {
  const stat = fs.statSync(filePath)
  const type = contentTypeFor(filePath)
  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('Content-Type', type)
  // Short TTL: artifacts and sources are read-only but can be re-produced.
  res.setHeader('Cache-Control', 'private, max-age=30')

  const range = req.headers.range
  if (!range) {
    res.statusCode = 200
    res.setHeader('Content-Length', stat.size)
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    fs.createReadStream(filePath).pipe(res)
    return
  }

  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
  if (!m || (!m[1] && !m[2])) {
    res.statusCode = 416
    res.setHeader('Content-Range', `bytes */${stat.size}`)
    res.end()
    return
  }
  let start = m[1] ? Number(m[1]) : 0
  let end = m[2] ? Number(m[2]) : stat.size - 1
  if (!m[1] && m[2]) {
    const suffix = Number(m[2])
    start = Math.max(0, stat.size - suffix)
    end = stat.size - 1
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= stat.size) {
    res.statusCode = 416
    res.setHeader('Content-Range', `bytes */${stat.size}`)
    res.end()
    return
  }
  end = Math.min(end, stat.size - 1)
  res.statusCode = 206
  res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`)
  res.setHeader('Content-Length', end - start + 1)
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  fs.createReadStream(filePath, { start, end }).pipe(res)
}

/**
 * Streams an upstream fetch body through without buffering (issue #86b2).
 * Preserves Range semantics: status 206 and `Content-Range` come from upstream.
 * Short TTL matches `serveFile` — artifacts are read-only but can be rebuilt.
 */
export function serveStream(
  req: IncomingMessage,
  res: ServerResponse,
  body: ReadableStream<Uint8Array> | null,
  init: {
    status: number
    contentType: string
    contentLength?: string | null
    contentRange?: string | null
    acceptRanges?: string | null
  }
): void {
  res.statusCode = init.status
  res.setHeader('Content-Type', init.contentType)
  res.setHeader('Cache-Control', 'private, max-age=30')
  res.setHeader('Accept-Ranges', init.acceptRanges ?? 'bytes')
  if (init.contentLength) res.setHeader('Content-Length', init.contentLength)
  if (init.contentRange) res.setHeader('Content-Range', init.contentRange)
  if (req.method === 'HEAD' || !body) {
    res.end()
    return
  }
  const stream = Readable.fromWeb(body as any)
  stream.on('error', () => {
    if (!res.headersSent) res.statusCode = 502
    res.destroy()
  })
  stream.pipe(res)
}
