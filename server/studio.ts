/**
 * Studio backend (issue #85a): Brief / Job / Asset contract v1.
 *
 * Job state is owned by the studio intake service (`ops/studio/intake.py`);
 * this module only calls it server-side (injecting `WEB_WRITE_TOKEN`) and maps
 * its response into the v1 Job/Asset shape. Briefs are the only objects this
 * server stores itself (`DATA_ROOT/studio/briefs`). Nothing here writes job
 * state — no double bookkeeping.
 *
 * Browsers never see the studio token: writes are authorised either by an
 * exact `X-Web-Token` (server-to-server) or by a same-origin `Origin`.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { contentTypeFor, serveStream } from './media'

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'
export type JobType = 'aigc' | 'optimize' | 'image'
export type Rail = 'A' | 'B'
export type AssetKind = 'video' | 'image' | 'audio' | 'subtitle' | 'report'

export interface Asset {
  id: string
  kind: AssetKind
  uri: string
  sha256: null
  size_bytes: number
  width: null
  height: null
  duration_s: null
  fps: null
  derived_from: string[]
  job_id: string
  version: 1
  license: null
  created_at: string
}

export interface Brief {
  id: string
  idea: string
  audience: string | null
  duration_s: number | null
  aspect: string | null
  tone: string | null
  references: string[]
  polished: Record<string, unknown> | null
  /** #87: questions from the last polish; non-empty blocks `/confirm`. */
  questions_pending: string[]
  status: 'draft' | 'confirmed'
  version: number
  created_at: string
  updated_at: string
}

export interface Job {
  id: string
  type: JobType
  rail: Rail
  status: JobStatus
  brief_id: string | null
  plan_id: null
  model: Record<string, unknown> | null
  inputs: Array<{ asset_id: string; role: 'source' }>
  outputs: string[]
  assets: Asset[]
  qc: { status: 'pending' | 'pass' | 'fail'; report_id: null }
  cost: { gpu_seconds: null; credits: null }
  created_by: 'web'
  created_at: string
  updated_at: string
  events: Array<{ ts: string; type: string; message: string }>
  error: string | null
  progress: { stage: string | null; stages: Record<string, string> }
  /** #89b: sanitized cover reference (never an absolute studio path). */
  cover_asset: AssetRef | null
  cover_url: string | null
  /** #89b: set by the orchestrator when an injected keyframe was used. */
  keyframe_source: string | null
  /** #89d: `{source_job, name}` read-back; never an absolute studio path. */
  keyframe_asset: { source_job: string; name: string } | null
}

/** #89b: a reference to an artifact without exposing the studio filesystem. */
export interface AssetRef {
  source_job: string
  name: string
  url: string | null
}

export type ImageMode = 't2i' | 'edit'

export interface ImageInput {
  mode: ImageMode
  prompt: string
  negative: string
  width: number
  height: number
  seed: number
  steps: number
  denoise: number
  source_image?: string
}

export interface JobSummary {
  id: string
  type: JobType
  rail: Rail
  status: JobStatus
  brief_id: string | null
  created_at: string
  updated_at: string
  error: string | null
  stage: string | null
  verdict: StudioVerdict
  /** #139: same real-duration rule as the gallery projection. */
  duration_ms: number | null
}

interface JobMeta {
  id: string
  type: JobType
  rail: Rail
  brief_id: string | null
  model: Record<string, unknown> | null
  input: string | null
  created_at: string
  upload_id?: string | null
  nas_path?: string | null
  /** #89b: stored so an image job can be retried without re-entering params. */
  image?: ImageInput | null
  keyframe_asset?: { source_job: string; name: string } | null
}

/** Everything this module needs from api.ts (avoids a circular import). */
export interface StudioContext {
  dataRoot: string
  intakeUrl: string
  timeoutMs: number
  webToken: string | null
  isSameOrigin: (req: IncomingMessage) => boolean
  sendJson: (res: ServerResponse, status: number, body: unknown) => void
  readJson: (file: string) => any
  atomicWriteJson: (file: string, value: unknown) => void
  readBody: (req: IncomingMessage) => Promise<any>
  /**
   * Injected by `api.ts` so `DELETE /api/studio/jobs/:id` reuses the exact
   * `authorizeTaskWrite` guard (token / same-origin contract) of task writes.
   */
  authorizeTaskWrite?: (
    req: IncomingMessage
  ) => { ok: true } | { ok: false; status: number; error: string }
}

const BRIEFS_DIR = (ctx: StudioContext) => path.join(ctx.dataRoot, 'studio', 'briefs')
const JOBS_DIR = (ctx: StudioContext) => path.join(ctx.dataRoot, 'studio', 'jobs')

const JOB_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
/** Kept in sync with `uploads.ts` (validated here before reading the NAS meta). */
const UPLOAD_ID_RE = /^[a-z0-9-]{8,64}$/
const UPLOAD_FORWARD_TIMEOUT_MS = 10 * 60 * 1000
const SHA256_RE = /^[a-f0-9]{64}$/i
const BRIEF_ID_RE = /^brief_[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/
const JOB_TYPES = new Set<JobType>(['aigc', 'optimize', 'image'])
const RAILS = new Set<Rail>(['A', 'B'])
const ASPECTS = new Set(['16:9', '9:16', '1:1', '4:5'])
const BRIEF_STATUSES = new Set(['draft', 'confirmed'])
const FULL_VIDEO_KINDS = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.webm'])
const IMAGE_KINDS = new Set(['.jpg', '.jpeg', '.png', '.webp'])
/** #89b: mirrors `intake.py` IMAGE_SIZES / IMAGE_MODES exactly. */
const IMAGE_SIZES = new Set(['1536x864', '864x1536', '1024x1024'])
const IMAGE_MODES = new Set<ImageMode>(['t2i', 'edit'])
const AUDIO_KINDS = new Set(['.wav', '.mp3', '.flac'])
const SUBTITLE_KINDS = new Set(['.srt', '.vtt'])
const REPORT_KINDS = new Set(['.json', '.jsonl', '.md', '.txt'])

/**
 * #86b2 artifact proxy allowlist. Only a single file name is accepted — no
 * directories, no `..`, no absolute paths, no percent-encoding — and only
 * data/report kinds that a job may expose under its `output/` directory.
 */
const ARTIFACT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const ARTIFACT_KINDS = new Set([
  '.mp4', '.mov', '.m4v', '.mkv', '.webm',
  '.png', '.jpg', '.jpeg', '.webp',
  '.json', '.csv', '.txt', '.log'
])
/** Long-lived stream timeout: artifacts are videos, not small JSON bodies. */
const ARTIFACT_TIMEOUT_MS = 5 * 60 * 1000

export type ArtifactCheck = { ok: true } | { ok: false; status: 403 | 404; error: string }

/** Pure allowlist used both by the route and by unit tests. */
export function checkArtifactName(name: string): ArtifactCheck {
  if (!name || name.length > 128) return { ok: false, status: 404, error: 'artifact not found' }
  if (
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('..') ||
    name.startsWith('.') ||
    path.isAbsolute(name)
  ) {
    return { ok: false, status: 403, error: 'artifact path not allowed' }
  }
  if (!ARTIFACT_NAME_RE.test(name)) {
    return { ok: false, status: 403, error: 'artifact path not allowed' }
  }
  if (!ARTIFACT_KINDS.has(path.extname(name).toLowerCase())) {
    return { ok: false, status: 404, error: 'artifact not found' }
  }
  return { ok: true }
}

/**
 * #87 polish runs against the local Ollama instance; same env var as api.ts
 * (read at call time so tests can point it at a stub server).
 */
const OLLAMA_DEFAULT_URL = 'http://127.0.0.1:11434'
const POLISH_TIMEOUT_MS = 120_000
const POLISH_TAGS_TIMEOUT_MS = 5_000
const POLISH_MAX_SHOTS = 12
const POLISH_MAX_QUESTIONS = 5
const EMBEDDING_MODEL_RE = /embed|bge|nomic/i

const nowIso = () => new Date().toISOString()

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasKey(value: Record<string, any>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function kindFor(filePath: string): AssetKind | null {
  const ext = path.extname(filePath).toLowerCase()
  if (FULL_VIDEO_KINDS.has(ext)) return 'video'
  if (IMAGE_KINDS.has(ext)) return 'image'
  if (AUDIO_KINDS.has(ext)) return 'audio'
  if (SUBTITLE_KINDS.has(ext)) return 'subtitle'
  if (REPORT_KINDS.has(ext)) return 'report'
  return null
}

function sanitizeKey(raw: string): string {
  const key = raw.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return key || 'file'
}

function newBriefId(): string {
  return `brief_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`
}

function intakeReason(err: unknown): string {
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return 'timeout'
  }
  const cause = (err as { cause?: { code?: unknown; message?: unknown } } | null)?.cause
  if (typeof cause?.code === 'string') return cause.code
  if (typeof cause?.message === 'string' && cause.message) return cause.message
  return 'network error'
}

type IntakeCall =
  | { ok: true; status: number; body: any }
  | { ok: false; status: number; body: { error: string; reason: string } }

/** Server-side call to the studio intake; never logs or returns the token. */
async function callIntake(
  ctx: StudioContext,
  method: string,
  upstreamPath: string,
  body?: unknown
): Promise<IntakeCall> {
  const headers: Record<string, string> = {}
  if (ctx.webToken) headers['X-Web-Token'] = ctx.webToken
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  try {
    const upstream = await fetch(`${ctx.intakeUrl}${upstreamPath}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(ctx.timeoutMs)
    })
    const text = await upstream.text().catch(() => '')
    let parsed: any = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      parsed = { error: 'invalid upstream response' }
    }
    return { ok: true, status: upstream.status, body: parsed }
  } catch (err) {
    const reason = intakeReason(err)
    console.error(`[studio] ${method} ${upstreamPath} -> ${reason}`)
    return { ok: false, status: reason === 'timeout' ? 504 : 502, body: { error: 'intake unavailable', reason } }
  }
}

/** Read-only intake detail, shared by `/api/studio/jobs/:id` and `/api/snapshot`. */
export async function fetchStudioJobDetail(
  ctx: StudioContext,
  id: string
): Promise<{ ok: boolean; status: number; body: any }> {
  return callIntake(ctx, 'GET', `/intake/jobs/${encodeURIComponent(id)}`)
}

/**
 * Reads a whitelisted JSON artifact (`summary.json`, `quality_b.json`) from the
 * intake. Returns null on any failure — callers must show "未记录", never invent
 * numbers.
 */
export async function fetchStudioArtifactJson(
  ctx: StudioContext,
  id: string,
  name: string
): Promise<any | null> {
  if (!ctx.webToken || !JOB_NAME_RE.test(id)) return null
  if (!checkArtifactName(name).ok) return null
  try {
    const upstream = await fetch(
      `${ctx.intakeUrl}/intake/jobs/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(name)}`,
      {
        headers: { 'X-Web-Token': ctx.webToken },
        signal: AbortSignal.timeout(ctx.timeoutMs)
      }
    )
    if (!upstream.ok) return null
    return await upstream.json().catch(() => null)
  } catch {
    return null
  }
}

/**
 * #86e: is an artifact actually readable upstream? Used only to decide the
 * `exists` dot in `dataSources`; a URL being known is not evidence the file is
 * there. A satisfiable 0-byte range proves readability without buffering the
 * whole video.
 */
export async function studioArtifactReadable(
  ctx: StudioContext,
  id: string,
  name: string
): Promise<boolean> {
  if (!ctx.webToken || !JOB_NAME_RE.test(id)) return false
  if (!checkArtifactName(name).ok) return false
  try {
    const upstream = await fetch(
      `${ctx.intakeUrl}/intake/jobs/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(name)}`,
      {
        headers: { 'X-Web-Token': ctx.webToken, Range: 'bytes=0-0' },
        signal: AbortSignal.timeout(ctx.timeoutMs)
      }
    )
    await upstream.body?.cancel().catch(() => {})
    return upstream.status === 200 || upstream.status === 206 || upstream.status === 416
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Authorisation
// ---------------------------------------------------------------------------

/**
 * Writes: exact `X-Web-Token` or same-origin; else 401 (missing token) /
 * 403 (wrong token) — #89d keeps the contract's 401-vs-403 split.
 * Shared with `agents.ts` so every write route uses the same rule.
 */
export function authorizedForWrite(
  webToken: string | null,
  isSameOrigin: (req: IncomingMessage) => boolean,
  req: IncomingMessage,
  res: ServerResponse,
  sendJson: (res: ServerResponse, status: number, body: unknown) => void
): boolean {
  const provided = req.headers['x-web-token']
  if (webToken && typeof provided === 'string' && provided === webToken) return true
  if (isSameOrigin(req)) return true
  if (provided !== undefined) {
    sendJson(res, 403, { error: 'invalid X-Web-Token' })
  } else {
    sendJson(res, 401, { error: 'same-origin or X-Web-Token required' })
  }
  return false
}

function requireWrite(ctx: StudioContext, req: IncomingMessage, res: ServerResponse): boolean {
  return authorizedForWrite(ctx.webToken, ctx.isSameOrigin, req, res, ctx.sendJson)
}

// ---------------------------------------------------------------------------
// Briefs
// ---------------------------------------------------------------------------

function briefPath(ctx: StudioContext, id: string): string {
  return path.join(BRIEFS_DIR(ctx), `${id}.json`)
}

function readBrief(ctx: StudioContext, id: string): Brief | null {
  if (!BRIEF_ID_RE.test(id)) return null
  const doc = ctx.readJson(briefPath(ctx, id))
  if (!isPlainObject(doc) || doc.id !== id) return null
  const brief = doc as Brief
  // #87: briefs written before this field existed are normalised on read so
  // GET/confirm never have to special-case `undefined`.
  if (!Array.isArray(brief.questions_pending)) brief.questions_pending = []
  return brief
}

type BriefFields = Pick<
  Brief,
  'idea' | 'audience' | 'duration_s' | 'aspect' | 'tone' | 'references' | 'polished' | 'status'
>

function validateBriefFields(
  body: unknown,
  creating: boolean
): { ok: true; fields: Partial<BriefFields> } | { ok: false; error: string } {
  if (!isPlainObject(body)) return { ok: false, error: 'body must be a JSON object' }
  const fields: Partial<BriefFields> = {}
  if (hasKey(body, 'idea') || creating) {
    if (typeof body.idea !== 'string' || !body.idea.trim() || body.idea.length > 2000) {
      return { ok: false, error: 'idea: 需为 1..2000 字符' }
    }
    fields.idea = body.idea
  }
  for (const key of ['audience', 'tone'] as const) {
    if (!hasKey(body, key)) continue
    const value = body[key]
    if (value === null) {
      fields[key] = null
      continue
    }
    if (typeof value !== 'string' || value.length > 200) {
      return { ok: false, error: `${key}: 需为 ≤200 字符的字符串或 null` }
    }
    fields[key] = value
  }
  if (hasKey(body, 'duration_s')) {
    const value = body.duration_s
    if (value === null) {
      fields.duration_s = null
    } else if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value > 600) {
      return { ok: false, error: 'duration_s: 需为 1..600 的数字或 null' }
    } else {
      fields.duration_s = value
    }
  }
  if (hasKey(body, 'aspect')) {
    const value = body.aspect
    if (value === null) {
      fields.aspect = null
    } else if (typeof value !== 'string' || !ASPECTS.has(value)) {
      return { ok: false, error: 'aspect: 需为 16:9 / 9:16 / 1:1 / 4:5 或 null' }
    } else {
      fields.aspect = value
    }
  }
  if (hasKey(body, 'references')) {
    const value = body.references
    if (value === null) {
      fields.references = []
    } else if (
      !Array.isArray(value) ||
      value.length > 10 ||
      value.some((item) => typeof item !== 'string' || item.length > 200)
    ) {
      return { ok: false, error: 'references: 需为 ≤10 条、每条 ≤200 字符的字符串数组' }
    } else {
      fields.references = value as string[]
    }
  }
  if (hasKey(body, 'polished')) {
    const value = body.polished
    if (value !== null && !isPlainObject(value)) {
      return { ok: false, error: 'polished: W1 仅支持 null 或对象' }
    }
    fields.polished = value as Record<string, unknown> | null
  }
  if (hasKey(body, 'status')) {
    const value = body.status
    if (typeof value !== 'string' || !BRIEF_STATUSES.has(value)) {
      return { ok: false, error: 'status: 需为 draft / confirmed' }
    }
    fields.status = value as Brief['status']
  }
  return { ok: true, fields }
}

// ---------------------------------------------------------------------------
// #87 Brief polish: strong `polished` schema + local Ollama call
// ---------------------------------------------------------------------------

export type PolishedShot = {
  no: number
  duration_s: number
  prompt: string
  camera?: string
}

export type PolishedBrief = {
  logline: string
  script: string
  shots: PolishedShot[]
  style?: string
}

export type PolishedResult =
  | { ok: true; value: PolishedBrief }
  | { ok: false; path: string; reason: string }

/**
 * Strong server-side schema (contract T-VID-087 §1.2). Every rejection names
 * the offending `path` so the UI can point at the field.
 */
export function validatePolished(value: unknown): PolishedResult {
  if (!isPlainObject(value)) return { ok: false, path: '', reason: '需为对象' }
  const logline = value.logline
  if (typeof logline !== 'string' || !logline.trim() || logline.length > 300) {
    return { ok: false, path: 'logline', reason: '需为 1..300 字符' }
  }
  const script = value.script
  if (typeof script !== 'string' || !script.trim() || script.length > 4000) {
    return { ok: false, path: 'script', reason: '需为 1..4000 字符' }
  }
  const rawShots = value.shots
  if (!Array.isArray(rawShots) || rawShots.length < 1 || rawShots.length > POLISH_MAX_SHOTS) {
    return { ok: false, path: 'shots', reason: `需为 1..${POLISH_MAX_SHOTS} 条数组` }
  }
  const shots: PolishedShot[] = []
  for (let i = 0; i < rawShots.length; i += 1) {
    const item = rawShots[i]
    const at = `shots[${i}]`
    if (!isPlainObject(item)) return { ok: false, path: at, reason: '需为对象' }
    if (typeof item.no !== 'number' || !Number.isInteger(item.no) || item.no !== i + 1) {
      return { ok: false, path: `${at}.no`, reason: '需为从 1 连续递增的整数' }
    }
    const duration = item.duration_s
    if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0 || duration > 600) {
      return { ok: false, path: `${at}.duration_s`, reason: '需为 (0,600] 的数字' }
    }
    const prompt = item.prompt
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 500) {
      return { ok: false, path: `${at}.prompt`, reason: '需为 1..500 字符' }
    }
    const shot: PolishedShot = { no: i + 1, duration_s: duration, prompt }
    if (item.camera !== undefined && item.camera !== null) {
      if (typeof item.camera !== 'string' || item.camera.length > 80) {
        return { ok: false, path: `${at}.camera`, reason: '需为 ≤80 字符' }
      }
      shot.camera = item.camera
    }
    shots.push(shot)
  }
  const out: PolishedBrief = { logline, script, shots }
  if (value.style !== undefined && value.style !== null) {
    if (typeof value.style !== 'string' || value.style.length > 120) {
      return { ok: false, path: 'style', reason: '需为 ≤120 字符' }
    }
    out.style = value.style
  }
  return { ok: true, value: out }
}

function ollamaBaseUrl(): string {
  return (process.env.OLLAMA_URL?.trim() || OLLAMA_DEFAULT_URL).replace(/\/+$/, '')
}

/** Network-level reason only; never includes request bodies or tokens. */
function llmReason(err: unknown): string {
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return 'timeout'
  }
  const cause = (err as { cause?: { code?: unknown; message?: unknown } } | null)?.cause
  if (typeof cause?.code === 'string') return cause.code
  if (typeof cause?.message === 'string' && cause.message) return cause.message
  return err instanceof Error && err.message ? err.message : 'network error'
}

function textModelNames(body: unknown): string[] {
  const models = isPlainObject(body) && Array.isArray(body.models) ? body.models : []
  return models
    .map((item) => (isPlainObject(item) && typeof item.name === 'string' ? item.name : ''))
    .filter((name) => name && !EMBEDDING_MODEL_RE.test(name))
}

/** `body.model` wins; otherwise pick a text model reported by `/api/tags`. */
async function pickPolishModel(base: string, requested: unknown): Promise<string | null> {
  if (typeof requested === 'string' && requested.trim()) return requested.trim()
  const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(POLISH_TAGS_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`tags HTTP ${res.status}`)
  const names = textModelNames(await res.json().catch(() => null))
  if (!names.length) return null
  for (const preferred of ['qwen2.5:7b', 'qwen3:4b', 'qwen3:8b']) {
    if (names.includes(preferred)) return preferred
  }
  return names[0]
}

function buildPolishPrompt(brief: Brief): string {
  const known = [
    `idea=${brief.idea}`,
    `audience=${brief.audience ?? '未提供'}`,
    `duration_s=${brief.duration_s ?? '未提供'}`,
    `aspect=${brief.aspect ?? '未提供'}`,
    `tone=${brief.tone ?? '未提供'}`,
    `references=${brief.references.length ? brief.references.join(' / ') : '未提供'}`
  ].join('；')
  return [
    '你是短视频策划助手。把用户的「想法」整理成可执行的 Brief JSON，只输出 JSON，不要解释。',
    'JSON 结构：{"logline":"一句话故事线(1..300字)","script":"分场脚本(1..4000字,含画面/动作/字幕/节奏)","shots":[{"no":1,"duration_s":3.5,"prompt":"该镜头画面与运镜描述(1..500字)","camera":"可选≤80字"}],"style":"可选≤120字","questions":["需要用户补充的问题"]}',
    `约束：shots 1..${POLISH_MAX_SHOTS} 条，no 从 1 连续递增；总时长尽量接近 duration_s；全部使用中文。`,
    `如果已知参数里有「未提供」，questions 给出 3~${POLISH_MAX_QUESTIONS} 条中文问题（每轮只问缺的）；如果参数都已提供，questions 为空数组 []。`,
    `已知参数：${known}`
  ].join('\n')
}

function stripCodeFence(raw: string): string {
  const text = raw.trim()
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return fenced ? fenced[1].trim() : text
}

function extractQuestions(value: unknown): string[] {
  if (!isPlainObject(value) || !Array.isArray(value.questions)) return []
  return value.questions
    .filter((q): q is string => typeof q === 'string')
    .map((q) => q.trim())
    .filter(Boolean)
    .slice(0, POLISH_MAX_QUESTIONS)
}

type PolishOutcome =
  | {
      ok: true
      model: string
      elapsed_ms: number
      polished: unknown
      questions: string[]
      parse_error: string | null
    }
  | { ok: false; reason: string }

async function callPolishLlm(brief: Brief, requestedModel: unknown): Promise<PolishOutcome> {
  const base = ollamaBaseUrl()
  const started = Date.now()
  let model: string | null
  try {
    model = await pickPolishModel(base, requestedModel)
  } catch (err) {
    return { ok: false, reason: llmReason(err) }
  }
  if (!model) return { ok: false, reason: 'no text model available' }
  let response: Response
  try {
    response = await fetch(`${base}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt: buildPolishPrompt(brief),
        stream: false,
        format: 'json',
        options: { temperature: 0.4, num_predict: 2048 }
      }),
      signal: AbortSignal.timeout(POLISH_TIMEOUT_MS)
    })
  } catch (err) {
    return { ok: false, reason: llmReason(err) }
  }
  if (!response.ok) return { ok: false, reason: `ollama HTTP ${response.status}` }
  let raw: string
  try {
    const body = (await response.json()) as { response?: unknown }
    raw = typeof body.response === 'string' ? body.response : ''
  } catch (err) {
    return { ok: false, reason: `ollama body: ${llmReason(err)}` }
  }
  const elapsed = Date.now() - started
  let parsed: unknown
  try {
    parsed = JSON.parse(stripCodeFence(raw))
  } catch {
    return { ok: true, model, elapsed_ms: elapsed, polished: null, questions: [], parse_error: 'LLM 未返回合法 JSON' }
  }
  return {
    ok: true,
    model,
    elapsed_ms: elapsed,
    polished: parsed,
    questions: extractQuestions(parsed),
    parse_error: null
  }
}

async function polishBrief(
  ctx: StudioContext,
  req: IncomingMessage,
  res: ServerResponse,
  id: string
): Promise<void> {
  const brief = readBrief(ctx, id)
  if (!brief) {
    ctx.sendJson(res, 404, { error: 'brief not found' })
    return
  }
  let body: unknown = null
  try {
    body = await ctx.readBody(req)
  } catch {
    ctx.sendJson(res, 400, { error: 'invalid JSON body' })
    return
  }
  if (body !== null && !isPlainObject(body)) {
    ctx.sendJson(res, 400, { error: 'body must be a JSON object' })
    return
  }
  if (typeof brief.idea !== 'string' || !brief.idea.trim() || brief.idea.length > 2000) {
    ctx.sendJson(res, 400, { error: 'idea: 需为 1..2000 字符' })
    return
  }
  const outcome = await callPolishLlm(brief, isPlainObject(body) ? body.model : undefined)
  if (!outcome.ok) {
    ctx.sendJson(res, 503, { error: 'polish_unavailable', reason: outcome.reason })
    return
  }
  if (outcome.parse_error) {
    ctx.sendJson(res, 422, {
      error: 'brief_schema_invalid',
      path: 'root',
      reason: outcome.parse_error
    })
    return
  }
  const checked = validatePolished(outcome.polished)
  if (!checked.ok) {
    ctx.sendJson(res, 422, {
      error: 'brief_schema_invalid',
      path: checked.path,
      reason: checked.reason
    })
    return
  }
  const versionsDir = path.join(BRIEFS_DIR(ctx), `${id}.versions`)
  ctx.atomicWriteJson(path.join(versionsDir, `v${brief.version}.json`), brief)
  const next: Brief = {
    ...brief,
    polished: checked.value as unknown as Record<string, unknown>,
    questions_pending: outcome.questions,
    // A re-polish invalidates any earlier confirmation: enqueueing is only
    // allowed after the newest output has been confirmed again.
    status: 'draft',
    version: brief.version + 1,
    updated_at: nowIso()
  }
  ctx.atomicWriteJson(briefPath(ctx, id), next)
  ctx.sendJson(res, 200, {
    brief: next,
    questions: outcome.questions,
    llm: { model: outcome.model, elapsed_ms: outcome.elapsed_ms }
  })
}

async function confirmBrief(
  ctx: StudioContext,
  req: IncomingMessage,
  res: ServerResponse,
  id: string
): Promise<void> {
  const brief = readBrief(ctx, id)
  if (!brief) {
    ctx.sendJson(res, 404, { error: 'brief not found' })
    return
  }
  let body: unknown
  try {
    body = await ctx.readBody(req)
  } catch {
    ctx.sendJson(res, 400, { error: 'invalid JSON body' })
    return
  }
  if (!isPlainObject(body) || body.ack !== true) {
    ctx.sendJson(res, 400, { error: 'ack_required' })
    return
  }
  if (!brief.polished) {
    ctx.sendJson(res, 409, { error: 'brief_not_ready', reason: 'polished missing' })
    return
  }
  const checked = validatePolished(brief.polished)
  if (!checked.ok) {
    ctx.sendJson(res, 409, {
      error: 'brief_not_ready',
      reason: 'polished_invalid',
      path: checked.path
    })
    return
  }
  if (brief.questions_pending.length > 0) {
    ctx.sendJson(res, 409, { error: 'brief_not_ready', reason: 'questions_pending' })
    return
  }
  const versionsDir = path.join(BRIEFS_DIR(ctx), `${id}.versions`)
  ctx.atomicWriteJson(path.join(versionsDir, `v${brief.version}.json`), brief)
  const next: Brief = {
    ...brief,
    status: 'confirmed',
    version: brief.version + 1,
    updated_at: nowIso()
  }
  ctx.atomicWriteJson(briefPath(ctx, id), next)
  ctx.sendJson(res, 200, { brief: next, job_gate: 'open' })
}

function listBriefs(ctx: StudioContext, limit: number): Brief[] {
  const dir = BRIEFS_DIR(ctx)
  let names: string[] = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const items: Brief[] = []
  for (const name of names) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue
    const id = name.slice(0, -'.json'.length)
    const brief = readBrief(ctx, id)
    if (brief) items.push(brief)
  }
  items.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
  return items.slice(0, limit)
}

async function createBrief(ctx: StudioContext, req: IncomingMessage, res: ServerResponse) {
  let body: unknown
  try {
    body = await ctx.readBody(req)
  } catch {
    ctx.sendJson(res, 400, { error: 'invalid JSON body' })
    return
  }
  const checked = validateBriefFields(body, true)
  if (!checked.ok) {
    ctx.sendJson(res, 400, { error: checked.error })
    return
  }
  const stamp = nowIso()
  const brief: Brief = {
    id: newBriefId(),
    idea: checked.fields.idea!,
    audience: checked.fields.audience ?? null,
    duration_s: checked.fields.duration_s ?? null,
    aspect: checked.fields.aspect ?? null,
    tone: checked.fields.tone ?? null,
    references: checked.fields.references ?? [],
    polished: checked.fields.polished ?? null,
    questions_pending: [],
    status: checked.fields.status ?? 'draft',
    version: 1,
    created_at: stamp,
    updated_at: stamp
  }
  ctx.atomicWriteJson(briefPath(ctx, brief.id), brief)
  ctx.sendJson(res, 201, brief)
}

function getBrief(ctx: StudioContext, res: ServerResponse, id: string) {
  const brief = readBrief(ctx, id)
  if (!brief) {
    ctx.sendJson(res, 404, { error: 'brief not found' })
    return
  }
  ctx.sendJson(res, 200, brief)
}

async function patchBrief(ctx: StudioContext, req: IncomingMessage, res: ServerResponse, id: string) {
  const current = readBrief(ctx, id)
  if (!current) {
    ctx.sendJson(res, 404, { error: 'brief not found' })
    return
  }
  let body: unknown
  try {
    body = await ctx.readBody(req)
  } catch {
    ctx.sendJson(res, 400, { error: 'invalid JSON body' })
    return
  }
  if (isPlainObject(body) && hasKey(body, 'version') && body.version !== current.version) {
    ctx.sendJson(res, 409, { error: 'version conflict', current: current.version })
    return
  }
  const checked = validateBriefFields(body, false)
  if (!checked.ok) {
    ctx.sendJson(res, 400, { error: checked.error })
    return
  }
  // #87 §1.4: confirmation is only reachable through `/confirm`, which checks
  // the polished schema and pending questions. draft → draft / confirmed → draft
  // stay allowed.
  if (checked.fields.status === 'confirmed' && current.status !== 'confirmed') {
    ctx.sendJson(res, 400, { error: 'use /confirm' })
    return
  }
  if (checked.fields.polished !== undefined && checked.fields.polished !== null) {
    const schema = validatePolished(checked.fields.polished)
    if (!schema.ok) {
      ctx.sendJson(res, 422, {
        error: 'brief_schema_invalid',
        path: schema.path,
        reason: schema.reason
      })
      return
    }
  }
  const versionsDir = path.join(BRIEFS_DIR(ctx), `${id}.versions`)
  ctx.atomicWriteJson(path.join(versionsDir, `v${current.version}.json`), current)
  const next: Brief = {
    ...current,
    ...checked.fields,
    version: current.version + 1,
    updated_at: nowIso()
  }
  ctx.atomicWriteJson(briefPath(ctx, id), next)
  ctx.sendJson(res, 200, next)
}

// ---------------------------------------------------------------------------
// Jobs (state comes from studio intake, never written here)
// ---------------------------------------------------------------------------

function jobMetaPath(ctx: StudioContext, id: string): string {
  return path.join(JOBS_DIR(ctx), `${id}.json`)
}

function readJobMeta(ctx: StudioContext, id: string): JobMeta | null {
  const doc = ctx.readJson(jobMetaPath(ctx, id))
  return isPlainObject(doc) && doc.id === id ? (doc as JobMeta) : null
}

function writeJobMeta(ctx: StudioContext, meta: JobMeta) {
  ctx.atomicWriteJson(jobMetaPath(ctx, meta.id), meta)
}

export function studioStatus(state: unknown): JobStatus {
  if (state === 'succeeded') return 'succeeded'
  if (state === 'running') return 'running'
  if (state === 'failed' || state === 'rejected') return 'failed'
  if (state === 'canceled') return 'canceled'
  return 'queued'
}

function qcFor(status: JobStatus, error: string | null): Job['qc'] {
  if (status === 'succeeded') return { status: 'pass', report_id: null }
  if (status === 'failed' && typeof error === 'string' && /quality/i.test(error)) {
    return { status: 'fail', report_id: null }
  }
  return { status: 'pending', report_id: null }
}

export type StudioVerdict = 'PASS' | 'FAIL' | 'CONDITIONAL' | 'UNKNOWN'

/** Single list/snapshot projection: status + stage + verdict are derived here only. */
export function studioProjection(detail: any): {
  status: JobStatus
  stage: string | null
  verdict: StudioVerdict
} {
  const status = studioStatus(detail?.state)
  const error = typeof detail?.error === 'string' ? detail.error : null
  const qc = qcFor(status, error).status
  const verdict: StudioVerdict = qc === 'pass' ? 'PASS' : qc === 'fail' ? 'FAIL' : 'UNKNOWN'
  return {
    status,
    stage: typeof detail?.stage === 'string' ? detail.stage : null,
    verdict
  }
}

/**
 * Assets are derived from the intake state's `artifacts` map. A path only
 * becomes an Asset when this process can stat it as a regular file — on the
 * NAS container the studio tree is not mounted, so the list is empty there
 * (known W2 boundary: media playback is not wired yet).
 */
function collectAssets(
  id: string,
  meta: JobMeta | null,
  artifacts: Record<string, unknown>
): { assets: Asset[]; outputs: string[] } {
  const assets: Asset[] = []
  const outputs: string[] = []
  if (meta?.input) {
    const kind = kindFor(meta.input) ?? 'video'
    let size = 0
    try {
      const stat = fs.statSync(meta.input)
      if (stat.isFile()) size = stat.size
    } catch {
      // Input was validated by intake on the studio host; size stays 0 when
      // this process cannot see that filesystem.
    }
    assets.push({
      id: `asset_${id}_source`,
      kind,
      uri: `studio://${meta.input}`,
      sha256: null,
      size_bytes: size,
      width: null,
      height: null,
      duration_s: null,
      fps: null,
      derived_from: [],
      job_id: id,
      version: 1,
      license: null,
      created_at: meta.created_at
    })
  }
  // #89b: image artifacts are stored relative to the studio repo root and the
  // web host cannot stat them; they are served through the artifact proxy so
  // the browser never sees an absolute studio path.
  const proxied = meta?.type === 'image'
  for (const [rawKey, rawPath] of Object.entries(artifacts)) {
    if (typeof rawPath !== 'string') continue
    if (!rawPath.startsWith('/') && !proxied) continue
    const kind = kindFor(rawPath)
    if (!kind) continue
    let stat: fs.Stats | null = null
    if (rawPath.startsWith('/')) {
      try {
        const found = fs.statSync(rawPath)
        if (found.isFile()) stat = found
      } catch {
        stat = null
      }
      if (!proxied && !stat) continue
    }
    const key = rawKey === 'final_video' ? 'final' : sanitizeKey(rawKey)
    const assetId = `asset_${id}_${key}`
    assets.push({
      id: assetId,
      kind,
      uri: proxied
        ? `/api/studio/jobs/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(path.basename(rawPath))}`
        : `studio://${rawPath}`,
      sha256: null,
      size_bytes: stat?.size ?? 0,
      width: null,
      height: null,
      duration_s: null,
      fps: null,
      derived_from: [],
      job_id: id,
      version: 1,
      license: null,
      created_at: stat ? new Date(stat.mtimeMs).toISOString() : (meta?.created_at ?? nowIso())
    })
    if (kind === 'video') outputs.push(assetId)
  }
  return { assets, outputs }
}

function readStages(raw: unknown): Record<string, string> {
  if (!isPlainObject(raw)) return {}
  const out: Record<string, string> = {}
  for (const key of Object.keys(raw)) {
    const s = raw[key]
    out[key] = isPlainObject(s) && typeof s.status === 'string' ? s.status : 'unknown'
  }
  return out
}

/**
 * #89b: turn an intake absolute path into a browser-safe reference.
 * Only `jobs/<job>/output/<image>` can become a URL; anything else keeps just
 * the file name and no URL (never leak the studio filesystem).
 */
export function assetRefFromPath(raw: unknown): AssetRef | null {
  if (typeof raw !== 'string' || !raw) return null
  const parts = raw.split(/[\\/]+/).filter(Boolean)
  const name = parts[parts.length - 1] ?? ''
  if (!name || !IMAGE_KINDS.has(path.extname(name).toLowerCase())) return null
  // Layout is `.../jobs/<job>/output/<name>`; the job id sits just before
  // `output/` and the literal `jobs` marker one segment before that.
  const isOutput = parts[parts.length - 2] === 'output' && parts[parts.length - 4] === 'jobs'
  const job = isOutput ? (parts[parts.length - 3] ?? '') : ''
  if (isOutput && JOB_NAME_RE.test(job)) {
    return {
      source_job: job,
      name,
      url: `/api/studio/jobs/${encodeURIComponent(job)}/artifacts/${encodeURIComponent(name)}`
    }
  }
  return { source_job: '', name, url: null }
}

/**
 * #89d: intake state stores `keyframe_asset` as an absolute studio path. The
 * contract's read-back shape is `{source_job, name}`; keep `source_job` empty
 * when the path cannot be mapped to `jobs/<job>/output/` instead of inventing
 * an id (never leak the studio filesystem).
 */
export function keyframeRefFromPath(raw: unknown): { source_job: string; name: string } | null {
  // Some intake builds already return the contract object; pass it through
  // (basename only) instead of dropping it.
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const rec = raw as Record<string, unknown>
    const rawName = typeof rec.name === 'string' ? rec.name.trim() : ''
    const name = rawName ? path.posix.basename(rawName.replace(/\\/g, '/')) : ''
    if (!name || name === '.' || name === '..') return null
    const rawJob = typeof rec.source_job === 'string' ? rec.source_job : ''
    return { source_job: JOB_NAME_RE.test(rawJob) ? rawJob : '', name }
  }
  if (typeof raw !== 'string' || !raw) return null
  const ref = assetRefFromPath(raw)
  if (ref) return { source_job: ref.source_job, name: ref.name }
  // A path that is not a recognised image artifact: keep just the file name,
  // never invent a job id. The read-back must stay a non-empty object.
  const parts = raw.split(/[\\/]+/).filter(Boolean)
  const name = parts[parts.length - 1] ?? ''
  if (!name || name === '.' || name === '..') return null
  return { source_job: '', name }
}

export function buildStudioJob(ctx: StudioContext, id: string, detail: any): Job {
  const meta = readJobMeta(ctx, id)
  const status = studioStatus(detail?.state)
  const updatedAt = typeof detail?.updated_at === 'string' ? detail.updated_at : null
  const createdAt = meta?.created_at ?? updatedAt ?? nowIso()
  const error = typeof detail?.error === 'string' ? detail.error : null
  const artifacts = isPlainObject(detail?.artifacts) ? detail.artifacts : {}
  const { assets, outputs } = collectAssets(id, meta, artifacts)
  const sourceId = meta?.input ? `asset_${id}_source` : null
  const cover = assetRefFromPath(detail?.cover_asset)
  return {
    id,
    type: meta?.type ?? 'aigc',
    rail: meta?.rail ?? 'A',
    status,
    brief_id: meta?.brief_id ?? null,
    plan_id: null,
    model: meta?.model ?? null,
    inputs: sourceId ? [{ asset_id: sourceId, role: 'source' }] : [],
    outputs,
    assets,
    qc: qcFor(status, error),
    cost: { gpu_seconds: null, credits: null },
    created_by: 'web',
    created_at: createdAt,
    updated_at: updatedAt ?? createdAt,
    events: [],
    error,
    progress: {
      // #97a: read real intake stages instead of {} (never written back).
      stage: typeof detail?.stage === 'string' ? detail.stage : null,
      stages: readStages(detail?.state?.stages)
    },
    cover_asset: cover,
    cover_url: cover?.url ?? null,
    keyframe_asset: keyframeRefFromPath(
      detail?.keyframe_asset ?? detail?.keyframe_asset_used
    ),
    keyframe_source:
      typeof detail?.keyframe_source === 'string'
        ? detail.keyframe_source
        : typeof detail?.state?.keyframe_source === 'string'
          ? detail.state.keyframe_source
          : null
  }
}

function buildSummary(ctx: StudioContext, item: any): JobSummary {
  const id = typeof item?.id === 'string' ? item.id : ''
  const meta = id ? readJobMeta(ctx, id) : null
  const updatedAt = typeof item?.updated_at === 'string' ? item.updated_at : null
  const createdAt = meta?.created_at ?? updatedAt ?? nowIso()
  const projection = studioProjection(item)
  return {
    id,
    type: meta?.type ?? 'aigc',
    rail: meta?.rail ?? 'A',
    status: projection.status,
    brief_id: meta?.brief_id ?? null,
    created_at: createdAt,
    updated_at: updatedAt ?? createdAt,
    error: typeof item?.error === 'string' ? item.error : null,
    stage: projection.stage,
    verdict: projection.verdict,
    duration_ms: resolveJobDurationMs(item, createdAt)
  }
}

function requireIntakeToken(ctx: StudioContext, res: ServerResponse): boolean {
  if (ctx.webToken) return true
  ctx.sendJson(res, 503, { error: 'studio disabled: WEB_WRITE_TOKEN is not set' })
  return false
}

/** #89b: pure Q1 validation (mirrors `intake.py::_validate_image`). */
export function validateImageRequest(
  value: unknown
):
  | { ok: true; image: ImageInput }
  | { ok: false; status: 400; error: string; path?: string } {
  const bad = (error: string, field?: string) =>
    ({ ok: false as const, status: 400 as const, error: field ? `${field}: ${error}` : error, path: field })
  if (!isPlainObject(value)) return bad('需为对象', 'image')
  const mode = value.mode
  if (typeof mode !== 'string' || !IMAGE_MODES.has(mode as ImageMode)) {
    return bad('需为 t2i / edit', 'image.mode')
  }
  if (typeof value.prompt !== 'string' || !value.prompt.trim()) {
    return bad('必填', 'image.prompt')
  }
  if (value.negative !== undefined && typeof value.negative !== 'string') {
    return bad('需为字符串', 'image.negative')
  }
  const width = value.width
  const height = value.height
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    !IMAGE_SIZES.has(`${width}x${height}`)
  ) {
    return bad('仅支持 1536x864 / 864x1536 / 1024x1024', 'image.size')
  }
  const seed = value.seed
  if (!Number.isInteger(seed) || (seed as number) < 0 || (seed as number) > 0xffffffff) {
    return bad('需为 0..4294967295 的整数', 'image.seed')
  }
  const steps = value.steps
  if (!Number.isInteger(steps) || (steps as number) < 1 || (steps as number) > 100) {
    return bad('需为 1..100 的整数', 'image.steps')
  }
  const denoise = value.denoise
  if (typeof denoise !== 'number' || !Number.isFinite(denoise) || denoise <= 0 || denoise > 1) {
    return bad('需在 (0, 1] 内', 'image.denoise')
  }
  if (mode === 't2i' && denoise !== 1) return bad('mode=t2i 必须为 1.0', 'image.denoise')
  return {
    ok: true,
    image: {
      mode: mode as ImageMode,
      prompt: value.prompt.trim(),
      negative: typeof value.negative === 'string' ? value.negative : '',
      width: width as number,
      height: height as number,
      seed: seed as number,
      steps: steps as number,
      denoise
    }
  }
}

type CreateJobInput = {
  id?: string
  type: JobType
  rail: Rail
  brief_id: string | null
  model: Record<string, unknown> | null
  input?: string
  upload_id?: string
  nas_path?: string
  image?: ImageInput
  /** #89b: injected C-stage keyframe for the next A-track job (shot 1 only). */
  keyframe_asset?: { source_job: string; name: string }
}

function validateCreateJob(
  ctx: StudioContext,
  body: unknown
): { ok: true; job: CreateJobInput } | { ok: false; status: number; error: string } {
  if (!isPlainObject(body)) return { ok: false, status: 400, error: 'body must be a JSON object' }
  const type = hasKey(body, 'type') ? body.type : 'aigc'
  if (typeof type !== 'string' || !JOB_TYPES.has(type as JobType)) {
    return { ok: false, status: 400, error: 'type: 需为 aigc / optimize / image' }
  }
  // #89b: image jobs carry an `image` object instead of a video input. Only
  // upload_id / source path (both server-side) may name the reference image.
  if (type === 'image') {
    const checked = validateImageRequest(body.image)
    if (!checked.ok) return checked
    const image = checked.image
    if (image.mode === 'edit') {
      const rawImage = isPlainObject(body.image) ? body.image : {}
      const sourceUpload = rawImage.source_upload_id
      const sourcePath = rawImage.source_image
      if (sourceUpload !== undefined && sourcePath !== undefined) {
        return { ok: false, status: 400, error: 'source_upload_id 与 source_image 二选一' }
      }
      if (sourceUpload !== undefined) {
        if (typeof sourceUpload !== 'string' || !UPLOAD_ID_RE.test(sourceUpload)) {
          return { ok: false, status: 400, error: 'source_upload_id: 非法' }
        }
        const ready = readReadyUpload(ctx, sourceUpload)
        if (!ready.ok) return { ok: false, status: ready.status, error: ready.error }
        if (!IMAGE_KINDS.has(path.extname(ready.name).toLowerCase())) {
          return { ok: false, status: 400, error: 'source_upload_id: 仅支持 png / jpg / jpeg / webp' }
        }
        const meta = ctx.readJson(path.join(ctx.dataRoot, 'uploads', sourceUpload, 'meta.json'))
        const studioPath = typeof meta?.studio_path === 'string' ? meta.studio_path : ''
        if (!studioPath) {
          return { ok: false, status: 409, error: 'source_upload_id: 参考图尚未转发到 studio' }
        }
        image.source_image = studioPath
      } else if (typeof sourcePath === 'string' && sourcePath.trim()) {
        // Advanced mode: a controlled absolute path on the studio host; intake
        // re-validates it against its allowed roots.
        image.source_image = sourcePath.trim()
      } else {
        return { ok: false, status: 400, error: 'image.source_upload_id 或 image.source_image 必填' }
      }
    }
    let imageId: string | undefined
    if (hasKey(body, 'id')) {
      if (typeof body.id !== 'string' || !JOB_NAME_RE.test(body.id)) {
        return { ok: false, status: 400, error: 'id: 非法' }
      }
      imageId = body.id
    }
    return {
      ok: true,
      job: {
        id: imageId,
        type: 'image',
        rail: 'B',
        brief_id: null,
        model: null,
        image
      }
    }
  }
  const hasInput = hasKey(body, 'input') && body.input !== null && body.input !== undefined
  const hasUpload = hasKey(body, 'upload_id') && body.upload_id !== null && body.upload_id !== undefined
  if (hasInput && hasUpload) {
    return { ok: false, status: 400, error: 'input 与 upload_id 二选一' }
  }
  if (!hasInput && !hasUpload) {
    return { ok: false, status: 400, error: 'input 或 upload_id 必填' }
  }
  let input: string | undefined
  let uploadId: string | undefined
  if (hasInput) {
    if (typeof body.input !== 'string' || !body.input.trim()) {
      return { ok: false, status: 400, error: 'input: 需为 studio 上已存在的绝对路径' }
    }
    input = body.input
  } else {
    if (typeof body.upload_id !== 'string' || !UPLOAD_ID_RE.test(body.upload_id)) {
      return { ok: false, status: 400, error: 'upload_id: 非法' }
    }
    uploadId = body.upload_id
  }
  const rail = hasKey(body, 'rail') ? body.rail : 'A'
  if (typeof rail !== 'string' || !RAILS.has(rail as Rail)) {
    return { ok: false, status: 400, error: 'rail: 需为 A / B' }
  }
  let id: string | undefined
  if (hasKey(body, 'id')) {
    if (typeof body.id !== 'string' || !JOB_NAME_RE.test(body.id)) {
      return { ok: false, status: 400, error: 'id: 非法' }
    }
    id = body.id
  }
  let briefId: string | null = null
  if (hasKey(body, 'brief_id') && body.brief_id !== null) {
    if (typeof body.brief_id !== 'string') {
      return { ok: false, status: 400, error: 'brief_id: 不存在' }
    }
    const brief = readBrief(ctx, body.brief_id)
    if (!brief) return { ok: false, status: 400, error: 'brief_id: 不存在' }
    // #87 §1.4: no GPU job may start until the Brief was confirmed via
    // `/confirm` (schema + questions checked there).
    if (brief.status !== 'confirmed') {
      return { ok: false, status: 409, error: 'brief_not_confirmed' }
    }
    briefId = body.brief_id
  }
  let model: Record<string, unknown> | null = null
  if (hasKey(body, 'model') && body.model !== null) {
    if (!isPlainObject(body.model)) {
      return { ok: false, status: 400, error: 'model: 需为对象或 null' }
    }
    model = body.model
  }
  // #89b: keyframe injection is scoped to `{source_job, name}` — a browser
  // never supplies an absolute studio path.
  let keyframeAsset: { source_job: string; name: string } | undefined
  if (hasKey(body, 'keyframe_asset') && body.keyframe_asset !== null) {
    const k = body.keyframe_asset
    const name = isPlainObject(k) ? k.name : null
    if (
      !isPlainObject(k) ||
      typeof k.source_job !== 'string' ||
      !JOB_NAME_RE.test(k.source_job) ||
      typeof name !== 'string' ||
      !name ||
      path.basename(name) !== name ||
      name.startsWith('.') ||
      !IMAGE_KINDS.has(path.extname(name).toLowerCase())
    ) {
      return { ok: false, status: 400, error: 'keyframe_asset: 需为 {source_job, name} 且 name 为图片文件名' }
    }
    keyframeAsset = { source_job: k.source_job, name }
  }
  return {
    ok: true,
    job: {
      id,
      type: type as JobType,
      rail: rail as Rail,
      brief_id: briefId,
      model,
      input,
      upload_id: uploadId,
      keyframe_asset: keyframeAsset
    }
  }
}

interface UploadTrace {
  upload_id: string
  nas_path: string | null
  studio_path: string | null
}

async function submitJob(
  ctx: StudioContext,
  res: ServerResponse,
  job: CreateJobInput,
  upload?: UploadTrace
): Promise<void> {
  // #89b: image jobs use the Q1 `image` object and carry no video input.
  // #86d: video jobs (aigc / optimize) must forward `type` + `rail` too —
  // without them intake defaults to `aigc` / rail A and B-track optimize jobs
  // were misrouted into A-track i2v (86c F-01/F-02).
  const payload: Record<string, unknown> =
    job.type === 'image'
      ? { type: 'image', image: job.image }
      : { type: job.type, rail: job.rail, input: job.input }
  if (job.id) {
    payload.id = job.id
    payload.job = job.id
  }
  if (job.type !== 'image' && job.keyframe_asset) {
    payload.keyframe_asset = job.keyframe_asset
  }
  // #98 I1: forward the confirmed Brief so intake can persist jobs/<job>/brief.json
  // and stage A can consume logline/script/shot prompts. Without brief_id the
  // payload stays byte-for-byte identical to the pre-#98 behaviour.
  if (job.brief_id) {
    const brief = readBrief(ctx, job.brief_id)
    if (!brief) {
      ctx.sendJson(res, 409, { error: 'brief_polished_invalid', path: '' })
      return
    }
    const checked = validatePolished(brief.polished)
    if (!checked.ok) {
      ctx.sendJson(res, 409, {
        error: 'brief_polished_invalid',
        path: checked.path,
        reason: checked.reason
      })
      return
    }
    payload.brief_id = job.brief_id
    payload.polished = brief.polished
  }
  const upstream = await callIntake(ctx, 'POST', '/intake/jobs', payload)
  if (!upstream.ok || upstream.status >= 400) {
    if (upload) {
      const reason = !upstream.ok
        ? upstream.body.reason
        : typeof upstream.body?.error === 'string'
          ? upstream.body.error
          : `status_${upstream.status}`
      ctx.sendJson(res, 502, {
        error: 'job_create_failed',
        reason,
        upload_id: upload.upload_id,
        studio_path: upload.studio_path
      })
      return
    }
    if (!upstream.ok) {
      ctx.sendJson(res, upstream.status, upstream.body)
      return
    }
    ctx.sendJson(res, upstream.status, upstream.body ?? { error: 'intake rejected the job' })
    return
  }
  const id = typeof upstream.body?.id === 'string' ? upstream.body.id : job.id
  if (!id) {
    ctx.sendJson(res, 502, { error: 'intake unavailable', reason: 'missing job id' })
    return
  }
  writeJobMeta(ctx, {
    id,
    type: job.type,
    rail: job.rail,
    brief_id: job.brief_id,
    model: job.model,
    input: job.input ?? null,
    created_at: nowIso(),
    upload_id: upload?.upload_id ?? null,
    nas_path: upload?.nas_path ?? null,
    image: job.type === 'image' ? (job.image ?? null) : null,
    keyframe_asset: job.keyframe_asset ?? null
  })
  const detail = await callIntake(ctx, 'GET', `/intake/jobs/${encodeURIComponent(id)}`)
  const detailBody = detail.ok && detail.status === 200 ? detail.body : { state: 'queued', updated_at: nowIso() }
  ctx.sendJson(res, upstream.status, buildStudioJob(ctx, id, detailBody))
}

type ReadyUpload =
  | { ok: true; name: string; sha256: string; sourcePath: string; size: number }
  | { ok: false; status: number; error: string }

/** Reads the NAS upload record written by `uploads.ts`; must be `status=ready`. */
function readReadyUpload(ctx: StudioContext, uploadId: string): ReadyUpload {
  const metaFile = path.join(ctx.dataRoot, 'uploads', uploadId, 'meta.json')
  const meta = ctx.readJson(metaFile)
  if (!meta || typeof meta !== 'object' || meta.upload_id !== uploadId) {
    return { ok: false, status: 404, error: 'upload not found' }
  }
  if (meta.status !== 'ready') {
    return { ok: false, status: 409, error: `upload not ready (status=${String(meta.status)})` }
  }
  const name = typeof meta.filename === 'string' ? meta.filename : ''
  const ext = typeof meta.ext === 'string' ? meta.ext : path.extname(name)
  const sha256 = typeof meta.sha256 === 'string' ? meta.sha256 : ''
  if (!name || !SHA256_RE.test(sha256) || !ext) {
    return { ok: false, status: 409, error: 'upload metadata is incomplete' }
  }
  const sourcePath = path.join(ctx.dataRoot, 'uploads', uploadId, `source${ext}`)
  try {
    const stat = fs.statSync(sourcePath)
    if (!stat.isFile()) return { ok: false, status: 409, error: 'upload source missing' }
    return { ok: true, name, sha256, sourcePath, size: stat.size }
  } catch {
    return { ok: false, status: 409, error: 'upload source missing' }
  }
}

type ForwardResult =
  | { ok: true; path: string; size: number; sha256: string }
  | { ok: false; reason: string }

/** Streams the NAS source to studio `POST /intake/uploads` (10 min budget). */
async function forwardUploadToStudio(
  ctx: StudioContext,
  uploadId: string,
  upload: Extract<ReadyUpload, { ok: true }>
): Promise<ForwardResult> {
  try {
    const upstream = await fetch(`${ctx.intakeUrl}/intake/uploads`, {
      method: 'POST',
      headers: {
        'X-Web-Token': ctx.webToken ?? '',
        'X-Upload-Id': uploadId,
        'X-Filename': upload.name,
        'X-Sha256': upload.sha256,
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(upload.size)
      },
      body: fs.createReadStream(upload.sourcePath) as unknown as BodyInit,
      duplex: 'half',
      signal: AbortSignal.timeout(UPLOAD_FORWARD_TIMEOUT_MS)
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
      return { ok: false, reason }
    }
    if (
      !parsed ||
      typeof parsed.path !== 'string' ||
      typeof parsed.size !== 'number' ||
      parsed.size !== upload.size ||
      typeof parsed.sha256 !== 'string' ||
      parsed.sha256.toLowerCase() !== upload.sha256.toLowerCase()
    ) {
      return { ok: false, reason: 'invalid_studio_response' }
    }
    return { ok: true, path: parsed.path, size: parsed.size, sha256: parsed.sha256 }
  } catch (err) {
    const reason = intakeReason(err)
    console.error(`[studio] POST /intake/uploads -> ${reason}`)
    return { ok: false, reason }
  }
}

async function submitUploadJob(
  ctx: StudioContext,
  res: ServerResponse,
  job: CreateJobInput
): Promise<void> {
  const uploadId = job.upload_id as string
  const ready = readReadyUpload(ctx, uploadId)
  if (!ready.ok) {
    ctx.sendJson(res, ready.status, { error: ready.error })
    return
  }
  const forwarded = await forwardUploadToStudio(ctx, uploadId, ready)
  if (!forwarded.ok) {
    ctx.sendJson(res, 502, { error: 'studio_upload_unavailable', reason: forwarded.reason })
    return
  }
  await submitJob(ctx, res, { ...job, input: forwarded.path }, {
    upload_id: uploadId,
    nas_path: ready.sourcePath,
    studio_path: forwarded.path
  })
}

async function createJobFromRequest(ctx: StudioContext, req: IncomingMessage, res: ServerResponse) {
  if (!requireWrite(ctx, req, res)) return
  if (!requireIntakeToken(ctx, res)) return
  let body: unknown
  try {
    body = await ctx.readBody(req)
  } catch {
    ctx.sendJson(res, 400, { error: 'invalid JSON body' })
    return
  }
  const checked = validateCreateJob(ctx, body)
  if (!checked.ok) {
    ctx.sendJson(res, checked.status, { error: checked.error })
    return
  }
  if (checked.job.upload_id) {
    await submitUploadJob(ctx, res, checked.job)
    return
  }
  await submitJob(ctx, res, checked.job)
}

async function listJobs(ctx: StudioContext, url: URL, res: ServerResponse) {
  if (!requireIntakeToken(ctx, res)) return
  const rawLimit = Number(url.searchParams.get('limit') ?? '20')
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 100) : 20
  const upstream = await callIntake(ctx, 'GET', `/intake/jobs?limit=${limit}`)
  if (!upstream.ok) {
    ctx.sendJson(res, upstream.status, upstream.body)
    return
  }
  if (upstream.status >= 400) {
    ctx.sendJson(res, upstream.status, upstream.body ?? { error: 'intake rejected the request' })
    return
  }
  const items = Array.isArray(upstream.body?.items) ? upstream.body.items : []
  const summaries = items.map((item: any) => buildSummary(ctx, item))
  ctx.sendJson(res, 200, { items: summaries, count: summaries.length, source: 'studio' })
}

/**
 * #86b2 read-only artifact proxy:
 * `GET/HEAD /api/studio/jobs/:id/artifacts/:name`
 * → intake `GET /intake/jobs/:id/artifacts/:name` with `X-Web-Token`.
 * Streams the upstream body (no buffering) and keeps the short TTL from
 * `media.ts`; Range is forwarded so `<video>` can seek.
 */
async function serveArtifact(
  ctx: StudioContext,
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  name: string
): Promise<void> {
  if (!requireIntakeToken(ctx, res)) return
  if (!JOB_NAME_RE.test(id)) {
    ctx.sendJson(res, 404, { error: 'job not found' })
    return
  }
  const check = checkArtifactName(name)
  if (!check.ok) {
    ctx.sendJson(res, check.status, { error: check.error })
    return
  }
  const headers: Record<string, string> = {}
  if (ctx.webToken) headers['X-Web-Token'] = ctx.webToken
  if (typeof req.headers.range === 'string' && req.headers.range) {
    headers.Range = req.headers.range
  }
  // #86b2-fix: intake does not implement HEAD (501), so always probe with GET
  // and drop the body for HEAD responses below.
  try {
    const upstream = await fetch(
      `${ctx.intakeUrl}/intake/jobs/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(name)}`,
      { method: 'GET', headers, signal: AbortSignal.timeout(ARTIFACT_TIMEOUT_MS) }
    )
    if (upstream.status === 404) {
      await upstream.body?.cancel().catch(() => {})
      ctx.sendJson(res, 404, { error: 'artifact not found' })
      return
    }
    if (upstream.status === 401 || upstream.status === 403) {
      await upstream.body?.cancel().catch(() => {})
      ctx.sendJson(res, 403, {
        error: 'artifact not allowed',
        reason: `intake rejected the proxy request (${upstream.status})`
      })
      return
    }
    // #86e: client errors are the client's own answer — forward 416 (and any
    // other 4xx) with its body/range headers. Only upstream 5xx / network
    // failures may become a 502.
    if (!upstream.ok && upstream.status !== 206) {
      const status = upstream.status
      if (status >= 400 && status < 500) {
        const body = await upstream.text().catch(() => '')
        res.statusCode = status
        const errorType = upstream.headers.get('content-type')
        if (errorType) res.setHeader('Content-Type', errorType)
        res.setHeader('Cache-Control', 'private, max-age=30')
        const acceptRanges = upstream.headers.get('accept-ranges')
        if (acceptRanges) res.setHeader('Accept-Ranges', acceptRanges)
        else if (status === 416) res.setHeader('Accept-Ranges', 'bytes')
        const contentRange = upstream.headers.get('content-range')
        if (contentRange) res.setHeader('Content-Range', contentRange)
        if (req.method === 'HEAD' || !body) res.end()
        else res.end(body)
        return
      }
      await upstream.body?.cancel().catch(() => {})
      ctx.sendJson(res, 502, {
        error: 'artifact proxy failed',
        reason: `intake responded ${status}`
      })
      return
    }
    // #86b2-fix: do not blindly trust the upstream content type — intake can
    // answer with an empty or generic `application/octet-stream` for artifacts.
    const upstreamType = upstream.headers.get('content-type')
    const contentType =
      upstreamType && !/^application\/octet-stream\s*(;|$)/i.test(upstreamType)
        ? upstreamType
        : contentTypeFor(name)

    if (req.method === 'HEAD') {
      // HEAD was answered by a GET upstream: publish the headers we can trust
      // (type/length/range) and discard the body without forwarding it.
      res.statusCode = upstream.status
      res.setHeader('Content-Type', contentType)
      res.setHeader('Cache-Control', 'private, max-age=30')
      res.setHeader('Accept-Ranges', upstream.headers.get('accept-ranges') ?? 'bytes')
      const contentLength = upstream.headers.get('content-length')
      if (contentLength) res.setHeader('Content-Length', contentLength)
      const contentRange = upstream.headers.get('content-range')
      if (contentRange) res.setHeader('Content-Range', contentRange)
      await upstream.body?.cancel().catch(() => {})
      res.end()
      return
    }

    serveStream(req, res, upstream.body as ReadableStream<Uint8Array> | null, {
      status: upstream.status,
      contentType,
      contentLength: upstream.headers.get('content-length'),
      contentRange: upstream.headers.get('content-range'),
      acceptRanges: upstream.headers.get('accept-ranges')
    })
  } catch (err) {
    if (res.headersSent) {
      res.destroy()
      return
    }
    ctx.sendJson(res, 502, { error: 'artifact proxy failed', reason: intakeReason(err) })
  }
}

async function jobDetail(ctx: StudioContext, res: ServerResponse, id: string) {
  if (!requireIntakeToken(ctx, res)) return
  if (!JOB_NAME_RE.test(id)) {
    ctx.sendJson(res, 404, { error: 'job not found' })
    return
  }
  const upstream = await callIntake(ctx, 'GET', `/intake/jobs/${encodeURIComponent(id)}`)
  if (!upstream.ok) {
    ctx.sendJson(res, upstream.status, upstream.body)
    return
  }
  if (upstream.status >= 400) {
    ctx.sendJson(res, upstream.status, upstream.body ?? { error: 'job not found' })
    return
  }
  ctx.sendJson(res, 200, buildStudioJob(ctx, id, upstream.body))
}

async function cancelJob(ctx: StudioContext, req: IncomingMessage, res: ServerResponse, id: string) {
  if (!requireWrite(ctx, req, res)) return
  if (!requireIntakeToken(ctx, res)) return
  if (!JOB_NAME_RE.test(id)) {
    ctx.sendJson(res, 404, { error: 'job not found' })
    return
  }
  const upstream = await callIntake(ctx, 'POST', `/intake/jobs/${encodeURIComponent(id)}/cancel`)
  if (!upstream.ok) {
    ctx.sendJson(res, upstream.status, upstream.body)
    return
  }
  if (upstream.status === 200) {
    ctx.sendJson(res, 200, { id, status: 'canceled' })
    return
  }
  ctx.sendJson(res, upstream.status, upstream.body ?? { error: 'cancel rejected' })
}

async function retryJob(ctx: StudioContext, req: IncomingMessage, res: ServerResponse, id: string) {
  if (!requireWrite(ctx, req, res)) return
  if (!requireIntakeToken(ctx, res)) return
  if (!JOB_NAME_RE.test(id)) {
    ctx.sendJson(res, 404, { error: 'job not found' })
    return
  }
  const upstream = await callIntake(ctx, 'GET', `/intake/jobs/${encodeURIComponent(id)}`)
  if (!upstream.ok) {
    ctx.sendJson(res, upstream.status, upstream.body)
    return
  }
  if (upstream.status >= 400) {
    ctx.sendJson(res, upstream.status, upstream.body ?? { error: 'job not found' })
    return
  }
  const status = studioStatus(upstream.body?.state)
  if (status !== 'failed' && status !== 'canceled') {
    ctx.sendJson(res, 409, { error: 'retry requires a failed or canceled job', status })
    return
  }
  const meta = readJobMeta(ctx, id)
  if (!meta?.input) {
    ctx.sendJson(res, 409, { error: 'retry unavailable: source input is unknown' })
    return
  }
  const retryId = `${id}-r${Math.floor(Date.now() / 1000)}`
  if (!JOB_NAME_RE.test(retryId)) {
    ctx.sendJson(res, 400, { error: 'retry id is too long' })
    return
  }
  const upload: UploadTrace | undefined = meta.upload_id
    ? {
        upload_id: meta.upload_id,
        nas_path: meta.nas_path ?? null,
        studio_path: meta.input
      }
    : undefined
  await submitJob(
    ctx,
    res,
    {
      id: retryId,
      type: meta.type,
      rail: meta.rail,
      brief_id: meta.brief_id,
      model: meta.model,
      input: meta.input ?? undefined,
      image: meta.image ?? undefined,
      keyframe_asset: meta.keyframe_asset ?? undefined
    },
    upload
  )
}

// ---------------------------------------------------------------------------
// #140 job deletion + image retention
// ---------------------------------------------------------------------------

const AUDIT_LOG = (ctx: StudioContext) => path.join(ctx.dataRoot, 'logs', 'audit.log')
const DEFAULT_IMAGE_RETENTION_DAYS = 7
const RETENTION_INTERVAL_MS = 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

type AuditEntry = {
  ts: string
  ip: string
  action: 'job_delete' | 'job_retention'
  id: string | null
  status: number | string
  [key: string]: unknown
}

/** Best-effort JSONL audit; a read-only data root must never break an action. */
function appendAudit(ctx: StudioContext, entry: AuditEntry): void {
  try {
    const file = AUDIT_LOG(ctx)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8')
  } catch {
    /* audit is diagnostic, not a gate */
  }
}

function requestIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for']
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded
  if (typeof raw === 'string' && raw.trim()) return raw.split(',')[0].trim()
  return req.socket?.remoteAddress ?? 'unknown'
}

/**
 * Resolves `p` through symlinks, walking up to the nearest existing ancestor
 * (macOS temp dirs are symlinked, so a plain resolve is not enough).
 */
function realOrNearest(p: string): string | null {
  let current = path.resolve(p)
  const missing: string[] = []
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...missing.slice().reverse())
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return null
      missing.push(path.basename(current))
      current = parent
    }
  }
}

/**
 * `root/name` when `name` is one plain segment and the resolved target (symlinks
 * included) stays under `root`; null for `..`, absolute paths and escapes.
 */
function safeChild(root: string, name: string): string | null {
  if (
    !name ||
    name !== path.basename(name) ||
    name.includes('/') ||
    name.includes('\\') ||
    name === '.' ||
    name === '..' ||
    path.isAbsolute(name)
  ) {
    return null
  }
  const rootResolved = path.resolve(root)
  const target = path.resolve(rootResolved, name)
  if (path.dirname(target) !== rootResolved) return null
  const rootReal = realOrNearest(rootResolved)
  const targetReal = realOrNearest(target)
  if (!rootReal || !targetReal) return null
  if (targetReal !== rootReal && !targetReal.startsWith(rootReal + path.sep)) return null
  return target
}

function removeIfExists(target: string): boolean {
  try {
    fs.lstatSync(target)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
  fs.rmSync(target, { recursive: true, force: true })
  return true
}

/**
 * Deletes only the two web-owned paths of a job:
 * `<WEB_DATA_ROOT>/jobs/<id>` and `<WEB_DATA_ROOT>/studio/jobs/<id>.json`.
 * State/reports stay untouched on purpose (audit trail).
 */
export function removeJobFiles(
  ctx: StudioContext,
  id: string
): { ok: boolean; deletedDir: boolean; deletedMeta: boolean } {
  const dir = safeChild(path.join(ctx.dataRoot, 'jobs'), id)
  const meta = safeChild(path.join(ctx.dataRoot, 'studio', 'jobs'), `${id}.json`)
  if (!dir || !meta) return { ok: false, deletedDir: false, deletedMeta: false }
  try {
    return { ok: true, deletedDir: removeIfExists(dir), deletedMeta: removeIfExists(meta) }
  } catch {
    return { ok: false, deletedDir: false, deletedMeta: false }
  }
}

function auditDelete(ctx: StudioContext, ip: string, id: string, status: number): void {
  appendAudit(ctx, { ts: nowIso(), ip, action: 'job_delete', id, status })
}

/**
 * `DELETE /api/studio/jobs/:id` (#140).
 * Only `failed|canceled` jobs may be removed; the intake remains the source of
 * truth for status, so a missing upstream job is a 404 and a live one a 409.
 */
async function deleteJob(
  ctx: StudioContext,
  req: IncomingMessage,
  res: ServerResponse,
  id: string
): Promise<void> {
  if (ctx.authorizeTaskWrite) {
    const auth = ctx.authorizeTaskWrite(req)
    if (!auth.ok) {
      ctx.sendJson(res, auth.status, { error: auth.error })
      return
    }
  } else if (!requireWrite(ctx, req, res)) {
    return
  }

  const ip = requestIp(req)
  if (!JOB_NAME_RE.test(id) || path.basename(id) !== id) {
    auditDelete(ctx, ip, id, 400)
    ctx.sendJson(res, 400, { error: 'invalid job id' })
    return
  }

  const upstream = await callIntake(ctx, 'GET', `/intake/jobs/${encodeURIComponent(id)}`)
  if (!upstream.ok) {
    auditDelete(ctx, ip, id, 502)
    ctx.sendJson(res, 502, upstream.body)
    return
  }
  if (upstream.status >= 400) {
    auditDelete(ctx, ip, id, 404)
    ctx.sendJson(res, 404, upstream.body ?? { error: 'job not found' })
    return
  }

  const status = studioStatus(upstream.body?.state)
  if (status !== 'failed' && status !== 'canceled') {
    auditDelete(ctx, ip, id, 409)
    ctx.sendJson(res, 409, { error: 'delete requires a failed or canceled job', status })
    return
  }

  const removed = removeJobFiles(ctx, id)
  if (!removed.ok) {
    auditDelete(ctx, ip, id, 400)
    ctx.sendJson(res, 400, { error: 'job path rejected' })
    return
  }
  if (!removed.deletedDir && !removed.deletedMeta) {
    auditDelete(ctx, ip, id, 404)
    ctx.sendJson(res, 404, { error: 'job not found' })
    return
  }

  auditDelete(ctx, ip, id, 200)
  ctx.sendJson(res, 200, { deleted: true, id })
}

/** `WEB_IMAGE_RETENTION_DAYS`: default 7, `0` disables the sweep. */
export function resolveImageRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.WEB_IMAGE_RETENTION_DAYS ?? '').trim()
  if (!raw) return DEFAULT_IMAGE_RETENTION_DAYS
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) return DEFAULT_IMAGE_RETENTION_DAYS
  return Math.floor(value)
}

export interface RetentionJob {
  id: string
  type: string
  status: JobStatus
  updated_at: string | null
}

/** Pure expiry rule: image + failed/canceled + older than `days`. */
export function selectExpiredImageJobs(
  jobs: RetentionJob[],
  days: number,
  now: number = Date.now()
): string[] {
  if (!(days > 0)) return []
  const cutoff = days * DAY_MS
  return jobs
    .filter((job) => {
      if (job.type !== 'image') return false
      if (job.status !== 'failed' && job.status !== 'canceled') return false
      if (typeof job.updated_at !== 'string') return false
      const updated = Date.parse(job.updated_at)
      if (!Number.isFinite(updated)) return false
      return now - updated > cutoff
    })
    .map((job) => job.id)
}

function readImageJobMetas(ctx: StudioContext): JobMeta[] {
  let names: string[]
  try {
    names = fs.readdirSync(JOBS_DIR(ctx))
  } catch {
    return []
  }
  const metas: JobMeta[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const id = name.slice(0, -'.json'.length)
    if (!JOB_NAME_RE.test(id)) continue
    const doc = ctx.readJson(path.join(JOBS_DIR(ctx), name))
    if (!isPlainObject(doc) || doc.id !== id || doc.type !== 'image') continue
    metas.push(doc as JobMeta)
  }
  return metas
}

export interface RetentionSweepResult {
  deleted: string[]
  retained: number
  skipped?: 'disabled' | 'intake'
}

/**
 * Deletes expired image jobs (failed/canceled only). Intake failures never
 * throw: the sweep reports `skipped: 'intake'` and keeps the directories.
 */
export async function sweepExpiredImageJobs(
  ctx: StudioContext,
  opts: { now?: number; days?: number } = {}
): Promise<RetentionSweepResult> {
  const days = opts.days ?? resolveImageRetentionDays()
  if (!(days > 0)) return { deleted: [], retained: 0, skipped: 'disabled' }

  const metas = readImageJobMetas(ctx)
  if (metas.length === 0) return { deleted: [], retained: 0 }

  const upstream = await callIntake(ctx, 'GET', '/intake/jobs?limit=200')
  if (!upstream.ok || upstream.status >= 400) {
    appendAudit(ctx, {
      ts: nowIso(),
      ip: 'internal',
      action: 'job_retention',
      id: null,
      status: 'intake_unavailable',
      deleted: 0,
      retained: metas.length
    })
    return { deleted: [], retained: metas.length, skipped: 'intake' }
  }

  const items = Array.isArray(upstream.body?.items) ? upstream.body.items : []
  const byId = new Map<string, any>()
  for (const item of items) {
    if (isPlainObject(item) && typeof item.id === 'string') byId.set(item.id, item)
  }

  const jobs: RetentionJob[] = metas.map((meta) => {
    const item = byId.get(meta.id)
    return {
      id: meta.id,
      type: meta.type,
      status: studioStatus(item?.state),
      updated_at: typeof item?.updated_at === 'string' ? item.updated_at : null
    }
  })

  const deleted: string[] = []
  for (const id of selectExpiredImageJobs(jobs, days, opts.now)) {
    const removed = removeJobFiles(ctx, id)
    if (!removed.ok || (!removed.deletedDir && !removed.deletedMeta)) continue
    deleted.push(id)
    appendAudit(ctx, {
      ts: nowIso(),
      ip: 'internal',
      action: 'job_retention',
      id,
      status: 'deleted'
    })
  }

  const retained = jobs.length - deleted.length
  appendAudit(ctx, {
    ts: nowIso(),
    ip: 'internal',
    action: 'job_retention',
    id: null,
    status: 200,
    deleted: deleted.length,
    retained
  })
  return { deleted, retained }
}

/** Boot + hourly retention sweep; the timer never keeps the process alive. */
export function startImageRetentionSweep(
  ctxFactory: () => StudioContext,
  intervalMs: number = RETENTION_INTERVAL_MS
): () => void {
  const run = async (): Promise<void> => {
    try {
      const result = await sweepExpiredImageJobs(ctxFactory())
      if (result.deleted.length > 0) {
        console.log(
          `[studio] retention deleted ${result.deleted.length} image job(s), retained ${result.retained}`
        )
      }
    } catch (err) {
      console.error('[studio] retention sweep failed:', (err as Error).message)
    }
  }
  void run()
  const timer = setInterval(() => void run(), intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function tsOrNull(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/**
 * #139: real generation duration in ms, never estimated.
 * Priority mirrors the ticket: intake/state duration fields first, then
 * `finished_at - (started_at ?? created_at)`. Anything missing stays null so
 * the gallery renders 「耗时未记录」 instead of inventing a number.
 */
export function resolveJobDurationMs(
  source: unknown,
  fallbackCreatedAt?: string | null
): number | null {
  if (!isPlainObject(source)) return null
  const direct = numOrNull(source.duration_ms)
  if (direct !== null && direct >= 0) return Math.round(direct)
  const elapsedMs = numOrNull(source.elapsed_ms)
  if (elapsedMs !== null && elapsedMs >= 0) return Math.round(elapsedMs)
  const elapsedS = numOrNull(source.elapsed_s)
  if (elapsedS !== null && elapsedS >= 0) return Math.round(elapsedS * 1000)
  const durationS = numOrNull(source.duration_s)
  if (durationS !== null && durationS >= 0) return Math.round(durationS * 1000)
  const finished = tsOrNull(source.finished_at)
  const started =
    tsOrNull(source.started_at) ??
    tsOrNull(source.created_at) ??
    tsOrNull(fallbackCreatedAt)
  if (finished !== null && started !== null && finished >= started) return finished - started
  return null
}

/** #89b gallery projection: only image jobs, URLs always via the proxy. */
export interface GalleryItem {
  id: string
  status: JobStatus
  created_at: string
  updated_at: string
  error: string | null
  stage: string | null
  mode: ImageMode | null
  prompt: string | null
  negative: string | null
  width: number | null
  height: number | null
  seed: number | null
  steps: number | null
  denoise: number | null
  elapsed_s: number | null
  /** #139: real duration in ms, null when neither state nor timestamps can prove it. */
  duration_ms: number | null
  images: Array<{ name: string; url: string }>
  cover_url: string | null
}

export function buildGalleryItem(
  id: string,
  meta: JobMeta | null,
  detail: any
): GalleryItem {
  const images: Array<{ name: string; url: string }> = []
  const seen = new Set<string>()
  const artifacts = isPlainObject(detail?.artifacts) ? detail.artifacts : {}
  for (const raw of Object.values(artifacts)) {
    if (typeof raw !== 'string') continue
    const name = path.basename(raw)
    if (!name || !IMAGE_KINDS.has(path.extname(name).toLowerCase()) || seen.has(name)) continue
    seen.add(name)
    images.push({
      name,
      url: `/api/studio/jobs/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(name)}`
    })
  }
  const image = isPlainObject(detail?.image) ? detail.image : isPlainObject(meta?.image) ? meta?.image : {}
  const num = (key: string): number | null =>
    typeof image?.[key] === 'number' ? (image[key] as number) : null
  const str = (key: string): string | null =>
    typeof image?.[key] === 'string' ? (image[key] as string) : null
  const cover = assetRefFromPath(detail?.cover_asset)
  return {
    id,
    status: studioStatus(detail?.state),
    created_at: meta?.created_at ?? (typeof detail?.updated_at === 'string' ? detail.updated_at : nowIso()),
    updated_at: typeof detail?.updated_at === 'string' ? detail.updated_at : nowIso(),
    error: typeof detail?.error === 'string' ? detail.error : null,
    stage: typeof detail?.stage === 'string' ? detail.stage : null,
    mode: str('mode') as ImageMode | null,
    prompt: str('prompt'),
    negative: str('negative'),
    width: num('width'),
    height: num('height'),
    seed: num('seed'),
    steps: num('steps'),
    denoise: num('denoise'),
    elapsed_s: typeof detail?.elapsed_s === 'number' ? detail.elapsed_s : null,
    duration_ms: resolveJobDurationMs(detail, meta?.created_at ?? null),
    images,
    cover_url: cover?.url ?? null
  }
}

/**
 * `GET /api/studio/gallery?job=<id>&limit=24`
 * Lists recent `type=image` jobs (web-created, meta-backed) with their proxy
 * URLs. Details are read per job because the intake list has no artifacts.
 */
async function imageGallery(ctx: StudioContext, url: URL, res: ServerResponse) {
  if (!requireIntakeToken(ctx, res)) return
  const rawLimit = Number(url.searchParams.get('limit') ?? '24')
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 50) : 24
  const jobFilter = url.searchParams.get('job')
  if (jobFilter && !JOB_NAME_RE.test(jobFilter)) {
    ctx.sendJson(res, 400, { error: 'job: 非法任务 id' })
    return
  }
  const upstream = await callIntake(ctx, 'GET', '/intake/jobs?limit=100')
  if (!upstream.ok) {
    ctx.sendJson(res, upstream.status, upstream.body)
    return
  }
  if (upstream.status >= 400) {
    ctx.sendJson(res, upstream.status, upstream.body ?? { error: 'intake rejected the request' })
    return
  }
  const list = Array.isArray(upstream.body?.items) ? upstream.body.items : []
  const selected: Array<{ id: string; meta: JobMeta | null }> = []
  for (const item of list) {
    const id = typeof item?.id === 'string' ? item.id : ''
    if (!id || !JOB_NAME_RE.test(id)) continue
    if (jobFilter && id !== jobFilter) continue
    const meta = readJobMeta(ctx, id)
    if (meta?.type !== 'image') continue
    selected.push({ id, meta })
    if (selected.length >= limit) break
  }
  const items = await Promise.all(
    selected.map(async ({ id, meta }) => {
      const detail = await callIntake(ctx, 'GET', `/intake/jobs/${encodeURIComponent(id)}`)
      const body = detail.ok && detail.status === 200 ? detail.body : { state: 'queued' }
      return buildGalleryItem(id, meta, body)
    })
  )
  ctx.sendJson(res, 200, { items, count: items.length, source: 'studio' })
}

/**
 * `POST /api/studio/jobs/:id/cover`
 * Browser sends `{source_job, name}` only; the web server injects the token,
 * never accepts an absolute path, and re-reads the detail so the UI sees the
 * persisted `cover_asset` (contract Q4).
 */
async function setCover(
  ctx: StudioContext,
  req: IncomingMessage,
  res: ServerResponse,
  id: string
) {
  if (!requireWrite(ctx, req, res)) return
  if (!requireIntakeToken(ctx, res)) return
  if (!JOB_NAME_RE.test(id)) {
    ctx.sendJson(res, 404, { error: 'job not found' })
    return
  }
  let body: any
  try {
    body = await ctx.readBody(req)
  } catch {
    ctx.sendJson(res, 400, { error: 'invalid JSON body' })
    return
  }
  if (!isPlainObject(body)) {
    ctx.sendJson(res, 400, { error: 'body must be a JSON object' })
    return
  }
  const name = body.name
  const sourceJob = body.source_job
  if (body.path !== undefined || body.source_image !== undefined) {
    ctx.sendJson(res, 400, { error: 'path: 不接受绝对路径，请使用 {source_job, name}' })
    return
  }
  if (
    typeof name !== 'string' ||
    !name ||
    path.basename(name) !== name ||
    name.startsWith('.') ||
    name.includes('..') ||
    !IMAGE_KINDS.has(path.extname(name).toLowerCase())
  ) {
    ctx.sendJson(res, 400, { error: 'name: 仅支持图片文件名（不含路径）' })
    return
  }
  if (typeof sourceJob !== 'string' || !JOB_NAME_RE.test(sourceJob)) {
    ctx.sendJson(res, 400, { error: 'source_job: 非法任务 id' })
    return
  }
  const upstream = await callIntake(ctx, 'POST', `/intake/jobs/${encodeURIComponent(id)}/cover`, {
    source_job: sourceJob,
    name
  })
  if (!upstream.ok) {
    ctx.sendJson(res, upstream.status, upstream.body)
    return
  }
  if (upstream.status >= 400) {
    const reason = isPlainObject(upstream.body) ? upstream.body.reason : null
    ctx.sendJson(res, upstream.status, {
      error: typeof upstream.body?.error === 'string' ? upstream.body.error : 'cover_update_failed',
      ...(typeof reason === 'string' ? { reason } : {})
    })
    return
  }
  // 成功回读：以 detail 为准，POST 响应仅作兜底。
  const detail = await callIntake(ctx, 'GET', `/intake/jobs/${encodeURIComponent(id)}`)
  const raw =
    detail.ok && detail.status === 200 ? detail.body?.cover_asset : upstream.body?.cover_asset
  const cover = assetRefFromPath(raw)
  ctx.sendJson(res, 200, {
    ok: true,
    job: id,
    cover_asset: cover,
    cover_url: cover?.url ?? null
  })
}

async function health(ctx: StudioContext, res: ServerResponse) {
  const upstream = await callIntake(ctx, 'GET', '/intake/health')
  ctx.sendJson(res, upstream.status, upstream.body)
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * Handles every `/api/studio/*` request; returns false only when the path is
 * outside this module's prefix.
 */
export async function handleStudioRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  pathname: string,
  ctx: StudioContext
): Promise<boolean> {
  if (pathname !== '/api/studio' && !pathname.startsWith('/api/studio/')) return false
  const method = req.method ?? 'GET'

  if (pathname === '/api/studio/health') {
    if (method !== 'GET' && method !== 'HEAD') {
      ctx.sendJson(res, 405, { error: 'method not allowed' })
      return true
    }
    await health(ctx, res)
    return true
  }

  if (pathname === '/api/studio/briefs') {
    if (method === 'GET' || method === 'HEAD') {
      const rawLimit = Number(url.searchParams.get('limit') ?? '50')
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 200) : 50
      const items = listBriefs(ctx, limit)
      ctx.sendJson(res, 200, { items, count: items.length })
      return true
    }
    if (method === 'POST') {
      if (!requireWrite(ctx, req, res)) return true
      await createBrief(ctx, req, res)
      return true
    }
    ctx.sendJson(res, 405, { error: 'method not allowed' })
    return true
  }

  const briefMatch = pathname.match(/^\/api\/studio\/briefs\/([^/]+)$/)
  if (briefMatch) {
    const id = briefMatch[1]
    if (method === 'GET' || method === 'HEAD') {
      getBrief(ctx, res, id)
      return true
    }
    if (method === 'PATCH') {
      if (!requireWrite(ctx, req, res)) return true
      await patchBrief(ctx, req, res, id)
      return true
    }
    ctx.sendJson(res, 405, { error: 'method not allowed' })
    return true
  }

  const polishMatch = pathname.match(/^\/api\/studio\/briefs\/([^/]+)\/polish$/)
  if (polishMatch) {
    if (method !== 'POST') {
      ctx.sendJson(res, 405, { error: 'method not allowed' })
      return true
    }
    if (!requireWrite(ctx, req, res)) return true
    await polishBrief(ctx, req, res, polishMatch[1])
    return true
  }

  const confirmMatch = pathname.match(/^\/api\/studio\/briefs\/([^/]+)\/confirm$/)
  if (confirmMatch) {
    if (method !== 'POST') {
      ctx.sendJson(res, 405, { error: 'method not allowed' })
      return true
    }
    if (!requireWrite(ctx, req, res)) return true
    await confirmBrief(ctx, req, res, confirmMatch[1])
    return true
  }

  if (pathname === '/api/studio/gallery') {
    if (method !== 'GET' && method !== 'HEAD') {
      ctx.sendJson(res, 405, { error: 'method not allowed' })
      return true
    }
    await imageGallery(ctx, url, res)
    return true
  }

  const coverMatch = pathname.match(/^\/api\/studio\/jobs\/([^/]+)\/cover$/)
  if (coverMatch) {
    if (method !== 'POST') {
      ctx.sendJson(res, 405, { error: 'method not allowed' })
      return true
    }
    await setCover(ctx, req, res, coverMatch[1])
    return true
  }

  if (pathname === '/api/studio/jobs') {
    if (method === 'GET' || method === 'HEAD') {
      await listJobs(ctx, url, res)
      return true
    }
    if (method === 'POST') {
      await createJobFromRequest(ctx, req, res)
      return true
    }
    ctx.sendJson(res, 405, { error: 'method not allowed' })
    return true
  }

  const cancelMatch = pathname.match(/^\/api\/studio\/jobs\/([^/]+)\/cancel$/)
  if (cancelMatch) {
    if (method !== 'POST') {
      ctx.sendJson(res, 405, { error: 'method not allowed' })
      return true
    }
    await cancelJob(ctx, req, res, cancelMatch[1])
    return true
  }

  const retryMatch = pathname.match(/^\/api\/studio\/jobs\/([^/]+)\/retry$/)
  if (retryMatch) {
    if (method !== 'POST') {
      ctx.sendJson(res, 405, { error: 'method not allowed' })
      return true
    }
    await retryJob(ctx, req, res, retryMatch[1])
    return true
  }

  const artifactMatch = pathname.match(/^\/api\/studio\/jobs\/([^/]+)\/artifacts\/([^/]+)$/)
  if (artifactMatch) {
    if (method !== 'GET' && method !== 'HEAD') {
      ctx.sendJson(res, 405, { error: 'method not allowed' })
      return true
    }
    await serveArtifact(ctx, req, res, artifactMatch[1], artifactMatch[2])
    return true
  }

  const jobMatch = pathname.match(/^\/api\/studio\/jobs\/([^/]+)$/)
  if (jobMatch) {
    if (method === 'DELETE') {
      await deleteJob(ctx, req, res, jobMatch[1])
      return true
    }
    if (method !== 'GET' && method !== 'HEAD') {
      ctx.sendJson(res, 405, { error: 'method not allowed' })
      return true
    }
    await jobDetail(ctx, res, jobMatch[1])
    return true
  }

  ctx.sendJson(res, 404, { error: 'not found' })
  return true
}
