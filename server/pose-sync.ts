/**
 * #138 增强：姿态参考库「从 GitHub 同步」。
 *
 * 只存外链 + 元数据，**不下载图片**：
 *  - 搜索 `pose reference / openpose / character poses / pose library` 与
 *    `topic:pose-estimation` / `topic:character-poses`，`sort=stars`，stars ≥ 300；
 *  - license 必须映射到既有白名单（CC0 / CC-BY-4.0 / CC-BY-SA-4.0 / MIT / Apache-2.0），
 *    无 license 或其它协议跳过并计原因；
 *  - 每个仓库用 git tree 找 png/jpg/jpeg/webp，路径含 pose|poses|reference|action，
 *    ≤10 张/仓、≤50 张/次，排除 `.github/`、测试目录、icon/logo；
 *  - 入库复用 `addPoseEntry`（校验 + 原子写 + source_url 去重）。
 *
 * 同步状态落 `<WEB_DATA_ROOT>/pose-library/sync-status.json`，用于 6 小时最小间隔
 * 与 UI 状态行。`GITHUB_TOKEN` 可选；匿名限速时如实返回 `rate_limit.limited`，
 * 由路由层返回 429，绝不伪造成成功。
 */
import type { PoseEntry, PoseLicense } from './pose-library'

export const POSE_SYNC_QUERIES = [
  'pose reference OR openpose OR "character poses" OR "pose library"',
  'topic:pose-estimation',
  'topic:character-poses'
] as const

export const POSE_SYNC_MIN_STARS = 300
export const POSE_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000
export const MAX_IMAGES_PER_REPO = 10
export const MAX_IMAGES_PER_RUN = 50

const SEARCH_PER_PAGE = 30
const FETCH_TIMEOUT_MS = 15_000
const MAX_ERRORS = 20

/** GitHub SPDX → 库内白名单。CC0 在 GitHub 上是 `CC0-1.0`。 */
const LICENSE_MAP: Record<string, PoseLicense> = {
  'CC0-1.0': 'CC0',
  CC0: 'CC0',
  'CC-BY-4.0': 'CC-BY-4.0',
  'CC-BY-SA-4.0': 'CC-BY-SA-4.0',
  MIT: 'MIT',
  'APACHE-2.0': 'Apache-2.0'
}

export function mapGitHubLicense(spdx: unknown): PoseLicense | null {
  if (typeof spdx !== 'string' || !spdx.trim()) return null
  if (spdx === 'NOASSERTION') return null
  return LICENSE_MAP[spdx.trim().toUpperCase()] ?? null
}

export type PoseSyncStage = 'search' | 'tree' | 'import'
export type PoseSyncSkipReason =
  | 'low_stars'
  | 'license_missing'
  | 'license_not_allowed'
  | 'no_pose_images'
  | 'duplicate_content'
  | 'duplicate_source_url'
  | 'add_failed'
  | 'max_images_per_run'

export type PoseSyncError = {
  at: string
  stage: PoseSyncStage
  error: string
  repo?: string
  query?: string
}

export type PoseSyncRepo = {
  repo: string
  stars: number
  license: PoseLicense | null
  imported: number
  skipped: number
  reason: PoseSyncSkipReason | 'rate_limit' | null
}

export type PoseRateLimit = {
  limited: boolean
  status: number | null
  remaining: number | null
  auth: 'token' | 'anonymous'
}

export type PoseSyncResult = {
  at: string | null
  imported: number
  skipped: number
  errors: PoseSyncError[]
  repos: PoseSyncRepo[]
  rate_limit: PoseRateLimit
  skip_reasons: Partial<Record<PoseSyncSkipReason, number>>
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export type RunPoseSyncOutcome =
  | { ok: true; result: PoseSyncResult }
  | {
      ok: false
      status: 409
      error: 'sync_too_soon'
      last_at: string
      next_at: string
      retry_after_ms: number
    }
  | { ok: false; status: 409; error: 'sync_running' }

type GithubRepo = {
  full_name?: unknown
  stargazers_count?: unknown
  license?: { spdx_id?: unknown } | null
  default_branch?: unknown
}

type TreeEntry = { path?: unknown; type?: unknown; sha?: unknown }

// ---------------------------------------------------------------------------
// 状态文件
// ---------------------------------------------------------------------------

export function poseSyncStatusFile(dataRoot: string): string {
  return `${dataRoot}/pose-library/sync-status.json`
}

export function emptyPoseSyncResult(): PoseSyncResult {
  return {
    at: null,
    imported: 0,
    skipped: 0,
    errors: [],
    repos: [],
    rate_limit: { limited: false, status: null, remaining: null, auth: 'anonymous' },
    skip_reasons: {}
  }
}

export function readPoseSyncStatus(
  dataRoot: string,
  readJson: (file: string) => any | null
): PoseSyncResult {
  const raw = readJson(poseSyncStatusFile(dataRoot))
  if (!raw || typeof raw !== 'object') return emptyPoseSyncResult()
  const value = raw as Partial<PoseSyncResult>
  return {
    at: typeof value.at === 'string' ? value.at : null,
    imported: typeof value.imported === 'number' ? value.imported : 0,
    skipped: typeof value.skipped === 'number' ? value.skipped : 0,
    errors: Array.isArray(value.errors) ? (value.errors as PoseSyncError[]) : [],
    repos: Array.isArray(value.repos) ? (value.repos as PoseSyncRepo[]) : [],
    rate_limit:
      value.rate_limit && typeof value.rate_limit === 'object'
        ? { ...emptyPoseSyncResult().rate_limit, ...value.rate_limit }
        : emptyPoseSyncResult().rate_limit,
    skip_reasons:
      value.skip_reasons && typeof value.skip_reasons === 'object'
        ? (value.skip_reasons as PoseSyncResult['skip_reasons'])
        : {}
  }
}

/** 与 pose-library 的归一化规则一致（去掉 hash 与末尾斜杠）；避免反向 import 造成循环。 */
function normalizeSourceKey(raw: string): string {
  try {
    const url = new URL(raw.trim())
    url.hash = ''
    let pathname = url.pathname
    if (pathname.length > 1) pathname = pathname.replace(/\/+$/, '')
    return `${url.protocol}//${url.host}${pathname}${url.search}`
  } catch {
    return raw.trim()
  }
}

function readStoredEntries(
  dataRoot: string,
  readJson: (file: string) => any | null
): PoseEntry[] {
  const raw = readJson(`${dataRoot}/pose-library/entries.json`)
  if (Array.isArray(raw)) return raw as PoseEntry[]
  if (raw && typeof raw === 'object' && Array.isArray((raw as { entries?: unknown }).entries)) {
    return (raw as { entries: PoseEntry[] }).entries
  }
  return []
}

// ---------------------------------------------------------------------------
// GitHub 请求
// ---------------------------------------------------------------------------

type JsonResult =
  | { ok: true; data: any; remaining: number | null }
  | { ok: false; code: string; status: number; remaining: number | null }

async function requestJson(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>
): Promise<JsonResult> {
  let res: Response
  try {
    res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  } catch {
    return { ok: false, code: 'network_error', status: 0, remaining: null }
  }
  const remainingRaw = res.headers.get('x-ratelimit-remaining')
  const remaining =
    remainingRaw !== null && Number.isFinite(Number(remainingRaw)) ? Number(remainingRaw) : null
  if (!res.ok) {
    let code = `http_${res.status}`
    if (res.status === 401) code = 'unauthorized'
    else if (res.status === 429) code = 'rate_limit'
    else if (res.status === 403) {
      code = 'forbidden'
      if (remaining === 0) code = 'rate_limit'
      else {
        try {
          const text = await res.text()
          if (/rate limit/i.test(text)) code = 'rate_limit'
        } catch {
          /* body 不可读时保留 forbidden */
        }
      }
    }
    return { ok: false, code, status: res.status, remaining }
  }
  try {
    return { ok: true, data: await res.json(), remaining }
  } catch {
    return { ok: false, code: 'invalid_json', status: res.status, remaining }
  }
}

function isFatalGithubError(code: string): boolean {
  return code === 'rate_limit' || code === 'unauthorized'
}

export function githubHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'kex-acceptance-web-pose-sync',
    'X-GitHub-Api-Version': '2022-11-28'
  }
  const token = env.GITHUB_TOKEN?.trim()
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

export function poseSearchUrl(query: string): string {
  return `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${SEARCH_PER_PAGE}`
}

export function poseTreeUrl(repo: string): string {
  return `https://api.github.com/repos/${repo}/git/trees/HEAD?recursive=1`
}

// ---------------------------------------------------------------------------
// 路径过滤
// ---------------------------------------------------------------------------

const IMAGE_EXT_RE = /\.(png|jpe?g|webp)$/i
const POSE_PATH_RE = /(^|[^a-z])(poses?|openpose|references?|actions?)([^a-z]|$)/i
const EXCLUDED_SEGMENTS = new Set([
  '.github',
  'test',
  'tests',
  '__tests__',
  'spec',
  'specs',
  'testing',
  'fixtures'
])
const ICON_RE = /(icon|logo|favicon)/i

/** 只收「像姿态参考」的图片；`.github/`、测试、icon/logo 一律排除。 */
export function isPoseImagePath(filePath: string): boolean {
  if (typeof filePath !== 'string' || !filePath.trim()) return false
  const normalized = filePath.replace(/\\/g, '/').toLowerCase()
  const segments = normalized.split('/').filter(Boolean)
  if (segments.length === 0) return false
  const base = segments[segments.length - 1] ?? ''
  if (!IMAGE_EXT_RE.test(base)) return false
  if (segments.some((segment) => EXCLUDED_SEGMENTS.has(segment))) return false
  if (ICON_RE.test(base)) return false
  return POSE_PATH_RE.test(normalized)
}

function encodePath(filePath: string): string {
  return filePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

export function githubBlobUrl(repo: string, filePath: string): string {
  return `https://github.com/${repo}/blob/HEAD/${encodePath(filePath)}`
}

export function githubRawUrl(repo: string, filePath: string): string {
  return `https://raw.githubusercontent.com/${repo}/HEAD/${encodePath(filePath)}`
}

/** repo 名（去掉 owner），用于中文标签；超长时按 60 字上限截断。 */
export function poseLabelFor(repo: string, index: number): string {
  const name = repo.split('/')[1] ?? repo
  const suffix = ` 姿态 ${index}`
  const budget = Math.max(1, 60 - [...suffix].length)
  return [...name].slice(0, budget).join('') + suffix
}

function licenseEvidenceUrl(repo: string, tree: TreeEntry[]): string {
  const paths = tree
    .filter((entry) => entry.type === 'blob' && typeof entry.path === 'string')
    .map((entry) => entry.path as string)
  const match =
    paths.find((p) => /^(license|licence|copying)(\.(md|txt|rst))?$/i.test(p)) ??
    paths.find((p) => /(^|\/)(license|licence|copying)(\.(md|txt|rst))?$/i.test(p))
  return githubBlobUrl(repo, match ?? 'LICENSE')
}

// ---------------------------------------------------------------------------
// 同步
// ---------------------------------------------------------------------------

const runningByRoot = new Set<string>()

export function poseSyncInFlight(dataRoot: string): boolean {
  return runningByRoot.has(dataRoot)
}

export async function runPoseSync(opts: {
  dataRoot: string
  readJson: (file: string) => any | null
  atomicWriteJson: (file: string, value: unknown) => void
  addPoseEntry: (value: {
    label_zh: string
    preview_url: string | null
    source_url: string
    license: PoseLicense
    license_evidence_url: string
    suitable_shots: ['full_body']
    tags: string[]
    note: string
    content_sha: string | null
  }) => Promise<{ ok: true; item: PoseEntry } | { ok: false; status: 409; error: string }>
  fetchImpl?: FetchLike
  env?: NodeJS.ProcessEnv
  now?: () => Date
  force?: boolean
}): Promise<RunPoseSyncOutcome> {
  const dataRoot = opts.dataRoot
  const now = opts.now ?? (() => new Date())
  const fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init))
  const env = opts.env ?? process.env
  const key = dataRoot
  if (runningByRoot.has(key)) return { ok: false, status: 409, error: 'sync_running' }

  const previous = readPoseSyncStatus(dataRoot, opts.readJson)
  const nowDate = now()
  const lastMs = previous.at ? Date.parse(previous.at) : Number.NaN
  if (!opts.force && Number.isFinite(lastMs) && nowDate.getTime() - lastMs < POSE_SYNC_INTERVAL_MS) {
    const nextMs = lastMs + POSE_SYNC_INTERVAL_MS
    return {
      ok: false,
      status: 409,
      error: 'sync_too_soon',
      last_at: new Date(lastMs).toISOString(),
      next_at: new Date(nextMs).toISOString(),
      retry_after_ms: Math.max(0, nextMs - nowDate.getTime())
    }
  }

  runningByRoot.add(key)
  try {
    return { ok: true, result: await syncOnce({ ...opts, dataRoot, now, fetchImpl, env }) }
  } finally {
    runningByRoot.delete(key)
  }
}

async function syncOnce(opts: {
  dataRoot: string
  readJson: (file: string) => any | null
  atomicWriteJson: (file: string, value: unknown) => void
  addPoseEntry: (value: {
    label_zh: string
    preview_url: string | null
    source_url: string
    license: PoseLicense
    license_evidence_url: string
    suitable_shots: ['full_body']
    tags: string[]
    note: string
    content_sha: string | null
  }) => Promise<{ ok: true; item: PoseEntry } | { ok: false; status: 409; error: string }>
  fetchImpl: FetchLike
  env: NodeJS.ProcessEnv
  now: () => Date
}): Promise<PoseSyncResult> {
  const { dataRoot, now, fetchImpl, env } = opts
  const headers = githubHeaders(env)
  const auth = env.GITHUB_TOKEN?.trim() ? 'token' : 'anonymous'
  const result: PoseSyncResult = {
    at: null,
    imported: 0,
    skipped: 0,
    errors: [],
    repos: [],
    rate_limit: { limited: false, status: null, remaining: null, auth },
    skip_reasons: {}
  }

  const pushError = (stage: PoseSyncStage, error: string, extra: Partial<PoseSyncError> = {}) => {
    if (result.errors.length < MAX_ERRORS) {
      result.errors.push({ at: now().toISOString(), stage, error, ...extra })
    }
  }
  const countSkip = (reason: PoseSyncSkipReason, repo?: PoseSyncRepo) => {
    result.skipped++
    result.skip_reasons[reason] = (result.skip_reasons[reason] ?? 0) + 1
    if (repo) {
      repo.skipped++
      repo.reason = reason
    }
  }
  const markRateLimited = (status: number) => {
    result.rate_limit.limited = true
    result.rate_limit.status = status
    result.rate_limit.remaining = 0
  }

  // 1. 搜索 + 去重仓库
  const found = new Map<string, GithubRepo>()
  let rateLimited = false
  for (const query of POSE_SYNC_QUERIES) {
    if (rateLimited) break
    const res = await requestJson(fetchImpl, poseSearchUrl(query), headers)
    if (res.remaining !== null) result.rate_limit.remaining = res.remaining
    if (!res.ok) {
      pushError('search', res.code, { query })
      if (isFatalGithubError(res.code)) {
        markRateLimited(res.status)
        rateLimited = true
      }
      continue
    }
    const items = Array.isArray(res.data?.items) ? (res.data.items as GithubRepo[]) : []
    for (const item of items) {
      const repo = typeof item.full_name === 'string' ? item.full_name : null
      if (!repo || found.has(repo)) continue
      found.set(repo, item)
    }
  }

  const existing = readStoredEntries(dataRoot, opts.readJson)
  const seenSources = new Set<string>()
  const seenContents = new Set<string>()
  for (const entry of existing) {
    const source = String(entry.source_url ?? '').trim()
    if (source) seenSources.add(normalizeSourceKey(source))
    const sha = String(entry.content_sha ?? '').trim().toLowerCase()
    if (sha) seenContents.add(sha)
  }
  const sourceKey = normalizeSourceKey

  // 2. 逐仓过滤 license / stars，再读 tree 找图
  for (const [repo, item] of found) {
    if (result.imported >= MAX_IMAGES_PER_RUN) break
    if (rateLimited) break

    const stars = typeof item.stargazers_count === 'number' ? item.stargazers_count : 0
    const spdx = item.license?.spdx_id
    const license = mapGitHubLicense(spdx)
    const repoRow: PoseSyncRepo = {
      repo,
      stars,
      license,
      imported: 0,
      skipped: 0,
      reason: null
    }
    result.repos.push(repoRow)

    if (stars < POSE_SYNC_MIN_STARS) {
      countSkip('low_stars', repoRow)
      continue
    }
    if (!license) {
      countSkip(
        typeof spdx === 'string' && spdx && spdx !== 'NOASSERTION'
          ? 'license_not_allowed'
          : 'license_missing',
        repoRow
      )
      continue
    }

    const treeRes = await requestJson(fetchImpl, poseTreeUrl(repo), headers)
    if (treeRes.remaining !== null) result.rate_limit.remaining = treeRes.remaining
    if (!treeRes.ok) {
      pushError('tree', treeRes.code, { repo })
      repoRow.reason = 'rate_limit'
      if (isFatalGithubError(treeRes.code)) {
        markRateLimited(treeRes.status)
        rateLimited = true
      }
      continue
    }
    const tree = Array.isArray(treeRes.data?.tree) ? (treeRes.data.tree as TreeEntry[]) : []
    const candidates = tree
      .filter((entry) => entry.type === 'blob' && typeof entry.path === 'string')
      .map((entry) => ({
        path: entry.path as string,
        sha: typeof entry.sha === 'string' && entry.sha.trim() ? entry.sha.trim().toLowerCase() : null
      }))
      .filter((entry) => isPoseImagePath(entry.path))
      .slice(0, MAX_IMAGES_PER_REPO)

    if (candidates.length === 0) {
      countSkip('no_pose_images', repoRow)
      continue
    }

    const evidence = licenseEvidenceUrl(repo, tree)
    for (const { path: filePath, sha } of candidates) {
      if (result.imported >= MAX_IMAGES_PER_RUN) {
        countSkip('max_images_per_run', repoRow)
        continue
      }
      // #169：同 blob sha（跨 fork / 镜像）只导入一次。
      if (sha && seenContents.has(sha)) {
        countSkip('duplicate_content', repoRow)
        continue
      }
      const sourceUrl = githubBlobUrl(repo, filePath)
      if (seenSources.has(sourceKey(sourceUrl))) {
        countSkip('duplicate_source_url', repoRow)
        continue
      }
      const value = {
        label_zh: poseLabelFor(repo, repoRow.imported + 1),
        preview_url: githubRawUrl(repo, filePath),
        source_url: sourceUrl,
        license,
        license_evidence_url: evidence,
        suitable_shots: ['full_body'] as ['full_body'],
        tags: [repo, 'github'],
        note: '',
        content_sha: sha
      }
      try {
        const added = await opts.addPoseEntry(value)
        if (!added.ok) {
          countSkip(added.error === 'duplicate_content' ? 'duplicate_content' : 'duplicate_source_url', repoRow)
          if (sha) seenContents.add(sha)
          seenSources.add(sourceKey(sourceUrl))
          continue
        }
        if (sha) seenContents.add(sha)
        seenSources.add(sourceKey(sourceUrl))
        repoRow.imported++
        result.imported++
      } catch (err) {
        countSkip('add_failed', repoRow)
        pushError('import', err instanceof Error ? err.message : 'add_failed', { repo })
      }
    }
    if (repoRow.imported === 0 && repoRow.reason === null) repoRow.reason = 'no_pose_images'
  }

  result.at = now().toISOString()
  opts.atomicWriteJson(poseSyncStatusFile(dataRoot), result)
  return result
}
