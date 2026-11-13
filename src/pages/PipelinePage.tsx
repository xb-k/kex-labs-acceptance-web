import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useJson, useLiveJson, useSystem } from '../api'
import { DataTable } from '../components/DataTable'
import type { Column } from '../components/DataTable'
import { Alert, Film, Refresh, Shield, TriangleAlert } from '../components/icons'
import { WorkflowGraph } from '../components/WorkflowGraph'
import type { ContractGateItem, ContractResponse, ContractThresholdItem, FlowResponse } from '../types'
import { needsIntranet } from '../url'
import { StatusPill, formatTime, text } from './FlowPage'

const QUEUE_KEYS: Array<{ key: keyof ContractQueueCounts; label: string }> = [
  { key: 'inbox', label: '收件箱' },
  { key: 'pending', label: '待处理' },
  { key: 'done', label: '完成' },
  { key: 'failed', label: '失败' },
  { key: 'rejected', label: '拒绝' },
  { key: 'running', label: '运行中' }
]

type ContractQueueCounts = {
  inbox: number
  pending: number
  done: number
  failed: number
  rejected: number
  running: number
}

const WORKFLOW_ROWS: Array<{ key: string; label: string }> = [
  { key: 'width', label: '宽' },
  { key: 'height', label: '高' },
  { key: 'length', label: '帧数' },
  { key: 'fps', label: '帧率' },
  { key: 'cfg', label: 'CFG' },
  { key: 'steps', label: '步数' },
  { key: 'denoise', label: '去噪' },
  { key: 'seed', label: '种子' },
  { key: 'sampler', label: '采样器' },
  { key: 'scheduler', label: '调度器' },
  { key: 'ckpt', label: '模型' }
]

const MEMORY_ROWS: Array<{ key: string; label: string }> = [
  { key: 'available_before_gb', label: '渲染前可用' },
  { key: 'available_after_gb', label: '渲染后可用' },
  { key: 'margin_gb', label: '余量' },
  { key: 'model_memory_gb', label: '模型占用' },
  { key: 'guard', label: '护栏' }
]

function Card({
  title,
  hint,
  children,
  testId,
  fill = true
}: {
  title: string
  hint?: ReactNode
  children: ReactNode
  testId?: string
  fill?: boolean
}) {
  return (
    <section className={`card flex min-w-0 flex-col p-4 ${fill ? 'h-full' : ''}`} data-testid={testId}>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-[13px] font-semibold leading-5">{title}</h2>
        {hint && <span className="text-[10px] leading-4 text-apple-subtext">{hint}</span>}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </section>
  )
}

/**
 * 内网 / 未连接的 ComfyUI：不给可点外链，只显示地址 + 提示 + 复制。
 * 复制失败（浏览器拒绝 clipboard）时降级为选中文本，用户可 ⌘C / Ctrl+C。
 */
function ComfyEndpoint({ url, online }: { url: string; online: boolean }) {
  const [notice, setNotice] = useState<'idle' | 'copied' | 'manual'>('idle')
  const addressRef = useRef<HTMLSpanElement | null>(null)

  useEffect(() => {
    if (notice === 'idle') return
    const timer = window.setTimeout(() => setNotice('idle'), 2400)
    return () => window.clearTimeout(timer)
  }, [notice])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setNotice('copied')
    } catch {
      const node = addressRef.current
      if (node) {
        const range = document.createRange()
        range.selectNodeContents(node)
        const selection = window.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
      }
      setNotice('manual')
    }
  }

  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-1" data-testid="open-comfyui">
      <span
        ref={addressRef}
        className="num max-w-full select-all break-all rounded bg-apple-bg px-1 py-0.5 text-apple-text"
      >
        {url}
      </span>
      <span className="shrink-0 text-apple-subtext">{online ? '需内网/Tailscale' : '未连接'}</span>
      <button
        type="button"
        onClick={copy}
        className="shrink-0 rounded-md border border-apple-line bg-white px-1.5 py-0.5 font-medium text-apple-blueInk transition-colors duration-200 hover:border-black/[0.12] focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/40"
      >
        {notice === 'copied' ? '已复制' : notice === 'manual' ? '已选中' : '复制地址'}
      </button>
    </span>
  )
}

export function PipelinePage() {
  const flow = useLiveJson<FlowResponse>('/api/flow', 5000)
  const contract = useJson<ContractResponse>('/api/contract')
  const system = useSystem()

  const job = flow.data?.job ?? null
  const data = contract.data
  const available = data ? data.available : null

  const queueCounts = useMemo<ContractQueueCounts>(() => {
    const queue = data?.queue
    return {
      inbox: queue?.inbox?.length ?? 0,
      pending: queue?.pending?.length ?? 0,
      done: queue?.done?.length ?? 0,
      failed: queue?.failed?.length ?? 0,
      rejected: queue?.rejected?.length ?? 0,
      running: queue?.running?.length ?? 0
    }
  }, [data?.queue])

  const [pinned, setPinned] = useState<string | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)

  // poster 只在「服务端已确认文件存在（frames[].exists）且路径在 KEX_REPO_ROOT/jobs/ 内」时渲染，
  // 避免对 /media/kex 发猜测性请求（404 会污染 console）。
  const root = flow.data?.meta?.root ?? null
  const posterUrl = useMemo(() => {
    if (!job || !root) return null
    const frame = job.frames.find((item) => item.exists && item.path)
    if (!frame?.path) return null
    const base = root.endsWith('/') ? root.slice(0, -1) : root
    if (!frame.path.startsWith(`${base}/`)) return null
    const rel = frame.path.slice(base.length + 1)
    if (!rel.startsWith('jobs/')) return null
    return `/media/kex?path=${encodeURIComponent(rel)}`
  }, [job, root])
  const [posterBroken, setPosterBroken] = useState(false)
  useEffect(() => setPosterBroken(false), [posterUrl])

  const gateItems = data?.gate?.items ?? []
  const thresholdItems = data?.thresholds?.items ?? []
  const workflow = data?.workflow
  const workflowStats = workflow?.stats ?? null
  const otherCatalog = (workflow?.catalog ?? []).filter((item) => !item.primary)
  const configuredComfyUrl = system.data?.configuredUrl ?? null
  // Only plain http(s) URLs are safe to render as an external link.
  const comfyUrl =
    typeof configuredComfyUrl === 'string' && /^https?:\/\//i.test(configuredComfyUrl)
      ? configuredComfyUrl
      : null
  // 内网地址或服务未连接时不做可点外链（公网用户点开只会超时）。
  const comfyOnline = system.data?.online !== false
  const comfyOpenable = comfyUrl !== null && comfyOnline && !needsIntranet(comfyUrl)
  const recent = data?.recent ?? null
  const memory = (recent?.render_report?.memory ?? null) as Record<string, unknown> | null

  const thresholdColumns: Column<ContractThresholdItem>[] = [
    {
      key: 'key',
      label: '键',
      cell: (row) => (
        <span className="block max-w-[150px] truncate font-mono text-[10px]" title={row.key}>
          {row.key}
        </span>
      )
    },
    { key: 'op', label: '比较', className: 'num', cell: (row) => row.op ?? '—' },
    { key: 'value', label: '阈值', className: 'num whitespace-nowrap', cell: (row) => (row.value === null ? '—' : row.value) },
    { key: 'unit', label: '单位', className: 'break-words', cell: (row) => row.unit ?? '—' }
  ]

  const gateOpen = (item: ContractGateItem) => pinned === item.key || hovered === item.key

  return (
    <div className="page-enter">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em] sm:text-[32px]">渲染工作台与契约</h1>
          <p className="mt-1.5 max-w-[64ch] text-sm leading-relaxed text-apple-subtext">
            左边是最新任务的实时画面；右边集中展示交付门禁、质量阈值、工作流参数、队列与最近报告，只读不改。尚未接入的能力不显示按钮。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              void flow.refresh()
              contract.retry()
            }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-apple-line bg-white px-2.5 py-1.5 text-[11px] font-medium text-apple-text shadow-soft transition-colors duration-200 hover:border-black/[0.12] focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/40"
          >
            <Refresh className={`h-3.5 w-3.5 ${flow.refreshing ? 'animate-spin' : ''}`} />
            刷新
          </button>
          <span className="num text-[10px] text-apple-subtext">
            {job ? `state 更新 ${formatTime(job.updated_at)}` : '—'}
            {flow.updatedAt ? ` · 读取 ${new Date(flow.updatedAt).toLocaleTimeString('zh-CN', { hour12: false })}` : ''}
          </span>
        </div>
      </div>

      {flow.error && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#F3D3CF] bg-[#FCEDEB] px-3 py-2 text-[11px] text-[#B3261E]" role="status">
          <span>/api/flow 读取失败：{flow.error}</span>
          <button type="button" onClick={() => void flow.retry()} className="font-medium underline">
            重试
          </button>
        </div>
      )}

      <div className="mt-4 grid gap-4 xl:grid-cols-[360px_minmax(0,1fr)] xl:items-start">
        <Card title="实时监看" hint="最新 job · /api/flow" testId="pipeline-live" fill={false}>
          {flow.status === 'loading' ? (
            <div className="space-y-2" aria-busy="true" aria-label="正在读取最新 job">
              <div className="h-4 w-2/3 animate-pulse rounded bg-[#ECECEF]" />
              <div className="h-3 w-1/2 animate-pulse rounded bg-[#F2F2F4]" />
              <div className="mt-3 aspect-[16/9] w-full animate-pulse rounded-lg bg-[#F2F2F4]" />
            </div>
          ) : !job ? (
            <div className="rounded-lg border border-dashed border-apple-line bg-white/60 px-3 py-4">
              <p className="text-xs font-medium">当前没有运行任务</p>
              <p className="mt-1 text-[11px] leading-relaxed text-apple-subtext">
                {flow.data?.message ?? flow.data?.reason ?? 'state/ 下没有 job'}。此页不构造运行画面。
              </p>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap gap-1.5" data-testid="pipeline-stages">
                {job.stages.map((stage) => (
                  <span
                    key={stage.key}
                    className="inline-flex items-center gap-1 rounded-lg border border-apple-line bg-white px-1.5 py-1 text-[10px]"
                    title={`${stage.key} · ${stage.status ?? '无数据'}`}
                  >
                    <span className="num font-semibold text-apple-subtext">{stage.key}</span>
                    <StatusPill status={stage.status} />
                  </span>
                ))}
              </div>

              <dl className="mt-3 space-y-1 text-[11px] leading-5">
                <div className="flex items-start justify-between gap-3">
                  <dt className="text-apple-subtext">job</dt>
                  <dd className="num min-w-0 break-all text-right">{job.id}</dd>
                </div>
                <div className="flex items-start justify-between gap-3">
                  <dt className="text-apple-subtext">更新时间</dt>
                  <dd className="num text-right">{formatTime(job.updated_at)}</dd>
                </div>
                <div className="flex items-start justify-between gap-3">
                  <dt className="text-apple-subtext">帧 / 镜头</dt>
                  <dd className="num text-right">
                    {job.frames.length} 帧 · {job.shots.length} 镜头
                  </dd>
                </div>
                <div className="flex items-start justify-between gap-3">
                  <dt className="text-apple-subtext">阶段总耗时</dt>
                  <dd className="num text-right">{job.duration_s === null ? '无数据' : `${job.duration_s.toFixed(1)}s`}</dd>
                </div>
              </dl>

              <div className="mt-3">
                {posterUrl && !posterBroken ? (
                  <img
                    src={posterUrl}
                    alt={`${job.id} 的关键帧`}
                    className="aspect-[16/9] w-full rounded-lg border border-apple-line object-cover"
                    onError={() => setPosterBroken(true)}
                  />
                ) : (
                  <div className="grid aspect-[16/9] w-full place-items-center rounded-lg border border-dashed border-apple-line bg-apple-bg/70">
                    <div className="flex flex-col items-center gap-1 text-apple-subtext">
                      <Film className="h-5 w-5" />
                      <span className="text-[11px]">无运行画面</span>
                    </div>
                  </div>
                )}
                <p className="mt-1.5 text-[10px] leading-4 text-apple-subtext">
                  仅当 <span className="num">/media/kex</span> 上真实存在 <span className="num">jobs/{job.id}/frames/</span> 下的关键帧才显示图片；API 未提供帧率与进度字段，所以这里不推算任何数字。
                </p>
              </div>
            </>
          )}
        </Card>

        <div>
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <h2 className="flex items-center gap-1.5 text-[18px] font-semibold leading-6 tracking-[-0.01em]">
              <Shield className="h-4 w-4 text-apple-subtext" />
              契约护甲（只读）
            </h2>
            <p className="text-[11px] text-apple-subtext">
              数据 /api/contract · 不写 inbox、不触发渲染
            </p>
          </div>

          {contract.status === 'loading' && (
            <div className="grid gap-4 md:grid-cols-2" aria-busy="true" aria-label="正在读取契约">
              {[0, 1, 2, 3].map((index) => (
                <div key={index} className="card h-[168px] animate-pulse p-4">
                  <div className="h-3 w-24 rounded bg-[#ECECEF]" />
                  <div className="mt-3 h-3 w-full rounded bg-[#F2F2F4]" />
                  <div className="mt-2 h-3 w-4/5 rounded bg-[#F2F2F4]" />
                </div>
              ))}
            </div>
          )}

          {contract.status === 'error' && (
            <div className="card flex flex-wrap items-center justify-between gap-3 p-5" role="alert">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 grid h-8 w-8 place-items-center rounded-full bg-[#FCEDEB] text-[#B3261E]">
                  <Alert className="h-4 w-4" />
                </span>
                <div>
                  <p className="text-sm font-medium">契约读取失败</p>
                  <p className="mt-1 text-xs leading-relaxed text-apple-subtext">{contract.error}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => contract.retry()}
                className="rounded-lg bg-apple-text px-3 py-1.5 text-xs font-medium text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
              >
                重试
              </button>
            </div>
          )}

          {data && available === false && (
            <div className="card flex items-start gap-3 p-5">
              <span className="mt-0.5 grid h-8 w-8 place-items-center rounded-full bg-[#F0F0F2] text-apple-subtextAlt">
                <TriangleAlert className="h-4 w-4" />
              </span>
              <div>
                <h3 className="text-sm font-semibold">仓库未配置</h3>
                <p className="mt-1 text-xs leading-relaxed text-apple-subtext">
                  {data.reason ?? 'kex repo not configured'}：设置 <span className="num">KEX_REPO_ROOT</span> 后这里会显示 gate / thresholds / workflow / queue。
                </p>
              </div>
            </div>
          )}

          {data && available !== false && (
            <div className="grid gap-4 md:grid-cols-2" data-equal-grid data-stagger>
              <div className="min-w-0 md:col-span-2">
                <Card
                  title="ComfyUI 工作流节点"
                  hint={workflowStats ? `${workflowStats.node_count} 节点 / ${workflowStats.link_count} 连接` : '—'}
                  testId="contract-nodegraph"
                >
                  <WorkflowGraph workflow={workflow} />
                  {workflow && (
                    <>
                      <div className="mt-3 flex flex-wrap items-start justify-between gap-x-4 gap-y-1.5 border-t border-apple-line/60 pt-2.5 text-[10px] leading-4 text-apple-subtext">
                        <p className="min-w-0 break-all">
                          <span className="num">{workflow.source}</span>
                          {workflow.sha256 && (
                            <span className="num ml-2" title={workflow.sha256}>
                              sha256 {workflow.sha256.slice(0, 12)}
                            </span>
                          )}
                        </p>
                        {comfyUrl && comfyOpenable && (
                          <a
                            href={comfyUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            data-testid="open-comfyui"
                            className="shrink-0 rounded-md border border-apple-line bg-white px-1.5 py-0.5 font-medium text-apple-blueInk transition-colors duration-200 hover:border-black/[0.12] focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/40"
                          >
                            在 ComfyUI 打开 ↗
                          </a>
                        )}
                        {comfyUrl && !comfyOpenable && (
                          <ComfyEndpoint url={comfyUrl} online={comfyOnline} />
                        )}
                      </div>
                      <p className="mt-1 text-[10px] leading-4 text-apple-subtext">
                        只读：节点/连线来自真实 workflow JSON（API 格式），坐标由前端自动布局，非 ComfyUI 原画布。
                      </p>
                      {otherCatalog.length > 0 && (
                        <details className="mt-2 rounded-lg border border-apple-line/60 bg-apple-bg/60 px-2.5 py-1.5">
                          <summary className="cursor-pointer text-[10px] font-medium leading-4 text-apple-subtext focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/40">
                            其他 workflow 文件（{otherCatalog.length}）
                          </summary>
                          <ul className="mt-1.5 space-y-1">
                            {otherCatalog.map((item) => (
                              <li key={item.source} className="flex items-baseline justify-between gap-3 text-[10px] leading-4">
                                <span className="num min-w-0 truncate" title={item.source}>
                                  {item.name}
                                </span>
                                <span className="num shrink-0 text-apple-subtext">
                                  {item.node_count} 节点 / {item.link_count} 连接
                                </span>
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </>
                  )}
                </Card>
              </div>

              <div className="md:col-span-2">
                <Card title="交付门禁" hint={`${gateItems.length} 条 · ${data.gate?.source ?? '—'}`} testId="contract-gate">
                  {gateItems.length === 0 ? (
                    <p className="text-xs text-apple-subtext">没有从交付门禁文档解析到条目（source 缺失或表格格式不符）。</p>
                  ) : (
                    <ul className="divide-y divide-apple-line/60">
                      {gateItems.map((item) => {
                        const open = gateOpen(item)
                        return (
                          <li
                            key={item.key}
                            className="py-1.5 first:pt-0 last:pb-0"
                            onMouseEnter={() => setHovered(item.key)}
                            onMouseLeave={() => setHovered((current) => (current === item.key ? null : current))}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <p className="text-[11px] leading-5">
                                  <span className="num mr-1 font-semibold text-apple-subtext">{item.key}</span>
                                  <span className="font-medium">{item.name}</span>
                                </p>
                                <p className="num mt-0.5 text-[10px] text-apple-blueInk">{item.threshold ?? '无数值阈值'}</p>
                              </div>
                              <button
                                type="button"
                                aria-expanded={open}
                                data-testid={`gate-toggle-${item.key}`}
                                onClick={() => setPinned((current) => (current === item.key ? null : item.key))}
                                className="shrink-0 rounded-md border border-apple-line bg-white px-1.5 py-0.5 text-[10px] text-apple-subtext transition-colors duration-200 hover:border-black/[0.12] focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/40"
                              >
                                {open ? '收起原文' : '原文'}
                              </button>
                            </div>
                            {open && (
                              <p className="mt-1 rounded-md bg-apple-bg px-2 py-1 font-mono text-[10px] leading-4 whitespace-pre-wrap break-words">
                                {item.source_line}
                              </p>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  )}
                  <p className="mt-2 text-[10px] leading-4 text-apple-subtext">
                    source 更新时间：{formatTime(data.gate?.updated_at ?? null)}
                  </p>
                </Card>
              </div>

              <Card title="质量阈值" hint={`${thresholdItems.length} 条 · ${data.thresholds?.source ?? '—'}`} testId="contract-thresholds">
                <DataTable
                  columns={thresholdColumns}
                  rows={thresholdItems}
                  rowKey={(row, index) => `${row.key}-${index}`}
                  empty="policy/quality_thresholds.json 没有 checks。"
                />
              </Card>

              <Card title="工作流参数" hint={workflow ? workflow.name : '—'} testId="contract-workflow">
                {!workflow ? (
                  <p className="text-xs text-apple-subtext">没有读到 workflows/ltxv_i2v_v1.json。</p>
                ) : (
                  <>
                    <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] leading-5">
                      {WORKFLOW_ROWS.map((row) => (
                        <div key={row.key} className="flex items-baseline justify-between gap-2 border-b border-apple-line/50 py-0.5">
                          <dt className="shrink-0 text-apple-subtext">{row.label}</dt>
                          <dd className="num min-w-0 truncate text-right" title={text((workflow.params as Record<string, unknown>)[row.key])}>
                            {text((workflow.params as Record<string, unknown>)[row.key])}
                          </dd>
                        </div>
                      ))}
                    </dl>
                    <p className="mt-2 text-[10px] leading-4 text-apple-subtext">
                      cutoff：{workflow.cutoff === null ? '无数据' : text(workflow.cutoff)} · source {workflow.source}
                    </p>
                  </>
                )}
              </Card>

              <Card title="队列计数" hint="空 = 0，不编造" testId="contract-queue">
                <dl className="grid grid-cols-3 gap-2">
                  {QUEUE_KEYS.map((item) => (
                    <div key={item.key} className="rounded-lg bg-apple-bg/70 px-2 py-2">
                      <dt className="text-[10px] leading-4 text-apple-subtext">{item.label}</dt>
                      <dd className="num mt-0.5 text-[18px] font-semibold leading-none">{queueCounts[item.key]}</dd>
                      <dd className="num mt-0.5 text-[9px] uppercase tracking-wide text-apple-subtext">{item.key}</dd>
                    </div>
                  ))}
                </dl>
                <p className="mt-2 text-[10px] leading-4 text-apple-subtext">只读计数，不提供「开始渲染」入口。</p>
              </Card>

              <Card title="最近报告" hint="水位（非峰值）" testId="contract-recent">
                {!recent ? (
                  <p className="text-xs text-apple-subtext">reports/ 下没有报告。</p>
                ) : (
                  <>
                    <p className="num text-[11px] leading-5 break-all">job：{recent.job}</p>
                    <dl className="mt-1.5 space-y-1 text-[11px] leading-5">
                      {MEMORY_ROWS.map((row) => (
                        <div key={row.key} className="flex items-baseline justify-between gap-3">
                          <dt className="shrink-0 text-apple-subtext">{row.label}</dt>
                          <dd className="num min-w-0 break-all text-right" title={row.key}>
                            {memory ? text(memory[row.key]) : '—'}
                          </dd>
                        </div>
                      ))}
                    </dl>
                    <p className="mt-1 text-[10px] leading-4 text-apple-subtext">
                      {memory ? 'render_report.memory（内存水位，非峰值）。' : '无数据：最近报告没有 render_report.memory。'}
                    </p>
                    <p className="mt-1.5 text-[11px] leading-5">
                      quality_gate：
                      <span className="ml-1 font-medium">{job && job.quality_gate === null ? '未执行' : job ? text(job.quality_gate) : '无数据'}</span>
                    </p>
                    <p className="mt-0.5 text-[10px] leading-4 text-apple-subtext">
                      assemble_report：{recent.assemble_report ? '有' : '无'} · probe：{recent.probe ? '有' : '无'}
                    </p>
                  </>
                )}
              </Card>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
