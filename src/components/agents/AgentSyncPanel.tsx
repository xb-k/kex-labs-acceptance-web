/**
 * #133 Agent / Skill 库同步：状态卡 + 只读清单。
 *
 * 表现层只做「看见状态 / 看见来源」，不提供任何「运行」入口 —— 清单是只读目录，
 * 导入的内容不会被执行。状态卡与清单都是纯 props 组件，便于 SSR 单测。
 */
import { AsyncStatusLine } from '../ui'
import { DataTable, type Column } from '../DataTable'
import { ExternalLink, Refresh, Shield, TriangleAlert } from '../icons'
import { primaryButton } from './agents-utils'
import {
  describeSyncCounts,
  describeSyncError,
  formatSyncStamp,
  summarizeSync,
  warningLabel,
  type AgentSyncStatus,
  type LibraryEntry
} from '../../agent-library'

const TONE_CLASS: Record<string, string> = {
  pending: 'bg-[#F0F0F2] text-apple-subtextAlt',
  running: 'bg-[#E8EFF8] text-apple-blueInk',
  done: 'bg-[#E9F1ED] text-[#1E7A3C]',
  blocked: 'bg-[#F4EEE8] text-apple-amber',
  failed: 'bg-[#FCEDEB] text-[#B3261E]'
}

function StatusChip({ label, tone }: { label: string; tone: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium ${TONE_CLASS[tone] ?? TONE_CLASS.pending}`}
    >
      {label}
    </span>
  )
}

export function AgentSyncCard({
  status,
  starting,
  startedAt,
  error,
  onStart
}: {
  status: AgentSyncStatus | null
  starting: boolean
  /** 本页发起同步的起点（毫秒）；服务端 running 时页面会回填 started_at。 */
  startedAt: number | null
  /** 启动 / 轮询失败的原因（原样展示）。 */
  error: string | null
  onStart: () => void
}) {
  const summary = summarizeSync(status)
  const counts = describeSyncCounts(status?.counts, status?.errors.length ?? 0)
  const lastRun = formatSyncStamp(status?.last_run ?? null)
  const running = summary.phase === 'running'
  const busy = starting || running
  const shownErrors = status?.errors.slice(0, 5) ?? []
  const hiddenErrors = (status?.errors.length ?? 0) - shownErrors.length

  return (
    <section className="card p-4 sm:p-5" aria-labelledby="agent-sync-title" data-testid="agent-sync-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="agent-sync-title" className="text-section text-apple-text">
              Agent / Skill 库同步
            </h2>
            <span data-testid="agent-sync-phase">
              <StatusChip label={summary.label} tone={summary.tone} />
            </span>
            {status?.auth === 'anonymous' && (
              <span
                className="inline-flex items-center gap-1 rounded-full bg-[#F0F0F2] px-2 py-0.5 text-[10.5px] text-apple-subtextAlt"
                title="未配置 GitHub Token，搜索接口按匿名额度调用"
              >
                匿名 GitHub 额度
              </span>
            )}
          </div>
          <p className="mt-1.5 max-w-[76ch] text-[12px] leading-relaxed text-apple-subtext">
            从 GitHub 搜索公开的 Agent / Skill 仓库，按 stars、license、时效与文件类型过滤后只读入库。
            <span className="text-apple-text"> 不执行任何远端内容</span>，也不提供「运行」。
          </p>
        </div>
        <button
          type="button"
          onClick={onStart}
          disabled={busy}
          aria-busy={busy}
          data-testid="agent-sync-start"
          className={primaryButton}
        >
          <Refresh className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} />
          {busy ? '同步中…' : '立即同步'}
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-apple-subtext">
        <span data-testid="agent-sync-last-run">
          最后更新：{lastRun ?? '尚未同步'}
        </span>
        <span className="num" data-testid="agent-sync-counts">
          {counts.text}
        </span>
        {status?.auth === 'token' && <span>GitHub Token 已配置</span>}
      </div>

      {running && (
        <div className="mt-3">
          <AsyncStatusLine
            testId="agent-sync-status"
            label="正在同步 GitHub 清单"
            startedAt={startedAt}
            detail={`当前 ${counts.text}`}
          />
        </div>
      )}

      {error && (
        <p
          role="alert"
          data-testid="agent-sync-error"
          className="mt-3 flex items-start gap-1.5 text-[12px] leading-relaxed text-[#B3261E]"
        >
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {error}
        </p>
      )}

      {shownErrors.length > 0 && (
        <div className="mt-3 rounded-[12px] border border-[#F3D3CF] bg-[#FCEDEB] px-3 py-2.5" data-testid="agent-sync-errors">
          <p className="flex items-center gap-1.5 text-[11.5px] font-medium text-[#B3261E]">
            <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
            最近一次同步有 {status?.errors.length} 个错误（原样展示）
          </p>
          <ul className="mt-1.5 space-y-1 text-[11px] leading-relaxed text-[#7A2E26]">
            {shownErrors.map((err, index) => (
              <li key={`${err.at}-${index}`} className="break-words">
                {describeSyncError(err)}
              </li>
            ))}
          </ul>
          {hiddenErrors > 0 && (
            <p className="mt-1 text-[11px] text-[#7A2E26]">另有 {hiddenErrors} 条未展开（状态文件保留全部）。</p>
          )}
        </div>
      )}
    </section>
  )
}

function warningCell(entry: LibraryEntry) {
  if (entry.warnings.length === 0) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-apple-subtext">
        <Shield className="h-3 w-3" />
        无标记
      </span>
    )
  }
  return (
    <span className="flex flex-wrap items-center gap-1" data-testid={`library-warnings-${entry.repo}-${entry.path}`}>
      {entry.warnings.map((code) => (
        <span
          key={code}
          title={code}
          className="inline-flex items-center gap-1 rounded-full bg-[#F4EEE8] px-2 py-0.5 text-[10.5px] font-medium text-apple-amber"
        >
          <TriangleAlert className="h-2.5 w-2.5" />
          {warningLabel(code)}
        </span>
      ))}
    </span>
  )
}

export function AgentLibraryList({
  entries,
  total,
  loading,
  loadingMore,
  error,
  generatedAt,
  onLoadMore,
  onRetry
}: {
  entries: LibraryEntry[]
  total: number
  loading: boolean
  loadingMore: boolean
  error: string | null
  generatedAt: string | null
  onLoadMore: () => void
  onRetry: () => void
}) {
  const generated = formatSyncStamp(generatedAt)
  const columns: Column<LibraryEntry>[] = [
    {
      key: 'repo',
      label: '来源仓库',
      className: 'w-[26%]',
      cell: (entry) => (
        <span className="flex min-w-0 flex-col">
          <a
            href={entry.url}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 break-words font-medium text-apple-blueInk hover:underline"
          >
            {entry.repo}
            <ExternalLink className="h-2.5 w-2.5 shrink-0" />
          </a>
          <span className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] text-apple-subtext">
            <span className="rounded bg-[#F0F0F2] px-1 py-px">{entry.tier} 档</span>
            {entry.verified && <span className="rounded bg-[#E8EFF8] px-1 py-px text-apple-blueInk">官方</span>}
          </span>
        </span>
      )
    },
    {
      key: 'path',
      label: '文件路径',
      className: 'w-[30%]',
      cell: (entry) => (
        <span className="block break-all font-mono text-[10.5px] text-apple-text" title={entry.path}>
          {entry.path}
        </span>
      )
    },
    {
      key: 'stars',
      label: 'Stars',
      className: 'num whitespace-nowrap text-right',
      cell: (entry) => entry.stars.toLocaleString('en-US')
    },
    {
      key: 'license',
      label: 'License',
      className: 'whitespace-nowrap',
      cell: (entry) => entry.license
    },
    {
      key: 'score',
      label: 'Score',
      className: 'num whitespace-nowrap text-right',
      cell: (entry) => entry.score.toFixed(2)
    },
    {
      key: 'warnings',
      label: '安全检查',
      cell: warningCell
    }
  ]

  const emptyText = loading
    ? '正在读取清单…'
    : total === 0
      ? '尚未同步。点上方「立即同步」，从 GitHub 拉取公开清单。'
      : '当前页没有条目。'

  return (
    <section className="card p-4 sm:p-5" aria-labelledby="agent-library-title" data-testid="agent-library">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <h2 id="agent-library-title" className="text-section text-apple-text">
            已入库清单（只读）
          </h2>
          <p className="mt-1 text-[11.5px] leading-relaxed text-apple-subtext">
            {generated ? `清单生成于 ${generated} · ` : ''}共 {total} 条，按 score 排序。
            可疑指令只做标记，不自动执行。
          </p>
        </div>
      </div>

      {error && (
        <div role="alert" className="mt-3 rounded-[12px] border border-[#F3D3CF] bg-[#FCEDEB] px-3 py-2.5 text-[11.5px] text-[#B3261E]">
          <p className="flex items-start gap-1.5">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            清单读取失败：{error}
          </p>
          <button
            type="button"
            onClick={onRetry}
            className="mt-2 inline-flex h-7 items-center rounded-lg bg-white px-2.5 text-[11px] font-medium text-apple-text ring-1 ring-black/[0.08] hover:bg-[#FAFAFC]"
          >
            重试
          </button>
        </div>
      )}

      <div className="mt-3">
        <DataTable
          columns={columns}
          rows={entries}
          rowKey={(entry) => `${entry.repo}/${entry.path}`}
          empty={emptyText}
        />
      </div>

      {entries.length > 0 && entries.length < total && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-apple-line pt-3">
          <span className="text-[11px] text-apple-subtext">
            已显示 {entries.length} / {total} 条
          </span>
          <button
            type="button"
            onClick={onLoadMore}
            disabled={loadingMore}
            aria-busy={loadingMore}
            data-testid="agent-library-more"
            className="inline-flex h-8 items-center rounded-full border border-black/[0.1] bg-white px-3.5 text-[12px] font-medium text-apple-text hover:bg-[#FAFAFC] disabled:cursor-not-allowed disabled:opacity-45"
          >
            {loadingMore ? '加载中…' : '加载更多'}
          </button>
        </div>
      )}
    </section>
  )
}
