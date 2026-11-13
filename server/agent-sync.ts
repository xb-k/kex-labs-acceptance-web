/**
 * #133 Agent / Skill library: autonomous discovery + import from GitHub.
 *
 * The library is a **read-only catalogue**: this module searches GitHub for
 * repos that look like agent/skill/prompt collections, mirrors a bounded set of
 * text files under `<WEB_DATA_ROOT>/agent-library/`, and records provenance in
 * `manifest.json`. Nothing is executed, and importing never enables an agent.
 *
 * Hard rules:
 *  - source repo: stars >= 1000 (official orgs may be >= 300, marked `verified`);
 *  - last push <= 365 days ago;
 *  - license must be in { MIT, Apache-2.0, BSD, CC0, CC-BY };
 *  - only `.md/.json/.yaml/.yml`, <= 256 KiB per file, <= 50 files per run;
 *  - suspicious instructions are flagged in `warnings` (never silently blocked);
 *  - every write stays inside `<WEB_DATA_ROOT>/agent-library/` (path traversal
 *    is rejected before a single byte is written).
 *
 * `startAgentSync` serialises runs per dataRoot: a second concurrent start is
 * rejected, so two HTTP requests cannot interleave manifest writes.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

export const SYNC_QUERIES = [
  'claude skills',
  'agent skills',
  'ai agents prompt',
  'storyboard prompt',
  'prompt library',
  'video generation workflow'
] as const

export const MIN_STARS = 1000
export const OFFICIAL_MIN_STARS = 300
export const TIER_A_STARS = 2000
export const MAX_REPO_AGE_DAYS = 365
export const MAX_FILE_BYTES = 256 * 1024
export const MAX_FILES_PER_RUN = 50
const SEARCH_PER_PAGE = 20
const FETCH_TIMEOUT_MS = 15_000
const MAX_ERRORS = 100
const MAX_LIBRARY_LIMIT = 200

const ALLOWED_EXT = new Set(['.md', '.json', '.yaml', '.yml'])
const IGNORED_SEGMENTS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  'vendor',
  '.next',
  '.cache'
])
const OFFICIAL_OWNERS = new Set([
  'anthropics',
  'openai',
  'google',
  'google-deepmind',
  'google-research',
  'microsoft',
  'facebookresearch',
  'huggingface',
  'langchain-ai',
  'modelcontextprotocol',
  'vercel',
  'github'
])
const LICENSE_RE = /^(MIT|Apache-2\.0|BSD-[23]-Clause|BSD|CC0-1\.0|CC-BY(-[0-9.]+)?)$/i
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

/** Patterns that make an imported document worth a human look. Matched, not executed. */
const WARNING_PATTERNS: Array<{ code: string; re: RegExp }> = [
  { code: 'prompt_injection_ignore_previous', re: /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i },
  { code: 'prompt_injection_disregard', re: /disregard\s+(all\s+)?(previous|prior|above|earlier)/i },
  { code: 'prompt_injection_role_override', re: /you\s+are\s+now\s+(the\s+)?(system|developer|root|admin)/i },
  { code: 'shell_execution', re: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:ba)?sh\b/i },
  { code: 'destructive_command', re: /\brm\s+-rf\s+[/~]/i },
  { code: 'credential_exfiltration', re: /\bsend\b[^\n]{0,80}\b(?:token|secret|api[_-]?key|password|credential)s?\b[^\n]{0,40}\bhttps?:\/\//i },
  { code: 'encoded_payload', re: /\bbase64\s+(?:-d|--decode)\b/i }
]

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export interface LibraryEntry {
  repo: string
  path: string
  url: string
  stars: number
  license: string
  sha: string
  fetched_at: string
  score: number
  warnings: string[]
  tier: 'A' | 'B'
  verified: boolean
}

export interface SyncCounts {
  queries: number
  repos_seen: number
  repos_selected: number
  files_seen: number
  files_imported: number
  files_skipped: number
  files_rejected: number
  duplicates: number
  warnings: number
}

export interface SyncError {
  at: string
  stage: 'search' | 'tree' | 'download'
  query?: string
  repo?: string
  error: string
}

export interface SyncStatus {
  last_run: string | null
  running: boolean
  started_at: string | null
  finished_at: string | null
  counts: SyncCounts
  errors: SyncError[]
  queries: string[]
  auth: 'token' | 'anonymous'
}

export interface SyncManifest {
  version: 1
  generated_at: string | null
  entries: LibraryEntry[]
}

export interface AgentSyncDeps {
  dataRoot: string
  fetchImpl?: FetchLike
  env?: NodeJS.ProcessEnv
  now?: () => Date
  log?: (message: string) => void
}

export interface AgentLibraryRouteContext {
  dataRoot: string
  authorize: (req: IncomingMessage) => { ok: true } | { ok: false; status: number; error: string }
  sendJson: (res: ServerResponse, status: number, body: unknown) => void
  env?: NodeJS.ProcessEnv
  fetchImpl?: FetchLike
  now?: () => Date
}

interface GithubRepo {
  full_name: string
  html_url?: string
  description?: string | null
  topics?: string[]
  stargazers_count: number
  pushed_at: string | null
  license?: { spdx_id?: string | null } | null
}

interface TreeEntry {
  path: string
  type?: string
  size?: number
}

interface ClassifiedRepo {
  repo: string
  stars: number
  license: string
  verified: boolean
  tier: 'A' | 'B'
  score: number
  pushed_at: string
}

/** In-process lock keyed by resolved dataRoot. One run at a time, per process. */
const runningByRoot = new Map<string, Promise<SyncStatus>>()

function emptyCounts(): SyncCounts {
  return {
    queries: 0,
    repos_seen: 0,
    repos_selected: 0,
    files_seen: 0,
    files_imported: 0,
    files_skipped: 0,
    files_rejected: 0,
    duplicates: 0,
    warnings: 0
  }
}

export function libraryRoot(dataRoot: string): string {
  return path.join(path.resolve(dataRoot), 'agent-library')
}

function manifestFile(dataRoot: string): string {
  return path.join(libraryRoot(dataRoot), 'manifest.json')
}

function statusFile(dataRoot: string): string {
  return path.join(libraryRoot(dataRoot), 'status.json')
}

function atomicWriteJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, file)
}

function sha256(input: Buffer | string): string {
  return crypto.createHash('sha256').update(input).digest('hex')
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isLibraryEntry(value: unknown): value is LibraryEntry {
  if (!isRecord(value)) return false
  return (
    typeof value.repo === 'string' &&
    typeof value.path === 'string' &&
    typeof value.sha === 'string' &&
    typeof value.stars === 'number' &&
    Array.isArray(value.warnings)
  )
}

function emptyStatus(): SyncStatus {
  return {
    last_run: null,
    running: false,
    started_at: null,
    finished_at: null,
    counts: emptyCounts(),
    errors: [],
    queries: [...SYNC_QUERIES],
    auth: 'anonymous'
  }
}

function readStatusFile(dataRoot: string): SyncStatus {
  try {
    const raw = JSON.parse(fs.readFileSync(statusFile(dataRoot), 'utf8'))
    if (!isRecord(raw)) return emptyStatus()
    return {
      last_run: typeof raw.last_run === 'string' ? raw.last_run : null,
      running: raw.running === true,
      started_at: typeof raw.started_at === 'string' ? raw.started_at : null,
      finished_at: typeof raw.finished_at === 'string' ? raw.finished_at : null,
      counts: { ...emptyCounts(), ...(isRecord(raw.counts) ? (raw.counts as Partial<SyncCounts>) : {}) },
      errors: Array.isArray(raw.errors) ? (raw.errors as SyncError[]) : [],
      queries: Array.isArray(raw.queries) ? (raw.queries as string[]) : [...SYNC_QUERIES],
      auth: raw.auth === 'token' ? 'token' : 'anonymous'
    }
  } catch {
    return emptyStatus()
  }
}

function readManifestFile(dataRoot: string): SyncManifest {
  try {
    const raw = JSON.parse(fs.readFileSync(manifestFile(dataRoot), 'utf8'))
    if (!isRecord(raw) || !Array.isArray(raw.entries)) {
      return { version: 1, generated_at: null, entries: [] }
    }
    return {
      version: 1,
      generated_at: typeof raw.generated_at === 'string' ? raw.generated_at : null,
      entries: raw.entries.filter(isLibraryEntry)
    }
  } catch {
    return { version: 1, generated_at: null, entries: [] }
  }
}

/** `GET /api/agents/sync` — status file, with a stale `running` flag neutralised. */
export function readAgentSyncStatus(dataRoot: string): SyncStatus {
  const status = readStatusFile(dataRoot)
  return { ...status, running: isAgentSyncRunning(dataRoot) }
}

export function isAgentSyncRunning(dataRoot: string): boolean {
  return runningByRoot.has(path.resolve(dataRoot))
}

export interface AgentLibraryPage {
  total: number
  limit: number
  offset: number
  generated_at: string | null
  items: LibraryEntry[]
}

/** `GET /api/agents/library` — score-sorted manifest, paginated. */
export function readAgentLibrary(
  dataRoot: string,
  opts: { limit?: number; offset?: number } = {}
): AgentLibraryPage {
  const manifest = readManifestFile(dataRoot)
  const limit = clampInt(opts.limit, 50, 1, MAX_LIBRARY_LIMIT)
  const offset = clampInt(opts.offset, 0, 0, Number.MAX_SAFE_INTEGER)
  const sorted = [...manifest.entries].sort(
    (a, b) =>
      b.score - a.score ||
      a.repo.localeCompare(b.repo) ||
      a.path.localeCompare(b.path)
  )
  return {
    total: sorted.length,
    limit,
    offset,
    generated_at: manifest.generated_at,
    items: sorted.slice(offset, offset + limit)
  }
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

// ---------------------------------------------------------------------------
// Filtering / scoring / scanning
// ---------------------------------------------------------------------------

function ownerOf(repo: string): string {
  return repo.split('/')[0]?.toLowerCase() ?? ''
}

export function isOfficialOwner(repo: string): boolean {
  return OFFICIAL_OWNERS.has(ownerOf(repo))
}

function licenseOf(repo: GithubRepo): string | null {
  const spdx = repo.license?.spdx_id
  if (typeof spdx !== 'string' || !spdx || spdx === 'NOASSERTION') return null
  return LICENSE_RE.test(spdx) ? spdx : null
}

function pushedDaysAgo(pushedAt: string | null, now: Date): number | null {
  if (!pushedAt) return null
  const pushed = Date.parse(pushedAt)
  if (Number.isNaN(pushed)) return null
  return (now.getTime() - pushed) / 86_400_000
}

function relevance(repo: GithubRepo, query: string): number {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return 0
  const haystack = [repo.full_name, repo.description ?? '', ...(repo.topics ?? [])]
    .join(' ')
    .toLowerCase()
  const hit = tokens.filter((token) => haystack.includes(token)).length
  return hit / tokens.length
}

/**
 * A repo is selected only when stars / license / age all pass. Official orgs
 * get a lower star bar but are marked `verified` and still need a licence.
 * Returns the deterministic score used to rank the manifest.
 */
export function classifyRepo(
  repo: GithubRepo,
  now: Date,
  query: string
): { ok: true; value: ClassifiedRepo } | { ok: false; reason: string } {
  if (!REPO_RE.test(repo.full_name ?? '')) return { ok: false, reason: 'invalid_repo_name' }
  const stars = Number(repo.stargazers_count)
  if (!Number.isFinite(stars)) return { ok: false, reason: 'invalid_stars' }
  const verified = isOfficialOwner(repo.full_name)
  const minStars = verified ? OFFICIAL_MIN_STARS : MIN_STARS
  if (stars < minStars) return { ok: false, reason: 'stars_below_threshold' }

  const license = licenseOf(repo)
  if (!license) return { ok: false, reason: 'license_not_allowed' }

  const age = pushedDaysAgo(repo.pushed_at, now)
  if (age === null) return { ok: false, reason: 'invalid_pushed_at' }
  if (age > MAX_REPO_AGE_DAYS) return { ok: false, reason: 'stale' }

  const relat = relevance(repo, query)
  const starScore = Math.min(40, 10 * Math.log10(Math.max(stars, 1)))
  const recencyScore = Math.max(0, 20 * (1 - age / MAX_REPO_AGE_DAYS))
  const score = Number(
    (starScore + relat * 30 + recencyScore + (verified ? 10 : 0)).toFixed(2)
  )
  return {
    ok: true,
    value: {
      repo: repo.full_name,
      stars,
      license,
      verified,
      tier: stars >= TIER_A_STARS ? 'A' : 'B',
      score,
      pushed_at: repo.pushed_at as string
    }
  }
}

/** Suspicious-instruction scan. Matching documents are imported, not blocked. */
export function scanWarnings(text: string): string[] {
  const warnings: string[] = []
  for (const pattern of WARNING_PATTERNS) {
    if (pattern.re.test(text)) warnings.push(pattern.code)
  }
  return warnings
}

/** File-path gate: extension, ignored directories and traversal attempts. */
export function isAllowedPath(filePath: string): boolean {
  if (typeof filePath !== 'string' || filePath.length === 0) return false
  if (filePath.includes('\0') || filePath.includes('\\')) return false
  if (filePath.startsWith('/') || /^[A-Za-z]:/.test(filePath)) return false
  const segments = filePath.split('/')
  if (segments.some((segment) => segment === '..' || segment === '.' || segment === '')) return false
  if (segments.some((segment) => IGNORED_SEGMENTS.has(segment.toLowerCase()))) return false
  return ALLOWED_EXT.has(path.posix.extname(filePath).toLowerCase())
}

function rawUrl(repo: string, filePath: string): string {
  const encoded = filePath.split('/').map(encodeURIComponent).join('/')
  return `https://raw.githubusercontent.com/${repo}/HEAD/${encoded}`
}

function treeUrl(repo: string): string {
  return `https://api.github.com/repos/${repo}/git/trees/HEAD?recursive=1`
}

function searchUrl(query: string): string {
  return `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${SEARCH_PER_PAGE}`
}

function githubHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'kex-acceptance-web-agent-sync',
    'X-GitHub-Api-Version': '2022-11-28'
  }
  const token = env.GITHUB_TOKEN?.trim()
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

type JsonResult =
  | { ok: true; data: any }
  | { ok: false; code: string; status: number }

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}

async function requestJson(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>
): Promise<JsonResult> {
  let res: Response
  try {
    res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  } catch {
    return { ok: false, code: 'network_error', status: 0 }
  }
  if (!res.ok) {
    const remaining = res.headers.get('x-ratelimit-remaining')
    let code = `http_${res.status}`
    if (res.status === 401) {
      code = 'unauthorized'
    } else if (res.status === 429) {
      code = 'rate_limit'
    } else if (res.status === 403) {
      code = 'forbidden'
      if (remaining === '0' || /rate limit/i.test(await safeText(res))) code = 'rate_limit'
    }
    return { ok: false, code, status: res.status }
  }
  try {
    return { ok: true, data: await res.json() }
  } catch {
    return { ok: false, code: 'invalid_json', status: res.status }
  }
}

function isFatalGithubError(code: string): boolean {
  return code === 'rate_limit' || code === 'unauthorized'
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export function startAgentSync(deps: AgentSyncDeps): { started: boolean; done: Promise<SyncStatus> } {
  const key = path.resolve(deps.dataRoot)
  const inFlight = runningByRoot.get(key)
  if (inFlight) return { started: false, done: inFlight }
  const done = runAgentSync(deps)
    .catch((err: unknown) => {
      console.error('[agent-sync] run failed:', err instanceof Error ? err.message : String(err))
      return readAgentSyncStatus(key)
    })
    .finally(() => {
      runningByRoot.delete(key)
    })
  runningByRoot.set(key, done)
  return { started: true, done }
}

/** Await the active run (tests / graceful shutdown); undefined when idle. */
export function agentSyncInFlight(dataRoot: string): Promise<SyncStatus> | undefined {
  return runningByRoot.get(path.resolve(dataRoot))
}

async function runAgentSync(deps: AgentSyncDeps): Promise<SyncStatus> {
  const dataRoot = path.resolve(deps.dataRoot)
  const fetchImpl = deps.fetchImpl ?? ((url, init) => fetch(url, init))
  const env = deps.env ?? process.env
  const now = deps.now ?? (() => new Date())
  const root = libraryRoot(dataRoot)
  fs.mkdirSync(root, { recursive: true })

  const previous = readManifestFile(dataRoot)
  const counts = emptyCounts()
  const errors: SyncError[] = []
  const auth: SyncStatus['auth'] = env.GITHUB_TOKEN?.trim() ? 'token' : 'anonymous'
  const startedAt = now().toISOString()
  const headers = githubHeaders(env)

  const pushError = (stage: SyncError['stage'], error: string, extra: Partial<SyncError> = {}) => {
    if (errors.length < MAX_ERRORS) {
      errors.push({ at: now().toISOString(), stage, error, ...extra })
    }
  }

  const baseStatus: SyncStatus = {
    last_run: startedAt,
    running: true,
    started_at: startedAt,
    finished_at: null,
    counts,
    errors,
    queries: [...SYNC_QUERIES],
    auth
  }
  atomicWriteJson(statusFile(dataRoot), baseStatus)

  let rateLimited = false

  try {
    // 1. Search each query, dedupe repos across queries, classify.
    const found = new Map<string, { repo: GithubRepo; query: string }>()
    for (const query of SYNC_QUERIES) {
      if (rateLimited) break
      counts.queries++
      const result = await requestJson(fetchImpl, searchUrl(query), headers)
      if (!result.ok) {
        pushError('search', result.code, { query })
        if (isFatalGithubError(result.code)) rateLimited = true
        continue
      }
      const items = Array.isArray(result.data?.items) ? (result.data.items as GithubRepo[]) : []
      for (const item of items) {
        if (!isRecord(item) || typeof item.full_name !== 'string') continue
        if (!found.has(item.full_name)) found.set(item.full_name, { repo: item, query })
      }
    }
    counts.repos_seen = found.size

    const selected: Array<ClassifiedRepo & { query: string }> = []
    for (const { repo, query } of found.values()) {
      // The repo may match several queries; the first hit supplies the keywords.
      const verdict = classifyRepo(repo, now(), query)
      if (verdict.ok) {
        selected.push({ ...verdict.value, query })
      }
    }
    counts.repos_selected = selected.length
    selected.sort((a, b) => b.score - a.score || a.repo.localeCompare(b.repo))

    // 2. Mirror files, dedupe by sha256 against the previous manifest and
    // within this run, cap at MAX_FILES_PER_RUN.
    const imported: LibraryEntry[] = []
    const seenShas = new Set(previous.entries.map((entry) => entry.sha))
    const repoRoot = path.resolve(root, 'repos')

    for (const selectedRepo of selected) {
      if (rateLimited || counts.files_imported >= MAX_FILES_PER_RUN) break

      const tree = await requestJson(fetchImpl, treeUrl(selectedRepo.repo), headers)
      if (!tree.ok) {
        pushError('tree', tree.code, { repo: selectedRepo.repo })
        if (isFatalGithubError(tree.code)) rateLimited = true
        continue
      }
      const blobs = Array.isArray(tree.data?.tree) ? (tree.data.tree as TreeEntry[]) : []
      const picked: TreeEntry[] = []
      for (const blob of blobs) {
        counts.files_seen++
        if (!isRecord(blob) || typeof blob.path !== 'string') {
          counts.files_rejected++
          continue
        }
        if (blob.type !== undefined && blob.type !== 'blob') {
          counts.files_rejected++
          continue
        }
        if (!isAllowedPath(blob.path)) {
          counts.files_rejected++
          continue
        }
        if (typeof blob.size === 'number' && blob.size > MAX_FILE_BYTES) {
          counts.files_rejected++
          continue
        }
        picked.push(blob)
      }
      picked.sort((a, b) => a.path.localeCompare(b.path))

      for (const blob of picked) {
        if (rateLimited || counts.files_imported >= MAX_FILES_PER_RUN) break
        const url = rawUrl(selectedRepo.repo, blob.path)
        let res: Response
        try {
          res = await fetchImpl(url, {
            headers: { 'User-Agent': headers['User-Agent'], ...(headers.Authorization ? { Authorization: headers.Authorization } : {}) },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
          })
        } catch {
          counts.files_skipped++
          pushError('download', 'network_error', { repo: selectedRepo.repo })
          continue
        }
        if (!res.ok) {
          counts.files_skipped++
          const code = res.status === 429 ? 'rate_limit' : `http_${res.status}`
          pushError('download', code, { repo: selectedRepo.repo })
          if (code === 'rate_limit') rateLimited = true
          continue
        }
        let bytes: Buffer
        try {
          bytes = Buffer.from(await res.arrayBuffer())
        } catch {
          counts.files_skipped++
          pushError('download', 'invalid_body', { repo: selectedRepo.repo })
          continue
        }
        if (bytes.length > MAX_FILE_BYTES) {
          counts.files_rejected++
          continue
        }
        const digest = sha256(bytes)
        if (seenShas.has(digest)) {
          counts.duplicates++
          continue
        }

        const segments = blob.path.split('/')
        const dest = path.resolve(repoRoot, ...selectedRepo.repo.split('/'), ...segments)
        if (dest !== repoRoot && !dest.startsWith(repoRoot + path.sep)) {
          counts.files_rejected++
          pushError('download', 'path_outside_root', { repo: selectedRepo.repo })
          continue
        }
        try {
          fs.mkdirSync(path.dirname(dest), { recursive: true })
          fs.writeFileSync(dest, bytes)
        } catch {
          counts.files_skipped++
          pushError('download', 'write_failed', { repo: selectedRepo.repo })
          continue
        }

        seenShas.add(digest)
        const text = bytes.toString('utf8')
        const warnings = scanWarnings(text)
        if (warnings.length > 0) counts.warnings++
        imported.push({
          repo: selectedRepo.repo,
          path: blob.path,
          url,
          stars: selectedRepo.stars,
          license: selectedRepo.license,
          sha: digest,
          fetched_at: now().toISOString(),
          score: selectedRepo.score,
          warnings,
          tier: selectedRepo.tier,
          verified: selectedRepo.verified
        })
        counts.files_imported++
      }
    }

    // 3. Manifest is cumulative: previous entries survive unless a run replaced
    // nothing (dedupe guarantees shas stay unique).
    const generatedAt = now().toISOString()
    atomicWriteJson(manifestFile(dataRoot), {
      version: 1,
      generated_at: generatedAt,
      entries: [...previous.entries, ...imported]
    } satisfies SyncManifest)

    return finishStatus(dataRoot, {
      ...baseStatus,
      last_run: generatedAt,
      running: false,
      finished_at: generatedAt,
      counts,
      errors
    })
  } catch (err) {
    pushError('download', `unexpected: ${err instanceof Error ? err.message : String(err)}`)
    return finishStatus(dataRoot, {
      ...baseStatus,
      running: false,
      finished_at: now().toISOString(),
      counts,
      errors
    })
  }
}

function finishStatus(dataRoot: string, status: SyncStatus): SyncStatus {
  atomicWriteJson(statusFile(dataRoot), status)
  return { ...status, running: false }
}

// ---------------------------------------------------------------------------
// HTTP route (GET /api/agents/sync, POST /api/agents/sync, GET /api/agents/library)
// ---------------------------------------------------------------------------

export async function handleAgentLibraryRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  pathname: string,
  ctx: AgentLibraryRouteContext
): Promise<boolean> {
  const method = (req.method ?? 'GET').toUpperCase()
  const isRead = method === 'GET' || method === 'HEAD'

  if (pathname === '/api/agents/sync') {
    if (isRead) {
      ctx.sendJson(res, 200, readAgentSyncStatus(ctx.dataRoot))
      return true
    }
    if (method !== 'POST') {
      res.statusCode = 405
      res.setHeader('Allow', 'GET, HEAD, POST')
      res.end()
      return true
    }
    const auth = ctx.authorize(req)
    if (!auth.ok) {
      ctx.sendJson(res, auth.status, { error: auth.error })
      return true
    }
    const { started } = startAgentSync({
      dataRoot: ctx.dataRoot,
      fetchImpl: ctx.fetchImpl,
      env: ctx.env,
      now: ctx.now
    })
    if (!started) {
      ctx.sendJson(res, 409, { started: false, error: 'sync_running' })
      return true
    }
    ctx.sendJson(res, 202, { started: true })
    return true
  }

  if (pathname === '/api/agents/library') {
    if (!isRead) {
      res.statusCode = 405
      res.setHeader('Allow', 'GET, HEAD')
      res.end()
      return true
    }
    const limit = Number(url.searchParams.get('limit') ?? '')
    const offset = Number(url.searchParams.get('offset') ?? '')
    ctx.sendJson(
      res,
      200,
      readAgentLibrary(ctx.dataRoot, {
        limit: Number.isFinite(limit) ? limit : undefined,
        offset: Number.isFinite(offset) ? offset : undefined
      })
    )
    return true
  }

  return false
}
