import { useMemo, useState } from 'react'
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts'
import { Link } from '../../router'
import type { FlowJob, PlanTask, StudioJobSummary } from '../../types'
import { buildDailyEfficiencyData, type AgentLoadPoint, type EfficiencyTrendPoint } from './daily-efficiency'
import type { PipelineNodeSpec, ShotStoryboardItem } from './production-data'

type ChartViewMode = 'trend' | 'agents'

interface CustomTooltipPayloadItem {
  dataKey?: string | number
  value?: number
  payload?: EfficiencyTrendPoint & AgentLoadPoint
}

function EfficiencyTooltip({
  active,
  payload,
  mode
}: {
  active?: boolean
  payload?: ReadonlyArray<CustomTooltipPayloadItem>
  mode: ChartViewMode
}) {
  if (!active || !payload || payload.length === 0) return null
  const row = payload[0]?.payload
  if (!row) return null

  if (mode === 'trend') {
    return (
      <div className="rounded-xl border border-black/[0.08] bg-white/95 px-3.5 py-2.5 text-[12px] shadow-card backdrop-blur-sm">
        <div className="flex items-center justify-between gap-4">
          <span className="font-semibold text-apple-text">{row.slot}</span>
          <span className="text-[11px] text-apple-subtext">{row.statusLabel}</span>
        </div>
        <div className="mt-1.5 space-y-1 border-t border-black/[0.06] pt-1.5">
          <div className="flex items-center justify-between gap-5">
            <span className="text-apple-subtext">累计渲染完成率</span>
            <span className="num font-semibold text-apple-blueInk">{row.completionRate}%</span>
          </div>
          <div className="flex items-center justify-between gap-5">
            <span className="text-apple-subtext">Agent 负载强度</span>
            <span className="num font-semibold text-[#5E4AC7]">{row.agentLoad}%</span>
          </div>
          <div className="flex items-center justify-between gap-5 text-[11px]">
            <span className="text-apple-subtext">负责角色 · 阶段耗时</span>
            <span className="num text-apple-text">
              {row.roleName} · {row.durationS > 0 ? `${row.durationS}s` : '待执行'}
            </span>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-black/[0.08] bg-white/95 px-3.5 py-2.5 text-[12px] shadow-card backdrop-blur-sm">
      <div className="flex items-center justify-between gap-4">
        <span className="font-semibold text-apple-text">{row.roleName} Agent</span>
        <span className="text-[11px] text-apple-subtext">{row.activeStatus}</span>
      </div>
      <div className="mt-1 text-[11px] font-mono text-apple-subtext">{row.toolLabel}</div>
      <div className="mt-1.5 space-y-1 border-t border-black/[0.06] pt-1.5">
        <div className="flex items-center justify-between gap-5">
          <span className="text-apple-subtext">任务完成率</span>
          <span className="num font-semibold text-apple-blueInk">{row.completionPct}%</span>
        </div>
        <div className="flex items-center justify-between gap-5">
          <span className="text-apple-subtext">工位负载</span>
          <span className="num font-semibold text-[#5E4AC7]">{row.loadPct}%</span>
        </div>
        <div className="flex items-center justify-between gap-5 text-[11px]">
          <span className="text-apple-subtext">协同动作 / 累计耗时</span>
          <span className="num text-apple-text">
            {row.actionsCount} 项 · {row.durationS > 0 ? `${row.durationS}s` : '0s'}
          </span>
        </div>
      </div>
    </div>
  )
}

export function DailyEfficiencyCard({
  job,
  nodes,
  storyboard,
  tasks,
  studioJobs = [],
  deliveriesCount,
  memPct,
  queue,
  loading = false
}: {
  job: FlowJob | null
  nodes: PipelineNodeSpec[]
  storyboard: ShotStoryboardItem[]
  tasks: PlanTask[]
  studioJobs?: StudioJobSummary[]
  deliveriesCount: number
  memPct: number
  queue: { running: number; pending: number } | null
  loading?: boolean
}) {
  const [viewMode, setViewMode] = useState<ChartViewMode>('trend')

  const { summary, timelineSeries, agentLoadSeries } = useMemo(
    () =>
      buildDailyEfficiencyData({
        job,
        nodes,
        storyboard,
        tasks,
        studioJobs,
        deliveriesCount,
        memPct
      }),
    [job, nodes, storyboard, tasks, studioJobs, deliveriesCount, memPct]
  )

  const hasData = timelineSeries.length > 0 || tasks.length > 0

  return (
    <section aria-label="今日效能统计" className="card p-5" data-testid="daily-efficiency-card">
      {/* Header & Mode Segmented Switch */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-baseline gap-2.5">
            <h2 className="text-[16px] font-semibold tracking-tight text-apple-text">今日效能</h2>
            <span className="text-[12px] text-apple-subtext">
              渲染任务完成率与 Agent 负载趋势
              {job ? ` · 追踪 ${job.id}` : ''}
            </span>
          </div>
          <p className="mt-0.5 text-[11.5px] text-apple-subtext">
            汇总流水线阶段节点、计划排期进度与六角色算力占用，实时反映渲染推进与负载拐点
          </p>
        </div>

        <div
          role="tablist"
          aria-label="今日效能图表维度"
          className="inline-flex items-center gap-1 rounded-[10px] border border-black/[0.08] bg-[#FAFAFB] p-1"
        >
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === 'trend'}
            onClick={() => setViewMode('trend')}
            className={`rounded-lg px-3 py-1 text-xs font-medium transition-colors whitespace-nowrap ${
              viewMode === 'trend'
                ? 'bg-apple-text text-white'
                : 'text-apple-subtext hover:bg-white hover:text-apple-text'
            }`}
          >
            完成率与负载趋势
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === 'agents'}
            onClick={() => setViewMode('agents')}
            className={`rounded-lg px-3 py-1 text-xs font-medium transition-colors whitespace-nowrap ${
              viewMode === 'agents'
                ? 'bg-apple-text text-white'
                : 'text-apple-subtext hover:bg-white hover:text-apple-text'
            }`}
          >
            六角色 Agent 负载
          </button>
        </div>
      </div>

      {/* Inline Metric Summary Row (hairline separated, zero nested cards) */}
      <div className="mt-4 grid gap-4 border-y border-black/[0.06] py-3.5 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <div className="text-[11.5px] text-apple-subtext">今日综合渲染完成率</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="num text-[24px] font-semibold tracking-tight text-apple-blueInk">
              {summary.overallCompletionRate}%
            </span>
            <span className="num text-[11.5px] text-apple-subtext">
              节点 {summary.doneNodes}/{summary.totalNodes}
            </span>
          </div>
          <div className="num mt-0.5 text-[11px] text-apple-subtext">
            排期任务 {summary.doneTasks}/{summary.totalTasks} · 成片 {deliveriesCount} 支
          </div>
        </div>

        <div>
          <div className="text-[11.5px] text-apple-subtext">Agent 负载均值 / 峰值</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="num text-[24px] font-semibold tracking-tight text-[#5E4AC7]">
              {summary.avgAgentLoad}%
            </span>
            <span className="num text-[11.5px] text-apple-subtext">
              峰值 {summary.peakAgentLoad}%（{summary.peakAgentRole}）
            </span>
          </div>
          <div className="num mt-0.5 text-[11px] text-apple-subtext">
            {summary.activeAgentsCount}/6 角色参与当前流水线
          </div>
        </div>

        <div>
          <div className="text-[11.5px] text-apple-subtext">阶段计算耗时与吞吐</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="num text-[24px] font-semibold tracking-tight text-apple-text">
              {summary.totalRenderDurationS}s
            </span>
            <span className="text-[11.5px] text-apple-subtext">累计链路耗时</span>
          </div>
          <div className="num mt-0.5 text-[11px] text-apple-subtext">
            进行中 {summary.runningTasks} 项 · 阻塞 {summary.blockedTasks} 项
          </div>
        </div>

        <div>
          <div className="text-[11.5px] text-apple-subtext">宿主算力与队列压力</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="num text-[24px] font-semibold tracking-tight text-apple-text">
              {memPct}%
            </span>
            <span className="text-[11.5px] text-apple-subtext">Metal VRAM 占用</span>
          </div>
          <div className="num mt-0.5 text-[11px] text-apple-subtext">
            队列 {queue ? `${queue.running} 执行 / ${queue.pending} 待排` : '空闲待命'} · 工坊已完成 {summary.studioCompletedCount}
          </div>
        </div>
      </div>

      {/* Chart Legend */}
      <div className="mt-3.5 flex flex-wrap items-center justify-between gap-2 text-[11.5px] text-apple-subtext">
        <div className="flex flex-wrap items-center gap-4">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-sm bg-apple-blue" aria-hidden="true" />
            {viewMode === 'trend' ? '累计渲染完成率 (%)' : '角色任务完成率 (%)'}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-sm bg-[#5E4AC7]" aria-hidden="true" />
            Agent 负载 (%)
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-0 w-4 border-t border-dashed border-[#C77700]" aria-hidden="true" />
            80% 高负载警戒线
          </span>
        </div>
        <span className="text-[11px]">悬停柱状或曲线节点查看详细指标</span>
      </div>

      {/* Recharts Canvas */}
      {loading && !hasData ? (
        <div className="mt-3 h-[260px] w-full rounded-xl skeleton" aria-label="正在加载今日效能图表" />
      ) : !hasData ? (
        <div className="mt-3 flex h-[220px] flex-col items-center justify-center rounded-xl border border-black/[0.05] bg-[#FAFAFB] px-4 text-center">
          <p className="text-sm font-medium text-apple-text">暂无今日渲染效能记录</p>
          <p className="mt-1 text-xs text-apple-subtext">
            提交一条 A 轨生成任务或 B 轨视频美化任务后，系统将自动绘制阶段完成率与 Agent 负载趋势。
          </p>
          <Link
            to="/studio?rail=a"
            className="mt-3 inline-flex items-center rounded-lg bg-apple-text px-3 py-1.5 text-xs font-medium text-white hover:bg-black/85"
          >
            前往工作台发起任务
          </Link>
        </div>
      ) : (
        <div className="mt-2 h-[264px] w-full" data-testid="daily-efficiency-chart">
          <ResponsiveContainer width="100%" height="100%">
            {viewMode === 'trend' ? (
              <ComposedChart data={timelineSeries} margin={{ top: 14, right: 12, left: -12, bottom: 4 }}>
                <defs>
                  <linearGradient id="effCompletionFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#0071E3" stopOpacity={0.22} />
                    <stop offset="100%" stopColor="#0071E3" stopOpacity={0.01} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="rgba(0,0,0,0.06)" strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="shortLabel"
                  tick={{ fontSize: 11, fill: '#6E6E73' }}
                  axisLine={{ stroke: 'rgba(0,0,0,0.08)' }}
                  tickLine={false}
                />
                <YAxis
                  domain={[0, 100]}
                  ticks={[0, 25, 50, 75, 100]}
                  tickFormatter={(val) => `${val}%`}
                  tick={{ fontSize: 11, fill: '#6E6E73' }}
                  axisLine={false}
                  tickLine={false}
                />
                <ReferenceLine y={80} stroke="#C77700" strokeDasharray="4 4" strokeOpacity={0.7} />
                <Tooltip
                  cursor={{ fill: 'rgba(0, 113, 227, 0.04)' }}
                  content={(props) => (
                    <EfficiencyTooltip
                      active={props.active}
                      payload={props.payload as ReadonlyArray<CustomTooltipPayloadItem>}
                      mode="trend"
                    />
                  )}
                />
                <Bar
                  dataKey="agentLoad"
                  name="Agent 负载 (%)"
                  fill="#5E4AC7"
                  fillOpacity={0.82}
                  radius={[5, 5, 0, 0]}
                  barSize={24}
                />
                <Area
                  type="monotone"
                  dataKey="completionRate"
                  name="累计渲染完成率 (%)"
                  stroke="#0071E3"
                  strokeWidth={2.5}
                  fill="url(#effCompletionFill)"
                  dot={{ r: 3.5, fill: '#0071E3', stroke: '#ffffff', strokeWidth: 1.5 }}
                  activeDot={{ r: 5.5, fill: '#0071E3', stroke: '#ffffff', strokeWidth: 2 }}
                />
              </ComposedChart>
            ) : (
              <BarChart data={agentLoadSeries} margin={{ top: 14, right: 12, left: -12, bottom: 4 }}>
                <CartesianGrid stroke="rgba(0,0,0,0.06)" strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="roleName"
                  tick={{ fontSize: 11, fill: '#6E6E73' }}
                  axisLine={{ stroke: 'rgba(0,0,0,0.08)' }}
                  tickLine={false}
                />
                <YAxis
                  domain={[0, 100]}
                  ticks={[0, 25, 50, 75, 100]}
                  tickFormatter={(val) => `${val}%`}
                  tick={{ fontSize: 11, fill: '#6E6E73' }}
                  axisLine={false}
                  tickLine={false}
                />
                <ReferenceLine y={80} stroke="#C77700" strokeDasharray="4 4" strokeOpacity={0.7} />
                <Tooltip
                  cursor={{ fill: 'rgba(94, 74, 199, 0.05)' }}
                  content={(props) => (
                    <EfficiencyTooltip
                      active={props.active}
                      payload={props.payload as ReadonlyArray<CustomTooltipPayloadItem>}
                      mode="agents"
                    />
                  )}
                />
                <Bar
                  dataKey="completionPct"
                  name="角色任务完成率 (%)"
                  fill="#0071E3"
                  radius={[5, 5, 0, 0]}
                  barSize={20}
                />
                <Bar
                  dataKey="loadPct"
                  name="Agent 负载 (%)"
                  fill="#5E4AC7"
                  fillOpacity={0.86}
                  radius={[5, 5, 0, 0]}
                  barSize={20}
                />
              </BarChart>
            )}
          </ResponsiveContainer>
        </div>
      )}
    </section>
  )
}
