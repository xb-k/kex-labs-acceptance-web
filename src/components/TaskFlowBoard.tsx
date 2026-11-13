import { useState } from 'react'
import type { PlanStatus, PlanTask } from '../types'
import { LazySection, LoadMore, Skeleton } from './lazy'
import { TriangleAlert } from './icons'

const PAGE_SIZE = 10

const COLUMNS: { status: PlanStatus; label: string; color: string; tint: string }[] = [
  { status: 'pending', label: '待排队', color: '#8E8E93', tint: '#F0F0F1' },
  { status: 'running', label: '执行中', color: '#0071E3', tint: '#E8EFF8' },
  { status: 'blocked', label: '阻塞', color: '#C77700', tint: '#F4EEE8' },
  { status: 'done', label: '已完成', color: '#30A14E', tint: '#E9F1ED' }
]

// 轨别只用中性浅底 + 深字区分，避免紫/蓝高饱和块抢走状态色语义。
const railStyle: Record<string, string> = {
  A: 'bg-black/[0.03] text-apple-subtextAlt ring-black/[0.06]',
  B: 'bg-black/[0.03] text-apple-subtextAlt ring-black/[0.06]',
  both: 'bg-black/[0.03] text-apple-subtextAlt ring-black/[0.06]'
}

function columnOf(status: PlanStatus) {
  const normalized = status === 'in_progress' ? 'running' : status
  return COLUMNS.find((column) => column.status === normalized) ?? COLUMNS[0]
}

function railLabel(rail: string): string {
  if (rail === 'A' || rail === 'B') return `${rail} 轨`
  return '双轨'
}

function countOf(tasks: PlanTask[], status: PlanStatus): number {
  return tasks.filter((task) => columnOf(task.status).status === status).length
}

/** #99 数字优先：总数 + 四状态大数字，先给量级再给明细。 */
function BoardSummary({ tasks }: { tasks: PlanTask[] }) {
  return (
    <div
      className="mb-3 flex flex-wrap items-end gap-x-6 gap-y-2 rounded-card border border-black/[0.04] bg-white px-4 py-3 shadow-container"
      aria-label={`任务总数 ${tasks.length}`}
    >
      <div className="flex items-baseline gap-1.5">
        <span className="text-[11px] font-medium text-apple-subtext">任务总数</span>
        <span className="num text-[26px] font-semibold leading-none tracking-[-0.02em] text-apple-text">
          {tasks.length}
        </span>
      </div>
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1.5">
        {COLUMNS.map((column) => {
          const count = countOf(tasks, column.status)
          return (
            <div key={column.status} className="flex items-baseline gap-1.5">
              <span
                aria-hidden="true"
                className="mb-0.5 h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: column.color }}
              />
              <span className="text-[11px] text-apple-subtext">{column.label}</span>
              <span
                className="num text-[20px] font-semibold leading-none tabular-nums"
                style={{ color: count > 0 ? column.color : '#C7C7CC' }}
              >
                {count}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** #99 紧凑单行：状态点 + 任务名 + rail / owner / 进度，不再用大卡片。 */
function TaskRow({ task }: { task: PlanTask }) {
  const progress = Number.isFinite(task.progress) ? Math.min(100, Math.max(0, task.progress)) : 0
  const blocked = task.status === 'blocked'
  const value = task.status === 'done' ? 100 : progress
  const meta = columnOf(task.status)
  const blockedReason = task.blocked_by || '原因未说明'

  return (
    <div
      className={`flex min-w-0 items-center gap-2 rounded-[8px] border px-2 py-1.5 ${
        blocked ? 'border-[#F0D9BC] bg-[#FBF1E4]' : 'border-black/[0.04] bg-white'
      }`}
      title={blocked ? `${task.title} · 阻塞：${blockedReason}` : `${task.title} · ${railLabel(task.rail)}`}
    >
      <span
        aria-hidden="true"
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: meta.color }}
      />
      <span className="min-w-0 flex-1 truncate text-[12px] font-medium leading-snug tracking-[-0.01em]">
        {task.title}
      </span>
      {blocked && (
        <TriangleAlert
          className="h-3 w-3 shrink-0 text-[#8A4B00]"
          aria-label={`阻塞：${blockedReason}`}
        />
      )}
      <span
        className={`shrink-0 rounded-[5px] px-1 py-0.5 text-[10px] font-medium ring-1 ring-inset ${
          railStyle[task.rail] ?? railStyle.both
        }`}
      >
        {railLabel(task.rail)}
      </span>
      <span
        className="hidden max-w-[64px] shrink-0 truncate text-right text-[10px] text-apple-subtext sm:inline"
        title={task.owner || '未指派'}
      >
        {task.owner || '未指派'}
      </span>
      <span className="num w-7 shrink-0 text-right text-[10px] tabular-nums text-apple-subtext">
        {value}%
      </span>
    </div>
  )
}

function BoardColumn({ column, items }: { column: (typeof COLUMNS)[number]; items: PlanTask[] }) {
  const [visible, setVisible] = useState(PAGE_SIZE)
  const shown = items.slice(0, visible)
  const remaining = Math.max(0, items.length - shown.length)

  return (
    <section
      aria-label={`${column.label}（${items.length}）`}
      className="flex min-w-0 flex-col overflow-hidden rounded-card border border-black/[0.04] bg-[#F5F5F7]/75 shadow-container"
    >
      <div className="flex items-center justify-between gap-2 border-b border-black/[0.04] bg-white/80 px-3 py-2">
        <span className="flex items-center gap-1.5 text-[12px] font-semibold tracking-[-0.01em]">
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: column.color }} />
          {column.label}
        </span>
        <span
          className="num text-[18px] font-semibold leading-none tabular-nums"
          style={{ color: items.length > 0 ? column.color : '#C7C7CC' }}
        >
          {items.length}
        </span>
      </div>

      <div className="space-y-1.5 p-2">
        {items.length === 0 ? (
          <p className="rounded-[8px] border border-dashed border-black/[0.08] px-3 py-4 text-center text-[11px] text-apple-subtext">
            空
          </p>
        ) : (
          shown.map((task) => (
            <LazySection key={task.id} minHeight={38} rootMargin="160px 0px">
              <TaskRow task={task} />
            </LazySection>
          ))
        )}

        <LoadMore
          remaining={remaining}
          onClick={() => setVisible((value) => value + PAGE_SIZE)}
          unit="个任务"
          className="mt-1.5"
        />
      </div>
    </section>
  )
}

export function TaskFlowBoard({
  tasks,
  loading,
  error,
  onRetry
}: {
  tasks: PlanTask[]
  loading: boolean
  error: string | null
  onRetry: () => void
}) {
  if (loading) {
    return (
      <div aria-busy="true" aria-label="正在加载任务看板">
        <div className="mb-3 flex flex-wrap items-end gap-x-6 gap-y-2 rounded-card border border-black/[0.04] bg-white px-4 py-3 shadow-container">
          <Skeleton className="h-7 w-24" />
          <Skeleton className="h-5 w-56" />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {COLUMNS.map((column) => (
            <div
              key={column.status}
              className="flex flex-col overflow-hidden rounded-card border border-black/[0.04] bg-[#F5F5F7]/75"
            >
              <div className="flex items-center justify-between gap-2 border-b border-black/[0.04] bg-white/80 px-3 py-2">
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-4 w-6" />
              </div>
              <div className="space-y-1.5 p-2">
                {[0, 1, 2].map((index) => (
                  <Skeleton key={index} className="h-[38px] w-full" />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }
  if (error) {
    return (
      <div className="card flex flex-wrap items-center justify-between gap-3 p-5" role="alert">
        <div>
          <p className="text-sm font-medium">任务计划读取失败</p>
          <p className="mt-1 text-xs text-apple-subtext">{error}</p>
        </div>
        <button
          type="button"
          onClick={onRetry}
          className="press rounded-lg bg-apple-text px-3 py-1.5 text-xs font-medium text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
        >
          重试
        </button>
      </div>
    )
  }
  if (tasks.length === 0) {
    return (
      <div className="card p-6">
        <h2 className="text-sm font-medium">暂无任务计划</h2>
        <p className="mt-2 text-sm text-apple-subtext">/api/plan 未返回任务，检查 tasks.json 或数据层同步状态。</p>
      </div>
    )
  }

  return (
    <div>
      <BoardSummary tasks={tasks} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {COLUMNS.map((column) => (
          <BoardColumn key={column.status} column={column} items={tasks.filter((task) => columnOf(task.status).status === column.status)} />
        ))}
      </div>
    </div>
  )
}
