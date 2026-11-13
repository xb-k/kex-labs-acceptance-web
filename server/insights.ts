/**
 * Read-only data providers for the `/flow`, `/pipeline` (contract) and `/reports`
 * pages (T-WEB-015d1).
 *
 * Everything here is derived from the real kex-labs-video artifacts under
 * `KEX_REPO_ROOT` + `PLAN_FILE`. Missing files degrade to `available:false` /
 * `null` — never to invented values.
 *
 * `flowData`, `contractData` and `weeklyReport` return `{ status, body }`; the
 * router in `api.ts` only forwards that to `sendJson`.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DATA_ROOT, PLAN_FILE, deliveriesData } from './api'
import { dbEnabled, sql } from './db'

// ---------------------------------------------------------------------------
// Small helpers (self-contained: no dependency on api.ts internals)
// ---------------------------------------------------------------------------

type Warn = string[]

const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

const isoOrNull = (v: unknown): string | null => {
  if (typeof v !== 'string' || !v.trim()) return null
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : v
}

export function kexRoot(): string | null {
  const root = process.env.KEX_REPO_ROOT
    ? path.resolve(process.env.KEX_REPO_ROOT)
    : path.join(DATA_ROOT, 'kex-repo')
  try {
    if (!fs.statSync(root).isDirectory()) return null
    fs.accessSync(root, fs.constants.R_OK)
    return root
  } catch {
    return null
  }
}

/** True only when `file`'s realpath lives inside `root` (symlink-safe). */
function insideRoot(root: string, file: string): boolean {
  try {
    const rootReal = fs.realpathSync(root)
    const real = fs.realpathSync(file)
    return real === rootReal || real.startsWith(rootReal + path.sep)
  } catch {
    return false
  }
}

/** Resolve an artifact path (absolute or root-relative) and check it is a file inside root. */
function pathExistsInRoot(root: string, p: unknown): boolean {
  if (typeof p !== 'string' || !p.trim()) return false
  const abs = path.isAbsolute(p) ? p : path.join(root, p)
  if (!insideRoot(root, abs)) return false
  try {
    return fs.statSync(abs).isFile()
  } catch {
    return false
  }
}

const jsonCache = new Map<string, { mtimeMs: number; readAt: number; value: any }>()

/** Read + parse a JSON file, with a 5s/mtime cache and tolerant error handling. */
function readJsonFile(file: string, warnings: Warn): any | null {
  let stat: fs.Stats
  try {
    stat = fs.statSync(file)
  } catch {
    return null
  }
  if (!stat.isFile()) return null
  const cached = jsonCache.get(file)
  if (cached && cached.mtimeMs === stat.mtimeMs && Date.now() - cached.readAt < 5000) {
    return cached.value
  }
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    jsonCache.set(file, { mtimeMs: stat.mtimeMs, readAt: Date.now(), value })
    return value
  } catch {
    warnings.push(`bad json: ${path.relative(DATA_ROOT, file)}`)
    return null
  }
}

/** Read a JSON path resolved against root, rejecting anything outside root. */
function readJsonInsideRoot(root: string, p: string, warnings: Warn): any | null {
  const abs = path.isAbsolute(p) ? p : path.join(root, p)
  if (!insideRoot(root, abs)) return null
  return readJsonFile(abs, warnings)
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function tailLines(file: string, limit: number): string[] {
  const text = readText(file)
  if (text === null) return []
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(-limit)
}

function listFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => {
        try {
          return fs.statSync(path.join(dir, f)).isFile()
        } catch {
          return false
        }
      })
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// /api/flow
// ---------------------------------------------------------------------------

type JobSummary = { id: string; updated_at: string; size: number }

function listJobs(root: string): JobSummary[] {
  const dir = path.join(root, 'state')
  const rows: Array<JobSummary & { mtimeMs: number }> = []
  for (const name of listFiles(dir)) {
    if (!name.endsWith('.json')) continue
    const abs = path.join(dir, name)
    let stat: fs.Stats
    try {
      stat = fs.statSync(abs)
    } catch {
      continue
    }
    rows.push({
      id: name.slice(0, -'.json'.length),
      updated_at: new Date(stat.mtimeMs).toISOString(),
      size: stat.size,
      mtimeMs: stat.mtimeMs
    })
  }
  rows.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return rows.map(({ id, updated_at, size }) => ({ id, updated_at, size }))
}

/** Read one `<dir>/decisions/<job>.jsonl`; bad lines warn instead of aborting. */
function readDecisionLines(dir: string, job: string, warnings: Warn): any[] {
  const file = path.join(dir, 'decisions', `${job}.jsonl`)
  const text = readText(file)
  if (text === null) return []
  const out: any[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      out.push(JSON.parse(trimmed))
    } catch {
      warnings.push(`bad decision line in ${job}.jsonl`)
    }
  }
  return out
}

function decisionAt(value: any): number {
  const raw = typeof value?.at === 'string' ? value.at : null
  const t = raw ? Date.parse(raw) : NaN
  return Number.isNaN(t) ? 0 : t
}

/**
 * #122/#127: merge the read-only `KEX_REPO_ROOT/decisions` log with the web-
 * writable `WEB_DATA_ROOT/decisions` copy. Identical JSON lines are deduped,
 * oldest → newest by `at`, and only the newest 20 survive (same shape as the
 * pre-#122 reader).
 */
export function mergeDecisions(groups: any[][], limit = 20): any[] {
  const seen = new Set<string>()
  const out: any[] = []
  for (const group of groups) {
    for (const decision of group) {
      const key = JSON.stringify(decision)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(decision)
    }
  }
  out.sort((a, b) => decisionAt(a) - decisionAt(b))
  return out.slice(-limit)
}

export function readDecisions(
  root: string,
  job: string,
  warnings: Warn,
  writableRoot: string | null = null
): any[] {
  const dirs = [root]
  if (writableRoot && path.resolve(writableRoot) !== path.resolve(root)) dirs.push(writableRoot)
  return mergeDecisions(dirs.map((dir) => readDecisionLines(dir, job, warnings)))
}

/** Runtime view of `WEB_DATA_ROOT` so tests can point it at a fixture. */
export function decisionsWritableRoot(): string {
  const env = process.env.WEB_DATA_ROOT
  return env ? path.resolve(env) : DATA_ROOT
}

function readReport(
  root: string,
  job: string,
  state: any,
  key: string,
  warnings: Warn
): any | null {
  const v = state?.[key]
  if (v && typeof v === 'object') return v
  if (typeof v === 'string') {
    const fromState = readJsonInsideRoot(root, v, warnings)
    if (fromState !== null) return fromState
  }
  // state paths often point at the original (studio-absolute) location; fall back
  // to the in-repo job directory when available.
  return readJsonInsideRoot(root, path.join('jobs', job, `${key}.json`), warnings)
}

function readLogs(root: string, warnings: Warn) {
  const logDir = process.env.KEX_LOG_DIR
    ? path.resolve(process.env.KEX_LOG_DIR)
    : path.join(os.homedir(), 'Library', 'Logs', 'kexlabs-video')
  const workerFile = path.join(logDir, 'worker-launchd-stdout.log')
  const workerLines = tailLines(workerFile, 200)
  if (workerLines.length === 0 && !fs.existsSync(workerFile)) {
    warnings.push('worker log missing')
  }

  const lockFile = path.join(root, 'state', '.locks', 'events.jsonl')
  const lockEvents: any[] = []
  for (const line of tailLines(lockFile, 50)) {
    try {
      lockEvents.push(JSON.parse(line))
    } catch {
      warnings.push('bad lock event line')
    }
  }

  return { worker: { path: workerFile, lines: workerLines }, lock_events: lockEvents }
}

const MEDIA_KIND: Record<string, 'image' | 'video' | 'audio'> = {
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.webp': 'image',
  '.gif': 'image',
  '.mp4': 'video',
  '.mov': 'video',
  '.webm': 'video',
  '.mkv': 'video',
  '.wav': 'audio',
  '.mp3': 'audio',
  '.m4a': 'audio',
  '.flac': 'audio'
}

/** Root-relative `jobs/...` path usable by `/media/kex`; null when outside the read-only repo. */
function kexRelPath(root: string, p: unknown): string | null {
  if (typeof p !== 'string' || !p.trim()) return null
  const abs = path.isAbsolute(p) ? p : path.join(root, p)
  const rel = path.relative(root, abs)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  const parts = rel.split(path.sep)
  if (parts[0] !== 'jobs') return null
  return parts.join('/')
}

/** One real file recorded in state; `url` is null unless the file is readable under jobs/. */
function stageArtifact(root: string, p: unknown, label: string) {
  if (typeof p !== 'string' || !p.trim()) return null
  const rel = kexRelPath(root, p)
  const exists = pathExistsInRoot(root, p)
  return {
    path: p,
    label,
    kind: MEDIA_KIND[path.extname(p).toLowerCase()] ?? 'file',
    exists,
    rel,
    url: exists && rel ? `/media/kex?path=${encodeURIComponent(rel)}` : null
  }
}

/** Prompt strings that state actually records (clips[].prompt / rendered[].prompt). */
function stagePromptsOf(list: any[], source: string) {
  return list
    .filter((item) => typeof item?.prompt === 'string' && item.prompt.trim())
    .map((item) => ({
      source: `state.${source}[].prompt`,
      shot_id: numOrNull(item?.shot_id),
      text: item.prompt,
      negative: typeof item?.negative === 'string' ? item.negative : null,
      seed: numOrNull(item?.seed)
    }))
}

/**
 * Read the scenario prompt file that `state.profile.prompt.path` points at.
 * Read-only passthrough (#103): never writes, never leaves the repo root.
 */
function profilePromptOf(root: string, profile: any) {
  const source = profile?.prompt
  const raw = typeof source?.path === 'string' ? source.path.trim() : ''
  if (!raw) return null
  const abs = path.isAbsolute(raw) ? raw : path.join(root, raw)
  if (!insideRoot(root, abs)) return null
  const text = readText(abs)
  if (text === null) return null
  return {
    path: raw,
    version: typeof source?.version === 'string' ? source.version : null,
    text: text.slice(0, 4000)
  }
}

function buildJob(root: string, id: string, state: any, warnings: Warn) {
  const stagesRaw: Record<string, any> = state?.stages ?? {}
  const stages = Object.keys(stagesRaw).map((key) => {
    const s = stagesRaw[key] ?? {}
    const toolsRaw: Record<string, any> = s.tools ?? {}
    return {
      key,
      status: s.status ?? null,
      duration_s: numOrNull(s.duration_s),
      updated_at: s.updated_at ?? null,
      tools: Object.keys(toolsRaw).map((name) => {
        const t = toolsRaw[name] ?? {}
        return {
          name,
          status: t.status ?? null,
          duration_ms: numOrNull(t.duration_ms),
          attempts: numOrNull(t.attempts),
          error: t.error ?? null,
          cached: t.cached ?? null,
          skipped: t.skipped ?? null,
          artifact: t.artifact ?? null
        }
      })
    }
  })
  const stagesTotal = stages.reduce<number>((sum, s) => (s.duration_s === null ? sum : sum + s.duration_s), 0)

  const shots = Array.isArray(state?.shots)
    ? state.shots.map((s: any) => ({
        shot_id: s?.shot_id ?? null,
        start: numOrNull(s?.start),
        end: numOrNull(s?.end),
        duration_s: numOrNull(s?.duration_s)
      }))
    : []

  const frames = Array.isArray(state?.frames)
    ? state.frames.map((f: any) => ({
        shot_id: f?.shot_id ?? null,
        frame_ts: numOrNull(f?.frame_ts),
        path: typeof f?.path === 'string' ? f.path : null,
        exists: pathExistsInRoot(root, f?.path)
      }))
    : []

  const artifactsRaw = state?.artifacts
  const artifacts =
    artifactsRaw && typeof artifactsRaw === 'object' && !Array.isArray(artifactsRaw)
      ? Object.values(artifactsRaw)
          .filter((p): p is string => typeof p === 'string')
          .map((p) => ({ path: p, exists: pathExistsInRoot(root, p) }))
      : []

  // Real per-stage outputs recorded in state (no inference: only fields that exist).
  const clips = Array.isArray(state?.clips) ? state.clips : []
  const rendered = Array.isArray(state?.rendered) ? state.rendered : []
  const graded = Array.isArray(state?.graded) ? state.graded : []
  const interpolated = Array.isArray(state?.interpolated) ? state.interpolated : []
  const upscaled = Array.isArray(state?.upscaled) ? state.upscaled : []
  const audio = state?.audio && typeof state.audio === 'object' ? state.audio : {}

  const stageOutputs: Record<string, Array<{ path: unknown; label: string }>> = {
    B: frames.map((f: any) => ({ path: f.path, label: '抽帧' })),
    C: rendered.map((r: any) => ({ path: r?.output, label: '关键帧' })),
    D: clips.map((c: any) => ({ path: c?.output, label: '片段' })),
    E: [
      ...graded.map((g: any) => ({ path: g?.output, label: '调色' })),
      ...interpolated.map((i: any) => ({ path: i?.output, label: '插帧' })),
      ...upscaled.map((u: any) => ({ path: u?.output, label: '超分' }))
    ],
    F: [
      ...(audio.mix ? [{ path: audio.mix, label: '混音' }] : []),
      ...(audio.narration ? [{ path: audio.narration, label: '旁白' }] : []),
      ...(audio.bgm ? [{ path: audio.bgm, label: 'BGM' }] : [])
    ]
  }
  const stagePrompts: Record<string, ReturnType<typeof stagePromptsOf>> = {
    C: stagePromptsOf(rendered, 'rendered'),
    D: stagePromptsOf(clips, 'clips')
  }

  const stagesWithMedia = stages.map((stage) => {
    const seen = new Set<string>()
    const media: any[] = []
    const add = (item: ReturnType<typeof stageArtifact>) => {
      if (!item || seen.has(item.path)) return
      seen.add(item.path)
      media.push(item)
    }
    for (const tool of stage.tools) add(stageArtifact(root, tool.artifact, '工具产物'))
    for (const output of stageOutputs[stage.key] ?? []) add(stageArtifact(root, output.path, output.label))
    return { ...stage, artifacts: media, prompts: stagePrompts[stage.key] ?? [] }
  })

  return {
    id,
    stage: state?.stage ?? null,
    updated_at: state?.updated_at ?? null,
    duration_s: stages.length ? Math.round(stagesTotal * 1000) / 1000 : null,
    stages: stagesWithMedia,
    shots,
    frames,
    semantics: state?.semantics ?? null,
    shot_semantics: state?.shot_semantics ?? null,
    profile: state?.profile ?? null,
    /** #103：只读透传 profile.prompt.path 指向的场景 prompt 正文（缺失为 null）。 */
    profile_prompt: profilePromptOf(root, state?.profile),
    probe: state?.probe ?? null,
    cold_warm: state?.cold_warm ?? null,
    quality: state?.quality ?? null,
    quality_gate: state?.quality_gate ?? null,
    artifacts,
    decisions: readDecisions(root, id, warnings, decisionsWritableRoot()),
    reports: {
      render: readReport(root, id, state, 'render_report', warnings),
      assemble: readReport(root, id, state, 'assemble_report', warnings),
      interpolate: readReport(root, id, state, 'interpolate_report', warnings)
    }
  }
}

export async function flowData(url: URL): Promise<{ status: number; body: any }> {
  const root = kexRoot()
  if (!root) {
    return { status: 200, body: { available: false, reason: 'kex repo not configured' } }
  }

  const warnings: Warn = []
  const jobs = listJobs(root)
  const meta = { root, generated_at: new Date().toISOString(), warnings }
  const logs = readLogs(root, warnings)
  const requested = (url.searchParams.get('job') ?? '').trim()

  if (requested === 'b-track-s1') {
    return {
      status: 200,
      body: {
        available: true,
        jobs,
        job: null,
        reason: 'no_orchestrator_state',
        message: 'B 轨走独立增强链，无编排 state',
        logs,
        meta
      }
    }
  }

  if (requested && !jobs.some((j) => j.id === requested)) {
    return { status: 404, body: { error: 'job not found' } }
  }

  const jobId = requested || jobs[0]?.id || null
  if (!jobId) {
    return {
      status: 200,
      body: {
        available: true,
        jobs: [],
        job: null,
        reason: 'no_state_files',
        message: 'state/ 下没有 job',
        logs,
        meta
      }
    }
  }

  const state = readJsonFile(path.join(root, 'state', `${jobId}.json`), warnings)
  if (state === null) {
    return { status: 200, body: { available: true, jobs, job: null, reason: 'no_state_files', message: 'state 文件不可读', logs, meta } }
  }

  return { status: 200, body: { available: true, jobs, job: buildJob(root, jobId, state, warnings), logs, meta } }
}

// ---------------------------------------------------------------------------
// /api/contract
// ---------------------------------------------------------------------------

const GATE_KEYS = ['A1', 'A2', 'B1', 'B2', 'B3', 'B4', 'B5']

function readGate(root: string) {
  const dir = path.join(root, 'docs', 'plan')
  const candidates = listFiles(dir)
    .filter((f) => /dual-track/i.test(f) && f.endsWith('.md'))
    .map((f) => {
      const abs = path.join(dir, f)
      return { abs, mtime: fs.statSync(abs).mtimeMs }
    })
    .sort((a, b) => b.mtime - a.mtime)

  if (!candidates.length) return { source: null, updated_at: null, items: [] }

  const file = candidates[0].abs
  const text = readText(file) ?? ''
  const items: Array<{ key: string; name: string; threshold: string | null; source_line: string }> = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('|')) continue
    if (!GATE_KEYS.some((k) => line.includes(k))) continue
    if (!/[≥≤><]/.test(line)) continue
    const cells = line.split('|').map((c) => c.trim())
    const key = cells[1]?.replace(/\*/g, '') ?? ''
    if (!GATE_KEYS.includes(key)) continue
    const name = (cells[2] ?? '').replace(/\*\*/g, '').trim()
    const criteria = cells.slice(3).join(' ').replace(/\*\*/g, '')
    const m = /([≥≤><])\s*([0-9]+(?:\.[0-9]+)?(?:e-?[0-9]+)?)\s*(%|[A-Za-z×]*)/.exec(criteria)
    const threshold = m ? `${m[1]}${m[2]}${m[3] ?? ''}` : null
    items.push({ key, name, threshold, source_line: line })
  }
  return { source: path.relative(root, file), updated_at: new Date(candidates[0].mtime).toISOString(), items }
}

export function readThresholds(root: string, warnings: Warn) {
  const data = readJsonFile(path.join(root, 'policy', 'quality_thresholds.json'), warnings)
  const checks: Record<string, any> = data?.checks ?? {}
  // #97a: expose name/hard so `/api/qc/*` can use the same 7 hard checks; the
  // numeric threshold is passed through untouched (no re-calibration here).
  const items = Object.keys(checks)
    .filter((key) => checks[key]?.hard === true)
    .map((key) => {
      const c = checks[key] ?? {}
      return {
        key,
        label: typeof c.label === 'string' ? c.label : key,
        op: c.op ?? null,
        value: numOrNull(c.threshold),
        unit: c.unit ?? null,
        hard: true
      }
    })
  return { source: 'policy/quality_thresholds.json', items }
}

type WorkflowNode = { id: string; class_type: string; inputs: Record<string, unknown> }
type WorkflowLink = { from: string; from_slot: number; to: string; to_input: string }
type WorkflowCatalogItem = {
  name: string
  source: string
  node_count: number
  link_count: number
  primary: boolean
}

/**
 * Reverse-engineer nodes/links from a ComfyUI API-format workflow (T-WEB-080).
 * Pure read-only: nodes keep file insertion order, links only come from
 * `[nodeId, slot]` input values; unknown shapes are ignored, never invented.
 */
function parseWorkflowDoc(doc: any): { nodes: WorkflowNode[]; links: WorkflowLink[] } {
  const nodes: WorkflowNode[] = []
  const links: WorkflowLink[] = []
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { nodes, links }

  for (const [rawId, rawNode] of Object.entries(doc)) {
    if (!rawNode || typeof rawNode !== 'object' || Array.isArray(rawNode)) continue
    const node = rawNode as Record<string, unknown>
    if (typeof node.class_type !== 'string') continue
    const inputs =
      node.inputs && typeof node.inputs === 'object' && !Array.isArray(node.inputs)
        ? (node.inputs as Record<string, unknown>)
        : {}
    const id = String(rawId)
    nodes.push({ id, class_type: node.class_type, inputs })
    for (const [toInput, value] of Object.entries(inputs)) {
      if (
        Array.isArray(value) &&
        value.length === 2 &&
        (typeof value[0] === 'string' || typeof value[0] === 'number') &&
        typeof value[1] === 'number'
      ) {
        links.push({ from: String(value[0]), from_slot: value[1], to: id, to_input: toInput })
      }
    }
  }

  // Keep only edges whose endpoints are real nodes: ComfyUI inputs also carry
  // literal arrays (e.g. `[512, 768]`), which must never become links.
  const knownIds = new Set(nodes.map((n) => n.id))
  const resolvedLinks = links.filter((l) => knownIds.has(l.from) && knownIds.has(l.to))

  const cmpId = (a: string, b: string) => {
    const na = Number(a)
    const nb = Number(b)
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb
    return a < b ? -1 : a > b ? 1 : 0
  }
  resolvedLinks.sort(
    (a, b) =>
      cmpId(a.from, b.from) ||
      cmpId(a.to, b.to) ||
      a.to_input.localeCompare(b.to_input) ||
      a.from_slot - b.from_slot
  )
  return { nodes, links: resolvedLinks }
}

const WORKFLOW_CATALOG_MAX_DEPTH = 2
const WORKFLOW_CATALOG_MAX_BYTES = 64 * 1024
const WORKFLOW_CATALOG_MAX_FILES = 200
const WORKFLOW_CATALOG_MAX_TOTAL_BYTES = 2 * 1024 * 1024

/** Catalog (`workflows/` ≤2 levels, `*.json`): counts only, never graph data. */
function readWorkflowCatalog(root: string, warnings: Warn, primaryFile: string): WorkflowCatalogItem[] {
  const base = path.join(root, 'workflows')
  // `workflows/` itself must resolve inside the repo root (a symlink to the
  // outside is never followed); missing dir stays a silent empty catalog.
  let baseExists = false
  try {
    baseExists = fs.statSync(base).isDirectory()
  } catch {
    baseExists = false
  }
  if (!baseExists) return []
  if (!insideRoot(root, base)) {
    warnings.push('workflow catalog: workflows dir outside repo root')
    return []
  }

  const files: string[] = []
  let filesTruncated = false
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (files.length >= WORKFLOW_CATALOG_MAX_FILES) {
        if (!filesTruncated) {
          filesTruncated = true
          warnings.push(`workflow catalog: truncated at ${WORKFLOW_CATALOG_MAX_FILES} files`)
        }
        return
      }
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth < WORKFLOW_CATALOG_MAX_DEPTH) walk(abs, depth + 1)
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        files.push(abs)
      }
    }
  }
  walk(base, 1)

  const items: WorkflowCatalogItem[] = []
  let totalBytes = 0
  let totalBudgetHit = false
  for (const abs of files) {
    const source = path.relative(root, abs).split(path.sep).join('/')
    let size = 0
    try {
      size = fs.statSync(abs).size
    } catch {
      continue
    }
    if (size > WORKFLOW_CATALOG_MAX_BYTES) {
      warnings.push(`workflow catalog: skipped ${source} (${size} bytes > 64KB)`)
      continue
    }
    if (totalBytes + size > WORKFLOW_CATALOG_MAX_TOTAL_BYTES) {
      if (!totalBudgetHit) {
        totalBudgetHit = true
        warnings.push(`workflow catalog: skipped remaining files (catalog > 2MB)`)
      }
      continue
    }
    totalBytes += size
    const { nodes, links } = parseWorkflowDoc(readJsonFile(abs, warnings))
    items.push({
      name: path.basename(abs, '.json'),
      source,
      node_count: nodes.length,
      link_count: links.length,
      primary: path.resolve(abs) === path.resolve(primaryFile)
    })
  }
  items.sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0))
  return items
}

function readWorkflow(root: string, warnings: Warn) {
  const file = path.join(root, 'workflows', 'ltxv_i2v_v1.json')
  let hasFile = false
  try {
    hasFile = fs.statSync(file).isFile()
  } catch {
    hasFile = false
  }
  // A symlink resolving outside the repo root is treated as missing (never read).
  const outsideRepoRoot = hasFile && !insideRoot(root, file)
  if (outsideRepoRoot) hasFile = false
  // One read → one Buffer: sha256 and JSON.parse see exactly the same bytes.
  let sha256: string | null = null
  let w: any = null
  if (hasFile) {
    try {
      const buf = fs.readFileSync(file)
      sha256 = createHash('sha256').update(buf).digest('hex')
      try {
        w = JSON.parse(buf.toString('utf8'))
      } catch {
        warnings.push(`bad json: ${path.relative(DATA_ROOT, file)}`)
        w = null
      }
    } catch {
      sha256 = null
      w = null
    }
  }

  const parsed = parseWorkflowDoc(w)
  const available = hasFile && w !== null && parsed.nodes.length > 0
  const reason = available
    ? null
    : !hasFile
      ? outsideRepoRoot
        ? 'workflow file outside repo root'
        : 'workflow file missing'
        : w === null
          ? 'workflow json invalid'
          : 'workflow has no nodes'
  const nodes = available ? parsed.nodes : []
  const links = available ? parsed.links : []
  const p = (node: string): Record<string, unknown> => {
    const n = w?.[node]
    return n &&
      typeof n === 'object' &&
      !Array.isArray(n) &&
      n.inputs &&
      typeof n.inputs === 'object' &&
      !Array.isArray(n.inputs)
      ? (n.inputs as Record<string, unknown>)
      : {}
  }
  // params only accept number/string scalars; arrays/objects are never coerced.
  const scalarNum = (v: unknown): number | null =>
    typeof v === 'number' || typeof v === 'string' ? numOrNull(v) : null
  const scalarStr = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() ? v : null
  const p1 = p('1')
  const p5 = p('5')
  const p7 = p('7')
  const p8 = p('8')
  const p10 = p('10')
  return {
    available,
    reason,
    source: 'workflows/ltxv_i2v_v1.json',
    name: 'ltxv_i2v_v1',
    sha256,
    params: {
      width: scalarNum(p7.width),
      height: scalarNum(p7.height),
      length: scalarNum(p7.length),
      fps: scalarNum(p5.frame_rate ?? p10.fps),
      cfg: scalarNum(p8.cfg),
      steps: scalarNum(p8.steps),
      denoise: scalarNum(p8.denoise),
      seed: scalarNum(p8.seed),
      sampler: scalarStr(p8.sampler_name) ?? scalarStr(p8.sampler),
      scheduler: scalarStr(p8.scheduler),
      ckpt: scalarStr(p1.ckpt_name)
    },
    cutoff: null,
    nodes,
    links,
    stats: {
      node_count: nodes.length,
      link_count: links.length,
      classes: [...new Set(nodes.map((n) => n.class_type))].sort()
    },
    catalog: readWorkflowCatalog(root, warnings, file)
  }
}

function readRecent(root: string, warnings: Warn) {
  const dir = path.join(root, 'reports')
  const files = listFiles(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const abs = path.join(dir, f)
      return { abs, mtime: fs.statSync(abs).mtimeMs }
    })
    .sort((a, b) => b.mtime - a.mtime)
  if (!files.length) return null

  const report = readJsonFile(files[0].abs, warnings) ?? {}
  const job = report?.job_id ?? files[0].abs.slice(files[0].abs.lastIndexOf(path.sep) + 1, -'.json'.length)
  const state = job ? readJsonFile(path.join(root, 'state', `${job}.json`), warnings) : null
  const probe = state?.probe ?? report?.probe ?? null

  const rr = job ? readJsonFile(path.join(root, 'jobs', job, 'render_report.json'), warnings) : null
  const renderReport = rr?.memory ? { memory: rr.memory } : null

  return {
    job,
    probe,
    render_report: renderReport,
    assemble_report: report?.assemble_report ?? null
  }
}

function readQueue(root: string) {
  const base = path.join(root, 'jobs')
  const read = (sub: string) => listFiles(path.join(base, sub))
  const inbox = read('inbox')
  return {
    inbox,
    // `inbox` holds jobs waiting to run; expose them as `pending` too so the
    // /pipeline panel has the full frozen shape.
    pending: [...inbox],
    done: read('inbox-done'),
    failed: read('inbox-failed'),
    rejected: read('inbox-rejected'),
    running: read('inbox-running')
  }
}

export async function contractData(): Promise<{ status: number; body: any }> {
  const root = kexRoot()
  if (!root) {
    return { status: 200, body: { available: false, reason: 'kex repo not configured' } }
  }
  const warnings: Warn = []
  return {
    status: 200,
    body: {
      available: true,
      gate: readGate(root),
      thresholds: readThresholds(root, warnings),
      workflow: readWorkflow(root, warnings),
      recent: readRecent(root, warnings),
      queue: readQueue(root),
      meta: { root, generated_at: new Date().toISOString(), warnings }
    }
  }
}

// ---------------------------------------------------------------------------
// /api/reports/weekly
// ---------------------------------------------------------------------------

async function dbTry<T>(fn: (db: any) => Promise<T>): Promise<T | null> {
  if (!sql) return null
  try {
    return await fn(sql)
  } catch (err) {
    console.error('[insights db] query failed:', err instanceof Error ? err.message : err)
    return null
  }
}

const DAY_MS = 86_400_000

async function computeBurndown(days: number) {
  const rows = (await dbTry(
    (db) =>
      db`select created_at, payload from acceptance.snapshots where kind = 'tasks_plan' and created_at >= now() - ${days} * interval '1 day' order by created_at asc`
  )) as any[] | null
  if (!rows || rows.length < 2) return { burndown: null, velocity: null }

  const now = Date.now()
  const from = now - days * DAY_MS
  const buckets = new Map<string, any>()
  for (const row of rows) {
    const created = new Date(row.created_at).getTime()
    if (Number.isNaN(created)) continue
    const day = new Date(created).toISOString().slice(0, 10)
    buckets.set(day, row) // later snapshot wins for the same day
  }
  const burndown = [...buckets.entries()]
    .map(([date, row]) => {
      const tasks: any[] = Array.isArray(row?.payload?.tasks) ? row.payload.tasks : []
      const done = tasks.filter((t) => t?.status === 'done').length
      return { date, remaining: tasks.length - done, done }
    })
    .sort((a, b) => a.date.localeCompare(b.date))

  if (!burndown.length) return { burndown: null, velocity: null }
  const last = burndown[burndown.length - 1]
  const spanDays = Math.max(1, Math.round((now - from) / DAY_MS))
  return {
    burndown,
    velocity: { completed_per_day: Math.round((last.done / spanDays) * 100) / 100 }
  }
}

export async function weeklyReport(
  days: number,
  taskList?: any[] | null
): Promise<{ status: number; body: any }> {
  const d = Number.isFinite(days) && days > 0 ? Math.floor(days) : 7
  const warnings: Warn = []
  const plan = readJsonFile(PLAN_FILE, warnings)
  // `null` = the caller's task source is unreachable → never fall back to the
  // local plan file (that would show stale tasks as current). `undefined` keeps
  // the old file-based behaviour for direct callers.
  const tasks: any[] | null = Array.isArray(taskList)
    ? taskList
    : taskList === null
      ? null
      : Array.isArray(plan?.tasks)
        ? plan.tasks
        : null
  if (!tasks) {
    return {
      status: 200,
      body: {
        available: false,
        reason: taskList === null ? 'task source unavailable' : 'plan file missing'
      }
    }
  }
  const countBy = (status: string) => tasks.filter((t) => t?.status === status).length
  const total = tasks.length
  const done = countBy('done')

  let deliveryCount = 0
  let repaired = 0
  try {
    const { deliveries } = await deliveriesData()
    deliveryCount = deliveries.length
    repaired = deliveries.filter((x: any) => x?.repair?.repaired).length
  } catch (err) {
    warnings.push(`deliveries unavailable: ${err instanceof Error ? err.message : 'error'}`)
  }

  const now = Date.now()
  const endOf = (t: any): string | null => isoOrNull(t?.end ?? t?.end_ts ?? t?.endTs)

  const deviations = tasks
    .filter((t) => t?.status !== 'done' && endOf(t) && Date.parse(endOf(t) as string) < now)
    .map((t) => {
      const end = endOf(t) as string
      return {
        task_id: t.id,
        title: t.title ?? null,
        owner: t.owner ?? null,
        status: t.status ?? null,
        end_ts: end,
        overdue_days: Math.floor((now - Date.parse(end)) / DAY_MS),
        progress: numOrNull(t.progress)
      }
    })

  const risks = [
    ...tasks
      .filter((t) => t?.status === 'blocked')
      .map((t) => ({
        level: 'blocked',
        task_id: t.id,
        text: `${t.title ?? t.id}（阻塞：${t.blocked_by ?? '原因未记录'}）`
      })),
    ...deviations.map((v) => ({
      level: 'overdue',
      task_id: v.task_id,
      text: `${v.title ?? v.task_id} 已超期 ${v.overdue_days} 天（end ${v.end_ts}）`
    }))
  ]

  let burndown: any = null
  let velocity: any = null
  let note = '无历史快照（DB 未启用）'
  if (dbEnabled()) {
    try {
      const computed = await computeBurndown(d)
      burndown = computed.burndown
      velocity = computed.velocity
      note = burndown ? '来自 acceptance.snapshots' : '历史快照不足（无法生成燃尽）'
    } catch {
      note = '历史快照读取失败（无法生成燃尽）'
    }
  }

  return {
    status: 200,
    body: {
      available: true,
      period: {
        from: new Date(now - d * DAY_MS).toISOString(),
        to: new Date(now).toISOString(),
        days: d
      },
      summary: {
        tasks: {
          total,
          done,
          running: countBy('running'),
          pending: countBy('pending'),
          blocked: countBy('blocked')
        },
        completion_rate: total ? Math.round((done / total) * 1000) / 1000 : 0,
        deliveries: { count: deliveryCount, repaired }
      },
      burndown,
      deviations,
      risks,
      milestones: Array.isArray(plan.milestones) ? plan.milestones : [],
      velocity,
      meta: { source: burndown ? 'postgres' : 'files', note }
    }
  }
}

// ---------------------------------------------------------------------------
// /media/kex
// ---------------------------------------------------------------------------

const KEX_MEDIA_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.mp4'])

export function resolveKexMedia(url: URL): { status: number; file?: string; error?: string } {
  const root = kexRoot()
  if (!root) return { status: 404, error: 'kex repo not configured' }
  const raw = url.searchParams.get('path')
  if (!raw || !raw.trim()) return { status: 400, error: 'path query parameter is required' }
  if (path.isAbsolute(raw) || raw.includes('\0')) return { status: 400, error: 'invalid path' }

  const abs = path.resolve(root, raw)
  const relToRoot = path.relative(root, abs)
  if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
    return { status: 403, error: 'path outside kex repo' }
  }
  if (relToRoot.split(path.sep)[0] !== 'jobs') {
    return { status: 403, error: 'only jobs/ media is served' }
  }
  if (!KEX_MEDIA_EXT.has(path.extname(abs).toLowerCase())) {
    return { status: 400, error: 'unsupported media type' }
  }

  let target: string
  try {
    target = fs.realpathSync(abs)
  } catch {
    return { status: 404, error: 'media not found' }
  }
  if (!insideRoot(root, target)) return { status: 403, error: 'path outside kex repo' }
  try {
    if (!fs.statSync(target).isFile()) return { status: 404, error: 'media not found' }
  } catch {
    return { status: 404, error: 'media not found' }
  }
  return { status: 200, file: target }
}
