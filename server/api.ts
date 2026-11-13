/**
 * Light backend for the acceptance UI.
 *
 * Everything it serves is read from real artifacts under the acceptance repo:
 *   issue-19/b-track-<id>/ (summary*.json, report.md, out/*.mp4, metrics csv)
 *   IMG_3189.MOV
 * No fixture data lives here — missing files surface as "无数据" in the UI.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import os from 'node:os'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Connect, Plugin } from 'vite'
import { dbEnabled, sql } from './db'
import { insertEvent, upsertTasksAndMilestones, writeSnapshot } from './db-ops'
import { flowData, contractData, weeklyReport, resolveKexMedia } from './insights'
import {
  GiteaError,
  addIssueComment as giteaAddIssueComment,
  createIssue as giteaCreateIssue,
  giteaConfigured,
  giteaInfo,
  issueComments as giteaIssueComments,
  issueDetail as giteaIssueDetail,
  issueSummary as giteaIssueSummary,
  listAllIssues as giteaListAllIssues,
  listTaskIssues as giteaListTaskIssues,
  reconcileTaskIssues as giteaReconcileTasks,
  sortTaskItems,
  taskItem as giteaTaskItem,
  updateTaskIssue as giteaUpdateTaskIssue
} from './gitea'
import type { GiteaIssueState, TaskItem, TaskPatch } from './gitea'
import {
  auditTaskCards,
  classifyIssueCounts,
  isAcceptanceTaskCard,
  manualVerifyForKey,
  normalizeVerifyKey,
  normalizeVerifyState,
  readManualVerify,
  setManualVerify,
  verifyKeyForIssue,
  verifyRank,
  type ManualVerifyState,
  type ManualVerifyStore
} from './manual-verify'
import {
  buildStudioJob,
  fetchStudioArtifactJson,
  fetchStudioJobDetail,
  handleStudioRoute,
  studioArtifactReadable,
  type Job as StudioJob,
  type StudioContext
} from './studio'
import { handleAgentsRoute } from './agents'
import { handleUploadsRoute } from './uploads'
import {
  createRiskDecision,
  listRiskDecisions,
  RiskDecisionError,
  validateRiskDecision,
  type AddRiskComment,
  type RiskTask
} from './risk-decisions'
import { buildSnapshot, bTrackProjection, isSafeJobId, judgeRule, policyRules } from './snapshot'

const DATA_ROOT = process.env.WEB_DATA_ROOT
  ? path.resolve(process.env.WEB_DATA_ROOT)
  : path.resolve(process.cwd(), '..')

const ORIGINAL_VIDEO = path.join(DATA_ROOT, 'IMG_3189.MOV')

/** `UPLOAD_MAX_BYTES` overrides the 2GiB cap (tests use a small value). */
const UPLOAD_MAX_BYTES = (() => {
  const raw = Number(process.env.UPLOAD_MAX_BYTES)
  return Number.isSafeInteger(raw) && raw > 0 ? raw : 2 * 1024 * 1024 * 1024
})()

/** Live project status board, maintained by the orchestrator (not by this UI). */
export const STATUS_FILE = process.env.WEB_STATUS_FILE
  ? path.resolve(process.env.WEB_STATUS_FILE)
  : path.join(DATA_ROOT, '.opencode', 'state', 'project-status.json')

/** Task plan (milestones + every task with start/end), maintained by the orchestrator. */
export const PLAN_FILE = process.env.WEB_PLAN_FILE
  ? path.resolve(process.env.WEB_PLAN_FILE)
  : path.join(DATA_ROOT, '.opencode', 'state', 'tasks.json')

/**
 * Manual-verification overlay (issue #77): `<DATA_ROOT>/manual-verify.json`
 * (mounted `/data` in the container), overridable for tests.
 */
const MANUAL_VERIFY_FILE = process.env.WEB_MANUAL_VERIFY_FILE
  ? path.resolve(process.env.WEB_MANUAL_VERIFY_FILE)
  : path.join(DATA_ROOT, 'manual-verify.json')

/** Issue backlog root (`issue-N/` cards): defaults to the data root. */
const ISSUE_ROOT = process.env.WEB_ISSUE_ROOT
  ? path.resolve(process.env.WEB_ISSUE_ROOT)
  : DATA_ROOT

/** `WEB_ISSUE_WRITE=0|false|off` turns the create endpoint into 403. */
const ISSUE_WRITE_DISABLED = ['0', 'false', 'off'].includes(
  (process.env.WEB_ISSUE_WRITE ?? '').trim().toLowerCase()
)

/** `WEB_ISSUE_TOKEN` (when set) is required verbatim in `X-Web-Token` for writes. */
const ISSUE_TOKEN = process.env.WEB_ISSUE_TOKEN || null

/**
 * Issue backlog source: `gitea` (default, see `gitea.ts`) or `files` (explicit
 * fallback scanning `WEB_ISSUE_ROOT`). Anything else falls back to Gitea.
 */
const ISSUES_SOURCE = (process.env.WEB_ISSUES_SOURCE ?? 'gitea').trim().toLowerCase()
const ISSUES_FROM_FILES = ISSUES_SOURCE === 'files'

/**
 * Task source for `/api/plan`, `/api/overview`, `/api/reports/weekly` and
 * `PATCH /api/tasks/:id`: `gitea` (default, task issues — see `gitea.ts`) or
 * `files` (explicit fallback to `PLAN_FILE`). Anything else means Gitea.
 */
const TASKS_SOURCE = (process.env.WEB_TASKS_SOURCE ?? 'gitea').trim().toLowerCase()
const TASKS_FROM_FILES = TASKS_SOURCE === 'files'

export type Criterion = {
  key: string
  name: string
  value: string
  threshold: string
  pass: boolean | null
  explain: string
  source: string
}

export type JobListItem = {
  id: string
  track: string
  taskId: string
  title: string
  /** #102: studio job type / rail, used by the readable job label. */
  type?: string | null
  rail?: string | null
  status: 'PASS' | 'FAIL' | 'CONDITIONAL' | 'UNKNOWN'
  /** #97a: same snapshot projection as `/api/snapshot` (optional for DB rows). */
  stage?: string | null
  verdict?: 'PASS' | 'FAIL' | 'CONDITIONAL' | 'UNKNOWN'
  statusLabel: string
  statusNote: string
  passed: number
  total: number
  judged: number
  durationS: number | null
  fps: number | null
  width: number | null
  height: number | null
  frames: number | null
  sourceStart: number
  hasQc: boolean
  media: {
    original: string | null
    output: string | null
    poster: string | null
    posterOriginal: string | null
  }
  summaryPath: string
  reportPath: string | null
  metricsPath: string | null
  /** #89d: studio cover / keyframe read-back (undefined for repo-only rows). */
  cover_asset?: { source_job: string; name: string; url: string | null } | null
  cover_url?: string | null
  keyframe_asset?: { source_job: string; name: string } | null
  keyframe_source?: string | null
}

/**
 * #97e (contract I2): `/api/jobs` rows must expose the same `(status, stage, verdict)`
 * as `/api/snapshot`. `status` is the normalized run state; the legacy gate value
 * stays available as `gateStatus`.
 */
export function toJobListItem(item: JobListItem) {
  const gateStatus = item.status
  const verdict = item.verdict ?? (item.track === 'B' ? item.status : 'UNKNOWN')
  if (item.track !== 'B') {
    return { ...item, stage: item.stage ?? null, verdict, gateStatus }
  }
  const projection = bTrackProjection(verdict, item.status)
  return {
    ...item,
    status: projection.status,
    stage: item.stage ?? projection.stage,
    verdict: projection.verdict ?? verdict,
    gateStatus
  }
}

export type JobDetail = {
  job: JobListItem
  sourceMeta: {
    label: string
    durationS: number | null
    frames: number | null
    fps: number | null
    width: number | null
    height: number | null
    bytes: number | null
    path: string
  } | null
  criteria: Criterion[]
  pipeline: {
    source: string | null
    l1Mode: string | null
    chain: string | null
    clip: Record<string, unknown> | null
    chainSteps: Record<string, number> | null
    chainTotalS: number | null
    look: unknown
  }
  dataSources: { label: string; path: string; exists: boolean }[]
  notes: string[]
  /** #86b2: studio optimize jobs expose B1/B2 gate rows read from intake. */
  bMetrics?: BMetrics | null
}

export type BMetricCheck = {
  key: string
  label: string
  group: 'B1' | 'B2' | 'B3' | '输出'
  value: number | null
  threshold: number | null
  op: string | null
  pass: boolean | null
  hard: boolean | null
  source: string
}

export type BMetrics = {
  verdict: 'PASS' | 'FAIL' | 'CONDITIONAL' | 'UNKNOWN'
  status: string | null
  checks: BMetricCheck[]
  failed: string[]
  positives: string[]
  positiveCount: number | null
  fpsIn: number | null
  fpsOut: number | null
  generatedAt: string | null
  source: string
  error: string | null
}

type Probe = {
  width: number | null
  height: number | null
  fps: number | null
  frames: number | null
  durationS: number | null
  codec: string | null
  pixFmt: string | null
  colorspace: string | null
  bitrateMbps: number | null
  bytes: number | null
}

const probeCache = new Map<string, { mtimeMs: number; probe: Probe | null }>()

function fractionRate(rate: string | undefined): number | null {
  if (!rate) return null
  const [a, b] = rate.split('/').map(Number)
  if (!Number.isFinite(a)) return null
  if (!b || !Number.isFinite(b)) return a
  return a / b
}

/** Real video metadata via ffprobe; null when the binary is unavailable. */
function probeVideo(file: string): Probe | null {
  if (!exists(file)) return null
  const stat = fs.statSync(file)
  const cached = probeCache.get(file)
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.probe
  try {
    const raw = execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=width,height,r_frame_rate,nb_frames,duration,codec_name,pix_fmt,color_space',
        '-show_entries',
        'format=duration,size,bit_rate',
        '-of',
        'json',
        file
      ],
      { encoding: 'utf8', timeout: 8000 }
    )
    const parsed = JSON.parse(raw) as {
      streams?: Record<string, unknown>[]
      format?: Record<string, unknown>
    }
    const stream = parsed.streams?.[0] ?? {}
    const format = parsed.format ?? {}
    const numberOrNull = (v: unknown) => {
      const n = Number(v)
      return Number.isFinite(n) ? n : null
    }
    const probe: Probe = {
      width: numberOrNull(stream.width),
      height: numberOrNull(stream.height),
      fps: fractionRate(typeof stream.r_frame_rate === 'string' ? stream.r_frame_rate : undefined),
      frames: numberOrNull(stream.nb_frames),
      durationS: numberOrNull(stream.duration) ?? numberOrNull(format.duration),
      codec: typeof stream.codec_name === 'string' ? stream.codec_name : null,
      pixFmt: typeof stream.pix_fmt === 'string' ? stream.pix_fmt : null,
      colorspace: typeof stream.color_space === 'string' ? stream.color_space : null,
      bitrateMbps:
        numberOrNull(format.bit_rate) != null ? Number(numberOrNull(format.bit_rate)) / 1_000_000 : null,
      bytes: numberOrNull(format.size) ?? stat.size
    }
    probeCache.set(file, { mtimeMs: stat.mtimeMs, probe })
    return probe
  } catch {
    probeCache.set(file, { mtimeMs: stat.mtimeMs, probe: null })
    return null
  }
}

const POSTER_DIR = path.join(os.tmpdir(), 'acceptance-web-posters')

/** Extract a real frame from a video for card/detail posters (cached in tmp). */
function makePoster(videoFile: string | null, key: string, atSeconds: number): string | null {
  if (!videoFile || !exists(videoFile)) return null
  const stat = fs.statSync(videoFile)
  const out = path.join(POSTER_DIR, `${key}-${Math.round(stat.mtimeMs)}-${atSeconds.toFixed(2)}.png`)
  if (exists(out)) return out
  try {
    fs.mkdirSync(POSTER_DIR, { recursive: true })
    execFileSync(
      'ffmpeg',
      ['-v', 'error', '-ss', String(atSeconds), '-i', videoFile, '-frames:v', '1', '-vf', 'scale=360:-2', '-y', out],
      { timeout: 15000, stdio: 'ignore' }
    )
    return exists(out) ? out : null
  } catch {
    return null
  }
}

export const rel = (p: string) => path.relative(DATA_ROOT, p)

export function readJson(file: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function exists(file: string) {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

function firstExisting(candidates: string[]) {
  return candidates.find(exists) ?? null
}

function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

function parseReportTitle(reportText: string, id: string): string {
  const h1 = reportText.split('\n').find((l) => l.startsWith('# '))
  if (!h1) return `${id.toUpperCase()} · B 轨样片`
  const afterDot = h1.replace(/^#\s*/, '').split('·').slice(-1)[0]?.trim() ?? ''
  const cleaned = afterDot.replace(/报告（/, '（').replace(/\s*报告$/, '')
  return cleaned || `${id.toUpperCase()} · B 轨样片`
}

function parseSourceStart(reportText: string): number {
  const m = reportText.match(/取样[：:]\s*t=([\d.]+)\s*[~～-]\s*([\d.]+)\s*s/)
  if (m) {
    const start = Number(m[1])
    if (Number.isFinite(start)) return start
  }
  return 0
}

const fmtPct = (n: number) => `${(n * 100).toFixed(2)}%`
const fmtNum = (n: number, d = 3) => n.toFixed(d)

function buildS1Criteria(s: any): Criterion[] {
  const a = s.aggregate ?? {}
  const g = s.gates ?? {}
  const val = (key: string, field = 'mean') => Number(a?.[key]?.[field])
  return [
    {
      key: 'B1',
      name: 'B1 · 保真 SSIM',
      value: `${val('B1_ssim_mean')} / 最差 ${val('B1_ssim_mean', 'worst')}`,
      threshold: '≥ 0.80',
      pass: Boolean(g['B1_ssim>=0.80']),
      explain: '输出与原片逐帧结构相似度；人物身份、构图、动作不变。',
      source: 'out/summary.json · aggregate'
    },
    {
      key: 'B2-gain',
      name: 'B2 · 锐度净增益',
      value: `${val('B2_net_gain_vs_baseline_ratio')}× / 最差 ${val('B2_net_gain_vs_baseline_ratio', 'worst')}×`,
      threshold: '≥ 1.5×（vs lanczos 往返基线）',
      pass: Boolean(g['B2_net_gain>=1.5x']),
      explain: '输出 lapvar ÷ lanczos 往返基线 lapvar；避免把噪声放大当成锐度提升。',
      source: 'out/summary.json · aggregate'
    },
    {
      key: 'B2-noise',
      name: 'B2 · 平坦区噪声',
      value: `+${val('B2_noise_change_pct').toFixed(1)}% / 最差 +${val('B2_noise_change_pct', 'worst').toFixed(1)}%`,
      threshold: '≤ +15%',
      pass: Boolean(g['B2_noise<=+15%']),
      explain:
        'Real-ESRGAN 4× 的空间锐化把平坦区高频一并放大。时域降噪 v2→v3 只把 +24.0% 压到 +23.8%，判为结构性副作用。',
      source: 'out/summary.json · gates · report.md §5'
    },
    {
      key: 'B3-ghost',
      name: 'B3 · 插帧鬼影比',
      value: `${fmtNum(val('B3_ghost_ratio_median'))} / 最差 ${fmtNum(val('B3_ghost_ratio_median', 'worst'))}`,
      threshold: '≤ 1.5',
      pass: Boolean(g['B3_ghost<=1.5']),
      explain: 'RIFE 2× 插帧的鬼影比中位数，越低越干净。',
      source: 'out/summary.json · aggregate'
    },
    {
      key: 'B3-tear',
      name: 'B3 · 撕裂占比',
      value: `${fmtPct(val('B3_tear_frac_mean'))} / 最差 ${fmtPct(val('B3_tear_frac_mean', 'worst'))}`,
      threshold: '≤ 10%',
      pass: Boolean(g['B3_tear<=10%']),
      explain: '插帧帧中检测到撕裂的区域占比。',
      source: 'out/summary.json · aggregate'
    },
    {
      key: 'B3-overshoot',
      name: 'B3 · 超分过冲',
      value: `${fmtPct(val('B3_overshoot_frac_mean'))} / 最差 ${fmtPct(val('B3_overshoot_frac_mean', 'worst'))}`,
      threshold: '≤ 35%',
      pass: Boolean(g['B3_overshoot<=35%']),
      explain: '超分锐化造成的振铃/过冲区域占比；S1 已从 S0 的 32.89% 降到 6.91%。',
      source: 'out/summary.json · aggregate · report.md §6'
    },
    {
      key: 'B3-skin',
      name: 'B3 · 肤色 ΔE（增强链）',
      value: `${fmtNum(val('B3_skin_dE_pre_grade_mean'), 3)} / 最差 ${fmtNum(val('B3_skin_dE_pre_grade_mean', 'worst'), 2)}`,
      threshold: '≤ 5（pre_grade）',
      pass: Boolean(g['B3_skin_dE_pre_grade<=5']),
      explain: '只量增强链自身；成片色偏另立 grade 判据，不计入增强链。',
      source: 'out/summary.json · aggregate'
    }
  ]
}

function buildS0Criteria(s: any): Criterion[] {
  return [
    {
      key: 'B1',
      name: 'B1 · 保真 SSIM',
      value: `${s.B1_ssim_mean} / 最差 ${s.B1_ssim_min}`,
      threshold: '≥ 0.80',
      pass: true,
      explain: 'S0 报告结论：B1 保真达标（≥ 0.80）。',
      source: 'summary_v2.json · report.md §1'
    },
    {
      key: 'B2-gain',
      name: 'B2 · 锐度净增益',
      value: `${s.B2_net_gain_vs_baseline_ratio}×`,
      threshold: '≥ 1.5×（2026-11-10 校准口径）',
      pass: null,
      explain:
        'S0 判定时用的是已作废的 lapvar +15% 绝对值口径；净增益 1.88× 是后来对照校准值，报告未据此重判。',
      source: 'summary_v2.json · gate 校准记录'
    },
    {
      key: 'B2-noise',
      name: 'B2 · 平坦区噪声',
      value: `+${s.B2_noise_change_pct}%`,
      threshold: '≤ +15%',
      pass: null,
      explain: 'S0 判定时噪声阈值尚未冻结；按现行 gate 该值会未过，但本页不追溯改判，保留原「有条件 PASS」。',
      source: 'summary_v2.json · report.md §5.1'
    },
    {
      key: 'B3-ghost',
      name: 'B3 · 插帧鬼影比',
      value: `${s.B3_ghost_ratio_median}（${s.B3_ghost_ratio_min}–${s.B3_ghost_ratio_max}）`,
      threshold: '≤ 1.5',
      pass: null,
      explain: 'S0 时 gate 文件本体未找到，B3 阈值未取得，只报数不判。',
      source: 'summary_v2.json · report.md §5.2'
    },
    {
      key: 'B3-tear',
      name: 'B3 · 撕裂占比',
      value: `${fmtPct(Number(s.B3_tear_frac_mean))} / 最大 ${fmtPct(Number(s.B3_tear_frac_max))}`,
      threshold: '≤ 10%',
      pass: null,
      explain: 'S0 时阈值未取得，只报数不判。',
      source: 'summary_v2.json · report.md §5.2'
    },
    {
      key: 'B3-overshoot',
      name: 'B3 · 超分过冲',
      value: `${fmtPct(Number(s.B3_overshoot_frac_mean))} / p95 ${fmtPct(Number(s.B3_overshoot_frac_p95))}`,
      threshold: '≤ 35%',
      pass: null,
      explain: 'S0 时阈值未取得，只报数不判；S1 同链路已降到 6.91%。',
      source: 'summary_v2.json · report.md §5.2'
    },
    {
      key: 'B3-skin',
      name: 'B3 · 肤色 ΔE',
      value: `${s.B3_skin_dE_mean}（成片）/ ${s.B3_skin_dE_attribution?.orig_to_pre_grade}（增强链）`,
      threshold: '≤ 5（pre_grade）',
      pass: null,
      explain: '成片 12.89 全部来自 grade_color L1 AWB；增强链自身 0.37。S0 未按 pre_grade 口径判定。',
      source: 'summary_v2.json · B3_skin_dE_attribution'
    }
  ]
}

function deriveStatus(s: any, criteria: Criterion[]) {
  const judged = criteria.filter((c) => c.pass !== null)
  const passed = judged.filter((c) => c.pass).length
  if (typeof s.verdict === 'string' && s.verdict.startsWith('PASS')) {
    return {
      status: 'CONDITIONAL' as const,
      statusLabel: 'PASS（有条件）',
      statusNote: s.verdict,
      passed: passed,
      total: criteria.length,
      judged: judged.length
    }
  }
  if (s.gates) {
    const entries = Object.entries(s.gates) as [string, boolean][]
    const ok = entries.filter(([, v]) => v).length
    const failed = entries.filter(([, v]) => !v).map(([k]) => k)
    return ok === entries.length
      ? {
          status: 'PASS' as const,
          statusLabel: 'PASS',
          statusNote: `${entries.length} 项判据全部通过`,
          passed: ok,
          total: entries.length,
          judged: entries.length
        }
      : {
          status: 'FAIL' as const,
          statusLabel: 'FAIL',
          statusNote: `报告判定 FAIL：${ok}/${entries.length} 项通过${failed.length ? `，未过：${failed.join('、')}` : ''}；待用户终审`,
          passed: ok,
          total: entries.length,
          judged: entries.length
        }
  }
  return {
    status: 'UNKNOWN' as const,
    statusLabel: '无判定',
    statusNote: 'summary 中没有判定字段',
    passed,
    total: criteria.length,
    judged: judged.length
  }
}

type ClipInfo = {
  duration_s: number | null
  fps: number | null
  width: number | null
  height: number | null
  frames: number | null
  codec: string | null
  pix_fmt: string | null
  colorspace: string | null
  bitrate_mbps: number | null
  bytes: number | null
  crf?: number | null
  path?: string
  local?: string
}

export type Discovered = {
  item: JobListItem
  summary: any
  title: string
  criteria: Criterion[]
  reportText: string
  clipInfo: ClipInfo | null
}

let cache: { at: number; jobs: Discovered[] } | null = null

export function discover(): Discovered[] {
  const now = Date.now()
  if (cache && now - cache.at < 3000) return cache.jobs

  const issueDir = path.join(DATA_ROOT, 'issue-19')
  const dirs = listDir(issueDir).filter((d) => /^b-track-s\d+$/.test(d))
  const jobs: Discovered[] = []

  for (const d of dirs.sort()) {
    const dir = path.join(issueDir, d)
    const id = d.replace('b-track-', '')
    const outDir = path.join(dir, 'out')
    const summaryPath = firstExisting([
      path.join(outDir, 'summary.json'),
      path.join(dir, 'summary_v2.json'),
      path.join(dir, 'summary.json')
    ])
    if (!summaryPath) continue
    const summary = readJson(summaryPath)
    if (!summary) continue

    const reportPath = firstExisting([path.join(dir, 'report.md')])
    const reportText = reportPath ? fs.readFileSync(reportPath, 'utf8') : ''
    const metricsPath = firstExisting([path.join(outDir, 'metrics.csv'), path.join(dir, 'metrics2.csv')])
    const outputPath = listDir(outDir)
      .filter((f) => f.endsWith('.mp4'))
      .map((f) => path.join(outDir, f))
      .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0] ?? null

    const summaryClip = (summary.clip ?? {}) as Record<string, unknown>
    const probe = outputPath ? probeVideo(outputPath) : null
    const clip = (summary.clip || probe
      ? {
          ...summaryClip,
          ...(probe
            ? {
                width: probe.width,
                height: probe.height,
                fps: probe.fps,
                frames: probe.frames,
                duration_s: probe.durationS,
                codec: probe.codec,
                pix_fmt: probe.pixFmt,
                colorspace: probe.colorspace,
                bitrate_mbps: probe.bitrateMbps,
                bytes: probe.bytes
              }
            : {})
        }
      : null) as ClipInfo | null
    const title = parseReportTitle(reportText, id)
    const criteria = summary.gates ? buildS1Criteria(summary) : buildS0Criteria(summary)
    const status = deriveStatus(summary, criteria)
    const projection = bTrackProjection(summary.verdict, status.status)
    const sourceStart = parseSourceStart(reportText)

    jobs.push({
      item: {
        id,
        track: 'B',
        taskId: String(summary.task_id ?? '无 task_id'),
        title,
        status: status.status,
        stage: projection.stage,
        verdict: projection.verdict ?? status.status,
        statusLabel: status.statusLabel,
        statusNote: status.statusNote,
        passed: status.passed,
        total: status.total,
        judged: status.judged,
        durationS: clip?.duration_s ?? null,
        fps: clip?.fps ?? null,
        width: clip?.width ?? null,
        height: clip?.height ?? null,
        frames: clip?.frames ?? null,
        sourceStart,
        hasQc: Boolean(metricsPath),
        media: {
          original: exists(ORIGINAL_VIDEO) ? '/media/original' : null,
          output: outputPath ? `/media/out/${id}` : null,
          poster: makePoster(outputPath, `${id}-out`, 0.2) ? `/media/poster/${id}` : null,
          posterOriginal: makePoster(ORIGINAL_VIDEO, `${id}-orig`, sourceStart + 0.2)
            ? `/media/poster-original/${id}`
            : null
        },
        summaryPath: rel(summaryPath),
        reportPath: reportPath ? rel(reportPath) : null,
        metricsPath: metricsPath ? rel(metricsPath) : null
      },
      summary,
      title,
      criteria,
      reportText,
      clipInfo: clip
    })
  }

  cache = { at: now, jobs }
  return jobs
}

function sourceMeta(jobs: Array<{ summary: any }>) {
  const probe = probeVideo(ORIGINAL_VIDEO)
  if (probe) {
    return {
      label: 'IMG_3189.MOV',
      durationS: probe.durationS,
      frames: probe.frames,
      fps: probe.fps,
      width: probe.width,
      height: probe.height,
      bytes: probe.bytes,
      path: rel(ORIGINAL_VIDEO)
    }
  }
  for (const j of jobs) {
    const src: string | undefined = j.summary.source
    if (!src) continue
    const m = src.match(/\(([\d.]+)s\s*\/\s*(\d+)f@(\d+)fps\s*\/\s*(\d+)x(\d+)\)/)
    if (m) {
      return {
        label: 'IMG_3189.MOV',
        durationS: Number(m[1]),
        frames: Number(m[2]),
        fps: Number(m[3]),
        width: Number(m[4]),
        height: Number(m[5]),
        bytes: exists(ORIGINAL_VIDEO) ? fs.statSync(ORIGINAL_VIDEO).size : null,
        path: rel(ORIGINAL_VIDEO)
      }
    }
  }
  return exists(ORIGINAL_VIDEO)
    ? {
        label: 'IMG_3189.MOV',
        durationS: null,
        frames: null,
        fps: null,
        width: null,
        height: null,
        bytes: fs.statSync(ORIGINAL_VIDEO).size,
        path: rel(ORIGINAL_VIDEO)
      }
    : null
}

function jobDetail(id: string): JobDetail | null {
  const jobs = discover()
  const found = jobs.find((j) => j.item.id === id)
  if (!found) return null
  const s = found.summary
  const notes: string[] = []
  if (found.item.status === 'FAIL') notes.push(found.item.statusNote)
  if (Array.isArray(s.unverified)) notes.push(...s.unverified.map((u: string) => `未验证：${u}`))
  if (s.look?.warning) notes.push(`look：${s.look.warning}`)

  return {
    job: found.item,
    sourceMeta: sourceMeta(jobs),
    criteria: found.criteria,
    pipeline: {
      source: s.source ?? null,
      l1Mode: s.l1_mode ?? null,
      chain: s.chain ?? null,
      clip: found.clipInfo,
      chainSteps: s.chain_steps_s ?? null,
      chainTotalS: typeof s.chain_total_s === 'number' ? s.chain_total_s : null,
      look: s.look ?? null
    },
    dataSources: [
      { label: 'summary', path: found.item.summaryPath, exists: true },
      { label: 'report', path: found.item.reportPath ?? '无', exists: Boolean(found.item.reportPath) },
      { label: 'metrics', path: found.item.metricsPath ?? '无', exists: Boolean(found.item.metricsPath) },
      {
        label: '原始视频',
        path: rel(ORIGINAL_VIDEO),
        exists: exists(ORIGINAL_VIDEO)
      }
    ],
    notes
  }
}

export function parseCsv(text: string): { columns: string[]; rows: Record<string, string | number>[] } {
  const lines = text.trim().split(/\r?\n/)
  if (lines.length < 2) return { columns: [], rows: [] }
  const columns = lines[0].split(',')
  const rows = lines.slice(1).map((line) => {
    const cells = line.split(',')
    const row: Record<string, string | number> = {}
    columns.forEach((c, i) => {
      const raw = cells[i] ?? ''
      const n = raw === '' ? NaN : Number(raw)
      row[c] = raw === '' ? '' : Number.isFinite(n) ? n : raw
    })
    return row
  })
  return { columns, rows }
}

/** #97a (I4): join policy rules with actuals from a metrics table. */
function rulesForRows(columns: string[], rows: Array<Record<string, string | number>>) {
  const policy = policyRules()
  return policy.rules.map((rule) => {
    const index = columns.indexOf(rule.id)
    let actual: number | null = null
    if (index >= 0) {
      const values = rows
        .map((row) => num(row[columns[index]]))
        .filter((value): value is number => value !== null)
      if (values.length) actual = values.reduce((sum, value) => sum + value, 0) / values.length
    }
    return { ...rule, actual, verdict: judgeRule(rule.op, rule.threshold, actual) }
  })
}

function qcData(id: string) {
  const jobs = discover()
  const found = jobs.find((j) => j.item.id === id)
  if (!found || !found.item.metricsPath) return null
  const file = path.join(DATA_ROOT, found.item.metricsPath)
  if (!exists(file)) return null
  const { columns, rows } = parseCsv(fs.readFileSync(file, 'utf8'))
  return {
    jobId: id,
    taskId: found.item.taskId,
    source: found.item.metricsPath,
    columns,
    rows,
    thresholds: [
      { label: 'lapvar 阈值', value: 16.3, note: '768×512 归一化口径' },
      { label: '单帧阈值', value: 5.0, note: '768×512 归一化口径' }
    ],
    rules: rulesForRows(columns, rows),
    rulesSource: policyRules().source,
    unitNote:
      '本 CSV 的 lapvar 是 1080×1920 原尺寸口径（约 100–3700），与 16.3 / 5.0 的 768×512 归一化口径不可直接比较；gate 已于 2026-11-10 校准，红线仅作历史参照。'
  }
}

const COMFYUI_DEFAULT_URL = 'http://127.0.0.1:8188'

/** 实际探测的 ComfyUI 地址：来自 COMFYUI_URL，未注入时回落默认值。 */
function comfyuiBaseUrl(): string {
  return (process.env.COMFYUI_URL || COMFYUI_DEFAULT_URL).replace(/\/$/, '')
}

/**
 * 把探测异常压成稳定的短文案：优先取底层 cause.code（如 ECONNREFUSED），
 * 超时统一为 `timeout`，HTTP 非 2xx 由调用方给出 `HTTP <status>`。
 */
function probeError(err: unknown): string {
  if (!(err instanceof Error)) return '未知错误'
  const cause = (err as { cause?: { code?: string; message?: string } }).cause
  if (cause?.code) return cause.code
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'timeout'
  const code = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|ENETUNREACH/.exec(err.message)
  if (code) return code[0]
  if (cause?.message) return cause.message
  return err.message
}

async function health() {
  const configuredUrl = comfyuiBaseUrl()
  const started = Date.now()
  try {
    const r = await fetch(`${configuredUrl}/system_stats`, { signal: AbortSignal.timeout(1500) })
    return {
      comfyui: {
        ok: r.ok,
        url: configuredUrl,
        configuredUrl,
        latencyMs: Date.now() - started,
        error: r.ok ? null : `HTTP ${r.status}`
      },
      checkedAt: new Date().toISOString()
    }
  } catch (err) {
    return {
      comfyui: {
        ok: false,
        url: configuredUrl,
        configuredUrl,
        latencyMs: Date.now() - started,
        error: probeError(err)
      },
      checkedAt: new Date().toISOString()
    }
  }
}

// ---------------------------------------------------------------------------
// Data-source helpers: DB first (T-DB-003), files fallback (`meta.source`).
// ---------------------------------------------------------------------------

const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

const sha256File = (file: string) =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

async function dbTry<T>(fn: (db: any) => Promise<T>): Promise<T | null> {
  if (!sql) return null
  try {
    return await fn(sql)
  } catch (err) {
    console.error('[db] query failed, falling back to files:', err instanceof Error ? err.message : err)
    return null
  }
}

type ArtifactRow = {
  job_id: string
  kind: string
  path: string
  size_bytes: number | string | null
  sha256: string | null
  mtime: string | Date | null
}

type DbJobsFull = {
  source: 'postgres'
  items: JobListItem[]
  summaries: Map<string, any>
  criteria: Map<string, Criterion[]>
  artifacts: Map<string, ArtifactRow[]>
}

let dbJobsCache: { at: number; value: DbJobsFull | null } | null = null

/** Jobs + criteria + artifacts from Postgres. Returns null when the DB is off/empty. */
async function dbJobsFull(): Promise<DbJobsFull | null> {
  if (!dbEnabled()) return null
  const now = Date.now()
  if (dbJobsCache && now - dbJobsCache.at < 2000) return dbJobsCache.value
  const rows = (await dbTry((db) => db`select * from acceptance.jobs order by id`)) as any[] | null
  if (!rows || rows.length === 0) {
    dbJobsCache = { at: now, value: null }
    return null
  }
  const critRows =
    ((await dbTry((db) => db`select * from acceptance.job_criteria order by job_id, key`)) as any[] | null) ?? []
  const artRows =
    ((await dbTry(
      (db) => db`select job_id, kind, path, size_bytes, sha256, mtime from acceptance.artifacts order by id`
    )) as any[] | null) ?? []

  const criteria = new Map<string, Criterion[]>()
  for (const c of critRows as any[]) {
    const list = criteria.get(c.job_id) ?? []
    list.push({
      key: c.key,
      name: c.name ?? c.key,
      value: c.value ?? '',
      threshold: c.threshold ?? '',
      pass: c.pass === null || c.pass === undefined ? null : Boolean(c.pass),
      explain: c.detail ?? '',
      source: c.source ?? ''
    })
    criteria.set(c.job_id, list)
  }
  const artifacts = new Map<string, ArtifactRow[]>()
  for (const a of artRows as ArtifactRow[]) {
    const list = artifacts.get(a.job_id) ?? []
    list.push(a)
    artifacts.set(a.job_id, list)
  }

  const summaries = new Map<string, any>()
  const items = (rows as any[]).map((row) => {
    const summary = row.summary ?? {}
    summaries.set(row.id, summary)
    const criteriaForJob = criteria.get(row.id) ?? []
    const status = deriveStatus(summary, criteriaForJob)
    const arts = artifacts.get(row.id) ?? []
    const video = arts.find((a) => a.kind === 'video')
    const videoExists = video ? exists(path.join(DATA_ROOT, video.path)) : false
    const hasOutput = Boolean(videoExists)
    const sourceStart = num(row.source_start) ?? 0
    const item: JobListItem = {
      id: row.id,
      track: row.track ?? 'B',
      taskId: row.task_id ?? '无 task_id',
      title: row.title ?? row.id,
      status: status.status,
      statusLabel: status.statusLabel,
      statusNote: status.statusNote,
      passed: status.passed,
      total: status.total,
      judged: status.judged,
      durationS: num(row.duration_s),
      fps: num(row.fps),
      width: num(row.width),
      height: num(row.height),
      frames: num(row.frames),
      sourceStart,
      hasQc: Boolean(row.has_qc),
      media: {
        original: exists(ORIGINAL_VIDEO) ? '/media/original' : null,
        output: hasOutput ? `/media/out/${row.id}` : null,
        poster: hasOutput ? `/media/poster/${row.id}` : null,
        posterOriginal: exists(ORIGINAL_VIDEO) ? `/media/poster-original/${row.id}` : null
      },
      summaryPath: arts.find((a) => a.kind === 'summary')?.path ?? '',
      reportPath: arts.find((a) => a.kind === 'report')?.path ?? null,
      metricsPath: arts.find((a) => a.kind === 'metrics')?.path ?? null
    }
    return item
  })

  const value: DbJobsFull = { source: 'postgres', items, summaries, criteria, artifacts }
  dbJobsCache = { at: now, value }
  return value
}

type SourceJobs = {
  source: 'postgres' | 'files'
  items: JobListItem[]
  summaries: Map<string, any>
  criteria: Map<string, Criterion[]>
  artifacts: Map<string, ArtifactRow[]>
}

export function filesArtifacts(item: JobListItem): ArtifactRow[] {
  const outDir = path.join(DATA_ROOT, 'issue-19', `b-track-${item.id}`, 'out')
  const dir = path.dirname(outDir)
  const files: { kind: string; file: string }[] = []
  for (const f of listDir(outDir).filter((f) => f.endsWith('.mp4')))
    files.push({ kind: 'video', file: path.join(outDir, f) })
  for (const f of listDir(dir).filter((f) => f.endsWith('.mp4')))
    files.push({ kind: 'video', file: path.join(dir, f) })
  if (item.reportPath) files.push({ kind: 'report', file: path.join(DATA_ROOT, item.reportPath) })
  if (item.summaryPath) files.push({ kind: 'summary', file: path.join(DATA_ROOT, item.summaryPath) })
  if (item.metricsPath) files.push({ kind: 'metrics', file: path.join(DATA_ROOT, item.metricsPath) })
  for (const r of collectRepairs(item.id)) {
    if (r.output.path) files.push({ kind: 'repair_video', file: path.join(DATA_ROOT, r.output.path) })
    if (r.report) files.push({ kind: 'repair_report', file: path.join(DATA_ROOT, r.report.path) })
    for (const c of r.compare) files.push({ kind: 'repair_compare', file: path.join(DATA_ROOT, c.path) })
  }
  return files
    .filter((f) => exists(f.file))
    .map((f) => {
      const stat = fs.statSync(f.file)
      return {
        job_id: item.id,
        kind: f.kind,
        path: rel(f.file),
        size_bytes: stat.size,
        sha256: null,
        mtime: stat.mtime.toISOString()
      }
    })
}

async function loadSourceJobs(): Promise<SourceJobs> {
  const fromDb = await dbJobsFull()
  if (fromDb) return fromDb
  const jobs = discover()
  const criteria = new Map<string, Criterion[]>()
  const artifacts = new Map<string, ArtifactRow[]>()
  const summaries = new Map<string, any>()
  for (const j of jobs) {
    criteria.set(j.item.id, j.criteria)
    artifacts.set(j.item.id, filesArtifacts(j.item))
    summaries.set(j.item.id, j.summary)
  }
  return { source: 'files', items: jobs.map((j) => j.item), summaries, criteria, artifacts }
}

// ---------------------------------------------------------------------------
// AI repair artefacts (issue-19/*/out/[<kind>/]ai_repair_report.json).
// Files are the only source of truth: missing outputs stay null/unverified.
// ---------------------------------------------------------------------------

export type RepairOutput = {
  sha256: string | null
  path: string | null
  url: string | null
  size: number | null
  durationS: number | null
  width: number | null
  height: number | null
}

export type Repair = {
  job: string | null
  tool: string | null
  issue: string | null
  kind: 'ai_repair'
  input: { sha256: string | null; path: string | null; url: string | null }
  output: RepairOutput
  metrics: { before: unknown; after: unknown; delta_e_veg: number | null }
  no_op: boolean
  no_op_reason: string | null
  params_source: string | null
  params_hash: string | null
  unverified: string[]
  frames_processed: number | null
  elapsed_s: number | null
  generatedAt: string | null
  report: { path: string; url: string } | null
  compare: { path: string; url: string }[]
  available: boolean
  meta: { source: 'files' }
}

const artifactUrl = (relPath: string) => `/media/artifact?path=${encodeURIComponent(relPath)}`

function insideDataRoot(file: string): boolean {
  let root: string
  let abs: string
  try {
    root = fs.realpathSync(DATA_ROOT)
  } catch {
    root = path.resolve(DATA_ROOT)
  }
  try {
    abs = fs.realpathSync(file)
  } catch {
    return false
  }
  return abs === root || abs.startsWith(root + path.sep)
}

/** Existing file inside the data root → relative path + media URL, otherwise null. */
function rootArtifact(file: string): { path: string; url: string } | null {
  if (!exists(file) || !insideDataRoot(file)) return null
  const relPath = rel(file)
  return { path: relPath, url: artifactUrl(relPath) }
}

function repairReportFiles(): string[] {
  const issueDir = path.join(DATA_ROOT, 'issue-19')
  const files: string[] = []
  for (const d of listDir(issueDir)) {
    if (!/^b-track-s\d+$/.test(d)) continue
    const outDir = path.join(issueDir, d, 'out')
    const direct = path.join(outDir, 'ai_repair_report.json')
    if (exists(direct)) files.push(direct)
    for (const sub of listDir(outDir)) {
      if (sub === 'ai_repair_report.json') continue
      const nested = path.join(outDir, sub, 'ai_repair_report.json')
      if (exists(nested)) files.push(nested)
    }
  }
  return files.sort()
}

/** Resolve report.output inside the data root; verifies output_sha256 when given. */
function resolveRepairOutput(
  report: any,
  reportDir: string,
  jobOutDir: string | null
): { file: string | null; note: string | null } {
  const raw = typeof report?.output === 'string' && report.output.trim() ? report.output.trim() : null
  const expected = typeof report?.output_sha256 === 'string' ? report.output_sha256 : null
  const candidates: string[] = []
  if (raw) {
    candidates.push(path.isAbsolute(raw) ? raw : path.resolve(reportDir, raw))
    const base = path.basename(raw)
    candidates.push(path.join(reportDir, base))
    if (jobOutDir) candidates.push(path.join(jobOutDir, base))
  }
  if (jobOutDir && expected) {
    for (const f of listDir(jobOutDir)) {
      if (f.endsWith('.mp4')) candidates.push(path.join(jobOutDir, f))
    }
  }
  const seen = new Set<string>()
  for (const c of candidates) {
    const key = path.resolve(c)
    if (seen.has(key)) continue
    seen.add(key)
    if (!exists(c)) continue
    if (expected && sha256File(c) !== expected) continue
    if (!insideDataRoot(c)) continue
    return { file: c, note: null }
  }
  return {
    file: null,
    note: 'output 文件未在数据根内找到（按 output_sha256 校验失败）'
  }
}

function buildRepairs(): Repair[] {
  const known = new Set(discover().map((j) => j.item.id))
  const items: { repair: Repair; mtimeMs: number }[] = []
  for (const reportFile of repairReportFiles()) {
    const report = readJson(reportFile)
    if (!report || typeof report !== 'object') continue
    const relReport = rel(reportFile)
    const m = relReport.match(/^issue-19\/b-track-([\w-]+)\/out\//)
    const parsedJob = m ? m[1] : null
    const job = parsedJob && known.has(parsedJob) ? parsedJob : null
    const jobOutDir = parsedJob ? path.join(DATA_ROOT, 'issue-19', `b-track-${parsedJob}`, 'out') : null
    const reportDir = path.dirname(reportFile)

    const unverified = Array.isArray(report.unverified)
      ? report.unverified.filter((u: unknown): u is string => typeof u === 'string')
      : []
    const { file: outFile, note } = resolveRepairOutput(report, reportDir, jobOutDir)
    if (note) unverified.push(note)
    if (!parsedJob) unverified.push('无法从路径解析 job id（路径不在 issue-19/b-track-<id>/out/ 下）')
    else if (!job) unverified.push(`job ${parsedJob} 不在 discover() 列表中`)

    const probe = outFile ? probeVideo(outFile) : null
    const outArtifact = outFile ? rootArtifact(outFile) : null
    const inputRaw = typeof report.input === 'string' && report.input.trim() ? report.input.trim() : null
    const inputPath = inputRaw && exists(inputRaw) ? inputRaw : null
    const inputArtifact = inputRaw ? rootArtifact(inputRaw) : null
    const reportArtifact = rootArtifact(reportFile)
    const compare: { path: string; url: string }[] = []
    for (const f of listDir(reportDir).filter((f) => /^compare_\d+\.png$/i.test(f)).sort()) {
      const a = rootArtifact(path.join(reportDir, f))
      if (a) compare.push(a)
    }

    const metrics = report.metrics ?? {}
    const repair: Repair = {
      job,
      tool: report.tool ?? null,
      issue: report.issue ?? null,
      kind: 'ai_repair',
      input: {
        sha256: report.input_sha256 ?? null,
        path: inputPath,
        url: inputArtifact?.url ?? null
      },
      output: {
        sha256: report.output_sha256 ?? null,
        path: outArtifact?.path ?? null,
        url: outArtifact?.url ?? null,
        size: outFile ? num(fs.statSync(outFile).size) : null,
        durationS: probe?.durationS ?? null,
        width: probe?.width ?? null,
        height: probe?.height ?? null
      },
      metrics: {
        before: metrics.before ?? null,
        after: metrics.after ?? null,
        delta_e_veg: num(metrics.delta_e_veg)
      },
      no_op: report.no_op === true,
      no_op_reason: report.no_op_reason ?? null,
      params_source: report.params_source ?? null,
      params_hash: report.params_hash ?? null,
      unverified,
      frames_processed: num(report.frames_processed),
      elapsed_s: num(report.elapsed_s),
      generatedAt: fs.statSync(reportFile).mtime.toISOString(),
      report: reportArtifact,
      compare,
      available: Boolean(outArtifact),
      meta: { source: 'files' }
    }
    items.push({ repair, mtimeMs: fs.statSync(reportFile).mtimeMs })
  }
  return items
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map((i) => i.repair)
}

let repairCache: { at: number; items: Repair[] } | null = null

/** Scans every `ai_repair_report.json` (job out or one sub-dir), newest first. */
export function collectRepairs(jobId?: string): Repair[] {
  const now = Date.now()
  if (!repairCache || now - repairCache.at > 2000) {
    repairCache = { at: now, items: buildRepairs() }
  }
  return jobId ? repairCache.items.filter((r) => r.job === jobId) : repairCache.items
}

type PlanBase = {
  source: 'postgres' | 'files'
  path: string
  exists: boolean
  updatedAt: string | null
  data: any
}

/** Non-task plan fields (milestones, eta, updated_at) from DB snapshot/FILE. */
async function readPlanBase(): Promise<PlanBase> {
  const rows = (await dbTry(
    (db) =>
      db`select payload, source_path, created_at from acceptance.snapshots where kind = 'tasks_plan' order by created_at desc limit 1`
  )) as any[] | null
  if (rows && rows.length) {
    const row: any = (rows as any[])[0]
    const data = row.payload
    return {
      source: 'postgres',
      path: row.source_path ?? PLAN_FILE,
      exists: true,
      updatedAt:
        typeof data?.updated_at === 'string'
          ? data.updated_at
          : row.created_at
            ? new Date(row.created_at).toISOString()
            : null,
      data
    }
  }
  const data = readJson(PLAN_FILE)
  let updatedAt: string | null = typeof data?.updated_at === 'string' ? data.updated_at : null
  if (data !== null && !updatedAt) {
    try {
      updatedAt = fs.statSync(PLAN_FILE).mtime.toISOString()
    } catch {
      updatedAt = null
    }
  }
  return { source: 'files', path: PLAN_FILE, exists: data !== null, updatedAt, data: data ?? null }
}

/**
 * Plan data for every read path. Tasks come from Gitea task issues
 * (`WEB_TASKS_SOURCE=gitea`, default); milestones/eta/updated_at keep coming
 * from `readPlanBase()`. When Gitea is unreachable the task list is empty and
 * the reason lands in `meta.error` — the local file is never used as a stand-in.
 */
async function readPlanData(): Promise<PlanBase & { tasksSource: 'gitea' | 'files'; error?: string }> {
  const base = await readPlanBase()
  const store = readManualVerify(MANUAL_VERIFY_FILE)
  if (TASKS_FROM_FILES) {
    const rawTasks = Array.isArray(base.data?.tasks) ? (base.data.tasks as TaskItem[]) : []
    const tasks = sortByManualVerify(rawTasks.map((task) => decorateTask(task, store)))
    return {
      ...base,
      data: base.data ? { ...base.data, tasks } : base.data,
      tasksSource: 'files'
    }
  }
  const keep = base.data && typeof base.data === 'object' ? base.data : {}
  try {
    const { tasks } = await giteaListTaskIssues()
    const items = sortTaskItems(tasks.map(giteaTaskItem)).map((task) => decorateTask(task, store))
    return {
      ...base,
      exists: true,
      data: { ...keep, tasks: sortByManualVerify(items) },
      tasksSource: 'gitea'
    }
  } catch (err) {
    const reason = err instanceof GiteaError ? `gitea ${err.reason}` : 'gitea unavailable'
    if (!(err instanceof GiteaError)) console.error('[plan] gitea task read failed:', issueErrorText(err))
    return {
      ...base,
      data: { ...keep, tasks: [] },
      tasksSource: 'gitea',
      error: reason
    }
  }
}

async function readStatusData(): Promise<{
  source: 'postgres' | 'files'
  path: string
  exists: boolean
  updatedAt: string | null
  data: any
}> {
  const rows = (await dbTry(
    (db) =>
      db`select payload, source_path, created_at from acceptance.snapshots where kind = 'project_status' order by created_at desc limit 1`
  )) as any[] | null
  if (rows && rows.length) {
    const row: any = (rows as any[])[0]
    const data = row.payload
    return {
      source: 'postgres',
      path: row.source_path ?? STATUS_FILE,
      exists: true,
      updatedAt:
        typeof data?.updated_at === 'string'
          ? data.updated_at
          : row.created_at
            ? new Date(row.created_at).toISOString()
            : null,
      data
    }
  }
  const data = readJson(STATUS_FILE)
  return {
    source: 'files',
    path: STATUS_FILE,
    exists: data !== null,
    updatedAt: typeof data?.updated_at === 'string' ? data.updated_at : null,
    data: data ?? null
  }
}

function fileMtimeIso(file: string): string | null {
  try {
    return fs.statSync(file).mtime.toISOString()
  } catch {
    return null
  }
}

function subagentRunningCount(): number {
  const parsed = readJson(path.join(DATA_ROOT, '.opencode', 'state', 'SUBAGENT_STATUS.json'))
  const list: any[] = Array.isArray(parsed?.agents)
    ? parsed.agents
    : Array.isArray(parsed?.tasks)
      ? parsed.tasks
      : Array.isArray(parsed)
        ? parsed
        : []
  return list.filter(
    (item) =>
      item?.state === 'running' ||
      item?.state === '进行中' ||
      item?.status === 'running' ||
      item?.status === '进行中'
  ).length
}

async function issueSourceCounts() {
  if (ISSUES_FROM_FILES) {
    const items = scanIssues()
    const open = items.filter((item) => item.status === 'open').length
    const closed = items.filter((item) => item.status === 'closed').length
    return { open, closed, total: items.length, fetchedAt: new Date().toISOString(), source: 'files' as const }
  }
  try {
    const summary = await giteaIssueSummary()
    return {
      open: summary.open,
      closed: summary.closed,
      total: summary.total,
      fetchedAt: summary.fetched_at,
      source: 'gitea' as const
    }
  } catch {
    return {
      open: null,
      closed: null,
      total: null,
      fetchedAt: null,
      source: 'gitea' as const,
      error: 'gitea unavailable'
    }
  }
}

/**
 * Cross-source numbers for the status page header (C1–C4). Issues reuse
 * `giteaIssueSummary()` (and its list cache) so `/api/status` and `/api/issues`
 * cannot disagree; tasks reuse `readPlanData()` exactly like `/api/overview`.
 */
async function statusSources(statusUpdatedAt: string | null) {
  const [issues, plan] = await Promise.all([issueSourceCounts(), readPlanData()])
  const tasks: any[] = Array.isArray(plan.data?.tasks) ? plan.data.tasks : []
  const stateDir = path.join(DATA_ROOT, '.opencode', 'state')
  const updatedAt = typeof statusUpdatedAt === 'string' ? statusUpdatedAt : null
  const parsed = updatedAt ? Date.parse(updatedAt) : NaN
  return {
    issues,
    tasks: { ...taskStatusCounts(tasks), source: plan.tasksSource },
    opencode: {
      taskMdUpdatedAt: fileMtimeIso(path.join(stateDir, 'TASK.md')),
      subagentUpdatedAt: fileMtimeIso(path.join(stateDir, 'SUBAGENT_STATUS.json')),
      runningCount: subagentRunningCount()
    },
    snapshot: {
      updatedAt,
      stale: !Number.isFinite(parsed) || Date.now() - parsed > 24 * 60 * 60 * 1000
    }
  }
}

const summaryMetric = (summary: any, key: string): number | null =>
  num(summary?.aggregate?.[key] ?? summary?.[key])

/** #97a2 (I4): display table derived from the same policy source, never a second list. */
const qcThresholds = () => {
  const policy = policyRules()
  return {
    source: policy.source,
    items: policy.rules.map((rule) => ({
      key: rule.id,
      label: rule.name,
      threshold:
        rule.op && rule.threshold !== null
          ? `${rule.op} ${rule.threshold}${rule.unit ? ` ${rule.unit}` : ''}`
          : '—'
    }))
  }
}

// ---------------------------------------------------------------------------
// New endpoints (T-DB-003 §C/§7)
// ---------------------------------------------------------------------------

async function systemStatus() {
  const configuredUrl = comfyuiBaseUrl()
  const base = configuredUrl
  const started = Date.now()
  const getJson = async (p: string) => {
    const r = await fetch(`${base}${p}`, { signal: AbortSignal.timeout(1500) })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return (await r.json()) as any
  }
  try {
    const [stats, queue] = await Promise.all([getJson('/system_stats'), getJson('/queue')])
    const sys = stats?.system ?? {}
    const dev = Array.isArray(stats?.devices) ? (stats.devices[0] ?? {}) : {}
    const vramTotal = num(dev.vram_total)
    const vramFree = num(dev.vram_free)
    const ramTotal = num(sys.ram_total)
    const ramFree = num(sys.ram_free)
    return {
      studio: {
        online: true,
        latencyMs: Date.now() - started,
        comfyuiVersion: sys.comfyui_version ?? null,
        os: sys.os ?? null
      },
      vram: {
        total: vramTotal,
        free: vramFree,
        used: vramTotal !== null && vramFree !== null ? vramTotal - vramFree : null
      },
      ram: {
        total: ramTotal,
        free: ramFree,
        used: ramTotal !== null && ramFree !== null ? ramTotal - ramFree : null
      },
      queue: {
        running: Array.isArray(queue?.queue_running) ? queue.queue_running.length : 0,
        pending: Array.isArray(queue?.queue_pending) ? queue.queue_pending.length : 0
      },
      configuredUrl,
      checkedAt: new Date().toISOString()
    }
  } catch (err) {
    const error = probeError(err)
    return {
      studio: {
        online: false,
        latencyMs: Date.now() - started,
        error
      },
      vram: null,
      ram: null,
      queue: null,
      configuredUrl,
      error,
      checkedAt: new Date().toISOString()
    }
  }
}

export async function deliveriesData(limit?: number) {
  const { source, items } = await loadSourceJobs()
  const repairsByJob = new Map<string, Repair[]>()
  for (const r of collectRepairs()) {
    if (!r.job) continue
    const list = repairsByJob.get(r.job) ?? []
    list.push(r)
    repairsByJob.set(r.job, list)
  }
  const rows = items
    .filter((item) => item.media.output)
    .map((item) => {
      const outDir = path.join(DATA_ROOT, 'issue-19', `b-track-${item.id}`, 'out')
      const video =
        listDir(outDir)
          .filter((f) => f.endsWith('.mp4'))
          .map((f) => path.join(outDir, f))
          .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0] ?? null
      // #107：成片已移入回收站/被删除时不再返回幽灵卡（恢复文件后自动重现）。
      // listDir 到 stat 之间文件可能被移走（删除/回收站恢复并发），两层都判存在。
      if (!video || !exists(video)) return null
      let stat: fs.Stats
      try {
        stat = fs.statSync(video)
      } catch {
        return null
      }
      const cover16 = path.join(outDir, 'cover_16x9.jpg')
      const repairs = repairsByJob.get(item.id) ?? []
      const latest = repairs[0]
      const repair = latest
        ? {
            count: repairs.length,
            latest: {
              tool: latest.tool,
              issue: latest.issue,
              generatedAt: latest.generatedAt,
              reportUrl: latest.report?.url ?? null,
              compareUrl: latest.compare[0]?.url ?? null
            },
            repaired: repairs.some((r) => r.available && r.no_op === false)
          }
        : null
      return {
        jobId: item.id,
        title: item.title,
        durationS: item.durationS,
        width: item.width,
        height: item.height,
        mp4: `/media/out/${item.id}`,
        poster: item.media.poster,
        coverUrl: exists(cover16) ? (`/media/artifact?path=${encodeURIComponent(rel(cover16))}`) : null,
        report: item.reportPath
          ? `/media/artifact?path=${encodeURIComponent(item.reportPath)}`
          : null,
        score: item.judged ? Math.round((item.passed / item.judged) * 100) / 100 : null,
        gate: item.statusLabel,
        createdAt: stat.mtime.toISOString(),
        bytes: stat.size,
        repair
      }
    })
  const out = rows
    .filter((row): row is NonNullable<typeof row> => row !== null)
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
  return { source, deliveries: limit ? out.slice(0, limit) : out }
}

// ---------------------------------------------------------------------------
// #107：交付软删。把 `issue-19/b-track-<id>/out` 下的成片与 16:9 封面移入
// `<DATA_ROOT>/.trash/deliveries/<id>-<ts>/`，人工移回即可恢复（不物理 unlink；
// 仅跨盘时 copy+unlink，语义仍是「移动」）。路径校验：id 白名单 + realpath
// 必须落在 out 目录内，符号链接越界直接拒绝。
// ---------------------------------------------------------------------------

const DELIVERY_ID_RE = /^[\w-]+$/

export type TrashResult =
  | { ok: true; jobId: string; movedTo: string; bytes: number; files: string[] }
  | { ok: false; status: number; error: string }

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep)
}

export function trashDelivery(
  id: string,
  dataRoot: string = DATA_ROOT,
  now: Date = new Date()
): TrashResult {
  if (!DELIVERY_ID_RE.test(id)) return { ok: false, status: 400, error: 'invalid delivery id' }
  const outDir = path.join(dataRoot, 'issue-19', `b-track-${id}`, 'out')
  let realOut: string
  try {
    realOut = fs.realpathSync(outDir)
  } catch {
    return { ok: false, status: 404, error: `job ${id} has no output directory` }
  }
  let realRoot = dataRoot
  try {
    realRoot = fs.realpathSync(dataRoot)
  } catch {
    /* keep unresolved root */
  }
  if (!isInside(realRoot, realOut)) {
    return { ok: false, status: 400, error: 'path outside WEB_DATA_ROOT' }
  }

  const picked: { name: string; file: string; size: number }[] = []
  for (const name of listDir(outDir)) {
    if (!name.endsWith('.mp4') && name !== 'cover_16x9.jpg') continue
    const file = path.join(outDir, name)
    let real: string
    try {
      real = fs.realpathSync(file)
    } catch {
      continue
    }
    if (!isInside(realOut, real)) {
      return { ok: false, status: 400, error: `refusing symlink outside out dir: ${name}` }
    }
    let stat: fs.Stats
    try {
      stat = fs.statSync(real)
    } catch {
      continue
    }
    if (!stat.isFile()) continue
    picked.push({ name, file: real, size: stat.size })
  }
  if (!picked.some((f) => f.name.endsWith('.mp4'))) {
    return { ok: false, status: 404, error: `job ${id} has no output video` }
  }

  const iso = now.toISOString()
  const stamp = `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}`
  let trashDir = path.join(dataRoot, '.trash', 'deliveries', `${id}-${stamp}`)
  for (let n = 2; existsDir(trashDir) && n < 50; n += 1) {
    trashDir = path.join(dataRoot, '.trash', 'deliveries', `${id}-${stamp}-${n}`)
  }
  fs.mkdirSync(trashDir, { recursive: true })

  let bytes = 0
  const files: string[] = []
  for (const f of picked) {
    const dest = path.join(trashDir, f.name)
    try {
      fs.renameSync(f.file, dest)
    } catch (err) {
      // 同盘 rename；跨盘才退化为 copy+unlink（内容仍保留在回收站）。
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
      fs.copyFileSync(f.file, dest)
      fs.unlinkSync(f.file)
    }
    bytes += f.size
    files.push(f.name)
  }
  return {
    ok: true,
    jobId: id,
    movedTo: path.relative(dataRoot, trashDir) || trashDir,
    bytes,
    files
  }
}

function existsDir(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Read-only share tokens (issue-60 / T-WEB-009).
//
// `POST /api/share` mints a token bound to one artefact already published by
// `GET /api/deliveries`; `GET /share/<token>` then redirects to the unguessable
// file endpoint. Tokens never grant writes. State lives in
// `<DATA_ROOT>/.opencode/state/shares.json` and is written atomically.
// ---------------------------------------------------------------------------

const SHARES_FILE = path.join(DATA_ROOT, '.opencode', 'state', 'shares.json')
const SHARE_TTL_HOURS = 7 * 24
const SHARE_TTL_HOURS_MIN = 1
const SHARE_TTL_HOURS_MAX = 168

type ShareToken = {
  token: string
  path: string
  name: string
  createdAt: string
  expiresAt: string
  revoked: boolean
  createdBy: string
}

type SharesFile = { version: 1; tokens: ShareToken[] }

/** Missing/corrupt file = empty list (never throws). */
function readSharesFile(): SharesFile {
  const data = readJson(SHARES_FILE)
  if (!data || !Array.isArray(data.tokens)) return { version: 1, tokens: [] }
  return {
    version: 1,
    tokens: data.tokens.filter(
      (t: any): t is ShareToken =>
        Boolean(t) && typeof t.token === 'string' && typeof t.path === 'string'
    )
  }
}

/**
 * `WEB_WRITE_TOKEN` set → exact `X-Web-Token` (401 otherwise). Unset → CSRF-style
 * same-origin check: `Origin` host:port must equal the request host (403 otherwise).
 * The server runs behind `serve.ts`, which rewrites `Host` to the upstream; the
 * original public host is kept in `x-forwarded-host`, so prefer that when present.
 *
 * Browsers do not send `Origin` on same-origin GET/HEAD (only on CORS/POST), so a
 * read that lacks `Origin` is accepted when it declares `Sec-Fetch-Site: same-origin`
 * or when its `Referer` host matches. Mutations (POST/PUT/DELETE) still require
 * `Origin`: they keep the original strict behaviour.
 */
function isSameOriginRequest(req: IncomingMessage): boolean {
  const forwarded = req.headers['x-forwarded-host']
  const host = (Array.isArray(forwarded) ? forwarded[0] : forwarded) || req.headers.host
  if (typeof host !== 'string' || !host) return false
  const expectedHost = host.trim().toLowerCase()
  const sameHost = (value: string): boolean => {
    try {
      return new URL(value).host.toLowerCase() === expectedHost
    } catch {
      return false
    }
  }

  const origin = req.headers.origin
  if (typeof origin === 'string' && origin) return sameHost(origin)

  const isRead = req.method === 'GET' || req.method === 'HEAD'
  if (!isRead) return false

  const fetchSite = req.headers['sec-fetch-site']
  if ((Array.isArray(fetchSite) ? fetchSite[0] : fetchSite) === 'same-origin') return true

  const referer = req.headers.referer
  if (typeof referer !== 'string' || !referer) return false
  return sameHost(referer)
}

/**
 * `PATCH /api/tasks/:id` guard (issue #105). Browsers never hold
 * `WEB_WRITE_TOKEN`, so the token is optional for the same-origin page:
 *  - header present → it must match the configured token (401 on mismatch,
 *    503 when no token is configured); the token check wins over same-origin;
 *  - no header → same-origin browser request is allowed (403 otherwise).
 * Exported so the three branches are unit-tested in `server/task-write.test.ts`.
 */
export function authorizeTaskWrite(
  req: IncomingMessage,
  env: NodeJS.ProcessEnv = process.env
): { ok: true } | { ok: false; status: number; error: string } {
  const token = env.WEB_WRITE_TOKEN
  const raw = req.headers['x-web-token']
  const provided = Array.isArray(raw) ? raw[0] : raw
  if (provided !== undefined) {
    if (!token) return { ok: false, status: 503, error: 'write disabled: WEB_WRITE_TOKEN is not set' }
    if (provided !== token) return { ok: false, status: 401, error: 'invalid X-Web-Token' }
    return { ok: true }
  }
  if (isSameOriginRequest(req)) return { ok: true }
  return { ok: false, status: 403, error: 'same-origin browser request or X-Web-Token required' }
}

/** Mutating share endpoints: token when configured, same-origin otherwise. */
function requireShareWriteToken(req: IncomingMessage, res: ServerResponse): boolean {
  const token = process.env.WEB_WRITE_TOKEN
  if (token) {
    if (req.headers['x-web-token'] !== token) {
      sendJson(res, 401, { error: 'invalid X-Web-Token' })
      return false
    }
    return true
  }
  if (!isSameOriginRequest(req)) {
    sendJson(res, 403, { error: 'same-origin required' })
    return false
  }
  return true
}

/** Listing stays token-only; unconfigured → 403 (never same-origin readable). */
function requireShareListToken(req: IncomingMessage, res: ServerResponse): boolean {
  const token = process.env.WEB_WRITE_TOKEN
  if (!token) {
    sendJson(res, 403, { error: 'share listing requires WEB_WRITE_TOKEN' })
    return false
  }
  if (req.headers['x-web-token'] !== token) {
    sendJson(res, 401, { error: 'invalid X-Web-Token' })
    return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Studio job intake bridge (issue #84, #84b).
//
// Browsers never hold the studio token: this server keeps `WEB_WRITE_TOKEN`
// and injects it as `X-Web-Token` when proxying to the studio intake service
// (`ops/studio/intake.py`, default port 8090). Writes fail closed when the
// token is unset (503); there is deliberately no same-origin fallback here.
// ---------------------------------------------------------------------------

const STUDIO_INTAKE_URL = (
  process.env.STUDIO_INTAKE_URL?.trim() || 'http://100.92.106.101:8090'
).replace(/\/$/, '')
const STUDIO_INTAKE_TIMEOUT_MS = 5000
const INTAKE_MAX_BODY_BYTES = 64 * 1024

/** `WEB_WRITE_TOKEN` must be configured and matched verbatim; else 503/401. */
function intakeToken(req: IncomingMessage, res: ServerResponse): string | null {
  const token = process.env.WEB_WRITE_TOKEN
  if (!token) {
    sendJson(res, 503, { error: 'intake disabled: WEB_WRITE_TOKEN is not set' })
    return null
  }
  if (req.headers['x-web-token'] !== token) {
    sendJson(res, 401, { error: 'invalid X-Web-Token' })
    return null
  }
  return token
}

/** Buffer the request body, rejecting anything above the studio's 64KB limit. */
function readIntakeBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    req.on('data', (chunk: Buffer) => {
      if (settled) return
      size += chunk.length
      if (size > INTAKE_MAX_BODY_BYTES) {
        settled = true
        reject(Object.assign(new Error('payload too large'), { code: 'TOO_LARGE' }))
        req.resume()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', (err) => {
      if (settled) return
      settled = true
      reject(err)
    })
  })
}

/** 502 for unreachable studio, 504 for its 5s timeout; never include the token. */
function intakeErrorReason(err: unknown): string {
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return 'timeout'
  }
  const cause = (err as { cause?: { code?: unknown; message?: unknown } } | null)?.cause
  if (typeof cause?.code === 'string') return cause.code
  if (typeof cause?.message === 'string' && cause.message) return cause.message
  return 'network error'
}

async function proxyIntake(
  res: ServerResponse,
  upstreamPath: string,
  init: { method: string; headers?: Record<string, string>; body?: string }
) {
  let upstream: Response
  try {
    upstream = await fetch(`${STUDIO_INTAKE_URL}${upstreamPath}`, {
      ...init,
      signal: AbortSignal.timeout(STUDIO_INTAKE_TIMEOUT_MS)
    })
  } catch (err) {
    const reason = intakeErrorReason(err)
    console.error(`[intake] ${init.method} ${upstreamPath} -> ${reason}`)
    sendJson(res, reason === 'timeout' ? 504 : 502, { error: 'intake unavailable', reason })
    return
  }
  const text = await upstream.text().catch(() => '')
  let body: unknown
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = { error: 'invalid upstream response' }
  }
  sendJson(res, upstream.status, body)
}

/** POST /api/intake/jobs — forward the JSON body to studio `/intake/jobs`. */
async function handleIntakePost(req: IncomingMessage, res: ServerResponse) {
  const token = intakeToken(req, res)
  if (!token) return
  let body: string
  try {
    body = await readIntakeBody(req)
  } catch (err) {
    if ((err as { code?: unknown }).code === 'TOO_LARGE') {
      sendJson(res, 413, { error: 'payload too large' })
      return
    }
    sendJson(res, 400, { error: 'unreadable body' })
    return
  }
  await proxyIntake(res, '/intake/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Web-Token': token },
    body
  })
}

/** GET /api/intake/jobs/:id — forward to studio status lookup. */
async function handleIntakeJobGet(req: IncomingMessage, res: ServerResponse, id: string) {
  const token = intakeToken(req, res)
  if (!token) return
  await proxyIntake(res, `/intake/jobs/${encodeURIComponent(id)}`, {
    method: 'GET',
    headers: { 'X-Web-Token': token }
  })
}

/** Decode percent-escapes until stable; null on malformed input. */
function decodeSharePath(value: string): string | null {
  let out = value
  for (let i = 0; i < 3; i++) {
    let next: string
    try {
      next = decodeURIComponent(out)
    } catch {
      return null
    }
    if (next === out) return out
    out = next
  }
  return out
}

/** Traversal / NUL guard, applied to the raw value and every decoded layer. */
function sharePathUnsafe(value: string): boolean {
  if (!value || value.includes('\0')) return true
  if (value.split(/[\\/]/).includes('..')) return true
  const decoded = decodeSharePath(value)
  if (decoded === null) return true
  return decoded !== value && decoded.split(/[\\/]/).includes('..')
}

function largestMp4(dir: string): string | null {
  const ranked = listDir(dir)
    .filter((f) => f.endsWith('.mp4'))
    .map((f) => path.join(dir, f))
    .map((file) => {
      try {
        return { file, size: fs.statSync(file).size }
      } catch {
        return null
      }
    })
    .filter((row): row is { file: string; size: number } => row !== null)
    .sort((a, b) => b.size - a.size)
  // #107：删除/移动后不再返回已不存在的路径（分享白名单与 /media/out 同源过滤）。
  return ranked[0] && exists(ranked[0].file) ? ranked[0].file : null
}

/**
 * Exact-match whitelist of `GET /api/deliveries` artefacts, keyed by both the
 * delivered URL (`/media/out/<id>`, `/media/artifact?path=…`) and the
 * underlying repo-relative path.
 */
async function shareWhitelist(): Promise<Map<string, string>> {
  const { deliveries } = await deliveriesData()
  const map = new Map<string, string>()
  const add = (key: string | null | undefined, file: string | null) => {
    if (!key || !file || !exists(file)) return
    map.set(key, file)
    map.set(rel(file), file)
  }
  for (const d of deliveries as any[]) {
    const jobId = typeof d?.jobId === 'string' ? d.jobId : ''
    if (!jobId || !/^[\w-]+$/.test(jobId)) continue
    add(`/media/out/${jobId}`, largestMp4(path.join(DATA_ROOT, 'issue-19', `b-track-${jobId}`, 'out')))
    for (const url of [d.coverUrl, d.report]) {
      if (typeof url !== 'string') continue
      const m = /^\/media\/artifact\?path=([^&]+)$/.exec(url)
      if (!m) continue
      const relPath = decodeSharePath(m[1])
      if (!relPath || sharePathUnsafe(relPath)) continue
      add(url, path.resolve(DATA_ROOT, relPath))
    }
  }
  return map
}

/** Resolve a stored share path to a real file inside `DATA_ROOT` (403 outside). */
function resolveShareFile(rawPath: string): { file?: string; status?: number; error?: string } {
  if (sharePathUnsafe(rawPath)) return { status: 400, error: 'invalid path' }
  const decoded = decodeSharePath(rawPath) as string
  let abs: string | null = null
  if (decoded.startsWith('/media/out/')) {
    const id = decoded.slice('/media/out/'.length)
    if (!/^[\w-]+$/.test(id)) return { status: 400, error: 'invalid path' }
    abs = largestMp4(path.join(DATA_ROOT, 'issue-19', `b-track-${id}`, 'out'))
  } else if (decoded.startsWith('/media/artifact?path=')) {
    const value = decodeSharePath(decoded.slice('/media/artifact?path='.length))
    if (!value || sharePathUnsafe(value)) return { status: 400, error: 'invalid path' }
    abs = path.resolve(DATA_ROOT, value)
  } else if (decoded.startsWith('/')) {
    return { status: 400, error: 'invalid path' }
  } else {
    abs = path.resolve(DATA_ROOT, decoded)
  }
  if (!abs) return { status: 404, error: 'file not found' }

  let root: string
  try {
    root = fs.realpathSync(DATA_ROOT)
  } catch {
    root = DATA_ROOT
  }
  let target: string
  try {
    target = fs.realpathSync(abs)
  } catch {
    return { status: 404, error: 'file not found' }
  }
  if (target !== root && !target.startsWith(root + path.sep)) {
    return { status: 403, error: 'path outside WEB_DATA_ROOT' }
  }
  if (!exists(target)) return { status: 404, error: 'file not found' }
  return { file: target }
}

/** Active = known, not revoked, not expired. All failure modes look identical. */
function activeShareToken(token: string): ShareToken | null {
  const hit = readSharesFile().tokens.find((t) => t.token === token)
  if (!hit || hit.revoked) return null
  const expires = Date.parse(hit.expiresAt)
  if (!Number.isFinite(expires) || expires <= Date.now()) return null
  return hit
}

async function handleSharePost(req: IncomingMessage, res: ServerResponse) {
  if (!requireShareWriteToken(req, res)) return
  let body: any
  try {
    body = await readRequestBody(req)
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : 'bad body' })
    return
  }
  const rawPath = typeof body?.path === 'string' ? body.path.trim() : ''
  if (!rawPath) {
    sendJson(res, 400, { error: 'path is required' })
    return
  }
  if (sharePathUnsafe(rawPath)) {
    sendJson(res, 400, { error: 'path not allowed' })
    return
  }
  const whitelist = await shareWhitelist()
  const file = whitelist.get(rawPath)
  if (!file) {
    sendJson(res, 400, { error: 'path is not a delivered artefact' })
    return
  }

  let ttlHours = SHARE_TTL_HOURS
  if (body?.ttlHours !== undefined && body?.ttlHours !== null) {
    const n = Number(body.ttlHours)
    if (!Number.isInteger(n) || n < SHARE_TTL_HOURS_MIN || n > SHARE_TTL_HOURS_MAX) {
      sendJson(res, 400, {
        error: `ttlHours must be an integer between ${SHARE_TTL_HOURS_MIN} and ${SHARE_TTL_HOURS_MAX}`
      })
      return
    }
    ttlHours = n
  }

  const store = readSharesFile()
  let token = crypto.randomBytes(16).toString('hex')
  while (store.tokens.some((t) => t.token === token)) {
    token = crypto.randomBytes(16).toString('hex')
  }
  const now = new Date()
  const name =
    typeof body?.name === 'string' && body.name.trim() ? body.name.trim() : path.basename(file)
  const entry: ShareToken = {
    token,
    path: rawPath,
    name,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlHours * 3600_000).toISOString(),
    revoked: false,
    createdBy: process.env.WEB_WRITE_TOKEN ? 'web-token' : 'same-origin'
  }
  store.tokens.push(entry)
  writeShares(store)
  sendJson(res, 201, {
    token,
    url: `/share/${token}`,
    path: entry.path,
    name: entry.name,
    expiresAt: entry.expiresAt
  })
}

function writeShares(store: SharesFile) {
  atomicWriteJson(SHARES_FILE, store)
}

function handleShareList(req: IncomingMessage, res: ServerResponse) {
  if (!requireShareListToken(req, res)) return
  const items = readSharesFile().tokens.map(({ token, path: p, name, createdAt, expiresAt, revoked }) => ({
    token,
    path: p,
    name,
    createdAt,
    expiresAt,
    revoked
  }))
  sendJson(res, 200, { items })
}

function handleShareDelete(req: IncomingMessage, res: ServerResponse, token: string) {
  if (!requireShareWriteToken(req, res)) return
  const store = readSharesFile()
  const hit = store.tokens.find((t) => t.token === token)
  if (!hit) {
    sendJson(res, 404, { error: 'share token not found' })
    return
  }
  if (!hit.revoked) {
    hit.revoked = true
    writeShares(store)
  }
  sendJson(res, 200, { revoked: true })
}

function handleShareRedirect(res: ServerResponse, token: string) {
  if (!activeShareToken(token)) {
    sendJson(res, 404, { error: 'not found' })
    return
  }
  res.statusCode = 302
  res.setHeader('Location', `/api/share/${token}/file`)
  res.setHeader('Cache-Control', 'no-store')
  res.end()
}

function handleShareFile(req: IncomingMessage, res: ServerResponse, token: string) {
  const hit = activeShareToken(token)
  if (!hit) {
    sendJson(res, 404, { error: 'not found' })
    return
  }
  const resolved = resolveShareFile(hit.path)
  if (!resolved.file) {
    sendJson(res, resolved.status ?? 404, { error: resolved.error ?? 'file not found' })
    return
  }
  const filename = (hit.name || path.basename(resolved.file)).replace(/[\r\n"\\]/g, '_')
  const encoded = encodeURIComponent(hit.name || path.basename(resolved.file))
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${filename}"; filename*=UTF-8''${encoded}`
  )
  serveMedia(req, res, resolved.file)
}

function taskStatusCounts(tasks: any[]) {
  const countBy = (s: string) => tasks.filter((t) => t.status === s).length
  return {
    done: countBy('done'),
    running: countBy('running'),
    pending: countBy('pending'),
    blocked: countBy('blocked'),
    total: tasks.length
  }
}

async function overviewData() {
  const [plan, status, jobs, system] = await Promise.all([
    readPlanData(),
    readStatusData(),
    loadSourceJobs(),
    systemStatus()
  ])
  const tasks: any[] = Array.isArray(plan.data?.tasks) ? plan.data.tasks : []
  const taskCounts = taskStatusCounts(tasks)
  const jc = {
    pass: jobs.items.filter((j) => j.status === 'PASS').length,
    fail: jobs.items.filter((j) => j.status === 'FAIL').length,
    conditional: jobs.items.filter((j) => j.status === 'CONDITIONAL').length,
    unknown: jobs.items.filter((j) => j.status === 'UNKNOWN').length,
    total: jobs.items.length
  }
  const alerts = [
    ...tasks
      .filter((t) => t.status === 'blocked')
      .map((t) => ({ type: 'task_blocked', id: t.id, title: t.title, detail: t.blocked_by ?? null })),
    ...jobs.items
      .filter((j) => j.status === 'FAIL')
      .map((j) => ({ type: 'job_fail', id: j.id, title: j.title, detail: j.statusNote })),
    ...(Array.isArray(status.data?.missing)
      ? status.data.missing.map((m: any) => ({
          type: 'missing',
          id: m.item ?? null,
          title: m.item ?? 'missing',
          detail: m.why ?? null
        }))
      : [])
  ]
  const pick = (t: any) => ({ id: t.id, title: t.title, owner: t.owner ?? null, progress: t.progress ?? null })
  const deliveries = await deliveriesData(4)
  return {
    counts: { tasks: taskCounts, jobs: jc },
    alerts,
    deliveries: deliveries.deliveries,
    running: tasks.filter((t) => t.status === 'running').map(pick),
    pending: tasks.filter((t) => t.status === 'pending').map(pick),
    system: {
      online: system.studio.online,
      latencyMs: system.studio.latencyMs,
      queue: system.queue
    },
    meta: {
      source:
        plan.source === 'postgres' || jobs.source === 'postgres' ? 'postgres' : 'files',
      planSource: plan.source,
      jobsSource: jobs.source,
      tasksSource: plan.tasksSource,
      ...(plan.error ? { planError: plan.error } : {})
    }
  }
}

async function qcSummaryData() {
  const { source, items, summaries } = await loadSourceJobs()
  // #97a (I4): rule list is the policy source, not a second hardcoded table.
  const policy = policyRules()
  return {
    thresholds: qcThresholds(),
    rules: policy.rules.map((rule) => ({ ...rule, actual: null, verdict: null })),
    rulesSource: policy.source,
    jobs: items.map((item) => {
      const s = summaries.get(item.id)
      return {
        jobId: item.id,
        taskId: item.taskId,
        status: item.status,
        passed: item.passed,
        judged: item.judged,
        ssim: summaryMetric(s, 'B1_ssim_mean'),
        noiseChangePct: summaryMetric(s, 'B2_noise_change_pct'),
        netGain: summaryMetric(s, 'B2_net_gain_vs_baseline_ratio'),
        ghostRatio: summaryMetric(s, 'B3_ghost_ratio_median'),
        hasQc: item.hasQc
      }
    }),
    meta: { source }
  }
}

// ---------------------------------------------------------------------------
// Task detail + write path (T-DB-003 §5/§7)
// ---------------------------------------------------------------------------

function evidenceFiles(evidence: unknown) {
  const text = typeof evidence === 'string' ? evidence : ''
  const tokens = text
    .split(/[\s,，、;；]+/)
    .map((t) => t.trim().replace(/^['"`]|['"`]$/g, ''))
    .filter(Boolean)
  const files: { path: string; exists: boolean; sizeBytes: number | null; sha256: string | null }[] = []
  const seen = new Set<string>()
  for (const token of tokens) {
    if (seen.has(token)) continue
    seen.add(token)
    const abs = path.resolve(DATA_ROOT, token)
    if (abs !== DATA_ROOT && !abs.startsWith(DATA_ROOT + path.sep)) continue
    if (exists(abs)) {
      const stat = fs.statSync(abs)
      files.push({ path: token, exists: true, sizeBytes: stat.size, sha256: sha256File(abs) })
    } else if (/[./]/.test(token)) {
      files.push({ path: token, exists: false, sizeBytes: null, sha256: null })
    }
  }
  return files
}

/** Whitelist: only `issue-19/b-track-s*` log files; tail ≤200 lines. */
function recentLogs(limit = 3) {
  const base = path.join(DATA_ROOT, 'issue-19')
  const found: { file: string; mtimeMs: number }[] = []
  for (const d of listDir(base).filter((d) => /^b-track-s\d+$/.test(d))) {
    const dir = path.join(base, d)
    for (const sub of [dir, path.join(dir, 'out')]) {
      for (const f of listDir(sub).filter((f) => f.endsWith('.log'))) {
        const file = path.join(sub, f)
        try {
          if (fs.statSync(file).isFile()) found.push({ file, mtimeMs: fs.statSync(file).mtimeMs })
        } catch {
          /* ignore */
        }
      }
    }
  }
  return found
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .map(({ file }) => {
      const text = fs.readFileSync(file, 'utf8')
      const lines = text.split(/\r?\n/)
      return {
        path: rel(file),
        mtime: fs.statSync(file).mtime.toISOString(),
        lines: lines.slice(Math.max(0, lines.length - 200))
      }
    })
}

async function taskSnapshots() {
  const rows = (await dbTry(
    (db) =>
      db`select kind, sha256, source_path, created_at from acceptance.snapshots order by created_at desc limit 20`
  )) as any[] | null
  if (rows && rows.length) {
    return (rows as any[]).map((r) => ({
      kind: r.kind,
      sha256: r.sha256,
      path: r.source_path,
      createdAt: r.created_at ? new Date(r.created_at).toISOString() : null
    }))
  }
  const out: { kind: string; sha256: string; path: string; createdAt: string | null }[] = []
  for (const [kind, file] of [
    ['tasks_plan', PLAN_FILE],
    ['project_status', STATUS_FILE]
  ] as const) {
    if (!exists(file)) continue
    out.push({
      kind,
      sha256: sha256File(file),
      path: rel(file),
      createdAt: fs.statSync(file).mtime.toISOString()
    })
  }
  return out
}

async function taskHistory(id: string) {
  const rows = (await dbTry(
    (db) =>
      db`select at, type, actor, entity, payload from acceptance.events where entity = ${id} order by at desc limit 50`
  )) as any[] | null
  if (!rows) return []
  return (rows as any[]).map((r) => ({
    at: r.at ? new Date(r.at).toISOString() : null,
    type: r.type,
    actor: r.actor,
    entity: r.entity,
    payload: r.payload
  }))
}

// ---------------------------------------------------------------------------
// Job logs / history (issue-59): read-only, never writes.
// ---------------------------------------------------------------------------

const MAX_LOG_BYTES = 64 * 1024
const MAX_LOG_LINES = 200
const LOG_WALK_DEPTH = 3

export type JobLogItem = { name: string; path: string; size: number; mtime: string }

function isDir(dir: string) {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

function collectLogFiles(dir: string, out: string[], depth = 0) {
  if (depth > LOG_WALK_DEPTH) return
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) collectLogFiles(file, out, depth + 1)
    else if (entry.isFile() && entry.name.endsWith('.log')) out.push(file)
  }
}

/** `jobs/<id>/**`, `issue-19/b-track-<id>/**`, plus `KEX_LOG_DIR` files named after the job. */
function jobLogScan(id: string): { items: JobLogItem[]; scanned: string[] } {
  const scanned: string[] = []
  const files: string[] = []
  for (const dir of [
    path.join(DATA_ROOT, 'jobs', id),
    path.join(DATA_ROOT, 'issue-19', `b-track-${id}`)
  ]) {
    if (!isDir(dir)) continue
    scanned.push(rel(dir))
    collectLogFiles(dir, files)
  }
  const logDir = process.env.KEX_LOG_DIR?.trim()
  if (logDir) {
    const dir = path.resolve(logDir)
    if (isDir(dir)) {
      scanned.push(rel(dir))
      const named: string[] = []
      collectLogFiles(dir, named)
      const token = new RegExp(`(^|[^\\w-])${id.replace(/[^\w-]/g, '')}([^\\w]|$)`)
      for (const file of named) {
        if (token.test(path.basename(file))) files.push(file)
      }
    }
  }
  const items = [...new Set(files)]
    .map((file) => {
      const stat = fs.statSync(file)
      return {
        name: path.basename(file),
        path: rel(file),
        size: stat.size,
        mtime: stat.mtime.toISOString()
      }
    })
    .sort((a, b) => Date.parse(b.mtime) - Date.parse(a.mtime))
  return { items, scanned }
}

function readLogTail(file: string): { content: string; truncated: boolean } {
  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size
    const start = Math.max(0, size - MAX_LOG_BYTES)
    const length = size - start
    const buf = Buffer.alloc(length)
    fs.readSync(fd, buf, 0, length, start)
    const lines = buf.toString('utf8').split(/\r?\n/)
    const keep = lines.slice(Math.max(0, lines.length - MAX_LOG_LINES))
    return { content: keep.join('\n'), truncated: start > 0 || keep.length < lines.length }
  } finally {
    fs.closeSync(fd)
  }
}

export type JobHistoryItem = { ts: string | null; kind: string; summary: string }

const HISTORY_EVENT_FILES = [
  path.join(DATA_ROOT, '.opencode', 'state', '.locks', 'events.jsonl'),
  path.join(DATA_ROOT, 'state', '.locks', 'events.jsonl'),
  path.join(DATA_ROOT, '.locks', 'events.jsonl')
]

function historyFromEventsFile(id: string): JobHistoryItem[] {
  const token = new RegExp(`(^|[^\\w-])${id.replace(/[^\w-]/g, '')}([^\\w-]|$)`)
  const items: JobHistoryItem[] = []
  for (const file of HISTORY_EVENT_FILES) {
    if (!exists(file)) continue
    let text = ''
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim() || !token.test(line)) continue
      let ev: any = null
      try {
        ev = JSON.parse(line)
      } catch {
        ev = null
      }
      const rawTs = ev?.ts ?? ev?.at ?? ev?.time ?? ev?.created_at ?? null
      const kind = String(ev?.kind ?? ev?.type ?? ev?.event ?? 'event')
      const summary = String(
        ev?.summary ??
          ev?.message ??
          ev?.note ??
          (ev?.actor ? `${kind} · ${ev.actor}` : line.slice(0, 200))
      )
      items.push({
        ts: typeof rawTs === 'string' ? rawTs : rawTs ? new Date(rawTs).toISOString() : null,
        kind,
        summary
      })
    }
  }
  return items.sort((a, b) => (Date.parse(b.ts ?? '') || 0) - (Date.parse(a.ts ?? '') || 0))
}

async function jobHistoryData(id: string): Promise<{ items: JobHistoryItem[]; source: string }> {
  const dbItems = await dbTry(async (db) => {
    const events = (await db`
      select at, type, actor, entity, payload from acceptance.events
      where entity = ${id} or payload->>'job' = ${id}
      order by at desc limit 50
    `) as any[]
    const snaps = (await db`
      select kind, source_path, created_at from acceptance.snapshots
      where source_path like ${'%' + id + '%'} or kind like ${'%' + id + '%'}
      order by created_at desc limit 20
    `) as any[]
    const rows: JobHistoryItem[] = []
    for (const r of events ?? []) {
      const payload = r.payload ?? {}
      rows.push({
        ts: r.at ? new Date(r.at).toISOString() : null,
        kind: String(r.type ?? 'event'),
        summary: String(payload?.summary ?? payload?.message ?? `${r.actor ?? ''} · ${r.entity ?? id}`).trim()
      })
    }
    for (const s of snaps ?? []) {
      rows.push({
        ts: s.created_at ? new Date(s.created_at).toISOString() : null,
        kind: `snapshot:${s.kind ?? 'unknown'}`,
        summary: String(s.source_path ?? '')
      })
    }
    return rows
  })
  if (dbItems && dbItems.length > 0) return { items: dbItems, source: 'postgres' }
  return { items: historyFromEventsFile(id), source: 'files' }
}

async function taskDetailData(id: string) {
  const [plan, jobs] = await Promise.all([readPlanData(), loadSourceJobs()])
  const tasks: any[] = Array.isArray(plan.data?.tasks) ? plan.data.tasks : []
  const task = tasks.find((t) => t.id === id)
  if (!task) return null
  const linked = jobs.items.filter((j) => j.taskId === id)
  const criteria = linked.flatMap((j) =>
    (jobs.criteria.get(j.id) ?? []).map((c) => ({ jobId: j.id, ...c }))
  )
  const artifacts = linked.flatMap((j) =>
    (jobs.artifacts.get(j.id) ?? []).map((a) => ({
      jobId: j.id,
      kind: a.kind,
      path: a.path,
      url: `/media/artifact?path=${encodeURIComponent(a.path)}`,
      sizeBytes: num(a.size_bytes),
      sha256: a.sha256 ?? null,
      mtime: a.mtime ? new Date(a.mtime).toISOString() : null
    }))
  )
  const repairs = linked.flatMap((j) => collectRepairs(j.id))
  return {
    task,
    criteria,
    evidence: evidenceFiles(task.evidence),
    artifacts,
    repairs,
    logs: recentLogs(),
    history: await taskHistory(id),
    snapshots: await taskSnapshots(),
    meta: { source: plan.source }
  }
}

const TASK_STATUSES = ['done', 'running', 'pending', 'blocked'] as const

function validateTaskPatch(body: any): { fields: Record<string, unknown> } | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'body must be a JSON object' }
  const allowed = new Set(['status', 'progress', 'owner', 'end_ts'])
  const keys = Object.keys(body)
  const unknown = keys.filter((k) => !allowed.has(k))
  if (unknown.length) return { error: `unknown fields: ${unknown.join(',')}` }
  if (keys.length === 0) return { error: 'no fields to update' }
  const fields: Record<string, unknown> = {}
  if ('status' in body) {
    if (!TASK_STATUSES.includes(body.status)) {
      return { error: `status must be one of ${TASK_STATUSES.join('|')}` }
    }
    fields.status = body.status
  }
  if ('progress' in body) {
    if (!Number.isInteger(body.progress) || body.progress < 0 || body.progress > 100) {
      return { error: 'progress must be an integer 0..100' }
    }
    fields.progress = body.progress
  }
  if ('owner' in body) {
    if (typeof body.owner !== 'string' || body.owner.trim() === '') {
      return { error: 'owner must be a non-empty string' }
    }
    fields.owner = body.owner
  }
  if ('end_ts' in body) {
    if (typeof body.end_ts !== 'string' || Number.isNaN(Date.parse(body.end_ts))) {
      return { error: 'end_ts must be an ISO timestamp' }
    }
    fields.end_ts = body.end_ts
  }
  return { fields }
}

function readRequestBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      data += chunk
      if (data.length > 64 * 1024) reject(new Error('body too large'))
    })
    req.on('end', () => {
      if (!data.trim()) {
        reject(new Error('empty body'))
        return
      }
      try {
        resolve(JSON.parse(data))
      } catch {
        reject(new Error('invalid JSON'))
      }
    })
    req.on('error', reject)
  })
}

function atomicWriteJson(file: string, value: unknown) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, file)
}

async function handleTaskPatch(req: IncomingMessage, res: ServerResponse, id: string) {
  // #105: same-origin browser PATCH is allowed; X-Web-Token stays authoritative
  // when present (scripts / cross-origin callers).
  const auth = authorizeTaskWrite(req)
  if (!auth.ok) {
    sendJson(res, auth.status, { error: auth.error })
    return
  }
  let body: any
  try {
    body = await readRequestBody(req)
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : 'bad body' })
    return
  }
  const validated = validateTaskPatch(body)
  if ('error' in validated) {
    sendJson(res, 400, { error: validated.error })
    return
  }
  const fields = validated.fields

  if (!TASKS_FROM_FILES) {
    try {
      const { tasks } = await giteaListTaskIssues()
      const record = tasks.find((item) => item.id === id)
      if (!record) {
        sendJson(res, 404, { error: `task ${id} not found` })
        return
      }
      const patch: TaskPatch = {}
      if ('status' in fields) patch.status = fields.status as TaskPatch['status']
      if ('progress' in fields) patch.progress = fields.progress as number
      if ('owner' in fields) patch.owner = fields.owner as string
      if ('end_ts' in fields) patch.end_ts = fields.end_ts as string
      const task = await giteaUpdateTaskIssue(record, patch)
      sendJson(res, 200, {
        ok: true,
        task,
        updatedAt: new Date().toISOString(),
        dbUpdated: false,
        source: 'gitea',
        meta: { source: 'gitea' }
      })
    } catch (err) {
      console.error(
        '[tasks] gitea patch failed:',
        err instanceof GiteaError ? err.reason : issueErrorText(err)
      )
      sendJson(res, 502, { error: 'gitea task update failed' })
    }
    return
  }

  const plan = readJson(PLAN_FILE)
  const tasks: any[] = Array.isArray(plan?.tasks) ? plan.tasks : []
  const task = tasks.find((t) => t.id === id)
  if (!plan || !task) {
    sendJson(res, 404, { error: `task ${id} not found` })
    return
  }
  if ('status' in fields) task.status = fields.status
  if ('progress' in fields) task.progress = fields.progress
  if ('owner' in fields) task.owner = fields.owner
  if ('end_ts' in fields) task.end = fields.end_ts

  const source = dbEnabled() ? 'postgres' : 'files'
  if (source === 'postgres' && sql) {
    const statusVal = (fields.status as string | undefined) ?? null
    const progressVal = (fields.progress as number | undefined) ?? null
    const ownerVal = (fields.owner as string | undefined) ?? null
    const endVal = (fields.end_ts as string | undefined) ?? null
    try {
      await sql.begin(async (tx) => {
        await tx`
          update acceptance.tasks set
            status = coalesce(${statusVal}, status),
            progress = coalesce(${progressVal}, progress),
            owner = coalesce(${ownerVal}, owner),
            end_ts = coalesce(${endVal}, end_ts),
            updated_at = now()
          where id = ${id}
        `
        await insertEvent(tx, { type: 'task.update', actor: 'web', entity: id, payload: fields })
        await writeSnapshot(tx, 'tasks_plan', plan, rel(PLAN_FILE))
      })
    } catch (err) {
      sendJson(res, 500, {
        error: `db update failed: ${err instanceof Error ? err.message : String(err)}`
      })
      return
    }
    try {
      atomicWriteJson(PLAN_FILE, plan)
    } catch (err) {
      sendJson(res, 500, {
        error: `db updated but tasks.json export failed: ${err instanceof Error ? err.message : String(err)}`,
        dbUpdated: true
      })
      return
    }
    const status = readJson(STATUS_FILE) ?? {}
    try {
      await upsertTasksAndMilestones(sql, plan, status)
    } catch (err) {
      console.error('[db] post-export re-upsert failed:', err instanceof Error ? err.message : err)
    }
  } else {
    try {
      atomicWriteJson(PLAN_FILE, plan)
    } catch (err) {
      sendJson(res, 500, {
        error: `tasks.json write failed: ${err instanceof Error ? err.message : String(err)}`
      })
      return
    }
  }

  sendJson(res, 200, {
    ok: true,
    task,
    updatedAt: new Date().toISOString(),
    meta: { source }
  })
}

// ---------------------------------------------------------------------------
// Cover generation (B) + AI explain (C), both real-binary/real-model driven.
// ---------------------------------------------------------------------------

const FFMPEG_BIN = process.env.FFMPEG_BIN?.trim() || 'ffmpeg'
const FFPROBE_BIN = process.env.FFPROBE_BIN?.trim() || 'ffprobe'
const OLLAMA_URL = (process.env.OLLAMA_URL?.trim() || 'http://127.0.0.1:11434').replace(/\/$/, '')
const QWEN_VL_MODEL = process.env.QWEN_VL_MODEL?.trim() || 'qwen2vl:7b-q4'
const COVER_PROVIDER = 'qwen2vl+ffmpeg'
const EXPLAIN_DISCLAIMER = 'AI 解读，非验收结论'

const COVER_SIZES = {
  '16x9': { width: 1920, height: 1080 },
  '9x16': { width: 1080, height: 1920 }
} as const

/**
 * B-track source clips (s0/s1) carry a FaceTime picture-in-picture window in the
 * top-right corner (measured on clip_60fps_s1.mp4 @4.95s: x≈687..1030,
 * y≈30..495 of 1080×1920, stable across the clip). Cropping the top 23% cut the
 * subject's hair AND left the window's bottom strip — so we cover that exact
 * rectangle with a brand block instead (margin 0.625..0.97 / 0.008..0.268).
 */
const PIP_MASK = { x: 0.625, y: 0.008, w: 0.345, h: 0.26 } as const
const PIP_MASK_COLOR = '0x0F1723'
const PIP_MASK_BORDER = '0xF2C14E@0.55'

type CoverVariant = keyof typeof COVER_SIZES

const COVER_FONT_CANDIDATES = [
  process.env.COVER_FONT?.trim(),
  '/System/Library/Fonts/PingFang.ttc',
  '/System/Library/Fonts/Hiragino Sans GB.ttc',
  '/System/Library/Fonts/STHeiti Medium.ttc',
  '/usr/share/fonts/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'
].filter((f): f is string => Boolean(f))

function pickCoverFont(): string | null {
  return COVER_FONT_CANDIDATES.find((f) => exists(f)) ?? null
}

const sha256Text = (text: string) => crypto.createHash('sha256').update(text).digest('hex')

const mediaUrl = (relPath: string) => `/media/artifact?path=${encodeURIComponent(relPath)}`

const coverTmpDir = () => path.join(os.tmpdir(), 'acceptance-web-cover')

type VideoInfo = { durationS: number | null; width: number | null; height: number | null }

/** Duration + dimensions via ffprobe, falling back to `ffmpeg -i` stderr (NAS/studio). */
function videoInfo(file: string): VideoInfo {
  try {
    const raw = execFileSync(
      FFPROBE_BIN,
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,duration', '-show_entries', 'format=duration', '-of', 'json', file],
      { encoding: 'utf8', timeout: 8000 }
    )
    const parsed = JSON.parse(raw) as any
    const stream = Array.isArray(parsed.streams) ? parsed.streams[0] : null
    const durationS = num(stream?.duration) ?? num(parsed.format?.duration)
    return {
      durationS: durationS && durationS > 0 ? durationS : null,
      width: num(stream?.width),
      height: num(stream?.height)
    }
  } catch {
    // ffprobe missing (studio) — ffmpeg prints metadata before failing on no-output.
  }
  try {
    const r = spawnSync(FFMPEG_BIN, ['-hide_banner', '-i', file], { encoding: 'utf8', timeout: 8000 })
    const text = String(r.stderr ?? '')
    const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text)
    const v = /Video:.*?(\d{2,5})x(\d{2,5})/.exec(text)
    return {
      durationS: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : null,
      width: v ? Number(v[1]) : null,
      height: v ? Number(v[2]) : null
    }
  } catch {
    return { durationS: null, width: null, height: null }
  }
}

/** Extract one real frame (cached by video mtime + timestamp + target width). */
function extractCoverFrame(
  videoFile: string,
  key: string,
  atSeconds: number,
  width: number | null,
  maskPip = false
): string | null {
  if (!exists(videoFile)) return null
  const stat = fs.statSync(videoFile)
  const dir = path.join(coverTmpDir(), `${key}-${Math.round(stat.mtimeMs)}`)
  const suffix = maskPip ? '-pipmask' : ''
  const file = path.join(
    dir,
    `frame-${atSeconds.toFixed(2)}${width ? `-${width}` : '-full'}${suffix}.jpg`
  )
  if (exists(file)) return file
  try {
    fs.mkdirSync(dir, { recursive: true })
    const filters: string[] = []
    if (maskPip) {
      const rect = `x=iw*${PIP_MASK.x}:y=ih*${PIP_MASK.y}:w=iw*${PIP_MASK.w}:h=ih*${PIP_MASK.h}`
      filters.push(`drawbox=${rect}:color=${PIP_MASK_COLOR}:t=fill`)
      filters.push(`drawbox=${rect}:color=${PIP_MASK_BORDER}:t=3`)
    }
    if (width) filters.push(`scale=${width}:-2`)
    const vf = filters.length ? ['-vf', filters.join(',')] : []
    execFileSync(
      FFMPEG_BIN,
      ['-v', 'error', '-ss', atSeconds.toFixed(3), '-i', videoFile, '-frames:v', '1', '-q:v', '2', ...vf, '-y', file],
      { timeout: 30000, stdio: 'ignore' }
    )
    return exists(file) ? file : null
  } catch {
    return null
  }
}

/** Qwen2-VL picks the best of the 3 candidate frames; median frame on any failure. */
async function scoreCoverFrames(frames: string[]): Promise<{ pick: number; reason: string; error: string | null }> {
  const prompt = [
    '你是短视频封面选帧助手。下面是同一段竖版视频在 20%、50%、80% 三个时刻的截帧，顺序为 1、2、3。',
    '这些候选帧右上角的 FaceTime 画中画小窗已被品牌色块遮挡，属正常设计。',
    '选出最适合做封面的一张：人物/主体清晰、表情或姿态自然、构图完整、不过曝不模糊。',
    '主体头部被画面边缘裁掉的帧不能选（头顶必须完整、留有余量）；若多张都安全，选人物状态最好的一张。',
    '只输出 JSON：{"pick":1|2|3,"reason":"一句中文理由"}'
  ].join('\n')
  try {
    const images = frames.map((f) => fs.readFileSync(f).toString('base64'))
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: QWEN_VL_MODEL,
        prompt,
        images,
        stream: false,
        format: 'json',
        options: { temperature: 0, num_predict: 200 }
      }),
      signal: AbortSignal.timeout(45000)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = (await res.json()) as { response?: string }
    const parsed = JSON.parse(String(body.response ?? '')) as { pick?: unknown; reason?: unknown }
    const pick = Number(parsed.pick)
    if (![1, 2, 3].includes(pick)) throw new Error(`pick=${String(parsed.pick)}`)
    return { pick, reason: String(parsed.reason ?? '').slice(0, 200), error: null }
  } catch (err) {
    return {
      pick: 1,
      reason: '首帧（Qwen2-VL 未给出可用结果；人物完整）',
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

const ffPath = (p: string) => `'${p.replace(/\\/g, '/').replace(/'/g, "\\'")}'`

function drawText(file: string, font: string | null, opts: { size: number; x: string; y: string; color?: string }): string {
  const fontArg = font ? `fontfile=${ffPath(font)}:` : ''
  return `drawtext=${fontArg}textfile=${ffPath(file)}:fontcolor=${opts.color ?? 'white'}:fontsize=${opts.size}:line_spacing=14:x=${opts.x}:y=${opts.y}`
}

/** Hard-wrap CJK text for drawtext (drawtext has no auto-wrap). */
/** Cover headline: drop the trailing technical parenthesis already shown as meta. */
function coverTitle(text: string): string {
  const short = text.replace(/（[^）]*）\s*$/, '').trim()
  return short || text
}

function wrapText(text: string, perLine: number, maxLines = 2): string {
  const chars = Array.from(text.trim())
  const lines: string[] = []
  for (let i = 0; i < chars.length && lines.length < maxLines; i += perLine) {
    lines.push(chars.slice(i, i + perLine).join(''))
  }
  if (chars.length > perLine * maxLines && lines.length > 0) {
    lines[lines.length - 1] = lines[lines.length - 1].slice(0, -1) + '…'
  }
  return lines.join('\n')
}

function buildCoverFilters(
  variant: CoverVariant,
  textDir: string,
  font: string | null,
  lines: string[]
): { filter: string; last: string } {
  const { width: W, height: H } = COVER_SIZES[variant]
  const [title, meta1, meta2, meta3, brand] = lines
  const files = {
    title: writeCoverText(textDir, 'title', title),
    meta1: writeCoverText(textDir, 'meta1', meta1),
    meta2: writeCoverText(textDir, 'meta2', meta2),
    meta3: writeCoverText(textDir, 'meta3', meta3),
    brand: writeCoverText(textDir, 'brand', brand)
  }
  const parts: string[] = []
  if (variant === '16x9') {
    parts.push(
      `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=24:2,eq=brightness=-0.10:saturation=0.85[bg]`,
      `[0:v]scale=-2:${H}[fg]`,
      `[bg][fg]overlay=(W-w)/2:0[base0]`
    )
  } else {
    parts.push(`[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}[base0]`)
  }
  let last = 'base0'
  let i = 0
  const chain = (filter: string) => {
    parts.push(`[${last}]${filter}[t${++i}]`)
    last = `t${i}`
  }
  if (variant === '16x9') {
    chain(`drawbox=x=1260:y=0:w=660:h=${H}:color=black@0.35:t=fill`)
    chain(drawText(files.title, font, { size: 46, x: '1310', y: '300' }))
    chain(drawText(files.meta1, font, { size: 30, x: '1310', y: '560', color: '0xE0E0E0' }))
    chain(drawText(files.meta2, font, { size: 30, x: '1310', y: '620', color: '0xE0E0E0' }))
    chain(drawText(files.meta3, font, { size: 30, x: '1310', y: '680', color: '0xE0E0E0' }))
    chain(drawText(files.brand, font, { size: 34, x: '1310', y: '980', color: '0xF2C14E' }))
  } else {
    chain(`drawbox=x=0:y=1360:w=${W}:h=560:color=black@0.55:t=fill`)
    chain(drawText(files.title, font, { size: 52, x: '80', y: '1400' }))
    chain(drawText(files.meta1, font, { size: 32, x: '80', y: '1600', color: '0xE0E0E0' }))
    chain(drawText(files.meta2, font, { size: 32, x: '80', y: '1660', color: '0xE0E0E0' }))
    chain(drawText(files.brand, font, { size: 36, x: '80', y: '1790', color: '0xF2C14E' }))
  }
  return { filter: parts.join(';'), last }
}

function writeCoverText(dir: string, name: string, text: string): string {
  const file = path.join(dir, `${name}.txt`)
  fs.writeFileSync(file, text, 'utf8')
  return file
}

function outputVideoFor(jobId: string): string | null {
  const outDir = path.join(DATA_ROOT, 'issue-19', `b-track-${jobId}`, 'out')
  return (
    listDir(outDir)
      .filter((f) => f.endsWith('.mp4'))
      .map((f) => path.join(outDir, f))
      .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0] ?? null
  )
}

async function recordArtifact(
  jobId: string,
  kind: string,
  relPath: string,
  file: string
): Promise<void> {
  const stat = fs.statSync(file)
  await dbTry(
    (db) =>
      db`
      insert into acceptance.artifacts (job_id, kind, path, size_bytes, sha256, mtime)
      values (${jobId}, ${kind}, ${relPath}, ${stat.size}, ${sha256File(file)}, ${new Date(stat.mtimeMs).toISOString()})
      on conflict (job_id, kind, path) do update set
        size_bytes = excluded.size_bytes, sha256 = excluded.sha256, mtime = excluded.mtime
    `
  )
}

type CoverResult = { status: number; body: unknown }

async function coverData(jobId: string, variant: CoverVariant, force: boolean): Promise<CoverResult> {
  const started = Date.now()
  const { source, items } = await loadSourceJobs()
  const item = items.find((j) => j.id === jobId)
  if (!item) return { status: 404, body: { error: `job ${jobId} not found` } }
  const video = outputVideoFor(jobId)
  if (!video) return { status: 404, body: { error: `job ${jobId} has no output video` } }

  const { width: W, height: H } = COVER_SIZES[variant]
  const outDir = path.join(DATA_ROOT, 'issue-19', `b-track-${jobId}`, 'out')
  const out = path.join(outDir, `cover_${variant}.jpg`)
  const relOut = rel(out)
  if (exists(out) && !force) {
    return {
      status: 200,
      body: {
        ok: true,
        provider: COVER_PROVIDER,
        path: relOut,
        url: mediaUrl(relOut),
        width: W,
        height: H,
        sha256: sha256File(out),
        sourceTs: null,
        pick: null,
        reason: 'cached',
        pipCropTop: 0,
        pipMask: PIP_MASK,
        cached: true,
        createdAt: fs.statSync(out).mtime.toISOString(),
        elapsedMs: Date.now() - started,
        meta: { source }
      }
    }
  }

  const info = videoInfo(video)
  const duration = item.durationS ?? info.durationS
  if (!duration || duration <= 0) {
    return {
      status: 422,
      body: { error: 'video duration unavailable', detail: 'ffprobe/ffmpeg 均无法读出时长' }
    }
  }
  const times = [0.2, 0.5, 0.8].map((p) => Math.max(0, Math.min(duration - 0.05, duration * p)))
  const frames = times.map((t) => extractCoverFrame(video, jobId, t, null, true))
  if (frames.some((f) => !f)) {
    return { status: 500, body: { error: 'frame extraction failed', times } }
  }
  const thumbs = times.map((t) => extractCoverFrame(video, jobId, t, 480, true))
  const scored =
    thumbs.every((t): t is string => Boolean(t))
      ? await scoreCoverFrames(thumbs)
      : { pick: 1, reason: '缩略帧抽取失败，使用首帧（人物完整）', error: 'thumb extraction failed' }

  const pickIndex = scored.pick - 1
  const frame = frames[pickIndex] as string
  const sourceTs = times[pickIndex]
  const font = pickCoverFont()
  const textDir = path.join(coverTmpDir(), `${jobId}-${variant}-${Date.now()}`)
  fs.mkdirSync(textDir, { recursive: true })
  const resText =
    item.width && item.height
      ? `${item.width}×${item.height}`
      : info.width && info.height
        ? `${info.width}×${info.height}`
        : '—'
  const lines = [
    wrapText(coverTitle(item.title), variant === '16x9' ? 10 : 14, 2),
    `轨道 B · ${duration.toFixed(1)}s`,
    `分辨率 ${resText}`,
    `验收 ${item.status}`,
    'Kex Labs'
  ]
  const { filter, last } = buildCoverFilters(variant, textDir, font, lines)
  try {
    execFileSync(
      FFMPEG_BIN,
      ['-v', 'error', '-i', frame, '-filter_complex', filter, '-map', `[${last}]`, '-frames:v', '1', '-q:v', '2', '-y', out],
      { timeout: 60000, stdio: ['ignore', 'ignore', 'pipe'] }
    )
  } catch (err) {
    return {
      status: 500,
      body: { error: 'cover_render_failed', detail: err instanceof Error ? err.message : String(err) }
    }
  }
  if (!exists(out)) return { status: 500, body: { error: 'cover_render_failed', detail: 'output missing' } }

  await recordArtifact(jobId, `cover_${variant === '16x9' ? '16x9' : '9x16'}`, relOut, out)
  return {
    status: 200,
    body: {
      ok: true,
      provider: COVER_PROVIDER,
      path: relOut,
      url: mediaUrl(relOut),
      width: W,
      height: H,
      sha256: sha256File(out),
      sourceTs: Number(sourceTs.toFixed(2)),
      pick: scored.pick,
      reason: scored.reason,
      pipCropTop: 0,
      pipMask: PIP_MASK,
      vlmError: scored.error,
      font: font ? path.basename(font) : null,
      cached: false,
      createdAt: new Date().toISOString(),
      elapsedMs: Date.now() - started,
      meta: { source }
    }
  }
}

function metricsStats(data: any): any {
  if (!data || !Array.isArray(data.rows) || !Array.isArray(data.columns)) return null
  const cols: string[] = data.columns
    .filter((c: string) => /ssim|lapvar|noise|ghost|tear|overshoot|skin|dE|net_gain|improve/i.test(c))
    .slice(0, 12)
  const stats = cols.map((c) => {
    const vals = data.rows
      .map((r: any) => Number(r[c]))
      .filter((n: number) => Number.isFinite(n))
    if (vals.length === 0) return { column: c, count: 0 }
    const mean = vals.reduce((a: number, b: number) => a + b, 0) / vals.length
    return {
      column: c,
      count: vals.length,
      mean: Number(mean.toFixed(4)),
      min: Number(Math.min(...vals).toFixed(4)),
      max: Number(Math.max(...vals).toFixed(4))
    }
  })
  return { rows: data.rows.length, stats, source: data.source ?? null }
}

function validateExplain(x: any): string | null {
  if (!x || typeof x !== 'object') return 'not an object'
  if (typeof x.summary !== 'string' || !x.summary.trim()) return 'summary'
  if (typeof x.verdict_explained !== 'string' || !x.verdict_explained.trim()) return 'verdict_explained'
  for (const key of ['items', 'issues', 'suggestions']) {
    if (!Array.isArray(x[key])) return key
  }
  return null
}

async function explainJob(jobId: string, force: boolean): Promise<CoverResult> {
  const started = Date.now()
  const { source, items, criteria, summaries } = await loadSourceJobs()
  const item = items.find((j) => j.id === jobId)
  if (!item) return { status: 404, body: { error: `job ${jobId} not found` } }

  const gates = (criteria.get(jobId) ?? []).map((c) => ({
    key: c.key,
    name: c.name,
    value: c.value,
    threshold: c.threshold,
    pass: c.pass,
    explain: c.explain
  }))
  const metrics = metricsStats(await qcDataAny(jobId))
  const video = outputVideoFor(jobId)
  let framesAt: number[] = []
  let frames: string[] = []
  if (video) {
    const info = videoInfo(video)
    const duration = item.durationS ?? info.durationS
    if (duration && duration > 0) {
      framesAt = [0.2, 0.8].map((p) => Number((duration * p).toFixed(2)))
      frames = framesAt
        .map((t) => extractCoverFrame(video, jobId, t, 640))
        .filter((f): f is string => Boolean(f))
    }
  }
  const input = {
    job: {
      id: item.id,
      title: item.title,
      status: item.status,
      statusLabel: item.statusLabel,
      statusNote: item.statusNote,
      passed: item.passed,
      total: item.total,
      judged: item.judged,
      durationS: item.durationS,
      width: item.width,
      height: item.height
    },
    gates,
    metrics,
    summary: summaries.get(jobId)?.aggregate ?? null,
    keyframes: framesAt
  }
  const inputSha = sha256Text(JSON.stringify(input))
  const cacheFile = path.join(DATA_ROOT, '.cache', 'explain', `${jobId}.json`)
  const cached = readJson(cacheFile)
  if (cached && !force && cached.inputSha === inputSha && cached.data) {
    return {
      status: 200,
      body: {
        ...cached.data,
        disclaimer: EXPLAIN_DISCLAIMER,
        model: cached.model,
        createdAt: cached.createdAt,
        cached: true,
        elapsedMs: Date.now() - started,
        meta: { source }
      }
    }
  }

  const gateLines = gates.map((g) => {
    const verdict = g.pass === null ? '未判定' : g.pass ? 'pass' : 'fail'
    return `- ${g.key} ${g.name}: 值 ${g.value}；阈值 ${g.threshold}；判定 ${verdict}`
  })
  const prompt = [
    '你是 Kex Labs 的视频验收解读助手。只根据下面给出的 gate 判据、指标统计和关键帧解释本次验收结果，不要编造未给出的数字。',
    `最终结论：${item.statusLabel}（${item.statusNote}）`,
    `gate 共 ${gates.length} 项：`,
    ...gateLines,
    `指标统计：${JSON.stringify(metrics?.stats ?? [])}`,
    '要求：',
    `1) items 必须恰好 ${gates.length} 项，顺序与上面 gate 一致，每项 key 用给出的键；why 必须引用该 gate 的具体数值与阈值。`,
    '2) verdict_explained 必须解释最终结论；若 FAIL，必须点名未通过的 gate 及其数字。',
    '3) summary 一句话概括。',
    '4) issues 列出每个失败 gate（全部通过时才可为空数组）；suggestions 针对失败项给可执行建议。',
    '5) gate 的判定是既定事实，不能改写，只能解释。',
    '只输出 JSON，结构：{"summary":"一句话","verdict_explained":"为什么 FAIL/PASS","items":[{"key":"B2","plain":"白话解释","status":"pass|fail","why":"依据哪个数字"}],"issues":[{"title":"...","severity":"low|mid|high","evidence":"..."}],"suggestions":[{"action":"...","expected":"...","feasible":"yes|no"}]}',
    '中文输出。'
  ].join('\n')

  let parsed: any
  try {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: QWEN_VL_MODEL,
        prompt,
        images: frames.map((f) => fs.readFileSync(f).toString('base64')),
        stream: false,
        format: 'json',
        options: { temperature: 0.1, num_predict: 1400 }
      }),
      signal: AbortSignal.timeout(60000)
    })
    if (!res.ok) {
      return {
        status: 503,
        body: { code: 'llm_unavailable', detail: `Ollama HTTP ${res.status}`, model: QWEN_VL_MODEL }
      }
    }
    const body = (await res.json()) as { response?: string }
    const text = String(body.response ?? '').trim()
    try {
      parsed = JSON.parse(text)
    } catch {
      return {
        status: 503,
        body: {
          code: 'llm_bad_json',
          detail: '模型输出不是合法 JSON',
          raw: text.slice(0, 500),
          model: QWEN_VL_MODEL
        }
      }
    }
  } catch (err) {
    return {
      status: 503,
      body: {
        code: 'llm_unavailable',
        detail: err instanceof Error ? err.message : String(err),
        model: QWEN_VL_MODEL,
        url: OLLAMA_URL
      }
    }
  }

  const invalid = validateExplain(parsed)
  if (invalid) {
    return {
      status: 503,
      body: { code: 'llm_bad_json', detail: `字段校验失败：${invalid}`, model: QWEN_VL_MODEL }
    }
  }

  const record = {
    model: QWEN_VL_MODEL,
    createdAt: new Date().toISOString(),
    inputSha,
    disclaimer: EXPLAIN_DISCLAIMER,
    data: parsed
  }
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true })
    atomicWriteJson(cacheFile, record)
  } catch (err) {
    console.error('[explain] cache write failed:', err instanceof Error ? err.message : err)
  }
  await dbTry((db) => writeSnapshot(db, 'explain', record, rel(cacheFile)))

  return {
    status: 200,
    body: {
      ...parsed,
      disclaimer: EXPLAIN_DISCLAIMER,
      model: QWEN_VL_MODEL,
      createdAt: record.createdAt,
      cached: false,
      elapsedMs: Date.now() - started,
      keyframes: framesAt,
      meta: { source }
    }
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(payload)
}

const MEDIA_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp'
}

function serveMedia(req: IncomingMessage, res: ServerResponse, filePath: string) {
  if (!exists(filePath)) {
    sendJson(res, 404, { error: 'media not found' })
    return
  }
  const stat = fs.statSync(filePath)
  const type = MEDIA_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('Content-Type', type)
  res.setHeader('Cache-Control', 'private, max-age=60')

  const range = req.headers.range
  if (!range) {
    res.statusCode = 200
    res.setHeader('Content-Length', stat.size)
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    fs.createReadStream(filePath).pipe(res)
    return
  }

  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
  if (!m || (!m[1] && !m[2])) {
    res.statusCode = 416
    res.setHeader('Content-Range', `bytes */${stat.size}`)
    res.end()
    return
  }
  let start = m[1] ? Number(m[1]) : 0
  let end = m[2] ? Number(m[2]) : stat.size - 1
  if (!m[1] && m[2]) {
    const suffix = Number(m[2])
    start = Math.max(0, stat.size - suffix)
    end = stat.size - 1
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= stat.size) {
    res.statusCode = 416
    res.setHeader('Content-Range', `bytes */${stat.size}`)
    res.end()
    return
  }
  end = Math.min(end, stat.size - 1)
  res.statusCode = 206
  res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`)
  res.setHeader('Content-Length', end - start + 1)
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  fs.createReadStream(filePath, { start, end }).pipe(res)
}

// ---------------------------------------------------------------------------
// Issue backlog (`issue-N/` directories): read-only scan + append-only create.
// ---------------------------------------------------------------------------

type IssueItem = {
  id: string
  number: number
  title: string
  description: string | null
  owner: string | null
  rail: string | null
  priority: string | null
  status: 'open' | 'closed' | 'doing' | 'blocked' | 'done' | null
  created_at: string | null
  updated_at: string | null
  dir: string | null
  source: 'issue.json' | 'readme' | 'dir' | 'gitea'
  /** Gitea page for the issue (files fallback leaves these undefined). */
  url?: string
  labels?: { name: string; color: string }[]
  comments?: number
  /** issue #77: task cards are hidden from the default list, not deleted. */
  is_task_card: boolean
  manual_verify: ManualVerifyState
  manual_verify_note: string | null
  manual_verify_key: string
}

const ISSUE_DIR_RE = /^issue-(\d+)$/
const ISSUE_STATUSES: readonly string[] = ['open', 'doing', 'blocked', 'done']
const ISSUE_RAILS: readonly string[] = ['A', 'B', '双轨', 'AB']
const ISSUE_PRIORITIES: readonly string[] = ['P0', 'P1', 'P2', 'P3']

const issueText = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null

const issueIso = (value: unknown): string | null =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null

function issueReadmeTitle(dir: string): string | null {
  try {
    for (const line of fs.readFileSync(path.join(dir, 'README.md'), 'utf8').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      return trimmed.replace(/^#+\s*/, '').trim() || null
    }
  } catch {
    return null
  }
  return null
}

function issueDirCreatedAt(abs: string): string | null {
  try {
    const stat = fs.statSync(abs)
    return new Date(stat.birthtimeMs || stat.mtimeMs).toISOString()
  } catch {
    return null
  }
}

/**
 * Scan `ISSUE_ROOT` for direct `issue-N` directories. Unreadable dirs and broken
 * `issue.json` files degrade to README/dir-name metadata instead of failing the page.
 */
function scanIssues(): IssueItem[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(ISSUE_ROOT, { withFileTypes: true })
  } catch {
    return []
  }
  const items: IssueItem[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue // symlinks and plain files are skipped
    const match = ISSUE_DIR_RE.exec(entry.name)
    if (!match) continue
    const number = Number(match[1])
    const abs = path.join(ISSUE_ROOT, entry.name)
    const parsed = readJson(path.join(abs, 'issue.json'))
    const json = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
    const readmeTitle = issueReadmeTitle(abs)
    const jsonTitle = issueText(json?.title)
    const status = issueText(json?.status)
    items.push({
      id: `issue-${number}`,
      number,
      title: jsonTitle ?? readmeTitle ?? entry.name,
      description: issueText(json?.description),
      owner: issueText(json?.owner),
      rail: issueText(json?.rail),
      priority: issueText(json?.priority),
      status: status && ISSUE_STATUSES.includes(status) ? (status as IssueItem['status']) : null,
      created_at: issueIso(json?.created_at) ?? issueDirCreatedAt(abs),
      updated_at: issueIso(json?.updated_at),
      dir: entry.name,
      source: json ? 'issue.json' : readmeTitle ? 'readme' : 'dir',
      is_task_card: false,
      manual_verify: 'pending',
      manual_verify_note: null,
      manual_verify_key: verifyKeyForIssue(number)
    })
  }
  items.sort((a, b) => {
    const at = a.created_at ? Date.parse(a.created_at) : 0
    const bt = b.created_at ? Date.parse(b.created_at) : 0
    return bt - at || b.number - a.number
  })
  return items
}

export type IssueFields = {
  title: string
  description: string | null
  owner: string | null
  rail: string | null
  priority: string | null
}

function validateIssue(body: any): { fields: IssueFields } | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'body: 必须是 JSON 对象' }
  }
  if (typeof body.title !== 'string' || !body.title.trim()) {
    return { error: 'title: 必填' }
  }
  const title = body.title.trim()
  if (title.length > 120) return { error: 'title: 长度需 1..120' }
  const optional = (key: 'description' | 'owner' | 'rail' | 'priority'): string | null | { error: string } => {
    const value = body[key]
    if (value === undefined || value === null) return null
    if (typeof value !== 'string') return { error: `${key}: 必须是字符串` }
    return value.trim() || null
  }
  const values: Record<'description' | 'owner' | 'rail' | 'priority', string | null> = {
    description: null,
    owner: null,
    rail: null,
    priority: null
  }
  for (const key of ['description', 'owner', 'rail', 'priority'] as const) {
    const value = optional(key)
    if (value && typeof value === 'object') return value
    values[key] = value
  }
  if (values.description && values.description.length > 2000) {
    return { error: 'description: 长度不能超过 2000' }
  }
  if (values.owner && values.owner.length > 60) return { error: 'owner: 长度不能超过 60' }
  if (values.rail && !ISSUE_RAILS.includes(values.rail)) {
    return { error: 'rail: 只能是 A/B/双轨/AB' }
  }
  if (values.priority && !ISSUE_PRIORITIES.includes(values.priority)) {
    return { error: 'priority: 只能是 P0/P1/P2/P3' }
  }
  return { fields: { title, ...values } }
}

/** Comment body limits (#110): 1..8000 characters after trimming. */
export const ISSUE_COMMENT_MAX = 8000

export function validateIssueComment(body: any): { body: string } | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'body: 必须是 JSON 对象' }
  }
  if (typeof body.body !== 'string') return { error: 'body: 必填' }
  const text = body.body.trim()
  if (!text) return { error: 'body: 长度需 1..8000' }
  if (text.length > ISSUE_COMMENT_MAX) return { error: 'body: 长度需 1..8000' }
  return { body: text }
}

function writeFileAtomic(file: string, content: string) {
  const tmp = `${file}.tmp-${crypto.randomBytes(6).toString('hex')}`
  fs.writeFileSync(tmp, content, 'utf8')
  fs.renameSync(tmp, file)
}

function issueErrorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function issueMeta() {
  return { root: ISSUE_ROOT, writable: !ISSUE_WRITE_DISABLED, scanned_at: new Date().toISOString() }
}

async function handleIssuePost(req: IncomingMessage, res: ServerResponse) {
  if (ISSUE_WRITE_DISABLED) {
    sendJson(res, 403, { error: 'issues write disabled' })
    return
  }
  if (ISSUE_TOKEN !== null && req.headers['x-web-token'] !== ISSUE_TOKEN) {
    sendJson(res, 401, { error: 'invalid X-Web-Token' })
    return
  }
  let body: any
  try {
    body = await readRequestBody(req)
  } catch (err) {
    sendJson(res, 400, { error: issueErrorText(err) })
    return
  }
  const validated = validateIssue(body)
  if ('error' in validated) {
    sendJson(res, 400, { error: validated.error })
    return
  }
  const fields = validated.fields

  let numbers: number[]
  try {
    numbers = fs
      .readdirSync(ISSUE_ROOT)
      .map((name) => ISSUE_DIR_RE.exec(name))
      .filter((m): m is RegExpExecArray => Boolean(m))
      .map((m) => Number(m[1]))
  } catch {
    numbers = []
  }
  let number = numbers.length ? Math.max(...numbers) + 1 : 1

  let createdDir: string | null = null
  try {
    fs.mkdirSync(ISSUE_ROOT, { recursive: true })
  } catch (err) {
    sendJson(res, 500, { error: `issues root unavailable: ${issueErrorText(err)}` })
    return
  }
  for (let attempt = 0; attempt < 5 && !createdDir; attempt += 1) {
    const abs = path.join(ISSUE_ROOT, `issue-${number}`)
    try {
      fs.mkdirSync(abs, { recursive: false })
      createdDir = abs
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        number += 1
        continue
      }
      console.error('[issues] mkdir failed:', issueErrorText(err))
      sendJson(res, 500, { error: `issue dir create failed: ${issueErrorText(err)}` })
      return
    }
  }
  if (!createdDir) {
    sendJson(res, 500, { error: 'issue number allocation failed' })
    return
  }

  let rootReal: string
  let dirReal: string
  try {
    rootReal = fs.realpathSync(ISSUE_ROOT)
    dirReal = fs.realpathSync(createdDir)
  } catch (err) {
    fs.rmSync(createdDir, { recursive: true, force: true })
    sendJson(res, 500, { error: `issue dir verify failed: ${issueErrorText(err)}` })
    return
  }
  if (dirReal !== rootReal && !dirReal.startsWith(rootReal + path.sep)) {
    fs.rmSync(createdDir, { recursive: true, force: true })
    sendJson(res, 403, { error: 'path outside WEB_ISSUE_ROOT' })
    return
  }

  const now = new Date().toISOString()
  const id = `issue-${number}`
  const record = {
    id,
    number,
    ...fields,
    status: 'open',
    created_at: now,
    updated_at: now,
    source: 'web'
  }
  const readme = [
    `# ${fields.title}`,
    ...(fields.description ? ['', fields.description] : []),
    '',
    `- 创建：${now}`,
    `- 负责人：${fields.owner ?? '—'}`
  ].join('\n')
  try {
    writeFileAtomic(path.join(createdDir, 'issue.json'), JSON.stringify(record, null, 2) + '\n')
    writeFileAtomic(path.join(createdDir, 'README.md'), readme + '\n')
  } catch (err) {
    fs.rmSync(createdDir, { recursive: true, force: true })
    sendJson(res, 500, { error: `issue write failed: ${issueErrorText(err)}` })
    return
  }

  const item: IssueItem = {
    id,
    number,
    title: fields.title,
    description: fields.description,
    owner: fields.owner,
    rail: fields.rail,
    priority: fields.priority,
    status: 'open',
    created_at: now,
    updated_at: now,
    dir: `issue-${number}`,
    source: 'issue.json',
    is_task_card: false,
    manual_verify: 'pending',
    manual_verify_note: null,
    manual_verify_key: verifyKeyForIssue(number)
  }
  sendJson(res, 201, { item, meta: issueMeta() })
}

// ---------------------------------------------------------------------------
// Gitea-backed issue source (T-WEB-017a, default). `files` keeps the local scan.
// ---------------------------------------------------------------------------

const ISSUE_STATE_VALUES: readonly GiteaIssueState[] = ['open', 'closed', 'all']

type IssueClassification = {
  real: { open: number; closed: number; total: number }
  task_cards: { open: number; closed: number; total: number }
}

function giteaMeta(
  counts?: { open: number; closed: number; total: number; fetched_at: string },
  classification?: IssueClassification
) {
  const { repo, web_url } = giteaInfo()
  return {
    source: 'gitea' as const,
    repo,
    web_url,
    writable: !ISSUE_WRITE_DISABLED,
    scanned_at: new Date().toISOString(),
    ...(counts
      ? {
          counts: {
            open: counts.open,
            closed: counts.closed,
            total: counts.total,
            ...(classification ? { classification } : {})
          },
          fetched_at: counts.fetched_at
        }
      : {})
  }
}

/** Attach the persisted tri-state and the shared task-card key to one issue. */
function decorateIssue(item: IssueItem, store: ManualVerifyStore): IssueItem {
  const key = verifyKeyForIssue(item.number)
  const view = manualVerifyForKey(store, key)
  return {
    ...item,
    is_task_card: isAcceptanceTaskCard(item),
    manual_verify: view.state,
    manual_verify_note: view.note,
    manual_verify_key: key
  }
}

/** Same overlay for a task from `/api/plan` (falls back to the task id). */
function decorateTask(task: TaskItem, store: ManualVerifyStore): TaskItem & {
  manual_verify: ManualVerifyState
  manual_verify_key: string
  manual_verify_note: string | null
} {
  const key =
    typeof task.issue_number === 'number' ? verifyKeyForIssue(task.issue_number) : `task:${task.id}`
  const view = manualVerifyForKey(store, key)
  return {
    ...task,
    manual_verify: view.state,
    manual_verify_key: key,
    manual_verify_note: view.note
  }
}

/** Failing items first (stable: previous order is kept inside each rank). */
function sortByManualVerify<T extends { manual_verify: ManualVerifyState }>(items: T[]): T[] {
  return items
    .slice()
    .sort((a, b) => verifyRank(a.manual_verify) - verifyRank(b.manual_verify))
}

async function handleGiteaIssuesGet(url: URL, res: ServerResponse) {
  const stateParam = (url.searchParams.get('state') ?? 'open').trim().toLowerCase()
  const state = ISSUE_STATE_VALUES.includes(stateParam as GiteaIssueState)
    ? (stateParam as GiteaIssueState)
    : null
  if (!state) {
    sendJson(res, 400, { error: 'state: open|closed|all' })
    return
  }
  // issue #77: task cards are board data, hidden by default, never deleted.
  const kindParam = (url.searchParams.get('kind') ?? 'real').trim().toLowerCase()
  const kind = ['real', 'tasks', 'all'].includes(kindParam) ? kindParam : null
  if (!kind) {
    sendJson(res, 400, { error: 'kind: real|tasks|all' })
    return
  }
  const rawLimit = Number(url.searchParams.get('limit') ?? '200')
  const rawPage = Number(url.searchParams.get('page') ?? '1')
  const limit = Number.isInteger(rawLimit) ? Math.min(200, Math.max(1, rawLimit)) : 200
  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1
  try {
    const all = await giteaListAllIssues()
    const classification = classifyIssueCounts(all)
    const store = readManualVerify(MANUAL_VERIFY_FILE)
    const inState = state === 'all' ? all : all.filter((item) => item.status === state)
    const decorated = inState.map((item) => decorateIssue(item as unknown as IssueItem, store))
    const filtered = decorated.filter((item) =>
      kind === 'all' ? true : kind === 'tasks' ? item.is_task_card : !item.is_task_card
    )
    const ordered = sortByManualVerify(filtered)
    const items = ordered.slice((page - 1) * limit, page * limit)
    const open = all.filter((item) => item.status === 'open').length
    const closed = all.length - open
    sendJson(res, 200, {
      available: true,
      kind,
      items,
      count: items.length,
      total: ordered.length,
      latest: items[0] ?? null,
      classification,
      meta: giteaMeta(
        { open, closed, total: all.length, fetched_at: new Date().toISOString() },
        classification
      )
    })
  } catch (err) {
    const reason = err instanceof GiteaError ? `gitea ${err.reason}` : 'gitea unavailable'
    if (!(err instanceof GiteaError)) {
      console.error('[issues] gitea read failed:', issueErrorText(err))
    }
    sendJson(res, 200, {
      available: false,
      reason,
      kind,
      items: [],
      count: 0,
      total: 0,
      latest: null,
      meta: giteaMeta()
    })
  }
}

async function handleGiteaIssuePost(req: IncomingMessage, res: ServerResponse) {
  if (ISSUE_WRITE_DISABLED) {
    sendJson(res, 403, { error: 'issues write disabled' })
    return
  }
  if (ISSUE_TOKEN !== null && req.headers['x-web-token'] !== ISSUE_TOKEN) {
    sendJson(res, 401, { error: 'invalid X-Web-Token' })
    return
  }
  let body: any
  try {
    body = await readRequestBody(req)
  } catch (err) {
    sendJson(res, 400, { error: issueErrorText(err) })
    return
  }
  const validated = validateIssue(body)
  if ('error' in validated) {
    sendJson(res, 400, { error: validated.error })
    return
  }
  if (!giteaConfigured()) {
    sendJson(res, 503, { error: 'gitea not configured' })
    return
  }
  try {
    const item = await giteaCreateIssue(validated.fields)
    sendJson(res, 201, { item, meta: giteaMeta() })
  } catch (err) {
    console.error(
      '[issues] gitea create failed:',
      err instanceof GiteaError ? err.reason : issueErrorText(err)
    )
    sendJson(res, 502, { error: 'gitea create failed' })
  }
}

/** Sanitized error text for the issue detail endpoints (no token / upstream body). */
function issueGiteaErrorText(err: unknown): string {
  if (err instanceof GiteaError) return `gitea ${err.reason}`
  console.error('[issues] gitea detail failed:', issueErrorText(err))
  return 'gitea unavailable'
}

/** `GET /api/issues/:n` — issue detail + comments in one read (#110). */
async function handleGiteaIssueDetailGet(number: number, res: ServerResponse) {
  try {
    const [item, comments] = await Promise.all([
      giteaIssueDetail(number),
      giteaIssueComments(number)
    ])
    sendJson(res, 200, { item, comments, meta: giteaMeta() })
  } catch (err) {
    const reason = issueGiteaErrorText(err)
    if (err instanceof GiteaError && err.status === 404) {
      sendJson(res, 404, { error: `issue #${number} not found` })
      return
    }
    sendJson(res, err instanceof GiteaError && err.reason === 'not configured' ? 503 : 502, {
      error: reason
    })
  }
}

/** `POST /api/issues/:n/comments` — same-origin/token guarded write (#110). */
async function handleGiteaIssueCommentPost(
  req: IncomingMessage,
  res: ServerResponse,
  number: number
) {
  if (ISSUE_WRITE_DISABLED) {
    sendJson(res, 403, { error: 'issues write disabled' })
    return
  }
  const auth = authorizeTaskWrite(req)
  if (!auth.ok) {
    sendJson(res, auth.status, { error: auth.error })
    return
  }
  let body: any
  try {
    body = await readRequestBody(req)
  } catch (err) {
    sendJson(res, 400, { error: issueErrorText(err) })
    return
  }
  const validated = validateIssueComment(body)
  if ('error' in validated) {
    sendJson(res, 400, { error: validated.error })
    return
  }
  if (!giteaConfigured()) {
    sendJson(res, 503, { error: 'gitea not configured' })
    return
  }
  try {
    const comment = await giteaAddIssueComment(number, validated.body)
    sendJson(res, 201, { comment, meta: giteaMeta() })
  } catch (err) {
    const reason = issueGiteaErrorText(err)
    if (err instanceof GiteaError && err.status === 404) {
      sendJson(res, 404, { error: `issue #${number} not found` })
      return
    }
    sendJson(res, err instanceof GiteaError && err.reason === 'not configured' ? 503 : 502, {
      error: reason
    })
  }
}

/** True for requests that reached us over the loopback interface. */
function isLoopback(req: IncomingMessage): boolean {  const addr = req.socket.remoteAddress ?? ''
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

/**
 * `POST /api/gitea/reconcile?dryRun=1` — create the task issues that are
 * missing from Gitea. Create-only and idempotent: existing issues are skipped,
 * nothing is deleted or overwritten. Guarded by `WEB_WRITE_TOKEN` (or
 * `WEB_GITEA_SYNC_TOKEN`); without either it only answers on loopback.
 */
async function handleTaskReconcile(req: IncomingMessage, url: URL, res: ServerResponse) {
  const token = process.env.WEB_WRITE_TOKEN || process.env.WEB_GITEA_SYNC_TOKEN || null
  if (token) {
    if (req.headers['x-web-token'] !== token) {
      sendJson(res, 401, { error: 'invalid X-Web-Token' })
      return
    }
  } else if (!isLoopback(req)) {
    sendJson(res, 403, { error: 'set WEB_WRITE_TOKEN or WEB_GITEA_SYNC_TOKEN to reconcile remotely' })
    return
  }
  const plan = readJson(PLAN_FILE)
  if (!plan || !Array.isArray(plan.tasks)) {
    sendJson(res, 503, { error: `plan file missing or invalid: ${PLAN_FILE}` })
    return
  }
  const dryRun = ['1', 'true', 'yes'].includes(
    (url.searchParams.get('dryRun') ?? '').trim().toLowerCase()
  )
  try {
    const result = await giteaReconcileTasks(plan.tasks, { dryRun })
    sendJson(res, 200, result)
  } catch (err) {
    console.error(
      '[reconcile] gitea task reconcile failed:',
      err instanceof GiteaError ? err.reason : issueErrorText(err)
    )
    sendJson(res, 502, { error: 'gitea reconcile failed' })
  }
}

/**
 * #107 `DELETE /api/deliveries/:id` 的生产实现，抽成可注入 `dataRoot` / `env`
 * 的函数，单测（server/deliveries-delete.test.ts）用临时目录驱动同一条路径。
 * 返回 true 表示请求已被本路由处理（含 405/4xx），false 交给后续路由。
 */
export function handleDeliveryDelete(
  req: IncomingMessage,
  res: ServerResponse,
  dataRoot: string = DATA_ROOT,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  let pathname: string
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)
  } catch {
    pathname = new URL(req.url ?? '/', 'http://localhost').pathname
  }
  const match = pathname.match(/^\/api\/deliveries\/([^/]+)$/)
  if (!match) return false
  if (req.method !== 'DELETE') {
    res.statusCode = 405
    res.setHeader('Allow', 'DELETE')
    res.end()
    return true
  }
  const auth = authorizeTaskWrite(req, env)
  if (!auth.ok) {
    sendJson(res, auth.status, { error: auth.error })
    return true
  }
  let id = match[1]
  try {
    id = decodeURIComponent(id)
  } catch {
    /* 非法百分号编码 → 交给白名单校验返回 400 */
  }
  let result: TrashResult
  try {
    result = trashDelivery(id, dataRoot)
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : 'trash failed' })
    return true
  }
  if (!result.ok) {
    sendJson(res, result.status, { error: result.error })
    return true
  }
  sendJson(res, 200, {
    ok: true,
    jobId: result.jobId,
    movedTo: result.movedTo,
    bytes: result.bytes,
    files: result.files
  })
  return true
}

/** `/api/risk-decisions` 的注入点，单测用临时目录 + 假任务/假评论驱动同一条路径。 */
export type RiskDecisionsDeps = {
  dataRoot: string
  env: NodeJS.ProcessEnv
  listTasks: () => Promise<RiskTask[]>
  addComment: AddRiskComment
}

/**
 * #108 `GET/POST /api/risk-decisions`。
 *  - GET  ?task=  倒序列表（不传 task 返回全部）；
 *  - POST 同源/token 守卫 → 校验 → 查任务 → 通知 Gitea → 落 jsonl。
 * 返回 true 表示请求已被本路由处理。
 */
export async function handleRiskDecisionsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  pathname: string,
  deps: RiskDecisionsDeps
): Promise<boolean> {
  if (pathname !== '/api/risk-decisions') return false

  if (req.method === 'GET' || req.method === 'HEAD') {
    const decisions = listRiskDecisions(deps.dataRoot, url.searchParams.get('task'))
    sendJson(res, 200, { decisions })
    return true
  }

  if (req.method !== 'POST') {
    res.statusCode = 405
    res.setHeader('Allow', 'GET, HEAD, POST')
    res.end()
    return true
  }

  const auth = authorizeTaskWrite(req, deps.env)
  if (!auth.ok) {
    sendJson(res, auth.status, { error: auth.error })
    return true
  }

  let body: unknown
  try {
    body = await readRequestBody(req)
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : 'bad body' })
    return true
  }
  const validated = validateRiskDecision(body)
  if (!validated.ok) {
    sendJson(res, 400, { error: validated.error })
    return true
  }

  let tasks: RiskTask[]
  try {
    tasks = await deps.listTasks()
  } catch (err) {
    sendJson(res, 503, {
      error: `任务计划不可用：${err instanceof Error ? err.message : 'plan unavailable'}`
    })
    return true
  }
  const task = tasks.find((item) => item.id === validated.value.task_id) ?? null

  try {
    const decision = await createRiskDecision({
      dataRoot: deps.dataRoot,
      input: validated.value,
      task,
      addComment: deps.addComment
    })
    sendJson(res, 201, { decision })
  } catch (err) {
    if (err instanceof RiskDecisionError) {
      sendJson(res, err.status, { error: err.message })
      return true
    }
    console.error('[risk-decisions] unexpected:', issueErrorText(err))
    sendJson(res, 500, { error: 'internal error' })
  }
  return true
}

/** 生产依赖：任务来自 `readPlanData()`（`id → issue_number`），评论走 Gitea。 */
async function riskDecisionDeps(): Promise<RiskDecisionsDeps> {
  return {
    dataRoot: DATA_ROOT,
    env: process.env,
    listTasks: async () => {
      const plan = await readPlanData()
      if (plan.error) throw new Error(plan.error)
      const tasks = Array.isArray(plan.data?.tasks) ? (plan.data.tasks as any[]) : []
      return tasks.map((task) => ({
        id: String(task.id),
        title: typeof task.title === 'string' ? task.title : undefined,
        issue_number: typeof task.issue_number === 'number' ? task.issue_number : null
      }))
    },
    addComment: async (issueNumber, commentBody) => {
      try {
        const comment = await giteaAddIssueComment(issueNumber, commentBody)
        return { id: comment.id, url: comment.url || null }
      } catch (err) {
        if (err instanceof GiteaError && err.reason === 'not configured') {
          throw new RiskDecisionError(503, 'Gitea 未配置，无法通知开发')
        }
        throw err
      }
    }
  }
}

export async function handler(req: IncomingMessage, res: ServerResponse, next: Connect.NextFunction) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const pathname = decodeURIComponent(url.pathname)

  if (pathname === '/api/uploads' || pathname.startsWith('/api/uploads/')) {
    await handleUploadsRoute(req, res, url, pathname, {
      dataRoot: DATA_ROOT,
      intakeUrl: STUDIO_INTAKE_URL,
      intakeTimeoutMs: STUDIO_INTAKE_TIMEOUT_MS,
      webToken: process.env.WEB_WRITE_TOKEN ?? null,
      isSameOrigin: isSameOriginRequest,
      sendJson,
      readJson,
      atomicWriteJson,
      readBody: readRequestBody,
      maxBytes: UPLOAD_MAX_BYTES
    })
    return
  }

  if (pathname === '/api/studio' || pathname.startsWith('/api/studio/')) {
    await handleStudioRoute(req, res, url, pathname, {
      dataRoot: DATA_ROOT,
      intakeUrl: STUDIO_INTAKE_URL,
      timeoutMs: STUDIO_INTAKE_TIMEOUT_MS,
      webToken: process.env.WEB_WRITE_TOKEN ?? null,
      isSameOrigin: isSameOriginRequest,
      sendJson,
      readJson,
      atomicWriteJson,
      readBody: readRequestBody
    })
    return
  }

  if (pathname === '/api/agents' || pathname.startsWith('/api/agents/')) {
    await handleAgentsRoute(req, res, url, pathname, {
      dataRoot: DATA_ROOT,
      webToken: process.env.WEB_WRITE_TOKEN ?? null,
      isSameOrigin: isSameOriginRequest,
      sendJson,
      readJson,
      atomicWriteJson
    })
    return
  }

  if (pathname === '/api/system') {
    sendJson(res, 200, await systemStatus())
    return
  }

  if (pathname === '/api/overview') {
    sendJson(res, 200, await overviewData())
    return
  }

  if (pathname === '/api/flow') {
    const result = await flowData(url)
    sendJson(res, result.status, result.body)
    return
  }

  if (pathname === '/api/contract') {
    const result = await contractData()
    sendJson(res, result.status, result.body)
    return
  }

  if (pathname === '/api/snapshot') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405
      res.setHeader('Allow', 'GET, HEAD')
      res.end()
      return
    }
    const source = url.searchParams.get('source')
    if (source !== 'b-track' && source !== 'studio') {
      sendJson(res, 400, { error: 'invalid source' })
      return
    }
    const job = url.searchParams.get('job')
    if (!job) {
      sendJson(res, 400, { error: 'job is required' })
      return
    }
    if (!isSafeJobId(job)) {
      sendJson(res, 400, { error: 'invalid job id' })
      return
    }
    sendJson(res, 200, await buildSnapshot({ source, jobId: job }))
    return
  }

  if (pathname === '/api/risk-decisions') {
    await handleRiskDecisionsRoute(req, res, url, pathname, await riskDecisionDeps())
    return
  }

  if (pathname === '/api/reports/weekly') {
    const days = Number(url.searchParams.get('days') ?? '7')
    const plan = await readPlanData()
    const result = await weeklyReport(days, plan.error ? null : plan.data?.tasks)
    sendJson(res, result.status, result.body)
    return
  }

  if (pathname === '/api/gitea/reconcile') {
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.setHeader('Allow', 'POST')
      res.end()
      return
    }
    await handleTaskReconcile(req, url, res)
    return
  }

  if (pathname === '/api/intake/health') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405
      res.setHeader('Allow', 'GET, HEAD')
      res.end()
      return
    }
    await proxyIntake(res, '/intake/health', { method: 'GET' })
    return
  }

  if (pathname === '/api/intake/jobs') {
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.setHeader('Allow', 'POST')
      res.end()
      return
    }
    await handleIntakePost(req, res)
    return
  }

  const intakeJobMatch = pathname.match(/^\/api\/intake\/jobs\/([^/]+)$/)
  if (intakeJobMatch) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405
      res.setHeader('Allow', 'GET, HEAD')
      res.end()
      return
    }
    await handleIntakeJobGet(req, res, intakeJobMatch[1])
    return
  }

  if (pathname === '/api/manual-verify') {
    if (req.method === 'GET' || req.method === 'HEAD') {
      const store = readManualVerify(MANUAL_VERIFY_FILE)
      const keyParam = url.searchParams.get('key')
      if (keyParam !== null) {
        const key = normalizeVerifyKey(keyParam)
        if (!key) {
          sendJson(res, 400, { error: 'key: 需为 1..80 字符' })
          return
        }
        sendJson(res, 200, manualVerifyForKey(store, key))
        return
      }
      const counts = { pass: 0, fail: 0 }
      for (const entry of Object.values(store.items)) counts[entry.state] += 1
      sendJson(res, 200, { items: store.items, counts })
      return
    }
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.setHeader('Allow', 'GET, HEAD, POST')
      res.end()
      return
    }
    // Same write policy as /api/share: token when configured, same-origin otherwise.
    if (!requireShareWriteToken(req, res)) return
    let body: any
    try {
      body = await readRequestBody(req)
    } catch (err) {
      sendJson(res, 400, { error: issueErrorText(err) })
      return
    }
    const key = normalizeVerifyKey(body?.key)
    if (!key) {
      sendJson(res, 400, { error: 'key: 必填，1..80 字符' })
      return
    }
    const state = normalizeVerifyState(body?.state)
    if (!state) {
      sendJson(res, 400, { error: 'state: pending|pass|fail' })
      return
    }
    const rawNote = body?.note
    if (rawNote !== undefined && rawNote !== null && typeof rawNote !== 'string') {
      sendJson(res, 400, { error: 'note: 必须是字符串' })
      return
    }
    const note = typeof rawNote === 'string' ? rawNote.trim() : null
    if (note && note.length > 500) {
      sendJson(res, 400, { error: 'note: 长度需 ≤500' })
      return
    }
    const view = setManualVerify(MANUAL_VERIFY_FILE, key, state, note || null)
    sendJson(res, 200, view)
    return
  }

  if (pathname === '/api/issues/audit') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405
      res.setHeader('Allow', 'GET')
      res.end()
      return
    }
    try {
      const all = await giteaListAllIssues()
      sendJson(res, 200, {
        available: true,
        ...auditTaskCards(
          all.map((item) => ({
            number: item.number,
            title: item.title,
            status: item.status,
            labels: item.labels,
            body: item.description
          }))
        )
      })
    } catch (err) {
      const reason = err instanceof GiteaError ? `gitea ${err.reason}` : 'gitea unavailable'
      sendJson(res, 200, { available: false, reason })
    }
    return
  }

  const issueCommentsMatch = pathname.match(/^\/api\/issues\/(\d+)\/comments$/)
  if (issueCommentsMatch) {
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.setHeader('Allow', 'POST')
      res.end()
      return
    }
    await handleGiteaIssueCommentPost(req, res, Number(issueCommentsMatch[1]))
    return
  }

  const issueDetailMatch = pathname.match(/^\/api\/issues\/(\d+)$/)
  if (issueDetailMatch) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405
      res.setHeader('Allow', 'GET, HEAD')
      res.end()
      return
    }
    await handleGiteaIssueDetailGet(Number(issueDetailMatch[1]), res)
    return
  }

  if (pathname === '/api/issues') {
    if (req.method === 'POST') {
      if (ISSUES_FROM_FILES) await handleIssuePost(req, res)
      else await handleGiteaIssuePost(req, res)
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405
      res.setHeader('Allow', 'GET, HEAD, POST')
      res.end()
      return
    }
    if (!ISSUES_FROM_FILES) {
      await handleGiteaIssuesGet(url, res)
      return
    }
    const kindParam = (url.searchParams.get('kind') ?? 'real').trim().toLowerCase()
    const kind = ['real', 'tasks', 'all'].includes(kindParam) ? kindParam : 'real'
    const store = readManualVerify(MANUAL_VERIFY_FILE)
    const decorated = scanIssues().map((item) => decorateIssue(item, store))
    const classification = classifyIssueCounts(decorated)
    const filtered = decorated.filter((item) =>
      kind === 'all' ? true : kind === 'tasks' ? item.is_task_card : !item.is_task_card
    )
    const items = sortByManualVerify(filtered)
    sendJson(res, 200, {
      kind,
      items,
      count: items.length,
      total: items.length,
      latest: items[0] ?? null,
      classification,
      meta: {
        ...issueMeta(),
        counts: {
          ...classification.real,
          total: classification.real.total + classification.task_cards.total,
          classification
        }
      }
    })
    return
  }

  if (pathname === '/api/deliveries') {
    const { source, deliveries } = await deliveriesData()
    sendJson(res, 200, { deliveries, meta: { source } })
    return
  }

  // #107：软删到 `.trash/deliveries/<id>-<ts>/`；auth 与 `PATCH /api/tasks/:id`
  // 同一守卫（同源浏览器放行 / X-Web-Token 优先）。
  if (handleDeliveryDelete(req, res)) return

  if (pathname === '/api/share') {
    if (req.method === 'POST') {
      await handleSharePost(req, res)
      return
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      handleShareList(req, res)
      return
    }
    res.statusCode = 405
    res.setHeader('Allow', 'GET, HEAD, POST')
    res.end()
    return
  }

  const shareFileMatch = pathname.match(/^\/api\/share\/([^/]+)\/file$/)
  if (shareFileMatch) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405
      res.setHeader('Allow', 'GET, HEAD')
      res.end()
      return
    }
    handleShareFile(req, res, shareFileMatch[1])
    return
  }

  const shareTokenMatch = pathname.match(/^\/api\/share\/([^/]+)$/)
  if (shareTokenMatch) {
    if (req.method === 'DELETE') {
      handleShareDelete(req, res, shareTokenMatch[1])
      return
    }
    sendJson(res, 404, { error: 'not found' })
    return
  }

  const shareRedirectMatch = pathname.match(/^\/share\/([^/]+)$/)
  if (shareRedirectMatch) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405
      res.setHeader('Allow', 'GET, HEAD')
      res.end()
      return
    }
    handleShareRedirect(res, shareRedirectMatch[1])
    return
  }

  if (pathname === '/api/repairs') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405
      res.setHeader('Allow', 'GET')
      res.end()
      return
    }
    const job = url.searchParams.get('job')?.trim() || null
    if (job && !discover().some((j) => j.item.id === job)) {
      sendJson(res, 404, { error: `job ${job} not found` })
      return
    }
    const repairs = collectRepairs(job ?? undefined)
    sendJson(res, 200, { job, repairs, meta: { source: 'files', count: repairs.length } })
    return
  }

  if (pathname === '/api/qc/summary') {
    sendJson(res, 200, await qcSummaryData())
    return
  }

  const jobLogContentMatch = pathname.match(/^\/api\/jobs\/([\w-]+)\/logs\/content$/)
  if (jobLogContentMatch) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405
      res.setHeader('Allow', 'GET')
      res.end()
      return
    }
    const id = jobLogContentMatch[1]
    const requested = url.searchParams.get('path') ?? ''
    const segments = requested.split(/[\\/]/)
    if (
      !requested ||
      requested.startsWith('/') ||
      /^[A-Za-z]:[\\/]/.test(requested) ||
      segments.includes('..')
    ) {
      sendJson(res, 403, { error: 'path not allowed' })
      return
    }
    const { items } = jobLogScan(id)
    const normalized = path.normalize(requested).replace(/\\/g, '/')
    const hit = items.find((item) => item.path === normalized)
    if (!hit) {
      sendJson(res, 403, { error: 'path not in scanned logs' })
      return
    }
    const file = path.join(DATA_ROOT, hit.path)
    if (!exists(file)) {
      sendJson(res, 404, { error: 'log file missing' })
      return
    }
    const tail = readLogTail(file)
    sendJson(res, 200, { ...hit, content: tail.content, truncated: tail.truncated })
    return
  }

  const jobLogsMatch = pathname.match(/^\/api\/jobs\/([\w-]+)\/logs$/)
  if (jobLogsMatch) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405
      res.setHeader('Allow', 'GET')
      res.end()
      return
    }
    sendJson(res, 200, jobLogScan(jobLogsMatch[1]))
    return
  }

  const jobHistoryMatch = pathname.match(/^\/api\/jobs\/([\w-]+)\/history$/)
  if (jobHistoryMatch) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405
      res.setHeader('Allow', 'GET')
      res.end()
      return
    }
    sendJson(res, 200, await jobHistoryData(jobHistoryMatch[1]))
    return
  }

  if (pathname === '/api/jobs') {
    const { source, items } = await loadSourceJobs()
    const jobs = items.map(toJobListItem)
    sendJson(res, 200, {
      jobs,
      dataRoot: DATA_ROOT,
      original: exists(ORIGINAL_VIDEO) ? rel(ORIGINAL_VIDEO) : null,
      generatedAt: new Date().toISOString(),
      meta: { source }
    })
    return
  }

  const jobItemMatch = pathname.match(/^\/api\/jobs\/([\w-]+)$/)
  if (jobItemMatch) {
    const { source, items } = await loadSourceJobs()
    const job = items.find((j) => j.id === jobItemMatch[1])
    if (job) {
      sendJson(res, 200, { job: toJobListItem(job), repairs: collectRepairs(job.id), meta: { source } })
      return
    }
    // #89e: a studio job (e.g. A-rail aigc) is not in the repo/DB list; fall
    // back to the same read-only studio projection `/api/metrics/:id` uses.
    const detail = await studioFallbackDetail(jobItemMatch[1])
    if (!detail) {
      sendJson(res, 404, { error: `job ${jobItemMatch[1]} not found` })
      return
    }
    sendJson(res, 200, {
      job: toJobListItem(detail.job),
      repairs: collectRepairs(detail.job.id),
      meta: { source: 'studio' }
    })
    return
  }

  const metricsMatch = pathname.match(/^\/api\/metrics\/([\w-]+)$/)
  if (metricsMatch) {
    const detail = await metricsDetailData(metricsMatch[1])
    if (!detail) {
      sendJson(res, 404, { error: `job ${metricsMatch[1]} not found` })
      return
    }
    sendJson(res, 200, detail)
    return
  }

  const qcMatch = pathname.match(/^\/api\/qc\/([\w-]+)$/)
  if (qcMatch) {
    const data = await qcDataAny(qcMatch[1])
    if (!data) {
      sendJson(res, 404, { error: `no metrics.csv for job ${qcMatch[1]}` })
      return
    }
    sendJson(res, 200, data)
    return
  }

  if (pathname === '/api/status') {
    const d = await readStatusData()
    const sources = await statusSources(d.updatedAt)
    sendJson(res, 200, {
      path: d.path,
      exists: d.exists,
      updatedAt: d.updatedAt,
      data: d.data,
      sources,
      meta: { source: d.source }
    })
    return
  }

  if (pathname === '/api/plan') {
    const d = await readPlanData()
    sendJson(res, 200, {
      path: d.path,
      exists: d.exists,
      updatedAt: d.updatedAt,
      data: d.data,
      meta: {
        source: d.source,
        tasksSource: d.tasksSource,
        // #105: the time this read actually queried Gitea (client shows it as 更新于).
        fetchedAt: new Date().toISOString(),
        ...(d.error ? { error: d.error } : {})
      }
    })
    return
  }

  const taskMatch = pathname.match(/^\/api\/tasks\/([\w.-]+)$/)
  if (taskMatch) {
    const id = taskMatch[1]
    if (req.method === 'PATCH') {
      await handleTaskPatch(req, res, id)
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405
      res.setHeader('Allow', 'GET, PATCH')
      res.end()
      return
    }
    const detail = await taskDetailData(id)
    if (!detail) {
      sendJson(res, 404, { error: `task ${id} not found` })
      return
    }
    sendJson(res, 200, detail)
    return
  }

  if (pathname === '/api/health') {
    sendJson(res, 200, await health())
    return
  }

  if (pathname === '/api/cover') {
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.statusCode = 405
      res.setHeader('Allow', 'GET, POST')
      res.end()
      return
    }
    const jobId = url.searchParams.get('job')?.trim() ?? ''
    const variant = (url.searchParams.get('variant')?.trim() || '16x9') as CoverVariant
    if (!jobId) {
      sendJson(res, 400, { error: 'job query parameter is required' })
      return
    }
    if (!(variant in COVER_SIZES)) {
      sendJson(res, 400, { error: 'variant must be 16x9|9x16' })
      return
    }
    if (url.searchParams.get('provider') === 'qwen_image') {
      sendJson(res, 503, {
        code: 'provider_unavailable',
        provider: 'qwen_image',
        detail: '缺权重/key，当前只用 qwen2vl+ffmpeg'
      })
      return
    }
    const force = ['1', 'true'].includes((url.searchParams.get('force') ?? '').toLowerCase())
    const result = await coverData(jobId, variant, force)
    sendJson(res, result.status, result.body)
    return
  }

  if (pathname === '/api/explain') {
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.setHeader('Allow', 'POST')
      res.end()
      return
    }
    let body: any
    try {
      body = await readRequestBody(req)
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : 'invalid body' })
      return
    }
    const jobId = String(body?.jobId ?? '').trim()
    if (!jobId) {
      sendJson(res, 400, { error: 'jobId is required' })
      return
    }
    const force = body?.force === true || body?.force === 1 || body?.force === '1'
    const result = await explainJob(jobId, force)
    sendJson(res, result.status, result.body)
    return
  }

  if (pathname === '/api/repair') {
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.setHeader('Allow', 'POST')
      res.end()
      return
    }
    sendJson(res, 501, { code: 'repair_not_ready', detail: '等待 T-WEB-012' })
    return
  }

  if (pathname === '/media/artifact') {
    const raw = url.searchParams.get('path')
    if (!raw) {
      sendJson(res, 400, { error: 'path query parameter is required' })
      return
    }
    const abs = path.resolve(DATA_ROOT, raw)
    let target: string
    let root: string
    try {
      root = fs.realpathSync(DATA_ROOT)
    } catch {
      root = DATA_ROOT
    }
    try {
      target = fs.realpathSync(abs)
    } catch {
      sendJson(res, 404, { error: 'artifact not found' })
      return
    }
    if (target !== root && !target.startsWith(root + path.sep)) {
      sendJson(res, 403, { error: 'path outside WEB_DATA_ROOT' })
      return
    }
    if (!exists(target)) {
      sendJson(res, 404, { error: 'artifact not found' })
      return
    }
    if (url.searchParams.get('download') === '1') {
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${path.basename(target).replace(/"/g, '')}"`
      )
    }
    serveMedia(req, res, target)
    return
  }

  if (pathname === '/media/kex') {
    const resolved = resolveKexMedia(url)
    if (!resolved.file) {
      sendJson(res, resolved.status, { error: resolved.error ?? 'media not found' })
      return
    }
    if (url.searchParams.get('download') === '1') {
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${path.basename(resolved.file).replace(/"/g, '')}"`
      )
    }
    serveMedia(req, res, resolved.file)
    return
  }

  if (pathname === '/media/original') {
    serveMedia(req, res, ORIGINAL_VIDEO)
    return
  }

  const posterMatch = pathname.match(/^\/media\/poster\/([\w-]+)$/)
  if (posterMatch) {
    const jobs = discover()
    const found = jobs.find((j) => j.item.id === posterMatch[1])
    const outDir = path.join(DATA_ROOT, 'issue-19', `b-track-${posterMatch[1]}`, 'out')
    const output = listDir(outDir)
      .filter((f) => f.endsWith('.mp4'))
      .map((f) => path.join(outDir, f))
      .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0]
    if (!found || !output) {
      sendJson(res, 404, { error: 'poster unavailable' })
      return
    }
    const poster = makePoster(output, `${posterMatch[1]}-out`, 0.2)
    if (!poster) {
      sendJson(res, 404, { error: 'poster unavailable' })
      return
    }
    serveMedia(req, res, poster)
    return
  }

  const posterOrigMatch = pathname.match(/^\/media\/poster-original\/([\w-]+)$/)
  if (posterOrigMatch) {
    const jobs = discover()
    const found = jobs.find((j) => j.item.id === posterOrigMatch[1])
    if (!found) {
      sendJson(res, 404, { error: 'job not found' })
      return
    }
    const poster = makePoster(ORIGINAL_VIDEO, `${posterOrigMatch[1]}-orig`, found.item.sourceStart + 0.2)
    if (!poster) {
      sendJson(res, 404, { error: 'poster unavailable' })
      return
    }
    serveMedia(req, res, poster)
    return
  }

  const mediaMatch = pathname.match(/^\/media\/out\/([\w-]+)$/)
  if (mediaMatch) {
    const jobs = discover()
    const found = jobs.find((j) => j.item.id === mediaMatch[1])
    if (!found) {
      sendJson(res, 404, { error: `job ${mediaMatch[1]} has no media` })
      return
    }
    const outDir = path.join(DATA_ROOT, 'issue-19', `b-track-${mediaMatch[1]}`, 'out')
    const output = listDir(outDir)
      .filter((f) => f.endsWith('.mp4'))
      .map((f) => path.join(outDir, f))
      .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0]
    if (!output) {
      sendJson(res, 404, { error: 'output video missing' })
      return
    }
    serveMedia(req, res, output)
    return
  }

  if (pathname.startsWith('/api/') || pathname.startsWith('/media/')) {
    sendJson(res, 404, { error: 'not found' })
    return
  }
  next()
}

/** Vite plugin: same middleware in `vite` dev and `vite preview`. */
export function acceptanceApi(): Plugin {
  const install = (middlewares: Connect.Server) => {
    middlewares.use(handler)
  }
  return {
    name: 'acceptance-api',
    configureServer(server) {
      install(server.middlewares)
    },
    configurePreviewServer(server) {
      install(server.middlewares)
    }
  }
}

export { DATA_ROOT }

/** DB-first job detail; files mode delegates to the original scanner. */
const B_LABELS: Record<string, { label: string; group: BMetricCheck['group'] }> = {
  B1_ssim: { label: 'B1 SSIM 均值', group: 'B1' },
  B1_ssim_mean: { label: 'B1 SSIM 均值', group: 'B1' },
  B1_ssim_min: { label: 'B1 SSIM 最小值', group: 'B1' },
  B2_net_gain: { label: 'B2 净增益比（vs 基线）', group: 'B2' },
  B2_net_gain_vs_baseline_ratio: { label: 'B2 净增益比（vs 基线）', group: 'B2' },
  B2_noise: { label: 'B2 平坦区噪声变化 %', group: 'B2' },
  B2_noise_change_pct: { label: 'B2 平坦区噪声变化 %', group: 'B2' },
  B2_positives: { label: 'B2 正向项数量', group: 'B2' },
  color_p95_delta_e2000: { label: '调色 ΔE2000 p95', group: 'B2' },
  B2_lapvar_gain_pct: { label: 'B2 清晰度增益 %', group: 'B2' },
  B2_lapvar_flat_gain_pct: { label: 'B2 平坦区清晰度增益 %', group: 'B2' },
  fps_in: { label: '输入帧率', group: '输出' },
  fps_out: { label: '输出帧率', group: '输出' }
}

const QUALITY_TO_SUMMARY: Record<string, string> = {
  B1_ssim: 'B1_ssim_mean',
  B2_net_gain: 'B2_net_gain_vs_baseline_ratio',
  B2_noise: 'B2_noise_change_pct',
  color_p95_delta_e2000: 'color_p95_delta_e2000'
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fmtMetric(value: number | null): string {
  if (value === null) return '未记录'
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)))
}

/**
 * #86b2: map intake `summary.json` + `quality_b.json` into the B1/B2 table.
 * Thresholds and PASS/FAIL only come from the upstream files — a missing
 * threshold is `null` (rendered as 未记录), never a guessed default.
 */
export function buildBMetrics(summary: any, quality: any): BMetrics | null {
  if (!isRecord(summary)) return null
  const metrics = isRecord(summary.metrics) ? summary.metrics : {}
  const failed = Array.isArray(summary.failed)
    ? summary.failed.filter((x: unknown): x is string => typeof x === 'string')
    : []
  const positives = Array.isArray(summary.positives)
    ? summary.positives.filter((x: unknown): x is string => typeof x === 'string')
    : []
  const qualityChecks = Array.isArray(quality?.checks)
    ? quality.checks.filter(isRecord)
    : []
  const checks: BMetricCheck[] = []
  const covered = new Set<string>()

  for (const q of qualityChecks) {
    const name = typeof q.name === 'string' ? q.name : ''
    if (!name) continue
    const summaryKey = QUALITY_TO_SUMMARY[name]
    const meta = B_LABELS[name]
    let value = num(q.value)
    if (summaryKey && summaryKey in metrics) value = num(metrics[summaryKey])
    if (name === 'B2_positives') value = positives.length
    checks.push({
      key: name,
      label: meta?.label ?? name,
      group: meta?.group ?? 'B2',
      value,
      threshold: num(q.threshold),
      op: typeof q.op === 'string' ? q.op : null,
      pass: typeof q.pass === 'boolean' ? q.pass : null,
      hard: typeof q.hard === 'boolean' ? q.hard : null,
      source: 'quality_b.json'
    })
    if (summaryKey) covered.add(summaryKey)
  }

  const failedAliases: Record<string, string[]> = {
    B1_ssim_mean: ['B1_ssim'],
    B2_net_gain_vs_baseline_ratio: ['B2_net_gain'],
    B2_noise_change_pct: ['B2_noise']
  }
  const keyFailed = (key: string) =>
    failed.includes(key) || (failedAliases[key] ?? []).some((name) => failed.includes(name))

  for (const key of [
    'B1_ssim_min',
    'B1_ssim_mean',
    'B2_net_gain_vs_baseline_ratio',
    'B2_noise_change_pct',
    'color_p95_delta_e2000',
    'B2_lapvar_gain_pct',
    'B2_lapvar_flat_gain_pct'
  ]) {
    if (!(key in metrics) || covered.has(key)) continue
    const meta = B_LABELS[key]
    checks.push({
      key,
      label: meta?.label ?? key,
      group: meta?.group ?? 'B2',
      value: num(metrics[key]),
      threshold: null,
      op: null,
      pass: keyFailed(key) ? false : null,
      hard: null,
      source: 'summary.json'
    })
  }

  const fpsIn = num(summary.fps_in)
  const fpsOut = num(summary.fps_out)
  if (fpsIn !== null) {
    checks.push({
      key: 'fps_in', label: '输入帧率', group: '输出', value: fpsIn,
      threshold: null, op: null, pass: null, hard: null, source: 'summary.json'
    })
  }
  if (fpsOut !== null) {
    checks.push({
      key: 'fps_out', label: '输出帧率', group: '输出', value: fpsOut,
      threshold: null, op: null, pass: null, hard: null, source: 'summary.json'
    })
  }

  const rawVerdict =
    (typeof summary.verdict === 'string' && summary.verdict) ||
    (typeof summary.quality?.status === 'string' && summary.quality.status) ||
    (typeof summary.status === 'string' && summary.status) ||
    null
  const upper = rawVerdict ? rawVerdict.toUpperCase() : ''
  const verdict: BMetrics['verdict'] =
    upper === 'PASS' || upper === 'FAIL' || upper === 'CONDITIONAL' ? upper : 'UNKNOWN'

  return {
    verdict,
    status:
      typeof summary.quality?.status === 'string'
        ? summary.quality.status
        : typeof summary.status === 'string'
          ? summary.status
          : null,
    checks,
    failed,
    positives,
    positiveCount: Array.isArray(summary.positives) ? positives.length : null,
    fpsIn,
    fpsOut,
    generatedAt: typeof summary.generated_at === 'string' ? summary.generated_at : null,
    source: qualityChecks.length ? 'summary.json + quality_b.json' : 'summary.json',
    error: typeof summary.quality?.error === 'string' ? summary.quality.error : null
  }
}

const VERDICT_LABELS: Record<BMetrics['verdict'], string> = {
  PASS: '通过',
  FAIL: '未通过',
  CONDITIONAL: '有条件通过',
  UNKNOWN: '未记录'
}

/** Builds a `DetailResponse`-compatible payload for a studio optimize job. */
export function mapStudioJobToDetail(input: {
  id: string
  job: StudioJob
  meta?: any
  summary?: any
  quality?: any
  /** #86e: actual upstream readability — never inferred from a URL alone. */
  readable?: { original?: boolean; output?: boolean }
  /** #86e: best-effort failed reason from state/error/events/failed inbox. */
  failureReason?: string | null
}): JobDetail {
  const { id, job, meta, summary, quality, readable, failureReason } = input
  const summaryRead = isRecord(summary)
  const bMetrics = buildBMetrics(summary, quality)
  const probe = isRecord(summary?.output?.probe) ? summary.output.probe : {}
  const srcProbe = isRecord(summary?.source?.probe) ? summary.source.probe : {}
  const verdict = bMetrics?.verdict ?? (job.status === 'failed' ? 'FAIL' : 'UNKNOWN')
  const checks = bMetrics?.checks ?? []
  const passed = checks.filter((c) => c.pass === true).length
  const judged = checks.filter((c) => c.pass !== null).length
  const uploadId =
    typeof meta?.upload_id === 'string' && /^[a-z0-9-]{8,64}$/.test(meta.upload_id)
      ? meta.upload_id
      : null
  const type = typeof meta?.type === 'string' ? meta.type : job.type
  const isImageJob = type === 'image'
  const briefId = typeof meta?.brief_id === 'string' ? meta.brief_id : job.brief_id
  const artifactUrl = (name: string) =>
    `/api/studio/jobs/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(name)}`
  const mediaOutput = artifactUrl('final.mp4')
  const summaryPath = artifactUrl('summary.json')
  const metricsPath = summary ? artifactUrl('metrics.csv') : null
  const reportPath = quality ? artifactUrl('quality_b.json') : null
  const mediaOriginal = uploadId ? `/api/uploads/${encodeURIComponent(uploadId)}/source` : null
  const failed = bMetrics?.failed ?? []
  const durationS = num(probe.duration_s)
  const fps = num(probe.fps)
  const width = num(probe.width)
  const height = num(probe.height)
  // #86e: `summary.verdict` may only be cited when summary.json was actually
  // read. With no summary, state/errors/events are the only allowed evidence.
  const reason = failureReason?.trim() || job.error?.trim() || null
  const statusNote = !summaryRead
    ? job.status === 'failed'
      ? `summary 未记录（产物缺失），判定与指标未记录；失败原因：${reason ?? '未记录'}。`
      : 'summary 未记录（产物缺失），判定与指标未记录。'
    : failed.length > 0
      ? `未过项：${failed.join('、')}。阈值与逐项结果取自 quality_b.json。`
      : bMetrics?.error
        ? bMetrics.error
        : reason
          ? reason
          : verdict === 'FAIL'
            ? '质量门禁 FAIL（summary.verdict），逐项明细未记录。'
            : '来自 studio intake 的只读投影；未记录项显示「未记录」。'
  const criteria: Criterion[] = checks.map((c) => ({
    key: c.key,
    name: c.label,
    value: fmtMetric(c.value),
    threshold:
      c.threshold === null ? '未记录' : `${c.op ? `${c.op} ` : ''}${c.threshold}`,
    pass: c.pass,
    explain:
      c.threshold === null
        ? 'summary 中未记录阈值'
        : c.hard === false
          ? '非硬门禁'
          : '硬门禁',
    source: c.source
  }))
  const stageMs = isRecord(summary?.stage_ms)
    ? (Object.fromEntries(
        Object.entries(summary.stage_ms).filter(([, v]) => typeof v === 'number')
      ) as Record<string, number>)
    : null
  const clip = isRecord(summary?.output?.probe)
    ? {
        duration_s: durationS,
        fps,
        width,
        height,
        codec: typeof probe.video_codec === 'string' ? probe.video_codec : null,
        path: typeof summary?.output?.path === 'string' ? summary.output.path : null
      }
    : null

  return {
    job: {
      id,
      track: 'B',
      taskId: briefId ?? '',
      // #102: 展示层用 type/rail 拼可读标签，不靠 title 里的 id。
      type,
      rail: job.rail,
      title: type === 'optimize' ? `B 轨优化任务 · ${id}` : `创作工坊任务 · ${id}`,
      status: verdict,
      stage: job.progress?.stage ?? null,
      verdict,
      statusLabel: VERDICT_LABELS[verdict],
      statusNote,
      passed,
      total: checks.length,
      judged,
      durationS,
      fps,
      width,
      height,
      frames: null,
      sourceStart: 0,
      hasQc: false,
      media: {
        // #89d: image jobs have no final.mp4 — never point the player at a 404.
        original: isImageJob ? null : mediaOriginal,
        output: isImageJob ? null : mediaOutput,
        poster: null,
        posterOriginal: null
      },
      summaryPath,
      reportPath,
      metricsPath,
      // #89d: `/job/<id>` must show the same cover/keyframe read-back as /studio.
      cover_asset: job.cover_asset ?? null,
      cover_url: job.cover_url ?? null,
      keyframe_asset: job.keyframe_asset ?? null,
      keyframe_source: job.keyframe_source ?? null
    },
    sourceMeta: Object.keys(srcProbe).length
      ? {
          label: 'source',
          durationS: num(srcProbe.duration_s),
          frames: null,
          fps: num(srcProbe.fps),
          width: num(srcProbe.width),
          height: num(srcProbe.height),
          bytes: null,
          path:
            typeof summary?.source?.effective_path === 'string'
              ? summary.source.effective_path
              : typeof summary?.source?.path === 'string'
                ? summary.source.path
                : '未记录'
        }
      : null,
    criteria,
    pipeline: {
      source:
        typeof summary?.source?.effective_path === 'string'
          ? summary.source.effective_path
          : typeof summary?.source?.path === 'string'
            ? summary.source.path
            : null,
      l1Mode: null,
      chain: null,
      clip,
      chainSteps: stageMs,
      chainTotalS: num(summary?.elapsed_s),
      look: summary?.quality ?? null
    },
    dataSources: [
      { label: 'summary（代理）', path: summaryPath, exists: summaryRead },
      { label: 'quality_b（代理）', path: reportPath ?? '未记录', exists: Boolean(quality) },
      {
        label: '原片',
        path: mediaOriginal ?? '未记录',
        exists: Boolean(mediaOriginal) && Boolean(readable?.original)
      },
      { label: '优化片（代理）', path: mediaOutput, exists: Boolean(readable?.output) }
    ],
    notes: [
      ...(failed.length ? [`未过项：${failed.join('、')}`] : []),
      ...(bMetrics?.error ? [bMetrics.error] : [])
    ],
    bMetrics
  }
}

function studioContext(): StudioContext {
  return {
    dataRoot: DATA_ROOT,
    intakeUrl: STUDIO_INTAKE_URL,
    timeoutMs: STUDIO_INTAKE_TIMEOUT_MS,
    webToken: process.env.WEB_WRITE_TOKEN ?? null,
    isSameOrigin: () => false,
    sendJson: () => {},
    readJson,
    atomicWriteJson,
    readBody: readRequestBody
  }
}

/** #86e: the source URL can exist while the uploaded file is gone. */
function uploadSourceReadable(uploadId: string): boolean {
  if (!/^[a-z0-9-]{8,64}$/.test(uploadId)) return false
  const meta = readJson(path.join(DATA_ROOT, 'uploads', uploadId, 'meta.json'))
  if (!isRecord(meta) || meta.upload_id !== uploadId || meta.status !== 'ready') return false
  const ext = typeof meta.ext === 'string' ? meta.ext : ''
  if (!/^\.[A-Za-z0-9]+$/.test(ext)) return false
  return exists(path.join(DATA_ROOT, 'uploads', uploadId, `source${ext}`))
}

/** #86e: best-effort failed reason. Missing evidence stays null (「未记录」). */
function studioFailureReason(body: any): string | null {
  const error = body?.error
  if (typeof error === 'string' && error.trim()) return error.trim()
  if (isRecord(error)) {
    for (const key of ['message', 'reason', 'error', 'detail']) {
      const value = error[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
  }
  for (const key of ['failure_reason', 'reason']) {
    const value = body?.[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  const events = Array.isArray(body?.events) ? body.events : []
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (!isRecord(event)) continue
    const type = typeof event.type === 'string' ? event.type.toLowerCase() : ''
    const message = typeof event.message === 'string' ? event.message.trim() : ''
    if (message && /(fail|error|exception|abort|cancel)/.test(type)) return message
  }
  return null
}

export async function studioFallbackDetail(
  id: string,
  ctx: StudioContext = studioContext()
): Promise<JobDetail | null> {
  if (!isSafeJobId(id)) return null
  const upstream = await fetchStudioJobDetail(ctx, id)
  if (!upstream.ok || upstream.status >= 400 || !isRecord(upstream.body)) return null
  const job = buildStudioJob(ctx, id, upstream.body)
  const meta = ctx.readJson(path.join(ctx.dataRoot, 'studio', 'jobs', `${id}.json`))
  const summary = await fetchStudioArtifactJson(ctx, id, 'summary.json')
  const quality = summary ? await fetchStudioArtifactJson(ctx, id, 'quality_b.json') : null
  // #89e: aigc jobs never write summary.json. Any job this intake returns is a
  // real studio job, so a missing summary is "未记录", not a 404. Unknown or
  // illegal ids still 404 via the id/upstream checks above.
  const uploadId =
    typeof meta?.upload_id === 'string' && /^[a-z0-9-]{8,64}$/.test(meta.upload_id)
      ? meta.upload_id
      : null
  const readable = {
    original: uploadId ? uploadSourceReadable(uploadId) : false,
    output: await studioArtifactReadable(ctx, id, 'final.mp4')
  }
  return mapStudioJobToDetail({
    id,
    job,
    meta,
    summary,
    quality,
    readable,
    failureReason: studioFailureReason(upstream.body)
  })
}

async function metricsDetailData(id: string) {
  const db = await dbJobsFull()
  if (!db) return (await studioFallbackDetail(id)) ?? jobDetail(id)
  const found = db.items.find((j) => j.id === id)
  if (!found) return studioFallbackDetail(id)
  const rawSummary = db.summaries.get(id)
  const summary = isRecord(rawSummary) ? rawSummary : {}
  // #86e: an empty summary row is a missing artifact, not a silent "no verdict".
  const summaryMissing = Object.keys(summary).length === 0
  const item = summaryMissing
    ? {
        ...found,
        statusNote:
          found.status === 'FAIL'
            ? 'summary 未记录（产物缺失），判定与指标未记录；失败原因：未记录。'
            : 'summary 未记录（产物缺失），判定与指标未记录。'
      }
    : found
  const criteria = db.criteria.get(id) ?? []
  const artifactExists = (kind: string): boolean => {
    const row = (db.artifacts.get(id) ?? []).find((a) => a.kind === kind)
    if (!row?.path) return false
    return exists(path.isAbsolute(row.path) ? row.path : path.join(DATA_ROOT, row.path))
  }
  const notes: string[] = []
  if (item.status === 'FAIL') notes.push(item.statusNote)
  if (Array.isArray(summary.unverified)) notes.push(...summary.unverified.map((u: any) => `未验证：${u}`))
  if (summary.look?.warning) notes.push(`look：${summary.look.warning}`)
  const clip = {
    duration_s: item.durationS,
    fps: item.fps,
    width: item.width,
    height: item.height,
    frames: item.frames,
    codec: summary.clip?.codec ?? null,
    pix_fmt: summary.clip?.pix_fmt ?? null,
    colorspace: summary.clip?.colorspace ?? null,
    bitrate_mbps: summary.clip?.bitrate_mbps ?? null,
    bytes: summary.clip?.bytes ?? null,
    path: summary.clip?.path ?? null,
    local: summary.clip?.local ?? null
  }
  return {
    job: item,
    sourceMeta: sourceMeta([{ summary }]),
    criteria,
    pipeline: {
      source: summary.source ?? null,
      l1Mode: summary.l1_mode ?? null,
      chain: summary.chain ?? null,
      clip: Object.values(clip).some((v) => v !== null) ? clip : null,
      chainSteps: summary.chain_steps_s ?? null,
      chainTotalS: typeof summary.chain_total_s === 'number' ? summary.chain_total_s : null,
      look: summary.look ?? null
    },
    dataSources: [
      { label: 'summary', path: item.summaryPath || '未记录', exists: artifactExists('summary') },
      { label: 'report', path: item.reportPath ?? '无', exists: artifactExists('report') },
      { label: 'metrics', path: item.metricsPath ?? '无', exists: artifactExists('metrics') },
      { label: '原始视频', path: rel(ORIGINAL_VIDEO), exists: exists(ORIGINAL_VIDEO) }
    ],
    notes
  }
}

/** DB-first QC series (job_metrics); files mode reads the CSV. */
async function qcDataAny(id: string) {
  const rows = (await dbTry(
    (db) => db`select metric, series from acceptance.job_metrics where job_id = ${id}`
  )) as any[] | null
  if (rows && rows.length) {
    const colRow = rows.find((r) => r.metric === '__columns')
    const measurements = rows.filter((r) => r.metric !== '__columns')
    const columns: string[] = Array.isArray(colRow?.series)
      ? colRow.series
      : measurements.map((r) => r.metric)
    const byMetric = new Map(measurements.map((r) => [r.metric, r.series]))
    const len = measurements.reduce(
      (m, r) => Math.max(m, Array.isArray(r.series) ? r.series.length : 0),
      0
    )
    const jobRow = (await dbTry(
      (db) => db`select task_id from acceptance.jobs where id = ${id}`
    )) as any[] | null
    const data = Array.from({ length: len }, (_, i) =>
      Object.fromEntries(
        columns.map((c) => [c, (byMetric.get(c) as any[] | undefined)?.[i] ?? ''])
      )
    )
    return {
      jobId: id,
      taskId: jobRow?.[0]?.task_id ?? null,
      source: 'postgres:acceptance.job_metrics',
      columns,
      rows: data,
      thresholds: [
        { label: 'lapvar 阈值', value: 16.3, note: '768×512 归一化口径' },
        { label: '单帧阈值', value: 5.0, note: '768×512 归一化口径' }
      ],
      rules: rulesForRows(columns, data),
      rulesSource: policyRules().source,
      unitNote:
        '本 CSV 的 lapvar 是 1080×1920 原尺寸口径（约 100–3700），与 16.3 / 5.0 的 768×512 归一化口径不可直接比较；gate 已于 2026-11-10 校准，红线仅作历史参照。'
    }
  }
  return qcData(id)
}
