/**
 * #133 Agent / Skill 库同步：只读远端清单的客户端与展示派生函数。
 *
 * 后端 `POST /api/agents/sync` 只负责抓取 + 落盘，前端不执行任何远端内容；
 * 页面只读 manifest、展示来源与 warnings。这里所有函数都是纯函数 / 薄 fetch，
 * 便于用 mock fetch 做契约级单测（见 agent-library.test.ts）。
 */

export interface LibraryEntry {
  repo: string
  path: string
  url: string
  stars: number
  license: string
  sha: string
  fetched_at: string
  score: number
  score_parts?: { star: number; recency: number; relevance: number }
  warnings: string[]
  tier: 'A' | 'B'
  verified: boolean
}

export interface AgentSyncCounts {
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

export interface AgentSyncError {
  at: string
  stage: 'search' | 'tree' | 'download'
  query?: string
  repo?: string
  error: string
}

export interface AgentSyncStatus {
  last_run: string | null
  running: boolean
  started_at: string | null
  finished_at: string | null
  counts: AgentSyncCounts
  errors: AgentSyncError[]
  queries: string[]
  auth: 'token' | 'anonymous'
}

export interface AgentLibraryPage {
  total: number
  limit: number
  offset: number
  generated_at: string | null
  items: LibraryEntry[]
}

export const EMPTY_SYNC_COUNTS: AgentSyncCounts = {
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

/** 状态卡的四种结论；失败与「部分失败」分开，不把有错误的成功说成干净成功。 */
export type SyncPhase = 'unsynced' | 'running' | 'success' | 'partial' | 'failed'

export interface SyncSummary {
  phase: SyncPhase
  label: string
  /** 状态胶囊配色（复用 DESIGN.md 状态色，不新造色）。 */
  tone: 'pending' | 'running' | 'done' | 'blocked' | 'failed'
}

/**
 * 由后端 status 派生展示状态：
 * - 从没跑过（last_run 为空且非 running）→ 未同步；
 * - running → 同步中；
 * - 导入 0 或全部请求失败 → 失败；
 * - 有 errors → 部分失败（成功导入的同时出错，不能当成功）；
 * - 其余 → 成功。
 */
export function summarizeSync(status: AgentSyncStatus | null): SyncSummary {
  if (!status) return { phase: 'unsynced', label: '未同步', tone: 'pending' }
  if (status.running) return { phase: 'running', label: '同步中', tone: 'running' }
  if (!status.last_run) return { phase: 'unsynced', label: '未同步', tone: 'pending' }
  const errors = status.errors.length
  const imported = status.counts.files_imported
  if (errors > 0 && imported === 0) return { phase: 'failed', label: '失败', tone: 'failed' }
  if (errors > 0) return { phase: 'partial', label: '部分失败', tone: 'blocked' }
  return { phase: 'success', label: '成功', tone: 'done' }
}

export interface SyncCountsText {
  imported: number
  skipped: number
  errors: number
  /** 「导入 12 · 跳过 3 · 错误 1」 */
  text: string
}

export function describeSyncCounts(
  counts: AgentSyncCounts | null | undefined,
  errorCount = 0
): SyncCountsText {
  const safe = counts ?? EMPTY_SYNC_COUNTS
  const imported = safe.files_imported
  const skipped = safe.files_skipped + safe.files_rejected + safe.duplicates
  return {
    imported,
    skipped,
    errors: errorCount,
    text: `导入 ${imported} · 跳过 ${skipped} · 错误 ${errorCount}`
  }
}

/** 可疑指令的中文标签；未知 code 原样返回，不吞掉后端新增的规则。 */
const WARNING_LABELS: Record<string, string> = {
  prompt_injection_ignore_previous: '提示注入：忽略先前指令',
  prompt_injection_disregard: '提示注入：无视先前指令',
  prompt_injection_role_override: '提示注入：角色覆盖',
  shell_execution: '管道执行 shell',
  destructive_command: '破坏性命令',
  credential_exfiltration: '凭据外传',
  encoded_payload: 'base64 编码载荷'
}

export function warningLabel(code: string): string {
  return WARNING_LABELS[code] ?? code
}

const STAGE_LABELS: Record<AgentSyncError['stage'], string> = {
  search: '搜索仓库',
  tree: '读取文件树',
  download: '下载文件'
}

/** 原样展示后端错误（rate limit / 401 等），只补阶段与人话前缀。 */
export function describeSyncError(error: AgentSyncError): string {
  const stage = STAGE_LABELS[error.stage] ?? error.stage
  const where = [error.query && `查询「${error.query}」`, error.repo].filter(Boolean).join(' · ')
  const prefix = where ? `${stage}（${where}）` : stage
  return `${prefix}：${error.error}`
}

/** 本地时间 `MM-DD HH:mm:ss`；无值返回 null（调用方显示「尚未同步」）。 */
export function formatSyncStamp(iso: string | null): string | null {
  if (!iso) return null
  const ts = Date.parse(iso)
  if (Number.isNaN(ts)) return null
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown; reason?: unknown }
    const code = typeof body.error === 'string' && body.error ? body.error : `HTTP ${res.status}`
    return typeof body.reason === 'string' && body.reason ? `${code}：${body.reason}` : code
  } catch {
    return `HTTP ${res.status}`
  }
}

export async function getAgentSyncStatus(signal?: AbortSignal): Promise<AgentSyncStatus> {
  const res = await fetch('/api/agents/sync', signal ? { signal } : undefined)
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as AgentSyncStatus
}

/** 202 = 已受理；409 = 已有同步在跑（不是失败，页面转成轮询）。 */
export async function startAgentLibrarySync(
  signal?: AbortSignal
): Promise<{ started: boolean }> {
  const res = await fetch('/api/agents/sync', {
    method: 'POST',
    ...(signal ? { signal } : {})
  })
  if (res.status === 409) return { started: false }
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as { started: boolean }
}

export async function listAgentLibrary(
  opts: { limit?: number; offset?: number } = {},
  signal?: AbortSignal
): Promise<AgentLibraryPage> {
  const search = new URLSearchParams()
  if (typeof opts.limit === 'number') search.set('limit', String(opts.limit))
  if (typeof opts.offset === 'number') search.set('offset', String(opts.offset))
  const suffix = search.toString()
  const res = await fetch(`/api/agents/library${suffix ? `?${suffix}` : ''}`, signal ? { signal } : undefined)
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as AgentLibraryPage
}

export const LIBRARY_PAGE_SIZE = 20
/** 轮询间隔与上限（工单要求 ≤5 分钟）。 */
export const SYNC_POLL_INTERVAL_MS = 2_000
export const SYNC_POLL_LIMIT_MS = 5 * 60_000
