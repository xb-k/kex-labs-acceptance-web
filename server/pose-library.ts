/**
 * #138 姿态参考库（pose library）后端。
 *
 * 数据落在 `WEB_DATA_ROOT/pose-library/entries.json`（顶层数组，原子写）。
 * 入库前置是 license：协议必须在白名单内，且必须给出 https 的授权证据链接；
 * 来源不明 / 证据缺失一律 400 `license_unverified`，不做「先入库再补证」。
 *
 * 契约：
 *  - 必填 `label_zh`（含中文、≤60 字）、`source_url`（https）、`license`、
 *    `license_evidence_url`（https）；`license_verified` 由服务端派生为 true；
 *  - `source_url` 归一化后唯一，重复入库 409 `duplicate_source_url`；
 *  - `preview_url` 可选：https，或以 `/` 开头的本服务数据路径；
 *  - `suitable_shots` 仅限枚举值；`tags` 最多 10 个；
 *  - id / created_at 由服务端生成，不信任客户端。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  readPoseSyncStatus,
  runPoseSync,
  type FetchLike,
  type PoseSyncResult
} from './pose-sync'
import { createUploadFromBytes } from './uploads'

export const POSE_LICENSES = [
  'CC0',
  'CC-BY-4.0',
  'CC-BY-SA-4.0',
  'MIT',
  'Apache-2.0',
  'OWNED'
] as const
export type PoseLicense = (typeof POSE_LICENSES)[number]

export const SUITABLE_SHOTS = ['closeup', 'medium', 'wide', 'full_body', 'action'] as const
export type SuitableShot = (typeof SUITABLE_SHOTS)[number]

export const LABEL_MAX = 60
export const TAGS_MAX = 10
export const NOTE_MAX = 500
export const LIST_LIMIT_DEFAULT = 20
export const LIST_LIMIT_MAX = 100

// #138 materialize：预览图抓取预算与允许类型。
const PREVIEW_MAX_BYTES = 15 * 1024 * 1024
const PREVIEW_TIMEOUT_MS = 20_000
// GitHub contents API 走的是同一条出口，大图（>1MB）在 NAS 慢链路上会超过 20s。
const PREVIEW_API_TIMEOUT_MS = 60_000
const PREVIEW_MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp'
}
const PREVIEW_FILE_EXT: Record<string, string> = {
  '.png': '.png',
  '.jpg': '.jpg',
  '.jpeg': '.jpg',
  '.webp': '.webp'
}

export type PoseEntry = {
  id: string
  label_zh: string
  preview_url: string | null
  source_url: string
  license: PoseLicense
  license_evidence_url: string
  license_verified: boolean
  suitable_shots: SuitableShot[]
  tags: string[]
  note: string
  created_at: string
}

export type PoseEntryInput = Omit<PoseEntry, 'id' | 'license_verified' | 'created_at'>

export type ValidationResult =
  | { ok: true; value: PoseEntryInput }
  | { ok: false; status: 400; error: string }

export function poseLibraryDir(dataRoot: string): string {
  return path.join(dataRoot, 'pose-library')
}

export function poseLibraryFile(dataRoot: string): string {
  return path.join(poseLibraryDir(dataRoot), 'entries.json')
}

function isHttpsUrl(value: unknown): boolean {
  if (typeof value !== 'string' || !value.trim()) return false
  try {
    const url = new URL(value.trim())
    return url.protocol === 'https:' && Boolean(url.hostname)
  } catch {
    return false
  }
}

/**
 * `source_url` 去重键：去掉 hash、统一小写 host、去掉根路径以外的尾斜杠。
 * 查询串保持原样（不同 query 可能指向不同素材）。
 */
export function normalizeSourceUrl(raw: string): string {
  const url = new URL(raw.trim())
  url.hash = ''
  let pathname = url.pathname
  if (pathname.length > 1) pathname = pathname.replace(/\/+$/, '')
  return `${url.protocol}//${url.host}${pathname}${url.search}`
}

function sourceKey(raw: string): string {
  try {
    return normalizeSourceUrl(raw)
  } catch {
    return raw.trim()
  }
}

/**
 * `raw.githubusercontent.com` 直链 → GitHub contents API 等价 URL。
 * NAS 容器到 raw 域名的 DNS 只解析出 IPv6（无路由），但 api.github.com 可达，
 * 因此抓图失败时用 contents API + `Accept: application/vnd.github.raw` 兜底。
 * 非 raw 直链或路径不足 `<owner>/<repo>/<ref>/<path>` 时返回 null。
 */
export function normalizeGithubRawUrl(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'raw.githubusercontent.com') {
    return null
  }
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length < 4) return null
  const [owner, repo, ref, ...rest] = parts
  return `https://api.github.com/repos/${owner}/${repo}/contents/${rest.join('/')}?ref=${encodeURIComponent(ref)}`
}

/** contents API 抓 raw 内容所需请求头；token 只用于请求，不落日志/响应。 */
export function githubRawHeaders(env: NodeJS.ProcessEnv = {}): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.raw',
    'User-Agent': 'kex-acceptance-web-pose-preview'
  }
  const token = env.GITHUB_TOKEN?.trim()
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

function isValidPreviewUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  return isHttpsUrl(trimmed) || (trimmed.startsWith('/') && !trimmed.startsWith('//') && trimmed.length > 1)
}

export function validatePoseInput(body: unknown): ValidationResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, error: 'invalid_body' }
  }
  const input = body as Record<string, unknown>

  // license 是入库前置：未知协议 / 缺证据 / 证据非 https 一律拒绝。
  const license = typeof input.license === 'string' ? input.license.trim() : ''
  const evidence =
    typeof input.license_evidence_url === 'string' ? input.license_evidence_url.trim() : ''
  if (
    !POSE_LICENSES.includes(license as PoseLicense) ||
    !isHttpsUrl(evidence) ||
    input.license_verified === false
  ) {
    return { ok: false, status: 400, error: 'license_unverified' }
  }

  const label = typeof input.label_zh === 'string' ? input.label_zh.trim() : ''
  if (!label || [...label].length > LABEL_MAX || !/[\u3400-\u9fff]/.test(label)) {
    return { ok: false, status: 400, error: 'label_zh_invalid' }
  }

  const sourceUrl = typeof input.source_url === 'string' ? input.source_url.trim() : ''
  if (!isHttpsUrl(sourceUrl)) {
    return { ok: false, status: 400, error: 'source_url_invalid' }
  }

  const previewRaw = input.preview_url
  if (previewRaw !== undefined && previewRaw !== null && previewRaw !== '' && !isValidPreviewUrl(previewRaw)) {
    return { ok: false, status: 400, error: 'preview_url_invalid' }
  }

  let suitable: SuitableShot[] = []
  if (input.suitable_shots !== undefined) {
    if (!Array.isArray(input.suitable_shots)) {
      return { ok: false, status: 400, error: 'suitable_shots_invalid' }
    }
    const seen = new Set<string>()
    for (const shot of input.suitable_shots) {
      if (typeof shot !== 'string' || !SUITABLE_SHOTS.includes(shot as SuitableShot)) {
        return { ok: false, status: 400, error: 'suitable_shots_invalid' }
      }
      seen.add(shot)
    }
    suitable = SUITABLE_SHOTS.filter((shot) => seen.has(shot))
  }

  let tags: string[] = []
  if (input.tags !== undefined) {
    if (!Array.isArray(input.tags)) {
      return { ok: false, status: 400, error: 'tags_invalid' }
    }
    const seen = new Set<string>()
    for (const tag of input.tags) {
      if (typeof tag !== 'string') return { ok: false, status: 400, error: 'tags_invalid' }
      const trimmed = tag.trim()
      if (!trimmed) return { ok: false, status: 400, error: 'tags_invalid' }
      seen.add(trimmed)
    }
    if (seen.size > TAGS_MAX) {
      return { ok: false, status: 400, error: 'tags_invalid' }
    }
    tags = [...seen]
  }

  let note = ''
  if (input.note !== undefined) {
    if (typeof input.note !== 'string') return { ok: false, status: 400, error: 'note_invalid' }
    note = input.note.trim()
    if ([...note].length > NOTE_MAX) return { ok: false, status: 400, error: 'note_invalid' }
  }

  return {
    ok: true,
    value: {
      label_zh: label,
      preview_url:
        typeof previewRaw === 'string' && previewRaw.trim() ? previewRaw.trim() : null,
      source_url: sourceUrl,
      license: license as PoseLicense,
      license_evidence_url: evidence,
      suitable_shots: suitable,
      tags,
      note
    }
  }
}

export function readPoseEntries(dataRoot: string, readJson: (file: string) => any | null): PoseEntry[] {
  const raw = readJson(poseLibraryFile(dataRoot))
  if (Array.isArray(raw)) return raw as PoseEntry[]
  if (raw && typeof raw === 'object' && Array.isArray((raw as { entries?: unknown }).entries)) {
    return (raw as { entries: PoseEntry[] }).entries
  }
  return []
}

/** 临时文件 + rename，保证读侧永远看到完整 JSON。 */
export function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, file)
}

// 同进程内串行化 read-modify-write，避免并发 POST 互相覆盖。
const writeQueues = new Map<string, Promise<unknown>>()

function withFileLock<T>(file: string, fn: () => T | Promise<T>): Promise<T> {
  const previous = writeQueues.get(file) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(fn)
  writeQueues.set(file, next)
  return next.finally(() => {
    if (writeQueues.get(file) === next) writeQueues.delete(file)
  })
}

export type AddPoseResult =
  | { ok: true; item: PoseEntry }
  | { ok: false; status: 409; error: 'duplicate_source_url' }

export async function addPoseEntry(opts: {
  dataRoot: string
  value: PoseEntryInput
  readJson: (file: string) => any | null
  atomicWriteJson: (file: string, value: unknown) => void
  now?: () => Date
}): Promise<AddPoseResult> {
  const file = poseLibraryFile(opts.dataRoot)
  const key = sourceKey(opts.value.source_url)
  return withFileLock(file, () => {
    const entries = readPoseEntries(opts.dataRoot, opts.readJson)
    if (entries.some((entry) => sourceKey(String(entry.source_url ?? '')) === key)) {
      return { ok: false, status: 409, error: 'duplicate_source_url' }
    }
    const item: PoseEntry = {
      id: `pose_${crypto.randomUUID()}`,
      ...opts.value,
      license_verified: true,
      created_at: (opts.now?.() ?? new Date()).toISOString()
    }
    opts.atomicWriteJson(file, [...entries, item])
    return { ok: true, item }
  })
}

export async function deletePoseEntry(opts: {
  dataRoot: string
  id: string
  readJson: (file: string) => any | null
  atomicWriteJson: (file: string, value: unknown) => void
}): Promise<PoseEntry | null> {
  const file = poseLibraryFile(opts.dataRoot)
  return withFileLock(file, () => {
    const entries = readPoseEntries(opts.dataRoot, opts.readJson)
    const index = entries.findIndex((entry) => entry.id === opts.id)
    if (index < 0) return null
    const [removed] = entries.splice(index, 1)
    opts.atomicWriteJson(file, entries)
    return removed
  })
}

export type PoseLibraryQuery = {
  q: string
  license: string
  shot: string
  limit: number
  offset: number
}

export type PoseLibraryFilterResult =
  | { ok: true; items: PoseEntry[]; total: number; limit: number; offset: number }
  | { ok: false; status: 400; error: string }

function parseNonNegativeInt(raw: string | null, fallback: number): number | null {
  if (raw === null || raw === '') return fallback
  const n = Number(raw)
  return Number.isSafeInteger(n) && n >= 0 ? n : null
}

export function filterPoseEntries(entries: PoseEntry[], query: PoseLibraryQuery): PoseLibraryFilterResult {
  if (query.license && !POSE_LICENSES.includes(query.license as PoseLicense)) {
    return { ok: false, status: 400, error: 'license_invalid' }
  }
  if (query.shot && !SUITABLE_SHOTS.includes(query.shot as SuitableShot)) {
    return { ok: false, status: 400, error: 'shot_invalid' }
  }
  if (query.limit > LIST_LIMIT_MAX) {
    query = { ...query, limit: LIST_LIMIT_MAX }
  }

  const needle = query.q.trim().toLowerCase()
  const matched = entries
    .slice()
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .filter((entry) => {
      if (query.license && entry.license !== query.license) return false
      if (query.shot && !entry.suitable_shots.includes(query.shot as SuitableShot)) return false
      if (!needle) return true
      const haystack = [entry.label_zh, entry.note, ...(entry.tags ?? [])].join('\n').toLowerCase()
      return haystack.includes(needle)
    })

  return {
    ok: true,
    items: matched.slice(query.offset, query.offset + query.limit),
    total: matched.length,
    limit: query.limit,
    offset: query.offset
  }
}

export type PoseLibraryDeps = {
  dataRoot: string
  readJson: (file: string) => any | null
  atomicWriteJson: (file: string, value: unknown) => void
  readBody: (req: IncomingMessage) => Promise<unknown>
  authorize: (req: IncomingMessage) => { ok: true } | { ok: false; status: number; error: string }
  sendJson: (res: ServerResponse, status: number, body: unknown) => void
  /** 测试注入；生产默认全局 fetch / process.env。 */
  fetchImpl?: FetchLike
  env?: NodeJS.ProcessEnv
  now?: () => Date
  /** #138 materialize：复用 uploads 的 studio intake 配置。 */
  uploads?: {
    intakeUrl: string
    webToken: string | null
  }
}

type PreviewResult =
  | { ok: true; bytes: Buffer; ext: string }
  | { ok: false; reason: string }

async function readCapped(response: Response, maxBytes: number): Promise<Buffer | null> {
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer())
    return bytes.length > maxBytes ? null : bytes
  }
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

function readLocalPreview(dataRoot: string, previewUrl: string): PreviewResult {
  let url: URL
  try {
    url = new URL(previewUrl, 'http://local')
  } catch {
    return { ok: false, reason: 'invalid_url' }
  }
  // 站内路径只认 /media/artifact?path=…（与 api.ts 的只读媒体口一致）。
  if (url.pathname !== '/media/artifact') {
    return { ok: false, reason: 'unsupported_local_path' }
  }
  const raw = url.searchParams.get('path')
  if (!raw) return { ok: false, reason: 'missing_path' }

  let root: string
  try {
    root = fs.realpathSync(dataRoot)
  } catch {
    root = path.resolve(dataRoot)
  }
  let target: string
  try {
    target = fs.realpathSync(path.resolve(dataRoot, raw))
  } catch {
    return { ok: false, reason: 'preview_not_found' }
  }
  if (target !== root && !target.startsWith(root + path.sep)) {
    return { ok: false, reason: 'path_outside_data_root' }
  }
  const ext = PREVIEW_FILE_EXT[path.extname(target).toLowerCase()]
  if (!ext) return { ok: false, reason: 'unsupported_type' }
  try {
    const stat = fs.statSync(target)
    if (!stat.isFile()) return { ok: false, reason: 'preview_not_found' }
    if (stat.size <= 0) return { ok: false, reason: 'empty_preview' }
    if (stat.size > PREVIEW_MAX_BYTES) return { ok: false, reason: 'preview_too_large' }
    return { ok: true, bytes: fs.readFileSync(target), ext }
  } catch {
    return { ok: false, reason: 'preview_not_found' }
  }
}

async function fetchPreviewAttempt(
  fetchImpl: FetchLike,
  target: string,
  init: RequestInit | undefined,
  timeoutMs: number,
  pathExt: string | undefined
): Promise<PreviewResult> {
  let response: Response
  try {
    response = await fetchImpl(target, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch {
    return { ok: false, reason: 'fetch_failed' }
  }
  if (!response.ok) return { ok: false, reason: `status_${response.status}` }
  const mime = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  // contents API 的 raw 响应是 `application/vnd.github.raw`，类型从路径后缀补。
  const ext = PREVIEW_MIME_EXT[mime] ?? pathExt
  if (!ext) return { ok: false, reason: 'unsupported_type' }
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > PREVIEW_MAX_BYTES) {
    return { ok: false, reason: 'preview_too_large' }
  }
  let bytes: Buffer | null
  try {
    // 超时 signal 覆盖到 body 读完：大图在慢链路上卡住时也要能转入 API 兜底。
    bytes = await readCapped(response, PREVIEW_MAX_BYTES)
  } catch {
    return { ok: false, reason: 'fetch_failed' }
  }
  if (!bytes) return { ok: false, reason: 'preview_too_large' }
  if (bytes.length === 0) return { ok: false, reason: 'empty_preview' }
  return { ok: true, bytes, ext }
}

/** `preview_url` 只接受 https 或站内 `/media/artifact`；其它一律视为抓取失败。 */
async function loadPosePreview(
  deps: Pick<PoseLibraryDeps, 'dataRoot' | 'fetchImpl' | 'env'>,
  previewUrl: string
): Promise<PreviewResult> {
  if (previewUrl.startsWith('/') && !previewUrl.startsWith('//')) {
    return readLocalPreview(deps.dataRoot, previewUrl)
  }
  let url: URL
  try {
    url = new URL(previewUrl)
  } catch {
    return { ok: false, reason: 'invalid_url' }
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'unsupported_protocol' }

  const fetchImpl: FetchLike = deps.fetchImpl ?? ((input, init) => fetch(input, init))
  const primary = await fetchPreviewAttempt(
    fetchImpl,
    url.toString(),
    undefined,
    PREVIEW_TIMEOUT_MS,
    undefined
  )
  if (primary.ok) return primary
  const apiUrl = normalizeGithubRawUrl(url.toString())
  if (!apiUrl) return primary
  const env = deps.env ?? process.env
  const fallback = await fetchPreviewAttempt(
    fetchImpl,
    apiUrl,
    { headers: githubRawHeaders(env) },
    PREVIEW_API_TIMEOUT_MS,
    PREVIEW_FILE_EXT[path.extname(url.pathname).toLowerCase()]
  )
  if (!fallback.ok) {
    return { ok: false, reason: `${primary.reason}|github_api_${fallback.reason}` }
  }
  return fallback
}

function methodNotAllowed(res: ServerResponse, allow: string) {
  res.statusCode = 405
  res.setHeader('Allow', allow)
  res.end()
}

function parseQuery(url: URL): PoseLibraryQuery | { error: string } {
  const limit = parseNonNegativeInt(url.searchParams.get('limit'), LIST_LIMIT_DEFAULT)
  const offset = parseNonNegativeInt(url.searchParams.get('offset'), 0)
  if (limit === null || offset === null) return { error: 'invalid_pagination' }
  return {
    q: (url.searchParams.get('q') ?? '').trim(),
    license: (url.searchParams.get('license') ?? '').trim(),
    shot: (url.searchParams.get('shot') ?? '').trim(),
    limit,
    offset
  }
}

/**
 * `/api/pose-library` 与 `/api/pose-library/:id`。
 * 返回 true 表示请求已被本路由处理。
 */
export async function handlePoseLibraryRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  pathname: string,
  deps: PoseLibraryDeps
): Promise<boolean> {
  if (pathname === '/api/pose-library/sync-status') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      methodNotAllowed(res, 'GET, HEAD')
      return true
    }
    deps.sendJson(res, 200, readPoseSyncStatus(deps.dataRoot, deps.readJson))
    return true
  }

  if (pathname === '/api/pose-library/sync') {
    if (req.method !== 'POST') {
      methodNotAllowed(res, 'POST')
      return true
    }
    const auth = deps.authorize(req)
    if (!auth.ok) {
      deps.sendJson(res, auth.status, { error: auth.error })
      return true
    }
    let body: any = {}
    try {
      body = await deps.readBody(req)
    } catch (err) {
      // 空 body 视为 {}（force 默认 false）；其它解析错误照旧 400。
      if (!(err instanceof Error && err.message === 'empty body')) {
        deps.sendJson(res, 400, { error: err instanceof Error ? err.message : 'bad body' })
        return true
      }
    }
    if (body !== null && typeof body !== 'object') {
      deps.sendJson(res, 400, { error: 'body_invalid' })
      return true
    }
    const force = (body as { force?: unknown })?.force === true
    const outcome = await runPoseSync({
      dataRoot: deps.dataRoot,
      readJson: deps.readJson,
      atomicWriteJson: deps.atomicWriteJson,
      fetchImpl: deps.fetchImpl,
      env: deps.env,
      now: deps.now,
      force,
      addPoseEntry: (value) =>
        addPoseEntry({
          dataRoot: deps.dataRoot,
          value,
          readJson: deps.readJson,
          atomicWriteJson: deps.atomicWriteJson,
          now: deps.now
        })
    })
    if (!outcome.ok) {
      deps.sendJson(res, outcome.status, {
        error: outcome.error,
        ...(outcome.error === 'sync_too_soon'
          ? {
              last_at: outcome.last_at,
              next_at: outcome.next_at,
              retry_after_ms: outcome.retry_after_ms
            }
          : {})
      })
      return true
    }
    const result: PoseSyncResult = outcome.result
    // 匿名限速且一张都没导入：明确 429，不返回成功假象。
    if (result.rate_limit.limited && result.imported === 0) {
      deps.sendJson(res, 429, {
        error: 'github_rate_limited',
        message: 'GitHub API 已限速（匿名每小时 60 次），可配置 GITHUB_TOKEN 后重试',
        ...result
      })
      return true
    }
    deps.sendJson(res, 200, result)
    return true
  }

  if (pathname === '/api/pose-library') {
    if (req.method === 'GET' || req.method === 'HEAD') {
      const query = parseQuery(url)
      if ('error' in query) {
        deps.sendJson(res, 400, { error: query.error })
        return true
      }
      const result = filterPoseEntries(readPoseEntries(deps.dataRoot, deps.readJson), query)
      if (!result.ok) {
        deps.sendJson(res, result.status, { error: result.error })
        return true
      }
      deps.sendJson(res, 200, {
        items: result.items,
        total: result.total,
        limit: result.limit,
        offset: result.offset
      })
      return true
    }

    if (req.method === 'POST') {
      const auth = deps.authorize(req)
      if (!auth.ok) {
        deps.sendJson(res, auth.status, { error: auth.error })
        return true
      }
      let body: unknown
      try {
        body = await deps.readBody(req)
      } catch (err) {
        deps.sendJson(res, 400, { error: err instanceof Error ? err.message : 'bad body' })
        return true
      }
      const validated = validatePoseInput(body)
      if (!validated.ok) {
        deps.sendJson(res, validated.status, { error: validated.error })
        return true
      }
      const added = await addPoseEntry({
        dataRoot: deps.dataRoot,
        value: validated.value,
        readJson: deps.readJson,
        atomicWriteJson: deps.atomicWriteJson,
        now: deps.now
      })
      if (!added.ok) {
        deps.sendJson(res, added.status, { error: added.error })
        return true
      }
      deps.sendJson(res, 201, { item: added.item })
      return true
    }

    methodNotAllowed(res, 'GET, HEAD, POST')
    return true
  }

  const materializeMatch = /^\/api\/pose-library\/([^/]+)\/materialize$/.exec(pathname)
  if (materializeMatch) {
    if (req.method !== 'POST') {
      methodNotAllowed(res, 'POST')
      return true
    }
    const auth = deps.authorize(req)
    if (!auth.ok) {
      deps.sendJson(res, auth.status, { error: auth.error })
      return true
    }
    const entry = readPoseEntries(deps.dataRoot, deps.readJson).find(
      (item) => item.id === materializeMatch[1]
    )
    if (!entry) {
      deps.sendJson(res, 404, { error: 'not_found' })
      return true
    }
    if (!entry.preview_url) {
      deps.sendJson(res, 409, { error: 'preview_missing' })
      return true
    }
    const uploads = deps.uploads
    if (!uploads) {
      deps.sendJson(res, 503, { error: 'upload_unconfigured' })
      return true
    }
    const preview = await loadPosePreview(deps, entry.preview_url)
    if (!preview.ok) {
      deps.sendJson(res, 400, { error: 'preview_unavailable', reason: preview.reason })
      return true
    }
    const safeId = entry.id.replace(/[^A-Za-z0-9_-]+/g, '_')
    const filename = `pose-${safeId}${preview.ext}`
    const created = await createUploadFromBytes(
      {
        dataRoot: deps.dataRoot,
        intakeUrl: uploads.intakeUrl,
        webToken: uploads.webToken,
        atomicWriteJson: deps.atomicWriteJson
      },
      {
        filename,
        bytes: preview.bytes,
        sha256: crypto.createHash('sha256').update(preview.bytes).digest('hex'),
        source_url: entry.source_url,
        pose_id: entry.id
      }
    )
    if (!created.ok) {
      deps.sendJson(res, created.status, {
        error: created.error,
        ...(created.reason ? { reason: created.reason } : {}),
        ...(created.upload_id ? { upload_id: created.upload_id } : {})
      })
      return true
    }
    deps.sendJson(res, 200, {
      upload_id: created.upload_id,
      filename: created.filename,
      size: created.size,
      sha256: created.sha256,
      studio_path: created.studio_path
    })
    return true
  }

  const match = /^\/api\/pose-library\/([^/]+)$/.exec(pathname)
  if (!match) return false

  if (req.method !== 'DELETE') {
    methodNotAllowed(res, 'DELETE')
    return true
  }
  const auth = deps.authorize(req)
  if (!auth.ok) {
    deps.sendJson(res, auth.status, { error: auth.error })
    return true
  }
  const removed = await deletePoseEntry({
    dataRoot: deps.dataRoot,
    id: match[1],
    readJson: deps.readJson,
    atomicWriteJson: deps.atomicWriteJson
  })
  if (!removed) {
    deps.sendJson(res, 404, { error: 'not_found' })
    return true
  }
  deps.sendJson(res, 200, { ok: true, item: removed })
  return true
}
