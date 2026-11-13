/**
 * Read-only `job_snapshot/1` contract (#97a).
 *
 * The snapshot is the *only* place where (status, stage, verdict) are derived.
 * `/api/snapshot`, `/api/jobs` and `/api/studio/jobs` all reuse this module so a
 * job cannot drift between pages (I2). Nothing here writes runner state.
 *
 * Contract: `.opencode/state/T-OBS-097-contract.md`.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { DATA_ROOT, discover, filesArtifacts, readJson, type JobListItem } from './api'
import { kexRoot, readThresholds } from './insights'
import {
  buildStudioJob,
  fetchStudioJobDetail,
  studioProjection,
  type StudioContext
} from './studio'

export type SnapshotSource = 'b-track' | 'studio'
export type SnapshotStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'unknown'
export type SnapshotVerdict = 'PASS' | 'FAIL' | 'CONDITIONAL' | 'UNKNOWN' | null
export type UnavailableReason =
  | 'source_unreachable'
  | 'kex_repo_not_configured'
  | 'job_not_found'
  | 'state_unreadable'
export type StageState = 'ok' | 'unavailable'
export type DecisionsState = 'ok' | 'not_recorded' | 'unavailable'

export type SnapshotStage = {
  name: string
  status: string | null
  started_at: string | null
  ended_at: string | null
}

export type SnapshotArtifact = {
  kind: string
  path: string
  bytes: number | null
  sha256: string | null
  available: boolean
}

export type SnapshotRule = {
  id: string
  name: string
  op: string | null
  threshold: number | null
  unit: string | null
  actual: number | null
  verdict: 'pass' | 'fail' | null
  source: string
}

export type SnapshotQc = {
  result: 'pass' | 'fail' | 'partial' | 'unavailable'
  rules: SnapshotRule[]
}

export type SnapshotDecision = {
  at: string | null
  kind: string | null
  summary: string | null
  source: string
}

export type JobSnapshot = {
  contract: 'job_snapshot/1'
  available: boolean
  reason: UnavailableReason | null
  source: SnapshotSource
  job_id: string
  status: SnapshotStatus | null
  status_source: string | null
  verdict: SnapshotVerdict
  stage: string | null
  stages_state: StageState
  stages: SnapshotStage[]
  artifacts: SnapshotArtifact[]
  qc: SnapshotQc
  decisions_state: DecisionsState
  /** I5: 20-line cap hit, response carries only the tail. */
  decisions_truncated: boolean
  decisions: SnapshotDecision[]
  timestamps: {
    created_at: string | null
    started_at: string | null
    updated_at: string | null
    finished_at: string | null
  }
}

const CONTRACT = 'job_snapshot/1' as const
const JOB_ID_RE = /^[A-Za-z0-9._-]+$/
const FALLBACK_SOURCE = '内置默认(policy 不可读)'

/** I6: only `[A-Za-z0-9._-]`, no traversal, nothing touches the FS otherwise. */
export function isSafeJobId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) return false
  if (!JOB_ID_RE.test(value)) return false
  if (value === '.' || value === '..' || value.includes('..')) return false
  return true
}

/** Contract §2: b-track verdict -> run status (full enum covered by tests). */
export function bTrackStatusFromVerdict(verdict: unknown): SnapshotStatus {
  const v = typeof verdict === 'string' ? verdict.toUpperCase() : ''
  if (v === 'PASS' || v === 'CONDITIONAL') return 'succeeded'
  if (v === 'FAIL') return 'failed'
  return 'unknown'
}

/** Contract §2: single b-track projection for both snapshot and `/api/jobs`. */
export type BTrackProjection = {
  status: SnapshotStatus
  verdict: Exclude<SnapshotVerdict, null> | null
  stage: null
}

export function bTrackProjection(summaryVerdict: unknown, listVerdict: unknown): BTrackProjection {
  const verdict = normalizeVerdict(summaryVerdict) ?? normalizeVerdict(listVerdict)
  return { status: bTrackStatusFromVerdict(verdict), verdict, stage: null }
}

/** Contract §2: studio qc status -> snapshot verdict. */
export function studioVerdictFromQc(qc: 'pass' | 'fail' | 'pending'): SnapshotVerdict {
  if (qc === 'pass') return 'PASS'
  if (qc === 'fail') return 'FAIL'
  return 'UNKNOWN'
}

function normalizeVerdict(value: unknown): Exclude<SnapshotVerdict, null> | null {
  const v = typeof value === 'string' ? value.toUpperCase() : ''
  return v === 'PASS' || v === 'FAIL' || v === 'CONDITIONAL' || v === 'UNKNOWN' ? v : null
}

const emptyTimestamps = () => ({
  created_at: null,
  started_at: null,
  updated_at: null,
  finished_at: null
})

/** Every `available:false` body uses the same null/[] shape (contract §1). */
export function unavailableSnapshot(
  source: SnapshotSource,
  jobId: string,
  reason: UnavailableReason
): JobSnapshot {
  return {
    contract: CONTRACT,
    available: false,
    reason,
    source,
    job_id: jobId,
    status: null,
    status_source: null,
    verdict: null,
    stage: null,
    stages_state: 'unavailable',
    stages: [],
    artifacts: [],
    qc: { result: 'unavailable', rules: [] },
    decisions_state: 'unavailable',
    decisions_truncated: false,
    decisions: [],
    timestamps: emptyTimestamps()
  }
}

// ---------------------------------------------------------------------------
// QC rules (single source: policy/quality_thresholds.json 7 hard checks)
// ---------------------------------------------------------------------------

type PolicyRule = Omit<SnapshotRule, 'actual' | 'verdict'>

/** Used only when the policy file is unreadable (values mirror the old table). */
const BUILTIN_RULES: PolicyRule[] = [
  { id: 'B1_ssim_mean', name: 'B1 · SSIM', op: '>=', threshold: 0.8, unit: '', source: FALLBACK_SOURCE },
  {
    id: 'B2_noise_change_pct',
    name: 'B2 · 平坦区噪声变化',
    op: '<=',
    threshold: 15,
    unit: '%',
    source: FALLBACK_SOURCE
  },
  {
    id: 'B2_net_gain_vs_baseline_ratio',
    name: 'B2 · 锐度净增益',
    op: '>=',
    threshold: 1.5,
    unit: '×',
    source: FALLBACK_SOURCE
  },
  {
    id: 'B3_ghost_ratio_median',
    name: 'B3 · 插帧鬼影比',
    op: '<=',
    threshold: 1.5,
    unit: '',
    source: FALLBACK_SOURCE
  }
]

/**
 * Policy rules without actuals. `KEX_REPO_ROOT` unavailable or policy unreadable
 * -> builtin fallback with the contract's explicit `source` label.
 */
export function policyRules(root: string | null = kexRoot()): {
  source: string
  rules: PolicyRule[]
} {
  if (root) {
    const warnings: string[] = []
    const thresholds = readThresholds(root, warnings)
    if (thresholds.items.length) {
      return {
        source: thresholds.source,
        rules: thresholds.items.map((item) => ({
          id: item.key,
          name: item.label,
          op: item.op,
          threshold: item.value,
          unit: item.unit,
          source: thresholds.source
        }))
      }
    }
  }
  return { source: FALLBACK_SOURCE, rules: BUILTIN_RULES.map((rule) => ({ ...rule })) }
}

const firstNumber = (...values: unknown[]): number | null => {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>
      const nested = firstNumber(obj.actual, obj.value, obj.mean, obj.p95, obj.worst)
      if (nested !== null) return nested
    }
  }
  return null
}

/**
 * Join an existing actual value by rule id. We only read values that already
 * exist (summary.aggregate / state.quality / metrics); never estimate.
 */
export function actualForRule(id: string, summary: any, detail: any): number | null {
  const aggregate = summary?.aggregate?.[id]
  if (aggregate !== undefined) return firstNumber(aggregate)

  const quality = detail?.state?.quality
  if (Array.isArray(quality)) {
    const hit = quality.find(
      (row: any) => row?.id === id || row?.key === id || row?.name === id
    )
    if (hit) return firstNumber(hit)
  } else if (quality && typeof quality === 'object') {
    if (id in quality) return firstNumber((quality as Record<string, unknown>)[id])
  }

  for (const bag of [detail?.state?.metrics, detail?.metrics]) {
    if (bag && typeof bag === 'object' && id in bag) {
      return firstNumber((bag as Record<string, unknown>)[id])
    }
  }
  return null
}

export function judgeRule(
  op: string | null,
  threshold: number | null,
  actual: number | null
): 'pass' | 'fail' | null {
  if (actual === null || threshold === null || !op) return null
  if (op === '>') return actual > threshold ? 'pass' : 'fail'
  if (op === '>=') return actual >= threshold ? 'pass' : 'fail'
  if (op === '<') return actual < threshold ? 'pass' : 'fail'
  if (op === '<=') return actual <= threshold ? 'pass' : 'fail'
  return null
}

function aggregateQc(rules: SnapshotRule[]): SnapshotQc['result'] {
  if (!rules.length) return 'unavailable'
  if (rules.every((rule) => rule.actual === null)) return 'unavailable'
  if (rules.some((rule) => rule.verdict === 'fail')) return 'fail'
  if (rules.some((rule) => rule.actual === null)) return 'partial'
  return 'pass'
}

function buildQc(summary: any, detail: any): SnapshotQc {
  const { rules } = policyRules()
  const joined = rules.map((rule) => {
    const actual = actualForRule(rule.id, summary, detail)
    return { ...rule, actual, verdict: judgeRule(rule.op, rule.threshold, actual) }
  })
  return { result: aggregateQc(joined), rules: joined }
}

// ---------------------------------------------------------------------------
// decisions
// ---------------------------------------------------------------------------

/** `readDecisions` semantics extended with the contract's `truncated` marker. */
export function readDecisionLog(
  root: string | null,
  job: string
): { state: DecisionsState; items: SnapshotDecision[]; truncated: boolean } {
  if (!root) return { state: 'unavailable', items: [], truncated: false }
  const rel = `decisions/${job}.jsonl`
  const file = path.join(root, 'decisions', `${job}.jsonl`)
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return { state: 'not_recorded', items: [], truncated: false }
  }
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const truncated = lines.length > 20
  const items: SnapshotDecision[] = []
  for (const line of lines.slice(-20)) {
    let doc: any
    try {
      doc = JSON.parse(line)
    } catch {
      continue
    }
    const at = typeof doc?.at === 'string' ? doc.at : typeof doc?.ts === 'string' ? doc.ts : null
    const kind = typeof doc?.kind === 'string' ? doc.kind : typeof doc?.type === 'string' ? doc.type : null
    const summary =
      typeof doc?.summary === 'string'
        ? doc.summary
        : typeof doc?.reason === 'string'
          ? doc.reason
          : typeof doc?.message === 'string'
            ? doc.message
            : null
    items.push({ at, kind, summary, source: rel })
  }
  return { state: 'ok', items, truncated }
}

// ---------------------------------------------------------------------------
// timestamps / stages
// ---------------------------------------------------------------------------

function mtimeIso(file: string | null | undefined): string | null {
  if (!file) return null
  try {
    return new Date(fs.statSync(file).mtimeMs).toISOString()
  } catch {
    return null
  }
}

function normalizeStages(raw: unknown): SnapshotStage[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  return Object.keys(raw as Record<string, any>).map((name) => {
    const stage = (raw as Record<string, any>)[name]
    const started = stage?.started_at ?? stage?.startedAt ?? null
    const ended = stage?.ended_at ?? stage?.endedAt ?? stage?.finished_at ?? null
    return {
      name,
      status: typeof stage?.status === 'string' ? stage.status : null,
      started_at: typeof started === 'string' ? started : null,
      ended_at: typeof ended === 'string' ? ended : null
    }
  })
}

// ---------------------------------------------------------------------------
// b-track
// ---------------------------------------------------------------------------

function bTrackSnapshot(jobId: string): JobSnapshot {
  const found = discover().find((job) => job.item.id === jobId)
  if (!found) return unavailableSnapshot('b-track', jobId, 'job_not_found')

  const summaryVerdict = normalizeVerdict(found.summary?.verdict)
  const projection = bTrackProjection(summaryVerdict, found.item.verdict)
  const verdict = projection.verdict
  const status = projection.status
  const artifacts: SnapshotArtifact[] = filesArtifacts(found.item as JobListItem).map((file) => ({
    kind: file.kind,
    path: file.path,
    bytes:
      typeof file.size_bytes === 'number'
        ? file.size_bytes
        : Number.isFinite(Number(file.size_bytes))
          ? Number(file.size_bytes)
          : null,
    sha256: file.sha256,
    available: true
  }))

  const summaryAbs = path.join(DATA_ROOT, found.item.summaryPath)
  const outputAbs = artifacts.find((artifact) => artifact.kind === 'video')
    ? path.join(DATA_ROOT, artifacts.find((artifact) => artifact.kind === 'video')!.path)
    : null
  const decisions = readDecisionLog(kexRoot(), jobId)

  return {
    contract: CONTRACT,
    available: true,
    reason: null,
    source: 'b-track',
    job_id: jobId,
    status,
    status_source: `${found.item.summaryPath}#${summaryVerdict ? 'verdict' : 'gates'}`,
    verdict,
    stage: projection.stage,
    stages_state: 'unavailable',
    stages: [],
    artifacts,
    qc: buildQc(found.summary, null),
    decisions_state: decisions.state,
    decisions_truncated: decisions.truncated,
    decisions: decisions.items,
    timestamps: {
      created_at: null,
      started_at: null,
      updated_at: mtimeIso(summaryAbs),
      finished_at: mtimeIso(outputAbs)
    }
  }
}

// ---------------------------------------------------------------------------
// studio
// ---------------------------------------------------------------------------

function studioContext(): StudioContext {
  return {
    dataRoot: DATA_ROOT,
    intakeUrl: process.env.STUDIO_INTAKE_URL?.trim() || 'http://100.92.106.101:8090',
    timeoutMs: 5000,
    webToken: process.env.WEB_WRITE_TOKEN ?? null,
    isSameOrigin: () => false,
    sendJson: (_res: ServerResponse, _status: number, _body: unknown) => {},
    readJson,
    atomicWriteJson: (_file: string, _value: unknown) => {},
    readBody: async (_req: IncomingMessage) => ({})
  }
}

async function studioSnapshot(jobId: string): Promise<JobSnapshot> {
  const ctx = studioContext()
  const upstream = await fetchStudioJobDetail(ctx, jobId)
  if (!upstream.ok) return unavailableSnapshot('studio', jobId, 'source_unreachable')
  if (upstream.status === 404) return unavailableSnapshot('studio', jobId, 'job_not_found')
  if (upstream.status >= 400) return unavailableSnapshot('studio', jobId, 'state_unreadable')

  const detail = upstream.body
  if (!detail || typeof detail !== 'object' || !detail.state) {
    return unavailableSnapshot('studio', jobId, 'state_unreadable')
  }

  const job = buildStudioJob(ctx, jobId, detail)
  const projection = studioProjection(detail)
  const stages = normalizeStages(detail?.state?.stages)
  const artifacts: SnapshotArtifact[] = job.assets.map((asset) => ({
    kind: asset.kind,
    path: asset.uri.replace(/^studio:\/\//, ''),
    bytes: asset.size_bytes,
    sha256: asset.sha256,
    available: true
  }))
  const decisions = readDecisionLog(kexRoot(), jobId)
  const state = detail.state ?? {}

  return {
    contract: CONTRACT,
    available: true,
    reason: null,
    source: 'studio',
    job_id: jobId,
    status: projection.status,
    status_source: 'intake /intake/jobs/:id#state',
    verdict: projection.verdict,
    stage: projection.stage,
    stages_state: stages.length ? 'ok' : 'unavailable',
    stages,
    artifacts,
    qc: buildQc(null, detail),
    decisions_state: decisions.state,
    decisions_truncated: decisions.truncated,
    decisions: decisions.items,
    timestamps: {
      created_at: typeof detail.created_at === 'string' ? detail.created_at : null,
      started_at:
        typeof detail.started_at === 'string'
          ? detail.started_at
          : typeof state.started_at === 'string'
            ? state.started_at
            : null,
      updated_at:
        typeof detail.updated_at === 'string'
          ? detail.updated_at
          : typeof state.updated_at === 'string'
            ? state.updated_at
            : null,
      finished_at:
        typeof detail.finished_at === 'string'
          ? detail.finished_at
          : typeof state.finished_at === 'string'
            ? state.finished_at
            : null
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function buildSnapshot(opts: {
  source: SnapshotSource
  jobId: string
}): Promise<JobSnapshot> {
  if (opts.source === 'studio') return studioSnapshot(opts.jobId)
  return bTrackSnapshot(opts.jobId)
}
