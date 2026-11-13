import { useState, type ReactNode } from 'react'
import { useJson, useSystem } from '../api'
import type {
  DeliveriesResponse,
  Delivery,
  JobsResponse,
  OverviewAlert,
  OverviewResponse,
  PlanResponse,
  StatusResponse,
  SystemSnapshot
} from '../types'
import { Link } from '../router'
import { StatusChip } from '../components/StatusChip'
import { TaskFlowBoard } from '../components/TaskFlowBoard'
import { LazySection, LazyVideo, LoadMore, Skeleton } from '../components/lazy'
import { Alert, ChevronRight, Cpu, Film, Refresh } from '../components/icons'
import { formatDuration, formatResolution } from '../format'
import { jobReadable } from '../job-label'

const DELIVERIES_PAGE = 4

function gb(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const n = value / 1024 ** 3
  return n >= 10 ? n.toFixed(0) : n.toFixed(1)
}

/** 从完整 URL 取 host:port；缺省端口按协议补 80/443，无法解析时原样返回。 */
function hostPort(value: string | null | undefined): string {
  if (!value) return '未配置'
  try {
    const u = new URL(value)
    return `${u.hostname}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`
  } catch {
    return value
  }
}

function stamp(value: string | null | undefined): string {
  if (!value) return '无数据'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value.slice(0, 16).replace('T', ' ')
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function deriveAlerts(
  plan: PlanResponse | null,
  jobs: JobsResponse | null,
  status: StatusResponse | null
): OverviewAlert[] {
  const alerts: OverviewAlert[] = []
  for (const task of plan?.data?.tasks ?? []) {
    if (task.status === 'blocked') {
      alerts.push({ type: 'task_blocked', id: task.id, title: task.title, detail: task.blocked_by ?? null })
    }
  }
  for (const job of jobs?.jobs ?? []) {
    if (job.verdict === 'FAIL') {
      alerts.push({ type: 'job_fail', id: job.id, title: job.title, detail: job.statusNote })
    }
  }
  for (const item of status?.data?.missing ?? []) {
    alerts.push({ type: 'missing', id: item.item, title: item.item, detail: item.why })
  }
  return alerts
}

const alertTone: Record<OverviewAlert['type'], string> = {
  task_blocked: 'bg-[#FFF4E5] text-apple-amber ring-[#F5DFC0]',
  job_fail: 'bg-[#FCEDEB] text-[#B3261E] ring-[#F3D3CF]',
  missing: 'bg-[#F0F0F2] text-apple-subtextAlt ring-[#E2E2E6]'
}

const alertLabel: Record<OverviewAlert['type'], string> = {
  task_blocked: '阻塞',
  job_fail: '判定未过',
  missing: '缺料'
}

function gateTone(gate: string): string {
  if (gate.includes('FAIL')) return 'bg-[#FCEDEB] text-[#B3261E] ring-[#F3D3CF]'
  if (gate.includes('PASS')) return 'bg-[#EAF8EE] text-[#1E7A3C] ring-[#CDEED6]'
  return 'bg-[#F0F0F2] text-apple-subtextAlt ring-[#E2E2E6]'
}

const KPI_TONE = {
  blue: { tile: 'bg-[#EAF2FF] text-[#0A6CD8]', ring: 'ring-[#D8E6FE]', accent: '#0071E3' },
  purple: { tile: 'bg-[#F3EEFD] text-[#6D48BF]', ring: 'ring-[#E6DCF8]', accent: '#5E4AC7' },
  green: { tile: 'bg-[#EAF8EE] text-[#1E7A3C]', ring: 'ring-[#D5EFDC]', accent: '#30A14E' },
  orange: { tile: 'bg-[#FFF3E4] text-[#B25E00]', ring: 'ring-[#F8E2C8]', accent: '#C77700' }
} as const

function KpiCard({
  label,
  icon,
  tone,
  children,
  note
}: {
  label: string
  icon: ReactNode
  tone: keyof typeof KPI_TONE
  children: ReactNode
  note: string
}) {
  const colors = KPI_TONE[tone]
  return (
    <div className="card card-interactive relative flex h-full min-w-0 flex-col overflow-hidden p-4">
      <span aria-hidden="true" className="absolute inset-x-0 top-0 h-[3px]" style={{ backgroundColor: colors.accent }} />
      <div className="flex items-center justify-between gap-2">
        <span className="label">{label}</span>
        <span className={`grid h-9 w-9 place-items-center rounded-[10px] ring-1 ring-inset ${colors.tile} ${colors.ring}`}>
          {icon}
        </span>
      </div>
      <div className="mt-2.5 flex-1">{children}</div>
      <p className="mt-2 truncate text-[11px] leading-4 text-apple-subtext" title={note}>
        {note}
      </p>
    </div>
  )
}

export function DashboardPage() {
  const overview = useJson<OverviewResponse>('/api/overview')
  const plan = useJson<PlanResponse>('/api/plan')
  const jobs = useJson<JobsResponse>('/api/jobs')
  const status = useJson<StatusResponse>('/api/status')
  const deliveriesRes = useJson<DeliveriesResponse>('/api/deliveries')
  const system = useSystem()
  const [visibleDeliveries, setVisibleDeliveries] = useState(DELIVERIES_PAGE)

  const sys: SystemSnapshot | null = system.data
  const comfyUrl = sys?.configuredUrl ?? null
  const comfyState: 'online' | 'unreachable' | 'unconfigured' =
    sys && comfyUrl ? (sys.online ? 'online' : 'unreachable') : 'unconfigured'
  const comfyLabel =
    system.status === 'loading'
      ? '读取中'
      : system.status === 'error'
        ? '无数据'
        : comfyState === 'online'
          ? '在线'
          : comfyState === 'unreachable'
            ? '不可达'
            : '未配置'
  const comfyError = sys?.error ?? null
  // 只有连接被拒/超时才提示监听配置；HTTP 5xx 等其它错误不给这条建议。
  const comfyHint =
    comfyState === 'unreachable' &&
    comfyError != null &&
    /ECONNREFUSED|timeout|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH/i.test(comfyError)
  const tasks = plan.data?.data?.tasks ?? []
  const counts = overview.data?.counts.tasks ?? {
    done: tasks.filter((t) => t.status === 'done').length,
    running: tasks.filter((t) => t.status === 'running').length,
    pending: tasks.filter((t) => t.status === 'pending').length,
    blocked: tasks.filter((t) => t.status === 'blocked').length,
    total: tasks.length
  }
  const alerts = overview.data?.alerts ?? deriveAlerts(plan.data, jobs.data, status.data)
  const alertCount = (type: OverviewAlert['type']) => alerts.filter((a) => a.type === type).length

  const deliveries: Delivery[] =
    deliveriesRes.data?.deliveries?.length
      ? deliveriesRes.data.deliveries
      : (jobs.data?.jobs ?? [])
          .filter((job) => job.media.output)
          .map((job) => ({
            jobId: job.id,
            title: job.title,
            durationS: job.durationS,
            width: job.width,
            height: job.height,
            mp4: job.media.output as string,
            poster: job.media.poster,
            report: null,
            score: job.judged ? Math.round((job.passed / job.judged) * 100) / 100 : null,
            gate: job.statusLabel,
            createdAt: null
          }))

  const eta = plan.data?.data?.eta
  const updatedAt = plan.data?.updatedAt ?? status.data?.updatedAt ?? null
  const allJobs = jobs.data?.jobs ?? []
  const shownJobs = allJobs.slice(0, 2)
  const shownDeliveries = deliveries.slice(0, visibleDeliveries)

  const refreshAll = () => {
    overview.retry()
    plan.retry()
    jobs.retry()
    status.retry()
    deliveriesRes.retry()
  }

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-page">工作台总览</h1>
          <p className="mt-2 max-w-[76ch] text-subtitle text-apple-subtext">
            全部任务、预计完成时间与真实产物，一屏看全。
            {eta?.current_phase && <> 当前阶段 <span className="text-apple-text">{eta.current_phase}</span>。</>}
            {eta?.best_case_days != null && eta?.worst_case_days != null && (
              <> 预估 {eta.best_case_days}–{eta.worst_case_days} 天（基准 {eta.base_case_days} 天）。</>
            )}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="num text-[11px] text-apple-subtext">更新 {stamp(updatedAt)}</span>
          <button
            type="button"
            onClick={refreshAll}
            className="press flex h-8 items-center gap-1.5 rounded-lg border border-black/[0.07] bg-white/85 px-2.5 text-xs font-medium shadow-soft transition-colors hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
          >
            <Refresh className="h-3.5 w-3.5" />
            刷新
          </button>
        </div>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4" data-equal-grid data-stagger>
        <KpiCard
          label="Metal VRAM"
          tone="blue"
          icon={<Cpu className="h-4 w-4" />}
          note={
            sys?.vram
              ? '来源 /api/system · 实时'
              : system.status === 'error'
                ? '状态接口不可用'
                : system.status === 'loading'
                  ? '读取中…'
                  : '回退 /api/health · VRAM 无数据'
          }
        >
          {sys?.vram && (sys.vram.used != null || sys.vram.free != null) ? (
            <>
              <p className="flex items-baseline gap-1.5">
                <span className="num text-kpi">{gb(sys.vram.used)}</span>
                <span className="text-xs text-apple-subtext">/ {gb(sys.vram.total)} GB 已用</span>
              </p>
              <p className="num mt-1.5 text-xs text-apple-subtext">{gb(sys.vram.free)} GB 空闲</p>
            </>
          ) : (
            <>
              <p className="text-[20px] font-semibold leading-none tracking-tight text-apple-subtext">无数据</p>
              <p className="mt-1.5 text-xs text-apple-subtext">
                {system.status === 'ready'
                  ? `ComfyUI ${sys?.online ? '在线' : '离线'} · ${sys?.latencyMs ?? '—'} ms`
                  : system.status === 'error'
                    ? '状态接口不可用'
                    : '读取中…'}
              </p>
            </>
          )}
        </KpiCard>

        <KpiCard
          label="队列"
          tone="purple"
          icon={<span className="num text-[13px]">Q</span>}
          note={sys?.queue ? '来源 /api/system.queue' : '来源 /api/system · 队列无数据'}
        >
          {sys?.queue ? (
            <>
              <p className="flex items-baseline gap-1.5">
                <span className="num text-kpi">{sys.queue.running}</span>
                <span className="text-xs text-apple-subtext">执行中</span>
              </p>
              <p className="num mt-1.5 text-xs text-apple-subtext">{sys.queue.pending} 个待排队</p>
            </>
          ) : (
            <>
              <p className="text-[20px] font-semibold leading-none tracking-tight text-apple-subtext">无数据</p>
              <p className="mt-1.5 text-xs text-apple-subtext">ComfyUI 队列未返回</p>
            </>
          )}
        </KpiCard>

        <KpiCard
          label="任务计数"
          tone="green"
          icon={<span className="num text-[13px]">∑</span>}
          note={overview.data ? '来源 /api/overview' : '来源 /api/plan（组合回退）'}
        >
          <p className="flex items-baseline gap-1.5">
            <span className="num text-kpi">{counts.total}</span>
            <span className="text-xs text-apple-subtext">条全量任务</span>
          </p>
          <p className="num mt-1.5 text-xs text-apple-subtext">
            完成 {counts.done} · 执行 {counts.running} · 待排 {counts.pending} · 阻塞 {counts.blocked}
          </p>
        </KpiCard>

        <KpiCard
          label="主机与入口"
          tone="orange"
          icon={
            <span
              aria-hidden="true"
              className={`h-2.5 w-2.5 rounded-full ${
                comfyState === 'online' ? 'bg-[#30A14E]' : comfyState === 'unreachable' ? 'bg-apple-red' : 'bg-[#C7C7CC]'
              }`}
            />
          }
          note={sys ? `ComfyUI 检查于 ${stamp(sys.checkedAt)}` : system.status === 'error' ? '状态接口不可用' : '读取中…'}
        >
          <div className="min-w-0 space-y-2">
            <div data-health="comfyui" data-state={comfyState} data-url={comfyUrl ?? ''} className="min-w-0">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-apple-subtext">ComfyUI 服务</span>
                <span
                  className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-4 ring-1 ring-inset ${
                    comfyState === 'online'
                      ? 'bg-[#EAF8EE] text-[#1E7A3C] ring-[#CDEED6]'
                      : comfyState === 'unreachable'
                        ? 'bg-[#FCEDEB] text-[#B3261E] ring-[#F3D3CF]'
                        : 'bg-[#F0F0F2] text-apple-subtextAlt ring-[#E2E2E6]'
                  }`}
                >
                  {comfyLabel}
                </span>
              </div>
              <p className="num mt-1 truncate text-[13px] font-medium leading-5 text-apple-text" title={comfyUrl ?? undefined}>
                {hostPort(comfyUrl)}
              </p>
              {comfyState === 'online' && sys?.latencyMs != null && (
                <p className="num mt-0.5 text-[11px] leading-4 text-apple-subtext">延迟 {sys.latencyMs} ms</p>
              )}
              {comfyState === 'unreachable' && comfyError && (
                <p className="mt-0.5 break-words text-[11px] leading-4 text-apple-subtext">错误：{comfyError}</p>
              )}
              {comfyHint && (
                <p className="mt-1 break-words text-[11px] leading-4 text-apple-amber">
                  若 ComfyUI 未对外监听（当前仅 127.0.0.1:8188），容器将无法探测；需以{' '}
                  <span className="num">--listen 0.0.0.0</span> 启动。
                </p>
              )}
            </div>
            <div data-health="web-entry" className="min-w-0 border-t border-black/[0.06] pt-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-apple-subtext">网页入口</span>
                <span className="shrink-0 rounded-full bg-[#F0F0F2] px-1.5 py-0.5 text-[10px] font-medium leading-4 text-apple-subtextAlt ring-1 ring-inset ring-[#E2E2E6]">
                  Tailscale
                </span>
              </div>
              <p className="num mt-1 truncate text-[13px] font-medium leading-5 text-apple-text">studio 100.92.106.101:8088</p>
              <p className="mt-0.5 text-[11px] leading-4 text-apple-subtext">本页即通过它访问，与 ComfyUI 状态无关</p>
            </div>
          </div>
        </KpiCard>
      </div>

      <section aria-label="告警" className="card mt-3 p-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="flex items-center gap-1.5 text-[13px] font-semibold">
            <Alert className="h-4 w-4 text-apple-amber" />
            需要关注
          </span>
          <span className="num rounded-full bg-apple-bg px-2 py-0.5 text-[11px] font-medium text-apple-text">
            {alerts.length} 项
          </span>
          <span className="num text-[11px] text-apple-subtext">
            阻塞 {alertCount('task_blocked')} · 判定未过 {alertCount('job_fail')} · 缺料 {alertCount('missing')}
          </span>
        </div>

        {alerts.length === 0 ? (
          <p className="mt-2 text-xs text-apple-subtext">当前无阻塞任务、无判定未过、无缺料项。</p>
        ) : (
          <details className="mt-2">
            <summary className="w-fit cursor-pointer rounded text-[11px] font-medium text-apple-blue focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50">
              展开明细
            </summary>
            <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
              {alerts.map((item, index) => (
                <li
                  key={`${item.type}-${item.id ?? 'x'}-${index}`}
                  className="flex min-w-0 items-start gap-2 rounded-lg bg-apple-bg/60 px-2.5 py-1.5"
                >
                  <span
                    className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset ${alertTone[item.type]}`}
                  >
                    {alertLabel[item.type]}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-[12px] font-medium" title={item.title}>
                      {item.title}
                    </span>
                    {item.detail && (
                      <span className="block truncate text-[11px] text-apple-subtext" title={item.detail}>
                        {item.detail}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <section className="mt-6" aria-labelledby="flow-title">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 id="flow-title" className="flex items-center gap-2 text-[18px] font-semibold tracking-[-0.014em]">
            <span aria-hidden="true" className="h-4 w-[3px] rounded-full bg-apple-accentBlue" />
            任务流转看板
          </h2>
          <div className="flex items-center gap-3 text-[11px] text-apple-subtext">
            <span className="num">数据 /api/plan · 全量 {tasks.length} 条</span>
            <Link
              to="/status"
              className="inline-flex items-center gap-1 rounded-lg border border-black/[0.08] bg-white px-2.5 py-1 text-[12px] font-medium text-apple-text shadow-hairline transition-colors hover:bg-apple-bg/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
            >
              任务计划
              <ChevronRight className="h-3 w-3 text-apple-subtext" />
            </Link>
          </div>
        </div>
        <TaskFlowBoard tasks={tasks} loading={plan.status === 'loading'} error={plan.error} onRetry={plan.retry} />
      </section>

      <div className="mt-6 grid gap-4 xl:grid-cols-2 xl:items-stretch">
        <section aria-labelledby="jobs-title" className="flex min-w-0 flex-col">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 id="jobs-title" className="flex items-center gap-2 text-section">
              <span aria-hidden="true" className="h-3.5 w-[3px] rounded-full bg-apple-accentBlue" />
              最近任务
            </h2>
            <div className="flex items-center gap-3 text-[11px] text-apple-subtext">
              <span className="num">数据 /api/jobs</span>
              <Link
                to="/jobs"
                className="inline-flex items-center gap-0.5 font-medium text-apple-blueInk focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
              >
                全部任务
                <ChevronRight className="h-3 w-3" />
              </Link>
            </div>
          </div>

          {jobs.status === 'loading' && (
            <div className="card space-y-2 p-3" aria-busy="true" aria-label="正在读取任务">
              {[0, 1, 2, 3].map((index) => (
                <Skeleton key={index} className="h-[76px] w-full" />
              ))}
            </div>
          )}
          {jobs.status === 'error' && (
            <div className="card flex flex-wrap items-center justify-between gap-3 p-5" role="alert">
              <div>
                <p className="text-sm font-medium">任务读取失败</p>
                <p className="mt-1 text-xs text-apple-subtext">{jobs.error}</p>
              </div>
              <button
                type="button"
                onClick={jobs.retry}
                className="rounded-lg bg-apple-text px-3 py-1.5 text-xs font-medium text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
              >
                重试
              </button>
            </div>
          )}
          {jobs.status === 'ready' && jobs.data.jobs.length === 0 && (
            <div className="card p-5 text-sm text-apple-subtext">issue-19 下还没有可展示的任务产物。</div>
          )}
          {jobs.status === 'ready' && allJobs.length > 0 && (
            <div className="grid flex-1 content-start gap-3 sm:grid-cols-2" data-equal-grid data-stagger>
              {shownJobs.map((job) => (
                <LazySection key={job.id} minHeight={286} className="h-full">
                  <article className="card card-interactive flex h-full flex-col overflow-hidden">
                    <div className="aspect-video bg-[#0B0B0C]" data-media-frame>
                      {job.media.poster ? (
                        <img
                          src={job.media.poster}
                          alt=""
                          loading="lazy"
                          decoding="async"
                          className="h-full w-full object-contain"
                        />
                      ) : (
                        <span className="grid h-full w-full place-items-center text-white/40">
                          <Film className="h-5 w-5" />
                        </span>
                      )}
                    </div>
                    <div className="flex flex-1 flex-col p-3 xl:min-h-[132px]">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="num rounded bg-apple-bg px-1.5 py-0.5 text-[11px] font-medium text-apple-subtextAlt">
                          {job.taskId || job.track}
                        </span>
                        <StatusChip status={job.verdict ?? 'UNKNOWN'} label={job.statusLabel} />
                      </div>
                      <h3
                        className="mt-1.5 line-clamp-1 text-[13px] font-medium tracking-tight"
                        title={`${jobReadable(job)}（任务 ID ${job.id}）`}
                      >
                        {jobReadable(job)}
                      </h3>
                      <p className="num mt-0.5 text-[11px] text-apple-subtext">
                        {formatDuration(job.durationS)} · {formatResolution(job.width, job.height)} ·{' '}
                        {job.fps ? `${job.fps}fps` : '无数据'} · {job.frames ?? '—'} 帧
                      </p>
                      <p className="num mt-0.5 text-[11px] text-apple-subtext">
                        {job.passed}/{job.judged} 判据通过
                        {job.verdict === 'CONDITIONAL' ? ` · ${job.total - job.judged} 项仅报数` : ''}
                      </p>
                      <div className="mt-auto flex items-center justify-between gap-2 pt-1.5">
                        <span className="num truncate text-[11px] text-apple-subtext" title={job.id}>
                          {job.id}
                        </span>
                        <Link
                          to={`/job/${job.id}`}
                          className="shrink-0 text-[11px] font-medium text-apple-blue focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
                        >
                          任务详情 →
                        </Link>
                      </div>
                    </div>
                  </article>
                </LazySection>
              ))}
            </div>
          )}
        </section>

        <section aria-labelledby="deliveries-title" className="flex min-w-0 flex-col">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 id="deliveries-title" className="flex items-center gap-2 text-section">
              <span aria-hidden="true" className="h-3.5 w-[3px] rounded-full bg-apple-statusDone" />
              最新交付
            </h2>
            <div className="flex items-center gap-3 text-[11px] text-apple-subtext">
              <span className="num">数据 /api/deliveries · 成片 /media/out</span>
              <Link
                to="/deliveries"
                className="inline-flex items-center gap-0.5 font-medium text-apple-blueInk focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
              >
                全部资产
                <ChevronRight className="h-3 w-3" />
              </Link>
            </div>
          </div>

          {deliveriesRes.status === 'loading' && (
            <div className="grid gap-3 sm:grid-cols-2" aria-busy="true" aria-label="正在读取交付">
              {[0, 1].map((index) => (
                <Skeleton key={index} className="h-[286px] w-full" />
              ))}
            </div>
          )}
          {deliveries.length === 0 && deliveriesRes.status !== 'loading' && (
            <div className="card p-5">
              <p className="text-sm font-medium">暂无交付产物</p>
              <p className="mt-1 text-xs text-apple-subtext">
                {deliveriesRes.status === 'error'
                  ? '交付接口不可用，且 /api/jobs 中没有可播放成片。'
                  : '/media/out 下还没有 mp4 成片。'}
              </p>
            </div>
          )}
          {deliveries.length > 0 && (
            <>
              <div className="grid flex-1 content-start gap-3 sm:grid-cols-2" data-equal-grid data-stagger>
                {shownDeliveries.map((item) => (
                  <LazySection key={item.jobId} minHeight={286} className="h-full">
                    <article className="card card-interactive flex h-full flex-col overflow-hidden">
                      <div className="aspect-video bg-[#0B0B0C]" data-media-frame>
                        <LazyVideo
                          src={item.mp4}
                          poster={item.poster}
                          ariaLabel={`${item.title} 交付成片`}
                        />
                      </div>
                      <div className="flex flex-1 flex-col p-3 xl:min-h-[132px]">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`rounded px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset ${gateTone(item.gate)}`}
                          >
                            {item.gate}
                          </span>
                        </div>
                        <h3
                          className="mt-1.5 line-clamp-1 text-[13px] font-medium tracking-tight"
                          title={`${item.title}（任务 ID ${item.jobId}）`}
                        >
                          {item.title}
                        </h3>
                        <p className="num mt-0.5 text-[11px] text-apple-subtext">
                          {formatDuration(item.durationS)} · {formatResolution(item.width, item.height)} ·{' '}
                          {item.score != null ? `通过率 ${Math.round(item.score * 100)}%` : '通过率 无数据'}
                        </p>
                        <p className="num mt-0.5 text-[11px] text-apple-subtext">
                          {item.createdAt ? stamp(item.createdAt) : '时间 无数据'}
                        </p>
                        <div className="mt-auto flex items-center justify-between gap-2 pt-1.5">
                          <span className="num truncate text-[11px] text-apple-subtext" title={item.jobId}>
                            {item.jobId}
                          </span>
                          <Link
                            to={`/job/${item.jobId}`}
                            className="shrink-0 text-[11px] font-medium text-apple-blue focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
                          >
                            任务详情 →
                          </Link>
                        </div>
                      </div>
                    </article>
                  </LazySection>
                ))}
              </div>
              <LoadMore
                remaining={deliveries.length - shownDeliveries.length}
                onClick={() => setVisibleDeliveries((value) => value + DELIVERIES_PAGE)}
                unit="个成片"
                className="mt-2.5"
              />
            </>
          )}
        </section>
      </div>
    </div>
  )
}
