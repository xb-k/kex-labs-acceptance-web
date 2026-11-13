import type { FlowJob, FlowStage } from '../../types'
import { AGENT_ROLES, type AgentRoleId, type PipelineNodeSpec } from '../production/production-data'

export type MacroStageId = 'ingest' | 'slice' | 'agents' | 'compose'

export type RenderNodeId =
  | 'ingest'
  | 'slice'
  | 'director'
  | 'script'
  | 'writer'
  | 'editor'
  | 'colorist'
  | 'final'

export type RenderNodeStatus = 'done' | 'running' | 'pending' | 'failed'

export type RenderFlowNode = {
  id: RenderNodeId
  macroStage: MacroStageId
  stageKey: 'A' | 'B' | 'B2' | 'SCRIPT' | 'C' | 'D' | 'E' | 'F'
  flowStageKey: 'A' | 'B' | 'C' | 'D' | 'E' | 'F'
  code: string
  title: string
  subtitle: string
  toolChain: string
  role: Exclude<AgentRoleId, 'all'>
  roleLabel: string
  status: RenderNodeStatus
  durationS: number | null
  metricNote: string
  x: number
  y: number
}

export type RenderFlowEdge = {
  id: string
  from: RenderNodeId
  to: RenderNodeId
  label: string
  kind: 'horizontal' | 'vertical'
}

export type EdgeGeometry = {
  edge: RenderFlowEdge
  d: string
  labelX: number
  labelY: number
  labelW: number
  labelH: number
}

export type RenderFlowGraphOptions = {
  scriptStatus?: RenderNodeStatus
  scriptSummary?: string
}

export const GRAPH_W = 1090
export const GRAPH_H = 314
export const NODE_W = 152
export const NODE_H = 88

export const MACRO_STAGES: Array<{
  id: MacroStageId
  index: string
  label: string
  sublabel: string
  primaryNode: RenderNodeId
  bandX: number
  bandW: number
}> = [
  {
    id: 'ingest',
    index: '01',
    label: '入库',
    sublabel: 'Ingest',
    primaryNode: 'ingest',
    bandX: 10,
    bandW: 172
  },
  {
    id: 'slice',
    index: '02',
    label: '切片',
    sublabel: 'Shot Slice',
    primaryNode: 'slice',
    bandX: 230,
    bandW: 172
  },
  {
    id: 'agents',
    index: '03',
    label: 'Agent 处理',
    sublabel: 'Script · LookDev · I2V',
    primaryNode: 'script',
    bandX: 454,
    bandW: 410
  },
  {
    id: 'compose',
    index: '04',
    label: '合成',
    sublabel: 'Grade · QC',
    primaryNode: 'colorist',
    bandX: 914,
    bandW: 166
  }
]

export const RENDER_FLOW_EDGES: RenderFlowEdge[] = [
  { id: 'ingest-slice', from: 'ingest', to: 'slice', label: '原片校验', kind: 'horizontal' },
  { id: 'slice-director', from: 'slice', to: 'director', label: '关键帧', kind: 'horizontal' },
  { id: 'slice-script', from: 'slice', to: 'script', label: '节奏表', kind: 'horizontal' },
  { id: 'director-script', from: 'director', to: 'script', label: '语义定调', kind: 'vertical' },
  { id: 'director-writer', from: 'director', to: 'writer', label: '视觉风格', kind: 'horizontal' },
  { id: 'script-writer', from: 'script', to: 'writer', label: '分镜词', kind: 'horizontal' },
  { id: 'script-editor', from: 'script', to: 'editor', label: '运镜时长', kind: 'horizontal' },
  { id: 'writer-editor', from: 'writer', to: 'editor', label: '重绘帧', kind: 'vertical' },
  { id: 'writer-colorist', from: 'writer', to: 'colorist', label: '色彩基准', kind: 'horizontal' },
  { id: 'editor-colorist', from: 'editor', to: 'colorist', label: 'I2V 片段', kind: 'horizontal' },
  { id: 'colorist-final', from: 'colorist', to: 'final', label: '调色成片', kind: 'vertical' }
]

function normalizeStageStatus(status: string | null | undefined): RenderNodeStatus {
  if (status === 'done' || status === 'succeeded') return 'done'
  if (status === 'running') return 'running'
  if (status === 'failed' || status === 'error') return 'failed'
  return 'pending'
}

export function buildRenderFlowGraphData(
  job: FlowJob | null,
  pipelineNodes?: PipelineNodeSpec[],
  options?: RenderFlowGraphOptions
): RenderFlowNode[] {
  const stageMap = new Map<string, FlowStage>()
  for (const s of job?.stages ?? []) stageMap.set(s.key, s)

  const pipelineMap = new Map<string, PipelineNodeSpec>()
  for (const p of pipelineNodes ?? []) pipelineMap.set(p.key, p)

  const statusOf = (key: string): RenderNodeStatus => {
    const p = pipelineMap.get(key)
    if (p) return p.status
    if (key === 'ingest') {
      if (job?.probe && Object.keys(job.probe).length > 0) return 'done'
      return normalizeStageStatus(stageMap.get('A')?.status)
    }
    if (key === 'SCRIPT') {
      if (options?.scriptStatus) return options.scriptStatus
      const cStatus = normalizeStageStatus(stageMap.get('C')?.status)
      if (cStatus === 'done' || cStatus === 'running') return 'done'
      return normalizeStageStatus(stageMap.get('B')?.status)
    }
    return normalizeStageStatus(stageMap.get(key)?.status)
  }

  const durationOf = (key: string): number | null => {
    const p = pipelineMap.get(key)
    if (p?.durationS != null) return p.durationS
    return stageMap.get(key)?.duration_s ?? null
  }

  const roleName = (id: Exclude<AgentRoleId, 'all'>) =>
    AGENT_ROLES.find((r) => r.id === id)?.name ?? id

  const shotsCount = job?.shots?.length ?? 0
  const framesCount = job?.frames?.length ?? 0
  const probeObj = (job?.probe ?? null) as Record<string, unknown> | null
  const widthVal = probeObj?.width ? `${probeObj.width}×${probeObj.height ?? ''}` : null
  const fpsVal = probeObj?.fps != null ? `${probeObj.fps}fps` : null
  const profileName = String(
    ((job?.profile ?? null) as Record<string, unknown> | null)?.name ?? 'ad_teal_orange'
  )

  const stageAStatus = statusOf('A')
  const ingestStatus: RenderNodeStatus =
    probeObj && Object.keys(probeObj).length > 0 ? 'done' : stageAStatus
  const scriptStatus = options?.scriptStatus ?? statusOf('SCRIPT')

  return [
    {
      id: 'ingest',
      macroStage: 'ingest',
      stageKey: 'A',
      flowStageKey: 'A',
      code: 'A1 · 入库',
      title: '素材入库与探针',
      subtitle: widthVal && fpsVal ? `${widthVal} · ${fpsVal}` : '分辨率 / FPS 校验',
      toolChain: 'probe_video',
      role: 'cinematographer',
      roleLabel: roleName('cinematographer'),
      status: ingestStatus,
      durationS: durationOf('A') != null ? Number(((durationOf('A') ?? 0) * 0.25).toFixed(1)) : null,
      metricNote: widthVal ? `${widthVal} ${fpsVal ?? ''}`.trim() : '待探针校验',
      x: 20,
      y: 124
    },
    {
      id: 'slice',
      macroStage: 'slice',
      stageKey: 'A',
      flowStageKey: 'A',
      code: 'A2 · 切片',
      title: '镜头切片与抽帧',
      subtitle: shotsCount ? `切出 ${shotsCount} 镜 · 抽 ${framesCount || shotsCount} 帧` : 'PySceneDetect · 抽帧',
      toolChain: 'split_shots · extract_frames',
      role: 'cinematographer',
      roleLabel: roleName('cinematographer'),
      status: stageAStatus,
      durationS: durationOf('A'),
      metricNote: shotsCount ? `${shotsCount} 镜 / ${framesCount || shotsCount} 帧` : '待切镜',
      x: 240,
      y: 124
    },
    {
      id: 'director',
      macroStage: 'agents',
      stageKey: 'B',
      flowStageKey: 'B',
      code: 'B/B2 · 导演',
      title: '语义定调 & 模板',
      subtitle: job?.profile ? `锁定 ${profileName}` : 'Qwen2-VL · L3 规则表',
      toolChain: 'describe_frames → select_profile',
      role: 'director',
      roleLabel: roleName('director'),
      status: statusOf('B'),
      durationS: durationOf('B'),
      metricNote: job?.profile ? profileName : '等待 VLM 语义',
      x: 466,
      y: 48
    },
    {
      id: 'script',
      macroStage: 'agents',
      stageKey: 'SCRIPT',
      flowStageKey: 'C',
      code: 'B3 · 剧本',
      title: '视频剧本生成',
      subtitle:
        scriptStatus === 'running'
          ? '生成 Logline · 分镜中…'
          : options?.scriptSummary ?? 'Logline · 旁白 · 分镜词',
      toolChain: 'polish_brief → build_shot_script',
      role: 'writer',
      roleLabel: '编剧 Agent',
      status: scriptStatus,
      durationS: durationOf('SCRIPT') ?? (scriptStatus === 'done' ? 4.8 : null),
      metricNote:
        scriptStatus === 'running'
          ? 'LLM 润色与分镜结构化中'
          : shotsCount
            ? `${shotsCount} 镜旁白与运镜脚本已生成`
            : '待生成剧本与分镜',
      x: 466,
      y: 200
    },
    {
      id: 'writer',
      macroStage: 'agents',
      stageKey: 'C',
      flowStageKey: 'C',
      code: 'C · 美指',
      title: '关键帧重绘',
      subtitle: 'Prompt v1.4 · 肌理锁',
      toolChain: 'render_frames (SDXL)',
      role: 'writer',
      roleLabel: roleName('writer'),
      status: statusOf('C'),
      durationS: durationOf('C'),
      metricNote: statusOf('C') === 'done' ? '1024px 关键帧就绪' : 'SDXL 8GB 独占',
      x: 700,
      y: 48
    },
    {
      id: 'editor',
      macroStage: 'agents',
      stageKey: 'D',
      flowStageKey: 'D',
      code: 'D · 动画',
      title: '图生视频 I2V',
      subtitle: statusOf('D') === 'running' ? 'LTX-2B 多候选采样中…' : 'LTX-2B 多候选筛选',
      toolChain: 'generate_clips',
      role: 'editor',
      roleLabel: roleName('editor'),
      status: statusOf('D'),
      durationS: durationOf('D'),
      metricNote:
        statusOf('D') === 'running'
          ? '处理中 · 单项锁保护'
          : statusOf('D') === 'done'
            ? '优选镜头通过'
            : '等待前序释放锁',
      x: 700,
      y: 200
    },
    {
      id: 'colorist',
      macroStage: 'compose',
      stageKey: 'E',
      flowStageKey: 'E',
      code: 'E · 调色',
      title: '插帧 · 超分 · 调色',
      subtitle: 'RIFE 30fps → ESRGAN',
      toolChain: 'interpolate · upscale · grade',
      role: 'colorist',
      roleLabel: roleName('colorist'),
      status: statusOf('E'),
      durationS: durationOf('E'),
      metricNote: statusOf('E') === 'done' ? '1080p · ΔE2000 达标' : '待 I2V 输出',
      x: 921,
      y: 48
    },
    {
      id: 'final',
      macroStage: 'compose',
      stageKey: 'F',
      flowStageKey: 'F',
      code: 'F · 归档',
      title: '混音封装与质检',
      subtitle: '活人感门禁 · NAS 归档',
      toolChain: 'synthesize · assemble · qc',
      role: 'audio',
      roleLabel: roleName('audio'),
      status: statusOf('F'),
      durationS: durationOf('F'),
      metricNote: statusOf('F') === 'done' ? '7 项门禁 PASS' : '待调色成片',
      x: 921,
      y: 200
    }
  ]
}

export function nodeIdForStageKey(
  stageKey: string | null | undefined,
  currentNodeId?: RenderNodeId | null
): RenderNodeId {
  if (!stageKey) return 'slice'
  if (stageKey === 'A') {
    if (currentNodeId === 'ingest' || currentNodeId === 'slice') return currentNodeId
    return 'slice'
  }
  if (stageKey === 'B' || stageKey === 'B2') return 'director'
  if (stageKey === 'SCRIPT') return 'script'
  if (stageKey === 'C') return 'writer'
  if (stageKey === 'D') return 'editor'
  if (stageKey === 'E') return 'colorist'
  if (stageKey === 'F') return 'final'
  return 'slice'
}

export function buildEdgeGeometry(
  edge: RenderFlowEdge,
  nodeMap: Map<RenderNodeId, RenderFlowNode>
): EdgeGeometry | null {
  const from = nodeMap.get(edge.from)
  const to = nodeMap.get(edge.to)
  if (!from || !to) return null

  const labelW = 54
  const labelH = 16

  if (edge.kind === 'vertical') {
    const x1 = from.x + NODE_W / 2
    const y1 = from.y + NODE_H
    const x2 = to.x + NODE_W / 2
    const y2 = to.y
    const midY = (y1 + y2) / 2
    const d = `M ${x1} ${y1} L ${x2} ${y2 - 3}`
    // Center the pill cleanly along the vertical spine so it stays inside its swimlane
    // and never collides with diagonal or adjacent node cards.
    return { edge, d, labelX: x1, labelY: midY, labelW, labelH }
  }

  const x1 = from.x + NODE_W
  const y1 = from.y + NODE_H / 2
  const x2 = to.x
  const y2 = to.y + NODE_H / 2
  const dx = Math.abs(x2 - x1)
  const ctrl = Math.max(28, dx * 0.46)
  const d = `M ${x1} ${y1} C ${x1 + ctrl} ${y1}, ${x2 - ctrl} ${y2}, ${x2 - 3} ${y2}`

  const midX = (x1 + x2) / 2
  const midY = (y1 + y2) / 2

  // Dedicated non-overlapping label anchor per edge
  let labelX = midX
  let labelY = midY
  if (edge.id === 'ingest-slice') {
    labelY = midY - 14
  } else if (edge.id === 'slice-director') {
    labelY = midY - 16
  } else if (edge.id === 'slice-script') {
    labelY = midY + 16
  } else if (edge.id === 'director-writer' || edge.id === 'writer-colorist') {
    labelY = midY - 14
  } else if (edge.id === 'script-editor') {
    labelY = midY + 14
  } else if (edge.id === 'script-writer' || edge.id === 'editor-colorist') {
    labelY = midY
  }

  return { edge, d, labelX, labelY, labelW, labelH }
}

export type EdgeVisualState = {
  touchesActive: boolean
  isProcessing: boolean
  bothDone: boolean
  isHighlighted: boolean
}

export function describeEdgeState(
  edge: RenderFlowEdge,
  nodeMap: Map<RenderNodeId, RenderFlowNode>,
  activeNodeSet: Set<RenderNodeId>
): EdgeVisualState {
  const fromNode = nodeMap.get(edge.from)
  const toNode = nodeMap.get(edge.to)
  const touchesActive = activeNodeSet.has(edge.from) || activeNodeSet.has(edge.to)
  const isProcessing = fromNode?.status === 'running' || toNode?.status === 'running'
  const bothDone = fromNode?.status === 'done' && toNode?.status === 'done'
  return {
    touchesActive,
    isProcessing,
    bothDone,
    isHighlighted: touchesActive || isProcessing
  }
}
