import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export type VideoTemplateId =
  | 'marketing'
  | 'documentary'
  | 'narrative'
  | 'historical_novel'
  | 'vlog'
  | 'product_demo'
  | 'scenic_essay'

export interface ScriptPromptTemplate {
  id: VideoTemplateId
  category: string
  label: string
  englishName: string
  githubStandard: string
  sourceUrl: string
  summary: string
  structureBeats: string
  opticalSpec: string
  recommendedProfile: 'ad_teal_orange' | 'vlog_warm_film' | 'doc_neutral' | 'landscape_low_sat'
  recommendedDurationS: 10 | 15 | 20 | 30 | 45 | 60
  recommendedAspect: '16:9' | '9:16' | '1:1' | '4:5'
  supportsNovelSeries?: boolean
  systemDirectives: string
}

export interface UpstreamGithubSource {
  id: string
  repo: string
  branch: string
  url: string
  license: string
  role: string
  status: 'synced' | 'fallback' | 'pending'
  checkedAt: string | null
  etag?: string | null
}

export interface GiteaDiscoveredLocation {
  repo: string
  branch: string
  filePath: string
  matchedTemplates: number
  htmlUrl?: string | null
}

export interface GiteaTemplateSource {
  enabled: boolean
  repo: string
  branch: string
  filePath: string
  configured: boolean
  lastSyncedAt: string | null
  status: 'idle' | 'synced' | 'fallback' | 'error'
  message: string
  htmlUrl?: string | null
  agentName?: string
  scannedRepos?: string[]
  discoveredLocations?: GiteaDiscoveredLocation[]
}

export interface TemplateSyncState {
  autoSyncEnabled: boolean
  intervalHours: 6 | 12 | 24 | 72
  lastSyncedAt: string | null
  lastSyncMode: 'manual' | 'scheduled' | 'initial'
  syncStatus: 'idle' | 'synced' | 'partial'
  lastResultMessage: string
  sources: UpstreamGithubSource[]
  giteaSource: GiteaTemplateSource
}

const DEFAULT_UPSTREAM_SOURCES: UpstreamGithubSource[] = [
  {
    id: 'seed-github-director-skills',
    repo: '0xhughs/director-skills',
    branch: 'main',
    url: 'https://raw.githubusercontent.com/0xhughs/director-skills/main/README.md',
    license: 'MIT',
    role: 'Observational Verité & Kinetic Director Protocol',
    status: 'synced',
    checkedAt: null
  },
  {
    id: 'seed-github-visual-skills',
    repo: 'smixs/visual-skills',
    branch: 'main',
    url: 'https://raw.githubusercontent.com/smixs/visual-skills/main/README.md',
    license: 'MIT',
    role: 'Commercial Hook-Payoff & Studio Tabletop Motion',
    status: 'synced',
    checkedAt: null
  },
  {
    id: 'seed-github-storyboard-studio',
    repo: 'Mirza-Luqman/prompt-storyboard-studio',
    branch: 'main',
    url: 'https://raw.githubusercontent.com/Mirza-Luqman/prompt-storyboard-studio/main/README.md',
    license: 'MIT',
    role: 'Dramatic Continuity, Historical Novel Multi-Chapter & Spatial Essay',
    status: 'synced',
    checkedAt: null
  }
]

export const GITHUB_SCRIPT_TEMPLATES: ScriptPromptTemplate[] = [
  {
    id: 'marketing',
    category: '营销',
    label: '营销广告 · 高转化商业片',
    englishName: 'Commercial Hook-Payoff Compiler',
    githubStandard: 'juspay/director · smixs/visual-skills (Commercial Spec)',
    sourceUrl: 'https://raw.githubusercontent.com/smixs/visual-skills/main/README.md',
    summary: '前 3 秒建立强视觉钩子与材质反差，中段密集呈现产品价值证据，结尾留出清晰品牌落版与情绪记忆点。',
    structureBeats: '01 强钩子开场 (2.5s) → 02 痛点/渴望情境 → 03 核心材质微距高光 → 04 品牌落版收口',
    opticalSpec: '35mm / 50mm / 85mm 大光圈切换 · 2.5s~4.0s 紧凑剪辑 · 侧逆光塑形 · 商业青橙反差',
    recommendedProfile: 'ad_teal_orange',
    recommendedDurationS: 15,
    recommendedAspect: '16:9',
    systemDirectives: [
      '[GitHub Spec: juspay/director Commercial Hook-Payoff + smixs/visual-skills]',
      '- 开场第 1 镜必须在 2.5~3.5s 内给出最具冲击力的物理特写或动势冲突（Visual Hook），拒绝平庸空镜铺垫。',
      '- 中段镜头按「材质纹理微距 (85mm) → 使用场景中景 (35mm/50mm)」交替推进，突出触感、反光与声效拟音 (Foley)。',
      '- 旁白采用短句、强动词与留白停顿结合，为品牌 Slogan 或核心卖点留足最终 3 秒视觉停顿空间。',
      '- I2V prompt 重点强化 specular highlights, tactile surface micro-detail, directional rim lighting 与 crisp motion cadence。'
    ].join('\n')
  },
  {
    id: 'documentary',
    category: '纪录片',
    label: '人文纪实 · 观察式纪录片',
    englishName: 'Observational Verité Director',
    githubStandard: '0xhughs/director-skills (Verité Documentary Protocol)',
    sourceUrl: 'https://raw.githubusercontent.com/0xhughs/director-skills/main/README.md',
    summary: '遵循观察式电影规范，用自然窗光、真实动作与同期环境音取代过度表演与广告腔，营造可信在场感。',
    structureBeats: '01 空间环境定场 → 02 人物专注劳作/习惯细节 → 03 同期声/内心独白切入 → 04 克制余韵收尾',
    opticalSpec: '35mm / 50mm 人文定焦 · 4.0s~6.5s 耐心长镜头 · 自然顶光/窗光 · 轻微肩扛呼吸感',
    recommendedProfile: 'doc_neutral',
    recommendedDurationS: 30,
    recommendedAspect: '16:9',
    systemDirectives: [
      '[GitHub Spec: 0xhughs/director-skills Observational Verité]',
      '- 严禁商业广告式浮夸推拉、过度柔焦或口号式解说词；全部镜头必须服务于「在场观察与时间流逝」。',
      '- 优先使用 35mm 与 50mm 人文定焦视角、4.0s~6.5s 舒缓单镜时长，允许主体短暂走出/走进景深平面。',
      '- 光线遵循现场物理光源（阴天漫反射窗光、室内台灯局部照明、自然环境反射），明确标注真实色温（如 4500K-5600K）。',
      '- 旁白克制真诚，优先保留真实环境底噪、脚步声、器物碰撞等同期声层次（Diegetic Sound First）。'
    ].join('\n')
  },
  {
    id: 'narrative',
    category: '叙事',
    label: '剧情叙事 · 电影感短片',
    englishName: 'Dramatic Continuity Storyboard',
    githubStandard: 'Mirza-Luqman/prompt-storyboard-studio (Continuity Lock)',
    sourceUrl: 'https://raw.githubusercontent.com/Mirza-Luqman/prompt-storyboard-studio/main/README.md',
    summary: '严格锁定 180° 轴线、人物视线匹配与情绪光比变化，以戏剧弧光驱动每一组正反打与转折镜头。',
    structureBeats: '01 情境建置与冲突暗线 → 02 人物关系试探/推进 → 03 情绪高潮瞬间 → 04 留白与戏剧余味',
    opticalSpec: '24mm 空间调度 + 85mm 情绪特写 · 严格 180° 视线匹配 · 明暗光比过渡',
    recommendedProfile: 'ad_teal_orange',
    recommendedDurationS: 30,
    recommendedAspect: '16:9',
    supportsNovelSeries: true,
    systemDirectives: [
      '[GitHub Spec: Mirza-Luqman/prompt-storyboard-studio Dramatic Continuity]',
      '- 必须以完整戏剧弧光组织分场：Setup（建置）→ Escalation（升级）→ Turning Point（转折）→ Aftermath（余波）。',
      '- continuity_anchor 必须显式锁定 180 度轴线朝向（screen-left / screen-right）、人物服装道具持握状态及视线焦点（eyeline match）。',
      '- 镜头景别遵循戏剧张力递进：用 24mm/35mm 交待人物与空间孤立感，在情绪转折点切入 85mm 浅景深面部/手部动作特写。',
      '- 台词或旁白重潜台词（Subtext），用「视觉动作+环境声断奏」传达内心波动，避免直接把情绪说白。'
    ].join('\n')
  },
  {
    id: 'historical_novel',
    category: '小说历史',
    label: '小说历史 · 史实长故事连载',
    englishName: 'Historical Novel & Multi-Chapter Compiler',
    githubStandard: 'Mirza-Luqman/prompt-storyboard-studio + Historical Grounding Spec',
    sourceUrl: 'https://raw.githubusercontent.com/Mirza-Luqman/prompt-storyboard-studio/main/README.md',
    summary: '专为整部小说/历史传奇打造：先核验朝代史实、服饰礼制与器物建筑，再生成多章节脉络与本集高精度分场剧本。',
    structureBeats: '01 时代气象与历史定场 → 02 人物命运伏笔 → 03 时代冲突与器物细节 → 04 章节留白悬念',
    opticalSpec: '24mm 时代建筑群景 + 50mm 叙事中景 + 85mm 器物/神态特写 · 史实服饰色温严格锁定',
    recommendedProfile: 'doc_neutral',
    recommendedDurationS: 60,
    recommendedAspect: '16:9',
    supportsNovelSeries: true,
    systemDirectives: [
      '[GitHub Spec: Historical Novel & Multi-Chapter Storyboard Compiler]',
      '- 严禁历史穿越违和（如宋代以前出现明清服饰建筑、尚未传入中国的农作物/器物、错误官职礼仪与纪年）。',
      '- 必须先依据核验后的史实语境锁定时代细节（服饰形制、发冠佩饰、家具陈设、照明介质如油灯/烛台/自然天光、建筑斗拱形制）。',
      '- 若为「整部小说 · 多章分集」模式，必须产出连贯的章节总纲（chapters），包含跨章节视觉记忆锚点与人物成长弧光，再细化当前集的高精度分场剧本。',
      '- I2V 英文提示词必须显式写出准确的时代材质（e.g. Tang Dynasty round-collar silk robe, unglazed stoneware lamp, timber bracket architecture）与自然胶片质感。'
    ].join('\n')
  },
  {
    id: 'vlog',
    category: 'Vlog',
    label: '生活方式 · 轻纪实 Vlog',
    englishName: 'First-Person Kinetic Storyteller',
    githubStandard: '0xhughs/director-skills (Kinetic Handheld Spec)',
    sourceUrl: 'https://raw.githubusercontent.com/0xhughs/director-skills/main/README.md',
    summary: '第一人称沉浸视角、轻快动作剪辑与高质感 ASMR 拟音，兼具随性真实感与高留存率节奏。',
    structureBeats: '01 推门/出发第一视角 → 02 空间风物与细节采样 → 03 沉浸式交互过程 → 04 轻盈收束金句',
    opticalSpec: '24mm / 35mm 亲近视角 · 2.5s~4.5s 动作匹配剪辑 · 适度手持呼吸感 · 温暖胶片肤色',
    recommendedProfile: 'vlog_warm_film',
    recommendedDurationS: 20,
    recommendedAspect: '9:16',
    systemDirectives: [
      '[GitHub Spec: director-skills Kinetic First-Person Vlog]',
      '- 采用第一人称或贴身跟拍视角（24mm/35mm），强调动作匹配转场（Match Cut，如推门、放杯、抬头瞬间衔接）。',
      '- 节奏轻快明朗，单镜控制在 2.5s~4.5s，每场明确写入 1 个标志性生活拟音细节（风铃、冰块撞杯、纸张翻页）。',
      '- 旁白口吻像与好友面对面聊天，自然松弛有呼吸停顿，绝不使用播音腔或书面八股。',
      '- I2V prompt 显式包含 subtle handheld natural sway, warm filmic skin tones, golden-hour window spill。'
    ].join('\n')
  },
  {
    id: 'product_demo',
    category: '评测',
    label: '产品演示 · 极简工业微距',
    englishName: 'Industrial Macro & Motion Control',
    githubStandard: 'smixs/visual-skills (Studio Tabletop Motion)',
    sourceUrl: 'https://raw.githubusercontent.com/smixs/visual-skills/main/README.md',
    summary: '专为数码硬件、工艺器物与功能产品设计，强调电控滑轨精确位移、倒角扫光与一镜看懂核心结构。',
    structureBeats: '01 暗调轮廓扫光唤醒 → 02 核心结构交互动作 → 03 功能/界面工作状态 → 04 全貌参数收口',
    opticalSpec: '85mm / 100mm 微距滑轨 · 零手持抖动精密运动 · 受控柔光箱边缘高光 · 中性高锐还原',
    recommendedProfile: 'doc_neutral',
    recommendedDurationS: 20,
    recommendedAspect: '16:9',
    systemDirectives: [
      '[GitHub Spec: smixs/visual-skills Industrial Tabletop Spec]',
      '- 严禁手持晃动；全部运镜必须为精确的电控滑轨、机械臂弧线围绕或锁定微距推轨（slider / orbital arc）。',
      '- 着重描写表面工艺物理反馈（阳极氧化铝、拉丝金属、玻璃镀膜、磨砂阻尼、指示灯点亮渐变）。',
      '- 布光采用可追溯的棚拍光源（overhead diffused softbox、narrow strip rim light carving metallic bevels）。',
      '- 口播精准客观，用可视化动作替代抽象形容词，让观众不靠字幕也能看懂产品工作原理。'
    ].join('\n')
  },
  {
    id: 'scenic_essay',
    category: '散文',
    label: '视觉散文 · 城市/自然史诗',
    englishName: 'Atmospheric Spatial Essay',
    githubStandard: 'prompt-storyboard-studio (Wide Architectural Poem)',
    sourceUrl: 'https://raw.githubusercontent.com/Mirza-Luqman/prompt-storyboard-studio/main/README.md',
    summary: '以空间尺度、气象光线与城市/自然韵律为核心，构建极具电影院线大银幕呼吸感的低饱和视觉诗。',
    structureBeats: '01 广角气象与建筑定场 → 02 光影水流动态细节 → 03 人与空间尺度剪影 → 04 天光渐变定格',
    opticalSpec: '16mm / 24mm 建筑广角 · 4.5s~6.5s 极缓推轨/航拍感 · 蓝调时刻/雨夜反射 · 低饱和电影感',
    recommendedProfile: 'landscape_low_sat',
    recommendedDurationS: 20,
    recommendedAspect: '16:9',
    systemDirectives: [
      '[GitHub Spec: prompt-storyboard-studio Atmospheric Spatial Essay]',
      '- 强调大空间透视线条（24mm architectural symmetry, leading lines, vast negative space）与缓慢克制的摄影机移动。',
      '- 核心描述围绕空气介质与光线演变展开（wet asphalt neon reflections, morning mist scattering, blue-hour twilight gradient）。',
      '- 旁白如电影画外音散文诗般精炼节制，允许 1~2 场完全由自然环境声与音乐留白承载。',
      '- 禁止急促闪切，每镜维持 4.0s~6.5s 的沉静视觉呼吸时长。'
    ].join('\n')
  }
]

export function getScriptPromptTemplate(
  templateId?: string | null,
  overrides?: Partial<Record<VideoTemplateId, Partial<ScriptPromptTemplate>>>
): ScriptPromptTemplate {
  const list = mergeTemplatesWithOverrides(overrides)
  if (!templateId) return list[0]
  return list.find((t) => t.id === templateId) ?? list[0]
}

function mergeTemplatesWithOverrides(
  overrides?: Partial<Record<VideoTemplateId, Partial<ScriptPromptTemplate>>>
): ScriptPromptTemplate[] {
  if (!overrides) return GITHUB_SCRIPT_TEMPLATES
  return GITHUB_SCRIPT_TEMPLATES.map((base) => {
    const patch = overrides[base.id]
    if (!patch) return base
    return {
      ...base,
      ...(typeof patch.category === 'string' && patch.category.trim() ? { category: patch.category.trim() } : {}),
      ...(typeof patch.label === 'string' && patch.label.trim() ? { label: patch.label.trim() } : {}),
      ...(typeof patch.summary === 'string' && patch.summary.trim() ? { summary: patch.summary.trim() } : {}),
      ...(typeof patch.structureBeats === 'string' && patch.structureBeats.trim()
        ? { structureBeats: patch.structureBeats.trim() }
        : {}),
      ...(typeof patch.opticalSpec === 'string' && patch.opticalSpec.trim()
        ? { opticalSpec: patch.opticalSpec.trim() }
        : {}),
      ...(typeof patch.systemDirectives === 'string' && patch.systemDirectives.trim()
        ? { systemDirectives: patch.systemDirectives.trim() }
        : {}),
      ...(typeof patch.githubStandard === 'string' && patch.githubStandard.trim()
        ? { githubStandard: patch.githubStandard.trim() }
        : {})
    }
  })
}

export function getMergedScriptTemplates(
  dataRoot?: string,
  readJson?: (file: string) => any,
  category?: string | null
): ScriptPromptTemplate[] {
  let overrides: Partial<Record<VideoTemplateId, Partial<ScriptPromptTemplate>>> | undefined
  if (dataRoot && readJson) {
    const file = path.join(dataRoot, 'script-templates-overrides.json')
    const stored = readJson(file)
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
      overrides = stored as Partial<Record<VideoTemplateId, Partial<ScriptPromptTemplate>>>
    }
  }
  const merged = mergeTemplatesWithOverrides(overrides)
  const cat = category?.trim()
  if (!cat || cat === 'all' || cat === '全部') return merged
  return merged.filter((t) => t.category === cat || t.id === cat)
}

function defaultGiteaSource(): GiteaTemplateSource {
  const repo = (process.env.GITEA_REPO || 'gitadmin/kex-labs-video').trim() || 'gitadmin/kex-labs-video'
  const branch = (process.env.GITEA_PROMPTS_REF || 'main').trim() || 'main'
  const filePath =
    (process.env.GITEA_PROMPTS_PATH || 'prompts/script-templates.json').trim() ||
    'prompts/script-templates.json'
  const configured = Boolean(
    (process.env.GITEA_TOKEN || (process.env.GITEA_USER && process.env.GITEA_PASS)) && repo
  )
  return {
    enabled: true,
    repo,
    branch,
    filePath,
    configured,
    lastSyncedAt: null,
    status: 'idle',
    message: configured
      ? 'Prompt-Scout Agent 就绪：可自动检索 Gitea 仓库与分支中的最新导演提示词定义。'
      : 'Prompt-Scout Agent 就绪：将自动巡检 Gitea 仓库并结合 GitHub 行业标准更新提示词库。',
    htmlUrl: null,
    agentName: 'Prompt-Scout Agent',
    scannedRepos: [],
    discoveredLocations: []
  }
}

function defaultSyncState(): TemplateSyncState {
  return {
    autoSyncEnabled: true,
    intervalHours: 24,
    lastSyncedAt: null,
    lastSyncMode: 'initial',
    syncStatus: 'idle',
    lastResultMessage: '尚未执行远端同步，当前使用随库预置的 GitHub 行业标准规范。',
    sources: DEFAULT_UPSTREAM_SOURCES.map((s) => ({ ...s })),
    giteaSource: defaultGiteaSource()
  }
}

export function getTemplateSyncState(
  dataRoot?: string,
  readJson?: (file: string) => any
): TemplateSyncState {
  const fallback = defaultSyncState()
  if (!dataRoot || !readJson) return fallback
  const file = path.join(dataRoot, 'script-templates-sync.json')
  const stored = readJson(file)
  if (!stored || typeof stored !== 'object') return fallback
  const storedGitea =
    stored.giteaSource && typeof stored.giteaSource === 'object'
      ? (stored.giteaSource as Partial<GiteaTemplateSource>)
      : {}
  return {
    autoSyncEnabled: typeof stored.autoSyncEnabled === 'boolean' ? stored.autoSyncEnabled : true,
    intervalHours: [6, 12, 24, 72].includes(stored.intervalHours) ? stored.intervalHours : 24,
    lastSyncedAt: typeof stored.lastSyncedAt === 'string' ? stored.lastSyncedAt : null,
    lastSyncMode:
      stored.lastSyncMode === 'manual' || stored.lastSyncMode === 'scheduled'
        ? stored.lastSyncMode
        : 'initial',
    syncStatus: stored.syncStatus === 'synced' || stored.syncStatus === 'partial' ? stored.syncStatus : 'idle',
    lastResultMessage:
      typeof stored.lastResultMessage === 'string' && stored.lastResultMessage.trim()
        ? stored.lastResultMessage
        : fallback.lastResultMessage,
    sources: Array.isArray(stored.sources) && stored.sources.length ? stored.sources : fallback.sources,
    giteaSource: {
      ...fallback.giteaSource,
      ...storedGitea,
      configured: fallback.giteaSource.configured
    }
  }
}

function sha256Hex(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex')
}

function atomicWriteText(file: string, text: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}

/**
 * Also materializes pulled/selected GitHub prompt skills into `<dataRoot>/agents/skills/`
 * so AgentsPage and ScriptEditor share the exact same GitHub template provenance.
 */
function materializeGithubSkillInAgentLibrary(
  dataRoot: string,
  source: UpstreamGithubSource,
  fetchedText: string | null,
  atomicWriteJson: (file: string, value: unknown) => void,
  readJson?: (file: string) => any
): string | null {
  const relatedTemplates = GITHUB_SCRIPT_TEMPLATES.filter((t) =>
    t.sourceUrl.includes(source.repo)
  )
  const markdown = [
    '---',
    `name: ${source.id.replace(/^seed-/, '')}`,
    `description: "【GitHub 导演规范】${source.repo} · ${source.role}（同步自脚本编辑器模板库）"`,
    `license: ${source.license}`,
    '---',
    '',
    `# ${source.repo}`,
    '',
    `- **上游仓库**：\`${source.repo}\` (${source.branch})`,
    `- **来源地址**：${source.url}`,
    `- **最近同步**：${source.checkedAt ?? new Date().toISOString()}（状态：${source.status}）`,
    '',
    '## 关联视频模板规则',
    ...relatedTemplates.flatMap((tpl) => [
      `### ${tpl.label} (${tpl.id})`,
      tpl.systemDirectives,
      ''
    ]),
    ...(fetchedText
      ? ['## 上游 README 摘要（实时拉取）', '```markdown', fetchedText.slice(0, 2400), '```']
      : [])
  ].join('\n')

  const skillDir = path.join(dataRoot, 'agents', 'skills', source.id)
  const metaPath = path.join(skillDir, 'meta.json')
  const existing = readJson?.(metaPath)
  const hash = sha256Hex(markdown)
  const now = new Date().toISOString()

  if (existing && typeof existing === 'object' && Array.isArray(existing.versions)) {
    const activeVer = existing.versions.find((v: any) => v.version === existing.active_version)
    if (activeVer?.sha256 === hash) {
      return null // unchanged
    }
    const nextVersion = Math.max(...existing.versions.map((v: any) => Number(v.version) || 1)) + 1
    atomicWriteText(path.join(skillDir, 'versions', `v${nextVersion}.md`), markdown)
    atomicWriteText(path.join(skillDir, 'content.md'), markdown)
    const updatedMeta = {
      ...existing,
      active_version: nextVersion,
      updated_at: now,
      source: {
        ...existing.source,
        kind: 'import',
        url: source.url,
        repo: source.repo,
        license: source.license,
        sha256: hash,
        imported_at: now
      },
      versions: [
        ...existing.versions,
        { version: nextVersion, sha256: hash, created_at: now, message: 'github sync update' }
      ]
    }
    atomicWriteJson(metaPath, updatedMeta)
    return source.id
  }

  atomicWriteText(path.join(skillDir, 'versions', 'v1.md'), markdown)
  atomicWriteText(path.join(skillDir, 'content.md'), markdown)
  atomicWriteJson(metaPath, {
    id: source.id,
    type: 'skill',
    name: source.id.replace(/^seed-github-/, 'github-'),
    description: `【GitHub 导演规范】${source.repo} · ${source.role}`,
    namespace: 'import',
    active: true,
    active_version: 1,
    project: 'kex-labs-video',
    source: {
      kind: 'import',
      url: source.url,
      repo: source.repo,
      commit: null,
      license: source.license,
      sha256: hash,
      imported_at: now
    },
    created_at: now,
    updated_at: now,
    versions: [{ version: 1, sha256: hash, created_at: now, message: 'github template sync' }]
  })
  return source.id
}

export async function syncScriptTemplatesFromGitHub(opts: {
  mode: 'manual' | 'scheduled'
  dataRoot?: string
  readJson?: (file: string) => any
  atomicWriteJson?: (file: string, value: unknown) => void
  fetchImpl?: typeof fetch
}): Promise<{ sync: TemplateSyncState; syncedSkills: string[] }> {
  const prev = getTemplateSyncState(opts.dataRoot, opts.readJson)
  const fetcher = opts.fetchImpl ?? fetch
  const now = new Date().toISOString()
  const updatedSources: UpstreamGithubSource[] = []
  const syncedSkills: string[] = []
  let okCount = 0

  for (const src of prev.sources) {
    let fetchedText: string | null = null
    let status: UpstreamGithubSource['status'] = 'fallback'
    let etag = src.etag ?? null
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 5000)
      try {
        const res = await fetcher(src.url, {
          signal: controller.signal,
          headers: { 'User-Agent': 'aistudio-build' }
        })
        if (res.ok) {
          fetchedText = await res.text()
          etag = res.headers.get('etag') ?? etag
          status = 'synced'
          okCount += 1
        }
      } finally {
        clearTimeout(timer)
      }
    } catch {
      status = 'fallback'
    }

    const nextSource: UpstreamGithubSource = {
      ...src,
      status,
      checkedAt: now,
      etag
    }
    updatedSources.push(nextSource)

    if (opts.dataRoot && opts.atomicWriteJson) {
      const changed = materializeGithubSkillInAgentLibrary(
        opts.dataRoot,
        nextSource,
        fetchedText,
        opts.atomicWriteJson,
        opts.readJson
      )
      if (changed) syncedSkills.push(changed)
    }
  }

  const nextState: TemplateSyncState = {
    ...prev,
    lastSyncedAt: now,
    lastSyncMode: opts.mode,
    syncStatus: okCount === updatedSources.length ? 'synced' : 'partial',
    lastResultMessage:
      okCount === updatedSources.length
        ? `${opts.mode === 'manual' ? '手动' : '定时'}同步完成：全部 ${okCount} 个 GitHub 上游规范源已校对更新。`
        : `${opts.mode === 'manual' ? '手动' : '定时'}校验完成：${okCount}/${updatedSources.length} 个远端在线更新，其余沿用本地锁定版规范并已写入 Agent 库。`,
    sources: updatedSources
  }

  if (opts.dataRoot && opts.atomicWriteJson) {
    opts.atomicWriteJson(path.join(opts.dataRoot, 'script-templates-sync.json'), nextState)
  }

  return { sync: nextState, syncedSkills }
}

export function parseTemplateOverridesFromContent(
  rawText: string
): Partial<Record<VideoTemplateId, Partial<ScriptPromptTemplate>>> {
  const trimmed = rawText.trim()
  if (!trimmed) return {}
  const validIds = new Set<string>(GITHUB_SCRIPT_TEMPLATES.map((t) => t.id))
  const overrides: Partial<Record<VideoTemplateId, Partial<ScriptPromptTemplate>>> = {}

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      const list = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object' && Array.isArray((parsed as { templates?: unknown }).templates)
          ? (parsed as { templates: unknown[] }).templates
          : []
      for (const entry of list) {
        if (!entry || typeof entry !== 'object') continue
        const rec = entry as Record<string, unknown>
        const id = typeof rec.id === 'string' ? rec.id.trim() : ''
        if (!validIds.has(id)) continue
        overrides[id as VideoTemplateId] = {
          ...(typeof rec.label === 'string' ? { label: rec.label } : {}),
          ...(typeof rec.summary === 'string' ? { summary: rec.summary } : {}),
          ...(typeof rec.structureBeats === 'string' ? { structureBeats: rec.structureBeats } : {}),
          ...(typeof rec.opticalSpec === 'string' ? { opticalSpec: rec.opticalSpec } : {}),
          ...(typeof rec.systemDirectives === 'string' ? { systemDirectives: rec.systemDirectives } : {}),
          ...(typeof rec.githubStandard === 'string' ? { githubStandard: rec.githubStandard } : {})
        }
      }
      if (Object.keys(overrides).length > 0) return overrides
    } catch {
      // fall through to Markdown parser
    }
  }

  // Markdown sections parser: `## marketing`, `## documentary`, etc.
  const sectionRegex = /^##\s+([a-z0-9_]+)\s*\r?\n([\s\S]*?)(?=^##\s+|(?![\s\S]))/gim
  let match: RegExpExecArray | null
  while ((match = sectionRegex.exec(trimmed)) !== null) {
    const id = match[1].trim()
    const body = match[2].trim()
    if (validIds.has(id) && body) {
      overrides[id as VideoTemplateId] = { systemDirectives: body.slice(0, 1800) }
    }
  }
  return overrides
}

export async function syncScriptTemplatesFromGitea(opts: {
  repo?: string
  branch?: string
  filePath?: string
  dataRoot?: string
  readJson?: (file: string) => any
  atomicWriteJson?: (file: string, value: unknown) => void
  fetchImpl?: typeof fetch
}): Promise<{ sync: TemplateSyncState; updatedCount: number; syncedSkills: string[] }> {
  const prev = getTemplateSyncState(opts.dataRoot, opts.readJson)
  const targetRepo = (opts.repo ?? prev.giteaSource.repo).trim() || prev.giteaSource.repo
  const targetBranch = (opts.branch ?? prev.giteaSource.branch).trim() || prev.giteaSource.branch
  const targetPath = (opts.filePath ?? prev.giteaSource.filePath).trim() || prev.giteaSource.filePath
  const now = new Date().toISOString()

  let updatedCount = 0
  const syncedSkills: string[] = []
  let nextGitea: GiteaTemplateSource = {
    ...prev.giteaSource,
    repo: targetRepo,
    branch: targetBranch,
    filePath: targetPath,
    lastSyncedAt: now,
    status: 'fallback',
    message: ''
  }

  try {
    const { fetchGiteaRepoFile } = await import('./gitea')
    const file = await fetchGiteaRepoFile({
      repo: targetRepo,
      ref: targetBranch,
      filePath: targetPath,
      fetchImpl: opts.fetchImpl
    })
    const overrides = parseTemplateOverridesFromContent(file.content)
    updatedCount = Object.keys(overrides).length
    if (opts.dataRoot && opts.atomicWriteJson && updatedCount > 0) {
      const overridesFile = path.join(opts.dataRoot, 'script-templates-overrides.json')
      const existing = opts.readJson?.(overridesFile)
      const merged =
        existing && typeof existing === 'object' && !Array.isArray(existing)
          ? { ...existing, ...overrides }
          : overrides
      opts.atomicWriteJson(overridesFile, merged)
    }

    if (opts.dataRoot && opts.atomicWriteJson) {
      const changed = materializeGithubSkillInAgentLibrary(
        opts.dataRoot,
        {
          id: 'gitea-script-templates',
          repo: targetRepo,
          branch: targetBranch,
          url: file.htmlUrl || `gitea://${targetRepo}/${targetPath}`,
          license: 'internal',
          role: 'Gitea 仓库同步导演提示词规范',
          status: 'synced',
          checkedAt: now
        },
        file.content,
        opts.atomicWriteJson,
        opts.readJson
      )
      if (changed) syncedSkills.push(changed)
    }

    nextGitea = {
      ...nextGitea,
      status: 'synced',
      htmlUrl: file.htmlUrl,
      message:
        updatedCount > 0
          ? `已从 Gitea 仓库 ${targetRepo}@${targetBranch} 拉取 ${targetPath}，更新 ${updatedCount} 类导演定义。`
          : `已连通 Gitea 仓库 ${targetRepo}@${targetBranch}（${targetPath}），内容已同步至技能库。`
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Gitea 拉取失败'
    nextGitea = {
      ...nextGitea,
      status: 'fallback',
      message: `未能连入 Gitea 仓库 ${targetRepo}（${errMsg}），继续保留当前已锁定定义。`
    }
  }

  const nextState: TemplateSyncState = {
    ...prev,
    lastSyncedAt: now,
    lastSyncMode: 'manual',
    syncStatus: nextGitea.status === 'synced' ? 'synced' : 'partial',
    lastResultMessage: nextGitea.message,
    giteaSource: nextGitea
  }

  if (opts.dataRoot && opts.atomicWriteJson) {
    opts.atomicWriteJson(path.join(opts.dataRoot, 'script-templates-sync.json'), nextState)
  }

  return { sync: nextState, updatedCount, syncedSkills }
}

/**
 * Autonomous Agent discovery + pull:
 * Scans accessible Gitea repositories and directory trees without requiring manual path entry,
 * validates candidate prompt/template definitions, persists overrides, and records provenance.
 */
export async function agentDiscoverAndSyncGiteaTemplates(opts: {
  mode?: 'manual' | 'scheduled'
  preferredRepo?: string
  preferredBranch?: string
  dataRoot?: string
  readJson?: (file: string) => any
  atomicWriteJson?: (file: string, value: unknown) => void
  fetchImpl?: typeof fetch
} = {}): Promise<{
  sync: TemplateSyncState
  updatedCount: number
  syncedSkills: string[]
  discoveredLocations: GiteaDiscoveredLocation[]
}> {
  const prev = getTemplateSyncState(opts.dataRoot, opts.readJson)
  const now = new Date().toISOString()
  const runMode = opts.mode ?? 'manual'
  const syncedSkills: string[] = []
  const discoveredLocations: GiteaDiscoveredLocation[] = []
  let combinedOverrides: Partial<Record<VideoTemplateId, Partial<ScriptPromptTemplate>>> = {}
  let scannedRepos: string[] = []
  let primaryCandidate: GiteaDiscoveredLocation | null = null

  try {
    const { discoverGiteaPromptFiles, fetchGiteaRepoFile } = await import('./gitea')
    const discovery = await discoverGiteaPromptFiles({
      preferredRepo: opts.preferredRepo,
      preferredBranch: opts.preferredBranch,
      fetchImpl: opts.fetchImpl
    })
    scannedRepos = discovery.scannedRepos

    const probeQueue =
      discovery.candidates.length > 0
        ? discovery.candidates
        : [
            {
              repo: (opts.preferredRepo ?? prev.giteaSource.repo).trim() || prev.giteaSource.repo,
              branch: (opts.preferredBranch ?? prev.giteaSource.branch).trim() || prev.giteaSource.branch,
              filePath: prev.giteaSource.filePath || 'prompts/script-templates.json',
              score: 1,
              htmlUrl: ''
            }
          ]

    for (const candidate of probeQueue.slice(0, 6)) {
      try {
        const file = await fetchGiteaRepoFile({
          repo: candidate.repo,
          ref: candidate.branch,
          filePath: candidate.filePath,
          fetchImpl: opts.fetchImpl
        })
        const parsed = parseTemplateOverridesFromContent(file.content)
        const matchedCount = Object.keys(parsed).length
        const loc: GiteaDiscoveredLocation = {
          repo: file.repo,
          branch: file.ref,
          filePath: file.filePath,
          matchedTemplates: matchedCount,
          htmlUrl: file.htmlUrl
        }
        discoveredLocations.push(loc)
        if (matchedCount > 0) {
          combinedOverrides = { ...combinedOverrides, ...parsed }
          if (!primaryCandidate) primaryCandidate = loc
        }

        if (opts.dataRoot && opts.atomicWriteJson && (matchedCount > 0 || !primaryCandidate)) {
          const changed = materializeGithubSkillInAgentLibrary(
            opts.dataRoot,
            {
              id: 'gitea-script-templates',
              repo: file.repo,
              branch: file.ref,
              url: file.htmlUrl || `gitea://${file.repo}/${file.filePath}`,
              license: 'internal',
              role: `Agent 自动发现导演提示词规范 (${file.filePath})`,
              status: 'synced',
              checkedAt: now
            },
            file.content,
            opts.atomicWriteJson,
            opts.readJson
          )
          if (changed) syncedSkills.push(changed)
        }
      } catch {
        // skip unreadable candidate and continue scanning others
      }
    }

    const updatedCount = Object.keys(combinedOverrides).length
    if (opts.dataRoot && opts.atomicWriteJson && updatedCount > 0) {
      const overridesFile = path.join(opts.dataRoot, 'script-templates-overrides.json')
      const existing = opts.readJson?.(overridesFile)
      const merged =
        existing && typeof existing === 'object' && !Array.isArray(existing)
          ? { ...existing, ...combinedOverrides }
          : combinedOverrides
      opts.atomicWriteJson(overridesFile, merged)
    }

    const topLoc = primaryCandidate ?? discoveredLocations[0] ?? null
    const nextGitea: GiteaTemplateSource = {
      ...prev.giteaSource,
      agentName: 'Prompt-Scout Agent',
      repo: topLoc?.repo ?? prev.giteaSource.repo,
      branch: topLoc?.branch ?? prev.giteaSource.branch,
      filePath: topLoc?.filePath ?? prev.giteaSource.filePath,
      htmlUrl: topLoc?.htmlUrl ?? prev.giteaSource.htmlUrl ?? null,
      lastSyncedAt: now,
      scannedRepos,
      discoveredLocations,
      status: discoveredLocations.length > 0 ? 'synced' : 'fallback',
      message:
        updatedCount > 0 && topLoc
          ? `Prompt-Scout Agent 已自动扫描 ${scannedRepos.length} 个 Gitea 仓库，在 ${topLoc.repo}@${topLoc.branch} 定位到 ${topLoc.filePath} 并同步 ${updatedCount} 类导演定义。`
          : discoveredLocations.length > 0 && topLoc
            ? `Agent 已扫描 ${scannedRepos.length} 个 Gitea 仓库并检索到 ${discoveredLocations.length} 份候选文件（含 ${topLoc.filePath}），已同步至技能库。`
            : `Agent 已巡检 ${scannedRepos.length} 个 Gitea 仓库，暂未发现结构化模板覆写文件，继续沿用当前已锁定行业规范。`
    }

    const nextState: TemplateSyncState = {
      ...prev,
      lastSyncedAt: now,
      lastSyncMode: runMode,
      syncStatus: updatedCount > 0 ? 'synced' : 'partial',
      lastResultMessage: nextGitea.message,
      giteaSource: nextGitea
    }
    if (opts.dataRoot && opts.atomicWriteJson) {
      opts.atomicWriteJson(path.join(opts.dataRoot, 'script-templates-sync.json'), nextState)
    }
    return { sync: nextState, updatedCount, syncedSkills, discoveredLocations }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Gitea Agent 巡检未连通'
    const nextGitea: GiteaTemplateSource = {
      ...prev.giteaSource,
      agentName: 'Prompt-Scout Agent',
      lastSyncedAt: now,
      scannedRepos,
      discoveredLocations,
      status: 'fallback',
      message: `Agent 自动巡检 Gitea 未连入（${errMsg}），继续使用 GitHub 行业标准与本地已锁定定义。`
    }
    const nextState: TemplateSyncState = {
      ...prev,
      lastSyncedAt: now,
      lastSyncMode: runMode,
      syncStatus: 'partial',
      lastResultMessage: nextGitea.message,
      giteaSource: nextGitea
    }
    if (opts.dataRoot && opts.atomicWriteJson) {
      opts.atomicWriteJson(path.join(opts.dataRoot, 'script-templates-sync.json'), nextState)
    }
    return { sync: nextState, updatedCount: 0, syncedSkills, discoveredLocations }
  }
}

export function updateTemplateSyncSchedule(opts: {
  autoSyncEnabled?: boolean
  intervalHours?: number
  giteaRepo?: string
  giteaBranch?: string
  giteaFilePath?: string
  giteaEnabled?: boolean
  dataRoot?: string
  readJson?: (file: string) => any
  atomicWriteJson?: (file: string, value: unknown) => void
}): TemplateSyncState {
  const prev = getTemplateSyncState(opts.dataRoot, opts.readJson)
  const nextInterval =
    typeof opts.intervalHours === 'number' && [6, 12, 24, 72].includes(opts.intervalHours)
      ? (opts.intervalHours as 6 | 12 | 24 | 72)
      : prev.intervalHours
  const next: TemplateSyncState = {
    ...prev,
    autoSyncEnabled:
      typeof opts.autoSyncEnabled === 'boolean' ? opts.autoSyncEnabled : prev.autoSyncEnabled,
    intervalHours: nextInterval,
    giteaSource: {
      ...prev.giteaSource,
      enabled:
        typeof opts.giteaEnabled === 'boolean' ? opts.giteaEnabled : prev.giteaSource.enabled,
      repo:
        typeof opts.giteaRepo === 'string' && opts.giteaRepo.trim()
          ? opts.giteaRepo.trim()
          : prev.giteaSource.repo,
      branch:
        typeof opts.giteaBranch === 'string' && opts.giteaBranch.trim()
          ? opts.giteaBranch.trim()
          : prev.giteaSource.branch,
      filePath:
        typeof opts.giteaFilePath === 'string' && opts.giteaFilePath.trim()
          ? opts.giteaFilePath.trim()
          : prev.giteaSource.filePath
    }
  }
  if (opts.dataRoot && opts.atomicWriteJson) {
    opts.atomicWriteJson(path.join(opts.dataRoot, 'script-templates-sync.json'), next)
  }
  return next
}

let schedulerTimer: NodeJS.Timeout | null = null
let activeSchedulerIntervalMs = 0

export function configureTemplateAutoSyncScheduler(opts: {
  dataRoot: string
  readJson: (file: string) => any
  atomicWriteJson: (file: string, value: unknown) => void
}): void {
  const state = getTemplateSyncState(opts.dataRoot, opts.readJson)
  const targetMs = state.intervalHours * 3600 * 1000

  if (!state.autoSyncEnabled) {
    if (schedulerTimer) {
      clearInterval(schedulerTimer)
      schedulerTimer = null
      activeSchedulerIntervalMs = 0
    }
    return
  }

  if (schedulerTimer && activeSchedulerIntervalMs === targetMs) return
  if (schedulerTimer) clearInterval(schedulerTimer)
  activeSchedulerIntervalMs = targetMs
  schedulerTimer = setInterval(() => {
    void (async () => {
      await syncScriptTemplatesFromGitHub({
        mode: 'scheduled',
        dataRoot: opts.dataRoot,
        readJson: opts.readJson,
        atomicWriteJson: opts.atomicWriteJson
      })
      await agentDiscoverAndSyncGiteaTemplates({
        mode: 'scheduled',
        dataRoot: opts.dataRoot,
        readJson: opts.readJson,
        atomicWriteJson: opts.atomicWriteJson
      })
    })().catch((err) => {
      console.error('[script-templates] scheduled agent sync failed:', err)
    })
  }, targetMs)
  schedulerTimer.unref()
}
