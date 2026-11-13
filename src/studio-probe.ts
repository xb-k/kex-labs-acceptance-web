import type { StudioBrief, StudioPolished } from './types'

/**
 * `POST /api/uploads/:id/probe` 的响应（#86 C4，studio intake 原样透传）。
 * 只声明 UI 需要的字段；未知字段忽略。
 */
export type UploadProbeResponse = {
  probe?: {
    width?: number | null
    height?: number | null
    fps?: number | null
    duration_s?: number | null
    bitrate_bps?: number | null
    bitrate_mbps?: number | null
    codec?: string | null
    has_audio?: boolean | null
    audio_codec?: string | null
  } | null
  shots?: {
    count?: number | null
    items?: Array<{ shot_id?: number; start?: number; end?: number; duration_s?: number }>
    backend?: string | null
    degraded?: string | null
  } | null
  shots_reason?: string | null
  plan?: {
    steps?: Array<{
      id?: string
      code?: string
      label?: string
      detail?: string
      reason?: string
      hint?: boolean
      params?: Record<string, unknown>
    }> | null
    risks?: Array<{ code?: string; level?: string; message?: string } | string> | null
  } | null
}

export type ProbeFact = { label: string; value: string }

function num(value: number, digits = 2): string {
  return String(Number(value.toFixed(digits)))
}

/** probe 关键事实（分辨率 / 时长 / 帧率 / 码率 / 音轨 / 镜数），缺失时显示「未知」。 */
export function probeFacts(body: UploadProbeResponse | null): ProbeFact[] {
  const probe = body?.probe ?? null
  const shots = body?.shots ?? null
  const width = typeof probe?.width === 'number' ? probe.width : null
  const height = typeof probe?.height === 'number' ? probe.height : null
  const duration = typeof probe?.duration_s === 'number' ? probe.duration_s : null
  const fps = typeof probe?.fps === 'number' ? probe.fps : null
  const bitrateBps = typeof probe?.bitrate_bps === 'number' ? probe.bitrate_bps : null
  const bitrateMbps = typeof probe?.bitrate_mbps === 'number' ? probe.bitrate_mbps : null
  const count =
    typeof shots?.count === 'number'
      ? shots.count
      : Array.isArray(shots?.items)
        ? shots.items.length
        : null

  const audio =
    probe?.has_audio === true
      ? probe.audio_codec
        ? `有（${probe.audio_codec}）`
        : '有'
      : probe?.has_audio === false
        ? '无音轨'
        : '未知'

  const shotCount =
    count !== null && count > 0
      ? `${count} 镜${shots?.backend ? `（${shots.backend}）` : ''}`
      : body?.shots_reason
        ? `未识别（${body.shots_reason}）`
        : '未知'

  return [
    { label: '分辨率', value: width !== null && height !== null ? `${width}×${height}` : '未知' },
    { label: '时长', value: duration !== null ? `${num(duration)} s` : '未知' },
    { label: '帧率', value: fps !== null ? `${num(fps)} fps` : '未知' },
    {
      label: '码率',
      value:
        bitrateBps !== null
          ? `${(bitrateBps / 1_000_000).toFixed(2)} Mbps`
          : bitrateMbps !== null
            ? `${num(bitrateMbps)} Mbps`
            : '未知'
    },
    { label: '音轨', value: audio },
    { label: '镜数', value: shotCount }
  ]
}

export type PlanStepRow = { key: string; title: string; detail: string | null; hint: boolean }

/** `plan.steps` → 展示行；兼容 label/detail 与 code/reason 两种命名。 */
export function planStepRows(body: UploadProbeResponse | null): PlanStepRow[] {
  const steps = body?.plan?.steps ?? []
  return steps.map((step, index) => ({
    key: step.id ?? step.code ?? `step-${index}`,
    title: step.label ?? step.code ?? step.id ?? `步骤 ${index + 1}`,
    detail: step.detail ?? step.reason ?? null,
    hint: step.hint === true
  }))
}

export type PlanRiskRow = { level: 'blocked' | 'warn' | 'info'; text: string }

/** `plan.risks` → 展示行；level 归一到 blocked / warn / info。 */
export function planRiskRows(body: UploadProbeResponse | null): PlanRiskRow[] {
  const risks = body?.plan?.risks ?? []
  return risks.map((risk) => {
    if (typeof risk === 'string') return { level: 'warn', text: risk }
    const level: PlanRiskRow['level'] =
      risk.level === 'blocked' || risk.level === 'error'
        ? 'blocked'
        : risk.level === 'warn' || risk.level === 'warning'
          ? 'warn'
          : 'info'
    return { level, text: risk.message ?? risk.code ?? '风险提示' }
  })
}

export type OptimizeJobPayload = {
  type: 'optimize'
  rail: 'B'
  upload_id: string
  brief_id?: string
  polished?: StudioPolished | null
}

/** B 轨提交参数：无 Brief 时不带 brief_id/polished，保持与 A 轨同样的「无 Brief」语义。 */
export function buildOptimizeJobPayload(
  uploadId: string,
  brief: StudioBrief | null
): OptimizeJobPayload {
  const payload: OptimizeJobPayload = { type: 'optimize', rail: 'B', upload_id: uploadId }
  if (brief) {
    payload.brief_id = brief.id
    payload.polished = brief.polished
  }
  return payload
}
