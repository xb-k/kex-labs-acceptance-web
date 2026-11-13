import { useEffect, useId, useMemo, useState } from 'react'
import { Check } from '../icons'
import type { FlowJob } from '../../types'
import { AGENT_ROLES, type PipelineNodeSpec } from '../production/production-data'
import {
  GRAPH_H,
  GRAPH_W,
  MACRO_STAGES,
  NODE_H,
  NODE_W,
  RENDER_FLOW_EDGES,
  buildEdgeGeometry,
  buildRenderFlowGraphData,
  describeEdgeState,
  nodeIdForStageKey,
  type EdgeGeometry,
  type MacroStageId,
  type RenderFlowNode,
  type RenderNodeId,
  type RenderNodeStatus
} from './render-flow-graph-model'

export {
  MACRO_STAGES,
  RENDER_FLOW_EDGES,
  buildRenderFlowGraphData,
  describeEdgeState,
  nodeIdForStageKey,
  type EdgeVisualState,
  type MacroStageId,
  type RenderFlowEdge,
  type RenderFlowGraphOptions,
  type RenderFlowNode,
  type RenderNodeId,
  type RenderNodeStatus
} from './render-flow-graph-model'

function statusPillLabel(status: RenderNodeStatus): { text: string; cls: string } {
  if (status === 'done') return { text: '已完成', cls: 'text-[#1E7A3C]' }
  if (status === 'running') return { text: '处理中', cls: 'text-[#0066CC]' }
  if (status === 'failed') return { text: '异常', cls: 'text-[#B3261E]' }
  return { text: '待执行', cls: 'text-apple-subtext' }
}

export function RenderFlowGraph({
  job,
  pipelineNodes,
  activeStageKey,
  onSelectStage,
  scriptStatus,
  scriptSummary,
  embedded = false,
  className = '',
  title = '视频渲染节点流程图 · 入库 → 切片 → Agent 处理 → 合成',
  subtitle = '响应式节点画布：点击任意节点或阶段分组激活高亮，处理中连线显示流动光点'
}: {
  job: FlowJob | null
  pipelineNodes?: PipelineNodeSpec[]
  activeStageKey?: string | null
  onSelectStage?: (stageKey: string, nodeId: RenderNodeId) => void
  scriptStatus?: RenderNodeStatus
  scriptSummary?: string
  embedded?: boolean
  className?: string
  title?: string
  subtitle?: string
}) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const arrowIdleId = `rf-arrow-idle-${uid}`
  const arrowDoneId = `rf-arrow-done-${uid}`
  const arrowActiveId = `rf-arrow-active-${uid}`
  const glowFilterId = `rf-dot-glow-${uid}`
  const particleGradId = `rf-dot-grad-${uid}`

  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const sync = () => setPrefersReducedMotion(mq.matches)
    sync()
    mq.addEventListener?.('change', sync)
    return () => mq.removeEventListener?.('change', sync)
  }, [])

  const nodes = useMemo(
    () => buildRenderFlowGraphData(job, pipelineNodes, { scriptStatus, scriptSummary }),
    [job, pipelineNodes, scriptStatus, scriptSummary]
  )
  const nodeMap = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])

  const [selectedNodeId, setSelectedNodeId] = useState<RenderNodeId>(() =>
    nodeIdForStageKey(activeStageKey, null)
  )
  const [macroFocus, setMacroFocus] = useState<MacroStageId | null>(null)

  useEffect(() => {
    if (!activeStageKey) return
    setSelectedNodeId((prev) => nodeIdForStageKey(activeStageKey, prev))
  }, [activeStageKey])

  const activeNodeSet = useMemo(() => {
    const set = new Set<RenderNodeId>()
    if (macroFocus) {
      for (const n of nodes) {
        if (n.macroStage === macroFocus) set.add(n.id)
      }
      return set
    }
    set.add(selectedNodeId)
    return set
  }, [macroFocus, nodes, selectedNodeId])

  const edgeEntries = useMemo(() => {
    const items = RENDER_FLOW_EDGES.map((edge, idx) => {
      const geom = buildEdgeGeometry(edge, nodeMap)
      if (!geom) return null
      const state = describeEdgeState(edge, nodeMap, activeNodeSet)
      return { geom, state, idx }
    }).filter((x): x is { geom: EdgeGeometry; state: ReturnType<typeof describeEdgeState>; idx: number } => x !== null)

    // Render dim edges first, highlighted/processing edges on top
    return [...items].sort((a, b) => Number(a.state.isHighlighted) - Number(b.state.isHighlighted))
  }, [nodeMap, activeNodeSet])

  const handleSelectNode = (node: RenderFlowNode) => {
    setMacroFocus(null)
    setSelectedNodeId(node.id)
    onSelectStage?.(node.stageKey, node.id)
  }

  const handleSelectMacro = (macro: (typeof MACRO_STAGES)[number]) => {
    if (macroFocus === macro.id) {
      setMacroFocus(null)
      return
    }
    setMacroFocus(macro.id)
    const targetNode = nodeMap.get(macro.primaryNode)
    if (targetNode) {
      setSelectedNodeId(targetNode.id)
      onSelectStage?.(targetNode.stageKey, targetNode.id)
    }
  }

  const focusedNode = nodeMap.get(selectedNodeId) ?? nodes[0]
  const doneCount = nodes.filter((n) => n.status === 'done').length
  const runningNodes = nodes.filter((n) => n.status === 'running')

  const Wrapper = embedded ? 'div' : 'section'

  return (
    <Wrapper
      aria-label={embedded ? undefined : '视频渲染节点式流程图'}
      data-testid="render-flow-graph"
      className={`${embedded ? '' : 'card p-5'} ${className}`.trim()}
    >
      {/* Header + 4-Macro-Stage Activation Controls */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[16px] font-semibold tracking-[-0.015em] text-apple-text">
              {title}
            </h2>
            {runningNodes.length > 0 && (
              <span className="inline-flex items-center gap-1.5 text-[11.5px] font-medium text-[#0066CC]">
                <span className="live-beacon h-2 w-2 rounded-full bg-apple-blue text-apple-blue" />
                处理中：{runningNodes.map((n) => n.title).join('、')}
              </span>
            )}
          </div>
          <p className="mt-0.5 text-[12px] text-apple-subtext">{subtitle}</p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="渲染阶段快捷高亮">
          {MACRO_STAGES.map((m) => {
            const isMacroFocused = macroFocus === m.id
            const isMacroActive = isMacroFocused || (!macroFocus && focusedNode?.macroStage === m.id)
            return (
              <button
                key={m.id}
                type="button"
                aria-pressed={isMacroFocused}
                data-testid={`macro-stage-${m.id}`}
                onClick={() => handleSelectMacro(m)}
                className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[9px] border px-2.5 text-[11.5px] font-medium transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/40 whitespace-nowrap ${
                  isMacroFocused
                    ? 'border-apple-blue bg-apple-blue text-white shadow-[0_4px_12px_-3px_rgba(0,113,227,0.45)]'
                    : isMacroActive
                      ? 'border-apple-blue/45 bg-[#EFF6FF] text-apple-blueInk'
                      : 'border-black/[0.08] bg-white text-apple-subtext hover:border-black/[0.16] hover:text-apple-text'
                }`}
              >
                <span className="num text-[10px] opacity-80">{m.index}</span>
                <span>{m.label}</span>
              </button>
            )
          })}
          <span className="ml-1 num shrink-0 text-[11px] text-apple-subtext">
            {doneCount}/{nodes.length} 就绪
          </span>
        </div>
      </div>

      {/* Responsive Proportional SVG + HTML Node Canvas (Zero Scrollbar on Desktop, Clean Scroll on <760px) */}
      <div className="mt-3.5 overflow-x-auto pb-1">
        <div
          className="relative w-full min-w-[760px] rounded-[14px] border border-black/[0.06] bg-[#FAFAFC]"
          style={{ aspectRatio: `${GRAPH_W} / ${GRAPH_H}` }}
        >
          {/* Layer 1: Responsive SVG Swimlanes, Active Halos, Bezier Connectors, Particles, and Top-Layer Labels */}
          <svg
            viewBox={`0 0 ${GRAPH_W} ${GRAPH_H}`}
            preserveAspectRatio="xMidYMid meet"
            className="pointer-events-none absolute inset-0 h-full w-full select-none"
            aria-hidden="true"
          >
            <defs>
              <marker
                id={arrowIdleId}
                viewBox="0 0 10 10"
                refX="8.5"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 1.5 L 9 5 L 0 8.5 z" fill="#C2C6CE" />
              </marker>
              <marker
                id={arrowDoneId}
                viewBox="0 0 10 10"
                refX="8.5"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 1.5 L 9 5 L 0 8.5 z" fill="#6AA87F" />
              </marker>
              <marker
                id={arrowActiveId}
                viewBox="0 0 10 10"
                refX="8.5"
                refY="5"
                markerWidth="6.5"
                markerHeight="6.5"
                orient="auto-start-reverse"
              >
                <path d="M 0 1.5 L 9 5 L 0 8.5 z" fill="#0071E3" />
              </marker>
              <filter id={glowFilterId} x="-80%" y="-80%" width="260%" height="260%">
                <feGaussianBlur in="SourceGraphic" stdDeviation="2.2" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
              <radialGradient id={particleGradId} cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="#FFFFFF" stopOpacity="1" />
                <stop offset="40%" stopColor="#38BDF8" stopOpacity="0.92" />
                <stop offset="100%" stopColor="#0071E3" stopOpacity="0" />
              </radialGradient>
            </defs>

            {/* 4 Macro-Stage Swimlanes */}
            {MACRO_STAGES.map((m) => {
              const bandHighlighted =
                macroFocus === m.id || (!macroFocus && focusedNode?.macroStage === m.id)
              return (
                <g key={m.id}>
                  <rect
                    x={m.bandX}
                    y={10}
                    width={m.bandW}
                    height={GRAPH_H - 20}
                    rx={12}
                    fill={bandHighlighted ? 'rgba(0, 113, 227, 0.035)' : 'rgba(255, 255, 255, 0.6)'}
                    stroke={bandHighlighted ? 'rgba(0, 113, 227, 0.3)' : 'rgba(0, 0, 0, 0.06)'}
                    strokeWidth={bandHighlighted ? 1.5 : 1}
                    strokeDasharray={bandHighlighted ? undefined : '4 4'}
                  />
                  <text
                    x={m.bandX + 12}
                    y={29}
                    fontSize={10.5}
                    fontWeight={600}
                    fill={bandHighlighted ? '#0062C4' : '#6E6E73'}
                  >
                    {m.index} · {m.label}
                  </text>
                  <text
                    x={m.bandX + m.bandW - 12}
                    y={29}
                    textAnchor="end"
                    fontSize={9.5}
                    fill="#9CA3AF"
                  >
                    {m.sublabel}
                  </text>
                </g>
              )
            })}

            {/* SVG Glow Halos behind Activated / Running Nodes */}
            {nodes.map((node) => {
              const isSelected = activeNodeSet.has(node.id)
              const isRunning = node.status === 'running'
              if (!isSelected && !isRunning) return null
              return (
                <rect
                  key={`halo-${node.id}`}
                  x={node.x - 4}
                  y={node.y - 4}
                  width={NODE_W + 8}
                  height={NODE_H + 8}
                  rx={15}
                  fill={isSelected ? 'rgba(0, 113, 227, 0.09)' : 'rgba(0, 113, 227, 0.045)'}
                  stroke={isSelected ? 'rgba(0, 113, 227, 0.48)' : 'rgba(0, 113, 227, 0.28)'}
                  strokeWidth={isSelected ? 1.5 : 1}
                  className={!prefersReducedMotion ? 'flow-active-halo' : undefined}
                />
              )
            })}

            {/* Pass 1: Edge Curves & Flowing Light Particles */}
            {edgeEntries.map(({ geom: { edge, d }, state: { touchesActive, isProcessing, bothDone, isHighlighted }, idx }) => {
              const pathId = `rf-edge-path-${uid}-${edge.id}`
              const stroke = isHighlighted
                ? '#0071E3'
                : bothDone
                  ? '#7FB692'
                  : '#CDD2DA'
              const markerEnd = isHighlighted
                ? `url(#${arrowActiveId})`
                : bothDone
                  ? `url(#${arrowDoneId})`
                  : `url(#${arrowIdleId})`
              const opacity = touchesActive ? 1 : isProcessing ? 0.96 : 0.28

              return (
                <g
                  key={edge.id}
                  data-testid={`flow-edge-${edge.id}`}
                  data-processing={isProcessing ? 'true' : 'false'}
                  style={{ opacity, transition: 'opacity 180ms ease' }}
                >
                  <path
                    id={pathId}
                    d={d}
                    pathLength={100}
                    fill="none"
                    stroke={stroke}
                    strokeWidth={isHighlighted ? 2.3 : 1.5}
                    strokeLinecap="round"
                    markerEnd={markerEnd}
                    className="flow-edge-draw"
                    style={{ animationDelay: `${idx * 40}ms` }}
                  />

                  {isHighlighted && (
                    <path
                      d={d}
                      fill="none"
                      stroke={isProcessing ? '#38BDF8' : '#7CC4FF'}
                      strokeWidth={isProcessing ? 2.0 : 1.6}
                      strokeLinecap="round"
                      className="flow-edge-active"
                      opacity={isProcessing ? 0.88 : 0.7}
                    />
                  )}

                  {isProcessing && !prefersReducedMotion && (
                    <g data-testid={`flow-edge-particles-${edge.id}`}>
                      {[0, -0.9].map((offsetS, pIdx) => (
                        <g key={pIdx}>
                          <circle r={6} fill={`url(#${particleGradId})`} />
                          <circle r={2.8} fill="#38BDF8" filter={`url(#${glowFilterId})`} />
                          <circle r={1.4} fill="#FFFFFF" />
                          <animateMotion
                            dur="1.8s"
                            begin={`${offsetS}s`}
                            repeatCount="indefinite"
                            calcMode="spline"
                            keyPoints="0;1"
                            keyTimes="0;1"
                            keySplines="0.35 0 0.65 1"
                          >
                            <mpath href={`#${pathId}`} />
                          </animateMotion>
                        </g>
                      ))}
                    </g>
                  )}
                </g>
              )
            })}

            {/* Pass 2: Edge Labels Rendered Above All Curves & Particles (Zero Occlusion) */}
            {edgeEntries.map(({ geom: { edge, labelX, labelY, labelW, labelH }, state: { touchesActive, isProcessing, isHighlighted } }) => {
              const opacity = touchesActive ? 1 : isProcessing ? 0.96 : 0.42
              return (
                <g
                  key={`label-${edge.id}`}
                  transform={`translate(${labelX}, ${labelY})`}
                  style={{ opacity, transition: 'opacity 180ms ease' }}
                >
                  <rect
                    x={-labelW / 2}
                    y={-labelH / 2}
                    width={labelW}
                    height={labelH}
                    rx={5}
                    fill={isProcessing ? '#E6F2FF' : isHighlighted ? '#EAF3FF' : '#FFFFFF'}
                    stroke={isHighlighted ? 'rgba(0, 113, 227, 0.4)' : 'rgba(0, 0, 0, 0.09)'}
                    strokeWidth={0.9}
                  />
                  <text
                    x={0}
                    y={3.2}
                    textAnchor="middle"
                    fontSize={8.8}
                    fontWeight={isHighlighted ? 600 : 500}
                    fill={isHighlighted ? '#005BB5' : '#6E6E73'}
                  >
                    {edge.label}
                  </text>
                </g>
              )
            })}
          </svg>

          {/* Layer 2: Responsive Percentage-Positioned HTML Node Cards */}
          {nodes.map((node) => {
            const isSelected = activeNodeSet.has(node.id)
            const isRunning = node.status === 'running'
            const isActive = isSelected || isRunning
            const st = statusPillLabel(node.status)
            const roleMeta = AGENT_ROLES.find((r) => r.id === node.role)

            return (
              <button
                key={node.id}
                type="button"
                aria-pressed={isSelected}
                data-testid={`render-flow-node-${node.id}`}
                data-node-active={isActive ? 'true' : 'false'}
                onClick={() => handleSelectNode(node)}
                style={{
                  left: `${(node.x / GRAPH_W) * 100}%`,
                  top: `${(node.y / GRAPH_H) * 100}%`,
                  width: `${(NODE_W / GRAPH_W) * 100}%`,
                  height: `${(NODE_H / GRAPH_H) * 100}%`
                }}
                className={`group absolute flex flex-col justify-between overflow-hidden rounded-[12px] border px-2.5 py-2 text-left transition-all duration-200 ease-apple focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/60 ${
                  isSelected
                    ? 'z-20 -translate-y-0.5 border-apple-blue bg-[#F4F8FF] ring-2 ring-apple-blue/20 shadow-[0_10px_22px_-10px_rgba(0,113,227,0.42)]'
                    : isRunning
                      ? 'z-10 border-apple-blue/75 bg-white shadow-[0_6px_16px_-6px_rgba(0,113,227,0.25)] hover:-translate-y-0.5 hover:border-apple-blue'
                      : node.status === 'failed'
                        ? 'z-10 border-[#E58A82] bg-white hover:-translate-y-0.5 hover:border-[#B3261E]'
                        : 'z-10 border-black/[0.09] bg-white shadow-[0_2px_6px_rgba(0,0,0,0.03)] hover:-translate-y-0.5 hover:border-black/[0.22]'
                }`}
              >
                {/* Top Status / Active Accent Bar */}
                <span
                  aria-hidden="true"
                  className={`absolute inset-x-0 top-0 h-[3px] ${
                    isSelected || isRunning
                      ? 'bg-apple-blue progress-shimmer'
                      : node.status === 'done'
                        ? 'bg-[#2AA151]'
                        : node.status === 'failed'
                          ? 'bg-[#B3261E]'
                          : 'bg-black/10'
                  }`}
                />

                <div className="min-w-0">
                  <div className="flex items-center justify-between gap-1">
                    <span
                      className={`num truncate text-[10px] font-semibold ${
                        isSelected ? 'text-apple-blueInk' : 'text-apple-subtext'
                      }`}
                    >
                      {node.code}
                    </span>
                    <span className={`inline-flex shrink-0 items-center gap-1 text-[10px] font-medium ${st.cls}`}>
                      {node.status === 'running' && (
                        <span className="live-beacon h-1.5 w-1.5 rounded-full bg-apple-blue text-apple-blue" />
                      )}
                      {node.status === 'done' && <Check className="h-2.5 w-2.5" />}
                      {st.text}
                    </span>
                  </div>

                  <div className="mt-0.5 truncate text-[11.5px] font-semibold leading-tight text-apple-text xl:text-[12px]">
                    {node.title}
                  </div>
                  <div
                    className="mt-0.5 truncate text-[10px] text-apple-subtext"
                    title={node.subtitle}
                  >
                    {node.subtitle}
                  </div>
                </div>

                <div className="flex items-center justify-between gap-1 border-t border-black/[0.05] pt-1 text-[10px]">
                  <span className={`truncate font-medium ${roleMeta?.accentText ?? 'text-apple-text'}`}>
                    {node.roleLabel}
                  </span>
                  <span className="num shrink-0 text-apple-subtext">
                    {node.durationS != null ? `${node.durationS.toFixed(1)}s` : '—'}
                  </span>
                </div>
              </button>
            )
          })}
        </div>
      </div>

      {/* Focused Node Highlight Legend & Quick Context Strip */}
      {focusedNode && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-black/[0.06] pt-2.5 text-[11.5px]">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 font-semibold text-apple-blueInk">
              <span className="live-beacon h-2 w-2 rounded-full bg-apple-blue text-apple-blue" />
              当前激活节点：{focusedNode.title}
            </span>
            <span className="text-black/20" aria-hidden="true">|</span>
            <span className="font-mono text-[11px] text-apple-text">{focusedNode.toolChain}</span>
            <span className="text-black/20" aria-hidden="true">·</span>
            <span className="text-apple-subtext">{focusedNode.metricNote}</span>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-[11px] text-apple-subtext">
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block h-2 w-2 rounded-full bg-[#38BDF8] ring-2 ring-[#0071E3]/25" />
              处理中光点
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="inline-block h-2 w-3.5 rounded-sm bg-apple-blue" />
              激活通路
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="inline-block h-2 w-3.5 rounded-sm bg-[#7FB692]" />
              已完成通路
            </span>
          </div>
        </div>
      )}
    </Wrapper>
  )
}
