import type { FlowJob, PlanTask, StudioJobSummary } from '../../types'
import { AGENT_ROLES, type PipelineNodeSpec, type ShotStoryboardItem } from './production-data'

export interface EfficiencyTrendPoint {
  key: string
  slot: string
  shortLabel: string
  roleName: string
  completionRate: number
  agentLoad: number
  durationS: number
  statusLabel: '已完成' | '处理中' | '待执行' | '异常'
}

export interface AgentLoadPoint {
  roleId: string
  roleName: string
  toolLabel: string
  loadPct: number
  completionPct: number
  durationS: number
  actionsCount: number
  activeStatus: '执行中' | '已完成' | '待命'
}

export interface DailyEfficiencySummary {
  overallCompletionRate: number
  nodeCompletionRate: number
  doneNodes: number
  totalNodes: number
  doneTasks: number
  runningTasks: number
  blockedTasks: number
  totalTasks: number
  avgAgentLoad: number
  peakAgentLoad: number
  peakAgentRole: string
  activeAgentsCount: number
  totalRenderDurationS: number
  studioCompletedCount: number
  studioTotalCount: number
}

export interface DailyEfficiencyInput {
  job: FlowJob | null
  nodes: PipelineNodeSpec[]
  storyboard: ShotStoryboardItem[]
  tasks: PlanTask[]
  studioJobs?: StudioJobSummary[]
  deliveriesCount: number
  memPct: number
}

const SHORT_LABEL_BY_KEY: Record<string, string> = {
  A: 'A 入库',
  B: 'B 语义',
  B2: 'B2 定调',
  SCRIPT: '剧本生成',
  C: 'C 关键帧',
  D: 'D 渲染',
  E: 'E 调色',
  F: 'F 交付'
}

const STATUS_LABEL_MAP: Record<PipelineNodeSpec['status'], EfficiencyTrendPoint['statusLabel']> = {
  done: '已完成',
  running: '处理中',
  pending: '待执行',
  failed: '异常'
}

const TASK_STAGE_KEYWORDS: Record<string, string[]> = {
  A: ['阶段 A', 'PySceneDetect', '抽帧'],
  B: ['阶段 B ·', 'Qwen2-VL', '语义'],
  B2: ['阶段 B2', 'Director', '挂载'],
  SCRIPT: ['剧本', '脚本', '前端可视化'],
  C: ['阶段 C', 'SDXL', '关键帧'],
  D: ['阶段 D', 'LTX-2B', '采样'],
  E: ['阶段 E', 'grade_color', 'LUT', '超分'],
  F: ['阶段 F', 'Kokoro', 'TTS', '混音', '归档']
}

function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, Math.round(value)))
}

function nodeBaseCompletion(node: PipelineNodeSpec, matchedTasks: PlanTask[]): number {
  if (node.status === 'done') return 100
  if (node.status === 'failed') return 15
  if (node.status === 'running') {
    const taskAvg =
      matchedTasks.length > 0
        ? matchedTasks.reduce((sum, t) => sum + (Number.isFinite(t.progress) ? t.progress : 50), 0) /
          matchedTasks.length
        : 62
    return clampPct(Math.max(35, Math.min(92, taskAvg)))
  }
  if (matchedTasks.length > 0) {
    const avg = matchedTasks.reduce((sum, t) => sum + (Number.isFinite(t.progress) ? t.progress : 0), 0) / matchedTasks.length
    return clampPct(avg * 0.6)
  }
  return 0
}

function matchTasksForStage(stageKey: string, tasks: PlanTask[]): PlanTask[] {
  const keys = TASK_STAGE_KEYWORDS[stageKey] ?? []
  if (keys.length === 0) return []
  return tasks.filter((t) => keys.some((kw) => t.title.includes(kw) || t.id.includes(kw)))
}

export function buildDailyEfficiencyData(input: DailyEfficiencyInput): {
  summary: DailyEfficiencySummary
  timelineSeries: EfficiencyTrendPoint[]
  agentLoadSeries: AgentLoadPoint[]
} {
  const { job, nodes, storyboard, tasks, studioJobs = [], deliveriesCount, memPct } = input
  const safeMem = clampPct(memPct)

  const stageDurationMap = new Map<string, number>()
  const stageAttemptsMap = new Map<string, number>()
  for (const s of job?.stages ?? []) {
    const dur = typeof s.duration_s === 'number' && Number.isFinite(s.duration_s) ? s.duration_s : 0
    stageDurationMap.set(s.key, dur)
    const attempts = s.tools.reduce((sum, t) => sum + (typeof t.attempts === 'number' ? t.attempts : 0), 0)
    stageAttemptsMap.set(s.key, attempts)
  }

  const maxDuration = Math.max(
    1,
    ...nodes.map((n) => n.durationS ?? stageDurationMap.get(n.key) ?? 0)
  )

  const roleActionCounts = new Map<string, number>()
  for (const shot of storyboard) {
    for (const action of shot.actions) {
      roleActionCounts.set(action.role, (roleActionCounts.get(action.role) ?? 0) + 1)
    }
  }

  const nodeCompletions: number[] = []
  const timelineSeries: EfficiencyTrendPoint[] = nodes.map((node, index) => {
    const matchedTasks = matchTasksForStage(node.key, tasks)
    const stepCompletion = nodeBaseCompletion(node, matchedTasks)
    nodeCompletions.push(stepCompletion)

    const cumulativeCompletion = clampPct(
      nodeCompletions.reduce((sum, v) => sum + v, 0) / Math.max(1, index + 1)
    )

    const rawDuration = node.durationS ?? stageDurationMap.get(node.key) ?? 0
    const durationWeight = Math.round((Math.log1p(rawDuration) / Math.log1p(maxDuration)) * 42)
    const attempts = stageAttemptsMap.get(node.key) ?? 0
    const retryWeight = Math.min(18, attempts * 7)
    const activeBoost = node.status === 'running' ? 32 : node.status === 'done' ? 18 : 6
    const memShare = node.status === 'running' ? Math.round(safeMem * 0.35) : node.status === 'done' ? Math.round(safeMem * 0.18) : 4
    const taskRunningBonus = matchedTasks.some((t) => t.status === 'running' || t.status === 'in_progress') ? 12 : 0

    const agentLoad = clampPct(activeBoost + durationWeight + retryWeight + memShare + taskRunningBonus)
    const roleMeta = AGENT_ROLES.find((r) => r.id === node.role)

    return {
      key: node.key,
      slot: `${node.code} · ${node.title}`,
      shortLabel: SHORT_LABEL_BY_KEY[node.key] ?? node.code,
      roleName: roleMeta?.name ?? 'Agent',
      completionRate: cumulativeCompletion,
      agentLoad,
      durationS: Number(rawDuration.toFixed(1)),
      statusLabel: STATUS_LABEL_MAP[node.status]
    }
  })

  const agentLoadSeries: AgentLoadPoint[] = AGENT_ROLES.map((role) => {
    const roleNodes = nodes.filter((n) => n.role === role.id)
    const rolePoints = timelineSeries.filter((p) => roleNodes.some((rn) => rn.key === p.key))
    const actionsCount = roleActionCounts.get(role.id) ?? 0
    const totalDur = roleNodes.reduce((sum, n) => sum + (n.durationS ?? 0), 0)

    const hasRunning = roleNodes.some((n) => n.status === 'running')
    const allDone = roleNodes.length > 0 && roleNodes.every((n) => n.status === 'done')

    const roleCompletion =
      roleNodes.length > 0
        ? clampPct(
            roleNodes.reduce((sum, n) => {
              const matched = matchTasksForStage(n.key, tasks)
              return sum + nodeBaseCompletion(n, matched)
            }, 0) / roleNodes.length
          )
        : 0

    const baseLoad =
      rolePoints.length > 0
        ? rolePoints.reduce((sum, p) => sum + p.agentLoad, 0) / rolePoints.length
        : 12
    const actionDensityBonus = Math.min(14, actionsCount * 3)
    const loadPct = clampPct(baseLoad + (hasRunning ? 10 : 0) + actionDensityBonus)

    return {
      roleId: role.id,
      roleName: role.name,
      toolLabel: role.modelOrTool,
      loadPct,
      completionPct: roleCompletion,
      durationS: Number(totalDur.toFixed(1)),
      actionsCount,
      activeStatus: hasRunning ? '执行中' : allDone ? '已完成' : '待命'
    }
  })

  const doneNodes = nodes.filter((n) => n.status === 'done').length
  const totalNodes = nodes.length
  const nodeCompletionRate = totalNodes > 0 ? clampPct((doneNodes / totalNodes) * 100) : 0

  const doneTasks = tasks.filter((t) => t.status === 'done').length
  const runningTasks = tasks.filter((t) => t.status === 'running' || t.status === 'in_progress').length
  const blockedTasks = tasks.filter((t) => t.status === 'blocked').length
  const totalTasks = tasks.length

  const weightedTaskRate =
    totalTasks > 0
      ? tasks.reduce((sum, t) => {
          if (t.status === 'done') return sum + 100
          return sum + Math.max(0, Math.min(99, Number.isFinite(t.progress) ? t.progress : 0))
        }, 0) / totalTasks
      : nodeCompletionRate

  const studioCompletedCount = studioJobs.filter((j) => j.status === 'succeeded').length + deliveriesCount
  const studioTotalCount = studioJobs.length + deliveriesCount
  const studioRate = studioTotalCount > 0 ? (studioCompletedCount / studioTotalCount) * 100 : nodeCompletionRate

  const overallCompletionRate = clampPct(
    nodeCompletionRate * 0.5 + weightedTaskRate * 0.35 + studioRate * 0.15
  )

  const avgAgentLoad =
    agentLoadSeries.length > 0
      ? clampPct(agentLoadSeries.reduce((sum, item) => sum + item.loadPct, 0) / agentLoadSeries.length)
      : 0

  const peakItem = agentLoadSeries.reduce<AgentLoadPoint | null>(
    (best, cur) => (!best || cur.loadPct > best.loadPct ? cur : best),
    null
  )

  const activeAgentsCount = agentLoadSeries.filter(
    (item) => item.activeStatus === '执行中' || item.actionsCount > 0
  ).length

  const totalRenderDurationS = Number(
    nodes.reduce((sum, n) => sum + (n.durationS ?? 0), 0).toFixed(1)
  )

  return {
    summary: {
      overallCompletionRate,
      nodeCompletionRate,
      doneNodes,
      totalNodes,
      doneTasks,
      runningTasks,
      blockedTasks,
      totalTasks,
      avgAgentLoad,
      peakAgentLoad: peakItem?.loadPct ?? 0,
      peakAgentRole: peakItem?.roleName ?? '—',
      activeAgentsCount,
      totalRenderDurationS,
      studioCompletedCount,
      studioTotalCount
    },
    timelineSeries,
    agentLoadSeries
  }
}
