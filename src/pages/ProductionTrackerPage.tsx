import { useEffect, useMemo, useState } from 'react'
import { HttpError, postJson, useLiveJson, useSystem } from '../api'
import { DailyEfficiencyCard } from '../components/production/DailyEfficiencyCard'
import { enrichAndFilterJobs, JobPicker } from '../components/production/JobPicker'
import { ShotAgentMatrix } from '../components/production/ShotAgentMatrix'
import { StageNodeTrack } from '../components/production/StageNodeTrack'
import {
  buildPipelineNodes,
  buildStoryboard,
  type AgentRoleId,
  type ShotRoleAction
} from '../components/production/production-data'
import {
  Alert,
  ChevronRight,
  Clapper,
  Cpu,
  Film,
  Flow,
  Pause,
  Play,
  Refresh,
  Server,
  Sliders
} from '../components/icons'
import { formatClockMs, formatGb } from '../format'
import { Link } from '../router'
import { ToastHost } from '../components/ui'
import { formatTime } from '../components/flow/flow-utils'
import { useInfiniteScrollBatch, useToast } from '../hooks'
import { readSearchParam } from '../url'
import type {
  DeliveriesResponse,
  FlowResponse,
  OverviewAlert,
  OverviewResponse,
  PlanResponse,
  StatusResponse,
  StudioBriefsResponse,
  StudioJobsResponse
} from '../types'

const FLOW_POLL_MS = 3000
const TELEMETRY_POLL_MS = 3500

const ALERT_TONES: Record<OverviewAlert['type'], string> = {
  task_blocked: 'text-[#9A5B00]',
  job_fail: 'text-[#B3261E]',
  missing: 'text-apple-subtextAlt'
}

const ALERT_LABELS: Record<OverviewAlert['type'], string> = {
  task_blocked: '阻塞',
  job_fail: '判定未过',
  missing: '缺料'
}

function hostPort(value: string | null | undefined): string {
  if (!value) return '未配置'
  try {
    const u = new URL(value)
    return `${u.hostname}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`
  } catch {
    return value
  }
}

export function ProductionTrackerPage() {
  const [selectedJobId, setSelectedJobId] = useState<string | null>(() => {
    const param = readSearchParam('job')
    return param && param.trim() ? param.trim() : null
  })
  const [liveSync, setLiveSync] = useState(true)
  const flowPoll = liveSync ? FLOW_POLL_MS : 0
  const metaPoll = liveSync ? TELEMETRY_POLL_MS : 0

  const url = selectedJobId ? `/api/flow?job=${encodeURIComponent(selectedJobId)}` : '/api/flow'
  const flow = useLiveJson<FlowResponse>(url, flowPoll)
  const briefsState = useLiveJson<StudioBriefsResponse>('/api/studio/briefs?limit=50', metaPoll)
  const overview = useLiveJson<OverviewResponse>('/api/overview', metaPoll)
  const plan = useLiveJson<PlanResponse>('/api/plan', metaPoll)
  const status = useLiveJson<StatusResponse>('/api/status', metaPoll)
  const deliveriesRes = useLiveJson<DeliveriesResponse>('/api/deliveries', metaPoll)
  const studioJobsRes = useLiveJson<StudioJobsResponse>('/api/studio/jobs?limit=50', metaPoll)
  const system = useSystem(liveSync ? 10000 : 0)
  const { toast, showToast, clearToast } = useToast(3400)

  const jobs = flow.data?.jobs ?? []
  const job = flow.data?.job ?? null

  // #122：/api/studio/briefs 已按 updated_at 倒序，直接取最近更新的 Brief；
  // 不再按 job id 特判残留 mock brief（brief_coffee_ad_001 / brief_vlog_cafe_002）。
  const activeBrief = briefsState.data?.items?.[0] ?? null

  const scriptStatus = activeBrief?.polished ? 'done' : undefined

  const nodes = useMemo(
    () => buildPipelineNodes(job, { scriptStatus, brief: activeBrief }),
    [job, scriptStatus, activeBrief]
  )
  const storyboard = useMemo(() => buildStoryboard(job, activeBrief), [job, activeBrief])

  const [activeStageKey, setActiveStageKey] = useState<string>('D')
  const [selectedShotId, setSelectedShotId] = useState<number>(1)
  const [roleFilter, setRoleFilter] = useState<AgentRoleId>('all')
  const [alertFilter, setAlertFilter] = useState<'all' | OverviewAlert['type']>('all')
  const [decisionRoleFilter, setDecisionRoleFilter] = useState<string>('all')
  const [retryBusy, setRetryBusy] = useState(false)
  const [decisionBusyKey, setDecisionBusyKey] = useState<string | null>(null)

  const deliveries = deliveriesRes.data?.deliveries ?? []
  const activeRenderingJobs = useMemo(
    () => enrichAndFilterJobs(jobs, deliveries, '', 'rendering', job?.id, job?.stage),
    [jobs, deliveries, job?.id, job?.stage]
  )

  useEffect(() => {
    if (selectedJobId || activeRenderingJobs.length === 0) return
    const firstActive = activeRenderingJobs[0]
    if (firstActive && job?.id !== firstActive.id) {
      setSelectedJobId(firstActive.id)
    }
  }, [selectedJobId, activeRenderingJobs, job?.id])

  const effectiveStageKey = useMemo(() => {
    if (nodes.some((n) => n.key === activeStageKey)) return activeStageKey
    const running = nodes.find((n) => n.status === 'running')
    return running?.key ?? nodes[0]?.key ?? 'A'
  }, [activeStageKey, nodes])

  const activeNodeArtifacts = useMemo(() => {
    if (!job) return []
    const stageKey = effectiveStageKey === 'B2' ? 'B' : effectiveStageKey === 'SCRIPT' ? 'C' : effectiveStageKey
    return job.stages.find((s) => s.key === stageKey)?.artifacts ?? []
  }, [job, effectiveStageKey])

  const effectiveShotId = useMemo(() => {
    if (storyboard.some((s) => s.shotId === selectedShotId)) return selectedShotId
    return storyboard[0]?.shotId ?? 1
  }, [storyboard, selectedShotId])

  const sys = system.data
  const coldWarm = (job?.cold_warm as Record<string, unknown> | null) ?? null
  const freeMemGb =
    sys?.vram?.free ?? (typeof coldWarm?.free_mem_gb === 'number' ? coldWarm.free_mem_gb : 38.6)
  const totalMemGb = sys?.vram?.total ?? 48
  const usedMetalGb = sys?.vram?.used ?? Math.max(4, Math.min(totalMemGb, Number((totalMemGb - freeMemGb).toFixed(1))))
  const memPct = Math.round((usedMetalGb / Math.max(1, totalMemGb)) * 100)

  const tasks = plan.data?.data?.tasks ?? []
  const taskCounts = overview.data?.counts.tasks ?? {
    done: tasks.filter((t) => t.status === 'done').length,
    running: tasks.filter((t) => t.status === 'running' || t.status === 'in_progress').length,
    pending: tasks.filter((t) => t.status === 'pending').length,
    blocked: tasks.filter((t) => t.status === 'blocked').length,
    total: tasks.length
  }
  const eta = plan.data?.data?.eta
  const alerts: OverviewAlert[] = useMemo(() => {
    if (overview.data?.alerts) return overview.data.alerts
    const out: OverviewAlert[] = []
    for (const task of tasks) {
      if (task.status === 'blocked') {
        out.push({ type: 'task_blocked', id: task.id, title: task.title, detail: task.blocked_by ?? null })
      }
    }
    for (const item of status.data?.data?.missing ?? []) {
      out.push({ type: 'missing', id: item.item, title: item.item, detail: item.why })
    }
    return out
  }, [overview.data?.alerts, tasks, status.data?.data?.missing])

  const filteredAlerts = useMemo(
    () => (alertFilter === 'all' ? alerts : alerts.filter((a) => a.type === alertFilter)),
    [alerts, alertFilter]
  )

  const decisions = job?.decisions ?? []
  const decisionRoles = useMemo(() => {
    const roles = new Set<string>()
    for (const dec of decisions) {
      const role = typeof dec?.role === 'string' && dec.role.trim() ? dec.role.trim() : 'orchestrator'
      roles.add(role)
    }
    return Array.from(roles)
  }, [decisions])

  const filteredDecisions = useMemo(() => {
    if (decisionRoleFilter === 'all') return decisions
    return decisions.filter((dec) => {
      const role = typeof dec?.role === 'string' && dec.role.trim() ? dec.role.trim() : 'orchestrator'
      return role === decisionRoleFilter
    })
  }, [decisions, decisionRoleFilter])

  const decisionBatch = useInfiniteScrollBatch(
    filteredDecisions.length,
    8,
    8,
    `${job?.id ?? ''}|${decisionRoleFilter}`
  )
  const visibleDecisions = filteredDecisions.slice(0, decisionBatch.visibleCount)

  const lastSyncedAt = Math.max(
    flow.updatedAt ?? 0,
    overview.updatedAt ?? 0,
    deliveriesRes.updatedAt ?? 0
  )

  const isRefreshing =
    flow.refreshing ||
    system.refreshing ||
    overview.refreshing ||
    plan.refreshing ||
    deliveriesRes.refreshing ||
    studioJobsRes.refreshing

  const handleRefreshAll = async () => {
    await Promise.all([
      flow.refresh(),
      system.refresh(),
      overview.refresh(),
      plan.refresh(),
      deliveriesRes.refresh(),
      studioJobsRes.refresh(),
      briefsState.refresh()
    ])
    showToast('已同步最新节点、主机与交付数据')
  }

  const actionError = (err: unknown) =>
    err instanceof HttpError
      ? err.message
      : err instanceof Error
        ? err.message
        : '请求失败，请稍后重试'

  const handleRetryJob = async () => {
    const jobId = job?.id
    if (!jobId || retryBusy) return
    setRetryBusy(true)
    try {
      const created = await postJson<{ id?: string }>(
        `/api/studio/jobs/${encodeURIComponent(jobId)}/retry`,
        {}
      )
      showToast(`已提交重跑：${created.id ?? jobId}`)
      await Promise.all([flow.refresh(), studioJobsRes.refresh()])
    } catch (err) {
      // 409 = 任务不是 failed/canceled；直接显示后端 error，不做本地假成功。
      showToast(`重跑失败：${actionError(err)}`)
    } finally {
      setRetryBusy(false)
    }
  }

  const handleDecision = async (action: ShotRoleAction, decision: 'adopt' | 'reject') => {
    const jobId = job?.id
    const key = `${action.id}:${decision}`
    if (!jobId || decisionBusyKey) return
    setDecisionBusyKey(key)
    try {
      await postJson<{ decision?: { at?: string } }>('/api/decisions', {
        job: jobId,
        action: decision,
        actor: '制片总台',
        note: action.actionTitle,
        stage: action.stageKey,
        tool: action.tool
      })
      showToast(
        decision === 'adopt'
          ? `已采纳「${action.actionTitle}」`
          : `已驳回「${action.actionTitle}」，等待重跑`
      )
      await flow.refresh()
    } catch (err) {
      showToast(`${decision === 'adopt' ? '采纳' : '驳回'}失败：${actionError(err)}`)
    } finally {
      setDecisionBusyKey(null)
    }
  }

  return (
    <div className="space-y-5">
      {/* Header & Scalable Video Job Selector */}
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-apple-subtext">
            <span>Kex Labs · 制片总台</span>
            <span aria-hidden="true">·</span>
            <span>仅追踪当前正在渲染 / 执行中的活跃任务（历史成片请在「任务中心 / 交付与资产」查看）</span>
          </div>
          <h1 className="mt-1 text-[28px] font-semibold tracking-[-0.024em] text-apple-text sm:text-[32px]">
            视频生产总台
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <JobPicker
            jobs={jobs}
            deliveries={deliveries}
            selectedJobId={job?.id ?? selectedJobId}
            currentJobStage={job?.stage ?? null}
            activeOnly
            onSelectJob={(jobId) => {
              setSelectedJobId(jobId)
              setSelectedShotId(1)
              setDecisionRoleFilter('all')
            }}
          />

          <button
            type="button"
            onClick={() => {
              setLiveSync((prev) => {
                const next = !prev
                showToast(next ? '已开启 3 秒实时同步' : '已暂停自动轮询，可随时点击立即刷新')
                return next
              })
            }}
            data-testid="production-live-sync-toggle"
            className={`inline-flex h-9 items-center gap-1.5 rounded-[10px] border px-3 text-xs font-medium transition-colors whitespace-nowrap ${
              liveSync
                ? 'border-[#BCE3C5] bg-[#F2FBF4] text-[#1E7A3C] hover:bg-[#E7F7EB]'
                : 'border-black/[0.08] bg-white text-apple-subtext hover:text-apple-text'
            }`}
          >
            {liveSync ? (
              <>
                <span className="live-beacon h-2 w-2 rounded-full bg-[#30A14E] text-[#30A14E]" />
                <Pause className="h-3 w-3" />
                <span>实时同步 3s</span>
              </>
            ) : (
              <>
                <Play className="h-3 w-3" />
                <span>已暂停轮询</span>
              </>
            )}
            {lastSyncedAt > 0 && (
              <span className="num text-[10.5px] opacity-80">· {formatClockMs(lastSyncedAt)}</span>
            )}
          </button>

          <button
            type="button"
            onClick={() => void handleRefreshAll()}
            disabled={isRefreshing}
            className="inline-flex h-9 items-center gap-1.5 rounded-[10px] border border-black/[0.08] bg-white px-3 text-xs font-medium text-apple-text transition-colors hover:bg-[#FAFAFB] disabled:opacity-60 whitespace-nowrap"
          >
            <Refresh className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
            立即刷新
          </button>
        </div>
      </header>

      {/* Dual-Rail Action Launchpad */}
      <section aria-label="双轨视频创作入口" className="grid gap-3 md:grid-cols-2">
        <Link
          to="/studio?rail=a"
          className="card card-interactive group flex items-center justify-between gap-4 p-4"
        >
          <div className="flex min-w-0 items-start gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[10px] bg-[#EAF2FF] text-[#0A6CD8]">
              <Clapper className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-xs font-semibold text-apple-blueInk">
                <span>A 轨 · 原创生成流水线</span>
              </div>
              <h2 className="mt-0.5 text-[15px] font-semibold text-apple-text">
                剧本生图 → 关键帧 → I2V 成片
              </h2>
              <p className="mt-0.5 truncate text-[11.5px] text-apple-subtext">
                AI 分场剧本生成与编辑、Brief 锁定、关键帧重绘及队列提交
              </p>
            </div>
          </div>
          <ChevronRight className="h-4 w-4 shrink-0 text-apple-subtext transition-transform group-hover:translate-x-0.5 group-hover:text-apple-blue" />
        </Link>

        <Link
          to="/studio?rail=b"
          className="card card-interactive group flex items-center justify-between gap-4 p-4"
        >
          <div className="flex min-w-0 items-start gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[10px] bg-[#EAF8EE] text-[#1E7A3C]">
              <Sliders className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-xs font-semibold text-[#1E7A3C]">
                <span>B 轨 · 视频增强流水线</span>
              </div>
              <h2 className="mt-0.5 text-[15px] font-semibold text-apple-text">
                上传视频 → AI 拆画诊断 → 美化调色渲染
              </h2>
              <p className="mt-0.5 truncate text-[11.5px] text-apple-subtext">
                自动抽帧、Gemini 视觉逐帧分析、LUT/降噪/锐化及前后分屏对比导出
              </p>
            </div>
          </div>
          <ChevronRight className="h-4 w-4 shrink-0 text-apple-subtext transition-transform group-hover:translate-x-0.5 group-hover:text-[#1E7A3C]" />
        </Link>
      </section>

      {/* Live Operations & Hardware KPI Strip */}
      <section aria-label="主机算力、排期与系统实况" data-stagger className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="card relative flex flex-col overflow-hidden p-4">
          <span aria-hidden="true" className="absolute inset-x-0 top-0 h-[3px] bg-apple-blue" />
          <div className="flex items-center justify-between gap-2 text-[12px] text-apple-subtext">
            <span>Metal VRAM 护栏</span>
            <Cpu className="h-4 w-4 text-apple-blue" />
          </div>
          <div className="mt-2 flex items-baseline gap-1.5">
            <span className="num text-[22px] font-semibold tracking-tight text-apple-text">
              {formatGb(usedMetalGb)}
            </span>
            <span className="num text-xs text-apple-subtext">/ {formatGb(totalMemGb)} GB</span>
          </div>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-black/[0.06]">
            <div
              className={`progress-shimmer h-full rounded-full transition-all duration-300 ${
                memPct > 80 ? 'bg-[#C77700]' : 'bg-apple-blue'
              }`}
              style={{ width: `${Math.min(100, Math.max(0, memPct))}%` }}
            />
          </div>
          <p className="num mt-2 text-[11px] text-apple-subtext">
            余 {formatGb(freeMemGb)} GB · {job?.stage === 'D' ? 'LTX-2B 独占加载中' : '空闲待命'}
          </p>
        </div>

        <div className="card relative flex flex-col overflow-hidden p-4">
          <span aria-hidden="true" className="absolute inset-x-0 top-0 h-[3px] bg-[#5E4AC7]" />
          <div className="flex items-center justify-between gap-2 text-[12px] text-apple-subtext">
            <span>渲染队列与主机</span>
            <Server className="h-4 w-4 text-[#5E4AC7]" />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="num text-[22px] font-semibold tracking-tight text-apple-text">
              {sys?.queue ? `${sys.queue.running} 执行` : sys?.online ? '在线' : '待连接'}
            </span>
            {sys?.queue && (
              <span className="num text-xs text-apple-subtext">{sys.queue.pending} 待排</span>
            )}
          </div>
          <p className="mt-auto pt-3 text-[11px] text-apple-subtext">
            <span
              className={`mr-1.5 inline-block h-1.5 w-1.5 rounded-full ${
                sys?.online ? 'bg-[#30A14E]' : 'bg-[#8E8E93]'
              }`}
              aria-hidden="true"
            />
            Studio {hostPort(sys?.configuredUrl)}
            {sys?.latencyMs != null ? ` · ${sys.latencyMs}ms` : ''}
          </p>
        </div>

        <div className="card relative flex flex-col overflow-hidden p-4">
          <span aria-hidden="true" className="absolute inset-x-0 top-0 h-[3px] bg-[#30A14E]" />
          <div className="flex items-center justify-between gap-2 text-[12px] text-apple-subtext">
            <span>计划任务与 ETA</span>
            <Flow className="h-4 w-4 text-[#30A14E]" />
          </div>
          <div className="mt-2 flex items-baseline gap-1.5">
            <span className="num text-[22px] font-semibold tracking-tight text-apple-text">
              {taskCounts.done}/{taskCounts.total}
            </span>
            <span className="text-xs text-apple-subtext">已完成</span>
          </div>
          <p className="num mt-auto pt-3 text-[11px] text-apple-subtext">
            进行 {taskCounts.running} · 待办 {taskCounts.pending} · 阻塞 {taskCounts.blocked}
            {eta?.base_case_days != null ? ` · 预计 ${eta.base_case_days}d` : ''}
          </p>
        </div>

        <div className="card relative flex flex-col overflow-hidden p-4">
          <span aria-hidden="true" className="absolute inset-x-0 top-0 h-[3px] bg-[#C77700]" />
          <div className="flex items-center justify-between gap-2 text-[12px] text-apple-subtext">
            <span>当前正在渲染 / 执行</span>
            <Film className="h-4 w-4 text-[#C77700]" />
          </div>
          <div className="mt-2 truncate text-[13.5px] font-semibold text-apple-text" title={job?.id}>
            {activeRenderingJobs.length > 0 && job
              ? job.id
              : flow.status === 'loading'
                ? '读取中…'
                : '当前无渲染中任务'}
          </div>
          <p className="num mt-auto pt-3 text-[11px] text-apple-subtext">
            活跃队列 {activeRenderingJobs.length} 支 · 模板{' '}
            {String((job?.profile as Record<string, unknown> | null)?.name ?? 'ad_teal_orange')} ·{' '}
            {job?.shots?.length ?? 0} 镜头
          </p>
        </div>
      </section>

      {flow.status === 'ready' && activeRenderingJobs.length === 0 && (
        <section
          aria-label="当前无渲染中任务提示"
          data-testid="production-no-active-banner"
          className="card flex flex-wrap items-center justify-between gap-3 border-[#D8E6FE] bg-[#F5F9FF] px-4 py-3 text-xs"
        >
          <div className="text-apple-text">
            <span className="font-semibold text-apple-blueInk">当前没有正在渲染或执行中的视频任务</span>
            <span className="ml-2 text-apple-subtext">
              总台专注实时排产监控，历史已完结视频不在此混排；如需查看成片与历史，请前往交付与资产或任务中心。
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <Link
              to="/studio"
              className="rounded-lg bg-apple-blue px-3 py-1.5 font-medium text-white hover:bg-[#0062C4]"
            >
              前往创作工坊提交新任务
            </Link>
            <Link
              to="/deliveries"
              className="rounded-lg border border-black/[0.1] bg-white px-3 py-1.5 font-medium text-apple-text hover:bg-black/[0.03]"
            >
              查看历史交付（{deliveries.length}）
            </Link>
          </div>
        </section>
      )}

      {/* Expandable System Alerts Strip */}
      {alerts.length > 0 && (
        <section aria-label="系统告警与阻塞" className="card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2.5 text-[12.5px]">
              <Alert className="h-4 w-4 text-apple-amber" />
              <span className="font-semibold text-apple-text">需要关注（{alerts.length} 项）</span>
            </div>
            <div className="flex flex-wrap items-center gap-1" role="group" aria-label="按告警类型筛选">
              {(
                [
                  { key: 'all', label: '全部' },
                  { key: 'task_blocked', label: '阻塞' },
                  { key: 'job_fail', label: '判定未过' },
                  { key: 'missing', label: '缺料' }
                ] as const
              ).map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  aria-pressed={alertFilter === tab.key}
                  onClick={() => setAlertFilter(tab.key)}
                  className={`rounded-lg px-2.5 py-1 text-[11px] font-medium transition-colors ${
                    alertFilter === tab.key
                      ? 'bg-apple-text text-white'
                      : 'bg-apple-bg text-apple-subtext hover:text-apple-text'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          <details className="mt-2" open={alertFilter !== 'all'}>
            <summary className="w-fit cursor-pointer text-[11.5px] font-medium text-apple-blue hover:underline">
              查看明细（{filteredAlerts.length} 项）
            </summary>
            <ul className="mt-2 grid gap-2 sm:grid-cols-2">
              {filteredAlerts.map((item, idx) => (
                <li
                  key={`${item.type}-${item.id ?? idx}`}
                  className="flex items-start justify-between gap-3 rounded-lg bg-apple-bg/70 px-3 py-2 text-[12px]"
                >
                  <div className="min-w-0">
                    <span className={`mr-2 font-semibold ${ALERT_TONES[item.type]}`}>
                      {ALERT_LABELS[item.type]}
                    </span>
                    <span className="font-medium text-apple-text">{item.title}</span>
                    {item.detail && (
                      <p className="mt-0.5 truncate text-[11px] text-apple-subtext">{item.detail}</p>
                    )}
                  </div>
                  <Link
                    to={item.type === 'job_fail' && item.id ? `/job/${encodeURIComponent(item.id)}` : '/jobs'}
                    className="shrink-0 text-[11px] font-medium text-apple-blue hover:underline"
                  >
                    处理 →
                  </Link>
                </li>
              ))}
            </ul>
          </details>
        </section>
      )}

      {/* Daily Efficiency Recharts Card */}
      <DailyEfficiencyCard
        job={job}
        nodes={nodes}
        storyboard={storyboard}
        tasks={tasks}
        studioJobs={studioJobsRes.data?.items ?? []}
        deliveriesCount={deliveries.length}
        memPct={memPct}
        queue={sys?.queue ?? null}
        loading={flow.status === 'loading' && plan.status === 'loading'}
      />

      {/* Section 1: Interactive SVG Node Flowchart & Inspector */}
      <StageNodeTrack
        job={job}
        brief={activeBrief}
        scriptStatus={scriptStatus}
        nodes={nodes}
        activeKey={effectiveStageKey}
        onSelectNode={setActiveStageKey}
        stageArtifacts={activeNodeArtifacts}
        onRetryNode={job?.id ? handleRetryJob : undefined}
        retryBusy={retryBusy}
      />

      {/* Section 2: Per-Shot Monitor & 6-Role Agent Collaboration Matrix */}
      <ShotAgentMatrix
        shots={storyboard}
        selectedShotId={effectiveShotId}
        onSelectShot={setSelectedShotId}
        roleFilter={roleFilter}
        onRoleFilter={setRoleFilter}
        jobId={job?.id ?? null}
        onDecision={handleDecision}
        decisionBusyKey={decisionBusyKey}
      />

      {/* Section 3: L3 Orchestrator Decision Audit Log (Active Job Execution Stream) */}
      <section aria-label="L3 编排决策流水" className="card p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h2 className="text-[15px] font-semibold text-apple-text">
              L3 Orchestrator 实时编排决策流水
            </h2>
            <p className="mt-0.5 text-[12px] text-apple-subtext">
              记录当前活跃任务的参数调度与工具选择链路 · 共 {decisions.length} 条真实决策（历史已成片请在
              <Link to="/deliveries" className="mx-1 text-apple-blueInk hover:underline">
                交付与资产
              </Link>
              查看）
            </p>
          </div>
          <Link to="/jobs?tab=studio" className="text-[12px] font-medium text-apple-blueInk hover:underline">
            全部渲染队列 →
          </Link>
        </div>

        {decisionRoles.length > 1 && (
          <div className="mt-3 flex flex-wrap items-center gap-1">
            <button
              type="button"
              onClick={() => setDecisionRoleFilter('all')}
              className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                decisionRoleFilter === 'all'
                  ? 'bg-apple-text text-white'
                  : 'bg-[#F5F5F7] text-apple-subtext hover:text-apple-text'
              }`}
            >
              全部 {decisions.length}
            </button>
            {decisionRoles.map((role) => (
              <button
                key={role}
                type="button"
                onClick={() => setDecisionRoleFilter(role)}
                className={`rounded-md px-2 py-1 font-mono text-[11px] font-medium transition-colors ${
                  decisionRoleFilter === role
                    ? 'bg-apple-text text-white'
                    : 'bg-[#F5F5F7] text-apple-subtext hover:text-apple-text'
                }`}
              >
                {role}
              </button>
            ))}
          </div>
        )}

        <div className="mt-3 divide-y divide-black/[0.05]">
          {visibleDecisions.map((dec, idx) => {
            const role = typeof dec?.role === 'string' ? dec.role : 'orchestrator'
            const kind = typeof dec?.kind === 'string' ? dec.kind : 'decision'
            const summary = typeof dec?.summary === 'string' ? dec.summary : JSON.stringify(dec)
            return (
              <div key={idx} className="flex flex-col gap-1 py-2.5 text-[12.5px] sm:flex-row sm:items-baseline sm:gap-4">
                <span className="num w-36 shrink-0 text-[11px] text-apple-subtext">
                  {formatTime(typeof dec?.at === 'string' ? dec.at : null)}
                </span>
                <span className="w-36 shrink-0 font-mono text-[11.5px] font-semibold text-apple-blueInk">
                  {role}
                </span>
                <span className="flex-1 text-apple-text">{summary}</span>
                <span className="shrink-0 font-mono text-[11px] text-apple-subtext">{kind}</span>
              </div>
            )
          })}
          {filteredDecisions.length === 0 && (
            <div className="py-4 text-[12px] text-apple-subtext">当前筛选条件下暂无决策记录。</div>
          )}
        </div>

        {filteredDecisions.length > 0 && (
          <div
            ref={decisionBatch.sentinelRef}
            className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-black/[0.05] pt-2.5 text-[11.5px] text-apple-subtext"
          >
            <span className="num">
              已加载 {visibleDecisions.length} / {filteredDecisions.length} 条决策
              {decisionBatch.hasMore ? ' · 下拉懒加载更多' : ''}
            </span>
            {decisionBatch.hasMore && (
              <button
                type="button"
                onClick={decisionBatch.loadMore}
                className="font-medium text-apple-blueInk hover:underline"
              >
                加载更多决策
              </button>
            )}
          </div>
        )}
      </section>

      <ToastHost toast={toast} onClose={clearToast} />
    </div>
  )
}
