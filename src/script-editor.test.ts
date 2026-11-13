import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyTemplateItemUpdate,
  buildExportMarkdown,
  buildExportPlainText,
  CANONICAL_DURATION_OPTIONS,
  getScriptPromptTemplate,
  GITHUB_SCRIPT_TEMPLATES,
  mergePlatformProfiles,
  mergePromptTemplates,
  normalizeAgentProfileId,
  resolveHistoricalGroundingActive,
  resolveScriptTemplateLibrary,
  sanitizeExportFilename,
  scheduleWaitLabel,
  SCRIPT_PRESETS,
  STORY_ERA_OPTIONS,
  SYNC_INTERVAL_OPTIONS,
  templateSourceBadge,
  toBriefPolishedFromGenerated
} from './components/production/script-editor-utils'
import type { AgentItem, GeminiGeneratedScript, ScriptPromptTemplateInfo } from './types'

const SAMPLE_SCRIPT: GeminiGeneratedScript = {
  title: '晨光手冲 · 十五秒商业短片',
  logline: '晨光穿透窗口，黄铜滤杯与手冲水流在 15 秒内完成一次克制的唤醒仪式。',
  tone: '克制温暖 · 青橙电影商业质感',
  aspect: '16:9',
  style: '50mm 浅景深 · 自然侧逆光',
  profile: 'ad_teal_orange',
  template_id: 'marketing',
  template_label: '营销广告 · 高转化商业片',
  optimization_notes: '按照商业 Hook-Payoff 规范将首镜缩短至 3.5s 强化视觉吸引',
  story_era: '唐代 · 盛唐长安/敦煌丝路',
  episode_mode: 'novel_series',
  historical_context: '盛唐时期长安西市胡商云集，坊市按鼓声启闭。',
  historical_sources: [{ title: '唐代坊市制度史料', url: 'https://example.com/tang-market' }],
  chapters: [
    {
      chapter_no: 1,
      title: '第一章 · 暮鼓启坊',
      era_anchor: '天宝三载 · 长安西市',
      summary: '少年画师在暮鼓声响前赶入波斯胡肆。',
      key_conflict: '星图残卷被人暗中调包'
    }
  ],
  duration_s: 15,
  markdown: '# 晨光手冲 · 十五秒商业短片\n\n> **一句话梗概**：晨光穿透窗口\n\n- **场次 01**：特写黄铜滤杯',
  scenes: [
    {
      scene_no: 1,
      timecode: '00:00 - 00:03.5',
      duration_s: 3.5,
      shot_type: '特写 · 50mm',
      camera: '极轻手持微推',
      continuity_anchor: '黄铜滤杯居中偏右，晨光从画面左侧斜射形成边缘高光',
      visual: '晨光穿过百叶窗落在黄铜滤杯边缘',
      video_prompt:
        'Close-up 50mm prime, gentle handheld push-in, morning window sunlight grazing brushed brass pour-over dripper, subtle rising steam, natural teal-orange film balance, 24fps',
      voiceover: '这一杯，从第一束自然光开始。',
      audio: '轻微陶瓷轻碰与清晨环境底噪'
    },
    {
      scene_no: 2,
      timecode: '00:03.5 - 00:08.5',
      duration_s: 5,
      shot_type: '微距 · 85mm',
      camera: '缓慢横移',
      continuity_anchor: '保持左向暖色逆光，水流垂直注入同款黄铜滤杯',
      visual: '细水柱平稳注入咖啡粉层，气泡缓缓膨起',
      video_prompt:
        'Macro 85mm shallow depth of field, slow lateral slide, thin gooseneck hot water stream blooming fresh coffee grounds, amber backlight mist, 24fps',
      voiceover: '（1.2s 环境水声留白）',
      audio: '水流声与热气微响'
    }
  ]
}

test('SCRIPT_PRESETS provides 4 ready-to-use prompt starters including historical_novel', () => {
  assert.equal(SCRIPT_PRESETS.length, 4)
  assert.ok(STORY_ERA_OPTIONS.length >= 5)
  assert.ok(SYNC_INTERVAL_OPTIONS.length === 4)
  const validDurations = new Set<number>(CANONICAL_DURATION_OPTIONS.map((d) => d.value))
  const validTemplates = new Set(GITHUB_SCRIPT_TEMPLATES.map((t) => t.id))
  for (const preset of SCRIPT_PRESETS) {
    assert.ok(preset.prompt.length > 20)
    assert.ok(validTemplates.has(preset.templateId))
    assert.ok(validDurations.has(preset.duration_s))
    assert.ok(['16:9', '9:16', '1:1', '4:5'].includes(preset.aspect))
    assert.ok(preset.profileId.length > 0)
  }
  assert.ok(SCRIPT_PRESETS.some((p) => p.templateId === 'historical_novel' && p.episodeMode === 'novel_series'))
})

test('mergePromptTemplates preserves all 7 GitHub industry templates and resolves documentary/marketing/narrative/historical_novel', () => {
  const list = mergePromptTemplates(null)
  assert.equal(list.length, 7)
  assert.equal(getScriptPromptTemplate('marketing').category, '营销')
  assert.equal(getScriptPromptTemplate('documentary').category, '纪录片')
  assert.equal(getScriptPromptTemplate('narrative').category, '叙事')
  assert.equal(getScriptPromptTemplate('historical_novel').category, '小说历史')
})

test('mergePlatformProfiles preserves canonical 4 profiles and appends active custom profiles', () => {
  assert.equal(normalizeAgentProfileId('seed-ad-teal-orange'), 'ad_teal_orange')

  const mockAgents: AgentItem[] = [
    {
      id: 'seed-ad-teal-orange',
      type: 'profile',
      name: '广告商业',
      description: '商业广告级青橙配色预设',
      namespace: 'seed',
      active: true,
      active_version: 1,
      source: { kind: 'local', url: null, repo: null, commit: null, license: 'MIT', sha256: 'abc' },
      created_at: '2026-11-12T00:00:00Z',
      updated_at: '2026-11-12T00:00:00Z',
      versions_count: 1
    },
    {
      id: 'user-cyber-noir',
      type: 'profile',
      name: '赛博雨夜短片',
      description: '冷青霓虹对比与高反光路面质感',
      namespace: 'user',
      active: true,
      active_version: 1,
      source: { kind: 'edit', url: null, repo: null, commit: null, license: null, sha256: 'def' },
      created_at: '2026-11-12T00:00:00Z',
      updated_at: '2026-11-12T00:00:00Z',
      versions_count: 1
    }
  ]

  const merged = mergePlatformProfiles(mockAgents)
  assert.equal(merged.length, 5)
  assert.equal(merged[0].id, 'ad_teal_orange')
  assert.equal(merged[0].description, '商业广告级青橙配色预设')
  assert.equal(merged[4].id, 'user-cyber-noir')
  assert.equal(merged[4].source, 'custom')
})

test('#136 定时同步等待文案：区分开关与间隔，说明具体动作而不是泛化「保存中」', () => {
  assert.equal(scheduleWaitLabel({ autoSyncEnabled: false }), '正在切换为手动触发同步')
  assert.equal(scheduleWaitLabel({ intervalHours: 12 }), '正在保存定时同步策略（每 12 小时）')
  assert.equal(scheduleWaitLabel({}), '正在保存定时同步策略')
})

test('resolveHistoricalGroundingActive defaults to off and only enables on explicit opt-in or a non-empty story era', () => {
  assert.equal(resolveHistoricalGroundingActive(false, ''), false)
  assert.equal(resolveHistoricalGroundingActive(true, ''), true)
  assert.equal(resolveHistoricalGroundingActive(false, '清代 · 京华风物与晚清沧桑'), true)
  assert.equal(resolveHistoricalGroundingActive(false, '   '), false)
})

test('sanitizeExportFilename strips unsafe characters and appends chosen extension', () => {
  assert.equal(sanitizeExportFilename('  咖啡 / 广告:测试*片  ', 'md'), '咖啡-广告-测试-片.md')
  assert.equal(sanitizeExportFilename('', 'txt'), 'video-script.txt')
})

test('buildExportMarkdown respects user inline edits and includes template_label & optimization_notes in fallback', () => {
  assert.match(buildExportMarkdown(SAMPLE_SCRIPT), /# 晨光手冲 · 十五秒商业短片/)
  const fallbackScript = { ...SAMPLE_SCRIPT, markdown: '' }
  const generatedFallback = buildExportMarkdown(fallbackScript)
  assert.match(generatedFallback, /营销广告 · 高转化商业片/)
  assert.match(generatedFallback, /AI 导演优化说明/)
  assert.match(generatedFallback, /连续性锚点/)
  assert.match(generatedFallback, /I2V 提示词/)

  const edited = '# 用户修改稿\n\n- 场次 01：新版本'
  assert.equal(buildExportMarkdown(SAMPLE_SCRIPT, edited), edited + '\n')
})

test('buildExportPlainText strips Markdown headings and bold markers cleanly', () => {
  const plain = buildExportPlainText(SAMPLE_SCRIPT)
  assert.ok(!plain.includes('# '))
  assert.ok(!plain.includes('**'))
  assert.match(plain, /晨光手冲 · 十五秒商业短片/)
  assert.match(plain, /一句话梗概/)
})

test('toBriefPolishedFromGenerated maps AI video_prompt and scenes into valid StudioPolished payload', () => {
  const polished = toBriefPolishedFromGenerated(SAMPLE_SCRIPT)
  assert.equal(polished.logline, SAMPLE_SCRIPT.logline)
  assert.equal(polished.shots.length, 2)
  assert.equal(polished.shots[0].no, 1)
  assert.equal(polished.shots[0].duration_s, 3.5)
  assert.match(polished.shots[0].camera ?? '', /特写 · 50mm/)
  assert.match(polished.shots[0].prompt, /Close-up 50mm prime/)
  assert.match(polished.shots[0].prompt, /晨光穿过百叶窗/)
})

// #134 模板库接线：新接口优先 → 旧接口回退 → 随库静态列表。
test('#134 resolveScriptTemplateLibrary prefers /api/script-templates, then legacy, then static defaults', () => {
  const apiItem: ScriptPromptTemplateInfo = {
    ...getScriptPromptTemplate('marketing'),
    label: '新接口标签',
    source: 'override'
  }
  const legacyItem: ScriptPromptTemplateInfo = {
    ...getScriptPromptTemplate('marketing'),
    label: '旧接口标签'
  }

  const fromApi = resolveScriptTemplateLibrary([apiItem], [legacyItem])
  const apiMarketing = fromApi.find((tpl) => tpl.id === 'marketing')
  assert.equal(apiMarketing?.label, '新接口标签')
  assert.equal(apiMarketing?.source, 'override')

  const fromLegacy = resolveScriptTemplateLibrary([], [legacyItem])
  assert.equal(fromLegacy.find((tpl) => tpl.id === 'marketing')?.label, '旧接口标签')

  const fromStatic = resolveScriptTemplateLibrary(null, null)
  assert.equal(fromStatic.length, GITHUB_SCRIPT_TEMPLATES.length)
  assert.equal(fromStatic.find((tpl) => tpl.id === 'marketing')?.label, getScriptPromptTemplate('marketing').label)
})

test('#134 templateSourceBadge marks override as 已自定义 and leaves default unmarked', () => {
  assert.equal(templateSourceBadge('override'), '已自定义')
  assert.equal(templateSourceBadge('default'), null)
  assert.equal(templateSourceBadge(undefined), null)
})

test('#134 applyTemplateItemUpdate replaces the saved item and keeps the selected template', () => {
  const base = resolveScriptTemplateLibrary(null)
  const selectedId = base[2].id
  const saved: ScriptPromptTemplateInfo = {
    ...getScriptPromptTemplate('marketing'),
    label: '保存后的营销模板',
    source: 'override'
  }

  const next = applyTemplateItemUpdate(base, saved)
  assert.equal(next.length, base.length)
  assert.equal(next.find((tpl) => tpl.id === 'marketing')?.label, '保存后的营销模板')
  assert.equal(next.find((tpl) => tpl.id === 'marketing')?.source, 'override')
  // 选中项内容与 id 都不因保存其它模板而变。
  assert.equal(next.find((tpl) => tpl.id === selectedId)?.id, selectedId)
  assert.equal(
    next.find((tpl) => tpl.id === selectedId)?.label,
    base.find((tpl) => tpl.id === selectedId)?.label
  )
})
