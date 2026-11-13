export type Criterion = {
  key: string
  name: string
  value: string
  threshold: string
  pass: boolean | null
  explain: string
  source: string
}

/** 门禁结论（QC verdict）；与运行状态 `SnapshotStatus` 分开。 */
export type GateStatus = 'PASS' | 'FAIL' | 'CONDITIONAL' | 'UNKNOWN'

export type Job = {
  id: string
  track: string
  taskId: string
  title: string
  /** #102：studio 任务类型 / 轨别；B 轨行可缺失，展示层按 track 兜底。 */
  type?: string | null
  rail?: string | null
  /** #97e: 归一化运行态，与 `/api/snapshot` 一致。 */
  status: SnapshotStatus
  verdict: GateStatus | null
  gateStatus: GateStatus
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
  /** #89d: studio cover / keyframe read-back (absent for repo-only rows). */
  cover_asset?: StudioAssetRef | null
  cover_url?: string | null
  keyframe_asset?: StudioKeyframeRef | null
  keyframe_source?: string | null
}

export type JobsResponse = {
  jobs: Job[]
  dataRoot: string
  original: string | null
  generatedAt: string
}

/** `/api/jobs/:id/logs`：只读扫描结果，`scanned` 是真实探测过的目录。 */
export type JobLogItem = {
  name: string
  path: string
  size: number
  mtime: string
}

export type JobLogsResponse = {
  items: JobLogItem[]
  scanned: string[]
}

/** `/api/jobs/:id/logs/content`：白名单命中的日志尾部（≤200 行 / ≤64KB）。 */
export type JobLogContentResponse = JobLogItem & {
  content: string
  truncated: boolean
}

/** `/api/jobs/:id/history`：快照/事件时间线，`source` 为 postgres 或 files。 */
export type JobHistoryItem = {
  ts: string | null
  kind: string
  summary: string
}

export type JobHistoryResponse = {
  items: JobHistoryItem[]
  source: string
}

export type SourceMeta = {
  label: string
  durationS: number | null
  frames: number | null
  fps: number | null
  width: number | null
  height: number | null
  bytes: number | null
  path: string
}

export type DetailResponse = {
  job: Job
  sourceMeta: SourceMeta | null
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
  /** #86b2：studio optimize job 的 B1/B2 指标（来自 intake 代理，缺失即 null）。 */
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

export type QcRow = Record<string, string | number>

export type QcResponse = {
  jobId: string
  taskId: string
  source: string
  columns: string[]
  rows: QcRow[]
  thresholds: { label: string; value: number; note: string }[]
  /** #97a：policy 单源规则清单（metrics 无对应列时 actual 为 null）。 */
  rules: SnapshotRule[]
  rulesSource: string
  unitNote: string
}

export type HealthResponse = {
  /** `url` 为旧字段，与 `configuredUrl` 同值，保留兼容。 */
  comfyui: {
    ok: boolean
    url: string
    configuredUrl: string
    latencyMs: number
    error: string | null
  }
  checkedAt: string
}

export type MilestoneState = 'done' | 'in_progress' | 'pending'

export type MilestoneRail = {
  rail: string
  state: string
  detail: string
  blocked_by?: string[]
}

export type Milestone = {
  id: string
  name: string
  state: MilestoneState
  detail?: string
  evidence?: string[]
  rails?: MilestoneRail[]
}

export type NowItem = {
  task: string
  detail: string
  owner: string
}

export type MissingItem = {
  item: string
  blocked_by: string
  why: string
  impact: string
}

export type ProjectStatus = {
  updated_at: string
  updated_by?: string
  milestones: Milestone[]
  now: NowItem[]
  missing: MissingItem[]
  verdict_rules: Record<string, unknown>
  eta: {
    best_case_days: number
    base_case_days: number
    worst_case_days: number
    assumption: string
  }
}

export type StatusIssuesSource = {
  open: number | null
  closed: number | null
  total: number | null
  fetchedAt: string | null
  source: 'gitea' | 'files'
  error?: string
}

export type StatusTasksSource = {
  done: number
  running: number
  pending: number
  blocked: number
  total: number
  source: 'gitea' | 'files'
}

export type StatusSources = {
  issues: StatusIssuesSource
  tasks: StatusTasksSource
  opencode: {
    taskMdUpdatedAt: string | null
    subagentUpdatedAt: string | null
    runningCount: number
  }
  snapshot: { updatedAt: string | null; stale: boolean }
}

export type StatusResponse = {
  path: string
  exists: boolean
  updatedAt: string | null
  data: ProjectStatus | null
  sources?: StatusSources
}

/** 任务计划：milestones + 全部任务的时间轴数据（`tasks.json`）。 */
export type PlanStatus = 'done' | 'running' | 'in_progress' | 'pending' | 'blocked'

export type PlanTask = {
  id: string
  title: string
  owner: string
  rail: string
  status: PlanStatus
  start: string
  end: string
  progress: number
  depends_on?: string[]
  blocked_by?: string
  evidence?: string
  estimated?: boolean
  /** issue #77：任务对应 issue 的编号/链接/改动说明（无正文时为 null）。 */
  issue_number?: number
  issue_url?: string
  issue_summary?: string | null
  manual_verify?: ManualVerifyState
  manual_verify_key?: string
  manual_verify_note?: string | null
}

export type PlanMilestone = {
  id: string
  label: string
  at: string
  state: MilestoneState
  estimated?: boolean
}

export type PlanEta = {
  best_case_days?: number
  base_case_days?: number
  worst_case_days?: number
  current_phase?: string
  next_gate?: string
}

export type PlanData = {
  updated_at: string
  timezone?: string
  note?: string
  milestones: PlanMilestone[]
  tasks: PlanTask[]
  eta?: PlanEta
}

export type PlanResponse = {
  path: string
  exists: boolean
  updatedAt: string | null
  data: PlanData | null
  /** #105：`tasksSource` 决定来源徽标；`fetchedAt` 是本次读接口真实查询时间。 */
  meta?: {
    source?: string
    tasksSource?: 'gitea' | 'files'
    fetchedAt?: string
    error?: string
  }
}

/** `/api/system`：Mac Studio（ComfyUI）算力与队列快照。字段缺失即视为接口未就绪。 */
export type ResourceUsage = {
  total: number | null
  free: number | null
  used: number | null
}

/**
 * `/api/system` 的原始形态（兼容两代服务端）：
 * - 扁平：`{ online, latencyMs, vram: { free }, queue }`（新契约）
 * - 嵌套：`{ studio: { online, latencyMs }, vram, queue }`（当前线上）
 * UI 统一走 `SystemSnapshot`，不在组件里判断服务端代数。
 */
export type SystemResponse = {
  online?: boolean
  latencyMs?: number
  vram?: ResourceUsage | null
  ram?: ResourceUsage | null
  queue?: { running: number; pending: number } | null
  checkedAt?: string
  configuredUrl?: string | null
  error?: string | null
  studio?: {
    online?: boolean
    latencyMs?: number
    comfyuiVersion?: string | null
    os?: string | null
    error?: string | null
  }
  data?: SystemResponse
}

/** 归一化后的算力/队列快照，组件只消费这个结构。 */
export type SystemSnapshot = {
  online: boolean
  latencyMs: number | null
  vram: ResourceUsage | null
  ram: ResourceUsage | null
  queue: { running: number; pending: number } | null
  error: string | null
  /** 实际探测的 ComfyUI base（COMFYUI_URL 或默认值）；缺失即视为未配置。 */
  configuredUrl: string | null
  checkedAt: string | null
  fallback: boolean
}

export type DeliveryRepair = {
  count: number
  repaired: boolean
  latest: {
    tool: string | null
    issue: string | null
    generatedAt: string | null
    reportUrl: string | null
    compareUrl: string | null
  }
}

export type Delivery = {
  jobId: string
  title: string
  durationS: number | null
  width: number | null
  height: number | null
  mp4: string
  poster: string | null
  /** 16:9 裁切封面（`cover_16x9.jpg`），可能缺失。 */
  coverUrl?: string | null
  report: string | null
  score: number | null
  gate: string
  createdAt: string | null
  /** 成片字节数（#107 删除确认框显示大小）；老数据可能缺失。 */
  bytes?: number | null
  /** AI 修复记录聚合；无记录时为 null。 */
  repair?: DeliveryRepair | null
}

/** `DELETE /api/deliveries/<id>` 软删响应（#107）。 */
export type DeliveryTrashResponse = {
  ok: true
  jobId: string
  /** 相对 WEB_DATA_ROOT 的回收站目录，如 `.trash/deliveries/s1-20261113-133000`。 */
  movedTo: string
  bytes: number
  files: string[]
}

export type DeliveriesResponse = {
  deliveries: Delivery[]
  meta: { source: string }
}

export type QcSummaryJob = {
  jobId: string
  taskId: string
  /** 门禁口径（来自 `/api/qc/summary`），不跟 `Job.status` 走。 */
  status: GateStatus
  passed: number
  judged: number
  ssim: number | null
  noiseChangePct: number | null
  netGain: number | null
  ghostRatio: number | null
  hasQc: boolean
}

/** #97 `job_snapshot/1`（只读投影；契约见 .opencode/state/T-OBS-097-contract.md）。 */
export type SnapshotStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'unknown'
export type SnapshotUnavailableReason =
  | 'source_unreachable'
  | 'kex_repo_not_configured'
  | 'job_not_found'
  | 'state_unreadable'
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
export type SnapshotDecision = {
  at: string | null
  kind: string | null
  summary: string | null
  source: string
}
export type JobSnapshot = {
  contract: 'job_snapshot/1'
  available: boolean
  reason: SnapshotUnavailableReason | null
  source: 'b-track' | 'studio'
  job_id: string
  status: SnapshotStatus | null
  status_source: string | null
  verdict: 'PASS' | 'FAIL' | 'CONDITIONAL' | 'UNKNOWN' | null
  stage: string | null
  stages_state: 'ok' | 'unavailable'
  artifacts: Array<{
    kind: string
    path: string
    bytes: number | null
    sha256: string | null
    available: boolean
  }>
  qc: { result: 'pass' | 'fail' | 'partial' | 'unavailable'; rules: SnapshotRule[] }
  decisions_state: 'ok' | 'not_recorded' | 'unavailable'
  decisions_truncated: boolean
  decisions: SnapshotDecision[]
  timestamps: {
    created_at: string | null
    started_at: string | null
    updated_at: string | null
    finished_at: string | null
  }
}

export type QcSummaryResponse = {
  thresholds: {
    source: string
    items: { key: string; label: string; threshold: string }[]
  }
  /** #97a: policy 单源规则清单（actual 缺失为 null，不造数）。 */
  rules: SnapshotRule[]
  rulesSource: string
  jobs: QcSummaryJob[]
  meta: { source: string }
}

export type OverviewAlert = {
  type: 'task_blocked' | 'job_fail' | 'missing'
  id: string | null
  title: string
  detail: string | null
}

export type OverviewResponse = {
  counts: {
    tasks: { done: number; running: number; pending: number; blocked: number; total: number }
    jobs: { pass: number; fail: number; conditional: number; unknown: number; total: number }
  }
  alerts: OverviewAlert[]
  deliveries: Delivery[]
  running: { id: string; title: string; owner: string | null; progress: number | null }[]
  pending: { id: string; title: string; owner: string | null; progress: number | null }[]
  system: { online: boolean; latencyMs: number; queue: { running: number; pending: number } | null }
  meta: { source: string; planSource: string; jobsSource: string }
}

/** Gitea 状态（T-WEB-017b）；本地 files 模式仅存在于 `WEB_ISSUES_SOURCE=files` 调试路径。 */
export type IssueStatus = 'open' | 'closed'

export type IssueSource = 'gitea' | 'issue.json' | 'readme' | 'dir'

export type IssueLabel = { name: string; color: string }

export type ManualVerifyState = 'pending' | 'pass' | 'fail'

export type IssueItem = {
  id: string
  number: number
  title: string
  description: string | null
  owner: string | null
  /** issue #110 修复：Gitea 创建者；文件源无此字段。 */
  author?: string | null
  rail: string | null
  priority: string | null
  status: IssueStatus | null
  created_at: string | null
  updated_at: string | null
  dir: string | null
  source: IssueSource
  url: string
  labels: IssueLabel[]
  comments: number
  /** issue #77：source/acceptance 任务卡（默认隐藏，不删除）。 */
  is_task_card: boolean
  manual_verify: ManualVerifyState
  manual_verify_note: string | null
  manual_verify_key: string
}

export type IssueCounts = { open: number; closed: number; total: number }

export type IssueClassification = {
  real: IssueCounts
  task_cards: IssueCounts
}

export type IssuesMeta = {
  source: 'gitea' | 'files'
  repo?: string
  web_url?: string
  writable?: boolean
  root?: string
  scanned_at: string
  counts?: IssueCounts & { classification?: IssueClassification }
  fetched_at?: string
}

export type IssuesResponse = {
  available?: boolean
  reason?: string
  kind?: 'real' | 'tasks' | 'all'
  items: IssueItem[]
  count: number
  total?: number
  latest: IssueItem | null
  classification?: IssueClassification
  meta: IssuesMeta
}

/** `GET|POST /api/manual-verify`（issue #77）。 */
export type ManualVerifyView = {
  key: string
  state: ManualVerifyState
  note: string | null
  updated_at: string | null
}

export type ManualVerifyEntry = {
  state: 'pass' | 'fail'
  note: string | null
  updated_at: string
}

export type ManualVerifyList = {
  items: Record<string, ManualVerifyEntry>
  counts: { pass: number; fail: number }
}

export type CreateIssueInput = {
  title: string
  description: string | null
  owner: string | null
  rail: string | null
  priority: string | null
}

export type CreateIssueResponse = {
  item: IssueItem
  meta: IssuesMeta
}

/** `GET /api/issues/:n`（issue #110） */
export type IssueComment = {
  id: string
  author: string | null
  body: string
  created_at: string | null
  updated_at: string | null
  url: string
}

export type IssueDetailResponse = {
  item: IssueItem
  comments: IssueComment[]
  meta: IssuesMeta
}

export type IssueCommentResponse = {
  comment: IssueComment
  meta: IssuesMeta
}

/* ---------- /api/flow · /api/contract（T-WEB-015d2） ---------- */

export type FlowJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'unknown'
export type FlowJobStatusSource = 'state' | 'intake' | 'unknown'

export type FlowJobSummary = {
  id: string
  updated_at: string
  size: number
  status: FlowJobStatus
  status_source: FlowJobStatusSource
  stale: boolean
}

export type FlowTool = {
  name: string
  status: string | null
  duration_ms: number | null
  attempts: number | null
  error: string | null
  cached: boolean | null
  skipped: boolean | null
  artifact: string | null
}

export type FlowStage = {
  key: string
  status: string | null
  duration_s: number | null
  updated_at: string | null
  tools: FlowTool[]
  /** 该环节在 state 里真实记录的产物（tools[].artifact / frames / clips / rendered / …）。 */
  artifacts?: FlowArtifact[]
  /** 只在 state 真有 prompt 字段时存在（C: rendered[].prompt，D: clips[].prompt）。 */
  prompts?: FlowPrompt[]
}

export type FlowPrompt = {
  source: string
  shot_id: number | null
  text: string
  negative: string | null
  seed: number | null
}

export type FlowShot = {
  shot_id: number | null
  start: number | null
  end: number | null
  duration_s: number | null
}

export type FlowFrame = {
  shot_id: number | null
  frame_ts: number | null
  path: string | null
  exists: boolean
}

export type FlowArtifact = {
  path: string
  exists: boolean
  /** 真实产物类型；后端从扩展名得出，未知为 file。 */
  kind?: 'image' | 'video' | 'audio' | 'file'
  /** 上游字段名（抽帧 / 关键帧 / 片段 / 调色 / 工具产物 …）。 */
  label?: string
  /** 相对 KEX_REPO_ROOT 的 jobs/... 路径；不在仓库内为 null。 */
  rel?: string | null
  /** 仅当文件真实存在且位于 jobs/ 下时才有 `/media/kex?...`。 */
  url?: string | null
}

export type FlowJob = {
  id: string
  stage: string | null
  updated_at: string | null
  duration_s: number | null
  stages: FlowStage[]
  shots: FlowShot[]
  frames: FlowFrame[]
  semantics: Record<string, unknown> | null
  shot_semantics: Record<string, unknown>[] | null
  profile: Record<string, unknown> | null
  /** #103：profile.prompt.path 指向的场景 prompt 正文（只读透传；缺失为 null）。 */
  profile_prompt?: { path: string | null; version: string | null; text: string | null } | null
  probe: Record<string, unknown> | null
  cold_warm: Record<string, unknown> | null
  quality: unknown
  quality_gate: unknown
  artifacts: FlowArtifact[]
  decisions: Record<string, unknown>[]
  reports: {
    render: Record<string, unknown> | null
    assemble: Record<string, unknown> | null
    interpolate: Record<string, unknown> | null
  }
}

export type FlowLogs = {
  worker: { path: string; lines: string[] }
  lock_events: Record<string, unknown>[]
}

export type FlowResponse = {
  available: boolean
  reason?: string
  message?: string
  jobs?: FlowJobSummary[]
  job: FlowJob | null
  logs?: FlowLogs
  meta?: { root: string; generated_at: string; warnings: string[] }
}

export type ContractGateItem = {
  key: string
  name: string
  threshold: string | null
  source_line: string
}

export type ContractThresholdItem = {
  key: string
  op: string | null
  value: number | null
  unit: string | null
}

export type WorkflowNode = {
  id: string
  class_type: string
  inputs: Record<string, unknown>
}

export type WorkflowLink = {
  from: string
  from_slot: number
  to: string
  to_input: string
}

export type WorkflowCatalogItem = {
  name: string
  source: string
  node_count: number
  link_count: number
  primary: boolean
}

export type ContractWorkflow = {
  available: boolean
  reason: string | null
  source: string
  name: string
  sha256: string | null
  params: {
    width: number | null
    height: number | null
    length: number | null
    fps: number | null
    cfg: number | null
    steps: number | null
    denoise: number | null
    seed: number | null
    sampler: string | null
    scheduler: string | null
    ckpt: string | null
  }
  cutoff: unknown
  nodes: WorkflowNode[]
  links: WorkflowLink[]
  stats: {
    node_count: number
    link_count: number
    classes: string[]
  }
  catalog: WorkflowCatalogItem[]
}

export type ContractQueue = {
  inbox: string[]
  pending: string[]
  done: string[]
  failed: string[]
  rejected: string[]
  running: string[]
}

export type ContractRecent = {
  job: string
  probe: Record<string, unknown> | null
  render_report: { memory?: Record<string, unknown> } | null
  assemble_report: Record<string, unknown> | null
}

export type ContractResponse = {
  available: boolean
  reason?: string
  gate?: { source: string | null; updated_at: string | null; items: ContractGateItem[] }
  thresholds?: { source: string; items: ContractThresholdItem[] }
  workflow?: ContractWorkflow
  recent?: ContractRecent | null
  queue?: ContractQueue
  meta?: { root: string; generated_at: string; warnings: string[] }
}

/** `/api/reports/weekly`：周报汇总（任务统计、偏差、风险、燃尽）。 */
export type WeeklyTaskSummary = {
  total: number
  done: number
  running: number
  pending: number
  blocked: number
}

export type WeeklyDeviation = {
  task_id: string | null
  title: string | null
  owner: string | null
  status: string | null
  end_ts: string | null
  overdue_days: number
  progress: number | null
}

export type WeeklyRisk = {
  level: string
  task_id: string | null
  text: string
}

/** #108：风险处置动作（与 server/risk-decisions.ts 的 RISK_ACTIONS 一致）。 */
export type RiskAction = '同意了继续' | '暂停等开发' | '改期' | '接受风险（已知）'

export type RiskDecision = {
  id: string
  ts: string
  task_id: string
  action: RiskAction
  actor: string
  note: string
  issue_number: number | null
  comment_id: string | null
  comment_url: string | null
}

export type RiskDecisionListResponse = { decisions: RiskDecision[] }
export type RiskDecisionResponse = { decision: RiskDecision }

export type WeeklyMilestone = {
  id: string
  label: string
  at: string
  state: MilestoneState
  estimated?: boolean
}

export type WeeklyBurndownPoint = {
  date: string
  remaining: number
  done: number
}

export type WeeklyReportResponse = {
  available: boolean
  reason?: string
  period?: { from: string; to: string; days: number }
  summary?: {
    tasks: WeeklyTaskSummary
    completion_rate: number
    deliveries: { count: number; repaired: number }
  }
  burndown?: WeeklyBurndownPoint[] | null
  velocity?: { completed_per_day: number } | null
  deviations?: WeeklyDeviation[]
  risks?: WeeklyRisk[]
  milestones?: WeeklyMilestone[]
  meta?: { source: string; note: string }
}

/** 润色后的单个镜头（#87 §1.2 schema）。 */
export type StudioShot = {
  no: number
  duration_s: number
  prompt: string
  camera?: string
}

/** 润色结果（#87 §1.2 schema，服务端强校验）。 */
export type StudioPolished = {
  logline: string
  script: string
  shots: StudioShot[]
  style?: string
}

/** `/api/studio/briefs`：创作 Brief（#85 W1 契约， #87 增 polished/questions_pending）。 */
export type StudioBrief = {
  id: string
  idea: string
  audience: string | null
  duration_s: number | null
  aspect: string | null
  tone: string | null
  references: string[]
  polished: StudioPolished | null
  /** 最近一次润色的追问；非空时 `/confirm` 返回 409 questions_pending。 */
  questions_pending: string[]
  status: 'draft' | 'confirmed'
  version: number
  created_at: string
  updated_at: string
}

export type StudioBriefsResponse = { items: StudioBrief[]; count: number }

/** `POST /api/studio/briefs/:id/polish`（#87 §1.1）。 */
export type StudioBriefPolishResponse = {
  brief: StudioBrief
  questions: string[]
  llm: { model: string; elapsed_ms: number }
}

/** `POST /api/studio/briefs/:id/confirm`（#87 §1.3）。 */
export type StudioBriefConfirmResponse = {
  brief: StudioBrief
  job_gate: 'open'
}

export type StudioJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'
export type StudioJobType = 'aigc' | 'optimize' | 'image'

export type StudioAsset = {
  id: string
  kind: 'video' | 'image' | 'audio' | 'subtitle' | 'report'
  uri: string
  sha256: string | null
  size_bytes: number
  width: number | null
  height: number | null
  duration_s: number | null
  fps: number | null
  derived_from: string[]
  job_id: string
  version: number
  license: string | null
  created_at: string
}

export type StudioJobSummary = {
  id: string
  type: StudioJobType
  rail: 'A' | 'B'
  status: StudioJobStatus
  brief_id: string | null
  created_at: string
  updated_at: string
  error: string | null
  stage: string | null
  /** #154: 真实耗时（ms）；null 时展示「耗时未记录」。 */
  duration_ms: number | null
}

/** #89b: 产物引用（绝不暴露 studio 绝对路径，`url` 一律走 /api 代理）。 */
export type StudioAssetRef = {
  source_job: string
  name: string
  url: string | null
}

/** #89b: 注入到下一个 A 轨任务的 C 阶段关键帧（仅 shot 1）。 */
export type StudioKeyframeRef = {
  source_job: string
  name: string
}

export type StudioJob = StudioJobSummary & {
  plan_id: null
  model: Record<string, unknown> | null
  inputs: Array<{ asset_id: string; role: string }>
  outputs: string[]
  assets: StudioAsset[]
  qc: { status: 'pending' | 'pass' | 'fail'; report_id: null }
  cost: { gpu_seconds: number | null; credits: number | null }
  created_by: 'web'
  events: Array<{ ts: string; type: string; message: string }>
  progress: { stage: string | null; stages: Record<string, string> }
  /** #89b: 已清洗的封面引用，可能缺失。 */
  cover_asset?: StudioAssetRef | null
  cover_url?: string | null
  /** #89b: 编排器写下，表示该任务用到了注入的关键帧。 */
  keyframe_source?: string | null
  keyframe_asset?: StudioKeyframeRef | null
}

/** #89b: 图片任务（t2i / edit）参数。 */
export type StudioImageMode = 't2i' | 'edit'

export type StudioImageRequest = {
  mode: StudioImageMode
  prompt: string
  negative?: string
  width?: number
  height?: number
  seed?: number
  steps?: number
  denoise?: number
  /** t2i 必须是 1.0；edit 才是重绘强度。 */
  source_upload_id?: string
  source_image?: string
}

/** `GET /api/studio/gallery`（#89b）的单条记录。 */
export type StudioGalleryItem = {
  id: string
  status: StudioJobStatus
  created_at: string
  updated_at: string
  error: string | null
  stage: string | null
  mode: StudioImageMode | null
  prompt: string | null
  negative: string | null
  width: number | null
  height: number | null
  seed: number | null
  steps: number | null
  denoise: number | null
  elapsed_s: number | null
  /** #139 真实耗时（ms）；intake/state 与时间戳都推不出时为 null，展示「耗时未记录」。 */
  duration_ms: number | null
  /** `url` 恒为 `/api/studio/jobs/:id/artifacts/:name`。 */
  images: Array<{ name: string; url: string }>
  cover_url: string | null
}

export type StudioJobsResponse = { items: StudioJobSummary[]; count: number; source: 'studio' }

/* ------------------------------------------------------------------ */
/* Agent / Skill 库（Gitea #88b）                                      */
/* ------------------------------------------------------------------ */

export type AgentType = 'skill' | 'agent' | 'profile'
export type AgentNamespace = 'seed' | 'import' | 'user' | string

export type AgentSource = {
  kind: 'local' | 'import' | 'edit' | string
  url: string | null
  repo: string | null
  commit: string | null
  license: string | null
  sha256: string
  imported_at?: string
}

export type AgentVersion = {
  version: number
  sha256: string
  created_at: string
  message: string
}

export type AgentHost = 'macbook' | 'studio' | '未指定'
export type AgentProject = 'kex-labs-video' | 'agent-memory' | 'lofa' | '通用' | '未分组'

/** #109 可绑定技能（详情接口按同项目计算）。 */
export type AgentBindableSkill = {
  id: string
  name: string
  description?: string
  project: AgentProject
}

export type AgentMeta = {
  id: string
  type: AgentType
  name: string
  description: string
  namespace: AgentNamespace
  active: boolean
  active_version: number
  source: AgentSource
  created_at: string
  updated_at: string
  versions: AgentVersion[]
  // #109 taxonomy：meta 已存值优先，否则来自 seed-agents/classify.json。
  host?: AgentHost
  project?: AgentProject
  skills?: string[]
}

/** `GET /api/agents` 的列表项：meta 摘要 + 版本数。 */
export type AgentItem = Omit<AgentMeta, 'versions'> & { versions_count: number }

export type AgentCounts = Record<AgentType, number>

export type AgentsResponse = {
  items: AgentItem[]
  counts: AgentCounts
}

export type AgentDetail = {
  meta: AgentMeta
  content: string
  bindable_skills?: AgentBindableSkill[]
}

export type AgentDiffResponse = {
  unified: string
}

export type AgentSeedResponse = {
  created: AgentCounts
  skipped: AgentCounts
  created_total: number
  skipped_total: number
}

export type AgentPutResponse = {
  meta: AgentMeta
  version: number
}

export type AgentImportInput = {
  type: AgentType
  url: string
  license?: string
  repo?: string
  commit?: string
  id?: string
}

export type VideoTemplateId =
  | 'marketing'
  | 'documentary'
  | 'narrative'
  | 'historical_novel'
  | 'vlog'
  | 'product_demo'
  | 'scenic_essay'

export type ScriptPromptTemplateInfo = {
  id: VideoTemplateId
  category: string
  label: string
  englishName: string
  githubStandard: string
  sourceUrl?: string
  summary: string
  structureBeats: string
  opticalSpec: string
  recommendedProfile: 'ad_teal_orange' | 'vlog_warm_film' | 'doc_neutral' | 'landscape_low_sat'
  recommendedDurationS: 10 | 15 | 20 | 30 | 45 | 60
  recommendedAspect: '16:9' | '9:16' | '1:1' | '4:5'
  supportsNovelSeries?: boolean
  systemDirectives: string
  /** #134: `GET /api/script-templates` 合并后的来源（default = 内置，override = 本地覆盖）。 */
  source?: 'default' | 'override'
}

export type UpstreamGithubSource = {
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

export type GiteaDiscoveredLocation = {
  repo: string
  branch: string
  filePath: string
  matchedTemplates: number
  htmlUrl?: string | null
}

export type GiteaTemplateSource = {
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

export type TemplateSyncState = {
  autoSyncEnabled: boolean
  intervalHours: 6 | 12 | 24 | 72
  lastSyncedAt: string | null
  lastSyncMode: 'manual' | 'scheduled' | 'initial'
  syncStatus: 'idle' | 'synced' | 'partial'
  lastResultMessage: string
  sources: UpstreamGithubSource[]
  giteaSource?: GiteaTemplateSource
}

export type HistoricalLookupResponse = {
  ok: boolean
  era_labels: string[]
  brief: string
  sources: HistoricalSourceRef[]
  ai_verified: boolean
  model: string | null
  elapsed_ms: number
}

export type HistoricalSourceRef = {
  title: string
  url: string
}

export type NovelChapterOutline = {
  chapter_no: number
  title: string
  era_anchor: string
  summary: string
  key_conflict: string
}

export type GeminiScriptScene = {
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

export type GeminiGeneratedScript = {
  title: string
  logline: string
  tone: string
  aspect: string
  style: string
  profile?: string
  template_id?: VideoTemplateId | string
  template_label?: string
  optimization_notes?: string
  story_era?: string
  episode_mode?: 'single' | 'novel_series'
  historical_context?: string
  historical_sources?: HistoricalSourceRef[]
  chapters?: NovelChapterOutline[]
  duration_s: number
  markdown: string
  scenes: GeminiScriptScene[]
}

export type GeminiScriptResponse = {
  model: string
  elapsed_ms: number
  grounding?: {
    used: boolean
    reason?: string
    matched_eras?: string[]
    sources?: HistoricalSourceRef[]
  }
  script: GeminiGeneratedScript
}

export type LookProfileId =
  | 'natural_clarity'
  | 'teal_orange'
  | 'warm_film'
  | 'landscape_vivid'

export type OptimizeParams = {
  profile: LookProfileId
  denoise: number
  sharpen: number
  contrast: number
  brightness: number
  saturation: number
  warmth: number
  upscale_1080p: boolean
  smooth_30fps: boolean
}

export type VideoMediaProbe = {
  width: number
  height: number
  fps: number
  duration_s: number
  codec: string
  pix_fmt: string
  bit_rate: number | null
  size_bytes: number
  has_audio: boolean
}

export type ExtractedFrame = {
  index: number
  filename: string
  timestamp_s: number
  timecode: string
  url: string
  after_filename?: string | null
  after_url?: string | null
}

export type FrameShotBreakdown = {
  frame_index: number
  timecode: string
  shot_type: string
  subject: string
  lighting_color: string
  flaw_diagnosis: string
  enhance_action: string
}

export type FrameAnalysisResult = {
  overall_assessment: string
  recommended_profile: LookProfileId
  recommended_profile_reason: string
  recommended_params: OptimizeParams
  shots: FrameShotBreakdown[]
}

export type OptimizeSession = {
  id: string
  filename: string
  created_at: string
  updated_at: string
  source_url: string
  enhanced_url: string | null
  probe: VideoMediaProbe
  enhanced_probe: VideoMediaProbe | null
  frames: ExtractedFrame[]
  params: OptimizeParams
  elapsed_ms: number | null
  filter_summary: string | null
  ai_analysis: FrameAnalysisResult | null
}

export type OptimizeSampleItem = {
  key: string
  label: string
  filename: string
  size_bytes: number
  description: string
}

