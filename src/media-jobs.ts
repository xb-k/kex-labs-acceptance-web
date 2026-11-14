/**
 * NAS 媒体（#160）前端只读工具：`GET /api/media/jobs` 的归一化、按任务过滤、
 * 缩略优先序与 URL 构造。纯函数，SSR / 单测直接断言，不碰 DOM。
 *
 * 后端响应实际字段是 `{ jobs, total, limit, offset }`；同时兼容 `{ items }`
 * 形态，避免契约文档（`items`）与实现（`jobs`）漂移时前端整体空白。
 */

import type { FlowArtifact } from './types'

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

/** 生产总台按任务过滤 NAS 成片（#160）：单次取 200 条覆盖现有归档量。 */
export const MEDIA_JOBS_TRACKER_URL = '/api/media/jobs?limit=200'

/** NAS 产物在阶段节点里的统一 label；不区分具体阶段，避免伪造。 */
export const NAS_ARTIFACT_LABEL = 'NAS 成片/图片'

/** 成片只可能在 D/E/F 出现；早期节点（抽帧/重绘）不冒领 NAS 成片。 */
const NAS_ARTIFACT_STAGE_KEYS = new Set(['D', 'E', 'F'])

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

/**
 * 把某个任务的 NAS 媒体映射成阶段节点产物（#160）。
 * - 只允许 D/E/F 复用：F 展示 final.mp4（及同任务图片），D/E 只复用视频；
 * - 早期节点没有对应 NAS 文件，返回空数组，不把成片挪到错误阶段。
 */
export function nasArtifactsForNode(
  items: MediaJobItem[],
  jobId: string | null | undefined,
  nodeKey: string | null | undefined
): FlowArtifact[] {
  if (!jobId || !nodeKey || !NAS_ARTIFACT_STAGE_KEYS.has(nodeKey)) return []
  const media = mediaForJob(items, jobId).filter((item) => nodeKey === 'F' || item.kind === 'video')
  return media.map((item) => ({
    path: `media/jobs/${item.job_id}/${item.name}`,
    exists: true,
    kind: item.kind,
    label: NAS_ARTIFACT_LABEL,
    rel: null,
    url: item.url
  }))
}

/**
 * 阶段节点产物解析：state.json 记录了真实产物就原样优先；
 * 只有 state 为空时才回退到该任务的 NAS 媒体，两者不混合、不伪造。
 */
export function resolveStageArtifacts(
  stateArtifacts: FlowArtifact[] | null | undefined,
  mediaItems: MediaJobItem[],
  jobId: string | null | undefined,
  nodeKey: string | null | undefined
): FlowArtifact[] {
  if (stateArtifacts && stateArtifacts.length > 0) return stateArtifacts
  return nasArtifactsForNode(mediaItems, jobId, nodeKey)
}
