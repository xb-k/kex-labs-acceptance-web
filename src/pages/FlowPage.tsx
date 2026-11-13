import { Fragment, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useJson, useLiveJson } from '../api'
import { DataTable } from '../components/DataTable'
import type { Column } from '../components/DataTable'
import { Alert, Clock, Film, Flow, Refresh, Shield, TriangleAlert } from '../components/icons'
import { SnapshotStatusStage } from '../components/SnapshotStatusStage'
import { Link } from '../router'
import {
  agentNodeExplain,
  chainLinks,
  continuityFields,
  nodeExplain,
  promptChain,
  stageExplain
} from '../flow-explain'
import { flowRequestUrl, jobSearch, parseJobParam, resolveFlowJobId } from '../flow-job-url'
import type { ContractResponse, ContractWorkflow, WorkflowNode } from '../types'
import type {
  FlowArtifact,
  FlowFrame,
  FlowJob,
  FlowLogs,
  FlowResponse,
  FlowShot,
  FlowStage,
  FlowTool
} from '../types'

/* ------------------------------- 展示词典 ------------------------------- */

const STAGE_LABEL: Record<string, string> = {
  A: '素材处理',
  B: '抽帧',
  B2: '帧语义',
  C: '关键帧重绘',
  D: 'I2V 生成',
  E: '调色 · 插帧 · 超分',
  F: '音频 · 封装'
}

type Tone = { label: string; chip: string; dot: string; bar: string }

const TONES: Record<string, Tone> = {
  done: {
    label: '完成',
    chip: 'bg-[#EAF8EE] text-apple-greenInk ring-[#CDEED6]',
    dot: 'bg-apple-statusDone',
    bar: 'bg-apple-statusDone'
  },
  running: {
    label: '执行中',
    chip: 'bg-[#E8F1FB] text-apple-blueInk ring-[#CFE2F8]',
    dot: 'bg-apple-statusRunning',
    bar: 'bg-apple-statusRunning'
  },
  failed: {
    label: '失败',
    chip: 'bg-[#FCEDEB] text-[#B3261E] ring-[#F3D3CF]',
    dot: 'bg-apple-red',
    bar: 'bg-apple-red'
  },
  pending: {
    label: '待排队',
    chip: 'bg-[#F0F0F2] text-apple-subtextAlt ring-[#E2E2E6]',
    dot: 'bg-apple-statusPending',
    bar: 'bg-apple-statusPending'
  },
  skipped: {
    label: '已跳过',
    chip: 'bg-[#F0F0F2] text-apple-subtextAlt ring-[#E2E2E6]',
    dot: 'bg-[#A1A1AA]',
    bar: 'bg-[#A1A1AA]'
  },
  // 派生状态：环节已完成但 state 记录的产物全部缺失（不是后端 status 值）。
  missing: {
    label: '文件缺失',
    chip: 'bg-[#FBF1E4] text-[#8A4B00] ring-[#F0D9BC]',
    dot: 'bg-[#C77700]',
    bar: 'bg-[#DDA45C]'
  },
  empty: {
    label: '无产物',
    chip: 'bg-[#F0F0F2] text-apple-subtextAlt ring-[#E2E2E6]',
    dot: 'bg-[#C7C7CC]',
    bar: 'bg-[#D8D8DD]'
  }
}

const NEUTRAL: Tone = {
  label: '无数据',
  chip: 'bg-[#F0F0F2] text-apple-subtextAlt ring-[#E2E2E6]',
  dot: 'bg-[#C7C7CC]',
  bar: 'bg-[#D8D8DD]'
}

function toneOf(status: string | null | undefined): Tone {
  return (status && TONES[status]) || NEUTRAL
}

export function StatusPill({ status }: { status: string | null | undefined }) {
  const tone = toneOf(status)
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium leading-4 ring-1 ring-inset ${tone.chip}`}
    >
      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />
      {status ? tone.label : '—'}
    </span>
  )
}

/* ------------------------------- 小工具 ------------------------------- */

export function text(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (typeof value === 'string') return value
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '—'
  if (Array.isArray(value)) return value.length ? value.map(text).join(' · ') : '—'
  try {
    return JSON.stringify(value)
  } catch {
    return '—'
  }
}

function boolText(value: boolean | null): string {
  if (value === null) return '—'
  return value ? '是' : '否'
}

function formatMs(ms: number | null): string {
  if (ms === null) return '—'
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`
}

export function formatTime(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  })
}

function clockOf(ms: number | null): string {
  if (ms === null) return '—'
  const date = new Date(ms)
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

function stageName(key: string): string {
  return `${key} · ${STAGE_LABEL[key] ?? '未命名环节'}`
}

/**
 * 展示状态：status 全取自 stages[].status；仅当「已完成但 state 记录的产物全部缺失」
 * 派生出 missing，或「已完成但没有任何产物字段」派生出 empty——都不编造后端没有的状态。
 */
function stageDisplayStatus(stage: FlowStage): string | null {
  const recorded = (stage.artifacts ?? []).filter((a) => Boolean(a.path))
  if (stage.status === 'done' && recorded.length > 0 && recorded.every((a) => !a.exists)) return 'missing'
  if (stage.status === 'done' && recorded.length === 0) return 'empty'
  return stage.status
}

function missingCountOf(stage: FlowStage): number {
  return (stage.artifacts ?? []).filter((a) => Boolean(a.path) && !a.exists).length
}

/** 当前环节：优先执行中，其次失败，最后取最后一个环节。状态一律取 stages.<S>.status。 */
function focusStageIndex(stages: FlowJob['stages']): number {
  const running = stages.findIndex((stage) => stage.status === 'running')
  if (running >= 0) return running
  const failed = stages.findIndex((stage) => stage.status === 'failed')
  if (failed >= 0) return failed
  return Math.max(0, stages.length - 1)
}

function nested(value: unknown, ...path: string[]): unknown {
  let cursor: unknown = value
  for (const key of path) {
    if (!cursor || typeof cursor !== 'object') return null
    cursor = (cursor as Record<string, unknown>)[key]
  }
  return cursor ?? null
}

/* ------------------------------- 结构组件 ------------------------------- */

function Section({
  title,
  hint,
  action,
  children,
  testId
}: {
  title: string
  hint?: ReactNode
  action?: ReactNode
  children: ReactNode
  testId?: string
}) {
  return (
    <section className="card p-4" data-testid={testId}>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-[13px] font-semibold leading-5">{title}</h2>
        <div className="flex items-center gap-2 text-[10px] leading-4 text-apple-subtext">
          {hint}
          {action}
        </div>
      </div>
      {children}
    </section>
  )
}

function Stat({
  label,
  value,
  note,
  accent
}: {
  label: string
  value: ReactNode
  note: string
  accent?: string
}) {
  return (
    <div className="card relative flex h-full min-w-0 flex-col overflow-hidden p-4" data-stat={label}>
      <span
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-[3px]"
        style={{ backgroundColor: accent ?? 'rgba(29,29,31,0.10)' }}
      />
      <p className="label">{label}</p>
      <p className="num mt-2 text-[24px] font-semibold leading-none tracking-[-0.02em]">{value}</p>
      <p className="mt-auto truncate pt-2 text-[11px] leading-4 text-apple-subtext" title={note}>
        {note}
      </p>
    </div>
  )
}

function Kv({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="space-y-1 text-[11px] leading-5">
      {rows.map(([key, value]) => (
        <div key={key} className="flex items-start justify-between gap-3">
          <dt className="shrink-0 text-apple-subtext">{key}</dt>
          <dd className="min-w-0 break-words text-right">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

/* ------------------------------- 工具表 ------------------------------- */

function ToolsTable({ tools }: { tools: FlowTool[] }) {
  if (tools.length === 0) {
    return <p className="text-xs leading-relaxed text-apple-subtext">该环节没有工具记录。</p>
  }

  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full border-collapse text-left text-[11px] leading-5">
          <thead>
            <tr className="text-apple-subtext">
              <th className="border-b border-apple-line/80 pb-1.5 pr-2 font-medium">工具</th>
              <th className="border-b border-apple-line/80 pb-1.5 pr-2 font-medium">状态</th>
              <th className="border-b border-apple-line/80 pb-1.5 pr-2 text-right font-medium">耗时</th>
              <th className="border-b border-apple-line/80 pb-1.5 pr-2 text-right font-medium">次数</th>
              <th className="border-b border-apple-line/80 pb-1.5 pr-2 font-medium">缓存</th>
              <th className="border-b border-apple-line/80 pb-1.5 font-medium">跳过</th>
            </tr>
          </thead>
          <tbody>
            {tools.map((tool) => (
              <Fragment key={tool.name}>
                <tr className="border-b border-apple-line/60 align-top last:border-b-0">
                  <td className="py-1.5 pr-2 font-mono break-all">{tool.name}</td>
                  <td className="py-1.5 pr-2">
                    <StatusPill status={tool.status} />
                  </td>
                  <td className="num py-1.5 pr-2 text-right whitespace-nowrap">{formatMs(tool.duration_ms)}</td>
                  <td className="num py-1.5 pr-2 text-right">{tool.attempts ?? '—'}</td>
                  <td className="py-1.5 pr-2">{boolText(tool.cached)}</td>
                  <td className="py-1.5">{boolText(tool.skipped)}</td>
                </tr>
                {tool.error && (
                  <tr className="border-b border-apple-line/60 last:border-b-0">
                    <td colSpan={6} className="pb-2 pr-2 text-[10px] leading-4 break-words text-[#B3261E]">
                      {tool.error}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="space-y-2 md:hidden">
        {tools.map((tool) => (
          <li key={tool.name} className="rounded-lg border border-black/[0.06] bg-apple-bg/70 px-2.5 py-2">
            <div className="flex items-start justify-between gap-3">
              <span className="min-w-0 font-mono text-[11px] break-all">{tool.name}</span>
              <StatusPill status={tool.status} />
            </div>
            <dl className="mt-1.5 space-y-1 text-[11px] leading-5">
              <div className="flex justify-between gap-3">
                <dt className="text-apple-subtext">耗时</dt>
                <dd className="num">{formatMs(tool.duration_ms)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-apple-subtext">次数</dt>
                <dd className="num">{tool.attempts ?? '—'}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-apple-subtext">缓存 / 跳过</dt>
                <dd>
                  {boolText(tool.cached)} / {boolText(tool.skipped)}
                </dd>
              </div>
              {tool.error && (
                <div>
                  <dt className="text-apple-subtext">错误</dt>
                  <dd className="mt-0.5 break-words text-[#B3261E]">{tool.error}</dd>
                </div>
              )}
            </dl>
          </li>
        ))}
      </ul>
    </>
  )
}

/* ------------------------------- 真实产物 / 缺失安全态 ------------------------------- */

/** 文件缺失兜底：毛玻璃空白舱，不渲染 <img>、不补图。 */
function MissingCabin({ title, note, compact }: { title: string; note?: string; compact?: boolean }) {
  return (
    <div
      data-testid="flow-missing"
      className={`flex flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-black/[0.10] bg-white/45 text-center backdrop-blur-sm ${
        compact ? 'px-3 py-4' : 'px-4 py-7'
      }`}
    >
      <span className="grid h-8 w-8 place-items-center rounded-full bg-[#FBF1E4] text-[#8A4B00]">
        <TriangleAlert className="h-4 w-4" />
      </span>
      <p className="text-[12px] font-medium leading-5 text-apple-text">{title}</p>
      {note && <p className="max-w-[38ch] text-[10px] leading-4 text-apple-subtext">{note}</p>}
    </div>
  )
}

function fileBase(p: string): string {
  const parts = p.split('/')
  return parts[parts.length - 1] || p
}

function emptyStageCopy(status: string | null): { title: string; note: string } {
  if (status === 'running') {
    return { title: '等待 Worker 调度', note: '该环节尚未落盘产物，不补图、不推算。' }
  }
  if (status === 'failed') {
    return { title: '环节失败，无产物', note: 'state 未记录该环节的产物路径。' }
  }
  if (status === 'pending' || status === null || status === undefined) {
    return { title: '未触发', note: '该环节还没有执行记录。' }
  }
  return { title: '当前环节无真实产物输出', note: 'state 未记录该环节的产物路径，不补图、不推算。' }
}

/** 产物面板：只对 exists=true 且位于 jobs/ 下的文件渲染 img/video/audio。 */
function MediaPanel({ stage }: { stage: FlowStage }) {
  const artifacts = stage.artifacts ?? []
  if (artifacts.length === 0) {
    const copy = emptyStageCopy(stage.status)
    return <MissingCabin title={copy.title} note={copy.note} />
  }

  return (
    <div data-testid="flow-media" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {artifacts.map((artifact, index) => {
        const ok = artifact.exists && artifact.url
        const label = artifact.label ?? '产物'
        let preview: ReactNode
        if (ok && artifact.kind === 'image') {
          preview = (
            <img
              src={artifact.url as string}
              alt={`${label} · ${fileBase(artifact.path)}`}
              loading="lazy"
              className="h-32 w-full bg-apple-bg object-cover"
            />
          )
        } else if (ok && artifact.kind === 'video') {
          preview = (
            <video
              src={artifact.url as string}
              controls
              preload="metadata"
              className="h-32 w-full bg-black object-contain"
            />
          )
        } else if (ok && artifact.kind === 'audio') {
          preview = (
            <div className="flex h-32 items-center px-3">
              <audio src={artifact.url as string} controls preload="metadata" className="w-full" />
            </div>
          )
        } else {
          preview = <MissingCabin compact title="文件缺失（No Artifact / Missing File）" note="当前环节无真实产物输出，不补图、不推算。" />
        }

        return (
          <figure key={`${artifact.path}-${index}`} className="overflow-hidden rounded-xl border border-black/[0.05] bg-white">
            {preview}
            <figcaption className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5 px-2.5 py-1.5">
              <span className="min-w-0 truncate font-mono text-[10px] text-apple-text" title={artifact.path}>
                {label} · {fileBase(artifact.path)}
              </span>
              <span className={`shrink-0 text-[9px] ${ok ? 'text-apple-greenInk' : 'text-[#8A4B00]'}`}>
                {ok ? '存在' : '文件缺失'}
              </span>
            </figcaption>
          </figure>
        )
      })}
    </div>
  )
}

/** Prompt 面板：只显示 state 真实记录的 prompt（C/D 环节），无字段就显示缺失文案。 */
function PromptPanel({ stage }: { stage: FlowStage }) {
  const prompts = stage.prompts ?? []
  if (prompts.length === 0) {
    return (
      <MissingCabin
        title="（当前环节未生成 Prompt 或文件缺失）"
        note="state 里没有该环节的 prompt 字段，不显示示例参数。"
      />
    )
  }

  return (
    <div data-testid="flow-prompt" className="space-y-2">
      {prompts.slice(0, 6).map((prompt, index) => (
        <div key={`${prompt.shot_id ?? 'x'}-${index}`} className="overflow-hidden rounded-lg border border-black/[0.05]">
          <div className="flex flex-wrap items-baseline gap-x-2 bg-apple-bg/70 px-2.5 py-1 text-[10px] text-apple-subtext">
            <span className="num font-medium text-apple-text">shot {prompt.shot_id ?? '—'}</span>
            <span className="num">seed {prompt.seed ?? '—'}</span>
            <span className="ml-auto font-mono text-[9px]">{prompt.source}</span>
          </div>
          <pre className="max-h-40 overflow-auto px-2.5 py-2 font-mono text-[10px] leading-4 whitespace-pre-wrap break-words text-apple-text">
            {prompt.text}
          </pre>
          {prompt.negative && (
            <pre className="border-t border-black/[0.04] bg-[#FCFCFD] px-2.5 py-1.5 font-mono text-[10px] leading-4 whitespace-pre-wrap break-words text-apple-subtext">
              {`negative: ${prompt.negative}`}
            </pre>
          )}
        </div>
      ))}
      {prompts.length > 6 && (
        <p className="text-[10px] text-apple-subtext">仅显示前 6 条，共 {prompts.length} 条。</p>
      )}
    </div>
  )
}

/** Payload 面板：state 没有下发请求体字段，只给安全态，不显示示例参数。 */
function PayloadPanel() {
  return (
    <div data-testid="flow-payload">
      <pre className="max-h-40 overflow-auto rounded-lg border border-dashed border-black/[0.10] bg-white/45 px-3 py-2 font-mono text-[10px] leading-4 whitespace-pre-wrap break-words text-apple-subtext backdrop-blur-sm">
        {'（state 未落盘 Payload，无可显示的数据源）'}
      </pre>
      <p className="mt-1 text-[10px] leading-4 text-apple-subtext">不显示示例参数；有真实字段后才会出现代码块。</p>
    </div>
  )
}

/* ------------------------------- 主页面 ------------------------------- */

const DEFAULT_POLL_MS = 5000

export function FlowPage() {
  // #103：支持 /flow?job=<id> 深链；未指定时读默认 feed（最近一次 state）。
  const [selected, setSelected] = useState<string | null>(() => parseJobParam(window.location.search))
  const url = flowRequestUrl(selected)
  const { status, data, error, refreshing, updatedAt, refresh, retry } = useLiveJson<FlowResponse>(
    url,
    DEFAULT_POLL_MS
  )

  const jobs = data?.jobs ?? []
  const job = data?.job ?? null
  const logs: FlowLogs | null = data?.logs ?? null
  const [activeKey, setActiveKey] = useState<string | null>(null)

  /** 选中 job：状态 + URL 同步（null = 回到默认 feed）。 */
  const chooseJob = (id: string | null) => {
    setSelected(id)
    setActiveKey(null)
    const search = jobSearch(window.location.search, id)
    const target = `${window.location.pathname}${search}${window.location.hash}`
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`
    if (target !== current) {
      window.history.replaceState({ ...(window.history.state ?? {}) }, '', target)
    }
  }

  // 浏览器前进/后退：URL 决定选中的 job。
  useEffect(() => {
    const apply = () => {
      setSelected(parseJobParam(window.location.search))
      setActiveKey(null)
    }
    window.addEventListener('popstate', apply)
    return () => window.removeEventListener('popstate', apply)
  }, [])

  const activeIndex = useMemo(() => {
    if (!job) return -1
    const index = activeKey ? job.stages.findIndex((stage) => stage.key === activeKey) : -1
    return index >= 0 ? index : focusStageIndex(job.stages)
  }, [activeKey, job])
  const activeStage = job && activeIndex >= 0 ? job.stages[activeIndex] : null

  const doneCount = job ? job.stages.filter((stage) => stage.status === 'done').length : 0
  const failedCount = job ? job.stages.filter((stage) => stage.status === 'failed').length : 0
  const currentStage = job ? focusStageIndex(job.stages) : -1

  const decision = job?.decisions?.[0] ?? null
  const profile = job?.profile ?? null
  const semantics = job?.semantics ?? null
  // #97：选中 job 的状态/阶段只读 /api/snapshot，不再展示 state.stage 原始值。
  const snapshotJobId = resolveFlowJobId(selected, data)

  // #103：链路解释层全部由已有字段派生；缺失字段显式「未记录」，不补示例值。
  const contract = useJson<ContractResponse>('/api/contract')
  const links = useMemo(() => chainLinks(job?.stages), [job])
  const continuity = useMemo(
    () =>
      continuityFields({
        semantics: job?.semantics ?? null,
        shot_semantics: job?.shot_semantics ?? null,
        profile: job?.profile ?? null
      }),
    [job]
  )
  const prompts = useMemo(
    () =>
      job
        ? promptChain({
            profile: job.profile,
            profile_prompt: job.profile_prompt ?? null,
            stages: job.stages
          })
        : [],
    [job]
  )

  const shotColumns: Column<FlowShot>[] = [
    { key: 'shot', label: '镜头', className: 'num', cell: (row) => row.shot_id ?? '—' },
    { key: 'start', label: '起始', className: 'num', cell: (row) => (row.start === null ? '—' : `${row.start}s`) },
    { key: 'end', label: '结束', className: 'num', cell: (row) => (row.end === null ? '—' : `${row.end}s`) },
    {
      key: 'duration',
      label: '时长',
      className: 'num',
      cell: (row) => (row.duration_s === null ? '—' : `${row.duration_s}s`)
    }
  ]

  const frameColumns: Column<FlowFrame>[] = [
    { key: 'shot', label: '镜头', className: 'num', cell: (row) => row.shot_id ?? '—' },
    { key: 'ts', label: '时间戳', className: 'num', cell: (row) => (row.frame_ts === null ? '—' : `${row.frame_ts}s`) },
    {
      key: 'path',
      label: '路径',
      className: 'font-mono break-all',
      cell: (row) => row.path ?? '—'
    },
    {
      key: 'exists',
      label: '文件',
      cell: (row) =>
        row.exists ? (
          <span className="text-apple-greenInk">存在</span>
        ) : (
          <span className="text-[#B3261E]">文件缺失</span>
        )
    }
  ]

  const artifactColumns: Column<FlowArtifact>[] = [
    { key: 'path', label: '路径', className: 'font-mono break-all', cell: (row) => row.path },
    {
      key: 'exists',
      label: '文件',
      cell: (row) =>
        row.exists ? (
          <span className="text-apple-greenInk">存在</span>
        ) : (
          <span className="text-[#B3261E]">文件缺失</span>
        )
    }
  ]

  const decisionColumns: Column<Record<string, unknown>>[] = [
    { key: 'ts', label: '时间', className: 'num whitespace-nowrap', cell: (row) => text(row.ts) },
    { key: 'typology', label: 'typology', cell: (row) => text(row.typology) },
    { key: 'look', label: 'look', cell: (row) => text(row.look) },
    { key: 'confidence', label: '置信度', className: 'num', cell: (row) => text(row.confidence) },
    {
      key: 'hit_rule',
      label: 'hit_rule',
      className: 'max-w-[220px]',
      cell: (row) => (
        <span className="block truncate" title={text(row.hit_rule)}>
          {text(row.hit_rule)}
        </span>
      )
    }
  ]

  const lockEvents = (logs?.lock_events ?? []).slice(-10).reverse()

  return (
    <div className="page-enter">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em] sm:text-[32px]">自动编排监看</h1>
          <p className="mt-1.5 max-w-[64ch] text-sm leading-relaxed text-apple-subtext">
            看每条自动编排任务走到哪一步：环节状态、所用工具、产物与决策记录。文件缺失会明确标出，不补图、不推算。
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-[11px] text-apple-subtext">
            <span className="shrink-0">job</span>
            <select
              aria-label="选择 job"
              data-testid="flow-job-select"
              value={selected ?? job?.id ?? jobs[0]?.id ?? ''}
              onChange={(event) => chooseJob(event.target.value || null)}
              className="max-w-[240px] rounded-lg border border-apple-line bg-white px-2 py-1.5 text-xs text-apple-text shadow-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/40"
            >
              {jobs.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.id}
                </option>
              ))}
              <option value="b-track-s1">b-track-s1（无编排 state）</option>
            </select>
          </label>
          <button
            type="button"
            onClick={() => void refresh()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-apple-line bg-white px-2.5 py-1.5 text-[11px] font-medium text-apple-text shadow-soft transition-colors duration-200 hover:border-black/[0.12] focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/40"
          >
            <Refresh className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            刷新
          </button>
          <span className="num text-[10px] text-apple-subtext" title={job?.updated_at ?? undefined}>
            {job ? `state 更新 ${formatTime(job.updated_at)}` : '—'}
            {updatedAt ? ` · 读取 ${clockOf(updatedAt)}` : ''}
          </span>
        </div>
      </div>

      {snapshotJobId && (
        <div className="mt-4 flex flex-wrap items-center gap-2" data-testid="flow-snapshot">
          <SnapshotStatusStage
            source="studio"
            jobId={snapshotJobId}
            statusTestId="snapshot-status"
            stageTestId="snapshot-stage"
            className="text-apple-subtext"
          />
        </div>
      )}

      {status === 'loading' && (
        <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-busy="true" aria-label="正在读取编排 state">
          {[0, 1, 2, 3].map((index) => (
            <div key={index} className="card h-[112px] animate-pulse p-4">
              <div className="h-3 w-20 rounded bg-[#ECECEF]" />
              <div className="mt-3 h-6 w-24 rounded bg-[#ECECEF]" />
              <div className="mt-3 h-3 w-2/3 rounded bg-[#F2F2F4]" />
            </div>
          ))}
        </div>
      )}

      {status === 'error' && (
        <div className="card mt-6 flex flex-wrap items-center justify-between gap-3 p-5" role="alert">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 grid h-8 w-8 place-items-center rounded-full bg-[#FCEDEB] text-[#B3261E]">
              <Alert className="h-4 w-4" />
            </span>
            <div>
              <p className="text-sm font-medium">编排 state 读取失败</p>
              <p className="mt-1 text-xs leading-relaxed text-apple-subtext">{error}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void retry()}
            className="rounded-lg bg-apple-text px-3 py-1.5 text-xs font-medium text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
          >
            重试
          </button>
        </div>
      )}

      {data && data.available === false && (
        <div className="card mt-6 p-6">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 grid h-8 w-8 place-items-center rounded-full bg-[#F0F0F2] text-apple-subtextAlt">
              <TriangleAlert className="h-4 w-4" />
            </span>
            <div>
              <h2 className="text-sm font-semibold">仓库未配置</h2>
              <p className="mt-1 text-xs leading-relaxed text-apple-subtext">
                {data.reason ?? 'kex repo not configured'}：设置 <span className="num">KEX_REPO_ROOT</span> 后此页会显示真实的 state / decisions / logs。
              </p>
            </div>
          </div>
        </div>
      )}

      {data && data.available !== false && !job && (
        <div className="card mt-6 p-6" data-testid="flow-empty">
          <h2 className="text-sm font-semibold">没有可展示的编排 state</h2>
          <p className="mt-1 text-xs leading-relaxed text-apple-subtext">
            <span data-testid="flow-empty-reason">
              {data.message ?? 'state/ 下没有 job'}（{data.reason ?? 'job:null'}）
            </span>
            。此页不构造虚构节点；换一个 job 或等 state 落盘后再看。
          </p>
          {selected && (
            <button
              type="button"
              onClick={() => chooseJob(null)}
              className="mt-3 rounded-lg border border-apple-line bg-white px-3 py-1.5 text-[11px] font-medium shadow-soft"
            >
              回到最新 job
            </button>
          )}
        </div>
      )}

      {job && (
        <>
          {error && (
            <div
              className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#F3D3CF] bg-[#FCEDEB] px-3 py-2 text-[11px] text-[#B3261E]"
              role="status"
            >
              <span>刷新失败：{error}（保留上次数据）</span>
              <button type="button" onClick={() => void retry()} className="font-medium underline">
                重试
              </button>
            </div>
          )}

          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4" data-equal-grid data-stagger>
            <Stat
              label="环节进度"
              value={`${doneCount}/${job.stages.length}`}
              note={failedCount > 0 ? `${failedCount} 个环节失败` : `当前 ${job.stages[currentStage]?.key ?? '—'}`}
              accent={failedCount > 0 ? '#FF3B30' : '#30A14E'}
            />
            <Stat
              label="阶段总耗时"
              value={job.duration_s === null ? '无数据' : `${job.duration_s.toFixed(1)}s`}
              note="stages[].duration_s 之和"
            />
            <Stat label="镜头" value={job.shots.length} note={`shots 表 ${job.shots.length} 行`} />
            <Stat label="关键帧" value={job.frames.length} note={`frames 表 ${job.frames.length} 行`} accent="#0071E3" />
          </div>

          <details className="card mt-4 p-4" data-testid="flow-tour" open>
            <summary className="cursor-pointer list-none text-[13px] font-semibold leading-5 focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/40">
              <span className="inline-flex items-center gap-1.5">
                <span className="grid h-5 w-5 place-items-center rounded-full bg-[#F0F6FF] text-[10px] font-semibold text-apple-blueInk">
                  ?
                </span>
                3 分钟看懂这条链路
                <span className="text-[10px] font-normal text-apple-subtext">（点标题展开 / 收起）</span>
              </span>
            </summary>
            <div className="mt-2 grid gap-2 text-[11px] leading-5 text-apple-subtext md:grid-cols-2">
              <p>
                <span className="font-medium text-apple-text">① 先看图例：</span>蓝色/绿色数字是<b className="font-medium text-apple-text">本 job 真实记录</b>的状态，
                灰字「未记录 / 未收录」表示 state 或文档里确实没有这一项，页面不会补示例值。
              </p>
              <p>
                <span className="font-medium text-apple-text">② 再看 6 环节：</span>导演 Brief → 分镜/场景 → 关键帧 → 视频片段 → 插帧/增强 → 组装交付，
                每行写清谁在做、输入什么、产出什么、验收看什么，并标出本 job 的进度。
              </p>
              <p>
                <span className="font-medium text-apple-text">③ 然后看环节与节点：</span>环节卡是「谁 / 做什么 / 产出 / 失败会怎样」；
                ComfyUI 节点表是每一步的职责、关键参数怎么读、调错时的典型表现。
              </p>
              <p>
                <span className="font-medium text-apple-text">④ 最后看连续性 7 项与提示词链 4 段：</span>跨镜头的角色 / 服装 / 道具 / 光线 / 色温 / 机位 / 背景是否记录；
                从导演 brief 到 negative prompt 每一段的来源字段。
              </p>
            </div>
          </details>

          <section className="mt-4" data-testid="flow-chain" aria-label="6 环节全链路总览">
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <h2 className="text-[18px] font-semibold leading-6 tracking-[-0.01em]">全链路 6 环节</h2>
              <p className="text-[11px] text-apple-subtext">角色 / 做什么 / 输入 / 产出 / 验收点 · 进度只由 stages[].status 派生</p>
            </div>
            <ol className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3" data-stagger>
              {links.map((link, index) => (
                <li key={link.id} className="card flex min-w-0 flex-col p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-baseline gap-2">
                      <span className="num shrink-0 text-[11px] font-semibold text-apple-subtext">
                        {String(index + 1).padStart(2, '0')}
                      </span>
                      <h3 className="text-[15px] font-semibold leading-5 tracking-tight">{link.title}</h3>
                    </div>
                    <span className="shrink-0 rounded-full bg-[#F0F0F2] px-2 py-0.5 text-[10px] font-medium text-apple-subtextAlt">
                      {link.role}
                    </span>
                  </div>
                  <dl className="mt-2 flex-1 space-y-1 text-[11px] leading-5">
                    {[
                      ['做什么', link.doing],
                      ['输入', link.input],
                      ['产出', link.output],
                      ['验收点', link.check]
                    ].map(([label, value]) => (
                      <div key={label} className="flex items-start gap-2">
                        <dt className="w-[3.2em] shrink-0 text-apple-subtext">{label}</dt>
                        <dd className="min-w-0 break-words">{value}</dd>
                      </div>
                    ))}
                  </dl>
                  <div className="mt-auto flex flex-wrap items-baseline gap-2 border-t border-apple-line/70 pt-2 text-[10px] leading-4">
                    <span className="font-medium text-apple-text">{link.current}</span>
                    <span className="text-apple-subtext">来源 {link.source}</span>
                  </div>
                </li>
              ))}
            </ol>
          </section>

          <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_400px] xl:items-start">
            <MonitorPanel job={job} />
            <ContractArmor status={contract.status} data={contract.data} error={contract.error} />
          </div>

          <section className="mt-4">
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <h2 className="text-[18px] font-semibold leading-6 tracking-[-0.01em]">编排环节</h2>
              <p className="text-[11px] text-apple-subtext">
                A–F 状态取 <span className="num">stages.&lt;S&gt;.status</span>，点节点看工具链 / 产物 / Prompt / Payload
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7" data-equal-grid data-stagger>
              {job.stages.map((stage, index) => {
                const shown = stageDisplayStatus(stage)
                const tone = toneOf(shown)
                const active = index === activeIndex
                const missing = missingCountOf(stage)
                return (
                  <button
                    key={stage.key}
                    type="button"
                    aria-pressed={active}
                    data-testid={`flow-stage-${stage.key}`}
                    data-stage-status={shown ?? 'none'}
                    onClick={() => setActiveKey(stage.key)}
                    className={`card card-interactive relative flex h-full min-w-0 flex-col overflow-hidden p-3 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50 ${
                      active ? 'ring-2 ring-apple-blue/40' : ''
                    } ${shown === 'failed' ? 'ring-1 ring-[#F3D3CF]' : ''} ${
                      shown === 'missing' ? 'ring-1 ring-[#F0D9BC]' : ''
                    }`}
                  >
                    <span
                      aria-hidden="true"
                      className={`absolute inset-x-0 top-0 h-[3px] ${tone.bar} ${
                        stage.status === 'running' ? 'flow-node-pulse' : ''
                      }`}
                    />
                    <div className="flex items-center justify-between gap-1">
                      <span className="num text-[11px] font-semibold text-apple-subtext">{stage.key}</span>
                      <StatusPill status={shown} />
                    </div>
                    <p className="mt-1 text-[12px] font-medium leading-5">{STAGE_LABEL[stage.key] ?? '未命名环节'}</p>
                    <p className="mt-auto pt-2 text-[10px] leading-4 text-apple-subtext">
                      {stage.tools.length} 工具 · {stage.duration_s === null ? '—' : `${stage.duration_s.toFixed(1)}s`}
                      {missing > 0 && <span className="text-[#8A4B00]"> · {missing} 文件缺失</span>}
                    </p>
                  </button>
                )
              })}
            </div>
          </section>

          <section className="mt-4" data-testid="flow-stage-explain" aria-label="环节白话说明">
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <h2 className="text-[18px] font-semibold leading-6 tracking-[-0.01em]">环节在做什么</h2>
              <p className="text-[11px] text-apple-subtext">四个白话问题：谁在做 / 在做什么 / 产出什么 / 失败会怎样</p>
            </div>
            {job.stages.length === 0 && (
              <p
                data-testid="flow-stage-empty-note"
                className="rounded-lg border border-apple-line bg-apple-bg/60 px-3 py-2 text-[11px] leading-5 text-apple-subtext"
              >
                该 job 的 state 没有 stages 记录：不构造虚构环节；换一个有 stages 的 job，或等阶段落盘后再看。
              </p>
            )}
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3" data-stagger>
              {job.stages.map((stage) => {
                const explain = stageExplain(stage.key)
                return (
                  <article
                    key={stage.key}
                    className="card flex min-w-0 flex-col p-4"
                    data-testid={`flow-stage-explain-${stage.key || 'empty'}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex min-w-0 items-baseline gap-2">
                        <span className="num shrink-0 text-[11px] font-semibold text-apple-subtext">{stage.key || '—'}</span>
                        <h3 className="min-w-0 break-words text-[13px] font-semibold leading-5">
                          {explain.known ? explain.label : `${stage.key || '空 key'} · 未收录说明`}
                        </h3>
                      </div>
                      <StatusPill status={stageDisplayStatus(stage)} />
                    </div>
                    <dl className="mt-2 flex-1 space-y-1.5 text-[11px] leading-5">
                      {[
                        ['谁在做', explain.role],
                        ['在做什么', explain.doing],
                        ['产出什么', explain.output],
                        ['失败会怎样', explain.failure]
                      ].map(([label, value]) => (
                        <div key={label}>
                          <dt className="text-[10px] font-medium text-apple-subtext">{label}</dt>
                          <dd className="break-words">{value}</dd>
                        </div>
                      ))}
                    </dl>
                    <p className="mt-2 border-t border-apple-line/70 pt-2 text-[10px] leading-4 text-apple-subtext">
                      {explain.known ? (
                        <>输入 {explain.input} · 来源 {explain.source}</>
                      ) : (
                        <>
                          未收录说明：文档未登记该 key，保留原始字段 key={stage.key || '（空）'} · status=
                          {stage.status ?? 'null'} · duration_s={stage.duration_s ?? 'null'} · tools=
                          {stage.tools.length} 个
                        </>
                      )}
                    </p>
                  </article>
                )
              })}
            </div>
          </section>

          <div className="mt-4 grid gap-4 xl:grid-cols-2 xl:items-start">
            <Section
              title="场景连续性检查"
              testId="flow-continuity"
              hint={`7 项 · 已记录 ${continuity.filter((row) => row.recorded).length} 项`}
            >
              <p className="mb-2 text-[10px] leading-4 text-apple-subtext">
                只读 state 已记录的语义字段；没有的写「未记录」，不推测、不补默认值。
              </p>
              <ul className="space-y-1.5">
                {continuity.map((row) => (
                  <li
                    key={row.key}
                    className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 rounded-lg bg-apple-bg/70 px-2.5 py-1.5 text-[11px] leading-5"
                    data-continuity-recorded={row.recorded ? 'true' : 'false'}
                  >
                    <span className="w-[2.6em] shrink-0 text-apple-subtext">{row.label}</span>
                    {row.recorded ? (
                      <span className="min-w-0 break-words font-medium">{row.values.join(' / ')}</span>
                    ) : (
                      <span className="rounded-full bg-[#F0F0F2] px-2 py-0.5 text-[10px] text-apple-subtextAlt">未记录</span>
                    )}
                    <span className="min-w-0 break-all text-[10px] text-apple-subtext">
                      {row.recorded ? row.sources.join(' · ') : row.note}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>

            <Section
              title="提示词链"
              testId="flow-prompt-chain"
              hint={`4 段 · 已记录 ${prompts.filter((item) => item.text).length} 段`}
            >
              <ul className="space-y-2">
                {prompts.map((segment, index) => (
                  <li key={segment.id} className="min-w-0 rounded-lg border border-black/[0.05] bg-apple-bg/60 px-2.5 py-2">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="num text-[10px] font-semibold text-apple-subtext">{String(index + 1).padStart(2, '0')}</span>
                      <span className="text-[12px] font-medium leading-5">{segment.label}</span>
                      <span className="min-w-0 break-all text-[10px] text-apple-subtext">来源 {segment.source}</span>
                    </div>
                    {segment.text ? (
                      <p className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[10.5px] leading-4">
                        {segment.text}
                      </p>
                    ) : (
                      <p className="mt-1 text-[10px] leading-4 text-apple-subtext">{segment.note ?? '未记录'}</p>
                    )}
                  </li>
                ))}
              </ul>
            </Section>
          </div>

          <Section
            title="ComfyUI 节点说明"
            testId="flow-node-explain-section"
            hint={
              contract.data?.workflow?.nodes?.length
                ? `${contract.data.workflow.nodes.length} 个节点 · ${contract.data.workflow.name}`
                : '未读到契约 workflow'
            }
          >
            <NodeExplainList workflow={contract.data?.workflow} status={contract.status} error={contract.error} />
          </Section>

          <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_520px] xl:items-start">
            <div className="space-y-4">
              {(semantics || profile || decision) && (
                <section>
                  <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <h2 className="text-[18px] font-semibold leading-6 tracking-[-0.01em]">Agent 节点</h2>
                    <p className="text-[11px] text-apple-subtext">只显示 profile / decisions / semantics 里已有的字段</p>
                  </div>
                  <div className="grid gap-3 md:grid-cols-3" data-equal-grid data-stagger>
                    {semantics && (
                      <AgentCard
                        title="语义理解"
                        hint="semantics"
                        kind="semantics"
                        rows={[
                          [
                            '主体',
                            `${text(nested(semantics, 'subject', 'count'))} · ${text(nested(semantics, 'subject', 'kind'))}`
                          ],
                          [
                            '情绪',
                            `${text(nested(semantics, 'emotion', 'valence'))} / ${text(nested(semantics, 'emotion', 'arousal'))}`
                          ],
                          [
                            '光照',
                            `${text(nested(semantics, 'lighting', 'temp_k'))}K · ${text(nested(semantics, 'lighting', 'quality'))}`
                          ],
                          [
                            '运动',
                            `${text(nested(semantics, 'motion', 'camera'))} · ${text(nested(semantics, 'motion', 'intensity'))}`
                          ],
                          ['置信度', text(semantics.confidence)]
                        ]}
                      />
                    )}
                    {(profile || decision) && (
                      <AgentCard
                        title="导演决策"
                        hint={decision ? `decisions ${job.decisions.length} 行` : 'profile'}
                        kind="profile"
                        rows={[
                          ['look', text(profile?.look ?? decision?.look)],
                          ['类型', text(profile?.typology ?? decision?.typology ?? profile?.requested_typology)],
                          ['置信度', text(profile?.confidence ?? decision?.confidence)],
                          ['命中规则', text(decision?.hit_rule ?? profile?.reason)],
                          ['fallback', text(profile?.fallback ?? decision?.fallback)]
                        ]}
                      />
                    )}
                    <AgentCard
                      title="QC 裁决"
                      hint="quality_gate"
                      kind="quality_gate"
                      rows={[
                        ['判定', job.quality_gate === null ? '未执行' : text(job.quality_gate)],
                        [
                          '质量项',
                          Array.isArray(job.quality) ? (job.quality.length ? `${job.quality.length} 项` : '无数据') : text(job.quality)
                        ],
                        ['render_report', job.reports.render ? '已读取' : '无'],
                        ['assemble_report', job.reports.assemble ? '已读取' : '无']
                      ]}
                    />
                  </div>
                </section>
              )}

              <Section title="运行观测" hint="probe · cold_warm · reports">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <p className="mb-1 text-[10px] font-medium text-apple-subtext">视频探针</p>
                    <Kv
                      rows={[
                        ['编码', text(nested(job.probe, 'codec'))],
                        [
                          '分辨率',
                          job.probe
                            ? `${text(nested(job.probe, 'width'))}×${text(nested(job.probe, 'height'))}`
                            : '—'
                        ],
                        ['帧率', text(nested(job.probe, 'fps'))],
                        ['时长', text(nested(job.probe, 'duration_s'))],
                        ['音轨', text(nested(job.probe, 'has_audio'))]
                      ]}
                    />
                  </div>
                  <div>
                    <p className="mb-1 text-[10px] font-medium text-apple-subtext">冷 / 热启动</p>
                    <Kv
                      rows={[
                        ['冷启动', formatMs(nested(job.cold_warm, 'cold_ms') as number | null)],
                        ['热启动', formatMs(nested(job.cold_warm, 'warm_ms') as number | null)],
                        ['模型', text(nested(job.cold_warm, 'model'))]
                      ]}
                    />
                  </div>
                </div>
              </Section>
            </div>

            <aside className="space-y-4" aria-label="环节只读详情">
              <Section
                title="环节详情"
                testId="flow-detail"
                hint={activeStage ? `更新 ${formatTime(activeStage.updated_at)}` : '未选择'}
                action={
                  <span className="flex items-center gap-1.5 text-[10px] text-apple-subtext">
                    <Flow className="h-3.5 w-3.5" />
                    只读
                  </span>
                }
              >
                {activeStage ? (
                  <>
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-[15px] font-semibold">{stageName(activeStage.key)}</h3>
                      <StatusPill status={stageDisplayStatus(activeStage)} />
                      <span className="num text-[10px] text-apple-subtext">
                        {activeStage.duration_s === null ? '—' : `${activeStage.duration_s.toFixed(2)}s`}
                      </span>
                    </div>
                    <p className="mt-3 mb-1 text-[10px] font-medium text-apple-subtext">工具链</p>
                    <ToolsTable tools={activeStage.tools} />

                    <p className="mt-3 mb-1 text-[10px] font-medium text-apple-subtext">产物 / 媒体</p>
                    <MediaPanel stage={activeStage} />

                    <p className="mt-3 mb-1 text-[10px] font-medium text-apple-subtext">Prompt</p>
                    <PromptPanel stage={activeStage} />

                    <p className="mt-3 mb-1 text-[10px] font-medium text-apple-subtext">Payload</p>
                    <PayloadPanel />
                  </>
                ) : (
                  <p className="text-xs text-apple-subtext">选择上方任一环节查看工具链、产物、Prompt 与日志。</p>
                )}
              </Section>

              <Section title="镜头" testId="flow-shots" hint={`${job.shots.length} 行`}>
                <DataTable columns={shotColumns} rows={job.shots} rowKey={(row, index) => `${row.shot_id ?? index}`} empty="state 里没有 shots。" />
              </Section>

              <Section title="关键帧" testId="flow-frames" hint={`${job.frames.length} 行`}>
                <DataTable
                  columns={frameColumns}
                  rows={job.frames}
                  rowKey={(row, index) => `${row.shot_id ?? 'x'}-${row.frame_ts ?? index}`}
                  empty="state 里没有 frames。"
                />
              </Section>

              <Section title="产物" testId="flow-artifacts" hint={`${job.artifacts.length} 项`}>
                <DataTable
                  columns={artifactColumns}
                  rows={job.artifacts}
                  rowKey={(row, index) => `${row.path}-${index}`}
                  empty="state 里没有 artifacts。"
                />
              </Section>

              <Section title="决策" testId="flow-decisions" hint={`job 级 · ${job.decisions.length} 行`}>
                <DataTable
                  columns={decisionColumns}
                  rows={job.decisions.slice(0, 20)}
                  rowKey={(row, index) => `${text(row.ts)}-${index}`}
                  empty="没有 decisions/<job>.jsonl。"
                />
              </Section>

              <Section
                title="worker 日志"
                testId="flow-logs"
                hint={logs ? `全局 · ${logs.worker.lines.length} 行（尾 200）` : '无'}
                action={
                  <span className="flex items-center gap-1 text-[10px] text-apple-subtext">
                    <Clock className="h-3 w-3" />
                    tail
                  </span>
                }
              >
                <p className="mb-1.5 text-[10px] leading-4 text-apple-subtext">
                  state 只记全局 worker 日志、没有按环节切分的日志字段；点击节点不改变这里的全局 tail。
                </p>
                {logs?.worker.lines.length ? (
                  <>
                    <p className="mb-1.5 font-mono text-[10px] break-all text-apple-subtext">{logs.worker.path}</p>
                    <pre className="max-h-56 overflow-auto rounded-lg bg-apple-bg px-3 py-2 font-mono text-[10px] leading-4 whitespace-pre-wrap break-words text-apple-text">
                      {logs.worker.lines.join('\n')}
                    </pre>
                  </>
                ) : (
                  <p className="text-xs text-apple-subtext">没有读到 worker 日志（{logs?.worker.path ?? '—'}）。</p>
                )}
              </Section>

              <Section title="lock 事件" testId="flow-locks" hint={`${logs?.lock_events.length ?? 0} 条 · 最近 10`}>
                {lockEvents.length ? (
                  <ul className="space-y-1.5 text-[11px] leading-5">
                    {lockEvents.map((event, index) => (
                      <li key={`${text(event.ts)}-${index}`} className="flex flex-wrap items-baseline gap-x-2 rounded-lg bg-apple-bg/70 px-2 py-1">
                        <span className="num text-[10px] text-apple-subtext">{text(event.ts)}</span>
                        <span className="font-medium">{text(event.event)}</span>
                        <span className="text-apple-subtext">{text(event.job)}</span>
                        <span className="ml-auto num text-[10px] text-apple-subtext">pid {text(event.pid)}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-apple-subtext">state/.locks/events.jsonl 没有事件。</p>
                )}
              </Section>
            </aside>
          </div>
        </>
      )}
    </div>
  )
}

function MonitorPanel({ job }: { job: FlowJob }) {
  const total = job.stages.length
  const done = job.stages.filter((stage) => stage.status === 'done').length
  const pct = total ? Math.round((done / total) * 100) : 0
  const fps = nested(job.probe, 'fps')
  const fpsText = typeof fps === 'number' ? fps.toFixed(Number.isInteger(fps) ? 0 : 2) : text(fps)

  return (
    <section aria-label="渲染监看" data-testid="flow-monitor" className="glass-dark rounded-[26px] p-2.5">
      <div className="relative flex aspect-video flex-col overflow-hidden rounded-[20px] bg-[#0A0A0C]">
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <span className="grid h-12 w-12 place-items-center rounded-2xl bg-white/[0.06] text-white/55 ring-1 ring-inset ring-white/10">
            <Film className="h-6 w-6" />
          </span>
          <p className="text-[13px] font-medium text-white/80">暂无成片画面</p>
          <p className="max-w-[46ch] text-[11px] leading-5 text-white/40">
            state 只记录本地文件路径，没有浏览器可播的成片 / 封面地址；此处不构造占位画面。
          </p>
          <p className="num mt-1 text-[10px] text-white/35">
            {job.shots.length} 镜头 · {job.frames.length} 关键帧 · {total} 环节
          </p>
        </div>

        <div className="glass-toolbar m-2 mt-0 rounded-2xl px-3 py-2.5 text-white">
          <div className="flex items-center gap-3">
            <span className="flex shrink-0 items-center gap-1.5 text-[10px] font-medium text-white/70">
              <Flow className="h-3.5 w-3.5" />
              环节完成
            </span>
            <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-white/15">
              <div
                className="h-full rounded-full bg-[#30D158] transition-[width] duration-200 ease-apple"
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="num shrink-0 text-[10px] text-white/75">
              {done}/{total}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
            <span className="num inline-flex items-baseline gap-1 text-[10px] text-white/50">
              FPS <span className="text-[11px] text-white/85">{fpsText}</span>
            </span>
            <span className="num inline-flex items-baseline gap-1 text-[10px] text-white/50">
              剩余 <span className="text-[11px] text-white/85">—</span>
            </span>
            <span className="num inline-flex items-baseline gap-1 text-[10px] text-white/50">
              进度 <span className="text-[11px] text-white/85">{pct}%</span>
            </span>
            <span
              className="inline-flex items-center gap-2 rounded-lg border border-dashed border-[#0A84FF]/45 px-1.5 py-0.5 text-[10px] text-white/50"
              title="flow 接口没有骨架 / 边缘数据，开关不可用"
            >
              Canny 骨架
              <span className="switch-track bg-white/15" role="switch" aria-checked="false" aria-disabled="true">
                <span className="switch-knob" />
              </span>
              <span className="text-white/35">暂无骨架数据</span>
            </span>
          </div>
        </div>
      </div>
      <p className="px-2 pt-2 pb-1 text-[10px] leading-4 text-white/35">
        FPS 取 probe.fps（成片帧率）；渲染进度取 stages 完成数；剩余时间无可用字段。
      </p>
    </section>
  )
}

function ContractArmor({
  status,
  data,
  error
}: {
  status: 'loading' | 'ready' | 'error'
  data: ContractResponse | null
  error: string | null
}) {
  const workflow = data?.workflow
  const params = workflow?.params
  const gateItems = data?.gate?.items ?? []
  const denoise = params?.denoise ?? null

  return (
    <section aria-label="契约控制" data-testid="flow-contract-armor" className="glass-panel overflow-hidden rounded-card">
      <header className="flex items-start justify-between gap-3 border-b border-black/[0.04] px-4 py-3.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] bg-apple-bg text-apple-text ring-1 ring-inset ring-black/[0.04]">
            <Shield className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold tracking-tight">Contract Armor</h2>
            <p className="truncate text-[10px] text-apple-subtext" title={data?.meta?.root}>
              {workflow?.name ?? data?.meta?.root ?? '—'}
            </p>
          </div>
        </div>
        <span className="shrink-0 rounded-full bg-[#F0F0F2] px-2 py-0.5 text-[10px] font-medium text-apple-subtextAlt">只读</span>
      </header>

      {status === 'loading' && <div className="h-[260px] animate-pulse bg-[#FAFAFC]" />}
      {status === 'error' && <p className="px-4 py-5 text-xs text-[#B3261E]">契约读取失败：{error}</p>}
      {data && data.available === false && (
        <p className="px-4 py-5 text-xs leading-relaxed text-apple-subtext">
          {data.reason ?? 'kex repo not configured'}：设置 <span className="num">KEX_REPO_ROOT</span> 后显示真实契约。
        </p>
      )}

      {data && data.available !== false && (
        <div className="space-y-4 px-4 py-4">
          <div>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="font-mono text-[11px] font-medium">KEX_D_REUSE_SOURCE</p>
                <p className="mt-0.5 text-[10px] leading-4 text-apple-subtext">锁定 C 阶段结构，防重绘糊化</p>
              </div>
              <span
                className="switch-track shrink-0 bg-[#E2E2E6]"
                role="switch"
                aria-checked="false"
                aria-disabled="true"
                title="契约 API 未提供该开关状态与写接口"
              >
                <span className="switch-knob" />
              </span>
            </div>
            <p className="mt-1 text-[10px] leading-4 text-apple-subtext">未暴露开关状态 / 写接口，禁用。</p>
          </div>

          <div>
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-[11px] font-medium">Denoise 重绘幅度</p>
              <span className="num text-[11px] text-apple-text">{denoise == null ? '—' : denoise.toFixed(2)}</span>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={denoise ?? 0}
              disabled
              aria-label="Denoise 重绘幅度（只读，来自契约 workflow）"
              className="range-readonly mt-2 w-full"
            />
            <div className="mt-1 flex justify-between text-[9px] leading-4 text-apple-subtext">
              <span>0.30 微动</span>
              <span>0.60 黄金离线解</span>
              <span>1.00 废片坍塌</span>
            </div>
          </div>

          <div>
            <p className="text-[11px] font-medium">单镜头截断分段</p>
            <div className="mt-1.5 flex rounded-[10px] bg-[#F0F0F2] p-0.5" role="group" aria-label="单镜头截断分段（只读）">
              <span className="flex-1 rounded-[8px] px-2 py-1.5 text-center text-[10px] font-medium text-apple-text">
                3.0s 黄金截断 · 72 帧
              </span>
              <span className="flex-1 rounded-[8px] px-2 py-1.5 text-center text-[10px] text-apple-subtext">5.0s · 尾段易衰减</span>
            </div>
            <p className="mt-1 text-[10px] leading-4 text-apple-subtext">无写接口，仅展示既有分段口径。</p>
          </div>

          <div className="rounded-xl bg-apple-bg/70 px-3 py-2.5">
            <p className="text-[10px] font-medium text-apple-subtext">交付门禁</p>
            {gateItems.length ? (
              <ul className="mt-1.5 space-y-1">
                {gateItems.slice(0, 4).map((item) => (
                  <li key={item.key} className="flex items-baseline justify-between gap-2 text-[10px] leading-4">
                    <span className="min-w-0 truncate text-apple-text" title={item.name}>
                      {item.name}
                    </span>
                    <span className="num shrink-0 text-apple-subtext">{item.threshold ?? '—'}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1.5 text-[10px] text-apple-subtext">无门禁条目</p>
            )}
            <p className="num mt-1.5 text-[9px] text-apple-subtext">
              {gateItems.length} 条 · 完整契约见「渲染工作台与契约」
            </p>
          </div>

          <dl className="grid grid-cols-3 gap-2 text-center">
            {[
              ['画布', params ? `${text(params.width)}×${text(params.height)}` : '—'],
              ['帧数', params ? text(params.length) : '—'],
              ['FPS', params ? text(params.fps) : '—']
            ].map(([label, value]) => (
              <div key={label} className="rounded-xl border border-black/[0.04] px-2 py-2">
                <dt className="text-[9px] text-apple-subtext">{label}</dt>
                <dd className="num mt-0.5 text-[11px] font-medium">{value}</dd>
              </div>
            ))}
          </dl>

          <Link
            to="/pipeline"
            data-testid="flow-nodegraph-link"
            className="inline-flex items-center gap-1 rounded-md text-[10px] font-medium leading-4 text-apple-blueInk transition-colors duration-200 hover:text-apple-blue focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/40"
          >
            节点图见 /pipeline →
          </Link>
        </div>
      )}
    </section>
  )
}

function AgentCard({
  title,
  hint,
  rows,
  kind
}: {
  title: string
  hint: string
  rows: Array<[string, ReactNode]>
  /** #103：节点职责 / 参数读法 / 调错表现（未知 kind 显示未收录说明）。 */
  kind?: string
}) {
  const explain = kind ? agentNodeExplain(kind) : null
  return (
    <div className="card flex h-full min-w-0 flex-col p-4" data-testid={kind ? `flow-agent-${kind}` : undefined}>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-[13px] font-semibold leading-5">{title}</h3>
        <span className="shrink-0 text-[10px] text-apple-subtext">{hint}</span>
      </div>
      <div className="mt-2 flex-1">
        <Kv rows={rows} />
      </div>
      {explain && (
        <dl className="mt-2 space-y-1 border-t border-apple-line/70 pt-2 text-[10px] leading-4">
          {[
            ['职责', explain.duty],
            ['参数怎么读', explain.params],
            ['调错表现', explain.failure]
          ].map(([label, value]) => (
            <div key={label} className="flex items-start gap-2">
              <dt className="w-[4.6em] shrink-0 text-apple-subtext">{label}</dt>
              <dd className="min-w-0 break-words">{value}</dd>
            </div>
          ))}
          <p className="text-apple-subtext">来源 {explain.source}</p>
        </dl>
      )}
    </div>
  )
}

/** #103：ComfyUI 节点说明表。行数 = 契约 workflow.nodes，未收录的 class_type 保留 inputs 原值。 */
function NodeExplainList({
  workflow,
  status,
  error
}: {
  workflow?: ContractWorkflow
  status: 'loading' | 'ready' | 'error'
  error: string | null
}) {
  if (status === 'loading') {
    return <p className="text-xs text-apple-subtext">正在读取契约 workflow…</p>
  }
  if (status === 'error') {
    return <p className="text-xs leading-relaxed text-[#B3261E]">契约读取失败：{error}</p>
  }
  if (!workflow || workflow.available === false) {
    return <p className="text-xs leading-relaxed text-apple-subtext">未读到契约 workflow，节点说明暂不可用。</p>
  }
  if (workflow.nodes.length === 0) {
    return <p className="text-xs leading-relaxed text-apple-subtext">契约 workflow 没有节点记录。</p>
  }

  return (
    <ul className="space-y-1.5" data-node-count={workflow.nodes.length}>
      {workflow.nodes.map((node: WorkflowNode) => {
        const explain = nodeExplain(node.class_type)
        return (
          <li
            key={node.id}
            data-testid="flow-node-explain"
            className="min-w-0 rounded-lg border border-black/[0.05] bg-apple-bg/60 px-2.5 py-2"
          >
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="num text-[10px] text-apple-subtext">#{node.id}</span>
              <span className="min-w-0 break-all font-mono text-[11px] font-medium">{node.class_type}</span>
              {!explain.known && (
                <span className="rounded-full bg-[#F0F0F2] px-2 py-0.5 text-[10px] text-apple-subtextAlt">未收录说明</span>
              )}
            </div>
            <dl className="mt-1 grid gap-x-3 gap-y-1 text-[10px] leading-4 md:grid-cols-3">
              {[
                ['职责', explain.duty],
                ['参数怎么读', explain.params],
                ['调错表现', explain.failure]
              ].map(([label, value]) => (
                <div key={label} className="min-w-0">
                  <dt className="text-apple-subtext">{label}</dt>
                  <dd className="break-words">{value}</dd>
                </div>
              ))}
            </dl>
            {!explain.known && (
              <p className="mt-1 break-all font-mono text-[10px] leading-4 text-apple-subtext">
                inputs: {JSON.stringify(node.inputs)}
              </p>
            )}
          </li>
        )
      })}
    </ul>
  )
}
