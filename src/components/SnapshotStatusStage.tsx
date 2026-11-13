import type { JobSnapshot, SnapshotStatus } from '../types'
import { useJson } from '../api'

const STATUS_LABEL: Record<SnapshotStatus, string> = {
  queued: '排队中',
  running: '运行中',
  succeeded: '成功',
  failed: '失败',
  canceled: '已取消',
  unknown: '未知'
}

/** 契约 §4：unavailable 一律给可见文案，不伪装成功 / 不回落旧字段。 */
export function snapshotReasonText(snapshot: JobSnapshot): string {
  if (snapshot.available) return ''
  switch (snapshot.reason) {
    case 'source_unreachable':
      return '不可用：来源不可达'
    case 'kex_repo_not_configured':
      return '不可用：KEX_REPO_ROOT 未配置'
    case 'job_not_found':
      return '不可用：来源中未找到该任务'
    case 'state_unreadable':
      return '不可用：状态文件不可读'
    default:
      return '不可用：原因未记录'
  }
}

export function SnapshotStatusStage({
  source,
  jobId,
  statusTestId,
  stageTestId,
  className = ''
}: {
  source: 'b-track' | 'studio'
  jobId: string
  statusTestId?: string
  stageTestId?: string
  className?: string
}) {
  const { status, data, error } = useJson<JobSnapshot>(
    `/api/snapshot?source=${source}&job=${encodeURIComponent(jobId)}`
  )

  const unavailableText = data ? snapshotReasonText(data) : ''
  const stageTitle = data
    ? data.stage
      ? `阶段 ${data.stage}`
      : data.available
        ? `阶段不可用：${source === 'b-track' ? 'b-track 未记录阶段' : 'studio 未返回 stage'}`
        : unavailableText
    : undefined
  const statusLabel = data
    ? data.available
      ? STATUS_LABEL[data.status ?? 'unknown']
      : '不可用'
    : status === 'error'
      ? '读取失败'
      : '读取中'

  return (
    <span className={`inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] ${className}`}>
      <span
        data-testid={statusTestId ?? `snapshot-status-${jobId}`}
        data-snapshot-status={data?.status ?? 'unavailable'}
        data-snapshot-verdict={data?.verdict ?? ''}
        data-snapshot-available={data ? String(data.available) : 'pending'}
        className="num"
      >
        状态 {statusLabel}
      </span>
      <span
        data-testid={stageTestId ?? `snapshot-stage-${jobId}`}
        data-snapshot-stage={data?.stage ?? ''}
        title={stageTitle}
        className="num text-apple-subtext"
      >
        阶段 {data?.stage ?? '—'}
      </span>
      {data && !data.available && <span className="text-[#B3261E]">{unavailableText}</span>}
      {status === 'error' && <span className="text-[#B3261E]">不可用：{error}</span>}
    </span>
  )
}
