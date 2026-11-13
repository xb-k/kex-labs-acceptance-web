import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai'
import fs from 'node:fs'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { formatHistoricalKnowledgeBrief, matchHistoricalKnowledge } from './historical-kb'
import { ollamaFetch } from './ollama'
import {
  agentDiscoverAndSyncGiteaTemplates,
  configureTemplateAutoSyncScheduler,
  getMergedScriptTemplates,
  getScriptPromptTemplate,
  getTemplateSyncState,
  syncScriptTemplatesFromGitea,
  syncScriptTemplatesFromGitHub,
  updateTemplateSyncSchedule
} from './script-templates'
import { isValidFrameName, isValidSessionId, sanitizeOptimizeParams, type LookProfileId, type OptimizeParams } from './video-optimize'

const GEMINI_MODEL = 'gemini-4-hydrogen'
const MAX_RETRIES = 2
const OLLAMA_DEFAULT_URL = 'http://127.0.0.1:11434'
const OLLAMA_DEFAULT_TEXT_MODEL = 'qwen2vl:7b-q4'
const OLLAMA_DEFAULT_VLM_MODEL = 'qwen2vl:7b-q4'
const OLLAMA_SCRIPT_TIMEOUT_MS = 60_000
const OLLAMA_VLM_TIMEOUT_MS = 90_000

const FRAME_ANALYSIS_SYSTEM_INSTRUCTION = [
  '你是 Kex Labs 视频工作台的 AI 影像分析与调色美化专家。',
  '请仔细查看从同一段视频按时间抽取的多个关键帧画面，完成逐帧镜头拆解、画质瑕疵诊断，并给出最适配的 FFmpeg 美化调色参数。',
  '可选 recommended_profile 仅限：natural_clarity（中性纪实通透）、teal_orange（电影青橙商业）、warm_film（温暖胶片肤色）、landscape_vivid（风景建筑高锐）。',
  '参数范围约束：denoise(0..100)、sharpen(0..100)、contrast(-30..40)、brightness(-20..25)、saturation(-30..50)、warmth(-30..30)。',
  '请务必用专业、具体、简洁的中文描述每个关键帧的真实视觉内容。',
  '只输出一个 JSON 对象，不要 markdown 代码块或额外解释。字段必须为：',
  '{"overall_assessment": string, "recommended_profile": "natural_clarity|teal_orange|warm_film|landscape_vivid", "recommended_profile_reason": string, "recommended_params": {"denoise": number, "sharpen": number, "contrast": number, "brightness": number, "saturation": number, "warmth": number, "upscale_1080p": boolean, "smooth_30fps": boolean}, "shots": [{"frame_index": number, "timecode": string, "shot_type": string, "subject": string, "lighting_color": string, "flaw_diagnosis": string, "enhance_action": string}]}'
].join('\n')

export interface ScriptSceneOutput {
  scene_no: number
  timecode: string
  duration_s: number
  shot_type: string
  camera: string
  continuity_anchor: string
  visual: string
  video_prompt: string
  voiceover: string
  audio: string
}

export interface HistoricalSourceRef {
  title: string
  url: string
}

export interface NovelChapterOutline {
  chapter_no: number
  title: string
  era_anchor: string
  summary: string
  key_conflict: string
}

export interface GeneratedScriptResult {
  title: string
  logline: string
  tone: string
  aspect: string
  style: string
  profile?: string
  template_id?: string
  template_label?: string
  optimization_notes?: string
  story_era?: string
  episode_mode?: 'single' | 'novel_series'
  historical_context?: string
  historical_sources?: HistoricalSourceRef[]
  chapters?: NovelChapterOutline[]
  duration_s: number
  markdown: string
  scenes: ScriptSceneOutput[]
}

export interface FrameShotBreakdown {
  frame_index: number
  timecode: string
  shot_type: string
  subject: string
  lighting_color: string
  flaw_diagnosis: string
  enhance_action: string
}

export interface FrameAnalysisResult {
  overall_assessment: string
  recommended_profile: LookProfileId
  recommended_profile_reason: string
  recommended_params: OptimizeParams
  shots: FrameShotBreakdown[]
}

export interface GeminiRouteContext {
  sendJson: (res: ServerResponse, status: number, body: unknown) => void
  readBody: (req: IncomingMessage) => Promise<any>
  dataRoot?: string
  readJson?: (file: string) => any
  atomicWriteJson?: (file: string, value: unknown) => void
  /** Injected by api.ts so script writes reuse `authorizeTaskWrite`. */
  authorizeWrite?: (req: IncomingMessage) => { ok: true } | { ok: false; status: number; error: string }
}

function createGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY?.trim()
  if (!apiKey) return null
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build'
      }
    }
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function normalizeGeminiError(err: unknown): { status: number; code: string; message: string } {
  const raw = err instanceof Error ? err.message : String(err)
  const lower = raw.toLowerCase()

  if (lower.includes('permission_denied') || lower.includes('403') || lower.includes('api_key_invalid')) {
    return {
      status: 403,
      code: 'gemini_auth_error',
      message: 'Gemini API 密钥无效或权限不足，请在 Settings > Secrets 中检查服务端 GEMINI_API_KEY。'
    }
  }
  if (lower.includes('resource_exhausted') || lower.includes('429') || lower.includes('quota')) {
    return {
      status: 429,
      code: 'gemini_rate_limited',
      message: 'Gemini API 当前配额已满或触发限流，请稍后再试或检查配额设置。'
    }
  }
  if (lower.includes('not_found') || lower.includes('404')) {
    return {
      status: 502,
      code: 'gemini_model_unavailable',
      message: `请求的模型（${GEMINI_MODEL}）当前不可用，请稍后重试。`
    }
  }
  if (lower.includes('timeout') || lower.includes('aborted') || lower.includes('fetch failed')) {
    return {
      status: 504,
      code: 'gemini_timeout',
      message: '连接 Gemini AI 服务超时，请检查网络或点击重新生成。'
    }
  }
  return {
    status: 502,
    code: 'gemini_upstream_error',
    message: raw || '调用 Gemini AI 生成剧本失败'
  }
}

export function isRetryableGeminiError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return (
    msg.includes('500') ||
    msg.includes('503') ||
    msg.includes('unavailable') ||
    msg.includes('timeout') ||
    msg.includes('econnreset') ||
    msg.includes('fetch failed')
  )
}

export function buildScriptMarkdownFromScenes(data: {
  title: string
  logline: string
  tone: string
  aspect: string
  style: string
  profile?: string
  template_id?: string
  template_label?: string
  optimization_notes?: string
  story_era?: string
  episode_mode?: 'single' | 'novel_series'
  historical_context?: string
  historical_sources?: HistoricalSourceRef[]
  chapters?: NovelChapterOutline[]
  duration_s: number
  scenes: ScriptSceneOutput[]
}): string {
  const lines: string[] = [
    `# ${data.title}`,
    '',
    `> **一句话梗概（Logline）**：${data.logline}`,
    '',
    ...(data.template_label ? [`- **视频类型模板**：${data.template_label}`] : []),
    ...(data.story_era ? [`- **历史时期 / 时代背景**：${data.story_era}`] : []),
    ...(data.episode_mode === 'novel_series' ? ['- **创作模式**：整部小说 · 多章分集连载'] : []),
    `- **叙事基调**：${data.tone}`,
    `- **画面风格**：${data.style}`,
    ...(data.profile ? [`- **平台风格模板**：${data.profile}`] : []),
    `- **建议规格**：${data.duration_s} 秒 · 画幅 ${data.aspect}`,
    ...(data.optimization_notes ? [`- **AI 导演优化说明**：${data.optimization_notes}`] : []),
    '',
    ...(data.historical_context
      ? [
          '## 史实背景与时代考据',
          '',
          data.historical_context,
          ...(data.historical_sources?.length
            ? ['', '**考据来源：**', ...data.historical_sources.map((s) => `- [${s.title}](${s.url})`)]
            : []),
          ''
        ]
      : []),
    ...(data.chapters && data.chapters.length > 0
      ? [
          '## 整部故事 / 小说章节脉络总纲',
          '',
          ...data.chapters.flatMap((ch) => [
            `### 第 ${String(ch.chapter_no).padStart(2, '0')} 章 · ${ch.title}`,
            `- **时代锚点**：${ch.era_anchor}`,
            `- **核心冲突**：${ch.key_conflict}`,
            `- **剧情摘要**：${ch.summary}`,
            ''
          ])
        ]
      : []),
    '## 分场拍摄与 AI 分镜提示词脚本',
    ''
  ]

  for (const scene of data.scenes) {
    lines.push(`### 场次 ${String(scene.scene_no).padStart(2, '0')} · ${scene.timecode}（${scene.duration_s}s）`)
    lines.push(`- **景别 / 运镜**：${scene.shot_type} · ${scene.camera}`)
    lines.push(`- **视觉连续性锚点**：${scene.continuity_anchor}`)
    lines.push(`- **画面描述**：${scene.visual}`)
    lines.push(`- **I2V 英文生成提示词**：\`${scene.video_prompt}\``)
    lines.push(`- **旁白 / 台词**：${scene.voiceover}`)
    lines.push(`- **音效 / 配乐**：${scene.audio}`)
    lines.push('')
  }

  return lines.join('\n').trim()
}

export function normalizeGeneratedScript(
  raw: Record<string, unknown>,
  defaults: {
    tone: string
    aspect: string
    duration_s: number
    profile?: string
    template_id?: string
    template_label?: string
    story_era?: string
    episode_mode?: 'single' | 'novel_series'
    historical_context?: string
    historical_sources?: HistoricalSourceRef[]
  }
): GeneratedScriptResult {
  const title =
    typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : 'AI 视频创作脚本'
  const logline =
    typeof raw.logline === 'string' && raw.logline.trim()
      ? raw.logline.trim()
      : '围绕核心创意设计的结构化分场视频脚本。'
  const tone =
    typeof raw.tone === 'string' && raw.tone.trim() ? raw.tone.trim() : defaults.tone
  const style =
    typeof raw.style === 'string' && raw.style.trim()
      ? raw.style.trim()
      : '电影感自然光影 · 非等长呼吸感剪辑节奏'
  const profile =
    typeof raw.profile === 'string' && raw.profile.trim()
      ? raw.profile.trim()
      : defaults.profile
  const template_id =
    typeof raw.template_id === 'string' && raw.template_id.trim()
      ? raw.template_id.trim()
      : defaults.template_id
  const template_label =
    typeof raw.template_label === 'string' && raw.template_label.trim()
      ? raw.template_label.trim()
      : defaults.template_label
  const optimization_notes =
    typeof raw.optimization_notes === 'string' && raw.optimization_notes.trim()
      ? raw.optimization_notes.trim()
      : undefined
  const story_era =
    typeof raw.story_era === 'string' && raw.story_era.trim()
      ? raw.story_era.trim()
      : defaults.story_era
  const episode_mode =
    raw.episode_mode === 'novel_series' || defaults.episode_mode === 'novel_series'
      ? 'novel_series'
      : 'single'
  const historical_context =
    typeof raw.historical_context === 'string' && raw.historical_context.trim()
      ? raw.historical_context.trim()
      : defaults.historical_context
  const historical_sources =
    Array.isArray(defaults.historical_sources) && defaults.historical_sources.length > 0
      ? defaults.historical_sources
      : undefined

  const rawChapters = Array.isArray(raw.chapters) ? raw.chapters : []
  const chapters: NovelChapterOutline[] = rawChapters
    .map((item, idx): NovelChapterOutline | null => {
      if (!item || typeof item !== 'object') return null
      const rec = item as Record<string, unknown>
      const chNo = Number(rec.chapter_no)
      const chTitle =
        typeof rec.title === 'string' && rec.title.trim() ? rec.title.trim() : `第 ${idx + 1} 章`
      const eraAnchor =
        typeof rec.era_anchor === 'string' && rec.era_anchor.trim()
          ? rec.era_anchor.trim()
          : story_era || '时代服饰、建筑礼制与光线语境保持统一'
      const summary =
        typeof rec.summary === 'string' && rec.summary.trim()
          ? rec.summary.trim()
          : '推进主线人物关系与时代命运抉择。'
      const keyConflict =
        typeof rec.key_conflict === 'string' && rec.key_conflict.trim()
          ? rec.key_conflict.trim()
          : '人物困境与历史洪流的正面碰撞。'
      return {
        chapter_no: Number.isFinite(chNo) && chNo > 0 ? Math.round(chNo) : idx + 1,
        title: chTitle,
        era_anchor: eraAnchor,
        summary,
        key_conflict: keyConflict
      }
    })
    .filter((c): c is NovelChapterOutline => c !== null)

  const duration_s =
    typeof raw.duration_s === 'number' && Number.isFinite(raw.duration_s) && raw.duration_s > 0
      ? Math.round(raw.duration_s)
      : defaults.duration_s

  const rawScenes = Array.isArray(raw.scenes) ? raw.scenes : []
  let cursor = 0
  const scenes: ScriptSceneOutput[] = rawScenes
    .map((item, idx): ScriptSceneOutput | null => {
      if (!item || typeof item !== 'object') return null
      const rec = item as Record<string, unknown>
      const dur =
        typeof rec.duration_s === 'number' && Number.isFinite(rec.duration_s) && rec.duration_s > 0
          ? Number(rec.duration_s.toFixed(1))
          : 3.5
      const start = cursor.toFixed(1)
      cursor += dur
      const end = cursor.toFixed(1)
      const shotType =
        typeof rec.shot_type === 'string' && rec.shot_type.trim()
          ? rec.shot_type.trim()
          : '中景 · 50mm'
      const camera =
        typeof rec.camera === 'string' && rec.camera.trim()
          ? rec.camera.trim()
          : '平稳推进'
      const visual =
        typeof rec.visual === 'string' && rec.visual.trim()
          ? rec.visual.trim()
          : '主体与环境光影层次清晰呈现。'
      const continuity_anchor =
        typeof rec.continuity_anchor === 'string' && rec.continuity_anchor.trim()
          ? rec.continuity_anchor.trim()
          : '保持主体材质质感、色温及主光源方向与前一镜头一致。'
      const video_prompt =
        typeof rec.video_prompt === 'string' && rec.video_prompt.trim()
          ? rec.video_prompt.trim()
          : `${shotType}, ${camera}, ${visual}, natural physical lighting, film grain, 24fps`

      return {
        scene_no: idx + 1,
        timecode:
          typeof rec.timecode === 'string' && rec.timecode.trim()
            ? rec.timecode.trim()
            : `${start}s - ${end}s`,
        duration_s: dur,
        shot_type: shotType,
        camera,
        continuity_anchor,
        visual,
        video_prompt,
        voiceover:
          typeof rec.voiceover === 'string' && rec.voiceover.trim()
            ? rec.voiceover.trim()
            : '（环境自然声留白）',
        audio:
          typeof rec.audio === 'string' && rec.audio.trim()
            ? rec.audio.trim()
            : '轻柔氛围底噪与细腻环境拟音'
      }
    })
    .filter((s): s is ScriptSceneOutput => s !== null)

  const markdown =
    typeof raw.markdown === 'string' && raw.markdown.trim()
      ? raw.markdown.trim()
      : buildScriptMarkdownFromScenes({
          title,
          logline,
          tone,
          aspect: defaults.aspect,
          style,
          profile,
          template_id,
          template_label,
          optimization_notes,
          story_era,
          episode_mode,
          historical_context,
          historical_sources,
          chapters: chapters.length > 0 ? chapters : undefined,
          duration_s,
          scenes
        })

  return {
    title,
    logline,
    tone,
    aspect: defaults.aspect,
    style,
    ...(profile ? { profile } : {}),
    ...(template_id ? { template_id } : {}),
    ...(template_label ? { template_label } : {}),
    ...(optimization_notes ? { optimization_notes } : {}),
    ...(story_era ? { story_era } : {}),
    episode_mode,
    ...(historical_context ? { historical_context } : {}),
    ...(historical_sources ? { historical_sources } : {}),
    ...(chapters.length > 0 ? { chapters } : {}),
    duration_s,
    markdown,
    scenes
  }
}

export function normalizeFrameAnalysis(
  raw: Record<string, unknown>,
  fallbackFrames: Array<{ index: number; timecode: string }>
): FrameAnalysisResult {
  const recommendedParams = sanitizeOptimizeParams({
    profile: raw.recommended_profile,
    ...(raw.recommended_params && typeof raw.recommended_params === 'object' ? raw.recommended_params : {})
  })
  const rawShots = Array.isArray(raw.shots) ? raw.shots : []
  const shots: FrameShotBreakdown[] = rawShots
    .map((item, idx): FrameShotBreakdown | null => {
      if (!item || typeof item !== 'object') return null
      const rec = item as Record<string, unknown>
      const fb = fallbackFrames[idx]
      const indexVal = Number(rec.frame_index)
      return {
        frame_index: Number.isFinite(indexVal) && indexVal > 0 ? Math.round(indexVal) : (fb?.index ?? idx + 1),
        timecode:
          typeof rec.timecode === 'string' && rec.timecode.trim()
            ? rec.timecode.trim()
            : (fb?.timecode ?? `00:${String(idx * 2).padStart(2, '0')}.0`),
        shot_type:
          typeof rec.shot_type === 'string' && rec.shot_type.trim() ? rec.shot_type.trim() : '中景 · 自然视角',
        subject:
          typeof rec.subject === 'string' && rec.subject.trim()
            ? rec.subject.trim()
            : '画面主体与环境构图清晰可见。',
        lighting_color:
          typeof rec.lighting_color === 'string' && rec.lighting_color.trim()
            ? rec.lighting_color.trim()
            : '自然光照与中等反差平衡。',
        flaw_diagnosis:
          typeof rec.flaw_diagnosis === 'string' && rec.flaw_diagnosis.trim()
            ? rec.flaw_diagnosis.trim()
            : '局部暗部细节轻微压缩，边缘锐度可进一步提升。',
        enhance_action:
          typeof rec.enhance_action === 'string' && rec.enhance_action.trim()
            ? rec.enhance_action.trim()
            : '适度降噪并强化中间调反差与细节锐度。'
      }
    })
    .filter((s): s is FrameShotBreakdown => s !== null)

  return {
    overall_assessment:
      typeof raw.overall_assessment === 'string' && raw.overall_assessment.trim()
        ? raw.overall_assessment.trim()
        : '整体曝光稳定，适合进行通透度增强与商业质感调色。',
    recommended_profile: recommendedParams.profile,
    recommended_profile_reason:
      typeof raw.recommended_profile_reason === 'string' && raw.recommended_profile_reason.trim()
        ? raw.recommended_profile_reason.trim()
        : '兼顾清晰度、肤色自然度与动态层次对比。',
    recommended_params: recommendedParams,
    shots
  }
}

function completeFrameAnalysis(
  ctx: GeminiRouteContext,
  res: ServerResponse,
  sessionId: string,
  model: string,
  started: number,
  parsed: Record<string, unknown>,
  fallbackFrames: Array<{ index: number; timecode: string }>
): void {
  const analysis = normalizeFrameAnalysis(parsed, fallbackFrames)

  // Persist AI analysis back to session.json if linked to an optimize session
  if (sessionId && isValidSessionId(sessionId) && ctx.dataRoot && ctx.readJson && ctx.atomicWriteJson) {
    const sessionFile = path.join(ctx.dataRoot, 'optimize-sessions', sessionId, 'session.json')
    const existing = ctx.readJson(sessionFile)
    if (existing) {
      ctx.atomicWriteJson(sessionFile, {
        ...existing,
        updated_at: new Date().toISOString(),
        ai_analysis: analysis
      })
    }
  }

  ctx.sendJson(res, 200, {
    model,
    elapsed_ms: Date.now() - started,
    analysis
  })
}

function sendLlmUnavailable(ctx: GeminiRouteContext, res: ServerResponse, err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err)
  console.error(`[gemini] POST /api/gemini/analyze-frames -> 503 llm_unavailable (${detail})`)
  ctx.sendJson(res, 503, {
    error: 'llm_unavailable',
    message: '本地 Ollama VLM 与 Gemini 均不可用，请检查 OLLAMA_URL/OLLAMA_VLM_MODEL 或配置 GEMINI_API_KEY。',
    detail
  })
}

async function handleAnalyzeFrames(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: GeminiRouteContext
): Promise<boolean> {
  if (req.method !== 'POST') {
    res.statusCode = 405
    res.setHeader('Allow', 'POST')
    res.end()
    return true
  }

  let body: unknown
  try {
    body = await ctx.readBody(req)
  } catch (err) {
    ctx.sendJson(res, 400, { error: err instanceof Error ? err.message : 'invalid JSON body' })
    return true
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    ctx.sendJson(res, 400, { error: '请求体必须为 JSON 对象' })
    return true
  }

  const record = body as Record<string, unknown>
  const sessionId = typeof record.sessionId === 'string' ? record.sessionId.trim() : ''
  const framesInput: Array<{ index: number; timecode: string; base64: string; mimeType: string }> = []
  let videoSummary = '视频素材'

  if (sessionId && isValidSessionId(sessionId) && ctx.dataRoot && ctx.readJson) {
    const sessionFile = path.join(ctx.dataRoot, 'optimize-sessions', sessionId, 'session.json')
    const session = ctx.readJson(sessionFile)
    if (!session) {
      ctx.sendJson(res, 404, { error: '找不到对应的视频会话' })
      return true
    }
    videoSummary = `${session.filename} (${session.probe?.width ?? '?'}x${session.probe?.height ?? '?'}, ${session.probe?.fps ?? '?'}fps, ${session.probe?.duration_s ?? '?'}s)`
    const sessionFrames = Array.isArray(session.frames) ? session.frames.slice(0, 6) : []
    for (const f of sessionFrames) {
      if (!f || typeof f.filename !== 'string' || !isValidFrameName(f.filename)) continue
      const framePath = path.join(ctx.dataRoot, 'optimize-sessions', sessionId, 'frames', f.filename)
      try {
        const buf = fs.readFileSync(framePath)
        framesInput.push({
          index: Number(f.index) || framesInput.length + 1,
          timecode: String(f.timecode || ''),
          base64: buf.toString('base64'),
          mimeType: 'image/jpeg'
        })
      } catch {
        /* skip unreadable frame */
      }
    }
  } else if (Array.isArray(record.frames)) {
    for (let i = 0; i < Math.min(6, record.frames.length); i += 1) {
      const f = record.frames[i] as Record<string, unknown>
      if (f && typeof f.base64 === 'string' && f.base64.trim()) {
        framesInput.push({
          index: Number(f.index) || i + 1,
          timecode: typeof f.timecode === 'string' ? f.timecode : `00:0${i}.0`,
          base64: f.base64.trim(),
          mimeType: typeof f.mimeType === 'string' ? f.mimeType : 'image/jpeg'
        })
      }
    }
  }

  if (framesInput.length === 0) {
    ctx.sendJson(res, 400, { error: '未找到可用于分析的视频关键帧画面' })
    return true
  }

  const started = Date.now()

  // #124/#127: local VLM is the default; an explicit Gemini backend still
  // falls back to Ollama if the upstream call fails, and only then reports 503.
  if (resolveAnalyzeFramesBackend() === 'ollama') {
    try {
      const result = await requestOllamaFrameAnalysis(framesInput, videoSummary)
      completeFrameAnalysis(ctx, res, sessionId, result.model, started, result.parsed, framesInput)
    } catch (err) {
      sendLlmUnavailable(ctx, res, err)
    }
    return true
  }

  const ai = createGeminiClient()
  if (!ai) {
    sendLlmUnavailable(ctx, res, new Error('GEMINI_API_KEY is not configured'))
    return true
  }

  const systemInstruction = FRAME_ANALYSIS_SYSTEM_INSTRUCTION

  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
    {
      text: `视频基本信息：${videoSummary}。以下共 ${framesInput.length} 张按时间顺序抽取的关键帧图片（依次对应第 ${framesInput.map((f) => `${f.index} 帧 ${f.timecode}`).join('、')}），请逐帧分析并输出完整 JSON：`
    }
  ]

  for (const frame of framesInput) {
    parts.push({
      inlineData: {
        mimeType: frame.mimeType,
        data: frame.base64
      }
    })
  }

  let lastError: unknown = null

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: { parts },
        config: {
          systemInstruction,
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            required: [
              'overall_assessment',
              'recommended_profile',
              'recommended_profile_reason',
              'recommended_params',
              'shots'
            ],
            properties: {
              overall_assessment: { type: Type.STRING, description: '全片画质、光线、稳定性与风格总评' },
              recommended_profile: {
                type: Type.STRING,
                description: 'natural_clarity | teal_orange | warm_film | landscape_vivid'
              },
              recommended_profile_reason: { type: Type.STRING, description: '选择该调色风格的理由' },
              recommended_params: {
                type: Type.OBJECT,
                required: ['denoise', 'sharpen', 'contrast', 'brightness', 'saturation', 'warmth', 'upscale_1080p', 'smooth_30fps'],
                properties: {
                  denoise: { type: Type.INTEGER },
                  sharpen: { type: Type.INTEGER },
                  contrast: { type: Type.INTEGER },
                  brightness: { type: Type.INTEGER },
                  saturation: { type: Type.INTEGER },
                  warmth: { type: Type.INTEGER },
                  upscale_1080p: { type: Type.BOOLEAN },
                  smooth_30fps: { type: Type.BOOLEAN }
                }
              },
              shots: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  required: [
                    'frame_index',
                    'timecode',
                    'shot_type',
                    'subject',
                    'lighting_color',
                    'flaw_diagnosis',
                    'enhance_action'
                  ],
                  properties: {
                    frame_index: { type: Type.INTEGER },
                    timecode: { type: Type.STRING },
                    shot_type: { type: Type.STRING },
                    subject: { type: Type.STRING },
                    lighting_color: { type: Type.STRING },
                    flaw_diagnosis: { type: Type.STRING },
                    enhance_action: { type: Type.STRING }
                  }
                }
              }
            }
          }
        }
      })

      const rawText = (response.text ?? '').trim()
      if (!rawText) throw new Error('Gemini 未返回有效画面分析结果')
      const parsed = JSON.parse(rawText) as Record<string, unknown>
      completeFrameAnalysis(ctx, res, sessionId, GEMINI_MODEL, started, parsed, framesInput)
      return true
    } catch (err) {
      lastError = err
      if (attempt < MAX_RETRIES && isRetryableGeminiError(err)) {
        await sleep(400 * (attempt + 1))
        continue
      }
      break
    }
  }

  const normalized = normalizeGeminiError(lastError)
  try {
    const result = await requestOllamaFrameAnalysis(framesInput, videoSummary)
    completeFrameAnalysis(ctx, res, sessionId, result.model, started, result.parsed, framesInput)
  } catch (ollamaErr) {
    sendLlmUnavailable(
      ctx,
      res,
      new Error(
        `${normalized.code}: ${normalized.message}; Ollama: ${ollamaErr instanceof Error ? ollamaErr.message : String(ollamaErr)}`
      )
    )
  }
  return true
}

export type HistoricalGroundingReason =
  | 'story_era_empty'
  | 'user_disabled'
  | 'story_era_present'
  | 'historical_template'

export interface HistoricalGroundingDecision {
  used: boolean
  reason: HistoricalGroundingReason
}

/**
 * Historical grounding requires a concrete story era. An empty `story_era`
 * must never trigger era/KB injection, even when the caller sends
 * `use_historical_grounding: true` (older clients defaulted it to true and
 * polluted modern ads with unrelated dynasties such as Qing).
 */
export function resolveHistoricalGroundingDecision(input: {
  useHistoricalGroundingFlag?: unknown
  templateId?: string
  storyEra?: string
}): HistoricalGroundingDecision {
  const storyEra = typeof input.storyEra === 'string' ? input.storyEra.trim() : ''
  if (!storyEra) return { used: false, reason: 'story_era_empty' }
  if (typeof input.useHistoricalGroundingFlag === 'boolean') {
    return input.useHistoricalGroundingFlag
      ? { used: true, reason: 'story_era_present' }
      : { used: false, reason: 'user_disabled' }
  }
  if (input.templateId === 'historical_novel') {
    return { used: true, reason: 'historical_template' }
  }
  return { used: false, reason: 'user_disabled' }
}

export function resolveUseHistoricalGrounding(input: {
  useHistoricalGroundingFlag?: unknown
  templateId?: string
  storyEra?: string
}): boolean {
  return resolveHistoricalGroundingDecision(input).used
}

export function buildLocalHistoricalContext(storyEra: string, prompt: string): {
  matchedEras: string[]
  localKbBrief: string
} {
  const matchedEntries = matchHistoricalKnowledge(storyEra, prompt)
  return {
    matchedEras: matchedEntries.map((entry) => entry.eraLabel),
    localKbBrief: formatHistoricalKnowledgeBrief(matchedEntries)
  }
}

async function verifyHistoricalFactBrief(
  ai: GoogleGenAI,
  prompt: string,
  storyEra: string
): Promise<{
  brief: string
  localKbBrief: string
  matchedEras: string[]
  sources: HistoricalSourceRef[]
}> {
  const { matchedEras, localKbBrief } = buildLocalHistoricalContext(storyEra, prompt)

  try {
    const query = [
      '请担任严谨的历史文献顾问，针对以下影视小说/历史故事创意，结合历史知识库与真实史料核验关键背景：',
      `设定时期/背景：${storyEra || '依据故事线索自动识别真实朝代/年代'}`,
      `故事创意：${prompt}`,
      ...(localKbBrief ? ['', localKbBrief] : []),
      '请用简洁精确的中文要点总结（250字以内）：1）确切朝代纪年与社会风貌；2）符合当时历史真实的服饰冠带、器物饮食、建筑斗拱形制；3）必须规避的时代错置/穿越雷区。'
    ].join('\n')

    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: query,
      config: {
        tools: [{ googleSearch: {} }]
      }
    })

    const groundedText = (response.text ?? '').trim()
    const combinedBrief = [
      groundedText,
      matchedEras.length > 0 ? `（已注入本地历史知识库：${matchedEras.join('、')}）` : ''
    ]
      .filter(Boolean)
      .join('\n')
    const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks
    const seen = new Set<string>()
    const sources: HistoricalSourceRef[] = []
    if (Array.isArray(chunks)) {
      for (const ch of chunks) {
        const uri = ch?.web?.uri?.trim()
        if (!uri || seen.has(uri)) continue
        seen.add(uri)
        sources.push({
          title: ch?.web?.title?.trim() || uri,
          url: uri
        })
        if (sources.length >= 5) break
      }
    }
    return {
      brief: combinedBrief || localKbBrief,
      localKbBrief,
      matchedEras,
      sources
    }
  } catch (err) {
    console.warn('[gemini] historical googleSearch grounding skipped:', err instanceof Error ? err.message : String(err))
    return {
      brief: localKbBrief,
      localKbBrief,
      matchedEras,
      sources: []
    }
  }
}

function resolveOllamaUrl(): string {
  return (process.env.OLLAMA_URL?.trim() || OLLAMA_DEFAULT_URL).replace(/\/+$/, '')
}

function resolveOllamaTextModel(): string {
  return process.env.OLLAMA_TEXT_MODEL?.trim() || OLLAMA_DEFAULT_TEXT_MODEL
}

function resolveOllamaVlmModel(): string {
  return process.env.OLLAMA_VLM_MODEL?.trim() || OLLAMA_DEFAULT_VLM_MODEL
}

/**
 * Local VLM is the default for frame analysis. Gemini is opt-in only when
 * `WEB_LLM_BACKEND=gemini` **and** a key is configured.
 */
export function resolveAnalyzeFramesBackend(env: NodeJS.ProcessEnv = process.env): 'ollama' | 'gemini' {
  const backend = (env.WEB_LLM_BACKEND ?? '').trim().toLowerCase()
  return backend === 'gemini' && Boolean(env.GEMINI_API_KEY?.trim()) ? 'gemini' : 'ollama'
}

function buildFrameAnalysisPrompt(
  videoSummary: string,
  framesInput: Array<{ index: number; timecode: string }>
): string {
  return [
    FRAME_ANALYSIS_SYSTEM_INSTRUCTION,
    `视频基本信息：${videoSummary}。以下共 ${framesInput.length} 张按时间顺序抽取的关键帧图片（依次对应第 ${framesInput.map((f) => `${f.index} 帧 ${f.timecode}`).join('、')}），请逐帧分析并输出完整 JSON：`
  ].join('\n\n')
}

async function requestOllamaFrameAnalysis(
  framesInput: Array<{ index: number; timecode: string; base64: string; mimeType: string }>,
  videoSummary: string
): Promise<{ model: string; parsed: Record<string, unknown> }> {
  const url = resolveOllamaUrl()
  const model = resolveOllamaVlmModel()
  let res: Response
  try {
    res = await ollamaFetch(`${url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt: buildFrameAnalysisPrompt(videoSummary, framesInput),
        images: framesInput.map((f) => f.base64),
        stream: false,
        format: 'json',
        options: { temperature: 0.2 }
      }),
      signal: AbortSignal.timeout(OLLAMA_VLM_TIMEOUT_MS)
    })
  } catch (err) {
    throw new Error(`Ollama VLM unreachable at ${url}: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!res.ok) throw new Error(`Ollama VLM HTTP ${res.status}`)

  const body = (await res.json()) as { response?: unknown }
  const text = String(body.response ?? '').trim()
  if (!text) throw new Error('Ollama VLM returned an empty response')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('Ollama VLM response is not valid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Ollama VLM response is not a JSON object')
  }
  return { model, parsed: parsed as Record<string, unknown> }
}

/**
 * Local-model fallback for script generation when no Gemini key is configured
 * (or the Gemini call fails). Uses Ollama's JSON mode and parses the structured
 * script server-side; callers must not fabricate a script when this throws.
 */
async function generateScriptWithOllama(prompt: string): Promise<{
  model: string
  parsed: Record<string, unknown>
}> {
  const url = resolveOllamaUrl()
  const model = resolveOllamaTextModel()
  let res: Response
  try {
    res = await ollamaFetch(`${url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        format: 'json',
        options: { temperature: 0.4, num_predict: 1800 }
      }),
      signal: AbortSignal.timeout(OLLAMA_SCRIPT_TIMEOUT_MS)
    })
  } catch (err) {
    throw new Error(`Ollama unreachable at ${url}: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`)

  const body = (await res.json()) as { response?: unknown }
  const text = String(body.response ?? '').trim()
  if (!text) throw new Error('Ollama returned an empty response')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('Ollama response is not valid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Ollama response is not a JSON object')
  }
  return { model, parsed: parsed as Record<string, unknown> }
}

export async function handleGeminiRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  ctx: GeminiRouteContext
): Promise<boolean> {
  if (ctx.dataRoot && ctx.readJson && ctx.atomicWriteJson) {
    configureTemplateAutoSyncScheduler({
      dataRoot: ctx.dataRoot,
      readJson: ctx.readJson,
      atomicWriteJson: ctx.atomicWriteJson
    })
  }

  if (pathname === '/api/gemini/script-templates') {
    if (req.method !== 'GET') {
      res.statusCode = 405
      res.setHeader('Allow', 'GET')
      res.end()
      return true
    }
    const urlObj = new URL(req.url ?? pathname, 'http://localhost')
    const category = urlObj.searchParams.get('category')
    const allItems = getMergedScriptTemplates(ctx.dataRoot, ctx.readJson)
    const filteredItems = getMergedScriptTemplates(ctx.dataRoot, ctx.readJson, category)
    const categories = Array.from(new Set(allItems.map((t) => t.category)))
    const sync = getTemplateSyncState(ctx.dataRoot, ctx.readJson)
    ctx.sendJson(res, 200, {
      items: filteredItems,
      total: filteredItems.length,
      all_total: allItems.length,
      categories,
      sync
    })
    return true
  }

  if (pathname === '/api/gemini/script-templates/sync') {
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.setHeader('Allow', 'POST')
      res.end()
      return true
    }
    const auth = ctx.authorizeWrite?.(req)
    if (!auth) {
      ctx.sendJson(res, 403, { error: 'script template write authorization is not wired' })
      return true
    }
    if (!auth.ok) {
      ctx.sendJson(res, auth.status, { error: auth.error })
      return true
    }
    let body: unknown = {}
    try {
      body = await ctx.readBody(req)
    } catch {
      body = {}
    }
    const rec = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
    const sourceMode =
      rec.source === 'gitea' || rec.source === 'gitea_discover'
        ? rec.source
        : rec.source === 'all'
          ? 'all'
          : 'github'
    const giteaRepo = typeof rec.giteaRepo === 'string' && rec.giteaRepo.trim() ? rec.giteaRepo.trim() : undefined
    const giteaBranch = typeof rec.giteaBranch === 'string' && rec.giteaBranch.trim() ? rec.giteaBranch.trim() : undefined
    const giteaFilePath = typeof rec.giteaFilePath === 'string' && rec.giteaFilePath.trim() ? rec.giteaFilePath.trim() : undefined
    const agentAutoDiscover = rec.agentAutoDiscover !== false

    let sync = getTemplateSyncState(ctx.dataRoot, ctx.readJson)
    const syncedSkills: string[] = []
    let updatedCount = 0

    if (sourceMode === 'github' || sourceMode === 'all') {
      const gh = await syncScriptTemplatesFromGitHub({
        mode: 'manual',
        dataRoot: ctx.dataRoot,
        readJson: ctx.readJson,
        atomicWriteJson: ctx.atomicWriteJson
      })
      sync = gh.sync
      syncedSkills.push(...gh.syncedSkills)
    }

    if (sourceMode === 'gitea' || sourceMode === 'gitea_discover' || sourceMode === 'all') {
      if (agentAutoDiscover || sourceMode === 'gitea_discover' || !giteaFilePath) {
        const discovered = await agentDiscoverAndSyncGiteaTemplates({
          mode: 'manual',
          preferredRepo: giteaRepo,
          preferredBranch: giteaBranch,
          dataRoot: ctx.dataRoot,
          readJson: ctx.readJson,
          atomicWriteJson: ctx.atomicWriteJson
        })
        sync = discovered.sync
        updatedCount = discovered.updatedCount
        syncedSkills.push(...discovered.syncedSkills)
      } else {
        const gt = await syncScriptTemplatesFromGitea({
          repo: giteaRepo,
          branch: giteaBranch,
          filePath: giteaFilePath,
          dataRoot: ctx.dataRoot,
          readJson: ctx.readJson,
          atomicWriteJson: ctx.atomicWriteJson
        })
        sync = gt.sync
        updatedCount = gt.updatedCount
        syncedSkills.push(...gt.syncedSkills)
      }
    }

    const items = getMergedScriptTemplates(ctx.dataRoot, ctx.readJson)
    ctx.sendJson(res, 200, {
      ok: true,
      items,
      total: items.length,
      categories: Array.from(new Set(items.map((t) => t.category))),
      updated_count: updatedCount,
      sync,
      synced_skills: syncedSkills
    })
    return true
  }

  if (pathname === '/api/gemini/historical-kb/lookup') {
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.setHeader('Allow', 'POST')
      res.end()
      return true
    }
    let body: unknown = {}
    try {
      body = await ctx.readBody(req)
    } catch {
      ctx.sendJson(res, 400, { error: 'invalid JSON body' })
      return true
    }
    const rec = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
    const prompt = typeof rec.prompt === 'string' ? rec.prompt.trim().slice(0, 2000) : ''
    const storyEra = typeof rec.story_era === 'string' ? rec.story_era.trim().slice(0, 120) : ''
    const started = Date.now()

    const matchedEntries = matchHistoricalKnowledge(storyEra, prompt)
    const kbBrief = formatHistoricalKnowledgeBrief(matchedEntries)
    const eraLabels = matchedEntries.map((entry) => entry.eraLabel)
    const ai = createGeminiClient()

    if (ai && (prompt || storyEra)) {
      try {
        const grounded = await verifyHistoricalFactBrief(ai, prompt || storyEra, storyEra)
        ctx.sendJson(res, 200, {
          ok: true,
          era_labels: eraLabels,
          brief: grounded.brief || kbBrief || '暂未匹配到特定朝代条目，将在生成时自动根据剧情年代检索史料。',
          sources: grounded.sources,
          ai_verified: Boolean(grounded.brief && grounded.brief !== kbBrief) || grounded.sources.length > 0,
          model: GEMINI_MODEL,
          elapsed_ms: Date.now() - started
        })
        return true
      } catch {
        // Fallback smoothly to local KB synthesis below
      }
    }

    ctx.sendJson(res, 200, {
      ok: true,
      era_labels: eraLabels,
      brief:
        kbBrief ||
        '已启用本地历史知识库守护：请在「历史时期」选择对应朝代或在创意中提及朝代/地名，系统将自动检索服饰礼制、器物形制与穿帮禁忌。',
      sources: [],
      ai_verified: false,
      model: ai ? GEMINI_MODEL : null,
      elapsed_ms: Date.now() - started
    })
    return true
  }

  if (pathname === '/api/gemini/script-templates/schedule') {
    if (req.method !== 'PATCH' && req.method !== 'POST') {
      res.statusCode = 405
      res.setHeader('Allow', 'PATCH, POST')
      res.end()
      return true
    }
    const auth = ctx.authorizeWrite?.(req)
    if (!auth) {
      ctx.sendJson(res, 403, { error: 'script template write authorization is not wired' })
      return true
    }
    if (!auth.ok) {
      ctx.sendJson(res, auth.status, { error: auth.error })
      return true
    }
    let body: unknown = {}
    try {
      body = await ctx.readBody(req)
    } catch {
      ctx.sendJson(res, 400, { error: 'invalid JSON body' })
      return true
    }
    const rec = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
    const sync = updateTemplateSyncSchedule({
      autoSyncEnabled: typeof rec.autoSyncEnabled === 'boolean' ? rec.autoSyncEnabled : undefined,
      intervalHours: typeof rec.intervalHours === 'number' ? rec.intervalHours : undefined,
      giteaRepo: typeof rec.giteaRepo === 'string' ? rec.giteaRepo : undefined,
      giteaBranch: typeof rec.giteaBranch === 'string' ? rec.giteaBranch : undefined,
      giteaFilePath: typeof rec.giteaFilePath === 'string' ? rec.giteaFilePath : undefined,
      giteaEnabled: typeof rec.giteaEnabled === 'boolean' ? rec.giteaEnabled : undefined,
      dataRoot: ctx.dataRoot,
      readJson: ctx.readJson,
      atomicWriteJson: ctx.atomicWriteJson
    })
    if (ctx.dataRoot && ctx.readJson && ctx.atomicWriteJson) {
      configureTemplateAutoSyncScheduler({
        dataRoot: ctx.dataRoot,
        readJson: ctx.readJson,
        atomicWriteJson: ctx.atomicWriteJson
      })
    }
    ctx.sendJson(res, 200, { ok: true, sync })
    return true
  }

  if (pathname === '/api/gemini/analyze-frames') {
    return handleAnalyzeFrames(req, res, ctx)
  }
  if (pathname !== '/api/gemini/script') return false

  if (req.method !== 'POST') {
    res.statusCode = 405
    res.setHeader('Allow', 'POST')
    res.end()
    return true
  }

  const auth = ctx.authorizeWrite?.(req)
  if (!auth) {
    ctx.sendJson(res, 403, { error: 'script write authorization is not wired' })
    return true
  }
  if (!auth.ok) {
    ctx.sendJson(res, auth.status, { error: auth.error })
    return true
  }

  let body: unknown
  try {
    body = await ctx.readBody(req)
  } catch (err) {
    ctx.sendJson(res, 400, { error: err instanceof Error ? err.message : 'invalid JSON body' })
    return true
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    ctx.sendJson(res, 400, { error: '请求体必须为 JSON 对象' })
    return true
  }

  const record = body as Record<string, unknown>
  const prompt = typeof record.prompt === 'string' ? record.prompt.trim() : ''
  if (!prompt || prompt.length > 2000) {
    ctx.sendJson(res, 400, { error: 'prompt 必填，且长度需在 1..2000 字符之间' })
    return true
  }

  const templateList = getMergedScriptTemplates(ctx.dataRoot, ctx.readJson)
  const requestedTplId = typeof record.template_id === 'string' ? record.template_id.trim() : null
  const template =
    (requestedTplId ? templateList.find((t) => t.id === requestedTplId) : null) ??
    getScriptPromptTemplate(requestedTplId)
  const customDirectives =
    typeof record.custom_directives === 'string' && record.custom_directives.trim()
      ? record.custom_directives.trim().slice(0, 1500)
      : template.systemDirectives

  const profile =
    typeof record.profile === 'string' && record.profile.trim()
      ? record.profile.trim().slice(0, 80)
      : template.recommendedProfile
  const tone =
    typeof record.tone === 'string' && record.tone.trim()
      ? record.tone.trim().slice(0, 120)
      : '克制温暖 · 青橙电影商业质感'
  const aspect =
    typeof record.aspect === 'string' && ['16:9', '9:16', '1:1', '4:5'].includes(record.aspect.trim())
      ? record.aspect.trim()
      : '16:9'
  const durationRaw = Number(record.duration_s)
  const duration_s =
    Number.isFinite(durationRaw) && durationRaw >= 5 && durationRaw <= 180
      ? Math.round(durationRaw)
      : template.recommendedDurationS
  const mode =
    record.mode === 'optimize'
      ? 'optimize'
      : record.mode === 'regenerate'
        ? 'regenerate'
        : 'generate'
  const episodeMode: 'single' | 'novel_series' =
    record.episode_mode === 'novel_series' ? 'novel_series' : 'single'
  const storyEra =
    typeof record.story_era === 'string' && record.story_era.trim()
      ? record.story_era.trim().slice(0, 80)
      : ''
  const groundingDecision = resolveHistoricalGroundingDecision({
    useHistoricalGroundingFlag: record.use_historical_grounding,
    templateId: template.id,
    storyEra
  })
  const useHistoricalGrounding = groundingDecision.used
  const previousTitle =
    typeof record.previousTitle === 'string' && record.previousTitle.trim()
      ? record.previousTitle.trim().slice(0, 120)
      : ''

  let previousScriptContext = ''
  if (mode === 'optimize' && record.previous_script && typeof record.previous_script === 'object') {
    const prev = record.previous_script as Record<string, unknown>
    const prevScenes = Array.isArray(prev.scenes) ? prev.scenes.slice(0, 6) : []
    const compactScenes = prevScenes
      .map((s) => {
        if (!s || typeof s !== 'object') return ''
        const sc = s as Record<string, unknown>
        return `场${sc.scene_no ?? ''}(${sc.duration_s ?? ''}s): ${sc.shot_type ?? ''} | ${sc.visual ?? ''} | 旁白:${sc.voiceover ?? ''}`
      })
      .filter(Boolean)
      .join('\n')
    previousScriptContext = [
      `已有剧本标题：${typeof prev.title === 'string' ? prev.title : previousTitle}`,
      `已有梗概：${typeof prev.logline === 'string' ? prev.logline : ''}`,
      compactScenes ? `已有分场草稿：\n${compactScenes}` : ''
    ]
      .filter(Boolean)
      .join('\n')
  }

  const started = Date.now()
  const ai = createGeminiClient()
  let historicalGrounding: {
    brief: string
    localKbBrief: string
    matchedEras: string[]
    sources: HistoricalSourceRef[]
  } = {
    brief: '',
    localKbBrief: '',
    matchedEras: [],
    sources: []
  }
  if (useHistoricalGrounding) {
    if (ai) {
      historicalGrounding = await verifyHistoricalFactBrief(ai, prompt, storyEra)
    } else {
      const local = buildLocalHistoricalContext(storyEra, prompt)
      historicalGrounding = {
        brief: local.localKbBrief,
        localKbBrief: local.localKbBrief,
        matchedEras: local.matchedEras,
        sources: []
      }
    }
  }

  const groundingMeta = {
    used: groundingDecision.used,
    reason: groundingDecision.reason,
    matched_eras: historicalGrounding.matchedEras,
    sources: historicalGrounding.sources
  }

  const normalizeDefaults = {
    tone,
    aspect,
    duration_s,
    profile,
    template_id: template.id,
    template_label: template.label,
    story_era: storyEra || undefined,
    episode_mode: episodeMode,
    historical_context: historicalGrounding.brief || undefined,
    historical_sources: historicalGrounding.sources
  }

  // Director-First Storyboard Compiler prompt adapted from open-source GitHub AI video director specs
  // (director-skills / visual-skills / prompt-storyboard-studio / juspay-director):
  const systemInstruction = [
    '你是 Kex Labs 制片平台的 Director-First AI 编剧与分镜编译 Agent（遵循开源 AI Director Storyboard Compiler 行业标准）。',
    `当前激活视频类型模板：【${template.label}】（${template.englishName} · 参考规范 ${template.githubStandard}）`,
    `推荐戏剧节拍结构：${template.structureBeats}`,
    `光学镜头与节奏标准：${template.opticalSpec}`,
    '核心创作指令（必须严格遵守）：',
    customDirectives,
    ...(episodeMode === 'novel_series'
      ? [
          '【整部小说 · 多章长故事编剧要求】：',
          '- 必须在 chapters 字段输出 4~6 章连贯的小说/系列视频总纲（每章含 chapter_no, title, era_anchor, key_conflict, summary），构建完整起承转合命运弧光。',
          '- 同时在 scenes 字段细化【第 1 章 / 开篇先导集】的高精度可拍摄分场剧本。'
        ]
      : []),
    ...(useHistoricalGrounding
      ? [
          '【历史史实严谨性要求】：',
          '- 必须在 historical_context 中交代经核验的真实时代背景、服饰冠带、器物建筑与民俗规范，严禁任何跨朝代穿帮（如时代不符的衣物、家具、作物与词汇）。'
        ]
      : []),
    '硬性输出规范：',
    '1. 严格使用具体光学与物理光影语言描述画面（如 24mm/35mm/50mm/85mm 焦段、景深、逆光/侧逆光/湿润反射）；严禁堆砌无意义质量黑话（禁止出现 4K、8K、超高清、大师杰作、Unreal Engine、hyperrealistic 等空洞词）。',
    '2. 节奏拆解：生成 4~6 个分场镜头，单镜时长符合模板推荐窗口（2.5s~6.5s），总时长紧密贴近目标时长。',
    '3. 视觉连续性锁定（continuity_anchor）：每一镜必须明确说明与前一镜衔接的服装/道具状态、180° 轴线视线或光线方向，避免跳切穿帮。',
    '4. 模型就绪提示词（video_prompt）：每一镜必须输出一条英文 I2V 专用生视频提示词，按公式组织：[Shot Type + Lens mm + Camera Motion] + [Subject Action & Texture] + [Physical Lighting & Color Palette] + [Motion Cadence]。',
    '5. 必须在 optimization_notes 中简明扼要概括本版如何按照所选 GitHub 视频类型标准完成结构与镜头优化。',
    mode === 'optimize'
      ? `6. 当前为「按新模板即时优化」模式：请保留用户核心创意主题，但将原有草稿的叙事视角、镜别焦段、剪辑节奏、旁白口吻与 I2V 提示词彻底重构优化为「${template.label}」专业标准。`
      : mode === 'regenerate'
        ? `6. 当前为「重新生成」模式，请彻底重构开场切入角度与视觉隐喻，避免与上一版「${previousTitle || '上一版'}」雷同。`
        : '6. 请确保画面描写与旁白/音效形成声画对位，留出呼吸感气口。'
  ].join('\n')

  const userContents = [
    `创意与制片需求（Prompt）：${prompt}`,
    `视频类型模板（Template）：${template.id} · ${template.label}`,
    `故事体裁模式（Episode Mode）：${episodeMode === 'novel_series' ? '整部小说 · 多章连载（需输出 chapters 章节总纲 + 开篇分场）' : '单集成片'}`,
    ...(storyEra ? [`设定历史时期（Era）：${storyEra}`] : []),
    `平台导演风格模板（Profile）：${profile}`,
    `目标成片总时长：${duration_s} 秒`,
    `画幅比例（Aspect）：${aspect}`,
    `叙事基调（Tone）：${tone}`,
    ...(historicalGrounding.localKbBrief
      ? ['', '--- 本地历史知识库参考上下文（必须严格遵循其服饰、器物、建筑与穿帮禁忌） ---', historicalGrounding.localKbBrief]
      : []),
    ...(historicalGrounding.brief && historicalGrounding.brief !== historicalGrounding.localKbBrief
      ? ['', '--- Google Search 实时核验史实补充 ---', historicalGrounding.brief]
      : []),
    ...(previousScriptContext ? ['', '--- 待优化升级的现有剧本 ---', previousScriptContext] : [])
  ].join('\n')

  let geminiError: string | null = null

  // Gemini is preferred when GEMINI_API_KEY is configured; Ollama covers the
  // no-key case and any Gemini failure below.
  if (ai) {
  let lastError: unknown = null

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: userContents,
        config: {
          systemInstruction,
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            required: ['title', 'logline', 'tone', 'style', 'optimization_notes', 'duration_s', 'scenes'],
            properties: {
              title: { type: Type.STRING, description: '简练有力的视频剧本标题' },
              logline: { type: Type.STRING, description: '一句话故事线与戏剧弧光（15~85字）' },
              tone: { type: Type.STRING, description: '最终确立的叙事基调与情绪温度' },
              style: { type: Type.STRING, description: '光学镜头组、色温调性与剪辑呼吸节奏说明' },
              optimization_notes: {
                type: Type.STRING,
                description: '说明本版剧本如何落实当前所选 GitHub 视频类型标准（25~90字）'
              },
              story_era: {
                type: Type.STRING,
                description: '本片/本小说所处的具体朝代或历史年代标签'
              },
              historical_context: {
                type: Type.STRING,
                description: '结合真实历史核验的时代风貌、服饰礼制与美术器物考据要点'
              },
              duration_s: { type: Type.INTEGER, description: '各分场合计秒数' },
              chapters: {
                type: Type.ARRAY,
                description: '整部小说/多章连载模式下的 4~6 章故事脉络总纲（非连载可省略或返回空数组）',
                items: {
                  type: Type.OBJECT,
                  required: ['chapter_no', 'title', 'era_anchor', 'summary', 'key_conflict'],
                  properties: {
                    chapter_no: { type: Type.INTEGER },
                    title: { type: Type.STRING },
                    era_anchor: { type: Type.STRING },
                    summary: { type: Type.STRING },
                    key_conflict: { type: Type.STRING }
                  }
                }
              },
              scenes: {
                type: Type.ARRAY,
                description: '4到6个分场镜头',
                items: {
                  type: Type.OBJECT,
                  required: [
                    'scene_no',
                    'timecode',
                    'duration_s',
                    'shot_type',
                    'camera',
                    'continuity_anchor',
                    'visual',
                    'video_prompt',
                    'voiceover',
                    'audio'
                  ],
                  properties: {
                    scene_no: { type: Type.INTEGER, description: '分场序号，从 1 开始' },
                    timecode: { type: Type.STRING, description: '如 00:00 - 00:03.5' },
                    duration_s: { type: Type.NUMBER, description: '本镜持续秒数（建议 2.5~6.5s）' },
                    shot_type: { type: Type.STRING, description: '景别与焦段，如 特写 · 50mm' },
                    camera: { type: Type.STRING, description: '运镜方式，如 缓慢推进 / 横摇跟随' },
                    continuity_anchor: {
                      type: Type.STRING,
                      description: '前后镜头衔接锚点：人物/道具位置、光线方向与色调一致性约束'
                    },
                    visual: { type: Type.STRING, description: '中文具体画面动作、材质细节与物理光影描写' },
                    video_prompt: {
                      type: Type.STRING,
                      description: '英文 I2V 模型专用生视频提示词（禁止 4k/8k/masterpiece 等无效词）'
                    },
                    voiceover: { type: Type.STRING, description: '旁白、台词或环境音留白说明' },
                    audio: { type: Type.STRING, description: 'BGM 情绪配器与细节拟音（Foley）' }
                  }
                }
              }
            }
          }
        }
      })

      const rawText = (response.text ?? '').trim()
      if (!rawText) {
        throw new Error('Gemini 未返回有效剧本文本')
      }
      const parsed = JSON.parse(rawText) as Record<string, unknown>
      const script = normalizeGeneratedScript(parsed, normalizeDefaults)
      ctx.sendJson(res, 200, {
        model: GEMINI_MODEL,
        elapsed_ms: Date.now() - started,
        grounding: groundingMeta,
        script
      })
      return true
    } catch (err) {
      lastError = err
      if (attempt < MAX_RETRIES && isRetryableGeminiError(err)) {
        await sleep(400 * (attempt + 1))
        continue
      }
      break
    }
  }

  const normalized = normalizeGeminiError(lastError)
  geminiError = `${normalized.code}: ${normalized.message}`
  console.error(
    `[gemini] POST /api/gemini/script -> ${normalized.status} (${normalized.code}); falling back to Ollama`
  )
  }

  const scriptPrompt = [
    systemInstruction,
    '',
    userContents,
    '',
    '只输出一个 JSON 对象（不要 Markdown 代码块或解释），字段为：',
    '{"title":string,"logline":string,"tone":string,"style":string,"optimization_notes":string,"story_era":string,"historical_context":string,"duration_s":number,"chapters":[{"chapter_no":number,"title":string,"era_anchor":string,"summary":string,"key_conflict":string}],"scenes":[{"scene_no":number,"timecode":string,"duration_s":number,"shot_type":string,"camera":string,"continuity_anchor":string,"visual":string,"video_prompt":string,"voiceover":string,"audio":string}]}',
    `请生成 4~6 个分场镜头，单镜 2.5~6.5 秒，总时长贴近 ${duration_s} 秒。`
  ].join('\n')

  try {
    const ollama = await generateScriptWithOllama(scriptPrompt)
    const script = normalizeGeneratedScript(ollama.parsed, normalizeDefaults)
    ctx.sendJson(res, 200, {
      model: ollama.model,
      elapsed_ms: Date.now() - started,
      grounding: groundingMeta,
      script
    })
    return true
  } catch (err) {
    const ollamaDetail = err instanceof Error ? err.message : String(err)
    const detail = geminiError ? `gemini: ${geminiError}; ollama: ${ollamaDetail}` : ollamaDetail
    console.error(`[gemini] POST /api/gemini/script -> 503 llm_unavailable (${detail})`)
    ctx.sendJson(res, 503, { error: 'llm_unavailable', detail })
    return true
  }
}
