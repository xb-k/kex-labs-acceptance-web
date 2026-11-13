/**
 * #89b 生图工作台纯函数层：表单校验 / 提交 payload / gallery 映射 / 封面目标校验。
 * 组件（ImageWorkbench.tsx）只负责交互与渲染，便于 node:test 覆盖规则。
 */
import type {
  StudioGalleryItem,
  StudioImageMode,
  StudioImageRequest,
  StudioJobStatus,
  StudioKeyframeRef
} from './types'

export type ImageSize = { value: string; width: number; height: number; label: string; hint: string }

/** 与 server/studio.ts `IMAGE_SIZES` 保持一致（白名单三档）。 */
export const IMAGE_SIZES: ImageSize[] = [
  { value: '1536x864', width: 1536, height: 864, label: '横屏', hint: '1536×864' },
  { value: '864x1536', width: 864, height: 1536, label: '竖屏', hint: '864×1536' },
  { value: '1024x1024', width: 1024, height: 1024, label: '方形', hint: '1024×1024' }
]

export const DEFAULT_IMAGE_SIZE = IMAGE_SIZES[0].value
export const DEFAULT_STEPS = '20'
export const DEFAULT_SEED = '0'
export const DEFAULT_EDIT_DENOISE = '0.6'
export const T2I_DENOISE = '1'

export type ImageFormInput = {
  mode: StudioImageMode
  prompt: string
  negative: string
  size: string
  seed: string
  steps: string
  denoise: string
  sourceUploadId?: string | null
  sourceImage?: string
}

export type ImageFormResult =
  | { ok: true; image: StudioImageRequest }
  | { ok: false; error: string; field?: 'prompt' | 'size' | 'seed' | 'steps' | 'denoise' | 'source' }

function parseInteger(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (!/^-?\d+$/.test(trimmed)) return null
  const parsed = Number(trimmed)
  return Number.isSafeInteger(parsed) ? parsed : null
}

export function parseImageSize(value: string): ImageSize | null {
  return IMAGE_SIZES.find((size) => size.value === value) ?? null
}

/**
 * 前端校验规则与后端 `validateImageRequest` 对齐：
 * - prompt 必填；尺寸三档白名单；seed 0..4294967295；steps 1..100
 * - t2i 固定 denoise=1.0（即使表单里残留其它值也强制 1）
 * - edit 必须且只能用「已上传参考图 / studio 绝对路径」二选一
 */
export function validateImageForm(input: ImageFormInput): ImageFormResult {
  const prompt = input.prompt.trim()
  if (!prompt) return { ok: false, error: '请填写 prompt。', field: 'prompt' }

  const size = parseImageSize(input.size)
  if (!size) {
    return { ok: false, error: '尺寸仅支持 1536×864 / 864×1536 / 1024×1024。', field: 'size' }
  }

  const seed = parseInteger(input.seed)
  if (seed === null || seed < 0 || seed > 0xffffffff) {
    return { ok: false, error: 'seed 需为 0..4294967295 的整数。', field: 'seed' }
  }

  const steps = parseInteger(input.steps)
  if (steps === null || steps < 1 || steps > 100) {
    return { ok: false, error: 'steps 需为 1..100 的整数。', field: 'steps' }
  }

  let denoise = 1
  if (input.mode === 'edit') {
    const parsed = Number(input.denoise)
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
      return { ok: false, error: 'denoise 需在 (0, 1] 内。', field: 'denoise' }
    }
    denoise = parsed
  }

  const image: StudioImageRequest = {
    mode: input.mode,
    prompt,
    negative: input.negative.trim(),
    width: size.width,
    height: size.height,
    seed,
    steps,
    denoise
  }

  if (input.mode === 'edit') {
    const uploadId = (input.sourceUploadId ?? '').trim()
    const sourceImage = (input.sourceImage ?? '').trim()
    if (uploadId && sourceImage) {
      return { ok: false, error: '参考图二选一：已上传文件或 studio 绝对路径。', field: 'source' }
    }
    if (!uploadId && !sourceImage) {
      return { ok: false, error: 'Edit 模式必须上传参考图，或填写 studio 上已存在的绝对路径。', field: 'source' }
    }
    if (sourceImage && !sourceImage.startsWith('/')) {
      return { ok: false, error: '参考图路径需为 studio 上的绝对路径。', field: 'source' }
    }
    if (uploadId) image.source_upload_id = uploadId
    else image.source_image = sourceImage
  }

  return { ok: true, image }
}

/** `POST /api/studio/jobs` 的 image 任务体。 */
export function buildImageJobPayload(image: StudioImageRequest): {
  type: 'image'
  image: StudioImageRequest
} {
  return { type: 'image', image }
}

export type AigcPayloadInput = {
  briefId: string | null
  /** 二选一：已上传视频 / studio 绝对路径。 */
  uploadId?: string | null
  input?: string | null
  /** 从生图工作台选中的关键帧（仅 shot 1，v1）。 */
  keyframe?: StudioKeyframeRef | null
}

/**
 * A 轨提交 payload。未选关键帧时**不含** `keyframe_asset` 键，保持旧请求逐字节不变。
 */
export function buildAigcJobPayload(input: AigcPayloadInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    type: 'aigc',
    rail: 'A',
    brief_id: input.briefId
  }
  const absolute = (input.input ?? '').trim()
  if (absolute) payload.input = absolute
  else if (input.uploadId) payload.upload_id = input.uploadId
  if (input.keyframe) {
    payload.keyframe_asset = {
      source_job: input.keyframe.source_job,
      name: input.keyframe.name
    }
  }
  return payload
}

const JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const IMAGE_NAME_RE = /\.(png|jpe?g|webp)$/i

/** 封面目标校验：目标 job id + 选中图片名（只接受 basename，防路径注入）。 */
export function validateCoverTarget(
  targetJob: string,
  sourceJob: string,
  name: string
): { ok: true; target: string; body: { source_job: string; name: string } } | { ok: false; error: string } {
  const target = targetJob.trim()
  if (!target) return { ok: false, error: '请填写目标 job id，或从最近任务中选择。' }
  if (!JOB_ID_RE.test(target)) return { ok: false, error: '目标 job id 非法（仅字母数字 . _ -，≤64 字符）。' }
  if (!sourceJob || !JOB_ID_RE.test(sourceJob)) return { ok: false, error: '选中图片的来源 job 非法。' }
  if (!name || name !== name.split('/').pop() || name.startsWith('.') || !IMAGE_NAME_RE.test(name)) {
    return { ok: false, error: '图片名非法：仅支持 png / jpg / jpeg / webp 文件名。' }
  }
  return { ok: true, target, body: { source_job: sourceJob, name } }
}

/**
 * 封面 / 关键帧按钮的启用条件（#89d UI）：
 * 未选中图片时两个按钮都禁用；封面写入中只禁用封面，关键帧仍可用。
 * 组件与测试共用同一规则，避免「选中了却仍 disabled」的口径漂移。
 */
export function imageActionState(input: { hasSelection: boolean; coverBusy: boolean }): {
  coverDisabled: boolean
  keyframeDisabled: boolean
} {
  return {
    coverDisabled: input.coverBusy || !input.hasSelection,
    keyframeDisabled: !input.hasSelection
  }
}

/**
 * #112 参考图面板始终可达：T2I 也显示上传入口；上传完成后提示「仅 Edit 参与生成」，
 * 并给一键切换到 Edit（不自动切换，避免用户没察觉模式被改掉）。
 */
export function referencePanelState(input: {
  mode: StudioImageMode
  uploadId: string | null
  uploading: boolean
}): {
  canUpload: boolean
  showReady: boolean
  showSwitchToEdit: boolean
  canClear: boolean
  note: string
} {
  const hasUpload = Boolean(input.uploadId)
  const note =
    input.mode === 't2i'
      ? hasUpload
        ? '参考图已上传，但当前是文生图模式：参考图仅 Edit 模式参与生成。'
        : '参考图仅 Edit 模式参与生成；文生图模式下上传不会影响本次任务。'
      : hasUpload
        ? '参考图已就绪，提交时作为 source_upload_id 转发到 studio。'
        : 'Edit 模式必须上传参考图，或填写 studio 绝对路径。'
  return {
    canUpload: !input.uploading,
    showReady: hasUpload,
    showSwitchToEdit: input.mode === 't2i' && hasUpload,
    canClear: hasUpload && !input.uploading,
    note
  }
}

const STATUS_LABEL: Record<StudioJobStatus, string> = {
  queued: '排队中',
  running: '生成中',
  succeeded: '已完成',
  failed: '失败',
  canceled: '已取消'
}

export function galleryStatusLabel(status: StudioJobStatus): string {
  return STATUS_LABEL[status] ?? status
}

/** #136 图片任务等待阶段：提交 → 排队 → 生成 → 完成（终态也停留在对应阶段）。 */
export const IMAGE_WAIT_STAGES = ['提交请求', '排队等待', '模型生成', '完成'] as const

export type ImageWaitStage = {
  /** 0-based，用于 AsyncStatusLine 的 stage。 */
  stage: number
  label: string
}

export function imageWaitStage(status: StudioJobStatus | null | undefined): ImageWaitStage {
  switch (status) {
    case 'queued':
      return { stage: 1, label: '已入队，等待 GPU 排队' }
    case 'running':
      return { stage: 2, label: '模型正在生成图片' }
    case 'succeeded':
      return { stage: 3, label: '图片生成完成' }
    case 'failed':
      return { stage: 2, label: '图片生成失败' }
    case 'canceled':
      return { stage: 2, label: '图片任务已取消' }
    default:
      return { stage: 1, label: '已提交，等待 studio 返回状态' }
  }
}

/** #136 图片 job 终态耗时：后端 `duration_ms` 优先，缺失时回退本地测得的墙钟；都不合法则不展示。 */
export function imageJobDurationMs(
  jobDurationMs: number | null | undefined,
  measuredMs: number | null | undefined
): number | undefined {
  for (const value of [jobDurationMs, measuredMs]) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  }
  return undefined
}

/** #136 只有 queued / running 的图片 job 显示取消；终态或未知状态不渲染取消，避免假取消。 */
export function canCancelImageJob(status: StudioJobStatus | null | undefined): boolean {
  return status === 'queued' || status === 'running'
}

/**
 * #139 真实耗时展示：`duration_ms` 为 null 时不估算，直接给「耗时未记录」。
 * <60s 保留一位小数（12.3s），≥60s 用 `1m 03s`；负值 / 非有限值按未记录处理。
 */
export function formatJobDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '耗时未记录'
  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 60) return `耗时 ${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `耗时 ${minutes}m ${String(seconds).padStart(2, '0')}s`
}

/** #140 只有 failed / canceled 的 job 可删；其余状态不显示删除入口。 */
export function canDeleteJob(status: StudioJobStatus): boolean {
  return status === 'failed' || status === 'canceled'
}

export type JobDeletePlan = { url: string; description: string }

/** #140 删除请求与二次确认文案（含 job id / 状态），组件与测试共用同一口径。 */
export function buildJobDeletePlan(job: { id: string; status: StudioJobStatus }): JobDeletePlan | null {
  if (!canDeleteJob(job.status)) return null
  return {
    url: `/api/studio/jobs/${encodeURIComponent(job.id)}`,
    description: `删除任务 ${job.id}（${galleryStatusLabel(job.status)}）？会同时移除它的产物与元数据，无法恢复。`
  }
}

/** gallery 卡片的缩略图 / 大图统一取代理 URL（后端保证是 /api/studio/... 同源路径）。 */
export function galleryPrimaryImage(item: StudioGalleryItem): { name: string; url: string } | null {
  return item.images.length > 0 ? item.images[0] : null
}

export function galleryMeta(item: StudioGalleryItem): string {
  const parts: string[] = []
  if (item.mode) parts.push(item.mode === 't2i' ? 'T2I' : 'Edit')
  if (item.width && item.height) parts.push(`${item.width}×${item.height}`)
  if (item.steps != null) parts.push(`${item.steps} steps`)
  if (item.seed != null) parts.push(`seed ${item.seed}`)
  // #139 耗时由 formatJobDuration 单独展示，这里不再重复。
  return parts.join(' · ')
}
