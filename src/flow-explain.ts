/**
 * #103：自动编排链路的解释层（只读展示派生）。
 *
 * 术语来源（studio `~/kex/projects/kex-labs-video`，2026-11-13 只读核对）：
 * - `docs/kex-labs-video-项目说明.md` §4「流水线六阶段（A→F）」、§17.2「角色总表」
 * - `docs/prompt-schema.md`（C/D prompt 结构）、`docs/spatial-schema.md`（空间字段）
 * - `docs/director-profiles.md`（look / style_bypass 口径）、`AGENTS.md`（状态机与兜底）
 * - `workflows/*.json` 的真实 `class_type` 与关键参数
 *
 * 只翻译已有字段：不重算阈值、不推测缺失值；未登记 key 一律显式「未收录说明」。
 */

export type StageExplain = {
  key: string
  known: boolean
  label: string
  role: string
  doing: string
  input: string
  output: string
  failure: string
  source: string
}

const UNRECORDED = '未收录说明'
const UNRECORDED_SOURCE = '—'

/** A–F 环节白话（§4 表格 + AGENTS.md 状态机）。 */
const STAGE_EXPLAINS: Record<string, Omit<StageExplain, 'key' | 'known'>> = {
  A: {
    label: '素材处理',
    role: '素材管理（Librarian）',
    doing: '探测源视频，按镜头切分并抽出关键帧',
    input: '源视频文件',
    output: 'shots.json + frames/*.png + probe',
    failure: '测试图/彩条混入（输入门禁历史事故）；探测不到时长/编码',
    source: '项目说明 §4 阶段 A / §17.2 角色 2'
  },
  B: {
    label: '帧语义',
    role: '语义描述（Qwen2-VL）',
    doing: '用 VLM 逐帧描述主体、情绪、光照与运动',
    input: 'A 阶段抽出的关键帧',
    output: 'semantics.json（VLM 语义）',
    failure: 'Ollama 未启动 / 内存未卸 → 该阶段 failed + unverified',
    source: '项目说明 §4 阶段 B / AGENTS.md「VLM 不可达」'
  },
  B2: {
    label: '风格查表',
    role: '导演（select_profile 纯函数）',
    doing: '把语义查表成 look / bgm_tone / 导演 profile',
    input: 'B 阶段语义',
    output: 'profile.json（look / prompt 路径 / bgm_tone）',
    failure: 'confidence<0.6 或 unknown → doc_neutral 兜底（fallback=true）',
    source: '项目说明 §4 阶段 B2 / §17.2 角色 4'
  },
  C: {
    label: '关键帧重绘',
    role: '美术 / 关键帧（SDXL img2img）',
    doing: '按 profile prompt 重绘关键帧，保留原图结构',
    input: '关键帧 + profile prompt',
    output: 'rendered/*.png + render_report.json',
    failure: '结构丢失（SSIM 下降）、denoise 过高熔脸',
    source: '项目说明 §4 阶段 C / §17.2 角色 5'
  },
  D: {
    label: '视频片段',
    role: '摄影 / 生成（LTXV I2V）',
    doing: '把关键帧生成为 3~5s 视频片段',
    input: '关键帧 + prompt / seed',
    output: 'clips/*.mp4 + 参数快照（seed/workflow sha）',
    failure: '尾段崩、拖影、形体崩坏',
    source: '项目说明 §4 阶段 D / §17.2 角色 6'
  },
  E: {
    label: '调色 · 插帧 · 超分',
    role: '调色 / 后期（RIFE + Real-ESRGAN）',
    doing: '插帧到 60fps、超分、全片统一色彩',
    input: 'D 阶段片段',
    output: 'interpolated / upscaled / graded 片段',
    failure: '鬼影、振铃、偏色；二进制缺失时只剩 lanczos',
    source: '项目说明 §4 阶段 E / §17.2 角色 7'
  },
  F: {
    label: '音频 · 封装',
    role: '剪辑 / 声音 / 交付',
    doing: '合成旁白与 BGM，按时间线剪辑、封装并归档',
    input: '片段 + 音频 + 报告',
    output: '成片 + assemble_report + archive',
    failure: '音画 offset、切点跳帧、缺 ffprobe',
    source: '项目说明 §4 阶段 F / §17.2 角色 8–11'
  }
}

export function stageExplain(key: string): StageExplain {
  const found = STAGE_EXPLAINS[key]
  if (!found) {
    return {
      key,
      known: false,
      label: key || '（空 key）',
      role: UNRECORDED,
      doing: UNRECORDED,
      input: UNRECORDED,
      output: UNRECORDED,
      failure: UNRECORDED,
      source: UNRECORDED_SOURCE
    }
  }
  return { key, known: true, ...found }
}

/* ------------------------------ 全链路总览 ------------------------------ */

export type ChainLink = {
  id: string
  title: string
  role: string
  doing: string
  input: string
  output: string
  check: string
  /** 本页对应 stage key；空数组表示文档标注「尚未实现/人工」。 */
  stages: string[]
  source: string
  /** 本 job 的真实进度文案（只由 stages[].status 派生）。 */
  current: string
}

const CHAIN: Omit<ChainLink, 'current'>[] = [
  {
    id: 'brief',
    title: '导演 Brief',
    role: '制片 + 导演',
    doing: '定目标、轨、交付规格与镜头语言',
    input: '用户目标（时长/平台/风格/素材）',
    output: 'job 配置 + director_plan.json',
    check: '目标可量化为 job 配置；导演计划逐镜可查',
    stages: [],
    source: '§17.2 角色 1、4（当前部分实现，缺 director_plan）'
  },
  {
    id: 'scenes',
    title: '分镜 / 场景',
    role: '素材管理 + 编剧 + 语义描述',
    doing: '切镜、抽帧、VLM 打标、查 profile',
    input: '源视频 / 脚本',
    output: 'shots.json + frames + semantics + profile',
    check: '镜数×时长正确；语义置信度与兜底标记可查',
    stages: ['A', 'B', 'B2'],
    source: '§4 阶段 A/B/B2'
  },
  {
    id: 'keyframe',
    title: '关键帧',
    role: '美术 / 关键帧',
    doing: 'SDXL img2img 重绘关键帧',
    input: '关键帧 + profile prompt',
    output: 'rendered/*.png + render_report',
    check: '结构保留（SSIM）；denoise 在可用区间',
    stages: ['C'],
    source: '§4 阶段 C'
  },
  {
    id: 'clips',
    title: '视频片段',
    role: '摄影 / 生成（DOP）',
    doing: '关键帧生成 3~5s 片段',
    input: '关键帧 + prompt / seed',
    output: 'clips/*.mp4 + 参数快照',
    check: '片段时长与首帧一致；尾段不崩',
    stages: ['D'],
    source: '§4 阶段 D'
  },
  {
    id: 'enhance',
    title: '插帧 / 增强',
    role: '调色 / 后期',
    doing: '插帧、超分、统一调色',
    input: '片段',
    output: '60fps / 高分 / 统一色彩片段',
    check: 'fps / 分辨率 / 色差可核对',
    stages: ['E'],
    source: '§4 阶段 E'
  },
  {
    id: 'deliver',
    title: '组装交付',
    role: '剪辑 + 声音 + 交付',
    doing: '旁白/BGM、剪辑封装、归档证据',
    input: '片段 + 音频 + 报告',
    output: '成片 + assemble_report + archive',
    check: '音画 offset、编码与门禁报告齐全',
    stages: ['F'],
    source: '§4 阶段 F'
  }
]

function linkProgress(stages: ChainLink['stages'], jobStages?: Array<{ key: string; status: string | null }>) {
  if (stages.length === 0) return '本页无对应 stage（文档：部分/未实现）'
  if (!jobStages || jobStages.length === 0) return '未触发'
  const found = stages
    .map((key) => jobStages.find((stage) => stage.key === key))
    .filter((stage): stage is { key: string; status: string | null } => Boolean(stage))
  if (found.length === 0) return `未触发（无 ${stages.join('/')}）`
  const failed = found.filter((stage) => stage.status === 'failed').length
  const running = found.filter((stage) => stage.status === 'running').length
  const done = found.filter((stage) => stage.status === 'done').length
  const label = failed > 0 ? '有失败' : running > 0 ? '执行中' : done === found.length ? '完成' : '未完成'
  return `${label}（${found.map((stage) => `${stage.key} ${stage.status ?? '无状态'}`).join(' · ')}）`
}

export function chainLinks(jobStages?: Array<{ key: string; status: string | null }>): ChainLink[] {
  return CHAIN.map((link) => ({ ...link, current: linkProgress(link.stages, jobStages) }))
}

/* --------------------------- ComfyUI 节点说明 --------------------------- */

export type NodeExplain = {
  classType: string
  known: boolean
  duty: string
  params: string
  failure: string
  source: string
}

const NODE_EXPLAINS: Record<string, Omit<NodeExplain, 'classType' | 'known'>> = {
  CheckpointLoaderSimple: {
    duty: '加载主模型检查点（SDXL / LTXV）',
    params: 'ckpt_name = 权重文件名，须与 models/checkpoints 下的文件完全一致',
    failure: '文件名不在列表 → 节点报 value not in list；模型不匹配 → 采样报维度错误',
    source: 'workflows/*.json · CheckpointLoaderSimple'
  },
  CLIPLoader: {
    duty: '加载文本编码器',
    params: 'clip_name 对应 text_encoders 文件；type=ltxv 指定 LTXV 文本编码',
    failure: '编码器类型不对 → 条件维度不匹配，KSampler 报错',
    source: 'workflows/ltxv_i2v_v1.json · CLIPLoader'
  },
  CLIPTextEncode: {
    duty: '把正 / 负 prompt 编码成条件',
    params: 'text = 实际 prompt；工作流里是 __POSITIVE__ / __NEGATIVE__ 占位，运行时替换',
    failure: 'prompt 为空或字段名错 → 条件为空，画面无引导',
    source: 'workflows/*.json · CLIPTextEncode'
  },
  LTXVConditioning: {
    duty: '给 LTXV 条件补帧率',
    params: 'frame_rate 应与目标 fps 一致（当前 30）',
    failure: '与 CreateVideo 的 fps 不一致 → 速度/时长不对',
    source: 'workflows/ltxv_i2v_v1.json · LTXVConditioning'
  },
  LoadImage: {
    duty: '读取输入关键帧',
    params: 'image = 输入图路径（占位 __IMAGE__）',
    failure: '路径不存在或不是图片 → 节点报 invalid image / 空图',
    source: 'workflows/*.json · LoadImage'
  },
  LTXVImgToVideo: {
    duty: '关键帧 → 视频 latent（I2V）',
    params: 'width/height/length/strength 决定尺寸、帧数与重绘强度',
    failure: '尺寸非 32 对齐或 length 超模型窗口 → 尾段崩 / 直接报错',
    source: 'workflows/ltxv_i2v_v1.json · LTXVImgToVideo'
  },
  KSampler: {
    duty: '采样器：把条件迭代成 latent',
    params: 'steps/cfg/denoise 控制质量与贴合度；seed 控制可复现',
    failure: 'denoise 过高 → 熔脸/结构丢失；改 seed → 结果不可复现',
    source: 'workflows/*.json · KSampler'
  },
  VAEDecode: {
    duty: 'latent 解码成图片 / 视频帧',
    params: 'samples 接采样器输出，vae 接模型自带 VAE',
    failure: 'VAE 不匹配 → 花屏 / 偏色',
    source: 'workflows/*.json · VAEDecode'
  },
  VAEEncode: {
    duty: '输入图编码成 latent（img2img 必需）',
    params: 'pixels 接 ImageScale 输出，vae 接模型 VAE',
    failure: '图尺寸与 VAE 预算不符 → 显存不足或编码报错',
    source: 'workflows/sdxl_img2img_v1.json · VAEEncode'
  },
  ImageScale: {
    duty: '重绘前缩放 / 裁切到目标尺寸',
    params: 'width/height/upscale_method/crop 决定构图与像素预算',
    failure: '尺寸超出预算 → OOM；裁切方式错 → 主体被切掉',
    source: 'workflows/sdxl_img2img_v1.json · ImageScale'
  },
  EmptyLatentImage: {
    duty: '文生图的空白 latent 起点',
    params: 'width/height/batch_size 决定画布与批量',
    failure: '尺寸过大 → 显存不足（OOM）',
    source: 'workflows/sdxl_txt2img_v1.json · EmptyLatentImage'
  },
  EmptyLTXVLatentVideo: {
    duty: '文生视频的空白 latent 起点',
    params: 'length/width/height 决定帧数与画布',
    failure: 'length 超模型窗口 → 生成失败',
    source: 'workflows/comfyui/ltxv_L2.json · EmptyLTXVLatentVideo'
  },
  CreateVideo: {
    duty: '把帧序列按 fps 合成为视频',
    params: 'images 接 VAEDecode，fps 决定时长与速度',
    failure: 'fps 与 LTXVConditioning 不一致 → 时长/速度错',
    source: 'workflows/ltxv_i2v_v1.json · CreateVideo'
  },
  SaveVideo: {
    duty: '把合成视频落盘',
    params: 'filename_prefix 决定输出目录/前缀；format=auto 由扩展名决定',
    failure: '目录不可写或编码不支持 → 保存失败，后续环节无产物',
    source: 'workflows/ltxv_i2v_v1.json · SaveVideo'
  },
  SaveImage: {
    duty: '把单帧图片落盘',
    params: 'filename_prefix 决定输出目录/前缀',
    failure: '目录不可写 → 保存失败，报告里文件缺失',
    source: 'workflows/*.json · SaveImage'
  }
}

export function nodeExplain(classType: string): NodeExplain {
  const found = NODE_EXPLAINS[classType]
  if (!found) {
    return {
      classType: classType || '（空 class_type）',
      known: false,
      duty: UNRECORDED,
      params: `${UNRECORDED}（页面保留节点 inputs 原值）`,
      failure: UNRECORDED,
      source: UNRECORDED_SOURCE
    }
  }
  return { classType, known: true, ...found }
}

/* ------------------------------ Agent 节点 ------------------------------ */

export type AgentExplainer = { duty: string; params: string; failure: string; source: string }

const AGENT_EXPLAINS: Record<string, AgentExplainer> = {
  semantics: {
    duty: '把关键帧描述成可查表的语义（主体 / 情绪 / 光照 / 运动）',
    params: 'confidence < 0.6 或值为 unknown → 不当作可靠语义，B2 走兜底 profile',
    failure: 'VLM 不可达时 B 阶段 failed + unverified，页面保留缺失而不是补值',
    source: '§4 阶段 B / AGENTS.md「VLM 不可达」'
  },
  profile: {
    duty: '把语义查表成 look / bgm_tone / 导演 profile',
    params: 'look=doc_neutral + fallback=true 表示保守兜底；style_bypass=true 表示不套 LUT/导演子句',
    failure: '语义 unknown → 兜底 profile；不会凭空生成镜头语言',
    source: '§4 阶段 B2 / docs/director-profiles.md'
  },
  decision: {
    duty: '记录规则命中与可重放决策（decisions/<job>.jsonl）',
    params: 'typology / look / hit_rule 决定本轮选择；confidence 是匹配强度',
    failure: '无 decisions 文件时显示「没有记录」，不推断原因',
    source: 'AGENTS.md「decisions/<job>.jsonl」'
  },
  quality_gate: {
    duty: '按交付门禁核对质量项，给出成片是否可交付',
    params: 'quality 每项是实测值，quality_gate 是阈值判定；门槛值来自 docs 门禁清单',
    failure: '未执行 → quality_gate 为 null（显示未执行）；指标缺失只报缺，不补算',
    source: '项目说明 §4 阶段 F / 门禁清单'
  }
}

export function agentNodeExplain(kind: string): AgentExplainer {
  const found = AGENT_EXPLAINS[kind]
  if (!found) {
    return {
      duty: UNRECORDED,
      params: `${UNRECORDED}（保留原始字段）`,
      failure: UNRECORDED,
      source: UNRECORDED_SOURCE
    }
  }
  return found
}

/* ---------------------------- 场景连续性检查 ---------------------------- */

export type ContinuityInput = {
  semantics: Record<string, unknown> | null
  shot_semantics: Record<string, unknown>[] | null
  profile: Record<string, unknown> | null
}

export type ContinuityRow = {
  key: string
  label: string
  values: string[]
  sources: string[]
  recorded: boolean
  note?: string
}

function read(value: unknown, ...path: string[]): unknown {
  let cursor: unknown = value
  for (const key of path) {
    if (!cursor || typeof cursor !== 'object') return null
    cursor = (cursor as Record<string, unknown>)[key]
  }
  return cursor ?? null
}

function display(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value.trim() ? value : null
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.length ? value.map((item) => String(item)).join(' / ') : null
  return null
}

function unique(values: Array<string | null>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

function perShotSemantics(input: ContinuityInput): Record<string, unknown>[] {
  const shots = Array.isArray(input.shot_semantics) ? input.shot_semantics : []
  const fromShots = shots
    .map((item) => read(item, 'semantics'))
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
  return fromShots.length > 0 ? fromShots : input.semantics ? [input.semantics] : []
}

export function continuityFields(input: ContinuityInput): ContinuityRow[] {
  const items = perShotSemantics(input)
  const subject = items.map((item) => {
    const count = display(read(item, 'subject', 'count'))
    const kind = display(read(item, 'subject', 'kind'))
    return [kind, count].filter(Boolean).join(' × ') || null
  })
  const lighting = items.flatMap((item) => [
    display(read(item, 'lighting', 'quality')),
    display(read(item, 'lighting', 'direction')),
    display(read(item, 'lighting', 'time'))
  ])
  const temp = items.map((item) => {
    const value = read(item, 'lighting', 'temp_k')
    const shown = display(value)
    if (!shown) return null
    return /^\d+(\.\d+)?$/.test(shown) ? `${shown}K` : shown
  })
  const camera = items.map((item) => display(read(item, 'motion', 'camera')))
  const profileLook = display(read(input.profile, 'look'))

  const rows: ContinuityRow[] = [
    {
      key: 'cast',
      label: '角色',
      values: unique(subject),
      sources: ['state.shot_semantics[].semantics.subject', 'state.semantics.subject'],
      recorded: unique(subject).length > 0,
      note: unique(subject).length > 0 ? undefined : 'state 未记录主体描述'
    },
    {
      key: 'costume',
      label: '服装',
      values: [],
      sources: [],
      recorded: false,
      note: 'state / spatial schema 均无服装字段'
    },
    {
      key: 'props',
      label: '道具',
      values: [],
      sources: [],
      recorded: false,
      note: 'state 无道具字段；spatial 只有地标，不含道具清单'
    },
    {
      key: 'lighting',
      label: '光线',
      values: unique(lighting),
      sources: ['state.shot_semantics[].semantics.lighting.quality/direction/time'],
      recorded: unique(lighting).length > 0,
      note: unique(lighting).length > 0 ? undefined : 'state 未记录光线描述'
    },
    {
      key: 'temp',
      label: '色温',
      values: unique(temp),
      sources: ['state.shot_semantics[].semantics.lighting.temp_k'],
      recorded: unique(temp).length > 0,
      note: unique(temp).length > 0 ? undefined : 'state 未记录色温'
    },
    {
      key: 'camera',
      label: '机位',
      values: unique(camera),
      sources: ['state.shot_semantics[].semantics.motion.camera'],
      recorded: unique(camera).length > 0,
      note: unique(camera).length > 0 ? undefined : 'state 未记录机位'
    },
    {
      key: 'background',
      label: '背景',
      values: [],
      sources: [],
      recorded: false,
      note: profileLook ? `只有 look=${profileLook}；无背景描述字段` : 'state 无背景字段'
    }
  ]
  return rows
}

/* ------------------------------ 提示词链 ------------------------------- */

export type PromptSegment = {
  id: 'brief' | 'scene' | 'shot' | 'negative'
  label: string
  source: string
  text: string | null
  note?: string
}

export type PromptChainInput = {
  profile: Record<string, unknown> | null
  profile_prompt?: { path: string | null; version: string | null; text: string | null } | null
  stages: Array<{ key: string; prompts?: Array<{ text: string; negative: string | null; shot_id: number | null; source: string }> }>
}

export function promptChain(input: PromptChainInput): PromptSegment[] {
  const scenePath = display(read(input.profile, 'prompt', 'path'))
  const sceneText = input.profile_prompt?.text ?? null
  const shotPrompts = input.stages
    .filter((stage) => stage.key === 'C' || stage.key === 'D')
    .flatMap((stage) =>
      (stage.prompts ?? []).map((prompt) => ({
        stage: stage.key,
        shot: prompt.shot_id,
        text: prompt.text,
        negative: prompt.negative
      }))
    )
  const positive = shotPrompts
    .map((item) => `${item.stage === 'C' ? '关键帧' : '片段'}${item.shot === null ? '' : ` · 镜 ${item.shot}`}：${item.text}`)
    .join('\n\n')
  const negative = unique(shotPrompts.map((item) => item.negative)).join('\n\n')

  return [
    {
      id: 'brief',
      label: '导演 brief',
      source: 'state 无 brief 正文字段（job 输入见 state.input）',
      text: null,
      note: '未记录：state 不保存 brief 正文，不补写示例'
    },
    {
      id: 'scene',
      label: '场景 prompt',
      source: scenePath ? `state.profile.prompt.path → ${scenePath}` : 'state.profile.prompt.path',
      text: sceneText,
      note: sceneText ? undefined : '未记录：profile 只给出路径，正文未读到'
    },
    {
      id: 'shot',
      label: '镜头 prompt',
      source: 'state.rendered[].prompt（C） / state.clips[].prompt（D）',
      text: positive || null,
      note: positive ? undefined : '未记录：C/D 的 prompts 为空'
    },
    {
      id: 'negative',
      label: 'negative prompt',
      source: 'state.rendered[].negative / state.clips[].negative',
      text: negative || null,
      note: negative ? undefined : '未记录：C/D 条目没有 negative'
    }
  ]
}
