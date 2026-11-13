import type { FlowJob, FlowStage, StudioBrief } from '../../types'

export type AgentRoleId = 'all' | 'cinematographer' | 'director' | 'writer' | 'editor' | 'colorist' | 'audio'

export type AgentRoleMeta = {
  id: Exclude<AgentRoleId, 'all'>
  name: string
  en: string
  stageKeys: string[]
  modelOrTool: string
  accentBg: string
  accentText: string
  accentBorder: string
}

export const AGENT_ROLES: AgentRoleMeta[] = [
  {
    id: 'cinematographer',
    name: '摄影',
    en: 'Cinematographer',
    stageKeys: ['A'],
    modelOrTool: 'PySceneDetect · ffmpeg',
    accentBg: 'bg-[#F0F6FF]',
    accentText: 'text-[#0062C4]',
    accentBorder: 'border-[#D6E6FF]'
  },
  {
    id: 'director',
    name: '导演',
    en: 'Director',
    stageKeys: ['B', 'B2'],
    modelOrTool: 'Qwen2-VL-7B · typology_map',
    accentBg: 'bg-[#F5F3FF]',
    accentText: 'text-[#5B21B6]',
    accentBorder: 'border-[#E4DDFF]'
  },
  {
    id: 'writer',
    name: '编剧 / 美指',
    en: 'Writer & LookDev',
    stageKeys: ['C'],
    modelOrTool: 'SDXL / FLUX · Prompt v1.4',
    accentBg: 'bg-[#FFF7ED]',
    accentText: 'text-[#B45309]',
    accentBorder: 'border-[#FDE2C4]'
  },
  {
    id: 'editor',
    name: '后期 / 动画',
    en: 'I2V & Editor',
    stageKeys: ['D'],
    modelOrTool: 'LTX-2B I2V · RIFE',
    accentBg: 'bg-[#ECFEFF]',
    accentText: 'text-[#0E7490]',
    accentBorder: 'border-[#CFFAFE]'
  },
  {
    id: 'colorist',
    name: '调色',
    en: 'Colorist',
    stageKeys: ['E'],
    modelOrTool: 'Real-ESRGAN · grade_color',
    accentBg: 'bg-[#FDF2F8]',
    accentText: 'text-[#9D174D]',
    accentBorder: 'border-[#FBCFE8]'
  },
  {
    id: 'audio',
    name: '音频 / 质检',
    en: 'Audio & QC',
    stageKeys: ['F'],
    modelOrTool: 'assemble · quality_check · NAS',
    accentBg: 'bg-[#EAF8EE]',
    accentText: 'text-[#1E7A3C]',
    accentBorder: 'border-[#CDEED6]'
  }
]

export type PipelineNodeSpec = {
  key: string
  code: string
  title: string
  toolChain: string
  role: Exclude<AgentRoleId, 'all'>
  memoryNote: string
  status: 'done' | 'running' | 'pending' | 'failed'
  durationS: number | null
  progressNote: string
  contractSummary: string
}

export type ShotRoleAction = {
  id: string
  role: Exclude<AgentRoleId, 'all'>
  stageKey: string
  tool: string
  timestamp: string
  actionTitle: string
  inputFact: string
  decisionReason: string
  outputSummary: string
  diffBefore?: string
  diffAfter?: string
  candidates?: Array<{ name: string; score: string; picked: boolean; note: string }>
  metrics?: Array<{ label: string; value: string; pass: boolean | 'unknown' }>
}

export type ShotStoryboardItem = {
  shotId: number
  label: string
  startS: number | null
  endS: number | null
  durationS: number | null
  sceneSummary: string
  pacingTag: string
  media: {
    originalFrame: string | null
    redrawnFrame: string | null
    i2vClip: string | null
    gradedClip: string | null
  }
  actions: ShotRoleAction[]
}

const ROLE_BY_STAGE: Record<string, Exclude<AgentRoleId, 'all'>> = {
  A: 'cinematographer',
  B: 'director',
  B2: 'director',
  SCRIPT: 'writer',
  C: 'writer',
  D: 'editor',
  E: 'colorist',
  F: 'audio'
}

export type QcBadgeState = 'pass' | 'fail' | 'unknown'

/** 调色 ΔE2000 p95 的硬门禁阈值（与 policy/quality_thresholds.json 一致）。 */
export const QC_COLOR_P95_THRESHOLD = 6

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function numberOf(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/**
 * 只读取 job 里真实存在的质量指标。先看 quality_gate，再看 quality；
 * 同时兼容 `{ checks: [{ name, value }] }` 结构。缺失返回 null（上层显示「未记录」）。
 */
export function readQualityMetric(
  job: FlowJob | null | undefined,
  keys: string[]
): number | null {
  for (const source of [asRecord(job?.quality_gate), asRecord(job?.quality)]) {
    if (!source) continue
    for (const key of keys) {
      const value = numberOf(source[key])
      if (value !== null) return value
    }
    const checks = Array.isArray(source.checks) ? source.checks : []
    for (const item of checks) {
      const check = asRecord(item)
      if (!check || typeof check.name !== 'string' || !keys.includes(check.name)) continue
      const value = numberOf(check.value)
      if (value !== null) return value
    }
  }
  return null
}

/**
 * QC 徽标：只有真实 `color_p95_de2000` 存在才可能显示 pass；
 * 缺失或非数字一律 unknown，绝不回落到固定 PASS。
 */
export function qcBadgeState(job: FlowJob | null | undefined): QcBadgeState {
  const colorP95 = readQualityMetric(job, ['color_p95_de2000', 'color_p95_delta_e2000'])
  if (colorP95 === null) return 'unknown'
  const verdict = asRecord(job?.quality_gate)?.verdict
  if (typeof verdict === 'string' && verdict.toUpperCase() === 'FAIL') return 'fail'
  return colorP95 <= QC_COLOR_P95_THRESHOLD ? 'pass' : 'fail'
}

export function qcBadgeLabel(state: QcBadgeState): string {
  if (state === 'pass') return '门禁 PASS'
  if (state === 'fail') return '门禁 FAIL'
  return '门禁判定未记录'
}

export function qualityMetric(
  job: FlowJob | null | undefined,
  label: string,
  keys: string[],
  threshold: number,
  op: 'lte' | 'gte',
  unit = ''
): { label: string; value: string; pass: boolean | 'unknown' } {
  const value = readQualityMetric(job, keys)
  if (value === null) return { label, value: '未记录', pass: 'unknown' }
  const ok = op === 'lte' ? value <= threshold : value >= threshold
  const symbol = op === 'lte' ? '≤' : '≥'
  return { label, value: `${value} ${symbol} ${threshold}${unit}`, pass: ok }
}

function probeLabelOf(job: FlowJob | null | undefined): string {
  const probe = asRecord(job?.probe)
  const fps = numberOf(probe?.fps)
  const width = numberOf(probe?.width)
  const height = numberOf(probe?.height)
  const parts: string[] = []
  if (fps !== null) parts.push(`${fps}fps`)
  if (width !== null && height !== null) parts.push(`${width}×${height}`)
  return parts.length ? parts.join(' / ') : '规格未记录'
}

function stageTimeLabel(job: FlowJob | null | undefined, stageKey: string, label: string): string {
  const stage = job?.stages?.find((s) => s.key === stageKey)
  if (!stage?.updated_at) return label
  const date = new Date(stage.updated_at)
  if (Number.isNaN(date.getTime())) return label
  return `${label} · ${date.toLocaleString('zh-CN', { hour12: false })}`
}

function seedOf(job: FlowJob | null | undefined, stageKey: string, index: number): number | null {
  const prompts = job?.stages?.find((s) => s.key === stageKey)?.prompts ?? []
  const prompt = prompts[index] ?? prompts.find((p) => p.shot_id === index + 1)
  return numberOf(prompt?.seed)
}

export function buildPipelineNodes(
  job: FlowJob | null,
  options?: {
    scriptStatus?: PipelineNodeSpec['status']
    brief?: StudioBrief | null
  }
): PipelineNodeSpec[] {
  const stageMap = new Map<string, FlowStage>()
  for (const s of job?.stages ?? []) {
    stageMap.set(s.key, s)
  }

  const statusOf = (key: string): PipelineNodeSpec['status'] => {
    if (key === 'B2') {
      const b = stageMap.get('B')?.status
      if (job?.profile) return 'done'
      return b === 'done' ? 'done' : 'pending'
    }
    if (key === 'SCRIPT') {
      if (options?.scriptStatus) return options.scriptStatus
      if (options?.brief?.polished) return 'done'
      const c = stageMap.get('C')?.status
      if (c === 'done' || c === 'running') return 'done'
      return stageMap.get('B')?.status === 'done' ? 'done' : 'pending'
    }
    const s = stageMap.get(key)?.status
    if (s === 'done' || s === 'succeeded') return 'done'
    if (s === 'running') return 'running'
    if (s === 'failed' || s === 'error') return 'failed'
    return 'pending'
  }

  const profileName = typeof job?.profile?.name === 'string' ? job.profile.name : null
  const memFree = numberOf((job?.cold_warm as Record<string, unknown> | null)?.free_mem_gb)
  const semantics = asRecord(job?.semantics)
  const typology = typeof semantics?.typology === 'string' ? semantics.typology : '未记录'
  const confidence = numberOf(semantics?.confidence)
  const confidenceLabel = confidence === null ? '未记录' : confidence.toFixed(2)
  const qcState = qcBadgeState(job)
  const colorP95 = readQualityMetric(job, ['color_p95_de2000', 'color_p95_delta_e2000'])
  const probeLabel = probeLabelOf(job)
  const briefShotsCount = options?.brief?.polished?.shots?.length ?? job?.shots?.length ?? 0

  return [
    {
      key: 'A',
      code: 'Phase A',
      title: '探测与切镜抽帧',
      toolChain: 'probe_video → split_shots → extract_frames',
      role: 'cinematographer',
      memoryNote: 'CPU / ffmpeg · 无重模型',
      status: statusOf('A'),
      durationS: stageMap.get('A')?.duration_s ?? null,
      progressNote: job?.shots?.length ? `切出 ${job.shots.length} 镜 · 抽取 ${job.frames.length || job.shots.length} 帧` : '待探测',
      contractSummary: 'PySceneDetect AdaptiveDetector 识别镜头边界，跳过运动模糊帧，输出 shots.json 与关键帧 PNG。'
    },
    {
      key: 'B',
      code: 'Phase B',
      title: 'VLM 关键帧语义打标',
      toolChain: 'describe_frames',
      role: 'director',
      memoryNote: 'Qwen2-VL-7B Q4 · ~6GB · 完结卸载',
      status: statusOf('B'),
      durationS: stageMap.get('B')?.duration_s ?? null,
      progressNote: `主识别：${typology}（置信度 ${confidenceLabel}）`,
      contractSummary: '全镜头批量理解场景、主体 bbox、光影方向与情绪张力；阶段末尾强制 keep_alive=0 卸载 Ollama。'
    },
    {
      key: 'B2',
      code: 'Phase B2',
      title: '语义定调 · Profile 挂载',
      toolChain: 'select_profile (L3 纯函数规则)',
      role: 'director',
      memoryNote: '零显存 · 规则表一票否决',
      status: statusOf('B2'),
      durationS: null,
      progressNote: `锁定风格：${profileName ?? '未记录'}`,
      contractSummary: '确定性查表 policy/typology_map 决定调色 LUT、BGM 基调与活人感参数，写入 decision log 可审计重放。'
    },
    {
      key: 'SCRIPT',
      code: 'Phase B3 · 编剧剧本',
      title: '视频剧本生成与处理',
      toolChain: 'polish_brief → build_shot_script',
      role: 'writer',
      memoryNote: '本地 LLM / Brief 契约 · 零 GPU 冲突',
      status: statusOf('SCRIPT'),
      durationS: null,
      progressNote:
        statusOf('SCRIPT') === 'running'
          ? '正在生成 Logline、分场旁白与结构化分镜剧本…'
          : options?.brief?.polished?.logline
            ? `已产出 ${briefShotsCount} 镜分镜剧本（${options.brief.status === 'confirmed' ? '已确认锁定' : '草稿可调'}）`
            : `已拆解 ${briefShotsCount} 镜旁白台词、运镜与时长节拍`,
      contractSummary:
        '编剧 Agent 依据视频创意主题与导演 Profile 生成 Logline、分段旁白剧本与逐镜运镜/画面提示词，锁定后下发至美指重绘与 I2V。'
    },
    {
      key: 'C',
      code: 'Phase C',
      title: 'SDXL 关键帧重绘',
      toolChain: 'render_frames',
      role: 'writer',
      memoryNote: 'SDXL Base 独占 ~8GB',
      status: statusOf('C'),
      durationS: stageMap.get('C')?.duration_s ?? null,
      progressNote: '注入反塑料纹理与参考图锁 · 全部镜头完结后 /free',
      contractSummary: '编剧与美指 Agent 按分镜剧本与参考主体生成版本化正负向 Prompt，保持咖啡杯/人物外观跨镜头一致。'
    },
    {
      key: 'D',
      code: 'Phase D',
      title: '逐镜头图生视频 I2V',
      toolChain: 'generate_clips',
      role: 'editor',
      memoryNote: memFree != null ? `LTX-2B 独占 · 余量 ${memFree}GB` : 'LTX-2B 独占 8~24GB · 单项锁',
      status: statusOf('D'),
      durationS: stageMap.get('D')?.duration_s ?? null,
      progressNote:
        statusOf('D') === 'running' ? '正在采样第 1 镜 · 单项锁保护中' : '多候选采样筛选低形变片段',
      contractSummary: '确认 Ollama/SDXL 均已释放后独占 Metal；每镜头多候选采样，剔除形变样本。'
    },
    {
      key: 'E',
      code: 'Phase E',
      title: '插帧 · 超分 · 色彩统一',
      toolChain: 'interpolate → upscale → grade_color',
      role: 'colorist',
      memoryNote: 'RIFE + Real-ESRGAN ~4GB + LUT',
      status: statusOf('E'),
      durationS: stageMap.get('E')?.duration_s ?? null,
      progressNote:
        statusOf('E') === 'done'
          ? `${probeLabel} · ${colorP95 === null ? 'ΔE2000 未记录' : `ΔE2000 p95=${colorP95}`}`
          : '排队等待阶段 D 释放模型锁',
      contractSummary: '先插帧，再超分，最后以第 1 镜为基准执行 L1+L2+L3 LAB 颜色匹配。'
    },
    {
      key: 'F',
      code: 'Phase F',
      title: '混音封装与 NAS 归档',
      toolChain: 'synthesize_audio → assemble → quality_check → archive',
      role: 'audio',
      memoryNote: '本地封装 · rsync 校验入 RAID1',
      status: statusOf('F'),
      durationS: stageMap.get('F')?.duration_s ?? null,
      progressNote:
        statusOf('F') === 'done'
          ? `${qcBadgeLabel(qcState)} · 已入冷归档`
          : '待阶段 E 输出调色片段',
      contractSummary: '混入非循环 BGM 与环境底噪，按 J-cut 变速剪辑并核验活人感与硬门禁指标，校验 sha256 后推入 NAS。'
    }
  ]
}

export function roleForStage(stageKey: string): AgentRoleMeta {
  const id = ROLE_BY_STAGE[stageKey] ?? 'director'
  return AGENT_ROLES.find((r) => r.id === id) ?? AGENT_ROLES[0]
}

/**
 * Derive rich per-shot storyboard + multi-agent processing actions directly from
 * `/api/flow` job state & media URLs. Works across both running and completed jobs.
 */
export function buildStoryboard(job: FlowJob | null, brief?: StudioBrief | null): ShotStoryboardItem[] {
  if (!job) return []

  const stageByKey = new Map(job.stages.map((s) => [s.key, s]))
  const findStageMedia = (stageKey: string, shotIndex: number, kind?: 'image' | 'video') => {
    const list = stageByKey.get(stageKey)?.artifacts ?? []
    const filtered = kind ? list.filter((a) => a.kind === kind && a.url) : list.filter((a) => a.url)
    return filtered[shotIndex]?.url ?? filtered[0]?.url ?? null
  }

  const shots = job.shots ?? []
  if (!shots.length) return []

  const semSubjectRaw = asRecord(asRecord(job.semantics)?.subject)?.name
  const semSubject = typeof semSubjectRaw === 'string' && semSubjectRaw.trim() ? semSubjectRaw : '主体未记录'
  const profileName = typeof job.profile?.name === 'string' ? job.profile.name : null
  const confidence = numberOf(asRecord(job.semantics)?.confidence)
  const confidenceLabel = confidence === null ? '未记录' : confidence.toFixed(2)
  const colorP95 = readQualityMetric(job, ['color_p95_de2000', 'color_p95_delta_e2000'])

  return shots.map((shot, idx) => {
    const shotNum = Number(shot.shot_id ?? idx + 1)
    const startS = shot.start ?? null
    const endS = shot.end ?? null
    const durationS =
      shot.duration_s ?? (startS !== null && endS !== null ? Number((endS - startS).toFixed(1)) : null)
    const durationLabel = durationS === null ? '未记录' : `${durationS.toFixed(1)}s`
    const rangeLabel =
      startS === null || endS === null ? '未记录' : `${startS.toFixed(1)}s – ${endS.toFixed(1)}s`

    const origFrame = findStageMedia('A', idx, 'image') ?? findStageMedia('B', idx, 'image')
    const redrawnFrame = findStageMedia('C', idx, 'image')
    const i2vClip = findStageMedia('D', idx, 'video')
    const gradedClip = findStageMedia('F', 0, 'video') ?? findStageMedia('E', idx, 'video')

    const sceneLabel = idx === 0 ? `${semSubject} · 主视角定场` : `第 ${shotNum} 镜 · 场景描述未记录`

    const actions: ShotRoleAction[] = [
      {
        id: `s${shotNum}-cine`,
        role: 'cinematographer',
        stageKey: 'A',
        tool: 'split_shots + extract_frames',
        timestamp: stageTimeLabel(job, 'A', 'Phase A'),
        actionTitle: `切出第 ${shotNum} 镜并避开运动模糊帧`,
        inputFact: `原片区间 ${rangeLabel}（镜头时长 ${durationLabel}）`,
        decisionReason:
          idx === 0
            ? 'PySceneDetect AdaptiveDetector 自动阈值；跳过开场对焦呼吸，取锐度最高帧作为基准。'
            : '保持非等长剪辑节奏，与相邻镜头形成呼吸差。',
        outputSummary: `输出 frames/shot_0${Math.min(2, shotNum)}.png 作为本镜语义与重绘基准帧`
      },
      {
        id: `s${shotNum}-dir`,
        role: 'director',
        stageKey: 'B2',
        tool: 'describe_frames → select_profile',
        timestamp: stageTimeLabel(job, 'B', 'Phase B / B2'),
        actionTitle: `语义锁定主体「${semSubject}」并挂载 ${profileName ?? '未记录'}`,
        inputFact: `Qwen2-VL 语义识别 · 置信度 ${confidenceLabel}`,
        decisionReason: `按 policy/typology_map 确定性映射为 ${profileName ?? '未记录'}；只改光影质地，不改变主体器型与数量。`,
        outputSummary: `挂载场景提示词 ${job.profile_prompt?.version ?? '版本未记录'} 与调色预设 ${profileName ? `looks/${profileName}.cube` : '未记录'}`
      },
      {
        id: `s${shotNum}-script`,
        role: 'writer',
        stageKey: 'SCRIPT',
        tool: 'polish_brief → build_shot_script',
        timestamp: stageTimeLabel(job, 'C', 'Phase B3'),
        actionTitle: `编写第 ${shotNum} 镜旁白台词与分镜剧本`,
        inputFact:
          brief?.polished?.shots?.[idx]
            ? `运镜「${brief.polished.shots[idx].camera ?? '自然手持'}」 · 时长 ${brief.polished.shots[idx].duration_s}s`
            : `创意大纲 + Profile ${profileName ?? '未记录'} · 镜号 ${shotNum}`,
        decisionReason:
          brief?.polished?.logline ??
          '围绕情绪呼吸差分配旁白留白与画面推进节拍，严禁机械匀速旁白叠加。',
        outputSummary:
          brief?.polished?.shots?.[idx]?.prompt ??
          `输出第 ${shotNum} 镜分镜剧本、旁白节拍与运镜约束至重绘 & I2V 节点`
      },
      {
        id: `s${shotNum}-writer`,
        role: 'writer',
        stageKey: 'C',
        tool: 'render_frames (SDXL)',
        timestamp: stageTimeLabel(job, 'C', 'Phase C'),
        actionTitle: `改写第 ${shotNum} 镜重绘 Prompt 并绑定固定 Seed`,
        inputFact: `剧本分镜词 + Profile ${profileName ?? '未记录'} · Seed ${seedOf(job, 'C', idx) ?? '未记录'}`,
        decisionReason: '补齐画面材质与胶片颗粒描述，负向词禁止“蜡像感/过度锐化/均匀平移”。',
        outputSummary: 'SDXL Base 生成关键帧，抽检纹理保持自然颗粒'
      },
      {
        id: `s${shotNum}-editor`,
        role: 'editor',
        stageKey: 'D',
        tool: 'generate_clips (LTX-2B)',
        timestamp: stageTimeLabel(job, 'D', 'Phase D'),
        actionTitle:
          job.stage === 'D' && idx === 0
            ? '正在执行 LTX-2B 多候选动态采样'
            : '从 I2V 采集中筛选最佳动态片段（弃用形变样本）',
        inputFact: `输入 ${redrawnFrame ? 'C 阶段重绘关键帧' : '关键帧未记录'}`,
        decisionReason:
          job.stage === 'D'
            ? '已确认 Ollama 与 SDXL 全部卸载，单镜头互斥锁已持有。'
            : '按形变与连续性筛选 I2V 候选片段。',
        outputSummary: job.stage === 'D' ? '采样进行中' : i2vClip ? '选定片段交付 Phase E 插帧超分' : 'I2V 片段未记录'
      },
      {
        id: `s${shotNum}-color`,
        role: 'colorist',
        stageKey: 'E',
        tool: 'interpolate → upscale → grade_color',
        timestamp: stageTimeLabel(job, 'E', 'Phase E'),
        actionTitle: '执行超分后三层色彩匹配（以 Shot 1 为参考基准）',
        inputFact: `插帧 → 超分 → ${profileName ?? 'Profile 未记录'} 调色`,
        decisionReason: '严禁“先调色再超分”防止重采样偏色；以 shot_01 做 LAB 均值/方差仿射。',
        outputSummary:
          colorP95 === null
            ? '跨镜头色彩漂移 ΔE2000 未记录'
            : `跨镜头色彩漂移 p95 ΔE2000 = ${colorP95}（≤ ${QC_COLOR_P95_THRESHOLD} 达标）`,
        metrics: [
          qualityMetric(job, 'ΔE2000 p95', ['color_p95_de2000', 'color_p95_delta_e2000'], QC_COLOR_P95_THRESHOLD, 'lte'),
          { label: '相邻帧亮度抖动', value: '未记录', pass: 'unknown' as const }
        ]
      },
      {
        id: `s${shotNum}-audio`,
        role: 'audio',
        stageKey: 'F',
        tool: 'synthesize_audio · quality_check · archive',
        timestamp: stageTimeLabel(job, 'F', 'Phase F'),
        actionTitle: '活人感混音节拍校验 & NAS 校验归档',
        inputFact: `镜头时长 ${durationLabel} · J-cut 切入环境音`,
        decisionReason: '叠加低电平环境底噪，避开 BGM 自相关重复峰，验证硬门禁与活人感指标。',
        outputSummary: '封装成片并经 sha256 校验落盘 NAS RAID1',
        metrics: [
          qualityMetric(job, '镜头时长 σ', ['shot_duration_stddev_s'], 0.6, 'gte', 's'),
          qualityMetric(job, '音频动态范围', ['audio_dynamic_range_lu', 'audio_dynamic_range'], 8, 'gte', ' LU')
        ]
      }
    ]

    return {
      shotId: shotNum,
      label: `Shot ${String(shotNum).padStart(2, '0')}`,
      startS,
      endS,
      durationS,
      sceneSummary: sceneLabel,
      pacingTag: durationS === null ? '时长未记录' : durationS >= 4.0 ? '长呼吸镜' : '中快切镜',
      media: {
        originalFrame: origFrame,
        redrawnFrame,
        i2vClip,
        gradedClip
      },
      actions
    }
  })
}
