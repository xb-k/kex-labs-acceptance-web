import assert from 'node:assert/strict'
import test, { after, beforeEach } from 'node:test'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { authorizeTaskWrite } from './api'
import {
  buildLocalHistoricalContext,
  buildScriptMarkdownFromScenes,
  handleGeminiRoute,
  isRetryableGeminiError,
  normalizeFrameAnalysis,
  normalizeGeneratedScript,
  resolveAnalyzeFramesBackend,
  resolveUseHistoricalGrounding
} from './gemini'
import { formatHistoricalKnowledgeBrief, matchHistoricalKnowledge } from './historical-kb'
import { discoverGiteaPromptFiles } from './gitea'
import {
  agentDiscoverAndSyncGiteaTemplates,
  getMergedScriptTemplates,
  getScriptPromptTemplate,
  getTemplateSyncState,
  GITHUB_SCRIPT_TEMPLATES,
  parseTemplateOverridesFromContent,
  syncScriptTemplatesFromGitea,
  updateTemplateSyncSchedule
} from './script-templates'

test('GITHUB_SCRIPT_TEMPLATES provides 7 industry-standard video types including historical_novel', () => {
  assert.equal(GITHUB_SCRIPT_TEMPLATES.length, 7)
  const categories = new Set(GITHUB_SCRIPT_TEMPLATES.map((t) => t.category))
  assert.ok(categories.has('营销'))
  assert.ok(categories.has('纪录片'))
  assert.ok(categories.has('叙事'))
  assert.ok(categories.has('小说历史'))
  for (const tpl of GITHUB_SCRIPT_TEMPLATES) {
    assert.ok(tpl.githubStandard.length > 5)
    assert.ok(tpl.systemDirectives.length > 40)
    assert.ok(tpl.structureBeats.length > 10)
  }
  assert.equal(getScriptPromptTemplate('documentary').category, '纪录片')
  assert.equal(getScriptPromptTemplate('historical_novel').category, '小说历史')
  assert.equal(getScriptPromptTemplate('unknown').id, 'marketing')
  assert.equal(getMergedScriptTemplates(undefined, undefined, '纪录片').length, 1)
  assert.equal(getMergedScriptTemplates(undefined, undefined, '营销').length, 1)
})

test('matchHistoricalKnowledge retrieves accurate dynasty attire, artifacts, and anachronism taboos', () => {
  const tang = matchHistoricalKnowledge('唐代 · 盛唐长安/敦煌丝路', '天宝年间胡姬酒肆')
  assert.ok(tang.length >= 1)
  assert.equal(tang[0].id, 'tang')
  const brief = formatHistoricalKnowledgeBrief(tang)
  assert.match(brief, /圆领襕衫/)
  assert.match(brief, /唐三彩/)
})

test('resolveUseHistoricalGrounding honors explicit switch state and buildLocalHistoricalContext formats KB context', () => {
  assert.equal(
    resolveUseHistoricalGrounding({
      useHistoricalGroundingFlag: false,
      templateId: 'historical_novel',
      storyEra: '唐代 · 盛唐长安/敦煌丝路'
    }),
    false
  )
  assert.equal(
    resolveUseHistoricalGrounding({
      useHistoricalGroundingFlag: true,
      templateId: 'marketing',
      storyEra: ''
    }),
    true
  )
  assert.equal(
    resolveUseHistoricalGrounding({
      templateId: 'historical_novel',
      storyEra: ''
    }),
    true
  )

  const ctx = buildLocalHistoricalContext('宋代 · 汴梁/江南市井雅韵', '江南瓦肆茶坊')
  assert.ok(ctx.matchedEras.includes('宋代 · 汴梁/江南市井雅韵'))
  assert.match(ctx.localKbBrief, /本地历史知识库档案/)
  assert.match(ctx.localKbBrief, /黑釉建盏/)
})

test('parseTemplateOverridesFromContent and syncScriptTemplatesFromGitea handle JSON/Markdown definitions', async () => {
  const parsedJson = parseTemplateOverridesFromContent(
    JSON.stringify({
      templates: [
        {
          id: 'documentary',
          summary: 'Gitea 更新版观察式纪录片规范',
          systemDirectives: '[Gitea Spec] 坚持 50mm 自然天光长镜头与真实同期声'
        }
      ]
    })
  )
  assert.match(parsedJson.documentary?.systemDirectives ?? '', /Gitea Spec/)

  const parsedMd = parseTemplateOverridesFromContent('## narrative\n[Gitea MD] 强化 180 度视线轴线锁定')
  assert.match(parsedMd.narrative?.systemDirectives ?? '', /180 度视线轴线/)

  const mockFetch: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        encoding: 'base64',
        content: Buffer.from(
          JSON.stringify([{ id: 'marketing', summary: '来自 Gitea 仓库的最新商业片规范' }]),
          'utf8'
        ).toString('base64')
      }),
      { status: 200 }
    )

  const res = await syncScriptTemplatesFromGitea({
    repo: 'gitadmin/kex-labs-video',
    branch: 'main',
    filePath: 'prompts/script-templates.json',
    fetchImpl: mockFetch
  })
  assert.equal(res.sync.giteaSource.status, 'synced')
  assert.equal(res.updatedCount, 1)
})

test('getTemplateSyncState and updateTemplateSyncSchedule support dual scheduled + manual + Gitea configuration', () => {
  const initial = getTemplateSyncState()
  assert.ok(initial.sources.length >= 3)
  assert.ok(initial.giteaSource.repo.length > 0)
  const updated = updateTemplateSyncSchedule({
    autoSyncEnabled: false,
    intervalHours: 12,
    giteaRepo: 'org/custom-prompts',
    giteaBranch: 'release'
  })
  assert.equal(updated.autoSyncEnabled, false)
  assert.equal(updated.intervalHours, 12)
  assert.equal(updated.giteaSource.repo, 'org/custom-prompts')
  assert.equal(updated.giteaSource.branch, 'release')
  const restored = updateTemplateSyncSchedule({ autoSyncEnabled: true, intervalHours: 24 })
  assert.equal(restored.autoSyncEnabled, true)
  assert.equal(restored.intervalHours, 24)
})

test('normalizeGeneratedScript normalizes missing fields, continuity anchors, historical context, chapters, and video prompts', () => {
  const out = normalizeGeneratedScript(
    {
      title: '长安星图驿站',
      logline: '天宝年间丝路驿站一夜间消失的星图卷轴',
      optimization_notes: '已按史实长故事连载规范锁定盛唐圆领袍与三彩器皿',
      historical_context: '盛唐天宝年间实行驿传勘合制度，男装多著圆领襕衫革带，酒器可见银鎏金盏与三彩执壶。',
      chapters: [
        {
          chapter_no: 1,
          title: '第一章 · 勘合密令',
          era_anchor: '天宝五载 · 洛阳都亭驿',
          summary: '画师临行前接过西域星图密匣。',
          key_conflict: '勘合符节缺角引发驿丞盘查'
        }
      ],
      scenes: [
        {
          duration_s: 4.2,
          shot_type: '中景 · 50mm',
          camera: '慢推',
          continuity_anchor: '画师身着赭黄圆领袍立于右侧檐下，竹灯笼位于左前景',
          visual: '暮雨落向唐式挑檐鸱吻，铜铃微颤',
          video_prompt: 'Medium 50mm slow push-in, Tang dynasty courier wearing ochre round-collar robe under timber eaves in twilight rain, 24fps',
          voiceover: '勘合文书上的朱印未干。',
          audio: '淅沥雨声与竹灯微响'
        }
      ]
    },
    {
      tone: '客观冷静',
      aspect: '16:9',
      duration_s: 30,
      profile: 'doc_neutral',
      template_id: 'historical_novel',
      template_label: '小说历史 · 史实长故事连载',
      story_era: '唐代 · 盛唐长安/敦煌丝路',
      episode_mode: 'novel_series',
      historical_sources: [{ title: '唐六典·驾部驿传', url: 'https://example.com/tang' }]
    }
  )

  assert.equal(out.title, '长安星图驿站')
  assert.equal(out.aspect, '16:9')
  assert.equal(out.profile, 'doc_neutral')
  assert.equal(out.template_id, 'historical_novel')
  assert.equal(out.story_era, '唐代 · 盛唐长安/敦煌丝路')
  assert.equal(out.episode_mode, 'novel_series')
  assert.equal(out.chapters?.length, 1)
  assert.equal(out.chapters?.[0].title, '第一章 · 勘合密令')
  assert.equal(out.historical_sources?.length, 1)
  assert.match(out.optimization_notes ?? '', /盛唐/)
  assert.equal(out.scenes.length, 1)
  assert.equal(out.scenes[0].scene_no, 1)
  assert.equal(out.scenes[0].timecode, '0.0s - 4.2s')
  assert.match(out.scenes[0].continuity_anchor, /圆领袍/)
  assert.match(out.scenes[0].video_prompt, /Medium 50mm/)
  assert.match(out.markdown, /# 长安星图驿站/)
  assert.match(out.markdown, /史实背景与时代考据/)
  assert.match(out.markdown, /整部故事 \/ 小说章节脉络总纲/)
  assert.match(out.markdown, /I2V 英文生成提示词/)
})

test('buildScriptMarkdownFromScenes renders headings and scene metadata lists cleanly', () => {
  const md = buildScriptMarkdownFromScenes({
    title: '测试标题',
    logline: '测试梗概',
    tone: '电影感',
    aspect: '9:16',
    style: '35mm',
    profile: 'vlog_warm_film',
    template_id: 'narrative',
    template_label: '剧情叙事 · 电影感短片',
    optimization_notes: '锁定 180° 轴线与 85mm 情绪特写转折',
    duration_s: 10,
    scenes: [
      {
        scene_no: 1,
        timecode: '00:00 - 00:05',
        duration_s: 5,
        shot_type: '特写',
        camera: '固定',
        continuity_anchor: '主体保持自然暖光源',
        visual: '镜头画面',
        video_prompt: 'Close-up 50mm locked tripod shot',
        voiceover: '旁白台词',
        audio: '轻音乐'
      }
    ]
  })
  assert.match(md, /## 分场拍摄与 AI 分镜提示词脚本/)
  assert.match(md, /### 场次 01 · 00:00 - 00:05/)
  assert.match(md, /\*\*视频类型模板\*\*：剧情叙事 · 电影感短片/)
  assert.match(md, /\*\*AI 导演优化说明\*\*：锁定 180° 轴线/)
  assert.match(md, /- \*\*视觉连续性锚点\*\*：主体保持自然暖光源/)
  assert.match(md, /- \*\*I2V 英文生成提示词\*\*：`Close-up 50mm locked tripod shot`/)
  assert.match(md, /- \*\*旁白 \/ 台词\*\*：旁白台词/)
})

test('isRetryableGeminiError detects transient upstream failures without retrying 4xx auth errors', () => {
  assert.equal(isRetryableGeminiError(new Error('503 Service Unavailable')), true)
  assert.equal(isRetryableGeminiError(new Error('request timeout')), true)
  assert.equal(isRetryableGeminiError(new Error('403 PERMISSION_DENIED')), false)
})

test('normalizeFrameAnalysis clamps parameters and fills missing shot metadata from fallback frames', () => {
  const result = normalizeFrameAnalysis(
    {
      overall_assessment: '暗部噪点偏多，整体偏冷',
      recommended_profile: 'warm_film',
      recommended_profile_reason: '适合暖色调人像肤色修复',
      recommended_params: {
        denoise: 150,
        sharpen: -10,
        contrast: 12,
        warmth: 99,
        upscale_1080p: true,
        smooth_30fps: false
      },
      shots: [
        {
          shot_type: '近景 · 人物',
          subject: '手持花艺特写',
          lighting_color: '阴影偏暗',
          flaw_diagnosis: '颗粒噪点略明显',
          enhance_action: '轻度降噪与提亮肤色'
        }
      ]
    },
    [{ index: 1, timecode: '00:00.8' }]
  )

  assert.equal(result.recommended_profile, 'warm_film')
  assert.equal(result.recommended_params.profile, 'warm_film')
  assert.equal(result.recommended_params.denoise, 100)
  assert.equal(result.recommended_params.sharpen, 0)
  assert.equal(result.recommended_params.warmth, 30)
  assert.equal(result.shots.length, 1)
  assert.equal(result.shots[0].frame_index, 1)
  assert.equal(result.shots[0].timecode, '00:00.8')
  assert.equal(result.shots[0].subject, '手持花艺特写')
})

test('discoverGiteaPromptFiles & agentDiscoverAndSyncGiteaTemplates autonomously scan repos and extract prompt specs', async () => {
  const prevUrl = process.env.GITEA_URL
  process.env.GITEA_URL = 'http://gitea.local'
  try {
    const mockFetch: typeof fetch = async (input) => {
      const url = String(input)
      if (url.includes('/api/v1/repos/search')) {
        return new Response(
          JSON.stringify({
            data: [{ full_name: 'kex/director-prompts', default_branch: 'main' }]
          }),
          { status: 200 }
        )
      }
      if (url.includes('/repos/kex/director-prompts/git/trees/')) {
        return new Response(
          JSON.stringify({
            tree: [
              { path: 'README.md', type: 'blob' },
              { path: 'prompts/script-templates.json', type: 'blob' }
            ]
          }),
          { status: 200 }
        )
      }
      if (url.includes('/repos/kex/director-prompts/contents/prompts/script-templates.json')) {
        return new Response(
          JSON.stringify({
            encoding: 'base64',
            content: Buffer.from(
              JSON.stringify({
                templates: [
                  {
                    id: 'historical_novel',
                    summary: 'Agent 自动扫描提取的盛唐考据长篇规范'
                  }
                ]
              }),
              'utf8'
            ).toString('base64')
          }),
          { status: 200 }
        )
      }
      return new Response('not found', { status: 404 })
    }

    const discovery = await discoverGiteaPromptFiles({ fetchImpl: mockFetch })
    assert.ok(discovery.scannedRepos.includes('kex/director-prompts'))
    assert.equal(discovery.candidates[0]?.repo, 'kex/director-prompts')
    assert.equal(discovery.candidates[0]?.filePath, 'prompts/script-templates.json')

    const syncRes = await agentDiscoverAndSyncGiteaTemplates({
      mode: 'manual',
      fetchImpl: mockFetch
    })
    assert.equal(syncRes.updatedCount, 1)
    assert.equal(syncRes.sync.giteaSource?.status, 'synced')
    assert.equal(syncRes.discoveredLocations[0]?.repo, 'kex/director-prompts')
  } finally {
    if (prevUrl === undefined) delete process.env.GITEA_URL
    else process.env.GITEA_URL = prevUrl
  }
})

// ---------------------------------------------------------------------------
// #124/#127 POST /api/gemini/script: Gemini preferred, Ollama JSON fallback.
// ---------------------------------------------------------------------------

const SCRIPT_JSON = {
  title: '山城早班车',
  logline: '一位夜班护士在清晨第一班轻轨上找回生活的秩序。',
  tone: '克制温暖 · 纪实',
  style: '35mm 自然光，低饱和青橙',
  optimization_notes: '按纪录片模板压缩节奏',
  duration_s: 12,
  scenes: [
    {
      scene_no: 1,
      timecode: '00:00 - 00:03',
      duration_s: 3,
      shot_type: '中景 · 35mm',
      camera: '缓慢推进',
      continuity_anchor: '晨雾方向与车窗反光保持一致',
      visual: '护士靠在车窗边，晨光扫过袖口',
      video_prompt: 'medium shot, 35mm, slow push-in, nurse by window, soft dawn light, 24fps',
      voiceover: '（车厢环境声）',
      audio: '低频车厢轰鸣与轻微刹车声'
    },
    {
      scene_no: 2,
      timecode: '00:03 - 00:07',
      duration_s: 4,
      shot_type: '特写 · 50mm',
      camera: '手持跟随',
      continuity_anchor: '袖口与上一镜同款',
      visual: '手指摩挲工牌边缘',
      video_prompt: 'close-up, 50mm, handheld, fingers on badge, dawn light, 24fps',
      voiceover: '今天可以慢一点。',
      audio: '钢琴单音与车厢底噪'
    }
  ]
}

const FRAME_ANALYSIS_JSON = {
  overall_assessment: '晨光稳定，暗部细节可再提升。',
  recommended_profile: 'natural_clarity',
  recommended_profile_reason: '纪实素材优先保留肤色与真实白平衡。',
  recommended_params: {
    denoise: 30,
    sharpen: 40,
    contrast: 8,
    brightness: 2,
    saturation: 6,
    warmth: 0,
    upscale_1080p: true,
    smooth_30fps: true
  },
  shots: [
    {
      frame_index: 1,
      timecode: '00:00.0',
      shot_type: '中景 · 自然视角',
      subject: '护士靠在车窗边',
      lighting_color: '清晨冷调侧光',
      flaw_diagnosis: '暗部轻微噪点',
      enhance_action: '轻度降噪后提升中间调反差'
    }
  ]
}

const SAME_ORIGIN_HEADERS = { host: '127.0.0.1:8088', origin: 'http://127.0.0.1:8088' }
const savedEnv = {
  gemini: process.env.GEMINI_API_KEY,
  ollama: process.env.OLLAMA_URL,
  model: process.env.OLLAMA_TEXT_MODEL,
  vlmModel: process.env.OLLAMA_VLM_MODEL,
  backend: process.env.WEB_LLM_BACKEND,
  token: process.env.WEB_WRITE_TOKEN
}

beforeEach(() => {
  delete process.env.GEMINI_API_KEY
  delete process.env.WEB_WRITE_TOKEN
  delete process.env.WEB_LLM_BACKEND
  process.env.OLLAMA_URL = 'http://127.0.0.1:11499'
  process.env.OLLAMA_TEXT_MODEL = 'script-test-model'
  process.env.OLLAMA_VLM_MODEL = 'vlm-test-model'
})

after(() => {
  const restore = (
    key: 'GEMINI_API_KEY' | 'OLLAMA_URL' | 'OLLAMA_TEXT_MODEL' | 'OLLAMA_VLM_MODEL' | 'WEB_LLM_BACKEND' | 'WEB_WRITE_TOKEN',
    value?: string
  ) => {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  restore('GEMINI_API_KEY', savedEnv.gemini)
  restore('OLLAMA_URL', savedEnv.ollama)
  restore('OLLAMA_TEXT_MODEL', savedEnv.model)
  restore('OLLAMA_VLM_MODEL', savedEnv.vlmModel)
  restore('WEB_LLM_BACKEND', savedEnv.backend)
  restore('WEB_WRITE_TOKEN', savedEnv.token)
})

async function callScript(
  body: unknown,
  headers: Record<string, string> = SAME_ORIGIN_HEADERS
): Promise<{ handled: boolean; status: number; body: any }> {
  let captured: { status: number; body: any } = { status: 0, body: null }
  const req = {
    method: 'POST',
    url: '/api/gemini/script',
    headers
  } as unknown as IncomingMessage
  const res = { statusCode: 0, setHeader() {}, end() {} } as unknown as ServerResponse
  const handled = await handleGeminiRoute(req, res, '/api/gemini/script', {
    sendJson: (_res, status, payload) => {
      captured = { status, body: payload }
    },
    readBody: async () => body,
    authorizeWrite: (r: IncomingMessage) => authorizeTaskWrite(r)
  })
  return { handled, ...captured }
}

async function callGeminiPath(
  pathname: string,
  method: string,
  body: unknown,
  headers: Record<string, string> = SAME_ORIGIN_HEADERS
): Promise<{ handled: boolean; status: number; body: any }> {
  let captured: { status: number; body: any } = { status: 0, body: null }
  const req = {
    method,
    url: pathname,
    headers
  } as unknown as IncomingMessage
  const res = { statusCode: 0, setHeader() {}, end() {} } as unknown as ServerResponse
  const handled = await handleGeminiRoute(req, res, pathname, {
    sendJson: (_res, status, payload) => {
      captured = { status, body: payload }
    },
    readBody: async () => body,
    authorizeWrite: (r: IncomingMessage) => authorizeTaskWrite(r)
  })
  return { handled, ...captured }
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

test('POST /api/gemini/script uses Gemini when GEMINI_API_KEY is set (mock fetch)', async () => {
  process.env.GEMINI_API_KEY = 'test-gemini-key'
  const realFetch = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = requestUrl(input)
    calls.push(url)
    return new Response(
      JSON.stringify({
        candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(SCRIPT_JSON) }] } }]
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  }) as typeof fetch
  try {
    const res = await callScript({ prompt: '清晨轻轨上的护士', template_id: 'documentary', duration_s: 12 })
    assert.equal(res.status, 200)
    assert.equal(res.body.model, 'gemini-4-hydrogen')
    assert.equal(res.body.script.title, SCRIPT_JSON.title)
    assert.match(res.body.script.markdown, /山城早班车/)
    assert.ok(calls.length >= 1)
    assert.match(calls[0], /generativelanguage\.googleapis\.com/)
    assert.equal(calls.some((u) => u.includes('/api/generate')), false)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('POST /api/gemini/script falls back to Ollama JSON mode when no Gemini key (mock fetch)', async () => {
  const realFetch = globalThis.fetch
  const seen: Array<{ url: string; body: any }> = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: requestUrl(input), body: JSON.parse(String(init?.body ?? '{}')) })
    return new Response(JSON.stringify({ response: JSON.stringify(SCRIPT_JSON) }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }) as typeof fetch
  try {
    const res = await callScript({
      prompt: '清晨轻轨上的护士',
      template_id: 'documentary',
      tone: '克制温暖',
      duration_s: 12
    })
    assert.equal(res.status, 200)
    assert.equal(res.body.model, 'script-test-model')
    assert.equal(res.body.script.scenes.length, 2)
    assert.equal(res.body.script.duration_s, 12)
    assert.match(res.body.script.markdown, /山城早班车/)

    assert.equal(seen.length, 1)
    assert.equal(seen[0].url, 'http://127.0.0.1:11499/api/generate')
    assert.equal(seen[0].body.model, 'script-test-model')
    assert.equal(seen[0].body.stream, false)
    assert.equal(seen[0].body.format, 'json')
    assert.match(seen[0].body.prompt, /清晨轻轨上的护士/)
    assert.match(seen[0].body.prompt, /12 秒/)
    assert.match(seen[0].body.prompt, /克制温暖/)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('POST /api/gemini/script returns 503 llm_unavailable when neither Gemini nor Ollama is available', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    throw new Error('ECONNREFUSED 127.0.0.1:11499')
  }) as typeof fetch
  try {
    const res = await callScript({ prompt: '无人值守的清晨站台', duration_s: 10 })
    assert.equal(res.status, 503)
    assert.equal(res.body.error, 'llm_unavailable')
    assert.match(String(res.body.detail), /Ollama/)
    assert.equal('script' in res.body, false)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('POST /api/gemini/script rejects a missing prompt with 400', async () => {
  const res = await callScript({ duration_s: 10 })
  assert.equal(res.status, 400)
  assert.match(String(res.body.error), /prompt/)
})

test('POST /api/gemini/script rejects an invalid X-Web-Token with 401', async () => {
  process.env.WEB_WRITE_TOKEN = 'script-write-token'
  const res = await callScript(
    { prompt: '清晨轻轨' },
    { host: '127.0.0.1:8088', origin: 'http://evil.example', 'x-web-token': 'wrong' }
  )
  assert.equal(res.status, 401)
  assert.match(String(res.body.error), /X-Web-Token/)
})

test('POST /api/gemini/script rejects a cross-origin caller without token with 403', async () => {
  const res = await callScript(
    { prompt: '清晨轻轨' },
    { host: '127.0.0.1:8088', origin: 'http://evil.example' }
  )
  assert.equal(res.status, 403)
  assert.match(String(res.body.error), /same-origin|X-Web-Token/)
})

// ---------------------------------------------------------------------------
// #124/#127 POST /api/gemini/analyze-frames: local Ollama VLM by default,
// Gemini only behind WEB_LLM_BACKEND=gemini + key, no fabricated analysis.
// ---------------------------------------------------------------------------

const FRAMES_BODY = { frames: [{ index: 1, timecode: '00:00.0', base64: 'aGVsbG8=', mimeType: 'image/jpeg' }] }

test('analyze-frames defaults to Ollama VLM JSON mode with base64 images', async () => {
  const realFetch = globalThis.fetch
  const seen: Array<{ url: string; body: any }> = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: requestUrl(input), body: JSON.parse(String(init?.body ?? '{}')) })
    return new Response(JSON.stringify({ model: 'vlm-test-model', response: JSON.stringify(FRAME_ANALYSIS_JSON) }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }) as typeof fetch
  try {
    assert.equal(resolveAnalyzeFramesBackend(), 'ollama')
    const res = await callGeminiPath('/api/gemini/analyze-frames', 'POST', FRAMES_BODY)
    assert.equal(res.status, 200)
    assert.equal(res.body.model, 'vlm-test-model')
    assert.equal(res.body.analysis.recommended_profile, 'natural_clarity')
    assert.equal(res.body.analysis.shots.length, 1)

    assert.equal(seen.length, 1)
    assert.equal(seen[0].url, 'http://127.0.0.1:11499/api/generate')
    assert.equal(seen[0].body.model, 'vlm-test-model')
    assert.equal(seen[0].body.format, 'json')
    assert.equal(seen[0].body.stream, false)
    assert.deepEqual(seen[0].body.images, ['aGVsbG8='])
    assert.match(seen[0].body.prompt, /JSON/)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('analyze-frames returns 503 llm_unavailable instead of fake analysis when Ollama VLM is down', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    throw new Error('ECONNREFUSED 127.0.0.1:11499')
  }) as typeof fetch
  try {
    const res = await callGeminiPath('/api/gemini/analyze-frames', 'POST', FRAMES_BODY)
    assert.equal(res.status, 503)
    assert.equal(res.body.error, 'llm_unavailable')
    assert.match(String(res.body.detail), /Ollama VLM/)
    assert.equal('analysis' in res.body, false)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('WEB_LLM_BACKEND=gemini + key uses Gemini; without a key it stays on Ollama', async () => {
  process.env.WEB_LLM_BACKEND = 'gemini'
  assert.equal(resolveAnalyzeFramesBackend(), 'ollama')

  process.env.GEMINI_API_KEY = 'test-gemini-key'
  assert.equal(resolveAnalyzeFramesBackend(), 'gemini')

  const realFetch = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(requestUrl(input))
    return new Response(
      JSON.stringify({
        candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(FRAME_ANALYSIS_JSON) }] } }]
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  }) as typeof fetch
  try {
    const res = await callGeminiPath('/api/gemini/analyze-frames', 'POST', FRAMES_BODY)
    assert.equal(res.status, 200)
    assert.equal(res.body.model, 'gemini-4-hydrogen')
    assert.match(calls[0], /generativelanguage\.googleapis\.com/)
    assert.equal(calls.some((u) => u.includes('/api/generate')), false)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('POST /api/gemini/script-templates/sync rejects 401 wrong token and 403 cross-origin', async () => {
  process.env.WEB_WRITE_TOKEN = 'template-write-token'
  const wrong = await callGeminiPath('/api/gemini/script-templates/sync', 'POST', {}, {
    host: '127.0.0.1:8088',
    origin: 'http://evil.example',
    'x-web-token': 'wrong'
  })
  assert.equal(wrong.status, 401)
  assert.match(String(wrong.body.error), /X-Web-Token/)

  delete process.env.WEB_WRITE_TOKEN
  const crossOrigin = await callGeminiPath('/api/gemini/script-templates/sync', 'POST', {}, {
    host: '127.0.0.1:8088',
    origin: 'http://evil.example'
  })
  assert.equal(crossOrigin.status, 403)
  assert.match(String(crossOrigin.body.error), /same-origin|X-Web-Token/)
})

test('POST /api/gemini/script-templates/schedule rejects 401 wrong token and 403 cross-origin', async () => {
  process.env.WEB_WRITE_TOKEN = 'template-write-token'
  const wrong = await callGeminiPath('/api/gemini/script-templates/schedule', 'POST', {}, {
    host: '127.0.0.1:8088',
    origin: 'http://evil.example',
    'x-web-token': 'wrong'
  })
  assert.equal(wrong.status, 401)

  delete process.env.WEB_WRITE_TOKEN
  const crossOrigin = await callGeminiPath('/api/gemini/script-templates/schedule', 'POST', {}, {
    host: '127.0.0.1:8088',
    origin: 'http://evil.example'
  })
  assert.equal(crossOrigin.status, 403)
})
