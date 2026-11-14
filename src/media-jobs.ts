/**
 * NAS 媒体（#160）前端只读工具：`GET /api/media/jobs` 的归一化、按任务过滤、
 * 缩略优先序与 URL 构造。纯函数，SSR / 单测直接断言，不碰 DOM。
 *
 * 后端响应实际字段是 `{ jobs, total, limit, offset }`；同时兼容 `{ items }`
 * 形态，避免契约文档（`items`）与实现（`jobs`）漂移时前端整体空白。
 */

export type MediaJobKind = 'video' | 'image' | 'audio'

export type MediaJobItem = {
  job_id: string
  name: string
  path: string
  url: string
  size: number
  bytes: number
  mtime: string
  kind: MediaJobKind
}

export type MediaJobsResponse = {
  jobs?: MediaJobItem[]
  items?: MediaJobItem[]
  total?: number
  limit?: number
  offset?: number
}

/** 详情/工坊列表统一取 100 条（NAS 现有媒体远小于该量级）。 */
export const MEDIA_JOBS_URL = '/api/media/jobs?limit=100'

/** 永久删除 NAS 文件的确认文案（交付页 / 工坊详情 / 单测共用）。 */
export const MEDIA_DELETE_CONFIRM = '永久删除 NAS 文件，不可恢复'

const KIND_RANK: Record<MediaJobKind, number> = { video: 0, image: 1, audio: 2 }

function isMediaItem(value: unknown): value is MediaJobItem {
  if (!value || typeof value !== 'object') return false
  const rec = value as Record<string, unknown>
  return (
    typeof rec.job_id === 'string' &&
    typeof rec.name === 'string' &&
    typeof rec.url === 'string' &&
    (rec.kind === 'video' || rec.kind === 'image' || rec.kind === 'audio')
  )
}

/** 归一化列表响应：优先 `jobs`，兼容 `items`；脏数据逐条丢弃。 */
export function mediaItemsOf(response: MediaJobsResponse | null | undefined): MediaJobItem[] {
  const raw = response?.jobs ?? response?.items
  if (!Array.isArray(raw)) return []
  return raw.filter(isMediaItem)
}

/** 规范文件名优先：final.mp4 / image-01.png 排在同类型最前，其余按修改时间倒序。 */
function nameRank(name: string): number {
  return name === 'final.mp4' || name === 'image-01.png' ? 0 : 1
}

/** 某个任务的 NAS 媒体，视频 → 图片 → 音频；同类型主成片优先、再按 mtime 倒序。 */
export function mediaForJob(items: MediaJobItem[], jobId: string | null | undefined): MediaJobItem[] {
  if (!jobId) return []
  return items
    .filter((item) => item.job_id === jobId)
    .sort(
      (a, b) =>
        KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
        nameRank(a.name) - nameRank(b.name) ||
        b.mtime.localeCompare(a.mtime) ||
        a.name.localeCompare(b.name)
    )
}

/** 工坊缩略：按任务类型取 NAS 视频（final.mp4 优先）或图片（image-01.png 优先）。 */
export function pickJobMedia(
  items: MediaJobItem[],
  jobId: string | null | undefined,
  prefer: 'video' | 'image'
): MediaJobItem | null {
  return mediaForJob(items, jobId).find((item) => item.kind === prefer) ?? null
}

/** 下载地址：后端 `download=1` 时补 Content-Disposition，浏览器直接落盘。 */
export function mediaDownloadUrl(item: MediaJobItem): string {
  return `${item.url}?download=1`
}

/** 物理删除走同一资源 URL 的 DELETE（后端 unlink + 审计）。 */
export function mediaDeleteUrl(item: MediaJobItem): string {
  return item.url
}

/** 交付页 media 行判定：合并后的 NAS 视频 `mp4` 指向 `/api/media/jobs/...`。 */
export function isMediaDeliveryUrl(mp4: string | null | undefined): boolean {
  return typeof mp4 === 'string' && mp4.startsWith('/api/media/jobs/')
}
