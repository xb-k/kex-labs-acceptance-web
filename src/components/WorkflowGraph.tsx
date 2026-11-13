import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ContractWorkflow, WorkflowLink, WorkflowNode } from '../types'

/** 固定几何：保证同一份 workflow 每次布局一致（无测量、无随机）。 */
const NODE_W = 200
const NODE_H = 136
const GAP_X = 64
const GAP_Y = 36
const PAD = 24

const NODE_TEXT = '#F5F5F7'
const NODE_SUBTEXT = '#A1A1A6'
const NODE_VALUE = '#D1D1D6'

type Category = 'loader' | 'conditioning' | 'sampler' | 'output' | 'other'

const CATEGORY_COLOR: Record<Category, string> = {
  loader: '#0A84FF',
  conditioning: '#30D158',
  sampler: '#FF9F0A',
  output: '#40C8E0',
  other: '#8E8E93'
}

const CATEGORY_LABEL: Record<Category, string> = {
  loader: 'loader',
  conditioning: 'conditioning',
  sampler: 'sampler',
  output: 'output',
  other: '其他'
}

function categoryOf(classType: string): Category {
  if (/Loader|LoadImage/i.test(classType)) return 'loader'
  if (/CLIPTextEncode|Conditioning|ImgToVideo/i.test(classType)) return 'conditioning'
  if (/Sampler/i.test(classType)) return 'sampler'
  if (/SaveVideo|CreateVideo|Preview/i.test(classType)) return 'output'
  return 'other'
}

/** id 数字序比较（"2" 在 "10" 前），保证同列行序稳定。 */
function compareId(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true })
}

function scalarText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null) return 'null'
  try {
    const json = JSON.stringify(value)
    return json === undefined ? '—' : json
  } catch {
    return '—'
  }
}

type Position = { x: number; y: number; col: number; row: number }

type Layout = {
  positions: Map<string, Position>
  width: number
  height: number
  edgePaths: Array<{ key: string; link: WorkflowLink; d: string }>
}

/**
 * 最长路径分层：depth(v) = max(depth(u) + 1)，u→v。
 * Kahn 拓扑排序，环上残留节点落在第 0 列，仍按 id 排行，不丢节点。
 */
function buildLayout(nodes: WorkflowNode[], links: WorkflowLink[]): Layout {
  const ids = nodes.map((node) => node.id)
  const known = new Set(ids)
  const successors = new Map<string, string[]>(ids.map((id) => [id, []]))
  const indegree = new Map<string, number>(ids.map((id) => [id, 0]))

  for (const link of links) {
    if (!known.has(link.from) || !known.has(link.to) || link.from === link.to) continue
    successors.get(link.from)!.push(link.to)
    indegree.set(link.to, (indegree.get(link.to) ?? 0) + 1)
  }
  for (const list of successors.values()) list.sort(compareId)

  const depth = new Map<string, number>(ids.map((id) => [id, 0]))
  const remaining = new Map(indegree)
  const queue = ids.filter((id) => remaining.get(id) === 0).sort(compareId)

  while (queue.length > 0) {
    const current = queue.shift()!
    for (const next of successors.get(current) ?? []) {
      depth.set(next, Math.max(depth.get(next) ?? 0, (depth.get(current) ?? 0) + 1))
      const left = (remaining.get(next) ?? 0) - 1
      remaining.set(next, left)
      if (left === 0) queue.push(next)
    }
    queue.sort(compareId)
  }

  const columns = new Map<number, string[]>()
  for (const id of ids) {
    const col = depth.get(id) ?? 0
    const list = columns.get(col) ?? []
    list.push(id)
    columns.set(col, list)
  }

  const positions = new Map<string, Position>()
  let colCount = 0
  let rowCount = 0
  for (const [col, list] of columns) {
    list.sort(compareId)
    if (col + 1 > colCount) colCount = col + 1
    if (list.length > rowCount) rowCount = list.length
    list.forEach((id, row) => {
      positions.set(id, {
        x: PAD + col * (NODE_W + GAP_X),
        y: PAD + row * (NODE_H + GAP_Y),
        col,
        row
      })
    })
  }

  const width = PAD * 2 + Math.max(colCount, 1) * NODE_W + Math.max(colCount - 1, 0) * GAP_X
  const height = PAD * 2 + Math.max(rowCount, 1) * NODE_H + Math.max(rowCount - 1, 0) * GAP_Y

  const edgePaths: Layout['edgePaths'] = []
  links.forEach((link, index) => {
    const from = positions.get(link.from)
    const to = positions.get(link.to)
    if (!from || !to) return
    const x1 = from.x + NODE_W
    const y1 = from.y + NODE_H / 2
    const x2 = to.x
    const y2 = to.y + NODE_H / 2
    let d: string
    if (link.from === link.to) {
      d = `M ${x1} ${y1} C ${x1 + 44} ${y1 - 48}, ${x2 + 44} ${y2 + 48}, ${x2} ${y2}`
    } else {
      const control = Math.max(36, Math.abs(x2 - x1) * 0.5)
      d = `M ${x1} ${y1} C ${x1 + control} ${y1}, ${x2 - control} ${y2}, ${x2 - 2} ${y2}`
    }
    edgePaths.push({ key: `${link.to}-${link.to_input}-${link.from}-${link.from_slot}-${index}`, link, d })
  })

  return { positions, width, height, edgePaths }
}

export function WorkflowGraph({ workflow }: { workflow: ContractWorkflow | null | undefined }) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const canvasRef = useRef<HTMLDivElement | null>(null)
  // 画布比容器宽时才出现滚动提示 / 右缘渐隐遮罩；滚到最右时遮罩退场。
  const [canScrollX, setCanScrollX] = useState(false)
  const [atRightEdge, setAtRightEdge] = useState(true)
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const arrowId = `wf-arrow-${uid}`
  const arrowActiveId = `wf-arrow-active-${uid}`

  const nodes = workflow?.available ? workflow.nodes : []
  const links = workflow?.available ? workflow.links : []
  const layout = useMemo(() => buildLayout(nodes, links), [nodes, links])
  const selected = nodes.find((node) => node.id === selectedId) ?? null

  const linkByInput = useMemo(() => {
    const map = new Map<string, WorkflowLink>()
    for (const link of links) map.set(`${link.to}\u0000${link.to_input}`, link)
    return map
  }, [links])

  const nodeCount = nodes.length

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) {
      setCanScrollX(false)
      setAtRightEdge(true)
      return
    }
    const measure = () => {
      const scrollable = canvas.scrollWidth > canvas.clientWidth + 1
      setCanScrollX(scrollable)
      setAtRightEdge(!scrollable || canvas.scrollLeft + canvas.clientWidth >= canvas.scrollWidth - 1)
    }
    const onScroll = () => {
      setAtRightEdge(canvas.scrollLeft + canvas.clientWidth >= canvas.scrollWidth - 1)
    }
    measure()
    canvas.addEventListener('scroll', onScroll, { passive: true })
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(canvas)
    window.addEventListener('resize', measure)
    return () => {
      canvas.removeEventListener('scroll', onScroll)
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [nodeCount])

  if (!workflow || !workflow.available || nodes.length === 0) {
    return (
      <div
        className="flex min-h-[220px] flex-col items-center justify-center gap-1.5 rounded-[14px] border border-white/[0.08] px-6 py-8 text-center"
        style={{ background: 'linear-gradient(160deg, #121214 0%, #0A0A0C 100%)' }}
        data-testid="workflow-graph-empty"
      >
        <p className="text-[12px] font-medium" style={{ color: 'rgba(245,245,247,0.88)' }}>
          无节点数据（workflows/ltxv_i2v_v1.json 缺失或不可解析）
        </p>
        {workflow?.reason && (
          <p className="max-w-[64ch] text-[10px] leading-4" style={{ color: NODE_SUBTEXT }}>
            {workflow.reason}
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="min-w-0">
      {canScrollX && (
        <div className="mb-1.5 flex items-center justify-end">
          <p
            data-testid="workflow-scroll-hint"
            className="flex items-center gap-1 text-[10px] leading-4 text-apple-subtext"
          >
            横向滚动查看全部
            <span className="num font-medium text-apple-text">{nodeCount}</span>
            个节点
            <span aria-hidden="true" className="ml-0.5">→</span>
          </p>
        </div>
      )}
      <div className="relative -mx-1">
        <div
          ref={canvasRef}
          role="region"
          aria-label="ComfyUI 工作流节点图（只读，可横向滚动）"
          tabIndex={0}
          className="overflow-x-auto rounded-[14px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0A84FF]"
          data-testid="workflow-graph-canvas"
        >
        <div
          className="relative shrink-0"
          style={{
            width: layout.width,
            height: layout.height,
            background: 'radial-gradient(120% 100% at 0% 0%, #141416 0%, #0A0A0C 62%)'
          }}
        >
          <svg
            className="pointer-events-none absolute inset-0"
            width={layout.width}
            height={layout.height}
            aria-hidden="true"
            focusable="false"
          >
            <defs>
              <marker id={arrowId} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto" markerUnits="userSpaceOnUse">
                <path d="M0 0 L7 3.5 L0 7 Z" fill="rgba(255,255,255,0.34)" />
              </marker>
              <marker id={arrowActiveId} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto" markerUnits="userSpaceOnUse">
                <path d="M0 0 L7 3.5 L0 7 Z" fill="#0A84FF" />
              </marker>
            </defs>
            {layout.edgePaths.map(({ key, link, d }) => {
              const related = selected ? link.from === selected.id || link.to === selected.id : true
              const active = Boolean(selected) && related
              return (
                <path
                  key={key}
                  data-testid="workflow-edge"
                  data-from={link.from}
                  data-to={link.to}
                  d={d}
                  fill="none"
                  stroke={active ? '#0A84FF' : 'rgba(255,255,255,0.28)'}
                  strokeWidth={active ? 1.8 : 1.2}
                  opacity={selected && !related ? 0.2 : 1}
                  markerEnd={`url(#${active ? arrowActiveId : arrowId})`}
                />
              )
            })}
          </svg>

          {nodes.map((node) => {
            const position = layout.positions.get(node.id)
            if (!position) return null
            const category = categoryOf(node.class_type)
            const isSelected = selected?.id === node.id
            const previewInputs = Object.keys(node.inputs).slice(0, 4)
            const hiddenCount = Math.max(Object.keys(node.inputs).length - previewInputs.length, 0)
            return (
              <button
                key={node.id}
                type="button"
                data-testid={`workflow-node-${node.id}`}
                aria-pressed={isSelected}
                aria-label={`节点 ${node.id}，${node.class_type}，${CATEGORY_LABEL[category]}，${previewInputs.length} 项输入预览${
                  hiddenCount > 0 ? `，另有 ${hiddenCount} 项` : ''
                }，按回车查看完整输入`}
                title={hiddenCount > 0 ? `还有 ${hiddenCount} 项输入，点击查看完整列表` : '点击查看完整输入'}
                onClick={() => setSelectedId((current) => (current === node.id ? null : node.id))}
                className="absolute z-10 overflow-hidden rounded-[10px] border text-left transition-colors duration-150 hover:border-white/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0A84FF]"
                style={{
                  left: position.x,
                  top: position.y,
                  width: NODE_W,
                  height: NODE_H,
                  background: isSelected ? '#1D1D21' : '#17171A',
                  borderColor: isSelected ? 'rgba(10,132,255,0.65)' : 'rgba(255,255,255,0.09)'
                }}
              >
                <span
                  aria-hidden="true"
                  className="absolute inset-y-0 left-0 w-[3px]"
                  style={{ background: CATEGORY_COLOR[category] }}
                />
                <span className="flex items-center justify-between gap-2 pl-3 pr-2 pt-2">
                  <span className="min-w-0 truncate font-mono text-[11px] font-semibold" style={{ color: NODE_TEXT }} title={node.class_type}>
                    {node.class_type}
                  </span>
                  <span
                    className="num shrink-0 rounded border px-1 py-px text-[9px] leading-3"
                    style={{ color: NODE_SUBTEXT, borderColor: 'rgba(255,255,255,0.14)' }}
                  >
                    #{node.id}
                  </span>
                </span>
                <span className="mt-1 flex flex-col gap-y-0.5 px-3 pb-2">
                  {previewInputs.length === 0 ? (
                    <span className="text-[10px] leading-5" style={{ color: NODE_SUBTEXT }}>
                      无输入
                    </span>
                  ) : (
                    previewInputs.map((inputKey) => {
                      const link = linkByInput.get(`${node.id}\u0000${inputKey}`)
                      if (link) {
                        return (
                          <span key={inputKey} className="flex items-baseline gap-1.5 overflow-hidden text-[10px] leading-5">
                            <span className="w-[56px] shrink-0 truncate" style={{ color: NODE_SUBTEXT }} title={inputKey}>
                              {inputKey}
                            </span>
                            <span
                              className="num min-w-0 truncate"
                              style={{ color: NODE_VALUE }}
                              title={`来自节点 ${link.from} · 槽位 ${link.from_slot}`}
                            >
                              ← #{link.from}
                            </span>
                          </span>
                        )
                      }
                      const value = scalarText(node.inputs[inputKey])
                      return (
                        <span key={inputKey} className="flex items-baseline gap-1.5 overflow-hidden text-[10px] leading-5">
                          <span className="w-[56px] shrink-0 truncate" style={{ color: NODE_SUBTEXT }} title={inputKey}>
                            {inputKey}
                          </span>
                          <span className="num min-w-0 truncate" style={{ color: NODE_VALUE }} title={value}>
                            {value}
                          </span>
                        </span>
                      )
                    })
                  )}
                </span>
              </button>
            )
          })}
        </div>
        </div>
        <div
          aria-hidden="true"
          data-testid="workflow-scroll-mask"
          className={`pointer-events-none absolute inset-y-0 right-0 w-12 rounded-r-[14px] transition-opacity duration-200 ${
            canScrollX && !atRightEdge ? 'opacity-100' : 'opacity-0'
          }`}
          style={{
            background: 'linear-gradient(to right, rgba(10,10,12,0) 0%, rgba(10,10,12,0.72) 55%, #0A0A0C 100%)'
          }}
        />
      </div>

      <div
        data-testid="workflow-node-detail"
        aria-live="polite"
        className="mt-2.5 rounded-xl border border-black/[0.04] bg-[#FAFAFC] px-3 py-2.5"
      >
        {selected ? (
          <>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <p className="min-w-0 text-[11px] font-medium leading-4">
                <span className="num mr-1 text-apple-subtext">#{selected.id}</span>
                <span className="font-mono">{selected.class_type}</span>
              </p>
              <span className="num shrink-0 text-[10px] text-apple-subtext">
                {Object.keys(selected.inputs).length} 项输入 · 入边 {links.filter((link) => link.to === selected.id).length} 条
              </span>
            </div>
            {Object.keys(selected.inputs).length === 0 ? (
              <p className="mt-1.5 text-[10px] leading-4 text-apple-subtext">该节点没有输入。</p>
            ) : (
              <dl className="mt-1.5 max-h-56 space-y-1 overflow-auto pr-1 text-[10px] leading-4">
                {Object.entries(selected.inputs).map(([inputKey, value]) => {
                  const link = linkByInput.get(`${selected.id}\u0000${inputKey}`)
                  return (
                    <div key={inputKey} className="grid grid-cols-[92px_1fr] items-baseline gap-x-2">
                      <dt className="min-w-0 truncate text-apple-subtext" title={inputKey}>
                        {inputKey}
                      </dt>
                      <dd className="num min-w-0 break-all" title={link ? `来自节点 ${link.from} · 槽位 ${link.from_slot}` : scalarText(value)}>
                        {link ? `← #${link.from} · 槽位 ${link.from_slot}` : scalarText(value)}
                      </dd>
                    </div>
                  )
                })}
              </dl>
            )}
          </>
        ) : (
          <p className="text-[10px] leading-4 text-apple-subtext">
            点击任一节点查看完整输入；选中后蓝色高亮它的相连连线。只读视图，不能编辑节点或触发渲染。
          </p>
        )}
      </div>
    </div>
  )
}
