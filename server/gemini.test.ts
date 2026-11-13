import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildLocalHistoricalContext,
  buildScriptMarkdownFromScenes,
  isRetryableGeminiError,
  normalizeFrameAnalysis,
  normalizeGeneratedScript,
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
