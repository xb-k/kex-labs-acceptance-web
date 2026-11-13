import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  JobsResponse,
  Milestone,
  MilestoneRail,
  MissingItem,
  PlanResponse,
  PlanStatus,
  PlanTask,
  StatusResponse,
  StatusSources
} from '../types'
import { patchJson, useJson } from '../api'
import { PlanGantt } from '../components/PlanGantt'
import { PlanSummary, PlanTable } from '../components/PlanTasks'

/** #105：页面可见时每 30s 静默刷新计划（Gitea 任务）。 */
const AUTO_REFRESH_MS = 30_000

type Tone = { text: string; bg: string; ring: string; dot: string }

const milestoneTones: Record<string, Tone> = {
  done: { text: 'text-[#1E7A3C]', bg: 'bg-[#EAF8EE]', ring: 'ring-[#CDEED6]', dot: 'bg-apple-green' },
  in_progress: { text: 'text-apple-blueInk', bg: 'bg-[#F0F6FF]', ring: 'ring-[#D6E6FF]', dot: 'bg-apple-blue' },
  pending: { text: 'text-apple-subtextAlt', bg: 'bg-[#F0F0F2]', ring: 'ring-[#E2E2E6]', dot: 'bg-[#C7C7CC]' }
}

const milestoneLabels: Record<string, string> = {
  done: '已完成',
  in_progress: '进行中',
  pending: '未开始'
}

const railTones: Record<string, Tone> = {
  conditional_pass: { text: 'text-apple-amber', bg: 'bg-[#FFF4E5]', ring: 'ring-[#F5DFC0]', dot: 'bg-[#C77700]' },
  pass: { text: 'text-[#1E7A3C]', bg: 'bg-[#EAF8EE]', ring: 'ring-[#CDEED6]', dot: 'bg-apple-green' },
  blocked: { text: 'text-[#B3261E]', bg: 'bg-[#FCEDEB]', ring: 'ring-[#F3D3CF]', dot: 'bg-apple-red' },
  pending: { text: 'text-apple-subtextAlt', bg: 'bg-[#F0F0F2]', ring: 'ring-[#E2E2E6]', dot: 'bg-[#C7C7CC]' }
}

const railLabels: Record<string, string> = {
  conditional_pass: '有条件通过',
  pass: '通过',
  blocked: '阻塞',
  pending: '未开始'
}

const groupOrder = ['用户', '下载', '未派', '未验证', '其他'] as const

type GroupKey = (typeof groupOrder)[number]

const groupTones: Record<GroupKey, Tone> = {
  用户: { text: 'text-apple-amber', bg: 'bg-[#FFF4E5]', ring: 'ring-[#F5DFC0]', dot: 'bg-[#C77700]' },
  下载: { text: 'text-apple-blueInk', bg: 'bg-[#F0F6FF]', ring: 'ring-[#D6E6FF]', dot: 'bg-apple-blue' },
  未派: { text: 'text-[#B3261E]', bg: 'bg-[#FCEDEB]', ring: 'ring-[#F3D3CF]', dot: 'bg-apple-red' },
  未验证: { text: 'text-apple-subtextAlt', bg: 'bg-[#F0F0F2]', ring: 'ring-[#E2E2E6]', dot: 'bg-[#C7C7CC]' },
  其他: { text: 'text-apple-subtextAlt', bg: 'bg-[#F0F0F2]', ring: 'ring-[#E2E2E6]', dot: 'bg-[#C7C7CC]' }
}

/** blocked_by 是自由文本，归一成需求里的四类（+ 兜底「其他」）。 */
function groupOf(blockedBy: string): GroupKey {
  if (blockedBy.includes('未验证')) return '未验证'
  if (blockedBy.includes('未派') || /^T-[A-Z]+-\d+/.test(blockedBy)) return '未派'
  if (blockedBy.includes('下载') || blockedBy.includes('q8') || blockedBy.includes('gemma')) return '下载'
  if (blockedBy.includes('用户') || blockedBy.includes('人工')) return '用户'
  return '其他'
}

function formatClock(value: string | null | undefined): string {
  if (!value) return '未知'
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return '未知'
  return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false })
}

/** #105：来源条 —— 数据从哪来、什么时候拉的、手动刷新入口。 */
function SourceBar({ plan, onRefresh }: { plan: PlanResponse | null; onRefresh: () => void }) {
  const meta = plan?.meta
  const tasksSource = meta?.tasksSource
  const failed = Boolean(meta?.error)
  const label = tasksSource === 'gitea' ? '来源 Gitea' : tasksSource === 'files' ? '来源 文件' : '来源 读取中'
  const fetchedAt = meta?.fetchedAt ?? (plan?.updatedAt ?? null)
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2" data-plan-source={tasksSource ?? 'unknown'}>
      <span
        className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${
          failed
            ? 'bg-[#FFF4E5] text-apple-amber ring-[#F5DFC0]'
            : 'bg-[#F0F6FF] text-apple-blueInk ring-[#D6E6FF]'
        }`}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${failed ? 'bg-[#C77700]' : 'bg-apple-blue'}`} aria-hidden="true" />
        {failed ? '来源 Gitea · 不可达' : label}
      </span>
      <span className="text-xs text-apple-subtext">
        更新于 <span className="num" data-plan-fetched-at>{formatClock(fetchedAt)}</span>
      </span>
      <button
        type="button"
        onClick={onRefresh}
        className="rounded-lg border border-apple-line bg-white px-2.5 py-1 text-xs font-medium text-apple-text transition-colors hover:bg-[#FAFAFB] focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
      >
        刷新
      </button>
      <span className="text-[11px] text-apple-subtext">可见时每 30s 自动刷新</span>
      {failed && <span className="w-full text-xs text-apple-amber">Gitea 不可达：{meta?.error}</span>}
    </div>
  )
}

function formatUpdated(value: string | null): string {
  if (!value) return '未知'
  return value.slice(0, 16).replace('T', ' ')
}

function formatAgo(value: string | null): string {
  if (!value) return '未知'
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return '未知'
  const minutes = Math.max(0, Math.floor((Date.now() - ms) / 60000))
  return `${minutes} 分钟前`
}

function latestTimestamp(values: (string | null)[]): string | null {
  let best: string | null = null
  let bestMs = Number.NEGATIVE_INFINITY
  for (const value of values) {
    if (!value) continue
    const ms = Date.parse(value)
    if (Number.isFinite(ms) && ms > bestMs) {
      bestMs = ms
      best = value
    }
  }
  return best
}

function Datum({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="inline-flex min-w-0 flex-wrap items-baseline gap-x-1">
      <span className="label shrink-0">{label}</span>
      {children}
    </span>
  )
}

function DataConsistency({ sources }: { sources: StatusSources }) {
  const { issues, tasks, opencode, snapshot } = sources
  const lastActivity = latestTimestamp([opencode.taskMdUpdatedAt, opencode.subagentUpdatedAt])
  return (
    <section aria-label="数据一致性" className="mt-5">
      <div className="card p-3.5">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <span className="shrink-0 text-xs font-semibold">数据一致性</span>
          <Datum label="Gitea">
            <span data-src-datum="issues-open" className="num text-sm font-semibold">
              {issues.open ?? '—'}
            </span>
            <span className="text-xs text-apple-subtext">开 /</span>
            <span data-src-datum="issues-closed" className="num text-sm font-semibold">
              {issues.closed ?? '—'}
            </span>
            <span className="text-xs text-apple-subtext">关 /</span>
            <span data-src-datum="issues-total" className="num text-sm font-semibold">
              {issues.total ?? '—'}
            </span>
            <span className="text-xs text-apple-subtext">总</span>
          </Datum>
          <Datum label="任务">
            <span data-src-datum="tasks-total" className="num text-sm font-semibold">
              {tasks.total}
            </span>
            <span className="text-xs text-apple-subtext">
              总 · 完成 {tasks.done} / 进行 {tasks.running} / 待办 {tasks.pending} / 阻塞 {tasks.blocked}
            </span>
          </Datum>
          <Datum label="opencode">
            <span data-src-datum="opencode-activity" className="num text-sm font-semibold">
              {formatAgo(lastActivity)}
            </span>
            <span className="text-xs text-apple-subtext">运行 {opencode.runningCount}</span>
          </Datum>
          <Datum label="快照">
            <span data-src-datum="snapshot-updated" className="num text-sm font-semibold">
              {formatUpdated(snapshot.updatedAt)}
            </span>
          </Datum>
        </div>
        {snapshot.stale && (
          <p className="mt-3 rounded-lg bg-[#FFF4E5] px-3 py-2 text-xs font-medium text-apple-amber ring-1 ring-inset ring-[#F5DFC0]">
            快照超过 24h 未更新
          </p>
        )}
      </div>
    </section>
  )
}

function Chip({ tone, label }: { tone: Tone; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${tone.bg} ${tone.text} ${tone.ring}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} aria-hidden="true" />
      {label}
    </span>
  )
}

function Section({ id, title, hint, children }: { id: string; title: string; hint?: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="mt-8 first:mt-0">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id={id} className="text-[15px] font-semibold tracking-tight">
          {title}
        </h2>
        {hint && <p className="text-xs text-apple-subtext">{hint}</p>}
      </div>
      {children}
    </section>
  )
}

function MilestoneCard({ milestone }: { milestone: Milestone }) {
  const tone = milestoneTones[milestone.state] ?? milestoneTones.pending
  return (
    <div className="rounded-card border border-apple-line bg-white p-4 shadow-card">
      <div className="flex items-center justify-between gap-2">
        <span className="num text-xs font-medium text-apple-subtext">{milestone.id}</span>
        <Chip tone={tone} label={milestoneLabels[milestone.state] ?? milestone.state} />
      </div>
      <h3 className="mt-1.5 text-sm font-semibold leading-snug">{milestone.name}</h3>
      {milestone.detail && <p className="mt-1.5 text-xs leading-relaxed text-apple-subtext">{milestone.detail}</p>}
      {milestone.rails && milestone.rails.length > 0 && (
        <ul className="mt-3 space-y-2 border-t border-apple-line pt-3">
          {milestone.rails.map((rail: MilestoneRail) => {
            const railTone = railTones[rail.state] ?? railTones.pending
            return (
              <li key={rail.rail}>
                <div className="flex items-center gap-2">
                  <span className="num text-xs font-medium text-apple-subtext">{rail.rail} 轨</span>
                  <Chip tone={railTone} label={railLabels[rail.state] ?? rail.state} />
                </div>
                <p className="mt-1 text-xs leading-relaxed text-apple-subtext">{rail.detail}</p>
                {rail.blocked_by && rail.blocked_by.length > 0 && (
                  <p className="mt-0.5 text-xs text-apple-subtext">
                    受阻：<span className="num">{rail.blocked_by.join(' / ')}</span>
                  </p>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function MissingRow({ item }: { item: MissingItem }) {
  return (
    <li className="rounded-xl border border-apple-line bg-white p-3.5">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <p className="text-sm font-medium leading-snug">{item.item}</p>
        <span className="num rounded-md bg-[#F5F5F7] px-1.5 py-0.5 text-xs text-apple-subtext">{item.blocked_by}</span>
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-apple-subtext">{item.why}</p>
      <p className="mt-1.5 text-xs leading-relaxed">
        <span className="label mr-1">影响</span>
        {item.impact}
      </p>
    </li>
  )
}

function NoStatus({ path }: { path: string }) {
  return (
    <div className="card mt-6 p-6" role="status">
      <h2 className="text-base font-semibold">无状态文件</h2>
      <p className="mt-2 text-sm leading-relaxed text-apple-subtext">
        没有读到项目状态 JSON，页面不显示任何推测数据。把文件放到下面的路径后刷新即可。
      </p>
      <p className="num mt-3 break-all rounded-lg bg-[#F5F5F7] px-3 py-2 text-xs text-apple-subtext">{path}</p>
    </div>
  )
}

function NoPlan({ path }: { path: string }) {
  return (
    <div className="card p-6" role="status">
      <h2 className="text-base font-semibold">无任务计划文件</h2>
      <p className="mt-2 text-sm leading-relaxed text-apple-subtext">
        没有读到任务计划 JSON，不绘制甘特图、也不推测任务时间。把文件放到下面的路径后刷新即可。
      </p>
      <p className="num mt-3 break-all rounded-lg bg-[#F5F5F7] px-3 py-2 text-xs text-apple-subtext">{path}</p>
    </div>
  )
}

export function StatusPage() {
  const { status, data, error, retry } = useJson<StatusResponse>('/api/status')
  const planQuery = useJson<PlanResponse>('/api/plan')
  const jobsQuery = useJson<JobsResponse>('/api/jobs')

  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<number | null>(null)
  const showToast = useCallback((text: string) => {
    setToast(text)
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 4000)
  }, [])
  useEffect(() => () => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
  }, [])

  const refreshAll = useCallback(() => {
    planQuery.refresh()
    jobsQuery.refresh()
  }, [planQuery.refresh, jobsQuery.refresh])

  // 可见时每 30s 自动刷新；隐藏时暂停，切回前台立刻补一次。
  useEffect(() => {
    let timer: number | null = null
    const start = () => {
      if (timer === null) timer = window.setInterval(refreshAll, AUTO_REFRESH_MS)
    }
    const stop = () => {
      if (timer !== null) {
        window.clearInterval(timer)
        timer = null
      }
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        refreshAll()
        start()
      } else {
        stop()
      }
    }
    if (document.visibilityState === 'visible') start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [refreshAll])

  const handleStatusChange = useCallback(
    async (task: PlanTask, next: PlanStatus) => {
      await patchJson(`/api/tasks/${encodeURIComponent(task.id)}`, { status: next })
      // 回读：以服务端返回为准，成功后静默刷新计划。
      planQuery.refresh()
    },
    [planQuery.refresh]
  )

  if (status === 'loading') {
    return (
      <div aria-busy="true" aria-label="正在读取项目状态">
        <div className="h-8 w-40 animate-pulse rounded-md bg-[#E9E9EC]" />
        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="h-28 animate-pulse rounded-card bg-[#EDEDF0]" />
          ))}
        </div>
        <div className="mt-4 h-40 animate-pulse rounded-card bg-[#EDEDF0]" />
      </div>
    )
  }

  if (status === 'error' || !data) {
    return (
      <div>
        <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em]">项目状态</h1>
        <div className="card mt-5 p-6" role="alert">
          <h2 className="text-base font-semibold">状态读取失败</h2>
          <p className="mt-2 text-sm text-apple-subtext">{error ?? '响应为空'}</p>
          <button
            type="button"
            onClick={retry}
            className="mt-4 rounded-lg bg-apple-text px-3 py-1.5 text-xs font-medium text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
          >
            重试
          </button>
        </div>
      </div>
    )
  }

  const project = data.data

  if (!data.exists || !project) {
    return (
      <div>
        <header>
          <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em] sm:text-[34px]">项目状态</h1>
          <p className="mt-2 max-w-[62ch] text-sm leading-relaxed text-apple-subtext">
            当前还缺什么、正在做什么。没有读到状态文件时不显示推测数据。
          </p>
        </header>
        <NoStatus path={data.path} />
      </div>
    )
  }

  const grouped = groupOrder.map((key) => ({
    key,
    items: project.missing.filter((item) => groupOf(item.blocked_by) === key)
  }))
  const activeGroups = grouped.filter((group) => group.items.length > 0)
  const verdictA = typeof project.verdict_rules.A === 'string' ? project.verdict_rules.A : null
  const verdictB = typeof project.verdict_rules.B === 'string' ? project.verdict_rules.B : null
  const verdictStates = Array.isArray(project.verdict_rules.states)
    ? (project.verdict_rules.states as string[])
    : []

  const planReady = planQuery.status === 'ready' ? planQuery.data : null
  const planData = planReady?.exists ? planReady.data : null
  const planTasks = planData && Array.isArray(planData.tasks) ? planData.tasks : []
  const planMilestones = planData && Array.isArray(planData.milestones) ? planData.milestones : []

  return (
    <div>
      <header>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em] sm:text-[34px]">项目状态</h1>
            <p className="mt-2 max-w-[62ch] text-sm leading-relaxed text-apple-subtext">
              当前还缺什么、正在做什么。任务直接来自 Gitea，状态可在此修改。
            </p>
            <p className="mt-1 text-xs text-apple-subtext">
              状态更新于 <span className="num">{formatUpdated(project.updated_at)}</span>
              {project.updated_by && <> · {project.updated_by}</>}
            </p>
          </div>
          <SourceBar plan={planReady} onRefresh={refreshAll} />
        </div>
      </header>

      {data.sources && <DataConsistency sources={data.sources} />}

      {planQuery.status === 'loading' && (
        <Section id="plan" title="计划概览" hint="读取任务计划">
          <div aria-busy="true" aria-label="正在读取任务计划">
            <div className="h-32 animate-pulse rounded-card bg-[#EDEDF0]" />
            <div className="mt-4 h-64 animate-pulse rounded-card bg-[#EDEDF0]" />
          </div>
        </Section>
      )}

      {planQuery.status === 'error' && (
        <Section id="plan" title="计划概览" hint="读取任务计划">
          <div className="card p-6" role="alert">
            <h2 className="text-base font-semibold">计划读取失败</h2>
            <p className="mt-2 text-sm text-apple-subtext">{planQuery.error}</p>
            <button
              type="button"
              onClick={planQuery.retry}
              className="mt-4 rounded-lg bg-apple-text px-3 py-1.5 text-xs font-medium text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
            >
              重试
            </button>
          </div>
        </Section>
      )}

      {planReady && !planReady.exists && (
        <Section id="plan" title="计划概览">
          <NoPlan path={planReady.path} />
        </Section>
      )}

      {planData && (
        <>
          <Section id="plan" title="计划概览" hint="全部任务、时间跨度与预计完成，任务来自 Gitea">
            <PlanSummary data={planData} />
          </Section>

          <Section id="gantt" title="甘特图" hint="条为开始 → 预计完成；虚线为里程碑，实线为今天">
            <PlanGantt tasks={planTasks} milestones={planMilestones} />
          </Section>

          <Section id="tasks" title="全部任务" hint={`${planTasks.length} 项，按开始时间排序`}>
            <PlanTable
              tasks={planTasks}
              jobs={jobsQuery.data?.jobs ?? []}
              jobsReady={jobsQuery.status === 'ready'}
              onStatusChange={handleStatusChange}
              onError={showToast}
            />
          </Section>
        </>
      )}

      <Section id="milestones" title="里程碑" hint="进度条按阶段顺序，卡片为当前证据">
        <div className="flex gap-1" aria-hidden="true">
          {project.milestones.map((milestone) => {
            const tone = milestoneTones[milestone.state] ?? milestoneTones.pending
            return <span key={milestone.id} className={`h-1.5 flex-1 rounded-full ${tone.dot}`} />
          })}
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-equal-grid>
          {project.milestones.map((milestone) => (
            <MilestoneCard key={milestone.id} milestone={milestone} />
          ))}
        </div>
      </Section>

      <Section id="now" title="正在做什么" hint={`${project.now.length} 项在途`}>
        <div>
          <ul className="space-y-2">
            {project.now.map((item) => (
              <li key={item.task} className="flex items-start justify-between gap-4 rounded-xl border border-apple-line bg-white p-3.5">
                <div className="min-w-0">
                  <p className="text-sm font-medium leading-snug">{item.task}</p>
                  <p className="mt-1 text-xs leading-relaxed text-apple-subtext">{item.detail}</p>
                </div>
                <span className="num shrink-0 rounded-md bg-[#F0F6FF] px-1.5 py-0.5 text-xs font-medium text-apple-blueInk">
                  {item.owner}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </Section>

      <Section id="missing" title="还缺什么" hint={`${project.missing.length} 项，按受阻来源分组`}>
        {activeGroups.length === 0 ? (
          <div className="card p-5 text-sm text-apple-subtext">没有阻塞项。</div>
        ) : (
          <div className="space-y-6">
            {activeGroups.map((group) => {
              const tone = groupTones[group.key]
              return (
                <div key={group.key}>
                  <div className="mb-2 flex items-center gap-2">
                    <h3 className="text-sm font-semibold">{group.key}</h3>
                    <span className="num text-xs text-apple-subtext">{group.items.length} 项</span>
                    <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} aria-hidden="true" />
                  </div>
                  <ul className="grid gap-2 sm:grid-cols-2">
                    {group.items.map((item) => (
                      <MissingRow key={`${group.key}-${item.item}`} item={item} />
                    ))}
                  </ul>
                </div>
              )
            })}
          </div>
        )}
      </Section>

      {(verdictA || verdictB) && (
        <Section id="verdict" title="判定口径" hint="只展示，不在这里改">
          <div className="card p-5">
            <dl className="space-y-3">
              {verdictA && (
                <div>
                  <dt className="label">A 轨</dt>
                  <dd className="mt-1 text-xs leading-relaxed">{verdictA}</dd>
                </div>
              )}
              {verdictB && (
                <div>
                  <dt className="label">B 轨</dt>
                  <dd className="mt-1 text-xs leading-relaxed">{verdictB}</dd>
                </div>
              )}
            </dl>
            {verdictStates.length > 0 && (
              <div className="mt-4 flex flex-wrap items-center gap-1.5">
                <span className="label mr-1">状态</span>
                {verdictStates.map((state) => (
                  <span key={state} className="num rounded-md bg-[#F5F5F7] px-1.5 py-0.5 text-xs text-apple-subtext">
                    {state}
                  </span>
                ))}
              </div>
            )}
          </div>
        </Section>
      )}

      <p className="mt-8 text-[11px] leading-relaxed text-apple-subtext">
        状态文件 <span className="num break-all">{data.path}</span>
        {planReady && <> · 计划基线 <span className="num break-all">{planReady.path}</span></>}
      </p>

      {toast && (
        <div
          role="alert"
          aria-live="assertive"
          data-testid="status-toast"
          className="fixed bottom-5 left-1/2 z-[70] flex max-w-[calc(100vw-32px)] -translate-x-1/2 items-center gap-2 rounded-full bg-apple-text px-3.5 py-2 text-[13px] font-medium text-white shadow-lift"
        >
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-apple-red" aria-hidden="true" />
          <span className="min-w-0">{toast}</span>
        </div>
      )}
    </div>
  )
}
