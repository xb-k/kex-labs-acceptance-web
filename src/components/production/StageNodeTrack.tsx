import { Refresh, Server, Shield } from '../icons'
import { RenderFlowGraph, type RenderNodeStatus } from '../flow/RenderFlowGraph'
import { Link } from '../../router'
import type { FlowArtifact, FlowJob, StudioBrief } from '../../types'
import { AGENT_ROLES, type PipelineNodeSpec } from './production-data'

export function StageNodeTrack({
  job = null,
  brief = null,
  scriptStatus,
  nodes,
  activeKey,
  onSelectNode,
  stageArtifacts,
  onRetryNode,
  retryBusy = false
}: {
  job?: FlowJob | null
  brief?: StudioBrief | null
  scriptStatus?: RenderNodeStatus
  nodes: PipelineNodeSpec[]
  activeKey: string
  onSelectNode: (key: string) => void
  stageArtifacts: FlowArtifact[]
  onRetryNode?: () => void | Promise<void>
  retryBusy?: boolean
}) {
  const activeNode = nodes.find((n) => n.key === activeKey) ?? nodes[0]
  const roleMeta = AGENT_ROLES.find((r) => r.id === activeNode?.role)

  return (
    <section aria-label="渲染流程节点图" className="card p-5">
      <RenderFlowGraph
        embedded
        job={job}
        pipelineNodes={nodes}
        activeStageKey={activeKey}
        scriptStatus={scriptStatus}
        scriptSummary={brief?.polished?.logline ? `Logline: ${brief.polished.logline}` : undefined}
        onSelectStage={(stageKey) => onSelectNode(stageKey)}
        title="渲染流程节点图 · 入库 → 切片 → Agent 处理 → 合成"
        subtitle="点击任意节点或阶段分组激活高亮；含视频剧本生成节点，处理中时 SVG 连线显示流动光点"
      />

      {/* Selected Node Inspector Strip */}
      {activeNode && (
        <div className="mt-4 grid gap-4 border-t border-black/[0.06] pt-4 lg:grid-cols-12">
          <div className="lg:col-span-7 flex flex-col justify-between gap-3">
            <div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-apple-subtext">
                <span className="num font-semibold text-apple-text">{activeNode.code}</span>
                <span aria-hidden="true">·</span>
                <span className="font-medium text-apple-text">{activeNode.title}</span>
                <span aria-hidden="true">·</span>
                <span className={roleMeta?.accentText}>{roleMeta?.name} Agent 主导</span>
                <span aria-hidden="true">·</span>
                <span className="num">{activeNode.memoryNote}</span>
              </div>
              <p className="mt-2 text-[13px] leading-relaxed text-apple-text">
                {activeNode.contractSummary}
              </p>
              <div className="mt-2.5 flex flex-wrap items-center gap-4 text-[12px] text-apple-subtext">
                <span>
                  当前进展：<strong className="font-medium text-apple-text">{activeNode.progressNote}</strong>
                </span>
                <span className="inline-flex items-center gap-1">
                  <Shield className="h-3.5 w-3.5 text-apple-subtext" />
                  幂等校验 + 断点检查点已开启
                </span>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button
                type="button"
                disabled={!onRetryNode || retryBusy}
                onClick={() => void onRetryNode?.()}
                title={onRetryNode ? '提交后端重跑当前任务' : '当前任务不可重跑'}
                className={`inline-flex items-center gap-1.5 rounded-lg bg-apple-text px-3 py-1.5 text-xs font-medium text-white whitespace-nowrap ${
                  !onRetryNode || retryBusy ? 'cursor-not-allowed opacity-60' : 'hover:bg-black'
                }`}
              >
                <Refresh className="h-3.5 w-3.5" />
                {retryBusy ? '提交重跑中…' : `提交重跑 (${activeNode.code})`}
              </button>
              {activeNode.key === 'SCRIPT' && (
                <Link
                  to="/studio?rail=a"
                  className="inline-flex items-center rounded-lg border border-apple-blue/35 bg-[#F0F6FF] px-3 py-1.5 text-xs font-medium text-apple-blueInk transition-colors hover:bg-[#E2EEFF]"
                >
                  进入 A 轨剧本与制片工坊 →
                </Link>
              )}
              {activeNode.key === 'B2' && (
                <Link
                  to="/studio?rail=b"
                  className="inline-flex items-center rounded-lg border border-[#CDEED6] bg-[#EAF8EE] px-3 py-1.5 text-xs font-medium text-[#1E7A3C] transition-colors hover:bg-[#DDF3E4]"
                >
                  前往 B 轨视频 AI 拆画美化 →
                </Link>
              )}
              <span className="inline-flex items-center gap-1.5 text-[11px] text-apple-subtext">
                <Server className="h-3.5 w-3.5" />
                工具链：<span className="font-mono text-apple-text">{activeNode.toolChain}</span>
              </span>
            </div>
          </div>

          <div className="lg:col-span-5">
            {activeNode.key === 'SCRIPT' ? (
              <div>
                <div className="text-[11px] font-medium text-apple-subtext">
                  本节点真实剧本产出（{brief?.id ?? 'studio/briefs'}）
                </div>
                <div className="mt-2 rounded-[10px] border border-black/[0.08] bg-white p-3 text-[12px]">
                  <div className="font-semibold text-apple-text">
                    {brief?.polished?.logline ?? '尚未生成 Logline'}
                  </div>
                  <p className="mt-1.5 line-clamp-3 whitespace-pre-wrap text-[11.5px] leading-relaxed text-apple-subtext">
                    {brief?.polished?.script ?? '点击下方「AI 生成 / 重新润色剧本」产出完整旁白与分镜脚本。'}
                  </p>
                  {brief?.polished?.shots?.length ? (
                    <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-black/[0.05] pt-2 text-[11px] text-apple-blueInk">
                      <span className="num font-medium">{brief.polished.shots.length} 镜分镜脚本已结构化</span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono text-apple-subtext">{brief.status}</span>
                    </div>
                  ) : null}
                </div>
              </div>
            ) : (
              <>
                <div className="text-[11px] font-medium text-apple-subtext">本节点真实输出产物（/media/kex）</div>
                {stageArtifacts.length > 0 ? (
                  <div className="mt-2 grid grid-cols-2 gap-2.5">
                    {stageArtifacts.slice(0, 2).map((art) => (
                      <div
                        key={art.path}
                        className="overflow-hidden rounded-[10px] border border-black/[0.08] bg-[#121316]"
                      >
                        {art.url && art.kind === 'image' ? (
                          <img
                            src={art.url}
                            alt={art.label}
                            referrerPolicy="no-referrer"
                            className="h-24 w-full object-cover"
                          />
                        ) : art.url && art.kind === 'video' ? (
                          <video
                            src={art.url}
                            controls
                            muted
                            playsInline
                            preload="metadata"
                            className="h-24 w-full object-cover"
                          />
                        ) : (
                          <div className="grid h-24 min-w-0 place-items-center break-all px-2 text-center text-[11px] leading-relaxed text-white/60">
                            产物路径：{art.path}
                          </div>
                        )}
                        <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 text-[11px] text-white/85">
                          <span className="truncate">{art.label}</span>
                          <span className="truncate font-mono text-[10px] text-white/55">
                            {art.path.split('/').pop()}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="mt-2 flex h-24 items-center justify-center rounded-[10px] border border-dashed border-black/[0.12] bg-white px-4 text-center text-[12px] text-apple-subtext">
                    {activeNode.status === 'pending'
                      ? '该节点正在排队等待上一阶段释放模型内存锁'
                      : '该节点为规则映射/元数据检查点，输出已写入 state.json 与 decision log'}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
