import {
  getScriptPromptTemplate,
  GITHUB_SCRIPT_TEMPLATES,
  type ScriptPromptTemplate
} from '../../../server/script-templates'
import type {
  AgentItem,
  GeminiGeneratedScript,
  ScriptPromptTemplateInfo,
  StudioPolished,
  VideoTemplateId
} from '../../types'

export type ScriptAspect = '16:9' | '9:16' | '1:1' | '4:5'

export type DirectorProfileOption = {
  id: string
  label: string
  tone: string
  description: string
  source: 'platform' | 'custom'
}

export { GITHUB_SCRIPT_TEMPLATES, getScriptPromptTemplate }

export const CANONICAL_DURATION_OPTIONS = [
  { value: 10, label: '10 秒 · 极速钩子' },
  { value: 15, label: '15 秒 · 标准短片' },
  { value: 20, label: '20 秒 · 双轨推荐' },
  { value: 30, label: '30 秒 · 完整叙事' },
  { value: 45, label: '45 秒 · 深度品牌' },
  { value: 60, label: '60 秒 · 专题微纪录' }
] as const

export const CANONICAL_DIRECTOR_PROFILES: DirectorProfileOption[] = [
  {
    id: 'ad_teal_orange',
    label: '广告商业 · 青橙电影质感',
    tone: '克制温暖 · 青橙电影商业质感',
    description: '高质感商业短片与品牌宣传，强调侧逆光塑形与材质微距',
    source: 'platform'
  },
  {
    id: 'vlog_warm_film',
    label: '人物 Vlog · 温暖胶片轻纪实',
    tone: '自然松弛 · 胶片轻纪实',
    description: '真实生活呼吸感，轻微手持节奏与暖调肤色还原',
    source: 'platform'
  },
  {
    id: 'doc_neutral',
    label: '宣传纪实 · 中性克制通透',
    tone: '客观冷静 · 中性纪实叙事',
    description: '自然环境光与真实空间纵深，避免过度渲染修饰',
    source: 'platform'
  },
  {
    id: 'landscape_low_sat',
    label: '风景大片 · 低饱和广角史诗',
    tone: '沉静诗意 · 低饱和电影广角',
    description: '24mm 大空间尺度、低饱和度冷暖层次与慢速推轨',
    source: 'platform'
  }
]

export function normalizeAgentProfileId(rawId: string): string {
  return rawId.replace(/^seed-/, '').replace(/-/g, '_')
}

export function mergePlatformProfiles(items: AgentItem[] | undefined | null): DirectorProfileOption[] {
  const byId = new Map<string, DirectorProfileOption>()
  for (const canonical of CANONICAL_DIRECTOR_PROFILES) {
    byId.set(canonical.id, canonical)
  }

  for (const item of items ?? []) {
    if (item.type !== 'profile' || !item.active) continue
    const normalizedId = normalizeAgentProfileId(item.id)
    const existing = byId.get(normalizedId)
    if (existing) {
      byId.set(normalizedId, {
        ...existing,
        description: item.description?.trim() || existing.description
      })
    } else {
      byId.set(item.id, {
        id: item.id,
        label: item.name?.trim() || item.id,
        tone: item.description?.trim() || `${item.name || item.id} · 自定义导演风格`,
        description: item.description?.trim() || '来自 Agent 与提示词库的自定义风格模板',
        source: 'custom'
      })
    }
  }

  return Array.from(byId.values())
}

export function mergePromptTemplates(
  items: ScriptPromptTemplateInfo[] | undefined | null
): ScriptPromptTemplate[] {
  if (!items || items.length === 0) return GITHUB_SCRIPT_TEMPLATES
  const byId = new Map<VideoTemplateId, ScriptPromptTemplate>()
  for (const fallback of GITHUB_SCRIPT_TEMPLATES) {
    byId.set(fallback.id, fallback)
  }
  for (const remote of items) {
    if (remote && remote.id && byId.has(remote.id)) {
      const existing = byId.get(remote.id)!
      byId.set(remote.id, {
        ...remote,
        sourceUrl: remote.sourceUrl ?? existing.sourceUrl
      })
    }
  }
  return Array.from(byId.values())
}

export const STORY_ERA_OPTIONS = [
  { value: '', label: '自动识别 / 现代当代' },
  { value: '汉晋 · 秦汉雄风与魏晋名士', label: '先秦 / 汉晋风骨' },
  { value: '唐代 · 盛唐长安/敦煌丝路', label: '唐代 · 盛唐长安 / 丝路' },
  { value: '宋代 · 汴梁/江南市井雅韵', label: '宋代 · 汴梁 / 江南雅韵' },
  { value: '明代 · 市井百态与海疆风云', label: '明代 · 市井百态 / 海疆' },
  { value: '清代 · 京华风物与晚清沧桑', label: '清代 · 京华风物 / 晚清' },
  { value: '民国 · 旧日山河与近代人文', label: '民国 · 时代风貌' }
] as const

export const SYNC_INTERVAL_OPTIONS = [
  { value: '6', label: '每 6 小时' },
  { value: '12', label: '每 12 小时' },
  { value: '24', label: '每 24 小时' },
  { value: '72', label: '每 72 小时' }
] as const

export type ScriptPreset = {
  id: string
  label: string
  templateId: VideoTemplateId
  prompt: string
  profileId: string
  tone: string
  duration_s: number
  aspect: ScriptAspect
  storyEra?: string
  episodeMode?: 'single' | 'novel_series'
}

export const SCRIPT_PRESETS: ScriptPreset[] = [
  {
    id: 'coffee-ad',
    label: '手冲咖啡品牌片',
    templateId: 'marketing',
    prompt:
      '清晨自然侧逆光下的手冲精品咖啡广告：展现黄铜滤杯、手工陶杯釉面细节与缓缓升腾的蒸汽，突出克制温暖的手工质感与品牌落版。',
    profileId: 'ad_teal_orange',
    tone: '克制温暖 · 青橙电影商业质感',
    duration_s: 15,
    aspect: '16:9'
  },
  {
    id: 'craft-doc',
    label: '老街陶瓷匠人纪实',
    templateId: 'documentary',
    prompt:
      '雨后老街作坊里独自拉坯三十年的陶瓷匠人短纪录片：聚焦沾满泥浆的指节、木窗斜照的自然天光与窑火熄灭前的安静时刻。',
    profileId: 'doc_neutral',
    tone: '客观冷静 · 中性纪实叙事',
    duration_s: 30,
    aspect: '16:9'
  },
  {
    id: 'tang-novel',
    label: '长安驿站奇案小说（史实长故事）',
    templateId: 'historical_novel',
    prompt:
      '整部历史悬疑小说视频企划：以天宝年间洛阳至长安丝路驿站为背景，讲述一名落第画师护送西域星图卷轴入京的五章命运历程，要求服饰官制、胡姬酒肆器皿与唐代建筑严格符合史实。',
    profileId: 'doc_neutral',
    tone: '客观冷静 · 中性纪实叙事',
    duration_s: 60,
    aspect: '16:9',
    storyEra: '唐代 · 盛唐长安/敦煌丝路',
    episodeMode: 'novel_series'
  },
  {
    id: 'cafe-vlog',
    label: '咖啡馆探店 Vlog',
    templateId: 'vlog',
    prompt:
      '周末午后街头独立咖啡馆探店日记：推门风铃响起、咖啡师浓缩萃取、奶泡拉花倾倒与窗边木桌光影，节奏轻快有呼吸感。',
    profileId: 'vlog_warm_film',
    tone: '自然松弛 · 胶片轻纪实',
    duration_s: 20,
    aspect: '9:16'
  }
]

export function sanitizeExportFilename(title: string, ext: 'md' | 'txt'): string {
  const clean = title
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)
  return `${clean || 'video-script'}.${ext}`
}

export function buildExportMarkdown(script: GeminiGeneratedScript, editedMarkdown?: string): string {
  const body = (editedMarkdown ?? script.markdown).trim()
  if (body) return body + '\n'
  const header = [
    `# ${script.title}`,
    '',
    `> ${script.logline}`,
    '',
    ...(script.template_label ? [`- 视频类型模板：${script.template_label}`] : []),
    ...(script.story_era ? [`- 历史时期：${script.story_era}`] : []),
    ...(script.episode_mode === 'novel_series' ? ['- 创作模式：整部小说 · 多章分集连载'] : []),
    `- 叙事基调：${script.tone}`,
    `- 画面风格：${script.style}`,
    ...(script.profile ? [`- 导演风格模板：${script.profile}`] : []),
    `- 建议时长：${script.duration_s} 秒 · 画幅 ${script.aspect}`,
    ...(script.optimization_notes ? [`- AI 导演优化说明：${script.optimization_notes}`] : []),
    '',
    ...(script.historical_context
      ? [
          '## 史实背景与时代考据',
          '',
          script.historical_context,
          ...(script.historical_sources?.length
            ? ['', ...script.historical_sources.map((s) => `- [${s.title}](${s.url})`)]
            : []),
          ''
        ]
      : []),
    ...(script.chapters?.length
      ? [
          '## 整部故事 / 小说章节脉络总纲',
          '',
          ...script.chapters.flatMap((c) => [
            `### 第 ${String(c.chapter_no).padStart(2, '0')} 章 · ${c.title}`,
            `- 时代锚点：${c.era_anchor}`,
            `- 核心冲突：${c.key_conflict}`,
            `- 剧情摘要：${c.summary}`,
            ''
          ])
        ]
      : []),
    '## 分场脚本与 I2V 提示词',
    ''
  ]
  const scenes = script.scenes.map((s) =>
    [
      `### 场次 ${String(s.scene_no).padStart(2, '0')} · ${s.timecode}（${s.duration_s}s）`,
      `- 景别/运镜：${s.shot_type} · ${s.camera}`,
      `- 连续性锚点：${s.continuity_anchor}`,
      `- 画面描述：${s.visual}`,
      `- I2V 提示词：\`${s.video_prompt}\``,
      `- 旁白/台词：${s.voiceover}`,
      `- 音效/配乐：${s.audio}`,
      ''
    ].join('\n')
  )
  return [...header, ...scenes].join('\n')
}

export function buildExportPlainText(script: GeminiGeneratedScript, editedMarkdown?: string): string {
  const md = buildExportMarkdown(script, editedMarkdown)
  return (
    md
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/^>\s?/gm, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .trim() + '\n'
  )
}

export function toBriefPolishedFromGenerated(script: GeminiGeneratedScript, editedMarkdown?: string): StudioPolished {
  const scriptText = (editedMarkdown ?? script.markdown).trim().slice(0, 3900)
  return {
    logline: script.logline.slice(0, 290),
    script: scriptText || script.logline,
    style: script.style.slice(0, 115),
    shots: script.scenes.slice(0, 12).map((s, idx) => ({
      no: idx + 1,
      duration_s: Math.max(0.5, Number(s.duration_s) || 3.5),
      camera: `${s.shot_type} · ${s.camera}`.slice(0, 75),
      prompt: (s.video_prompt ? `${s.video_prompt} | ${s.visual}` : s.visual).slice(0, 480)
    }))
  }
}
