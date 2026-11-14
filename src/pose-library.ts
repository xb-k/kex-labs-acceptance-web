/**
 * #138 姿态参考库（pose library）前端契约与纯函数。
 *
 * 服务端契约（server/pose-library.ts）：
 *  - GET  `/api/pose-library?q=&license=&shot=&limit=&offset=` → `{ items, total }`
 *  - POST `/api/pose-library` → 201 `{ item }`；未核 license → 400 `license_unverified`；
 *    重复 source_url → 409 `duplicate_source_url`
 *  - DELETE `/api/pose-library/:id` → 200 `{ ok, item }`
 *
 * 这里只放类型、筛选 URL 构造、前端预校验与服务端错误文案；渲染在
 * `components/studio/PoseLibraryPanel.tsx`，便于用 react-dom/server 做 SSR 断言。
 */
import { deleteJson, getJson, HttpError, postJson } from './api'

export const POSE_LICENSES = [
  'CC0',
  'CC-BY-4.0',
  'CC-BY-SA-4.0',
  'MIT',
  'Apache-2.0',
  'OWNED'
] as const
export type PoseLicense = (typeof POSE_LICENSES)[number]

export type PoseShot = 'closeup' | 'medium' | 'wide' | 'full_body' | 'action'

export const POSE_SHOT_OPTIONS: ReadonlyArray<{ value: PoseShot; label: string }> = [
  { value: 'closeup', label: '特写' },
  { value: 'medium', label: '中景' },
  { value: 'wide', label: '远景' },
  { value: 'full_body', label: '全身' },
  { value: 'action', label: '动作' }
]

export const POSE_LABEL_MAX = 60
export const POSE_TAGS_MAX = 10

export type PoseLibraryItem = {
  id: string
  label_zh: string
  preview_url: string | null
  source_url: string
  license: PoseLicense
  license_evidence_url: string
  license_verified: boolean
  suitable_shots: string[]
  tags: string[]
  note?: string
  created_at: string
}

export type PoseLibraryList = {
  items: PoseLibraryItem[]
  total: number
  limit?: number
  offset?: number
}

/** #138 增强：GitHub 同步结果（与 server/pose-sync.ts 对齐）。 */
export type PoseSyncRateLimit = {
  limited: boolean
  status: number | null
  remaining: number | null
  auth: 'token' | 'anonymous'
}

export type PoseSyncError = {
  at: string
  stage: 'search' | 'tree' | 'import'
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
  reason: string | null
}

export type PoseSyncResult = {
  at: string | null
  imported: number
  skipped: number
  errors: PoseSyncError[]
  repos: PoseSyncRepo[]
  rate_limit: PoseSyncRateLimit
  skip_reasons?: Record<string, number>
}

export type PoseFilters = {
  q: string
  license: PoseLicense | ''
  shot: PoseShot | ''
}

export const EMPTY_POSE_FILTERS: PoseFilters = { q: '', license: '', shot: '' }

/** 列表查询 URL（q / license / shot 只在非空时出现；limit 固定 24 条一页）。 */
export function buildPoseLibraryQuery(filters: PoseFilters, limit = 24, offset = 0): string {
  const params = new URLSearchParams()
  const q = filters.q.trim()
  if (q) params.set('q', q)
  if (filters.license) params.set('license', filters.license)
  if (filters.shot) params.set('shot', filters.shot)
  params.set('limit', String(limit))
  params.set('offset', String(offset))
  return `/api/pose-library?${params.toString()}`
}

export type PoseDraft = {
  label_zh: string
  source_url: string
  license: PoseLicense | ''
  license_evidence_url: string
  preview_url: string
  suitable_shots: PoseShot[]
  /** 逗号分隔（中英文逗号都接受），提交前拆成数组去重。 */
  tags: string
}

export const EMPTY_POSE_DRAFT: PoseDraft = {
  label_zh: '',
  source_url: '',
  license: '',
  license_evidence_url: '',
  preview_url: '',
  suitable_shots: [],
  tags: ''
}

export type PoseDraftErrors = Partial<
  Record<'label_zh' | 'source_url' | 'license' | 'license_evidence_url' | 'preview_url' | 'tags', string>
>

export type PosePayload = {
  label_zh: string
  source_url: string
  license: PoseLicense
  license_evidence_url: string
  preview_url: string | null
  suitable_shots: PoseShot[]
  tags: string[]
}

export type PoseDraftResult =
  | { ok: true; payload: PosePayload }
  | { ok: false; errors: PoseDraftErrors }

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value.trim())
    return url.protocol === 'https:' && Boolean(url.hostname)
  } catch {
    return false
  }
}

function isPreviewUrl(value: string): boolean {
  const trimmed = value.trim()
  return isHttpsUrl(trimmed) || (trimmed.startsWith('/') && !trimmed.startsWith('//') && trimmed.length > 1)
}

/** 逗号分隔的标签串 → 去重数组（空段丢弃；超过 10 个返回 null 由调用方报错）。 */
export function parsePoseTags(raw: string): { tags: string[]; tooMany: boolean } {
  const seen = new Set<string>()
  for (const part of raw.split(/[,，]/)) {
    const tag = part.trim()
    if (tag) seen.add(tag)
  }
  return { tags: [...seen], tooMany: seen.size > POSE_TAGS_MAX }
}

/**
 * 前端预校验：规则与 server/pose-library.ts 对齐，尽量把错误挡在弹窗里；
 * 服务端仍是最终判定（例如重复 source_url 只能由服务端 409 返回）。
 */
export function validatePoseDraft(draft: PoseDraft): PoseDraftResult {
  const errors: PoseDraftErrors = {}

  const label = draft.label_zh.trim()
  if (!label) errors.label_zh = '请填写中文标签'
  else if ([...label].length > POSE_LABEL_MAX) errors.label_zh = `中文标签不超过 ${POSE_LABEL_MAX} 字`
  else if (!/[\u3400-\u9fff]/.test(label)) errors.label_zh = '中文标签至少包含一个汉字'

  const sourceUrl = draft.source_url.trim()
  if (!sourceUrl) errors.source_url = '请填写来源链接'
  else if (!isHttpsUrl(sourceUrl)) errors.source_url = '来源链接必须是 https://'

  if (!draft.license || !POSE_LICENSES.includes(draft.license as PoseLicense)) {
    errors.license = '请选择 license（未知协议不能入库）'
  }

  const evidence = draft.license_evidence_url.trim()
  if (!evidence) errors.license_evidence_url = '请填写授权证据链接'
  else if (!isHttpsUrl(evidence)) errors.license_evidence_url = '授权证据链接必须是 https://'

  const preview = draft.preview_url.trim()
  if (preview && !isPreviewUrl(preview)) {
    errors.preview_url = '预览图需为 https:// 或以 / 开头的站内路径'
  }

  const { tags, tooMany } = parsePoseTags(draft.tags)
  if (tooMany) errors.tags = `标签最多 ${POSE_TAGS_MAX} 个`

  if (Object.keys(errors).length > 0) return { ok: false, errors }

  return {
    ok: true,
    payload: {
      label_zh: label,
      source_url: sourceUrl,
      license: draft.license as PoseLicense,
      license_evidence_url: evidence,
      preview_url: preview || null,
      suitable_shots: draft.suitable_shots,
      tags
    }
  }
}

const POSE_ERROR_HINTS: Record<string, string> = {
  license_unverified: 'license 与授权证据链接必须齐全',
  preview_missing: '该条目没有预览图，不能用作参考图',
  preview_unavailable: '预览图不可用（本地缺失、非图片或超过 8 MiB），请更换预览地址后重试',
  studio_stage_failed: 'studio 暂存失败，本地副本已保留，可稍后重试',
  upload_unconfigured: '服务端未配置上传路径，暂不能用作参考图',
  unsupported_type: '仅支持 png / jpg / jpeg / webp',
  empty_bytes: '预览图为空，无法用作参考图',
  invalid_filename: '参考图文件名不合法',
  write_failed: '写入本地副本失败，请重试',
  duplicate_source_url: '该来源已在库中，换个来源或先删除旧条目',
  label_zh_invalid: '中文标签不合法',
  source_url_invalid: '来源链接不合法',
  preview_url_invalid: '预览图链接不合法',
  suitable_shots_invalid: '适用镜头取值不合法',
  tags_invalid: '标签不合法',
  'invalid X-Web-Token': '鉴权失败：X-Web-Token 不正确',
  'same-origin browser request or X-Web-Token required': '鉴权失败：需同源访问或配置 X-Web-Token',
  'write disabled: WEB_WRITE_TOKEN is not set': '写接口未启用：服务端未配置 WEB_WRITE_TOKEN',
  sync_too_soon: '距上次同步不足 6 小时，可强制同步',
  sync_running: '同步进行中，请稍候',
  github_rate_limited: 'GitHub 已限速，可配置 GITHUB_TOKEN 后重试',
  body_invalid: '请求体不合法'
}

/** 服务端错误原样展示（状态码 + error code），附中文提示；非 HTTP 错误透传 message。 */
export function formatPoseError(err: unknown): string {
  if (err instanceof HttpError) {
    const raw = err.message || `HTTP ${err.status}`
    const hint = POSE_ERROR_HINTS[raw]
    const base = `${err.status} ${raw}`
    return hint ? `${base}（${hint}）` : base
  }
  return err instanceof Error && err.message ? err.message : '请求失败'
}

export function isPoseAuthError(err: unknown): boolean {
  return err instanceof HttpError && (err.status === 401 || err.status === 403)
}

export function listPoseEntries(filters: PoseFilters, signal?: AbortSignal): Promise<PoseLibraryList> {
  return getJson<PoseLibraryList>(buildPoseLibraryQuery(filters), signal)
}

export function createPoseEntry(payload: PosePayload): Promise<PoseLibraryItem> {
  return postJson<{ item: PoseLibraryItem }>('/api/pose-library', payload).then((res) => res.item)
}

export function removePoseEntry(id: string): Promise<void> {
  return deleteJson<{ ok: boolean }>(`/api/pose-library/${encodeURIComponent(id)}`).then(() => undefined)
}

/** #138 `POST /api/pose-library/:id/materialize` 响应（与 server/pose-library.ts 对齐）。 */
export type PoseMaterializeResult = {
  upload_id: string
  filename: string
  size: number
  sha256: string
  studio_path: string
}

/** 姿态参考 → 图片工作台的三件套（upload_id / 文件名 / 中文标签）。 */
export type PoseUsage = {
  uploadId: string
  filename: string
  label: string
}

export function poseUsageFromMaterialize(
  item: PoseLibraryItem,
  result: PoseMaterializeResult
): PoseUsage {
  return { uploadId: result.upload_id, filename: result.filename, label: item.label_zh }
}

/**
 * #138 把姿态预览图落成 studio upload；成功后返回值可直接作为
 * ImageWorkbench 的 source_upload_id。失败抛 HttpError（error 为预览/暂存错误码）。
 */
export function materializePoseEntry(id: string): Promise<PoseMaterializeResult> {
  return postJson<PoseMaterializeResult>(
    `/api/pose-library/${encodeURIComponent(id)}/materialize`,
    {}
  )
}

export function poseShotLabel(shot: string): string {
  return POSE_SHOT_OPTIONS.find((opt) => opt.value === shot)?.label ?? shot
}

export function formatPoseDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 同步状态：上次同步时间 / 导入数 / 跳过数 / 错误数；未同步时为中文提示。 */
export function formatPoseSyncStatus(status: PoseSyncResult | null): string {
  if (!status || !status.at) return '尚未同步'
  const date = new Date(status.at)
  const pad = (n: number) => String(n).padStart(2, '0')
  const when = Number.isNaN(date.getTime())
    ? status.at
    : `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  return `上次同步 ${when} · 导入 ${status.imported} · 跳过 ${status.skipped} · 错误 ${status.errors.length}`
}

export function getPoseSyncStatus(signal?: AbortSignal): Promise<PoseSyncResult> {
  return getJson<PoseSyncResult>('/api/pose-library/sync-status', signal)
}

/** POST /api/pose-library/sync；force 跳过 6 小时最小间隔。 */
export function runPoseSync(force = false): Promise<PoseSyncResult> {
  return postJson<PoseSyncResult>('/api/pose-library/sync', force ? { force: true } : {})
}
