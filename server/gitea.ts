/**
 * Gitea issue source for `/api/issues` (T-WEB-017a).
 *
 * The acceptance UI must mirror the real backlog in
 * `http://192.168.3.14:3000/gitadmin/kex-labs-video/issues`, so issues are read
 * from (and written to) the Gitea API instead of scanning local `issue-N/` dirs.
 * The local scan stays available only when `WEB_ISSUES_SOURCE=files` is set
 * explicitly (see `api.ts`).
 *
 * Credentials come from the environment only and never leave this module:
 * `GITEA_TOKEN`, or `GITEA_USER` + `GITEA_PASS`. Error messages are sanitized
 * (no auth header, no URL-with-credentials, no upstream body).
 */
import { taskBodySummary } from './manual-verify'
import type { IssueFields } from './api'

export type GiteaLabel = { name: string; color: string }

export type GiteaIssueItem = {
  id: string
  number: number
  title: string
  description: string | null
  /** 指派对象（assignee），任务 owner 语义仍用它。 */
  owner: string | null
  /** #110 修复：详情「作者」= issue 创建者（`user.login`），不是 assignee。 */
  author: string | null
  rail: string | null
  priority: string | null
  status: 'open' | 'closed'
  created_at: string | null
  updated_at: string | null
  url: string
  labels: GiteaLabel[]
  comments: number
  dir: null
  source: 'gitea'
}

/** One issue comment, mapped to the browser contract (no raw Gitea payload). */
export type GiteaComment = {
  id: string
  author: string | null
  body: string
  created_at: string | null
  updated_at: string | null
  url: string
}

export type GiteaIssueState = 'open' | 'closed' | 'all'

export type GiteaCounts = { open: number; closed: number; total: number }

export type GiteaErrorReason = 'not configured' | 'auth failed' | 'unavailable' | 'upstream error'

export class GiteaError extends Error {
  readonly reason: GiteaErrorReason
  readonly status: number | null

  constructor(reason: GiteaErrorReason, status: number | null = null) {
    super(`gitea ${reason}`)
    this.name = 'GiteaError'
    this.reason = reason
    this.status = status
  }
}

type GiteaRawLabel = { name?: string; color?: string }
type GiteaRawUser = { login?: string } | null
type GiteaRawIssue = {
  number?: number
  title?: string
  body?: string | null
  state?: string
  html_url?: string
  comments?: number
  created_at?: string
  updated_at?: string
  labels?: GiteaRawLabel[]
  assignee?: GiteaRawUser
  user?: GiteaRawUser
}

type GiteaRawComment = {
  id?: number | string
  body?: string | null
  html_url?: string
  created_at?: string
  updated_at?: string
  user?: GiteaRawUser
}

const DEFAULT_URL = 'http://192.168.3.14:3000'
const DEFAULT_REPO = 'gitadmin/kex-labs-video'
const TIMEOUT_MS = 8_000
const CACHE_TTL_MS = 10_000

const RAIL_LABELS: readonly string[] = ['A轨', 'B轨', '双轨']
const PRIORITY_LABELS: readonly string[] = ['P0', 'P1', 'P2', 'P3']

const envValue = (key: string): string | null => {
  const raw = process.env[key]
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed ? trimmed : null
}

export function giteaConfig() {
  const url = (envValue('GITEA_URL') ?? DEFAULT_URL).replace(/\/+$/, '')
  const webUrl = (envValue('GITEA_WEB_URL') ?? url).replace(/\/+$/, '')
  const repo = envValue('GITEA_REPO') ?? DEFAULT_REPO
  const token = envValue('GITEA_TOKEN')
  const user = envValue('GITEA_USER')
  const pass = envValue('GITEA_PASS')
  return { url, webUrl, repo, token, user, pass }
}

/**
 * Rewrite a Gitea `html_url`/`web_url` origin to `GITEA_WEB_URL` while keeping
 * pathname + search + hash. Unset `GITEA_WEB_URL` (or an unparsable URL) leaves
 * the value untouched. API traffic keeps using `GITEA_URL`; this only affects
 * links the browser opens.
 */
export function publicUrl(value: string): string {
  const raw = value.trim()
  if (!raw) return raw
  const { webUrl } = giteaConfig()
  try {
    const parsed = new URL(raw)
    const base = new URL(webUrl)
    const prefix = base.pathname.replace(/\/+$/, '')
    return `${base.origin}${prefix}${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return raw
  }
}

/** True when a base URL + repo + one auth mode (token, or user+pass) are present. */
export function giteaConfigured(): boolean {
  const { url, repo, token, user, pass } = giteaConfig()
  return Boolean(url && repo && (token || (user && pass)))
}

/** Public, credential-free target info for API responses. */
export function giteaInfo() {
  const { webUrl, repo } = giteaConfig()
  return { repo, web_url: `${webUrl}/${repo}/issues` }
}

function authHeader(): string | null {
  const { token, user, pass } = giteaConfig()
  if (token) return `token ${token}`
  if (user && pass) {
    return `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`
  }
  return null
}

const cache = new Map<string, { at: number; items: GiteaIssueItem[]; total: number }>()

/** 10s read-only caches for the detail drawer (`/api/issues/:n`). */
const detailCache = new Map<number, { at: number; item: GiteaIssueItem }>()
const commentsCache = new Map<number, { at: number; comments: GiteaComment[] }>()

/** Task-issue snapshot (`listTaskIssues`), invalidated by every write. */
let taskCache: { at: number; tasks: TaskRecord[] } | null = null

/** Drop cached list pages (called after a successful create/update). */
export function invalidateGiteaCache(): void {
  cache.clear()
  detailCache.clear()
  commentsCache.clear()
  taskCache = null
}

function mapLabel(label: GiteaRawLabel): GiteaLabel {
  return { name: String(label.name ?? ''), color: String(label.color ?? '') }
}

function mapIssue(raw: GiteaRawIssue): GiteaIssueItem {
  const number = Number(raw.number)
  const labels = Array.isArray(raw.labels) ? raw.labels.map(mapLabel) : []
  const labelNames = labels.map((label) => label.name)
  const rail = RAIL_LABELS.find((name) => labelNames.includes(name)) ?? null
  const priority = PRIORITY_LABELS.find((name) => labelNames.includes(name)) ?? null
  const description = typeof raw.body === 'string' ? raw.body.trim() : ''
  return {
    id: String(number),
    number,
    title: String(raw.title ?? `#${number}`),
    description: description || null,
    owner: raw.assignee?.login ?? null,
    author: raw.user?.login ?? null,
    rail,
    priority,
    status: raw.state === 'closed' ? 'closed' : 'open',
    created_at: raw.created_at ?? null,
    updated_at: raw.updated_at ?? null,
    url: publicUrl(String(raw.html_url ?? '')),
    labels,
    comments: Number(raw.comments ?? 0),
    dir: null,
    source: 'gitea'
  }
}

/** Map a raw Gitea comment; unknown fields are dropped, body stays verbatim. */
function mapComment(raw: GiteaRawComment): GiteaComment {
  const id = raw.id === undefined || raw.id === null ? '' : String(raw.id)
  return {
    id,
    author: raw.user?.login ?? null,
    body: typeof raw.body === 'string' ? raw.body : '',
    created_at: raw.created_at ?? null,
    updated_at: raw.updated_at ?? null,
    url: publicUrl(String(raw.html_url ?? ''))
  }
}

async function requestJson(pathAndQuery: string, init: RequestInit = {}): Promise<{ data: unknown; total: number | null }> {
  if (!giteaConfigured()) throw new GiteaError('not configured')
  const auth = authHeader()
  const url = `${giteaConfig().url}${pathAndQuery}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(auth ? { Authorization: auth } : {}),
        ...(init.headers ?? {})
      }
    })
  } catch {
    // Network errors, DNS failures and timeouts (aborted) are all "unreachable".
    throw new GiteaError('unavailable')
  } finally {
    clearTimeout(timer)
  }
  if (response.status === 401 || response.status === 403) {
    throw new GiteaError('auth failed', response.status)
  }
  if (!response.ok) {
    throw new GiteaError('upstream error', response.status)
  }
  let data: unknown
  try {
    data = await response.json()
  } catch {
    throw new GiteaError('upstream error', response.status)
  }
  const rawTotal = response.headers.get('x-total-count')
  const total = rawTotal !== null && Number.isFinite(Number(rawTotal)) ? Number(rawTotal) : null
  return { data, total }
}

function issuesPath(state: GiteaIssueState, limit: number, page: number): string {
  const { repo } = giteaConfig()
  const params = new URLSearchParams({
    state,
    type: 'issues',
    sort: 'recentupdate',
    direction: 'desc',
    limit: String(limit),
    page: String(page)
  })
  return `/api/v1/repos/${repo}/issues?${params.toString()}`
}

export type GiteaListResult = {
  items: GiteaIssueItem[]
  total: number
}

/** List one page of issues (cached 10s per state/limit/page). */
export async function listIssues(options: {
  state?: GiteaIssueState
  limit?: number
  page?: number
}): Promise<GiteaListResult> {
  const state = options.state ?? 'open'
  const limit = options.limit ?? 50
  const page = options.page ?? 1
  const key = `${state}|${limit}|${page}`
  const cached = cache.get(key)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return { items: cached.items, total: cached.total }
  }
  const { data, total } = await requestJson(issuesPath(state, limit, page))
  if (!Array.isArray(data)) throw new GiteaError('upstream error')
  const items = data.map((raw) => mapIssue(raw as GiteaRawIssue))
  const resolvedTotal = total ?? items.length
  cache.set(key, { at: Date.now(), items, total: resolvedTotal })
  return { items, total: resolvedTotal }
}

/**
 * Every issue (open + closed), paged through the 10s list cache. Used by the
 * issue-list classification (`real` vs `source/acceptance` task cards) and the
 * read-only task-card audit. Gitea caps `limit` at 50.
 */
export async function listAllIssues(): Promise<GiteaIssueItem[]> {
  const out: GiteaIssueItem[] = []
  const seen = new Set<number>()
  const limit = 50
  for (let page = 1; page <= 20; page += 1) {
    const { items, total } = await listIssues({ state: 'all', limit, page })
    for (const item of items) {
      if (seen.has(item.number)) continue
      seen.add(item.number)
      out.push(item)
    }
    if (items.length < limit || page * limit >= total) break
  }
  return out
}

async function countIssues(state: 'open' | 'closed', fallbackTotal: number | null): Promise<number> {
  if (fallbackTotal !== null) return fallbackTotal
  try {
    const { items, total } = await listIssues({ state, limit: 1, page: 1 })
    return total || items.length
  } catch {
    return 0
  }
}

/**
 * Counts for the whole backlog. One `state=all` page is enough while the repo
 * fits in 50 issues; beyond that we fall back to per-state totals.
 */
export async function issueSummary(): Promise<GiteaCounts & { fetched_at: string }> {
  const { items, total } = await listIssues({ state: 'all', limit: 50, page: 1 })
  let counts: GiteaCounts
  if (items.length >= total) {
    const open = items.filter((item) => item.status === 'open').length
    const closed = items.filter((item) => item.status === 'closed').length
    counts = { open, closed, total: open + closed }
  } else {
    const open = await countIssues('open', null)
    const closed = await countIssues('closed', null)
    counts = { open, closed, total: open + closed }
  }
  return { ...counts, fetched_at: new Date().toISOString() }
}

function buildBody(fields: IssueFields): string {
  const lines: string[] = []
  if (fields.owner) lines.push(`- 负责人：${fields.owner}`)
  if (fields.rail) lines.push(`- 轨道：${fields.rail}`)
  if (fields.priority) lines.push(`- 优先级：${fields.priority}`)
  const meta = lines.length ? `\n\n---\n${lines.join('\n')}` : ''
  return `${fields.description ?? ''}${meta}`
}

/** Create an issue in Gitea and return it mapped to the API contract. */
export async function createIssue(fields: IssueFields): Promise<GiteaIssueItem> {
  if (!giteaConfigured()) throw new GiteaError('not configured')
  const { repo } = giteaConfig()
  const { data } = await requestJson(`/api/v1/repos/${repo}/issues`, {
    method: 'POST',
    body: JSON.stringify({ title: fields.title, body: buildBody(fields) })
  })
  invalidateGiteaCache()
  if (!data || typeof data !== 'object') throw new GiteaError('upstream error')
  return mapIssue(data as GiteaRawIssue)
}

// ---------------------------------------------------------------------------
// Issue detail + comments (#110)
//
// Read paths cache for 10s like the issue list; a successful comment write
// invalidates every cache so the next read sees the new comment/count. Errors
// stay sanitized by `requestJson` (no token, no upstream body).
// ---------------------------------------------------------------------------

/** One issue, mapped for the detail drawer. Cached 10s. */
export async function issueDetail(number: number): Promise<GiteaIssueItem> {
  if (!giteaConfigured()) throw new GiteaError('not configured')
  const cached = detailCache.get(number)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.item
  const { repo } = giteaConfig()
  const { data } = await requestJson(`/api/v1/repos/${repo}/issues/${number}`)
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new GiteaError('upstream error')
  }
  const item = mapIssue(data as GiteaRawIssue)
  detailCache.set(number, { at: Date.now(), item })
  return item
}

function byCreatedAt(a: GiteaComment, b: GiteaComment): number {
  const at = a.created_at ? Date.parse(a.created_at) : 0
  const bt = b.created_at ? Date.parse(b.created_at) : 0
  if (at !== bt) return at - bt
  return a.id.localeCompare(b.id, undefined, { numeric: true })
}

/** Every comment on one issue, oldest first. Cached 10s. */
export async function issueComments(number: number): Promise<GiteaComment[]> {
  if (!giteaConfigured()) throw new GiteaError('not configured')
  const cached = commentsCache.get(number)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.comments
  const { repo } = giteaConfig()
  const limit = 50
  const out: GiteaComment[] = []
  for (let page = 1; page <= 20; page += 1) {
    const { data } = await requestJson(
      `/api/v1/repos/${repo}/issues/${number}/comments?limit=${limit}&page=${page}`
    )
    if (!Array.isArray(data)) throw new GiteaError('upstream error')
    out.push(...data.map((raw) => mapComment(raw as GiteaRawComment)))
    if (data.length < limit) break
  }
  const comments = out.sort(byCreatedAt)
  commentsCache.set(number, { at: Date.now(), comments })
  return comments
}

/** Post one comment; the route validates the body (1..8000) before calling. */
export async function addIssueComment(number: number, body: string): Promise<GiteaComment> {
  if (!giteaConfigured()) throw new GiteaError('not configured')
  const { repo } = giteaConfig()
  const { data } = await requestJson(`/api/v1/repos/${repo}/issues/${number}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body })
  })
  invalidateGiteaCache()
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new GiteaError('upstream error')
  }
  return mapComment(data as GiteaRawComment)
}

// ---------------------------------------------------------------------------
// Task issues (T-WEB-017d)
//
// The orchestrator's 34 local tasks live in Gitea as issues identified by a
// first-line HTML comment `<!-- acceptance:task {json} -->` (single-line JSON)
// or a `[<id>]` title prefix. `source/acceptance`, `status/*` and `rail/*`
// labels carry the semantics; reconcile only ever creates, never deletes or
// overwrites, so it is safe to re-run.
// ---------------------------------------------------------------------------

const TASK_ID_RE = /^T-[A-Z]+-\d+[a-z]?$/
const TASK_TITLE_RE = /^\[(T-[A-Z]+-\d+[a-z]?)\]\s*(.*)$/
const TASK_META_RE = /^<!--\s*acceptance:task\s+(\{.*\})\s*-->$/

const TASK_STATUSES = ['done', 'running', 'pending', 'blocked'] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

/** Label catalogue. Colors follow the documented status palette (README). */
export const TASK_LABELS: readonly GiteaLabel[] = [
  { name: 'source/acceptance', color: '#8E8E93' },
  { name: 'status/pending', color: '#8E8E93' },
  { name: 'status/running', color: '#0071E3' },
  { name: 'status/blocked', color: '#C77700' },
  { name: 'status/done', color: '#30A14E' },
  { name: 'rail/A', color: '#0071E3' },
  { name: 'rail/B', color: '#5E5CE6' },
  { name: 'rail/双轨', color: '#8E8E93' }
]
const TASK_LABEL_NAMES = new Set(TASK_LABELS.map((label) => label.name))
const TASK_ISSUE_NOTE = '> 由 acceptance 看板自动维护（T-WEB-017d）：请勿手改首行 meta。'

export type TaskMeta = {
  id: string
  owner: string | null
  rail: string | null
  status: TaskStatus | null
  start: string | null
  end: string | null
  progress: number | null
  depends_on: string[]
  blocked_by: string | null
  evidence: string | null
  estimated: boolean | null
}

export type TaskRecord = {
  id: string
  number: number
  title: string
  body: string
  html_url: string
  labels: GiteaLabel[]
  meta: TaskMeta
}

/** Plan task as consumed by the UI (`PlanTask` in `src/types.ts`). */
export type TaskItem = {
  id: string
  title: string
  owner: string
  rail: string
  status: TaskStatus
  start: string
  end: string
  progress: number
  depends_on: string[]
  blocked_by?: string
  evidence?: string
  estimated?: boolean
  /** Gitea issue that carries this task (issue #77 traceability). */
  issue_number?: number
  issue_url?: string
  /** What changed, read from the task issue body; null → UI shows 未提供说明. */
  issue_summary?: string | null
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** Coerce a meta object (or a `tasks.json` task) into validated task meta. */
function metaFromValue(raw: unknown, fallbackId: string | null): TaskMeta | null {
  if (!raw || typeof raw !== 'object') return null
  const src = raw as Record<string, unknown>
  const id = text(src.id) ?? fallbackId
  if (!id || !TASK_ID_RE.test(id)) return null
  const statusText = text(src.status)
  const status = statusText && (TASK_STATUSES as readonly string[]).includes(statusText)
    ? (statusText as TaskStatus)
    : null
  const progress =
    typeof src.progress === 'number' &&
    Number.isInteger(src.progress) &&
    src.progress >= 0 &&
    src.progress <= 100
      ? src.progress
      : null
  const depends = Array.isArray(src.depends_on)
    ? src.depends_on.filter((value): value is string => typeof value === 'string')
    : []
  return {
    id,
    owner: text(src.owner),
    rail: text(src.rail),
    status,
    start: text(src.start),
    end: text(src.end),
    progress,
    depends_on: depends,
    blocked_by: text(src.blocked_by),
    evidence: text(src.evidence),
    estimated: typeof src.estimated === 'boolean' ? src.estimated : null
  }
}

/** Parse one Gitea issue; returns null when it is not an acceptance task. */
export function parseTaskIssue(item: GiteaIssueItem): TaskRecord | null {
  const body = item.description ?? ''
  const firstLine = (body.split('\n', 1)[0] ?? '').trim()
  const titleMatch = TASK_TITLE_RE.exec(item.title)
  const commentMatch = TASK_META_RE.exec(firstLine)
  let meta: TaskMeta | null = null
  if (commentMatch) meta = metaFromValue(safeJson(commentMatch[1]), titleMatch?.[1] ?? null)
  if (!meta && titleMatch) meta = metaFromValue({}, titleMatch[1])
  if (!meta) return null
  return {
    id: meta.id,
    number: item.number,
    title: (titleMatch?.[2] ?? item.title).trim() || meta.id,
    body,
    html_url: item.url,
    labels: item.labels,
    meta
  }
}

/** Serialize task meta back to the canonical first line. */
function metaLine(meta: TaskMeta): string {
  const payload: Record<string, unknown> = { id: meta.id }
  if (meta.owner) payload.owner = meta.owner
  if (meta.rail) payload.rail = meta.rail
  if (meta.status) payload.status = meta.status
  if (meta.start) payload.start = meta.start
  if (meta.end) payload.end = meta.end
  if (meta.progress !== null) payload.progress = meta.progress
  payload.depends_on = meta.depends_on
  if (meta.blocked_by) payload.blocked_by = meta.blocked_by
  if (meta.evidence) payload.evidence = meta.evidence
  if (meta.estimated !== null) payload.estimated = meta.estimated
  return `<!-- acceptance:task ${JSON.stringify(payload)} -->`
}

function railLabelName(rail: string | null): string {
  if (rail === 'A') return 'rail/A'
  if (rail === 'B') return 'rail/B'
  return 'rail/双轨'
}

/** Task record → the plan shape the UI already understands. */
export function taskItem(record: TaskRecord): TaskItem {
  const meta = record.meta
  const item: TaskItem = {
    id: meta.id,
    title: record.title,
    owner: meta.owner ?? '',
    rail: meta.rail ?? 'both',
    status: meta.status ?? 'pending',
    start: meta.start ?? '',
    end: meta.end ?? '',
    progress: meta.progress ?? 0,
    depends_on: meta.depends_on
  }
  if (meta.blocked_by) item.blocked_by = meta.blocked_by
  if (meta.evidence) item.evidence = meta.evidence
  if (meta.estimated !== null) item.estimated = meta.estimated
  item.issue_number = record.number
  item.issue_url = record.html_url
  item.issue_summary = taskBodySummary(record.body)
  return item
}

/** Status group (done → running → pending → blocked), then end asc, then id. */
export function sortTaskItems(tasks: TaskItem[]): TaskItem[] {
  const rank = (status: TaskStatus) => TASK_STATUSES.indexOf(status)
  return tasks.slice().sort((a, b) => {
    const byStatus = rank(a.status) - rank(b.status)
    if (byStatus !== 0) return byStatus
    const aEnd = Date.parse(a.end)
    const bEnd = Date.parse(b.end)
    const aHas = Number.isFinite(aEnd)
    const bHas = Number.isFinite(bEnd)
    if (aHas !== bHas) return aHas ? -1 : 1
    if (aHas && bHas && aEnd !== bEnd) return aEnd - bEnd
    return a.id.localeCompare(b.id)
  })
}

/** Every task issue (all states), one entry per task id, newest copy wins. */
export async function listTaskIssues(): Promise<{ tasks: TaskRecord[] }> {
  const now = Date.now()
  if (taskCache && now - taskCache.at < CACHE_TTL_MS) return { tasks: taskCache.tasks }
  const seen = new Map<string, TaskRecord>()
  const limit = 50
  for (let page = 1; page <= 40; page += 1) {
    const { items, total } = await listIssues({ state: 'all', limit, page })
    for (const item of items) {
      const record = parseTaskIssue(item)
      if (record && !seen.has(record.id)) seen.set(record.id, record)
    }
    if (items.length < limit || page * limit >= total) break
  }
  const tasks = [...seen.values()]
  taskCache = { at: now, tasks }
  return { tasks }
}

async function repoLabelMap(): Promise<Map<string, number>> {
  const { repo } = giteaConfig()
  const map = new Map<string, number>()
  for (let page = 1; page <= 10; page += 1) {
    const { data } = await requestJson(`/api/v1/repos/${repo}/labels?limit=50&page=${page}`)
    if (!Array.isArray(data)) break
    for (const raw of data as { id?: number; name?: string }[]) {
      const name = String(raw?.name ?? '')
      if (name) map.set(name, Number(raw?.id))
    }
    if (data.length < 50) break
  }
  return map
}

/** Create the task labels that are missing and return `name → label id`. */
export async function ensureTaskLabels(): Promise<Map<string, number>> {
  if (!giteaConfigured()) throw new GiteaError('not configured')
  const { repo } = giteaConfig()
  let map = await repoLabelMap()
  for (const label of TASK_LABELS) {
    if (map.has(label.name)) continue
    try {
      await requestJson(`/api/v1/repos/${repo}/labels`, {
        method: 'POST',
        body: JSON.stringify({ name: label.name, color: label.color })
      })
    } catch (err) {
      // Already created concurrently (409/422) — the re-read below picks it up.
      if (!(err instanceof GiteaError)) throw err
    }
  }
  map = await repoLabelMap()
  return map
}

/** Managed labels for the current state + any unrelated labels already on it. */
function taskLabelIds(labels: Map<string, number>, meta: TaskMeta, existing: GiteaLabel[] = []): number[] {
  const ids = new Set<number>()
  const wanted = ['source/acceptance', `status/${meta.status ?? 'pending'}`, railLabelName(meta.rail)]
  for (const name of wanted) {
    const id = labels.get(name)
    if (typeof id === 'number' && Number.isFinite(id)) ids.add(id)
  }
  for (const label of existing) {
    if (TASK_LABEL_NAMES.has(label.name)) continue
    const id = labels.get(label.name)
    if (typeof id === 'number' && Number.isFinite(id)) ids.add(id)
  }
  return [...ids]
}

async function setIssueState(number: number, state: 'open' | 'closed'): Promise<void> {
  const { repo } = giteaConfig()
  await requestJson(`/api/v1/repos/${repo}/issues/${number}`, {
    method: 'PATCH',
    body: JSON.stringify({ state })
  })
  invalidateGiteaCache()
}

/** Create one task issue from a `tasks.json` task; returns its number. */
export async function createTaskIssue(task: unknown, labels: Map<string, number>): Promise<number> {
  if (!giteaConfigured()) throw new GiteaError('not configured')
  const { repo } = giteaConfig()
  const source = (task ?? {}) as Record<string, unknown>
  const meta = metaFromValue(source, text(source.id))
  if (!meta) throw new GiteaError('upstream error')
  const title = `[${meta.id}] ${text(source.title) ?? ''}`.trim()
  // issue #77: keep a short "what changed" note in the issue body so later
  // video-test reviews can read it without the local task file.
  const description = text(source.description) ?? text(source.summary) ?? text(source.change)
  const body = [metaLine(meta), TASK_ISSUE_NOTE, description].filter(Boolean).join('\n\n')
  const { data } = await requestJson(`/api/v1/repos/${repo}/issues`, {
    method: 'POST',
    body: JSON.stringify({ title, body, labels: taskLabelIds(labels, meta) })
  })
  if (!data || typeof data !== 'object') throw new GiteaError('upstream error')
  const number = Number((data as GiteaRawIssue).number)
  invalidateGiteaCache()
  if (meta.status === 'done' && Number.isFinite(number)) await setIssueState(number, 'closed')
  return number
}

export type TaskPatch = {
  status?: TaskStatus
  progress?: number
  owner?: string
  end_ts?: string
}

/** Merge a PATCH into the issue's meta line, labels and open/closed state. */
export async function updateTaskIssue(record: TaskRecord, patch: TaskPatch): Promise<TaskItem> {
  if (!giteaConfigured()) throw new GiteaError('not configured')
  const { repo } = giteaConfig()
  const merged: TaskMeta = { ...record.meta }
  if (patch.status !== undefined) merged.status = patch.status
  if (patch.progress !== undefined) merged.progress = patch.progress
  if (patch.owner !== undefined) merged.owner = patch.owner
  if (patch.end_ts !== undefined) merged.end = patch.end_ts
  const rest = record.body.split('\n').slice(1).join('\n').replace(/^\n+/, '')
  const body = `${metaLine(merged)}${rest ? `\n\n${rest}` : ''}`
  const labels = await repoLabelMap()
  const labelIds = taskLabelIds(labels, merged, record.labels)
  const { data } = await requestJson(`/api/v1/repos/${repo}/issues/${record.number}`, {
    method: 'PATCH',
    body: JSON.stringify({ body, state: merged.status === 'done' ? 'closed' : 'open' })
  })
  if (labelIds.length) {
    await requestJson(`/api/v1/repos/${repo}/issues/${record.number}/labels`, {
      method: 'PUT',
      body: JSON.stringify({ labels: labelIds })
    })
  }
  invalidateGiteaCache()
  if (!data || typeof data !== 'object') throw new GiteaError('upstream error')
  return taskItem({ ...record, meta: merged, body })
}

export type ReconcileResult = {
  dryRun: boolean
  total: number
  missing: number
  created: number
  skipped: number
  ids: string[]
}

/**
 * Create the task issues that do not exist yet (idempotent, create-only).
 * `dryRun` reports what would be created without writing anything.
 */
export async function reconcileTaskIssues(
  tasks: { id?: unknown }[],
  options: { dryRun?: boolean } = {}
): Promise<ReconcileResult> {
  const { tasks: existing } = await listTaskIssues()
  const known = new Set(existing.map((record) => record.id))
  const missing = tasks.filter((task) => typeof task?.id === 'string' && !known.has(task.id))
  const result: ReconcileResult = {
    dryRun: Boolean(options.dryRun),
    total: tasks.length,
    missing: missing.length,
    created: 0,
    skipped: tasks.length - missing.length,
    ids: missing.map((task) => String(task.id))
  }
  if (result.dryRun || missing.length === 0) return result
  const labels = await ensureTaskLabels()
  for (const task of missing) {
    await createTaskIssue(task, labels)
    result.created += 1
  }
  invalidateGiteaCache()
  return result
}
