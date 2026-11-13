import { useEffect, useMemo, useState } from 'react'
import type { PlanMilestone, PlanTask } from '../types'
import {
  DAY_MS,
  fmtDateTime,
  fmtDayLabel,
  localDayStart,
  parseTs,
  planStatusTone,
  railLabel
} from '../plan'

const DAY_W = 114
const LEFT_W = 236
const LEFT_W_NARROW = 168
const ROW_H = 40
const BAR_H = 10
const MIN_BAR_W = 6
const LANE_H = 22
const MILESTONE_LANES = 2
const HEADER_LANES_H = (MILESTONE_LANES + 1) * LANE_H + 6
const HEADER_DAY_H = 26
const HEADER_H = HEADER_LANES_H + HEADER_DAY_H
const CHIP_W = 150

type Row = { task: PlanTask; start: number; end: number }

type PlacedMilestone = { milestone: PlanMilestone; at: number; x: number; lane: number }

type Model = {
  rows: Row[]
  domainStart: number
  days: number
  timelineW: number
  placed: PlacedMilestone[]
  todayX: number | null
  todayLabel: string
}

function barPaint(status: PlanTask['status']): { background: string; border: string; image?: string } {
  switch (status) {
    case 'done':
      return { background: '#E3F4E8', border: '1px solid #B7DFC4' }
    case 'running':
    case 'in_progress':
      return { background: '#D7E6F9', border: '1px solid #A9CBF3' }
    case 'pending':
      return { background: '#DDEBFC', border: '1px solid #B9D3F2' }
    case 'blocked':
      return {
        background: '#F9E2C3',
        border: '1px solid #DDA45C',
        image: 'repeating-linear-gradient(45deg, #F9E2C3 0 3px, #F1D0A0 3px 6px)'
      }
    default:
      return { background: '#F0F0F2', border: '1px solid #E5E5EA' }
  }
}

export function PlanGantt({ tasks, milestones }: { tasks: PlanTask[]; milestones: PlanMilestone[] }) {
  // #105: 390px 下左列收窄，给时间轴留出可读宽度（桌面保持 236）。
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 639px)')
    const sync = () => setNarrow(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])
  const model = useMemo<Model | null>(() => {
    const rows: Row[] = tasks
      .map((task) => ({ task, start: parseTs(task.start), end: parseTs(task.end) }))
      .filter((row): row is Row => row.start !== null && row.end !== null)
      .sort((a, b) => a.start - b.start)
    if (rows.length === 0) return null

    const milestonesAt = milestones
      .map((milestone) => ({ milestone, at: parseTs(milestone.at) }))
      .filter((row): row is { milestone: PlanMilestone; at: number } => row.at !== null)

    const minTs = Math.min(...rows.map((row) => row.start), ...milestonesAt.map((row) => row.at))
    const maxTs = Math.max(...rows.map((row) => row.end), ...milestonesAt.map((row) => row.at))
    const domainStart = localDayStart(minTs)
    const days = Math.max(1, Math.round((localDayStart(maxTs) + DAY_MS - domainStart) / DAY_MS))
    const timelineW = days * DAY_W
    const xOf = (ts: number) => ((ts - domainStart) / DAY_MS) * DAY_W

    const laneEnds: number[] = []
    const placed = milestonesAt
      .sort((a, b) => a.at - b.at)
      .map((row) => {
        const x = xOf(row.at)
        let lane = 0
        while (lane < MILESTONE_LANES && laneEnds[lane] !== undefined && x - laneEnds[lane] < 8) lane += 1
        lane = Math.min(lane, MILESTONE_LANES - 1)
        laneEnds[lane] = x + CHIP_W
        return { ...row, x, lane }
      })

    const now = Date.now()
    const inRange = now >= domainStart && now <= domainStart + days * DAY_MS
    return {
      rows,
      domainStart,
      days,
      timelineW,
      placed,
      todayX: inRange ? xOf(now) : null,
      todayLabel: fmtDateTime(now).slice(0, 5)
    }
  }, [tasks, milestones])

  if (!model) {
    return <div className="card p-5 text-sm text-apple-subtext">计划里没有可绘制的任务。</div>
  }

  const { rows, domainStart, days, timelineW, placed, todayX, todayLabel } = model
  const leftW = narrow ? LEFT_W_NARROW : LEFT_W
  const totalW = leftW + timelineW
  const xOf = (ts: number) => ((ts - domainStart) / DAY_MS) * DAY_W
  const dayTicks = Array.from({ length: days }, (_, index) => domainStart + index * DAY_MS)
  // 网格线只做定位参考，压到 5% 黑，不与任务条抢视觉。
  const dayGrid = `linear-gradient(to right, rgba(0,0,0,0.05) 1px, transparent 1px)`

  return (
    <div className="card overflow-hidden">
      <div
        className="overflow-x-auto overscroll-x-contain focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-apple-blue/50"
        role="region"
        aria-label="甘特图，可横向滚动查看时间轴"
        tabIndex={0}
      >
        <div className="relative" style={{ width: totalW }}>
          <div
            className="grid border-b border-apple-line"
            style={{ gridTemplateColumns: `${leftW}px ${timelineW}px` }}
          >
            <div
              className="sticky left-0 z-30 flex items-end border-r border-apple-line bg-[#FAFAFB] px-3 pb-2"
              style={{ height: HEADER_H }}
            >
              <span className="label">任务 · {rows.length}</span>
            </div>
            <div className="relative bg-[#FAFAFB]" style={{ height: HEADER_H }}>
              {dayTicks.map((tick, index) => (
                <span
                  key={tick}
                  className="num absolute bottom-1.5 text-[10px] text-apple-subtext"
                  style={{ left: index * DAY_W + 6 }}
                >
                  {fmtDayLabel(tick)}
                </span>
              ))}
              {placed.map(({ milestone, x, lane }) => {
                const flip = x > timelineW - CHIP_W / 2 ? '-100%' : x < CHIP_W / 2 ? '0' : '-50%'
                const label = `${milestone.id} ${milestone.label}`
                return (
                <span
                    key={milestone.id}
                    data-milestone-id={milestone.id}
                    className="num absolute z-10 flex max-w-[150px] items-center gap-1 truncate rounded-[7px] bg-black/[0.05] px-2 py-[2px] text-[12px] leading-4 text-apple-text"
                  style={{ left: x, top: lane * LANE_H + 2, transform: `translateX(${flip})` }}
                    title={`${label} · ${fmtDateTime(milestone.at)}`}
                  >
                    <span className="font-semibold">{milestone.id}</span>
                    <span className="truncate text-apple-subtext">{fmtDateTime(milestone.at)}</span>
                  </span>
                )
              })}
              {todayX !== null && (
                <span
                  className="num absolute z-10 rounded-[4px] bg-apple-text px-1 py-0.5 text-[10px] leading-4 text-white"
                  style={{
                    left: todayX,
                    top: MILESTONE_LANES * LANE_H + 4,
                    transform: todayX > timelineW - 40 ? 'translateX(-100%)' : 'translateX(-50%)'
                  }}
                >
                  今天 {todayLabel}
                </span>
              )}
            </div>
          </div>

          {rows.map(({ task, start, end }, rowIndex) => {
            const tone = planStatusTone(task.status)
            const deps = task.depends_on ?? []
            const paint = barPaint(task.status)
            const left = Math.max(0, xOf(start))
            const width = Math.min(timelineW - left, Math.max(MIN_BAR_W, xOf(end) - left))
            const progress = Number.isFinite(task.progress) ? Math.min(100, Math.max(0, task.progress)) : 0
            const label = `${task.id} ${task.title}，${tone.label}，开始 ${fmtDateTime(task.start)}，预计完成 ${fmtDateTime(task.end)}，进度 ${progress}%${task.blocked_by ? `，受阻：${task.blocked_by}` : ''}`
            const meta = [task.owner, railLabel(task.rail), deps.length > 0 ? `← ${deps.join(' ')}` : '']
              .filter(Boolean)
              .join(' · ')

            return (
              <div
                key={task.id}
                className="group grid"
                style={{ gridTemplateColumns: `${leftW}px ${timelineW}px` }}
              >
                <div
                  className="sticky left-0 z-10 flex flex-col justify-center border-t border-r border-t-black/[0.05] border-r-apple-line bg-white px-3 group-hover:bg-[#FAFAFB]"
                  style={{ height: ROW_H }}
                >
                  <div className="flex min-w-0 items-baseline gap-2">
                    <span className="num shrink-0 text-[10px] text-apple-subtext">{task.id}</span>
                    <span className="truncate text-xs font-medium leading-snug" title={task.title}>
                      {task.title}
                    </span>
                  </div>
                  <p
                    className="mt-0.5 flex min-w-0 items-center gap-1 text-[10px] leading-4 text-apple-subtext"
                    title={meta}
                  >
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`} aria-hidden="true" />
                    <span className={`shrink-0 ${tone.text}`}>{tone.label}</span>
                    <span aria-hidden="true">·</span>
                    <span className="truncate">{meta}</span>
                  </p>
                </div>

                <div
                  className="relative border-t border-black/[0.05] bg-white group-hover:bg-[#FAFAFB]"
                  style={{ height: ROW_H, backgroundImage: dayGrid, backgroundSize: `${DAY_W}px 100%` }}
                >
                  <div
                    role="img"
                    aria-label={label}
                    title={label}
                    className="gantt-bar absolute rounded-[3px]"
                    style={{
                      left,
                      width,
                      top: (ROW_H - BAR_H) / 2,
                      height: BAR_H,
                      background: paint.background,
                      backgroundImage: paint.image,
                      border: paint.border,
                      boxSizing: 'border-box',
                      animationDelay: `${Math.min(rowIndex, 4) * 20}ms`
                    }}
                  >
                    {task.status === 'running' && progress > 0 && (
                      <span
                        className="absolute inset-y-0 left-0 rounded-[2px] bg-apple-blue"
                        style={{ width: `${progress}%` }}
                        aria-hidden="true"
                      />
                    )}
                  </div>
                  {task.blocked_by && (
                    <span
                      className="absolute truncate text-[10px] leading-4 text-apple-amber"
                      style={{ left: left + width + 6, top: (ROW_H - 16) / 2, maxWidth: 168 }}
                      title={`受阻：${task.blocked_by}`}
                    >
                      受阻：{task.blocked_by}
                    </span>
                  )}
                </div>
              </div>
            )
          })}

          <div
            aria-hidden="true"
            className="pointer-events-none absolute"
            style={{ left: leftW, top: HEADER_H, width: timelineW, bottom: 0 }}
          >
            {placed.map(({ milestone, x }) => (
              <span
                key={milestone.id}
                className="absolute bottom-0 top-0"
                style={{ left: x, borderLeft: '1px dashed rgba(0,0,0,0.10)' }}
              />
            ))}
            {todayX !== null && (
              <span
                className="absolute bottom-0 top-0"
                style={{ left: todayX, borderLeft: '1px solid rgba(29,29,31,0.55)' }}
              />
            )}
          </div>
        </div>
      </div>

      <ul className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-apple-line px-4 py-3 text-[11px] text-apple-subtext">
        <li className="flex items-center gap-1.5">
          <span className="h-2.5 w-4 rounded-[2px] border border-[#B7DFC4] bg-[#E3F4E8]" aria-hidden="true" />已完成
        </li>
        <li className="flex items-center gap-1.5">
          <span className="relative h-2.5 w-4 rounded-[2px] border border-[#A9CBF3] bg-[#D7E6F9]" aria-hidden="true">
            <span className="absolute inset-y-0 left-0 w-2/3 rounded-l-[1px] bg-apple-blue" />
          </span>
          进行中（内条为进度）
        </li>
        <li className="flex items-center gap-1.5">
          <span className="h-2.5 w-4 rounded-[2px] border border-[#B9D3F2] bg-[#DDEBFC]" aria-hidden="true" />
          未开始
        </li>
        <li className="flex items-center gap-1.5">
          <span
            className="h-2.5 w-4 rounded-[2px] border border-[#DDA45C]"
            style={{ backgroundImage: 'repeating-linear-gradient(45deg, #F9E2C3 0 3px, #F1D0A0 3px 6px)' }}
            aria-hidden="true"
          />
          阻塞
        </li>
        <li className="flex items-center gap-1.5">
          <span className="h-3 w-0 border-l border-apple-text/60" aria-hidden="true" />
          今天
        </li>
        <li className="flex items-center gap-1.5">
          <span className="h-3 w-0 border-l border-dashed border-black/[0.10]" aria-hidden="true" />
          里程碑
        </li>
      </ul>
    </div>
  )
}
