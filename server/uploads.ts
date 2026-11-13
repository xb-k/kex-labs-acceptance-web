/**
 * Chunked NAS uploads (issue #94a).
 *
 * Files are written under `<DATA_ROOT>/uploads/<upload_id>/`: `meta.json`, the
 * chunk files `chunks/<index>` and, after a successful `complete`, the joined
 * `source.<ext>`. `complete` also stages the source to the studio intake
 * (`POST /intake/uploads`, issue #86 C4) and persists the returned absolute
 * `studio_path` in `meta.json`; `POST /api/uploads/:id/probe` reuses it.
 *
 * Reads and writes both need the exact `X-Web-Token` or a same-origin request
 * (same rule as `studio.ts`), so upload ids cannot be enumerated anonymously.
 * Nothing here logs request bodies or the token.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { authorizedForWrite } from './studio'
import { serveFile } from './media'

export interface UploadsContext {
  dataRoot: string
  intakeUrl: string
  intakeTimeoutMs: number
  webToken: string | null
  isSameOrigin: (req: IncomingMessage) => boolean
  sendJson: (res: ServerResponse, status: number, body: unknown) => void
  readJson: (file: string) => any
  atomicWriteJson: (file: string, value: unknown) => void
  readBody: (req: IncomingMessage) => Promise<any>
  maxBytes: number
}

const UPLOAD_ID_RE = /^[a-z0-9-]{8,64}$/
const SHA256_RE = /^[a-f0-9]{64}$/i
const INDEX_RE = /^\d{1,6}$/
const CHUNK_RE = /^\d+$/
const CHUNK_SIZE = 4194304
const VIDEO_EXTS = ['.mp4', '.mov', '.m4v', '.mkv', '.webm']
/** #89b: reference images for `image` jobs (t2i / edit) — staged via the same intake. */
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp']
const ALLOWED_EXTS = new Set([...VIDEO_EXTS, ...IMAGE_EXTS])
const MAX_FILENAME_LENGTH = 200
// AC4: abandoned uploads are pruned lazily on the next init. Completed uploads
// (`status: 'ready'`) are never touched — the user's source must stay available.
const PRUNE_AGE_MS = 24 * 60 * 60 * 1000
const PRUNE_MAX_DIRS = 200
// Same budget as `studio.ts` upload forwarding: the source is streamed once more.
const STUDIO_FORWARD_TIMEOUT_MS = 10 * 60 * 1000

export interface UploadProbe {
  path: string
  probe: Record<string, unknown>
  shots: unknown
  shots_reason: string | null
  plan: Record<string, unknown>
  probed_at: string
}

interface UploadMeta {
  upload_id: string
  filename: string
  size: number
  sha256: string | null
  ext: string
  chunk_size: number
  status: 'uploading' | 'ready'
  created_at: string
  completed_at?: string
  path?: string
  /** Absolute source path on the studio host (issue #86 C4). */
  studio_path?: string | null
  /** Last successful `POST /intake/probe` result, persisted verbatim. */
  probe?: UploadProbe | null
}

function nowIso(): string {
  return new Date().toISOString()
}

function uploadsRoot(ctx: UploadsContext): string {
  return path.join(ctx.dataRoot, 'uploads')
}

function uploadDir(ctx: UploadsContext, id: string): string {
  return path.join(uploadsRoot(ctx), id)
}

function metaPath(ctx: UploadsContext, id: string): string {
  return path.join(uploadDir(ctx, id), 'meta.json')
}

function chunksDir(ctx: UploadsContext, id: string): string {
  return path.join(uploadDir(ctx, id), 'chunks')
}

function sourcePath(ctx: UploadsContext, meta: UploadMeta): string {
  return path.join(uploadDir(ctx, meta.upload_id), `source${meta.ext}`)
}

/**
 * #89d: reject path traversal at init instead of silently basenaming it.
 * Catches NUL, any path separator, Windows drive prefixes and `..` names.
 * Normal names (Chinese, spaces, dots inside the stem) still pass — they are
 * cleaned later by `cleanFilename`.
 */
export function filenameRejection(raw: unknown): string | null {
  if (typeof raw !== 'string') return 'filename: 需为不含路径的文件名'
  const input = raw.trim()
  if (!input) return 'filename: 不能为空'
  if (input.includes('\x00')) return 'filename: 不能包含 NUL'
  if (input.includes('/') || input.includes('\\')) return 'filename: 不能包含路径分隔符'
  if (/^[A-Za-z]:/.test(input)) return 'filename: 不能为绝对路径'
  const segments = input.split(/[\\/]+/)
  if (segments.some((seg) => seg === '..')) return 'filename: 不能包含 ..'
  return null
}

/** Basename only, ASCII whitelist (the studio intake reads the filename header). */
function cleanFilename(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const input = raw.trim()
  if (!input || input.includes('\x00')) return null
  const base = path.posix.basename(input.replace(/\\/g, '/'))
  const ext = path.extname(base).toLowerCase()
  const stem = base
    .slice(0, base.length - path.extname(base).length)
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._-]+|_+$/g, '')
    .slice(0, Math.max(MAX_FILENAME_LENGTH - ext.length, 1))
  const cleaned = `${stem || 'upload'}${ext}`
  if (cleaned === '.' || cleaned === '..') return null
  return cleaned
}

function newUploadId(): string {
  return `up-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`
}

function readMeta(ctx: UploadsContext, id: string): UploadMeta | null {
  if (!UPLOAD_ID_RE.test(id)) return null
  const doc = ctx.readJson(metaPath(ctx, id))
  if (!doc || typeof doc !== 'object' || doc.upload_id !== id) return null
  return doc as UploadMeta
}

function requireAuth(
  ctx: UploadsContext,
  req: IncomingMessage,
  res: ServerResponse
): boolean {
  return authorizedForWrite(ctx.webToken, ctx.isSameOrigin, req, res, ctx.sendJson)
}

function totalChunks(size: number, chunkSize: number): number {
  return Math.ceil(size / chunkSize)
}

/** Present chunk index → on-disk byte count. Dot-files (in-flight `.tmp`) are ignored. */
function scanChunks(dir: string): Map<number, number> {
  let names: string[] = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return new Map()
  }
  const present = new Map<number, number>()
  for (const name of names) {
    if (!CHUNK_RE.test(name)) continue
    const index = Number(name)
    try {
      const stat = fs.statSync(path.join(dir, name))
      if (stat.isFile()) present.set(index, stat.size)
    } catch {
      // vanished between readdir and stat; treat as missing
    }
  }
  return present
}

function uploadState(ctx: UploadsContext, meta: UploadMeta) {
  const dir = chunksDir(ctx, meta.upload_id)
  const present = scanChunks(dir)
  const total = totalChunks(meta.size, meta.chunk_size)
  let received = 0
  const missing: number[] = []
  if (meta.status === 'ready') {
    received = meta.size
  } else {
    for (let index = 0; index < total; index++) {
      const bytes = present.get(index)
      if (bytes === undefined) {
        missing.push(index)
      } else {
        received += bytes
      }
    }
  }
  return { received, missing, total }
}

function initPayload(meta: UploadMeta, maxBytes: number) {
  return {
    upload_id: meta.upload_id,
    filename: meta.filename,
    size: meta.size,
    chunk_size: meta.chunk_size,
    max_bytes: maxBytes,
    received: 0,
    status: meta.status
  }
}

/**
 * AC4 lazy cleanup: removes upload directories that were abandoned more than
 * 24h ago. Only `status: 'uploading'` directories with an old `created_at` and
 * meta-less orphan directories with an old mtime are deleted; `ready` uploads
 * are always kept. Anything outside `<dataRoot>/uploads` is never touched and a
 * failed removal only logs — init must not be blocked.
 */
function pruneUploads(ctx: UploadsContext, nowMs = Date.now()): void {
  const root = path.resolve(uploadsRoot(ctx))
  let names: string[]
  try {
    names = fs.readdirSync(root)
  } catch {
    return
  }
  let scanned = 0
  for (const name of names) {
    if (scanned >= PRUNE_MAX_DIRS) break
    const dir = path.resolve(root, name)
    if (!dir.startsWith(root + path.sep)) continue
    let stat: fs.Stats
    try {
      stat = fs.statSync(dir)
    } catch {
      continue
    }
    if (!stat.isDirectory()) continue
    scanned++

    let ageMs = 0
    let reason = ''
    const metaFile = path.join(dir, 'meta.json')
    if (!fs.existsSync(metaFile)) {
      ageMs = nowMs - stat.mtimeMs
      if (ageMs > PRUNE_AGE_MS) reason = 'orphan'
    } else {
      const meta = ctx.readJson(metaFile)
      if (meta && typeof meta === 'object' && meta.status === 'uploading') {
        const created = Date.parse(String(meta.created_at))
        if (Number.isFinite(created)) {
          ageMs = nowMs - created
          if (ageMs > PRUNE_AGE_MS) reason = 'stale-uploading'
        }
      }
    }
    if (!reason) continue
    try {
      fs.rmSync(dir, { recursive: true, force: true })
      console.log(`[uploads] prune ${name} age=${Math.round(ageMs / 3600000)}h reason=${reason}`)
    } catch (err) {
      console.log(`[uploads] prune-failed ${name} reason=${reason} error=${(err as Error).message}`)
    }
  }
}

async function initUpload(
  ctx: UploadsContext,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  pruneUploads(ctx)
  let body: any
  try {
    body = await ctx.readBody(req)
  } catch {
    ctx.sendJson(res, 400, { error: 'invalid JSON body' })
    return
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    ctx.sendJson(res, 400, { error: 'body must be a JSON object' })
    return
  }
  const rejected = filenameRejection(body.filename)
  if (rejected) {
    ctx.sendJson(res, 400, { error: rejected })
    return
  }
  const filename = cleanFilename(body.filename)
  if (!filename) {
    ctx.sendJson(res, 400, { error: 'filename: 需为不含路径的文件名' })
    return
  }
  const ext = path.extname(filename).toLowerCase()
  if (!ALLOWED_EXTS.has(ext)) {
    ctx.sendJson(res, 400, { error: `filename: 仅支持 ${[...ALLOWED_EXTS].join(' ')}` })
    return
  }
  const size = body.size
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1) {
    ctx.sendJson(res, 400, { error: 'size: 需为 ≥1 的整数（字节）' })
    return
  }
  if (size > ctx.maxBytes) {
    ctx.sendJson(res, 400, { error: `size: 超过上限 ${ctx.maxBytes}` })
    return
  }
  let sha256: string | null = null
  if (body.sha256 !== undefined && body.sha256 !== null) {
    if (typeof body.sha256 !== 'string' || !SHA256_RE.test(body.sha256)) {
      ctx.sendJson(res, 400, { error: 'sha256: 需为 64 位十六进制' })
      return
    }
    sha256 = body.sha256.toLowerCase()
  }

  const id = newUploadId()
  const meta: UploadMeta = {
    upload_id: id,
    filename,
    size,
    sha256,
    ext,
    chunk_size: CHUNK_SIZE,
    status: 'uploading',
    created_at: nowIso()
  }
  fs.mkdirSync(chunksDir(ctx, id), { recursive: true })
  ctx.atomicWriteJson(metaPath(ctx, id), meta)
  console.log(`[uploads] init ${id} size=${size} ext=${ext}`)
  ctx.sendJson(res, 201, initPayload(meta, ctx.maxBytes))
}

/** Streams one chunk to `chunks/.<index>.*.tmp`, then renames it into place. */
async function putChunk(
  ctx: UploadsContext,
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  rawIndex: string
): Promise<void> {
  if (!UPLOAD_ID_RE.test(id)) {
    ctx.sendJson(res, 400, { error: 'invalid upload id' })
    return
  }
  const meta = readMeta(ctx, id)
  if (!meta) {
    ctx.sendJson(res, 404, { error: 'upload not found' })
    return
  }
  if (!INDEX_RE.test(rawIndex)) {
    ctx.sendJson(res, 400, { error: 'invalid chunk index' })
    return
  }
  const index = Number(rawIndex)
  const total = totalChunks(meta.size, meta.chunk_size)
  if (index >= total) {
    req.resume()
    ctx.sendJson(res, 416, { error: 'chunk index out of range', total_chunks: total })
    return
  }
  if (meta.status === 'ready') {
    req.resume()
    ctx.sendJson(res, 409, { error: 'upload already completed' })
    return
  }
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > meta.chunk_size) {
    req.resume()
    ctx.sendJson(res, 413, { error: `chunk exceeds ${meta.chunk_size} bytes` })
    return
  }

  const dir = chunksDir(ctx, id)
  fs.mkdirSync(dir, { recursive: true })
  const final = path.join(dir, String(index))
  // Retried chunk from a resumed upload: keep the existing file (sha/mtime) when
  // it already has the exact size this index must carry.
  const expectedSize = index === total - 1 ? meta.size - index * meta.chunk_size : meta.chunk_size
  try {
    const existing = fs.statSync(final)
    if (existing.isFile() && existing.size === expectedSize) {
      req.resume()
      const state = uploadState(ctx, meta)
      ctx.sendJson(res, 201, {
        upload_id: id,
        index,
        received: state.received,
        size: meta.size,
        missing_chunks: state.missing
      })
      return
    }
  } catch {
    // chunk not written yet
  }
  const tmp = path.join(dir, `.${index}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`)

  let bytes = 0
  let finished = false
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(tmp, { flags: 'wx' })
    const fail = (code: 'too_large' | 'empty' | 'io') => {
      if (finished) return
      finished = true
      out.destroy()
      fs.rm(tmp, { force: true }, () => {})
      reject(new Error(code))
    }
    req.on('data', (buf: Buffer) => {
      bytes += buf.length
      if (bytes > meta.chunk_size) fail('too_large')
    })
    req.on('aborted', () => fail('io'))
    req.on('error', () => fail('io'))
    out.on('error', () => fail('io'))
    out.on('finish', () => {
      if (finished) return
      if (bytes === 0) {
        fail('empty')
        return
      }
      try {
        fs.renameSync(tmp, final)
      } catch {
        fail('io')
        return
      }
      finished = true
      resolve()
    })
    req.pipe(out)
  }).catch((err: Error) => {
    if (err.message === 'too_large') {
      req.resume()
      ctx.sendJson(res, 413, { error: `chunk exceeds ${meta.chunk_size} bytes` })
    } else if (err.message === 'empty') {
      ctx.sendJson(res, 400, { error: 'empty chunk' })
    } else {
      ctx.sendJson(res, 500, { error: 'chunk write failed' })
    }
  })
  if (res.writableEnded) return

  const state = uploadState(ctx, meta)
  console.log(`[uploads] chunk ${id} #${index} ${bytes}B received=${state.received}/${meta.size}`)
  ctx.sendJson(res, 201, {
    upload_id: id,
    index,
    received: state.received,
    size: meta.size,
    missing_chunks: state.missing
  })
}

function getUpload(ctx: UploadsContext, res: ServerResponse, id: string): void {
  if (!UPLOAD_ID_RE.test(id)) {
    ctx.sendJson(res, 400, { error: 'invalid upload id' })
    return
  }
  const meta = readMeta(ctx, id)
  if (!meta) {
    ctx.sendJson(res, 404, { error: 'upload not found' })
    return
  }
  const state = uploadState(ctx, meta)
  ctx.sendJson(res, 200, {
    upload_id: id,
    status: meta.status,
    filename: meta.filename,
    size: meta.size,
    received: state.received,
    missing_chunks: state.missing,
    sha256: meta.sha256,
    path: meta.path ?? null,
    studio_path: meta.studio_path ?? null
  })
}

/** `POST /api/uploads/:id/probe` — C4 read-only probe proxied to the studio. */
async function probeUpload(
  ctx: UploadsContext,
  res: ServerResponse,
  id: string
): Promise<void> {
  if (!UPLOAD_ID_RE.test(id)) {
    ctx.sendJson(res, 400, { error: 'invalid upload id' })
    return
  }
  const meta = readMeta(ctx, id)
  if (!meta) {
    ctx.sendJson(res, 404, { error: 'upload not found' })
    return
  }
  if (meta.status !== 'ready') {
    ctx.sendJson(res, 409, { error: 'upload not ready', status: meta.status })
    return
  }

  let studioPath = meta.studio_path
  if (!studioPath) {
    const staged = await stageSource(ctx, meta)
    if (!staged.ok) {
      ctx.sendJson(res, staged.status, {
        error: staged.error,
        reason: staged.reason,
        upload_id: id
      })
      return
    }
    studioPath = staged.studioPath
    ctx.atomicWriteJson(metaPath(ctx, id), { ...meta, studio_path: studioPath })
  }

  const probed = await callProbe(ctx, studioPath)
  if (!probed.ok) {
    ctx.sendJson(res, probed.status, probed.body)
    return
  }
  const body = probed.body
  const record: UploadProbe = {
    path: typeof body.path === 'string' ? body.path : studioPath,
    probe: body.probe,
    shots: body.shots ?? null,
    shots_reason: typeof body.shots_reason === 'string' ? body.shots_reason : null,
    plan: body.plan,
    probed_at: nowIso()
  }
  ctx.atomicWriteJson(metaPath(ctx, id), { ...meta, studio_path: studioPath, probe: record })
  console.log(`[uploads] probe ${id}`)
  ctx.sendJson(res, 200, body)
}

function fetchReason(err: unknown): string {
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return 'timeout'
  }
  const cause = (err as { cause?: { code?: unknown; message?: unknown } } | null)?.cause
  if (typeof cause?.code === 'string') return cause.code
  if (typeof cause?.message === 'string' && cause.message) return cause.message
  return 'network error'
}

type StageResult =
  | { ok: true; studioPath: string }
  | { ok: false; status: number; error: string; reason: string }

/**
 * Streams the joined source to the studio intake and returns its absolute path.
 * Idempotent on the studio side (same upload id + sha256 → 200), so a failed
 * `complete` can be retried without re-uploading chunks.
 */
async function stageSource(ctx: UploadsContext, meta: UploadMeta): Promise<StageResult> {
  const source = sourcePath(ctx, meta)
  const sha = typeof meta.sha256 === 'string' ? meta.sha256 : ''
  try {
    const stat = fs.statSync(source)
    if (!stat.isFile() || stat.size !== meta.size || !SHA256_RE.test(sha)) {
      return { ok: false, status: 409, error: 'source_missing', reason: 'source file missing' }
    }
  } catch {
    return { ok: false, status: 409, error: 'source_missing', reason: 'source file missing' }
  }

  try {
    const upstream = await fetch(`${ctx.intakeUrl}/intake/uploads`, {
      method: 'POST',
      headers: {
        'X-Web-Token': ctx.webToken ?? '',
        'X-Upload-Id': meta.upload_id,
        'X-Filename': meta.filename,
        'X-Sha256': sha,
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(meta.size)
      },
      body: fs.createReadStream(source) as unknown as BodyInit,
      duplex: 'half',
      signal: AbortSignal.timeout(STUDIO_FORWARD_TIMEOUT_MS)
    } as unknown as RequestInit)
    const text = await upstream.text().catch(() => '')
    let parsed: any = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      parsed = null
    }
    if (upstream.status !== 200 && upstream.status !== 201) {
      const reason =
        upstream.status === 404
          ? 'upstream_404'
          : typeof parsed?.error === 'string'
            ? parsed.error
            : `status_${upstream.status}`
      return { ok: false, status: 502, error: 'studio_upload_rejected', reason }
    }
    if (
      !parsed ||
      typeof parsed.path !== 'string' ||
      typeof parsed.size !== 'number' ||
      parsed.size !== meta.size ||
      typeof parsed.sha256 !== 'string' ||
      parsed.sha256.toLowerCase() !== sha.toLowerCase()
    ) {
      return {
        ok: false,
        status: 502,
        error: 'studio_upload_rejected',
        reason: 'invalid_studio_response'
      }
    }
    return { ok: true, studioPath: parsed.path }
  } catch (err) {
    const reason = fetchReason(err)
    console.error(`[uploads] POST /intake/uploads -> ${reason}`)
    return {
      ok: false,
      status: reason === 'timeout' ? 504 : 502,
      error: 'studio_unreachable',
      reason
    }
  }
}

type ProbeCall =
  | { ok: true; body: any }
  | { ok: false; status: number; body: { error: string; reason: string } }

/** Read-only `POST /intake/probe`; 4xx bodies are passed through untouched. */
async function callProbe(ctx: UploadsContext, source: string): Promise<ProbeCall> {
  try {
    const upstream = await fetch(`${ctx.intakeUrl}/intake/probe`, {
      method: 'POST',
      headers: {
        'X-Web-Token': ctx.webToken ?? '',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ path: source }),
      signal: AbortSignal.timeout(ctx.intakeTimeoutMs)
    })
    const text = await upstream.text().catch(() => '')
    let parsed: any = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      parsed = null
    }
    if (upstream.status >= 400) {
      const body =
        parsed && typeof parsed === 'object'
          ? parsed
          : { error: `status_${upstream.status}`, reason: 'probe_failed' }
      return { ok: false, status: upstream.status, body }
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !parsed.probe ||
      typeof parsed.probe !== 'object' ||
      !parsed.plan ||
      typeof parsed.plan !== 'object'
    ) {
      return {
        ok: false,
        status: 502,
        body: { error: 'invalid_studio_response', reason: 'probe' }
      }
    }
    return { ok: true, body: parsed }
  } catch (err) {
    const reason = fetchReason(err)
    console.error(`[uploads] POST /intake/probe -> ${reason}`)
    return {
      ok: false,
      status: reason === 'timeout' ? 504 : 502,
      body: { error: 'studio_unreachable', reason }
    }
  }
}

async function completeUpload(
  ctx: UploadsContext,
  res: ServerResponse,
  id: string
): Promise<void> {
  if (!UPLOAD_ID_RE.test(id)) {
    ctx.sendJson(res, 400, { error: 'invalid upload id' })
    return
  }
  const meta = readMeta(ctx, id)
  if (!meta) {
    ctx.sendJson(res, 404, { error: 'upload not found' })
    return
  }
  const target = sourcePath(ctx, meta)
  if (meta.status === 'ready') {
    if (!meta.studio_path) {
      const staged = await stageSource(ctx, meta)
      if (!staged.ok) {
        ctx.sendJson(res, staged.status, {
          error: staged.error,
          reason: staged.reason,
          upload_id: id
        })
        return
      }
      meta.studio_path = staged.studioPath
      ctx.atomicWriteJson(metaPath(ctx, id), meta)
    }
    ctx.sendJson(res, 200, {
      upload_id: id,
      path: target,
      studio_path: meta.studio_path,
      size: meta.size,
      sha256: meta.sha256,
      filename: meta.filename
    })
    return
  }

  const state = uploadState(ctx, meta)
  if (state.missing.length > 0) {
    ctx.sendJson(res, 409, { error: 'missing_chunks', missing_chunks: state.missing })
    return
  }
  if (state.received !== meta.size) {
    ctx.sendJson(res, 422, { error: 'size_mismatch', expected: meta.size, actual: state.received })
    return
  }

  const dir = chunksDir(ctx, id)
  const tmp = path.join(uploadDir(ctx, id), `.source.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`)
  const hash = crypto.createHash('sha256')
  let written = 0
  try {
    const out = fs.createWriteStream(tmp, { flags: 'wx' })
    for (let index = 0; index < state.total; index++) {
      const input = fs.createReadStream(path.join(dir, String(index)))
      for await (const buf of input) {
        const chunk = buf as Buffer
        written += chunk.length
        hash.update(chunk)
        if (!out.write(chunk)) {
          await new Promise<void>((resolve) => out.once('drain', resolve))
        }
      }
    }
    await new Promise<void>((resolve, reject) => {
      out.end(() => resolve())
      out.on('error', reject)
    })
    const fh = await fs.promises.open(tmp, 'r+')
    await fh.sync()
    await fh.close()
  } catch {
    fs.rm(tmp, { force: true }, () => {})
    ctx.sendJson(res, 500, { error: 'complete failed' })
    return
  }

  const digest = hash.digest('hex')
  if (written !== meta.size) {
    fs.rm(tmp, { force: true }, () => {})
    ctx.sendJson(res, 422, { error: 'size_mismatch', expected: meta.size, actual: written })
    return
  }
  if (meta.sha256 && digest !== meta.sha256) {
    fs.rm(tmp, { force: true }, () => {})
    ctx.sendJson(res, 422, { error: 'sha256_mismatch', expected: meta.sha256, actual: digest })
    return
  }
  try {
    fs.renameSync(tmp, target)
  } catch {
    fs.rm(tmp, { force: true }, () => {})
    ctx.sendJson(res, 500, { error: 'complete failed' })
    return
  }

  const next: UploadMeta = {
    ...meta,
    sha256: digest,
    status: 'ready',
    completed_at: nowIso(),
    path: target
  }
  ctx.atomicWriteJson(metaPath(ctx, id), next)
  fs.rmSync(dir, { recursive: true, force: true })
  console.log(`[uploads] complete ${id} size=${written}`)

  // #86 C4: stage the source on the studio host and keep its absolute path.
  // A staging failure leaves `meta.status=ready` (chunks are gone, sha verified),
  // so a retried `complete` only re-runs this step.
  const staged = await stageSource(ctx, next)
  if (!staged.ok) {
    ctx.sendJson(res, staged.status, {
      error: staged.error,
      reason: staged.reason,
      upload_id: id
    })
    return
  }
  const withStudio: UploadMeta = { ...next, studio_path: staged.studioPath }
  ctx.atomicWriteJson(metaPath(ctx, id), withStudio)
  ctx.sendJson(res, 200, {
    upload_id: id,
    path: target,
    studio_path: staged.studioPath,
    size: written,
    sha256: digest,
    filename: meta.filename
  })
}

/**
 * #86b2 C5：浏览器播放原片。只读、需鉴权（同 uploads 其它路由），
 * 文件路径由 upload_id 推导，绝不回传 `path`/`studio_path`。
 */
async function serveUploadSource(
  ctx: UploadsContext,
  req: IncomingMessage,
  res: ServerResponse,
  id: string
): Promise<void> {
  if (!UPLOAD_ID_RE.test(id)) {
    ctx.sendJson(res, 400, { error: 'invalid upload id' })
    return
  }
  const meta = readMeta(ctx, id)
  if (!meta) {
    ctx.sendJson(res, 404, { error: 'upload not found' })
    return
  }
  if (meta.status !== 'ready') {
    ctx.sendJson(res, 409, { error: 'upload not ready', status: meta.status })
    return
  }
  const file = sourcePath(ctx, meta)
  if (!fs.existsSync(file)) {
    ctx.sendJson(res, 404, { error: 'source not found' })
    return
  }
  serveFile(req, res, file)
}

export async function handleUploadsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  pathname: string,
  ctx: UploadsContext
): Promise<boolean> {
  if (pathname !== '/api/uploads' && !pathname.startsWith('/api/uploads/')) return false
  const method = req.method ?? 'GET'

  if (!requireAuth(ctx, req, res)) return true

  if (pathname === '/api/uploads/init') {
    if (method !== 'POST') {
      ctx.sendJson(res, 405, { error: 'method not allowed' })
      return true
    }
    await initUpload(ctx, req, res)
    return true
  }

  const chunksMatch = pathname.match(/^\/api\/uploads\/([^/]+)\/chunks\/([^/]+)$/)
  if (chunksMatch) {
    if (method !== 'PUT') {
      ctx.sendJson(res, 405, { error: 'method not allowed' })
      return true
    }
    await putChunk(ctx, req, res, chunksMatch[1], chunksMatch[2])
    return true
  }

  const completeMatch = pathname.match(/^\/api\/uploads\/([^/]+)\/complete$/)
  if (completeMatch) {
    if (method !== 'POST') {
      ctx.sendJson(res, 405, { error: 'method not allowed' })
      return true
    }
    await completeUpload(ctx, res, completeMatch[1])
    return true
  }

  const probeMatch = pathname.match(/^\/api\/uploads\/([^/]+)\/probe$/)
  if (probeMatch) {
    if (method !== 'POST') {
      ctx.sendJson(res, 405, { error: 'method not allowed' })
      return true
    }
    await probeUpload(ctx, res, probeMatch[1])
    return true
  }

  // #86b2 C5：原片只读流媒体（Range），浏览器永远拿不到 nas_path 绝对路径。
  const sourceMatch = pathname.match(/^\/api\/uploads\/([^/]+)\/source$/)
  if (sourceMatch) {
    if (method !== 'GET' && method !== 'HEAD') {
      ctx.sendJson(res, 405, { error: 'method not allowed' })
      return true
    }
    await serveUploadSource(ctx, req, res, sourceMatch[1])
    return true
  }

  const metaMatch = pathname.match(/^\/api\/uploads\/([^/]+)$/)
  if (metaMatch) {
    if (method !== 'GET' && method !== 'HEAD') {
      ctx.sendJson(res, 405, { error: 'method not allowed' })
      return true
    }
    getUpload(ctx, res, metaMatch[1])
    return true
  }

  ctx.sendJson(res, 404, { error: 'not found' })
  return true
}
