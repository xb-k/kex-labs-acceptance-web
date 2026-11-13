import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import defaultTemplateData from './script-templates.default.json'

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

export const SCRIPT_TEMPLATE_IDS = [
  'marketing',
  'documentary',
  'narrative',
  'historical_novel',
  'vlog',
  'product_demo',
  'scenic_essay'
] as const satisfies readonly VideoTemplateId[]

export const RECOMMENDED_PROFILES = [
  'ad_teal_orange',
  'vlog_warm_film',
  'doc_neutral',
  'landscape_low_sat'
] as const

export const RECOMMENDED_DURATIONS_S = [10, 15, 20, 30, 45, 60] as const

export const RECOMMENDED_ASPECTS = ['16:9', '9:16', '1:1', '4:5'] as const

/** Fields a `PUT /api/script-templates/:id` caller may change (#134). */
export const EDITABLE_TEMPLATE_FIELDS = [
  'label',
  'summary',
  'structureBeats',
  'opticalSpec',
  'systemDirectives',
  'recommendedProfile',
  'recommendedDurationS',
  'recommendedAspect'
] as const

/**
 * Loader-accepted override fields (superset of PUT): the existing GitHub/Gitea
 * sync has always been allowed to override `category` / `githubStandard`, so
 * those keep working when they arrive through the override store.
 */
const LOADABLE_TEMPLATE_FIELDS = [
  'category',
  'label',
  'summary',
  'structureBeats',
  'opticalSpec',
  'systemDirectives',
  'githubStandard',
  ...EDITABLE_TEMPLATE_FIELDS
] as const

const DEFAULT_STRING_FIELDS = [
  'category',
  'label',
  'englishName',
  'githubStandard',
  'sourceUrl',
  'summary',
  'structureBeats',
  'opticalSpec',
  'systemDirectives'
] as const

const TEXT_FIELD_LIMITS: Record<string, number> = {
  category: 40,
  label: 80,
  summary: 400,
  structureBeats: 400,
  opticalSpec: 400,
  systemDirectives: 4000,
  githubStandard: 200
}

/** Canonical override store relative to `WEB_DATA_ROOT` (#134).
 * Function (not a top-level const) so the browser bundle can tree-shake this
 * server-only module without executing `node:path` at import time. */
export function templateOverridesRelativePath(): string {
  return path.join('script-templates', 'overrides.json')
}
/** Pre-#134 store; still read when the canonical file is absent. */
const LEGACY_OVERRIDES_FILENAME = 'script-templates-overrides.json'

export function templateOverridesFile(dataRoot: string): string {
  return path.join(dataRoot, templateOverridesRelativePath())
}

export function isScriptTemplateId(value: unknown): value is VideoTemplateId {
  return typeof value === 'string' && (SCRIPT_TEMPLATE_IDS as readonly string[]).includes(value)
}

function isRecommendedProfile(value: unknown): value is ScriptPromptTemplate['recommendedProfile'] {
  return typeof value === 'string' && (RECOMMENDED_PROFILES as readonly string[]).includes(value)
}

function isRecommendedDuration(value: unknown): value is ScriptPromptTemplate['recommendedDurationS'] {
  return typeof value === 'number' && (RECOMMENDED_DURATIONS_S as readonly number[]).includes(value)
}

function isRecommendedAspect(value: unknown): value is ScriptPromptTemplate['recommendedAspect'] {
  return typeof value === 'string' && (RECOMMENDED_ASPECTS as readonly string[]).includes(value)
}

/**
 * #134: the seven built-in director templates live in
 * `server/script-templates.default.json` and are bundled into the server build
 * (esbuild inlines JSON imports, so `serve.mjs` needs no extra file at runtime).
 * The object below is validated once at module load; a malformed default file
 * fails loudly instead of silently downgrading to an empty library.
 */
function loadDefaultScriptTemplates(): ScriptPromptTemplate[] {
  const raw = defaultTemplateData as unknown
  if (!Array.isArray(raw)) {
    throw new Error('script-templates.default.json: expected an array of templates')
  }
  const ids = new Set<string>(SCRIPT_TEMPLATE_IDS)
  const seen = new Set<string>()
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`script-templates.default.json: entry ${index} is not an object`)
    }
    const rec = entry as Record<string, unknown>
    const id = typeof rec.id === 'string' ? rec.id : ''
    if (!ids.has(id)) {
      throw new Error(`script-templates.default.json: entry ${index} has unknown id "${id}"`)
    }
    if (seen.has(id)) {
      throw new Error(`script-templates.default.json: duplicate id "${id}"`)
    }
    seen.add(id)
    for (const field of DEFAULT_STRING_FIELDS) {
      if (typeof rec[field] !== 'string' || !(rec[field] as string).trim()) {
        throw new Error(`script-templates.default.json: "${id}.${field}" must be a non-empty string`)
      }
    }
    if (!isRecommendedProfile(rec.recommendedProfile)) {
      throw new Error(`script-templates.default.json: "${id}.recommendedProfile" is not a known profile`)
    }
    if (!isRecommendedDuration(rec.recommendedDurationS)) {
      throw new Error(`script-templates.default.json: "${id}.recommendedDurationS" is not a known duration`)
    }
    if (!isRecommendedAspect(rec.recommendedAspect)) {
      throw new Error(`script-templates.default.json: "${id}.recommendedAspect" is not a known aspect`)
    }
    if (rec.supportsNovelSeries !== undefined && typeof rec.supportsNovelSeries !== 'boolean') {
      throw new Error(`script-templates.default.json: "${id}.supportsNovelSeries" must be a boolean`)
    }
    return rec as unknown as ScriptPromptTemplate
  })
}

export const GITHUB_SCRIPT_TEMPLATES: ScriptPromptTemplate[] = loadDefaultScriptTemplates()

export function getScriptPromptTemplate(
  templateId?: string | null,
  overrides?: Partial<Record<VideoTemplateId, Partial<ScriptPromptTemplate>>>
): ScriptPromptTemplate {
  const list = mergeTemplatesWithOverrides(overrides)
  if (!templateId) return list[0]
  return list.find((t) => t.id === templateId) ?? list[0]
}

export type TemplateOverride = Partial<
  Pick<ScriptPromptTemplate, (typeof LOADABLE_TEMPLATE_FIELDS)[number]>
>

export interface ScriptTemplateWithSource extends ScriptPromptTemplate {
  source: 'default' | 'override'
}

export interface TemplateOverridesReadResult {
  overrides: Partial<Record<VideoTemplateId, TemplateOverride>>
  warnings: string[]
}

type OverrideFieldValue = string | number

function validateOverrideField(
  field: string,
  value: unknown
): { ok: true; value: OverrideFieldValue } | { ok: false; error: string } {
  if (field === 'recommendedProfile') {
    return isRecommendedProfile(value)
      ? { ok: true, value }
      : { ok: false, error: 'must be one of ad_teal_orange|vlog_warm_film|doc_neutral|landscape_low_sat' }
  }
  if (field === 'recommendedDurationS') {
    return isRecommendedDuration(value)
      ? { ok: true, value }
      : { ok: false, error: 'must be one of 10|15|20|30|45|60' }
  }
  if (field === 'recommendedAspect') {
    return isRecommendedAspect(value)
      ? { ok: true, value }
      : { ok: false, error: 'must be one of 16:9|9:16|1:1|4:5' }
  }
  if (typeof value !== 'string') return { ok: false, error: 'must be a string' }
  const trimmed = value.trim()
  if (!trimmed) return { ok: false, error: 'must not be empty' }
  const limit = TEXT_FIELD_LIMITS[field] ?? 400
  if (trimmed.length > limit) return { ok: false, error: `must be <= ${limit} characters` }
  return { ok: true, value: trimmed }
}

function sanitizeOverrideEntry(
  id: string,
  raw: unknown,
  warnings: string[]
): TemplateOverride | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push(`${id}: override must be an object, ignored`)
    return null
  }
  const patch: Record<string, OverrideFieldValue> = {}
  for (const [field, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(LOADABLE_TEMPLATE_FIELDS as readonly string[]).includes(field)) {
      warnings.push(`${id}.${field}: unsupported field, ignored`)
      continue
    }
    const verdict = validateOverrideField(field, value)
    if (!verdict.ok) {
      warnings.push(`${id}.${field}: ${verdict.error}, ignored`)
      continue
    }
    patch[field] = verdict.value
  }
  return Object.keys(patch).length ? (patch as TemplateOverride) : null
}

/**
 * Reads the override store from `<dataRoot>/script-templates/overrides.json`.
 * When that file does not exist, the pre-#134 `script-templates-overrides.json`
 * is read instead so already-synced data keeps working. Invalid ids/fields are
 * dropped and reported through `warnings` — never thrown.
 */
export function readTemplateOverrides(
  dataRoot?: string,
  readJson?: (file: string) => any
): TemplateOverridesReadResult {
  const warnings: string[] = []
  if (!dataRoot || !readJson) return { overrides: {}, warnings }
  let stored = readJson(templateOverridesFile(dataRoot))
  if (stored === null || stored === undefined) {
    stored = readJson(path.join(dataRoot, LEGACY_OVERRIDES_FILENAME))
    if (stored !== null && stored !== undefined) {
      warnings.push(
        `legacy ${LEGACY_OVERRIDES_FILENAME} read; next write migrates to ${templateOverridesRelativePath()}`
      )
    }
  }
  if (stored === null || stored === undefined) return { overrides: {}, warnings }
  if (typeof stored !== 'object' || Array.isArray(stored)) {
    warnings.push('overrides: expected an object keyed by template id, ignored')
    return { overrides: {}, warnings }
  }
  const overrides: Partial<Record<VideoTemplateId, TemplateOverride>> = {}
  for (const [id, raw] of Object.entries(stored as Record<string, unknown>)) {
    if (!isScriptTemplateId(id)) {
      warnings.push(`${id}: unknown template id, ignored`)
      continue
    }
    const patch = sanitizeOverrideEntry(id, raw, warnings)
    if (patch) overrides[id] = patch
  }
  return { overrides, warnings }
}

function mergeTemplate(base: ScriptPromptTemplate, patch?: TemplateOverride): ScriptPromptTemplate {
  return patch ? ({ ...base, ...patch } as ScriptPromptTemplate) : base
}

function mergeTemplatesWithOverrides(
  overrides?: Partial<Record<VideoTemplateId, Partial<ScriptPromptTemplate>>>
): ScriptPromptTemplate[] {
  if (!overrides) return GITHUB_SCRIPT_TEMPLATES
  return GITHUB_SCRIPT_TEMPLATES.map((base) => mergeTemplate(base, overrides[base.id] as TemplateOverride))
}

/** Merged library + per-item provenance and loader warnings (#134 GET). */
export function listMergedScriptTemplates(
  dataRoot?: string,
  readJson?: (file: string) => any
): { items: ScriptTemplateWithSource[]; warnings: string[] } {
  const { overrides, warnings } = readTemplateOverrides(dataRoot, readJson)
  const items = GITHUB_SCRIPT_TEMPLATES.map((base): ScriptTemplateWithSource => {
    const patch = overrides[base.id]
    return { ...mergeTemplate(base, patch), source: patch ? 'override' : 'default' }
  })
  return { items, warnings }
}

export function getMergedScriptTemplates(
  dataRoot?: string,
  readJson?: (file: string) => any,
  category?: string | null
): ScriptPromptTemplate[] {
  const { items } = listMergedScriptTemplates(dataRoot, readJson)
  const merged: ScriptPromptTemplate[] = items
  const cat = category?.trim()
  if (!cat || cat === 'all' || cat === '全部') return merged
  return merged.filter((t) => t.category === cat || t.id === cat)
}

/**
 * Validates a PUT body: every key must be an editable field and every value
 * must satisfy its type/length/enum rule. Unlike the loader, PUT rejects
 * instead of ignoring, so the caller learns why the write did not happen.
 */
export function validateTemplatePatch(
  raw: unknown
): { ok: true; patch: TemplateOverride } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'body must be a JSON object' }
  }
  const patch: Record<string, OverrideFieldValue> = {}
  for (const [field, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(EDITABLE_TEMPLATE_FIELDS as readonly string[]).includes(field)) {
      return { ok: false, error: `unsupported field: ${field}` }
    }
    const verdict = validateOverrideField(field, value)
    if (!verdict.ok) return { ok: false, error: `${field}: ${verdict.error}` }
    patch[field] = verdict.value
  }
  if (Object.keys(patch).length === 0) {
    return { ok: false, error: 'no editable fields provided' }
  }
  return { ok: true, patch: patch as TemplateOverride }
}

/** Writes one template's patch into the canonical override store (atomic). */
export function saveTemplateOverride(opts: {
  dataRoot: string
  id: VideoTemplateId
  patch: TemplateOverride
  readJson: (file: string) => any
  atomicWriteJson: (file: string, value: unknown) => void
}): ScriptTemplateWithSource {
  const { overrides } = readTemplateOverrides(opts.dataRoot, opts.readJson)
  const patch: TemplateOverride = { ...overrides[opts.id], ...opts.patch }
  const next: Partial<Record<VideoTemplateId, TemplateOverride>> = { ...overrides, [opts.id]: patch }
  opts.atomicWriteJson(templateOverridesFile(opts.dataRoot), next)
  const base = GITHUB_SCRIPT_TEMPLATES.find((t) => t.id === opts.id) ?? GITHUB_SCRIPT_TEMPLATES[0]
  return { ...mergeTemplate(base, patch), source: 'override' }
}

/** Deletes one override (canonical store) so the built-in default applies. */
export function removeTemplateOverride(opts: {
  dataRoot: string
  id: VideoTemplateId
  readJson: (file: string) => any
  atomicWriteJson: (file: string, value: unknown) => void
}): { item: ScriptTemplateWithSource; removed: boolean } {
  const { overrides } = readTemplateOverrides(opts.dataRoot, opts.readJson)
  const removed = Boolean(overrides[opts.id])
  if (removed) {
    const next: Partial<Record<VideoTemplateId, TemplateOverride>> = { ...overrides }
    delete next[opts.id]
    opts.atomicWriteJson(templateOverridesFile(opts.dataRoot), next)
  }
  const base = GITHUB_SCRIPT_TEMPLATES.find((t) => t.id === opts.id) ?? GITHUB_SCRIPT_TEMPLATES[0]
  return { item: { ...base, source: 'default' }, removed }
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
      const overridesFile = templateOverridesFile(opts.dataRoot)
      const existing = opts.readJson ? readTemplateOverrides(opts.dataRoot, opts.readJson).overrides : {}
      opts.atomicWriteJson(overridesFile, { ...existing, ...overrides })
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
      const overridesFile = templateOverridesFile(opts.dataRoot)
      const existing = opts.readJson ? readTemplateOverrides(opts.dataRoot, opts.readJson).overrides : {}
      opts.atomicWriteJson(overridesFile, { ...existing, ...combinedOverrides })
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
