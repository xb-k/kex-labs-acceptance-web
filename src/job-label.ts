/**
 * #102：任务可读标签。
 *
 * 全站历史上直接展示 `job-id`（`web-20261113093155-3ef5f3`），人看不出任务在做什么。
 * 这里只做「展示层」派生：优先用 type / rail / 素材名 / 时间 / 状态拼一个可读标签，
 * 字段缺失就省略，绝不输出 `undefined` 或把服务器绝对路径原样带出。
 *
 * 不改变任何 id：页面仍保留原始 id（排障需要），只是降级为小号次要信息。
 */

/** 兼容 B 轨 `Job`、studio `StudioJob*`、交付 `Delivery` 三种形状的最小字段集。 */
export type JobLabelInput = {
  id?: string | null
  /** studio 任务类型：image / optimize / aigc；B 轨 Job 没有该字段。 */
  type?: string | null
  rail?: string | null
  track?: string | null
  status?: string | null
  title?: string | null
  taskId?: string | null
  input?: string | null
  source?: string | null
  source_image?: string | null
  uploadName?: string | null
  upload_name?: string | null
  upload_id?: string | null
  uploadId?: string | null
  source_upload_id?: string | null
  created_at?: string | null
  createdAt?: string | null
  media?: { original?: string | null; output?: string | null } | null
  /** 以下字段不参与标签，只用于筛选覆盖「页面上真实显示的文字」。 */
  stage?: string | null
  verdict?: string | null
  statusLabel?: string | null
  statusNote?: string | null
  brief_id?: string | null
  width?: number | null
  height?: number | null
  fps?: number | null
  frames?: number | null
  passed?: number | null
  judged?: number | null
  total?: number | null
  durationS?: number | null
  duration_s?: number | null
}

function text(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 取路径 / URL / upload id 的文件名；清掉 query/hash、反斜杠、绝对路径前缀。 */
export function jobBasename(value: string | null | undefined): string {
  const raw = text(value)
  if (!raw) return ''
  const cleaned = raw.split(/[?#]/, 1)[0].replace(/\\/g, '/').replace(/\/+$/, '')
  const parts = cleaned.split('/').filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : ''
}

function materialName(job: JobLabelInput): string {
  // 明确的文件名优先；upload_id 只有在本身像文件名（带扩展名）时才用，避免把 `up-…` 当素材名。
  const named = [
    job.input,
    job.source,
    job.source_image,
    job.uploadName,
    job.upload_name,
    job.uploadId,
    job.upload_id,
    job.source_upload_id
  ]
  for (const candidate of named) {
    const name = jobBasename(candidate)
    if (name && name.includes('.')) return name
  }
  // 纯文件名（无扩展名）仍可用于 input/source/uploadName。
  for (const candidate of [job.input, job.source, job.uploadName, job.upload_name]) {
    const name = jobBasename(candidate)
    if (name) return name
  }
  return ''
}

function typeLabel(type: string): string {
  if (type === 'image') return '图片生成'
  if (type === 'optimize') return 'B 轨优化'
  if (type === 'aigc') return 'A 轨生成'
  return '任务'
}

function railTag(job: JobLabelInput): string {
  const raw = text(job.rail) || text(job.track)
  if (!raw) return ''
  if (raw === 'A' || raw === 'A轨') return 'A 轨'
  if (raw === 'B' || raw === 'B轨') return 'B 轨'
  if (raw === 'both' || raw === 'AB' || raw === 'A/B' || raw === '双轨') return '双轨'
  return ''
}

function formatStamp(value: string | null | undefined): string {
  const raw = text(value)
  if (!raw) return ''
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function statusText(status: string): string {
  if (!status) return ''
  if (status === 'done' || status === 'succeeded' || status === 'success' || status === 'completed') return '完成'
  if (status === 'failed' || status === 'error' || status === 'canceled' || status === 'cancelled') return '失败'
  if (status === 'blocked') return '阻塞'
  if (status === 'queued' || status === 'pending' || status === 'running' || status === 'in_progress') return '进行中'
  return ''
}

/**
 * 标题兜底：B 轨任务没有 type/素材字段，但 `title` 本身是人写的可读信息。
 * 若标题里只是回显 id（studio fallback 的「创作工坊任务 · web-…」），则不采用。
 */
function titleFallback(job: JobLabelInput): string {
  const title = text(job.title)
  const id = text(job.id)
  if (!title || title === '任务') return ''
  if (id && title.includes(id)) return ''
  return title.length > 40 ? `${title.slice(0, 40)}…` : title
}

/** 主标签，例如 `A 轨生成 · IMG_3189.MOV · 11-13 12:03 · 完成`。 */
export function jobReadable(job: JobLabelInput | null | undefined): string {
  if (!job) return '任务'
  const type = text(job.type)
  const rail = railTag(job)
  const base = typeLabel(type)
  const parts: string[] = [base]

  // type 已经带轨别（如「A 轨生成」）时不再重复追加。
  if (rail && !base.startsWith(rail)) parts.push(rail)

  const material = materialName(job)
  if (material) parts.push(material)
  else {
    const fallback = titleFallback(job)
    if (fallback) parts.push(fallback)
  }

  const when = formatStamp(job.created_at ?? job.createdAt)
  if (when) parts.push(when)

  const state = statusText(text(job.status))
  if (state) parts.push(state)

  return parts.join(' · ')
}

/** 可读缩略 id：`web-20261113093155-3ef5f3` → `…3ef5f3`。 */
export function jobIdShort(id: string | null | undefined): string {
  const value = text(id)
  if (!value) return ''
  if (value.length <= 10) return value
  return `…${value.slice(-6)}`
}

/** 主标签 + 缩略 id（需要「小号等宽」的样式由调用方决定）。 */
export function jobLabelWithId(job: JobLabelInput | null | undefined): string {
  const label = jobReadable(job)
  const short = jobIdShort(job?.id)
  return short ? `${label} · ${short}` : label
}

/** 页面上真实出现的可读字段（状态、判据、分辨率、阶段等），筛选要覆盖。 */
function displayedFields(job: JobLabelInput): Array<string | number | null | undefined> {
  const resolution =
    job.width && job.height ? `${job.width}×${job.height} ${job.width}x${job.height}` : ''
  const criteria =
    job.passed != null && job.judged != null ? `${job.passed}/${job.judged}` : ''
  return [
    job.id,
    job.title,
    job.taskId,
    job.type,
    job.rail,
    job.track,
    job.status,
    job.verdict,
    job.statusLabel,
    job.statusNote,
    job.stage,
    job.brief_id,
    job.width,
    job.height,
    job.fps,
    job.frames,
    job.passed,
    job.judged,
    job.total,
    job.durationS,
    job.duration_s,
    resolution,
    criteria
  ]
}

/**
 * 筛选：匹配原始 id、可读标签，以及页面上真实显示的文字。
 * 标题用未截断的完整 `title`，避免截断后的标签搜不到后半段。
 */
export function matchesJobQuery(job: JobLabelInput | null | undefined, query: string): boolean {
  const q = text(query).toLowerCase()
  if (!q) return true
  if (!job) return false
  const haystack = [jobReadable(job), ...displayedFields(job)]
    .map((value) => (value == null ? '' : String(value)).trim().toLowerCase())
    .join(' ')
  return haystack.includes(q)
}
