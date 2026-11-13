import { useEffect, useMemo, useState } from 'react'
import type { Job, PlanData, PlanStatus, PlanTask } from '../types'
import { HttpError } from '../api'
import { Link } from '../router'
import {
  DAY_MS,
  fmtDateTime,
  fmtDuration,
  fmtSpan,
  localDayStart,
  parseTs,
  planStatusTone,
  railLabel
} from '../plan'

type FilterKey = 'all' | PlanStatus

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'running', label: '进行中' },
  { key: 'blocked', label: '阻塞' },
  { key: 'pending', label: '未开始' },
  { key: 'done', label: '已完成' }
]

function countByStatus(tasks: PlanTask[]): Record<PlanStatus, number> {
  const counts: Record<PlanStatus, number> = { done: 0, running: 0, in_progress: 0, blocked: 0, pending: 0 }
  // 未知状态不计数，也不能把 counts 写成 NaN。
  for (const task of tasks) {
    const key = task.status as PlanStatus
    if (counts[key] !== undefined) counts[key] += 1
  }
  return counts
}

/** in_progress 与 running 同义；「进行中」筛选/统计一并包含。 */
function isRunning(task: PlanTask): boolean {
  return task.status === 'running' || task.status === 'in_progress'
}

function matchesFilter(task: PlanTask, filter: FilterKey): boolean {
  if (filter === 'all') return true
  if (filter === 'running') return isRunning(task)
  return task.status === filter
}

/** #105：状态编辑只暴露 Gitea 任务的四个值（in_progress 归入 running）。 */
const EDIT_OPTIONS: { value: PlanStatus; label: string }[] = [
  { value: 'pending', label: '待办' },
  { value: 'running', label: '进行中' },
  { value: 'blocked', label: '阻塞' },
  { value: 'done', label: '完成' }
]

function editableStatus(status: PlanStatus): PlanStatus {
  return status === 'in_progress' ? 'running' : status
}

function writeErrorMessage(err: unknown): string {
  if (err instanceof HttpError) {
    if (err.status === 401) return '写入校验失败（401）：X-Web-Token 无效'
    if (err.status === 403) return '跨源请求被拒绝（403）：请从本站页面操作'
    if (err.status === 503) return '写入未启用（503）：服务端未配置 WEB_WRITE_TOKEN'
    return `更新失败（${err.status}）：${err.message}`
  }
  return `更新失败：${err instanceof Error ? err.message : '网络错误'}`
}

export function PlanSummary({ data }: { data: PlanData }) {
  const tasks = data.tasks ?? []
  const counts = countByStatus(tasks)
  const timestamps = tasks.flatMap((task) => [parseTs(task.start), parseTs(task.end)])
  const valid = timestamps.filter((ts): ts is number => ts !== null)
  const spanStart = valid.length > 0 ? Math.min(...valid) : null
  const spanEnd = valid.length > 0 ? Math.max(...valid) : null
  const spanDays =
    spanStart !== null && spanEnd !== null
      ? Math.round((localDayStart(spanEnd) + DAY_MS - localDayStart(spanStart)) / DAY_MS)
      : null
  const eta = data.eta

  return (
    <div className="card p-5">
      <div className="grid items-stretch gap-3 sm:grid-cols-2 lg:grid-cols-4" data-summary-grid>
        <div className="flex h-full flex-col" data-summary-card>
          <p className="label">任务总数</p>
          <p className="num mt-1 text-[26px] font-semibold leading-none tracking-tight">{tasks.length}</p>
          <ul className="mt-2.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-apple-subtext">
            <li className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-[#C7C7CC]" aria-hidden="true" />
              已完成 <span className="num font-medium text-apple-text">{counts.done}</span>
            </li>
            <li className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-apple-blue" aria-hidden="true" />
              进行中 <span className="num font-medium text-apple-text">{counts.running + counts.in_progress}</span>
            </li>
            <li className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-[#DDA45C]" aria-hidden="true" />
              阻塞 <span className="num font-medium text-apple-text">{counts.blocked}</span>
            </li>
            <li className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-[#A9CBF3]" aria-hidden="true" />
              未开始 <span className="num font-medium text-apple-text">{counts.pending}</span>
            </li>
          </ul>
        </div>

        <div className="flex h-full flex-col" data-summary-card>
          <p className="label">计划跨度</p>
          {spanStart !== null && spanEnd !== null ? (
            <>
              <p className="num mt-1 text-sm font-semibold leading-snug">
                {fmtDateTime(spanStart)} → {fmtDateTime(spanEnd)}
              </p>
              <p className="mt-1 text-xs text-apple-subtext">
                {fmtSpan(spanStart, spanEnd)} · {spanDays} 个自然日
              </p>
            </>
          ) : (
            <p className="mt-1 text-sm text-apple-subtext">无数据</p>
          )}
        </div>

        <div className="flex h-full flex-col" data-summary-card>
          <p className="label">最近更新</p>
          <p className="num mt-1 text-sm font-semibold leading-snug">{fmtDateTime(data.updated_at)}</p>
          <p className="mt-1 text-xs text-apple-subtext">计划基线时间 · {data.timezone ?? 'Asia/Shanghai'}</p>
        </div>

        <div className="flex h-full flex-col" data-summary-card>
          <p className="label">预计完成（ETA）</p>
          {eta?.base_case_days != null ? (
            <>
              <p className="num mt-1 text-sm font-semibold leading-snug">基准 {eta.base_case_days} 天</p>
              <p className="mt-1 text-xs text-apple-subtext">
                最短 {eta.best_case_days ?? '—'} 天 · 最坏 {eta.worst_case_days ?? '—'} 天
              </p>
              {(eta.current_phase || eta.next_gate) && (
                <p className="mt-1 text-xs text-apple-subtext">
                  {eta.current_phase}
                  {eta.next_gate ? ` · 下一闸 ${eta.next_gate}` : ''}
                </p>
              )}
            </>
          ) : (
            <p className="mt-1 text-sm text-apple-subtext">无数据</p>
          )}
        </div>
      </div>

      {data.note && <p className="mt-4 border-t border-apple-line pt-3 text-[11px] leading-relaxed text-apple-subtext">{data.note}</p>}
    </div>
  )
}

export function PlanTable({
  tasks,
  jobs,
  jobsReady = false,
  onStatusChange,
  onError
}: {
  tasks: PlanTask[]
  jobs: Job[]
  jobsReady?: boolean
  /** #105：有回调才渲染状态下拉；失败时由本组件回滚并上报可读消息。 */
  onStatusChange?: (task: PlanTask, next: PlanStatus) => Promise<void>
  onError?: (message: string) => void
}) {
  const [filter, setFilter] = useState<FilterKey>('all')
  // 乐观状态：请求成功/服务端回读前先显示用户选择；失败立即回滚。
  const [overrides, setOverrides] = useState<Record<string, PlanStatus>>({})
  const [saving, setSaving] = useState<Record<string, boolean>>({})
  const counts = useMemo(() => countByStatus(tasks), [tasks])

  // 回读数据已经带上新状态时清掉 override，避免掩盖服务端真实值。
  useEffect(() => {
    setOverrides((prev) => {
      if (Object.keys(prev).length === 0) return prev
      const next = { ...prev }
      let changed = false
      for (const task of tasks) {
        if (next[task.id] !== undefined && editableStatus(task.status) === next[task.id]) {
          delete next[task.id]
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [tasks])

  const effectiveStatus = (task: PlanTask): PlanStatus => overrides[task.id] ?? editableStatus(task.status)

  const changeStatus = (task: PlanTask, next: PlanStatus) => {
    if (!onStatusChange || saving[task.id]) return
    const previous = editableStatus(task.status)
    if (next === previous) return
    setOverrides((prev) => ({ ...prev, [task.id]: next }))
    setSaving((prev) => ({ ...prev, [task.id]: true }))
    void onStatusChange(task, next)
      .catch((err: unknown) => {
        setOverrides((prev) => {
          const rollback = { ...prev }
          delete rollback[task.id]
          return rollback
        })
        onError?.(writeErrorMessage(err))
      })
      .finally(() => {
        setSaving((prev) => {
          const done = { ...prev }
          delete done[task.id]
          return done
        })
      })
  }

  const statusControl = (task: PlanTask) => {
    const current = effectiveStatus(task)
    const tone = planStatusTone(current)
    if (!onStatusChange) {
      return (
        <span className="flex items-center gap-1.5 whitespace-nowrap text-xs">
          <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} aria-hidden="true" />
          <span className={tone.text}>{tone.label}</span>
        </span>
      )
    }
    return (
      <span className="flex items-center gap-1.5 whitespace-nowrap text-xs">
        <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} aria-hidden="true" />
        <select
          value={current}
          disabled={Boolean(saving[task.id])}
          aria-busy={Boolean(saving[task.id])}
          aria-label={`修改 ${task.id} 状态`}
          data-task-status={task.id}
          onChange={(event) => changeStatus(task, event.target.value as PlanStatus)}
          className="cursor-pointer rounded-md border border-apple-line bg-white px-1.5 py-1 text-xs text-apple-text transition-colors hover:bg-[#FAFAFB] focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50 disabled:cursor-progress disabled:opacity-60"
        >
          {EDIT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </span>
    )
  }

  const sorted = useMemo(
    () => [...tasks].sort((a, b) => (parseTs(a.start) ?? 0) - (parseTs(b.start) ?? 0)),
    [tasks]
  )
  const jobByTask = useMemo(() => {
    const map: Record<string, string> = {}
    for (const task of tasks) {
      const evidence = task.evidence ?? ''
      const hit =
        jobs.find((job) => job.taskId === task.id) ??
        jobs.find((job) => evidence.includes(`b-track-${job.id}`))
      if (hit) map[task.id] = hit.id
    }
    return map
  }, [tasks, jobs])
  const visible = sorted.filter((task) => matchesFilter(task, filter))

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="按状态筛选任务">
        {FILTERS.map(({ key, label }) => {
          const active = filter === key
          const count = key === 'all' ? sorted.length : key === 'running' ? counts.running + counts.in_progress : counts[key]
          return (
            <button
              key={key}
              type="button"
              aria-pressed={active}
              onClick={() => setFilter(key)}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50 ${
                active
                  ? 'border-apple-text bg-apple-text text-white'
                  : 'border-apple-line bg-white text-apple-text hover:bg-[#FAFAFB]'
              }`}
            >
              {label}
              <span className={`num ${active ? 'text-white/80' : 'text-apple-subtext'}`}>{count}</span>
            </button>
          )
        })}
      </div>

      <div className="card hidden overflow-hidden md:block">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1080px] border-collapse text-left">
            <caption className="sr-only">全部任务明细，按开始时间升序</caption>
            <thead>
              <tr className="border-b border-apple-line bg-[#FAFAFB] text-[11px] text-apple-subtext">
                <th scope="col" className="px-4 py-2.5 font-medium">任务</th>
                <th scope="col" className="px-3 py-2.5 font-medium">负责人</th>
                <th scope="col" className="px-3 py-2.5 font-medium">轨道</th>
                <th scope="col" className="px-3 py-2.5 font-medium">状态</th>
                <th scope="col" className="px-3 py-2.5 font-medium">进度</th>
                <th scope="col" className="px-3 py-2.5 font-medium">开始</th>
                <th scope="col" className="px-3 py-2.5 font-medium">预计完成</th>
                <th scope="col" className="px-3 py-2.5 font-medium">时长</th>
                <th scope="col" className="px-3 py-2.5 font-medium">依赖 / 阻塞</th>
                <th scope="col" className="px-4 py-2.5 font-medium">证据</th>
                <th scope="col" className="px-4 py-2.5 font-medium">详情</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((task) => {
                const tone = planStatusTone(effectiveStatus(task))
                const start = parseTs(task.start)
                const end = parseTs(task.end)
                const progress = Number.isFinite(task.progress) ? Math.min(100, Math.max(0, task.progress)) : 0
                const deps = task.depends_on ?? []
                return (
                  <tr key={task.id} className="border-b border-apple-line align-top last:border-0 hover:bg-[#FAFAFB]">
                    <td className="px-4 py-2.5">
                      <p className="min-w-[200px] text-sm font-medium leading-snug">{task.title}</p>
                      <p className="num mt-0.5 text-[10px] text-apple-subtext">{task.id}</p>
                    </td>
                    <td className="px-3 py-2.5 text-xs">{task.owner}</td>
                    <td className="px-3 py-2.5 text-xs text-apple-subtext">{railLabel(task.rail)}</td>
                    <td className="px-3 py-2.5">{statusControl(task)}</td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <span className="h-1 w-12 overflow-hidden rounded-full bg-[#EDEDF0]" aria-hidden="true">
                          <span className={`block h-full rounded-full ${tone.dot}`} style={{ width: `${progress}%` }} />
                        </span>
                        <span className="num text-xs text-apple-subtext">{progress}%</span>
                      </div>
                    </td>
                    <td className="num whitespace-nowrap px-3 py-2.5 text-xs">{fmtDateTime(task.start)}</td>
                    <td className="num whitespace-nowrap px-3 py-2.5 text-xs">
                      {fmtDateTime(task.end)}
                      {task.estimated && <span className="ml-1 text-[10px] text-apple-subtext">估</span>}
                    </td>
                    <td className="num whitespace-nowrap px-3 py-2.5 text-xs text-apple-subtext">
                      {start !== null && end !== null ? fmtDuration(start, end) : '—'}
                    </td>
                    <td className="px-3 py-2.5 text-xs">
                      {deps.length === 0 && !task.blocked_by ? (
                        <span className="text-apple-subtext">—</span>
                      ) : (
                        <div className="max-w-[240px] space-y-1">
                          {deps.length > 0 && (
                            <p className="flex flex-wrap gap-1">
                              {deps.map((dep) => (
                                <span key={dep} className="num rounded bg-[#F5F5F7] px-1 py-0.5 text-[10px] text-apple-subtext">
                                  ← {dep}
                                </span>
                              ))}
                            </p>
                          )}
                          {task.blocked_by && (
                            <p className="text-[11px] leading-snug text-apple-amber" title={task.blocked_by}>
                              受阻：{task.blocked_by}
                            </p>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-xs">
                      {task.evidence ? (
                        <span className="num block max-w-[200px] break-all leading-snug text-apple-subtext" title={task.evidence}>
                          {task.evidence}
                        </span>
                      ) : (
                        <span className="text-apple-subtext">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-xs">
                      {jobByTask[task.id] ? (
                        <Link
                          to={`/job/${jobByTask[task.id]}`}
                          className="whitespace-nowrap font-medium text-apple-blueInk hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
                        >
                          查看详情
                        </Link>
                      ) : jobsReady ? (
                        <span className="whitespace-nowrap text-apple-subtext" title="该任务没有对应的 job 产物">
                          暂无任务产物
                        </span>
                      ) : (
                        <span className="text-apple-subtext">…</span>
                      )}
                    </td>
                  </tr>
                )
              })}
              {visible.length === 0 && (
                <tr>
                  <td colSpan={11} className="px-4 py-10 text-center text-sm text-apple-subtext">
                    该状态下没有任务。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* #105：390px 下表格换成纵向卡片，字段与桌面表一致。 */}
      <ul className="space-y-2 md:hidden" aria-label="任务明细卡片">
        {visible.map((task) => {
          const start = parseTs(task.start)
          const end = parseTs(task.end)
          const progress = Number.isFinite(task.progress) ? Math.min(100, Math.max(0, task.progress)) : 0
          const tone = planStatusTone(effectiveStatus(task))
          const deps = task.depends_on ?? []
          return (
            <li key={task.id} className="card p-4" data-task-card={task.id}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium leading-snug">{task.title}</p>
                  <p className="num mt-0.5 text-[10px] text-apple-subtext">{task.id}</p>
                </div>
                {statusControl(task)}
              </div>
              <div className="mt-2 flex items-center gap-2">
                <span className="h-1 flex-1 overflow-hidden rounded-full bg-[#EDEDF0]" aria-hidden="true">
                  <span className={`block h-full rounded-full ${tone.dot}`} style={{ width: `${progress}%` }} />
                </span>
                <span className="num text-xs text-apple-subtext">{progress}%</span>
              </div>
              <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
                <div>
                  <dt className="text-apple-subtext">开始</dt>
                  <dd className="num">{start === null ? '—' : fmtDateTime(start)}</dd>
                </div>
                <div>
                  <dt className="text-apple-subtext">预计完成</dt>
                  <dd className="num">{end === null ? '—' : fmtDateTime(end)}</dd>
                </div>
                <div>
                  <dt className="text-apple-subtext">负责人</dt>
                  <dd className="truncate">{task.owner}</dd>
                </div>
                <div>
                  <dt className="text-apple-subtext">轨道</dt>
                  <dd className="truncate">{railLabel(task.rail)}</dd>
                </div>
              </dl>
              {(task.blocked_by || deps.length > 0) && (
                <p className="mt-2 text-[11px] leading-snug text-apple-subtext">
                  {task.blocked_by ? `受阻：${task.blocked_by}` : `依赖：${deps.join(' ')}`}
                </p>
              )}
              {task.evidence && (
                <p className="num mt-1 break-all text-[11px] leading-snug text-apple-subtext">{task.evidence}</p>
              )}
              {jobByTask[task.id] && (
                <Link
                  to={`/job/${jobByTask[task.id]}`}
                  className="mt-2 inline-block text-[11px] font-medium text-apple-blueInk hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
                >
                  查看详情
                </Link>
              )}
            </li>
          )
        })}
        {visible.length === 0 && (
          <li className="card p-6 text-center text-sm text-apple-subtext">该状态下没有任务。</li>
        )}
      </ul>

      <p className="px-1 text-[11px] text-apple-subtext">
        显示 {visible.length} / {sorted.length} 项 · 时间按 Asia/Shanghai · 「估」为估算时间
      </p>
    </div>
  )
}
