import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { getJson, HttpError, postJson, useJson, useLiveJson } from '../api'
import type {
  StudioAsset,
  StudioBrief,
  StudioBriefsResponse,
  StudioJob,
  StudioJobsResponse,
  StudioJobSummary,
  StudioKeyframeRef
} from '../types'
import { ChevronRight, Clapper, Plus, Refresh, Upload } from '../components/icons'
import { StudioStatusChip } from '../components/StudioStatusChip'
import { SnapshotStatusStage } from '../components/SnapshotStatusStage'
import { BriefWorkbench } from '../components/BriefWorkbench'
import { ImageWorkbench } from '../components/ImageWorkbench'
import { Field, inputClass, primaryButton, quietButton } from '../components/studio-ui'
import { buildAigcJobPayload } from '../image-workbench'
import {
  buildOptimizeJobPayload,
  planRiskRows,
  planStepRows,
  probeFacts
} from '../studio-probe'
import type { UploadProbeResponse } from '../studio-probe'

const POLL_MS = 4000

const QC: Record<StudioJob['qc']['status'], { label: string; className: string }> = {
  pending: { label: '待判定', className: 'bg-[#F0F0F2] text-apple-subtextAlt ring-[#E2E2E6]' },
  pass: { label: '通过', className: 'bg-[#EAF8EE] text-[#1E7A3C] ring-[#CDEED6]' },
  fail: { label: '未通过', className: 'bg-[#FCEDEB] text-[#B3261E] ring-[#F3D3CF]' }
}

const KIND_LABEL: Record<StudioAsset['kind'], string> = {
  video: '视频',
  image: '图像',
  audio: '音频',
  subtitle: '字幕',
  report: '报告'
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function formatStamp(value: string | null | undefined): string {
  if (!value) return '无数据'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes()
  )}:${pad(date.getSeconds())}`
}

function formatSize(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function formatClock(value: number | null): string {
  if (!value) return '等待首次读取'
  const date = new Date(value)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/* ------------------------------------------------------------------ */
/* 素材上传（T-UPLOAD-094b）：4 MiB 分块，失败保留 upload_id 可续传 */
/* ------------------------------------------------------------------ */

const VIDEO_EXTS = ['.mp4', '.mov', '.mkv', '.webm']
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024

type UploadSession = {
  uploadId: string
  filename: string
  size: number
  chunkSize: number
  received: number
  status: 'uploading' | 'failed' | 'ready'
  error: string | null
  sha256: string | null
}

type UploadInitResponse = {
  upload_id: string
  filename: string
  size: number
  chunk_size: number
  max_bytes: number
  received: number
  status: 'uploading' | 'ready'
}

type UploadStateResponse = {
  upload_id: string
  status: 'uploading' | 'ready'
  filename: string
  size: number
  received: number
  missing_chunks: number[]
  sha256: string | null
  path: string | null
}

type UploadCompleteResponse = {
  upload_id: string
  path: string
  size: number
  sha256: string
  filename: string
}

function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot).toLowerCase() : ''
}

/** 深链：读 `/studio?job=<id>`；空值视为无。 */
function readJobParam(): string | null {
  const id = new URLSearchParams(window.location.search).get('job')
  return id && id.trim() ? id : null
}

/** 把当前任务写进 URL，保证可分享 / 刷新有效（保留 router 的 scrollY state）。 */
function writeJobParam(id: string) {
  const url = new URL(window.location.href)
  url.searchParams.set('job', id)
  const target = `${url.pathname}${url.search}${url.hash}`
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`
  if (target === current) return
  window.history.replaceState({ ...(window.history.state ?? {}) }, '', target)
}

function putChunk(
  uploadId: string,
  index: number,
  chunk: Blob,
  onProgress: (loaded: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', `/api/uploads/${encodeURIComponent(uploadId)}/chunks/${index}`)
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded)
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve()
        return
      }
      let message = `HTTP ${xhr.status}`
      try {
        const payload = JSON.parse(xhr.responseText) as { error?: string }
        if (payload?.error) message = payload.error
      } catch {
        /* 非 JSON 响应体 */
      }
      reject(new Error(message))
    }
    xhr.onerror = () => reject(new Error('网络中断：分块上传失败，可点「继续上传」补齐。'))
    xhr.onabort = () => reject(new Error('上传已中断，可点「继续上传」补齐。'))
    xhr.send(chunk)
  })
}

function qcChip(status: StudioJob['qc']['status']) {
  const qc = QC[status]
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${qc.className}`}
    >
      {qc.label}
    </span>
  )
}

function EmptyQueue({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="px-6 py-16 text-center">
      <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-apple-bg text-apple-subtext">
        <Clapper className="h-5 w-5" />
      </span>
      <p className="mt-3 text-sm font-medium">还没有创作任务</p>
      <p className="mx-auto mt-1 max-w-[34ch] text-xs leading-relaxed text-apple-subtext">
        studio 队列为空。上传一段视频素材，即可提交第一个 A 轨任务。
      </p>
      <button type="button" onClick={onCreate} className={`${primaryButton} mt-4`}>
        创建第一个任务
      </button>
    </div>
  )
}

function LoadingRows() {
  return (
    <ul className="divide-y divide-black/[0.06]" aria-busy="true" aria-label="加载任务列表">
      {[0, 1, 2].map((index) => (
        <li key={index} className="animate-pulse px-4 py-4 motion-reduce:animate-none">
          <div className="flex items-center gap-3">
            <span className="h-5 w-16 rounded-full bg-black/[0.06]" />
            <span className="h-3.5 w-40 rounded bg-black/[0.06]" />
          </div>
          <div className="mt-2 h-3 w-56 rounded bg-black/[0.04]" />
        </li>
      ))}
    </ul>
  )
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0">
      <h4 className="text-[11px] font-semibold tracking-[0.02em] text-apple-subtext">{title}</h4>
      <div className="mt-1.5 text-[12px] leading-relaxed text-apple-text">{children}</div>
    </section>
  )
}

function JobDetail({
  job,
  detail,
  brief,
  loading,
  error,
  onRetry
}: {
  job: StudioJobSummary
  detail: StudioJob | null
  brief: StudioBrief | null
  loading: boolean
  error: string | null
  onRetry: () => void
}) {
  const sourceAsset = detail?.assets.find((asset) => asset.id === `asset_${job.id}_source`) ?? null
  const otherAssets = detail?.assets.filter((asset) => asset.id !== `asset_${job.id}_source`) ?? []

  return (
    <div className="mx-4 mb-4 rounded-[12px] border border-black/[0.06] bg-[#FAFAFC] p-3.5">
      {loading && !detail && (
        <p className="text-[11px] text-apple-subtext" aria-live="polite">
          读取任务详情…
        </p>
      )}

      {error && (
        <div className="rounded-[10px] bg-[#FCEDEB] px-3 py-2 text-[11px] leading-relaxed text-[#B3261E] ring-1 ring-inset ring-[#F3D3CF]">
          <p className="break-words">详情加载失败：{error}</p>
          <button
            type="button"
            onClick={onRetry}
            className="mt-1 rounded text-[11px] font-medium underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
          >
            重试
          </button>
        </div>
      )}

      {detail && (
        <div className="grid gap-x-6 gap-y-4 md:grid-cols-2">
          <DetailSection title="概览">
            <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-[11px] leading-5">
              <dt className="text-apple-subtext">QC</dt>
              <dd>{qcChip(detail.qc.status)}</dd>
              <dt className="text-apple-subtext">类型 / 轨</dt>
              <dd className="num">
                {detail.type} / {detail.rail}
              </dd>
              <dt className="text-apple-subtext">模型</dt>
              <dd className="num break-all">
                {typeof detail.model?.id === 'string'
                  ? `${detail.model.id}${typeof detail.model.version === 'string' ? ` @ ${detail.model.version}` : ''}`
                  : '未指定'}
              </dd>
              <dt className="text-apple-subtext">创建</dt>
              <dd className="num">{formatStamp(detail.created_at)}</dd>
              <dt className="text-apple-subtext">更新</dt>
              <dd className="num">{formatStamp(detail.updated_at)}</dd>
            </dl>
          </DetailSection>

          <DetailSection title="Brief">
            {brief ? (
              <div>
                <p className="text-[12px] leading-relaxed">{brief.idea}</p>
                <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-apple-subtext">
                  <span className="num">
                    {brief.id} · v{brief.version}
                  </span>
                  {brief.audience && <span>受众 {brief.audience}</span>}
                  {brief.duration_s != null && <span>时长 {brief.duration_s}s</span>}
                  {brief.aspect && <span>画幅 {brief.aspect}</span>}
                  {brief.tone && <span>调性 {brief.tone}</span>}
                </p>
              </div>
            ) : job.brief_id ? (
              <p className="num break-all text-[11px] text-apple-subtext">
                {job.brief_id}（Brief 详情未在列表中，可能已被清理）
              </p>
            ) : (
              <p className="text-[11px] text-apple-subtext">未关联 Brief。</p>
            )}
          </DetailSection>

          <DetailSection title="输入素材">
            {sourceAsset ? (
              <p className="num break-all text-[11px]">
                {sourceAsset.uri.replace(/^studio:\/\//, '')}
                <span className="ml-2 whitespace-nowrap text-apple-subtext">
                  {formatSize(sourceAsset.size_bytes)}
                </span>
              </p>
            ) : detail.inputs.length > 0 ? (
              <p className="num break-all text-[11px] text-apple-subtext">
                {detail.inputs.map((input) => input.asset_id).join('、')}（当前服务无法读取源文件信息）
              </p>
            ) : (
              <p className="text-[11px] text-apple-subtext">无输入记录。</p>
            )}
          </DetailSection>

          <DetailSection title="封面与关键帧">
            {detail.cover_url ? (
              <div>
                <img
                  src={detail.cover_url}
                  alt={detail.cover_asset ? `封面 ${detail.cover_asset.name}` : '任务封面'}
                  className="max-h-32 w-full rounded-[8px] object-cover"
                />
                <p className="num mt-1 break-all text-[11px]">
                  {detail.cover_asset
                    ? `${detail.cover_asset.source_job}/${detail.cover_asset.name}`
                    : 'cover_asset 已写入（细节未返回）'}
                </p>
              </div>
            ) : (
              <p className="text-[11px] text-apple-subtext">未设置封面（cover_asset 为空）。</p>
            )}
            <p className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px]">
              {detail.keyframe_source ? (
                <span className="inline-flex rounded-full bg-[#EAF2FD] px-2 py-0.5 text-apple-blueInk ring-1 ring-inset ring-[#CFE2FA]">
                  keyframe_source=<span className="num ml-0.5">{detail.keyframe_source}</span>
                </span>
              ) : (
                <span className="text-apple-subtext">keyframe_source 为空（未使用注入关键帧）。</span>
              )}
              {detail.keyframe_asset && (
                <span className="num break-all text-apple-subtext">
                  {detail.keyframe_asset.source_job}/{detail.keyframe_asset.name}
                </span>
              )}
            </p>
          </DetailSection>

          <DetailSection title="阶段与事件">
            <p className="text-[11px]">
              当前阶段：
              <span className="num ml-1">{detail.progress.stage ?? job.stage ?? '无数据'}</span>
            </p>
            {Object.keys(detail.progress.stages).length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1.5">
                {Object.entries(detail.progress.stages).map(([stage, state]) => (
                  <span
                    key={stage}
                    className="num rounded-full bg-white px-2 py-0.5 text-[10px] text-apple-subtext ring-1 ring-inset ring-black/[0.06]"
                  >
                    {stage} · {state}
                  </span>
                ))}
              </div>
            )}
            {detail.events.length > 0 ? (
              <ul className="mt-2 max-h-32 space-y-1 overflow-y-auto pr-1">
                {detail.events.map((event, index) => (
                  <li key={`${event.ts}-${index}`} className="flex gap-2 text-[11px] leading-5">
                    <span className="num shrink-0 text-apple-subtext">{formatStamp(event.ts)}</span>
                    <span className="shrink-0 text-apple-subtextAlt">{event.type}</span>
                    <span className="min-w-0 break-words">{event.message}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-[11px] text-apple-subtext">studio 未返回事件记录（events 为空）。</p>
            )}
          </DetailSection>

          <div className="md:col-span-2">
            <DetailSection title={`资产${otherAssets.length > 0 ? ` · ${otherAssets.length} 项` : ''}`}>
              {otherAssets.length > 0 ? (
                <ul className="space-y-1.5">
                  {otherAssets.map((asset) => (
                    <li key={asset.id} className="flex items-baseline gap-2">
                      <span className="shrink-0 rounded-full bg-white px-2 py-0.5 text-[10px] text-apple-subtext ring-1 ring-inset ring-black/[0.06]">
                        {KIND_LABEL[asset.kind] ?? asset.kind}
                      </span>
                      <span className="num min-w-0 flex-1 break-all text-[11px]">
                        {asset.uri.replace(/^studio:\/\//, '')}
                      </span>
                      <span className="num shrink-0 text-[11px] text-apple-subtext">
                        {formatSize(asset.size_bytes)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[11px] text-apple-subtext">
                  暂无资产。任务未完成，或当前服务无法读取 studio 文件（NAS 未挂载媒体属 W2 边界）。
                </p>
              )}
            </DetailSection>
          </div>

          {detail.error && (
            <div className="md:col-span-2">
              <DetailSection title="错误原文">
                <p className="break-words rounded-[10px] bg-[#FCEDEB] px-3 py-2 text-[11px] leading-relaxed text-[#B3261E] ring-1 ring-inset ring-[#F3D3CF]">
                  {detail.error}
                </p>
              </DetailSection>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function JobRow({
  job,
  briefs,
  highlighted,
  defaultExpanded = false,
  focusSignal,
  onRefresh
}: {
  job: StudioJobSummary
  briefs: StudioBrief[]
  highlighted: boolean
  /** 仅深链目标为 true：首次挂载即展开详情。 */
  defaultExpanded?: boolean
  /** 变化时强制展开（「查看任务」按钮 / popstate）。 */
  focusSignal?: number
  onRefresh: () => void
}) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [detail, setDetail] = useState<StudioJob | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailNonce, setDetailNonce] = useState(0)
  const [brief, setBrief] = useState<StudioBrief | null>(
    () => briefs.find((item) => item.id === job.brief_id) ?? null
  )
  const [action, setAction] = useState<'cancel' | 'retry' | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionNote, setActionNote] = useState<string | null>(null)

  const briefFromList = job.brief_id ? briefs.find((item) => item.id === job.brief_id) ?? null : null

  useEffect(() => {
    if (highlighted) setExpanded(true)
  }, [highlighted])

  useEffect(() => {
    if (focusSignal != null) setExpanded(true)
  }, [focusSignal])

  useEffect(() => {
    if (briefFromList) setBrief(briefFromList)
  }, [briefFromList])

  useEffect(() => {
    if (!expanded) return
    const ac = new AbortController()
    setDetailLoading(true)
    getJson<StudioJob>(`/api/studio/jobs/${encodeURIComponent(job.id)}`, ac.signal)
      .then((next) => {
        setDetail(next)
        setDetailError(null)
      })
      .catch((err: unknown) => {
        if (ac.signal.aborted) return
        setDetailError(err instanceof Error ? err.message : '请求失败')
      })
      .finally(() => {
        if (!ac.signal.aborted) setDetailLoading(false)
      })
    return () => ac.abort()
  }, [expanded, job.id, job.updated_at, job.status, detailNonce])

  useEffect(() => {
    if (!expanded || !job.brief_id || brief) return
    const ac = new AbortController()
    getJson<StudioBrief>(`/api/studio/briefs/${encodeURIComponent(job.brief_id)}`, ac.signal)
      .then((next) => setBrief(next))
      .catch(() => {
        /* Brief 读取失败时详情面板会显示 brief_id 与缺失说明 */
      })
    return () => ac.abort()
  }, [expanded, job.brief_id, brief])

  const runAction = useCallback(
    async (kind: 'cancel' | 'retry') => {
      setAction(kind)
      setActionError(null)
      setActionNote(null)
      try {
        const result = await postJson<{ id?: string; status?: string }>(
          `/api/studio/jobs/${encodeURIComponent(job.id)}/${kind}`,
          {}
        )
        setActionNote(
          kind === 'retry'
            ? `已创建重试任务 ${result.id ?? '（id 未返回）'}，旧记录保持不变。`
            : '任务已取消。'
        )
        onRefresh()
      } catch (err) {
        const status = err instanceof HttpError ? `HTTP ${err.status} · ` : ''
        setActionError(`${status}${err instanceof Error ? err.message : '操作失败'}`)
      } finally {
        setAction(null)
      }
    },
    [job.id, onRefresh]
  )

  const canCancel = job.status === 'queued'
  const canRetry = job.status === 'failed' || job.status === 'canceled'

  return (
    <li
      id={`studio-job-${job.id}`}
      data-job-id={job.id}
      className={`border-t border-black/[0.06] first:border-t-0 ${highlighted ? 'bg-[#F5F9FF]' : ''}`}
    >
      <div className="flex items-start gap-2 px-4 py-3.5">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="min-w-0 flex-1 rounded-[8px] text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
        >
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <ChevronRight
              className={`h-3.5 w-3.5 shrink-0 text-apple-subtext transition-transform duration-200 ease-apple ${
                expanded ? 'rotate-90' : ''
              }`}
            />
            <span className="num truncate text-[13px] font-medium">{job.id}</span>
            {highlighted ? (
              <SnapshotStatusStage source="studio" jobId={job.id} className="text-apple-subtext" />
            ) : (
              <>
                <StudioStatusChip status={job.status} />
                <span className="num text-[11px] text-apple-subtext">阶段 {job.stage ?? '无数据'}</span>
              </>
            )}
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 pl-[22px] text-[11px] text-apple-subtext">
            <span className="num">更新 {formatStamp(job.updated_at)}</span>
            <span className="num">
              {job.type} / {job.rail} 轨
            </span>
            <span className="num truncate">
              {job.brief_id ? `Brief ${job.brief_id}` : '未关联 Brief'}
            </span>
          </span>
          {job.error && (
            <span
              className="mt-1 line-clamp-2 pl-[22px] text-[11px] leading-relaxed text-[#B3261E]"
              title={job.error}
            >
              {job.error}
            </span>
          )}
        </button>

        <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
          {canCancel && (
            <button
              type="button"
              onClick={() => runAction('cancel')}
              disabled={action !== null}
              className="h-7 rounded-full border border-black/[0.1] px-2.5 text-[11px] font-medium text-apple-text transition-colors hover:bg-black/[0.03] focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50 disabled:cursor-not-allowed disabled:opacity-55"
            >
              {action === 'cancel' ? '取消中…' : '取消'}
            </button>
          )}
          {canRetry && (
            <button
              type="button"
              onClick={() => runAction('retry')}
              disabled={action !== null}
              className="h-7 rounded-full bg-apple-blue px-2.5 text-[11px] font-medium text-white transition-colors hover:bg-[#0062C4] focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50 disabled:cursor-not-allowed disabled:opacity-55"
            >
              {action === 'retry' ? '重试中…' : '重试'}
            </button>
          )}
        </div>
      </div>

      {(actionError || actionNote) && (
        <div className="px-4 pb-3 pl-[38px]">
          {actionError && (
            <p
              className="break-words rounded-[10px] bg-[#FCEDEB] px-3 py-2 text-[11px] leading-relaxed text-[#B3261E] ring-1 ring-inset ring-[#F3D3CF]"
              role="alert"
            >
              {actionError}
            </p>
          )}
          {actionNote && (
            <p className="break-words rounded-[10px] bg-[#EAF8EE] px-3 py-2 text-[11px] leading-relaxed text-[#1E7A3C] ring-1 ring-inset ring-[#CDEED6]">
              {actionNote}
            </p>
          )}
        </div>
      )}

      {expanded && (
        <JobDetail
          job={job}
          detail={detail}
          brief={brief}
          loading={detailLoading}
          error={detailError}
          onRetry={() => setDetailNonce((value) => value + 1)}
        />
      )}
    </li>
  )
}

/* ------------------------------------------------------------------ */
/* B 轨源片探针（#86）：上传 complete 后自动探测，确认后提交 optimize 任务 */
/* ------------------------------------------------------------------ */

type ProbeState =
  | { status: 'idle' }
  | { status: 'loading'; uploadId: string }
  | { status: 'ready'; uploadId: string; data: UploadProbeResponse }
  | { status: 'error'; uploadId: string; message: string; reason: string | null }

const RISK_STYLE: Record<'blocked' | 'warn' | 'info', string> = {
  blocked: 'bg-[#FCEDEB] text-[#B3261E] ring-[#F3D3CF]',
  warn: 'bg-[#FBF1E4] text-[#8A4B00] ring-[#F0D9BC]',
  info: 'bg-white text-apple-subtextAlt ring-black/[0.06]'
}

function ProbePanel({
  probe,
  blocked,
  submitting,
  error,
  onRetry,
  onSubmit
}: {
  probe: ProbeState
  /** 关联 Brief 未确认（沿用 A 轨同一门禁）。 */
  blocked: boolean
  submitting: boolean
  error: string | null
  onRetry: () => void
  onSubmit: () => void
}) {
  const facts = probe.status === 'ready' ? probeFacts(probe.data) : []
  const steps = probe.status === 'ready' ? planStepRows(probe.data) : []
  const risks = probe.status === 'ready' ? planRiskRows(probe.data) : []

  return (
    <section
      className="min-w-0 rounded-[12px] border border-black/[0.06] bg-apple-bg/40 px-3.5 py-3"
      aria-labelledby="studio-b-track-title"
      data-testid="studio-probe-panel"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="studio-b-track-title" className="text-[13px] font-medium text-apple-text">
          B 轨增强 · 源片探针
        </h3>
        <div className="flex items-center gap-1.5">
          <span className="num rounded-full bg-white px-2 py-0.5 text-[10px] font-medium text-apple-subtextAlt ring-1 ring-inset ring-black/[0.06]">
            optimize
          </span>
          <span className="num rounded-full bg-white px-2 py-0.5 text-[10px] font-medium text-apple-subtextAlt ring-1 ring-inset ring-black/[0.06]">
            B 轨
          </span>
        </div>
      </div>

      {(probe.status === 'idle' || probe.status === 'loading') && (
        <p className="mt-2 text-[11px] leading-relaxed text-apple-subtext" aria-live="polite">
          正在探测源片：分辨率 / 时长 / 帧率 / 码率 / 音轨 / 镜头切分 / 优化计划…
        </p>
      )}

      {probe.status === 'error' && (
        <div className="mt-2 rounded-[10px] bg-[#FCEDEB] px-3 py-2 text-[11px] leading-relaxed text-[#B3261E] ring-1 ring-inset ring-[#F3D3CF]">
          <p className="break-words" role="alert">
            探针失败：{probe.message}
            {probe.reason ? `（reason: ${probe.reason}）` : ''}
          </p>
          <button
            type="button"
            onClick={onRetry}
            className="mt-1 rounded text-[11px] font-medium underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
          >
            重新探测
          </button>
        </div>
      )}

      {probe.status === 'ready' && (
        <div className="mt-2.5 space-y-2.5">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[11px] sm:grid-cols-3">
            {facts.map((fact) => (
              <div key={fact.label} className="min-w-0">
                <dt className="text-apple-subtext">{fact.label}</dt>
                <dd className="num mt-0.5 break-words">{fact.value}</dd>
              </div>
            ))}
          </dl>

          <div className="min-w-0">
            <p className="text-[11px] font-semibold text-apple-subtext">执行步骤</p>
            {steps.length > 0 ? (
              <ol className="mt-1 space-y-1.5">
                {steps.map((step, index) => (
                  <li key={step.key} className="flex min-w-0 gap-2 text-[12px] leading-relaxed">
                    <span className="num mt-0.5 shrink-0 rounded-full bg-white px-1.5 text-[10px] text-apple-subtext ring-1 ring-inset ring-black/[0.06]">
                      {index + 1}
                    </span>
                    <div className="min-w-0">
                      <p className="break-words font-medium text-apple-text">
                        {step.title}
                        {step.hint && (
                          <span className="ml-1.5 text-[10px] font-normal text-apple-subtext">
                            提示
                          </span>
                        )}
                      </p>
                      {step.detail && (
                        <p className="break-words text-[11px] text-apple-subtext">{step.detail}</p>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="mt-1 text-[11px] text-apple-subtext">计划未给出步骤。</p>
            )}
          </div>

          <div className="min-w-0">
            <p className="text-[11px] font-semibold text-apple-subtext">风险提示</p>
            {risks.length > 0 ? (
              <ul className="mt-1 space-y-1">
                {risks.map((risk, index) => (
                  <li
                    key={`${risk.level}-${index}`}
                    className={`break-words rounded-[8px] px-2.5 py-1.5 text-[11px] leading-relaxed ring-1 ring-inset ${RISK_STYLE[risk.level]}`}
                  >
                    {risk.text}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-[11px] text-[#1E7A3C]">未发现风险。</p>
            )}
          </div>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 text-[11px] leading-relaxed text-apple-subtext">
          {blocked
            ? '关联 Brief 未确认：确认后才能提交 B 轨（不会触发 GPU）。'
            : '确认后按上述计划提交 optimize 任务；任务进入 studio 队列。'}
        </p>
        <button
          type="button"
          data-testid="studio-b-submit"
          onClick={onSubmit}
          disabled={submitting || blocked || probe.status !== 'ready'}
          className={`${primaryButton} shrink-0`}
        >
          {submitting ? '提交中…' : '确认执行 B 轨'}
        </button>
      </div>

      {error && (
        <p
          role="alert"
          className="mt-2 break-words rounded-[10px] bg-[#FCEDEB] px-3 py-2 text-[11px] leading-relaxed text-[#B3261E] ring-1 ring-inset ring-[#F3D3CF]"
        >
          提交失败：{error}
        </p>
      )}
    </section>
  )
}

export function StudioPage() {
  const jobs = useLiveJson<StudioJobsResponse>('/api/studio/jobs?limit=50', POLL_MS)
  const briefsState = useJson<StudioBriefsResponse>('/api/studio/briefs?limit=50')
  const briefs = briefsState.data?.items ?? []

  const sourceRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dropzoneRef = useRef<HTMLLabelElement>(null)
  const uploadRunRef = useRef(0)
  const sessionRef = useRef<UploadSession | null>(null)
  const [path, setPath] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [session, setSession] = useState<UploadSession | null>(null)
  const [dragging, setDragging] = useState(false)
  const [briefChoice, setBriefChoice] = useState('none')
  /** 当前关联/新建的 Brief（工作台回写）；门禁与提交都以它为准。 */
  const [linkBrief, setLinkBrief] = useState<StudioBrief | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  /** #89b: 图片工作台选中的关键帧（仅 shot 1）。未选时提交 payload 不含该键。 */
  const [keyframeAsset, setKeyframeAsset] = useState<StudioKeyframeRef | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [createdJobId, setCreatedJobId] = useState<string | null>(null)
  const [focusJobId, setFocusJobId] = useState<string | null>(() => readJobParam())
  const [focusNonce, setFocusNonce] = useState(0)
  /** #101：任务队列收进抽屉；深链 ?job= 首次进入时自动打开。 */
  const [queueOpen, setQueueOpen] = useState(() => Boolean(readJobParam()))
  const queueTriggerRef = useRef<HTMLButtonElement>(null)
  const queueCloseRef = useRef<HTMLButtonElement>(null)
  const scrolledRef = useRef<string>('')
  const probeRunRef = useRef(0)
  const [probe, setProbe] = useState<ProbeState>({ status: 'idle' })
  const [bError, setBError] = useState<string | null>(null)

  const selectedBrief =
    briefChoice !== 'none' && briefChoice !== 'new'
      ? briefs.find((brief) => brief.id === briefChoice) ?? null
      : null

  // 选中已有 Brief 时把它同步进门禁状态；工作台回写的版本优先于列表快照。
  useEffect(() => {
    if (briefChoice === 'none' || briefChoice === 'new') {
      setLinkBrief(null)
      return
    }
    setLinkBrief((prev) => (prev && prev.id === briefChoice ? prev : selectedBrief))
  }, [briefChoice, selectedBrief])

  /** #87 §1.4：关联 Brief 未确认时禁止入队；无 Brief（不关联）保持原行为。 */
  const submitGateBrief =
    briefChoice === 'none'
      ? null
      : briefChoice === 'new'
        ? linkBrief
        : linkBrief && linkBrief.id === briefChoice
          ? linkBrief
          : selectedBrief
  const submitBlocked = briefChoice !== 'none' && submitGateBrief?.status !== 'confirmed'

  const focusSource = useCallback(() => {
    dropzoneRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    fileInputRef.current?.focus({ preventScroll: true })
  }, [])

  const applySession = useCallback((next: UploadSession | null) => {
    sessionRef.current = next
    setSession(next)
  }, [])

  const patchSession = useCallback((patch: Partial<UploadSession>) => {
    const current = sessionRef.current
    if (!current) return
    const next = { ...current, ...patch }
    sessionRef.current = next
    setSession(next)
  }, [])

  /** 上传 complete 后探测源片；失败保留原因，可点「重新探测」。 */
  const runProbe = useCallback(async (uploadId: string) => {
    const runId = ++probeRunRef.current
    setProbe({ status: 'loading', uploadId })
    setBError(null)
    try {
      const data = await postJson<UploadProbeResponse>(
        `/api/uploads/${encodeURIComponent(uploadId)}/probe`,
        {}
      )
      if (probeRunRef.current !== runId) return
      setProbe({ status: 'ready', uploadId, data })
    } catch (err) {
      if (probeRunRef.current !== runId) return
      const reason =
        err instanceof HttpError && err.payload !== null && typeof err.payload === 'object'
          ? (err.payload as { reason?: unknown }).reason
          : null
      setProbe({
        status: 'error',
        uploadId,
        message: err instanceof Error ? err.message : '探针失败',
        reason: typeof reason === 'string' && reason ? reason : null
      })
    }
  }, [])

  const readyUploadId = session?.status === 'ready' ? session.uploadId : null
  const probedUploadId = probe.status === 'idle' ? null : probe.uploadId

  // 上传 complete 后自动探测一次；同一 upload 不重复触发（重试走面板按钮）。
  useEffect(() => {
    if (!readyUploadId || probedUploadId === readyUploadId) return
    void runProbe(readyUploadId)
  }, [readyUploadId, probedUploadId, runProbe])

  /** 4 MiB 分块上传：首次走 init；resume 时只补 GET 返回的 missing_chunks。 */
  const runUpload = useCallback(
    async (
      target: File,
      resume?: { session: UploadSession; missing: number[]; received: number }
    ) => {
      const runId = ++uploadRunRef.current
      setFormError(null)
      setNotice(null)
      try {
        let active: UploadSession
        if (resume) {
          active = { ...resume.session, status: 'uploading', error: null, received: resume.received }
          applySession(active)
        } else {
          const init = await postJson<UploadInitResponse>('/api/uploads/init', {
            filename: target.name,
            size: target.size
          })
          active = {
            uploadId: init.upload_id,
            filename: init.filename,
            size: init.size,
            chunkSize: init.chunk_size,
            received: 0,
            status: 'uploading',
            error: null,
            sha256: null
          }
          applySession(active)
        }
        if (uploadRunRef.current !== runId) return

        const pending =
          resume?.missing ??
          Array.from({ length: Math.ceil(active.size / active.chunkSize) }, (_, index) => index)
        let done = resume?.received ?? 0
        for (const index of pending) {
          if (uploadRunRef.current !== runId) return
          const start = index * active.chunkSize
          const end = Math.min(start + active.chunkSize, active.size)
          const base = done
          await putChunk(active.uploadId, index, target.slice(start, end), (loaded) => {
            if (uploadRunRef.current !== runId) return
            patchSession({ received: Math.min(active.size, base + loaded) })
          })
          done += end - start
          patchSession({ received: Math.min(active.size, done) })
        }

        const completed = await postJson<UploadCompleteResponse>(
          `/api/uploads/${encodeURIComponent(active.uploadId)}/complete`,
          {}
        )
        if (uploadRunRef.current !== runId) return
        patchSession({
          status: 'ready',
          received: completed.size,
          sha256: completed.sha256,
          error: null
        })
      } catch (err) {
        if (uploadRunRef.current !== runId) return
        const message = err instanceof Error ? err.message : '上传失败'
        if (sessionRef.current) {
          patchSession({ status: 'failed', error: message })
        } else {
          setFormError(`上传失败：${message}`)
        }
      }
    },
    [applySession, patchSession]
  )

  const pickFile = useCallback(
    (candidate: File | null | undefined) => {
      if (!candidate) return
      if (sessionRef.current?.status === 'uploading') {
        setFormError('当前素材仍在上传，请等待完成或失败后再更换文件。')
        return
      }
      const ext = fileExtension(candidate.name)
      if (!VIDEO_EXTS.includes(ext)) {
        setFormError(`不支持的文件类型${ext ? ` ${ext}` : ''}：仅支持 mp4 / mov / mkv / webm。`)
        return
      }
      if (candidate.size <= 0) {
        setFormError('文件为空（0 字节），无法上传。')
        return
      }
      if (candidate.size > MAX_UPLOAD_BYTES) {
        setFormError(`文件过大（${formatSize(candidate.size)}）：上限 2 GiB。`)
        return
      }
      uploadRunRef.current += 1
      probeRunRef.current += 1
      setProbe({ status: 'idle' })
      setBError(null)
      applySession(null)
      setFile(candidate)
      setFormError(null)
      setNotice(null)
      void runUpload(candidate)
    },
    [applySession, runUpload]
  )

  const resumeUpload = useCallback(async () => {
    const current = sessionRef.current
    if (!current || !file) return
    setFormError(null)
    setNotice(null)
    patchSession({ status: 'uploading', error: null })
    try {
      const state = await getJson<UploadStateResponse>(
        `/api/uploads/${encodeURIComponent(current.uploadId)}`
      )
      if (state.status === 'ready') {
        patchSession({ status: 'ready', received: state.size, sha256: state.sha256, error: null })
        return
      }
      await runUpload(file, {
        session: current,
        missing: state.missing_chunks,
        received: state.received
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : '续传失败'
      patchSession({ status: 'failed', error: message })
    }
  }, [file, patchSession, runUpload])

  const resetForm = useCallback(() => {
    uploadRunRef.current += 1
    probeRunRef.current += 1
    setProbe({ status: 'idle' })
    setBError(null)
    applySession(null)
    setFile(null)
    setPath('')
    setBriefChoice('none')
    setLinkBrief(null)
    setKeyframeAsset(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [applySession])

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFormError(null)
    setNotice(null)

    const upload = sessionRef.current
    const absolute = path.trim()
    if (upload?.status === 'uploading') {
      setFormError('素材仍在上传中：请等待进度到 100% 后再创建任务。')
      return
    }
    if (upload?.status === 'failed') {
      setFormError('素材上传未完成：请先点「继续上传」补齐分块，或更换文件。')
      return
    }
    if (!absolute && !upload) {
      setFormError('请先选择并上传素材，或在「高级」里填写 studio 上已存在的绝对路径。')
      focusSource()
      return
    }
    if (briefChoice !== 'none' && submitGateBrief?.status !== 'confirmed') {
      setFormError('需先确认 Brief：润色并确认后才能提交生成；未确认时不会触发 GPU。')
      return
    }

    setSubmitting(true)
    const briefId: string | null = briefChoice === 'none' ? null : submitGateBrief!.id
    try {
      const payload = buildAigcJobPayload({
        briefId,
        input: absolute || null,
        uploadId: absolute ? null : upload?.uploadId ?? null,
        keyframe: keyframeAsset
      })
      const job = await postJson<StudioJob>('/api/studio/jobs', payload)

      setNotice(`已提交 ${job.id}。任务状态与阶段以 studio 为准，列表每 4 秒刷新。`)
      setCreatedJobId(job.id)
      writeJobParam(job.id)
      resetForm()
      jobs.refresh()
      briefsState.refresh()
    } catch (err) {
      const code =
        err instanceof HttpError && err.payload !== null && typeof err.payload === 'object'
          ? (err.payload as { error?: unknown }).error
          : null
      const message =
        code === 'brief_not_confirmed'
          ? 'brief_not_confirmed：Brief 尚未确认，需先确认才能入队（未触发 GPU）。'
          : err instanceof Error
            ? err.message
            : '提交失败'
      setFormError(message)
    } finally {
      setSubmitting(false)
    }
  }

  /** B 轨：探针就绪后提交 optimize 任务；关联 Brief 时带 brief_id/polished。 */
  async function handleBSubmit() {
    const upload = sessionRef.current
    if (!upload || upload.status !== 'ready' || probe.status !== 'ready') return
    if (briefChoice !== 'none' && submitGateBrief?.status !== 'confirmed') {
      setBError('关联 Brief 未确认：请先润色并确认，未确认时不会触发 GPU。')
      return
    }

    setBError(null)
    setSubmitting(true)
    const brief = briefChoice === 'none' ? null : submitGateBrief
    try {
      const job = await postJson<StudioJob>(
        '/api/studio/jobs',
        buildOptimizeJobPayload(upload.uploadId, brief)
      )
      setNotice(`已提交 B 轨任务 ${job.id}。任务状态与阶段以 studio 为准，列表每 4 秒刷新。`)
      setCreatedJobId(job.id)
      writeJobParam(job.id)
      resetForm()
      jobs.refresh()
      briefsState.refresh()
    } catch (err) {
      const body =
        err instanceof HttpError && err.payload !== null && typeof err.payload === 'object'
          ? (err.payload as { error?: unknown; reason?: unknown })
          : null
      const code = typeof body?.error === 'string' ? body.error : null
      const reason = typeof body?.reason === 'string' && body.reason ? body.reason : null
      const message =
        code === 'brief_not_confirmed'
          ? 'brief_not_confirmed：Brief 尚未确认，需先确认才能入队（未触发 GPU）。'
          : err instanceof Error
            ? err.message
            : '提交失败'
      setBError(reason && reason !== message ? `${message}（reason: ${reason}）` : message)
    } finally {
      setSubmitting(false)
    }
  }

  const jobsData = jobs.data?.items ?? []
  const showEmpty = jobs.status === 'ready' && jobsData.length === 0

  const focusMissingId =
    focusJobId && jobs.status === 'ready' && !jobsData.some((job) => job.id === focusJobId)
      ? focusJobId
      : null

  const focusJob = useCallback((id: string) => {
    setFocusJobId(id)
    setFocusNonce((value) => value + 1)
    setCreatedJobId(id)
    setQueueOpen(true)
    writeJobParam(id)
  }, [])

  const closeQueue = useCallback(() => {
    setQueueOpen(false)
    window.requestAnimationFrame(() => queueTriggerRef.current?.focus())
  }, [])

  // 直接打开 / popstate：URL 的 ?job= 决定深链目标，并自动打开队列抽屉。
  useEffect(() => {
    const apply = () => {
      const id = readJobParam()
      setFocusJobId(id)
      setQueueOpen(Boolean(id))
      setFocusNonce((value) => value + 1)
    }
    window.addEventListener('popstate', apply)
    return () => window.removeEventListener('popstate', apply)
  }, [])

  // 抽屉打开：锁页面滚动、聚焦关闭按钮、Esc 关闭。
  useEffect(() => {
    if (!queueOpen) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    queueCloseRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeQueue()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKey)
    }
  }, [queueOpen, closeQueue])

  // 命中深链目标后滚动到该行；抽屉挂载后再滚，同一目标只滚一次。
  useEffect(() => {
    if (!queueOpen || !focusJobId || !jobs.data) return
    const key = `${focusJobId}:${focusNonce}`
    if (scrolledRef.current === key) return
    const el = document.getElementById(`studio-job-${focusJobId}`)
    if (!el) return
    scrolledRef.current = key
    const raf = window.requestAnimationFrame(() => {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    })
    return () => window.cancelAnimationFrame(raf)
  }, [queueOpen, focusJobId, focusNonce, jobs.data])
  const uploading = session?.status === 'uploading'
  const readyUpload = session?.status === 'ready' ? session : null
  const progressPct =
    session && session.size > 0
      ? Math.min(100, Math.round((session.received / session.size) * 100))
      : 0
  const uploadPill =
    session?.status === 'ready'
      ? 'bg-[#EAF8EE] text-[#1E7A3C] ring-[#CDEED6]'
      : session?.status === 'failed'
        ? 'bg-[#FCEDEB] text-[#B3261E] ring-[#F3D3CF]'
        : 'bg-[#EAF2FD] text-apple-blueInk ring-[#CFE2FA]'

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em] sm:text-[34px]">
            创作工坊
          </h1>
          <p className="mt-1.5 max-w-[68ch] text-sm leading-relaxed text-apple-subtext">
            提交创作任务，跟踪排队、生成与成片。状态和素材以创作服务为准，每 4 秒自动刷新；失败可重试，排队中可取消。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-apple-subtext">
          <span className="h-1.5 w-1.5 rounded-full bg-apple-statusDone" aria-hidden="true" />
          <span className="num">studio 数据源 · {formatClock(jobs.updatedAt)}</span>
          <button
            ref={queueTriggerRef}
            type="button"
            onClick={() => setQueueOpen(true)}
            className={`${quietButton} h-9 gap-1.5 px-3 text-[12px]`}
            data-testid="studio-queue-trigger"
            aria-haspopup="dialog"
            aria-expanded={queueOpen}
          >
            任务队列
            <span className="num rounded-full bg-apple-bg px-1.5 text-[10px] text-apple-subtext">
              {jobs.status === 'ready' ? jobsData.length : '…'}
            </span>
          </button>
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(320px,380px)_minmax(0,1fr)] xl:items-start">
        <form
          onSubmit={handleSubmit}
          className="card p-5 xl:sticky xl:top-6"
          aria-labelledby="studio-create-title"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 id="studio-create-title" className="text-section">
                新建任务
              </h2>
              <p className="mt-1 text-[11px] leading-relaxed text-apple-subtext">
                上传素材（mp4 / mov / mkv / webm，≤2 GiB）后创建 A 轨任务；脚本素材可在高级选项里走 studio 绝对路径。
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="num rounded-full bg-apple-bg px-2.5 py-1 text-[11px] font-medium text-apple-subtextAlt ring-1 ring-inset ring-black/[0.06]">
                aigc
              </span>
              <span className="num rounded-full bg-apple-bg px-2.5 py-1 text-[11px] font-medium text-apple-subtextAlt ring-1 ring-inset ring-black/[0.06]">
                A 轨
              </span>
            </div>
          </div>

          <div className="mt-4 space-y-3.5">
            <div>
              <div className="flex items-baseline justify-between gap-2">
                <label htmlFor="studio-file" className="text-[13px] font-medium text-apple-text">
                  素材视频
                </label>
                <span className="text-[11px] text-apple-subtext">必填 · 与绝对路径二选一</span>
              </div>

              <div className="mt-1.5 space-y-2">
                <input
                  ref={fileInputRef}
                  id="studio-file"
                  type="file"
                  accept=".mp4,.mov,.mkv,.webm,video/mp4,video/quicktime,video/webm"
                  className="peer sr-only"
                  disabled={uploading}
                  aria-describedby="studio-file-hint"
                  onChange={(event) => {
                    pickFile(event.target.files?.[0])
                    event.target.value = ''
                  }}
                />
                <label
                  ref={dropzoneRef}
                  htmlFor="studio-file"
                  onDragEnter={(event) => {
                    event.preventDefault()
                    if (!uploading) setDragging(true)
                  }}
                  onDragOver={(event) => {
                    event.preventDefault()
                    if (!uploading) setDragging(true)
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(event) => {
                    event.preventDefault()
                    setDragging(false)
                    if (uploading) {
                      setFormError('当前素材仍在上传，请等待完成或失败后再更换文件。')
                      return
                    }
                    pickFile(event.dataTransfer.files?.[0])
                  }}
                  aria-disabled={uploading}
                  className={`flex cursor-pointer flex-col items-center gap-1 rounded-[12px] border border-dashed px-3 text-center transition-colors duration-200 peer-focus-visible:ring-2 peer-focus-visible:ring-apple-blue/45 ${
                    dragging
                      ? 'border-apple-blue bg-[#F0F6FF]'
                      : 'border-black/[0.16] bg-apple-bg/50 hover:border-black/[0.28]'
                  } ${uploading ? 'pointer-events-none opacity-60' : ''} ${file ? 'py-3.5' : 'py-6'}`}
                >
                  <span
                    className={`grid h-8 w-8 place-items-center rounded-full bg-white ${
                      dragging ? 'text-apple-blue' : 'text-apple-subtext'
                    }`}
                  >
                    <Upload className="h-4 w-4" />
                  </span>
                  <span className="text-[12px] font-medium text-apple-text">
                    {file ? '拖拽或点击更换视频' : '拖拽视频到这里，或点击选择'}
                  </span>
                  <span className="text-[11px] leading-relaxed text-apple-subtext">
                    支持 mp4 / mov / mkv / webm · 最大 2 GiB
                  </span>
                </label>
                <p id="studio-file-hint" className="text-[11px] leading-relaxed text-apple-subtext">
                  4 MiB 分块上传，写入 NAS；创建任务时由 Web 服务端转发到 studio，失败可从已完成分块续传。
                </p>
              </div>

              {file && session && (
                <div className="mt-2 rounded-[12px] border border-black/[0.08] bg-white p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-[12px] font-medium" title={file.name}>
                        {file.name}
                      </p>
                      <p className="num mt-0.5 text-[11px] text-apple-subtext">
                        {formatSize(file.size)}
                      </p>
                    </div>
                    <span
                      aria-live="polite"
                      className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ring-inset ${uploadPill}`}
                    >
                      {session.status === 'ready'
                        ? '已上传'
                        : session.status === 'failed'
                          ? '上传失败'
                          : '上传中'}
                    </span>
                  </div>

                  <div
                    className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/[0.06]"
                    role="progressbar"
                    aria-label="素材上传进度"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={progressPct}
                  >
                    <div
                      className={`h-full rounded-full transition-[width] duration-200 ${
                        session.status === 'ready'
                          ? 'bg-apple-statusDone'
                          : session.status === 'failed'
                            ? 'bg-apple-red'
                            : 'bg-apple-blue'
                      }`}
                      style={{ width: `${progressPct}%` }}
                    />
                  </div>
                  <div className="num mt-1.5 flex items-center justify-between gap-2 text-[11px] text-apple-subtext">
                    <span>{progressPct}%</span>
                    <span className="truncate">
                      已传 {formatSize(session.received)} / {formatSize(file.size)}
                    </span>
                  </div>

                  {session.error && (
                    <p
                      role="alert"
                      className="mt-2 break-words rounded-[8px] bg-[#FCEDEB] px-2.5 py-1.5 text-[11px] leading-relaxed text-[#B3261E] ring-1 ring-inset ring-[#F3D3CF]"
                    >
                      上传失败：{session.error}
                    </p>
                  )}

                  {session.status === 'failed' && (
                    <button
                      type="button"
                      onClick={() => void resumeUpload()}
                      className={`${quietButton} mt-2 h-8 px-3 text-[12px]`}
                    >
                      继续上传
                    </button>
                  )}

                  {session.status === 'ready' && (
                    <p className="mt-2 break-words text-[11px] leading-relaxed text-[#1E7A3C]">
                      已上传并写入 NAS。创建任务时由 Web 服务端转发到 studio。
                    </p>
                  )}
                  {session.status === 'ready' && session.sha256 && (
                    <p
                      className="num mt-0.5 truncate text-[10px] text-apple-subtext"
                      title={session.sha256}
                    >
                      sha256 {session.sha256}
                    </p>
                  )}
                </div>
              )}
            </div>

            <details className="group rounded-[12px] border border-black/[0.06] bg-apple-bg/40 px-3 py-2">
              <summary className="flex cursor-pointer select-none items-center gap-1.5 rounded text-[12px] font-medium text-apple-text focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/40">
                <ChevronRight className="h-3 w-3 text-apple-subtext transition-transform duration-200 group-[[open]]:rotate-90" />
                高级：使用 studio 绝对路径
              </summary>
              <div className="pt-2">
                <label htmlFor="studio-source" className="sr-only">
                  studio 绝对路径
                </label>
                <input
                  ref={sourceRef}
                  id="studio-source"
                  type="text"
                  value={path}
                  onChange={(event) => setPath(event.target.value)}
                  placeholder="/abs/path/on/studio.mp4"
                  spellCheck={false}
                  autoComplete="off"
                  aria-describedby="studio-source-hint"
                  className={`${inputClass} num`}
                />
                <p id="studio-source-hint" className="mt-1 text-[11px] leading-relaxed text-apple-subtext">
                  填写后以 studio 上已存在的绝对路径提交，本次上传的素材不会随任务发送（与上传二选一）。
                </p>
                {path.trim() && readyUpload && (
                  <p className="mt-1 rounded-[8px] bg-[#FBF1E4] px-2 py-1 text-[11px] leading-relaxed text-[#8A4B00] ring-1 ring-inset ring-[#F0D9BC]">
                    已上传的素材将不被使用：当前以绝对路径为准。
                  </p>
                )}
              </div>
            </details>

            <Field id="studio-brief" label="Brief" optional hint="可选择已有 Brief，或快速新建一条草稿。">
              <select
                id="studio-brief"
                value={briefChoice}
                onChange={(event) => setBriefChoice(event.target.value)}
                className={`${inputClass} appearance-none pr-8`}
              >
                <option value="none">不关联 Brief</option>
                {briefs.map((brief) => (
                  <option key={brief.id} value={brief.id}>
                    {brief.idea.length > 26 ? `${brief.idea.slice(0, 26)}…` : brief.idea}
                  </option>
                ))}
                <option value="new">＋ 新建 Brief…</option>
              </select>
              {briefsState.status === 'error' && (
                <p className="mt-1 text-[11px] leading-relaxed text-[#B3261E]">
                  Brief 列表加载失败：{briefsState.error}。仍可直接新建 Brief。
                </p>
              )}
            </Field>

            {briefChoice !== 'none' &&
              (briefChoice === 'new' || selectedBrief ? (
                <BriefWorkbench
                  key={briefChoice}
                  brief={briefChoice === 'new' ? null : selectedBrief}
                  onBriefChange={(next) => {
                    setLinkBrief(next)
                    briefsState.refresh()
                  }}
                />
              ) : (
                <p className="mt-2 text-[11px] leading-relaxed text-apple-subtext">
                  Brief 读取中…
                </p>
              ))}

            {readyUpload && !path.trim() && (
              <ProbePanel
                probe={probe}
                blocked={submitBlocked}
                submitting={submitting}
                error={bError}
                onRetry={() => void runProbe(readyUpload.uploadId)}
                onSubmit={() => void handleBSubmit()}
              />
            )}

            {keyframeAsset && (
              <div
                className="flex flex-wrap items-center justify-between gap-2 rounded-[10px] bg-[#EAF2FD] px-3 py-2 text-[11px] leading-relaxed text-apple-blueInk ring-1 ring-inset ring-[#CFE2FA]"
                role="status"
                data-testid="studio-keyframe-hint"
              >
                <span className="min-w-0 break-words">
                  已选关键帧：<span className="num">{keyframeAsset.source_job}/{keyframeAsset.name}</span>
                  （v1 仅注入 shot 1，提交时随 A 轨任务透传）。
                </span>
                <button
                  type="button"
                  onClick={() => setKeyframeAsset(null)}
                  className="shrink-0 font-medium underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
                >
                  移除
                </button>
              </div>
            )}

            {formError && (
              <p
                className="break-words rounded-[10px] bg-[#FCEDEB] px-3 py-2 text-[11px] leading-relaxed text-[#B3261E] ring-1 ring-inset ring-[#F3D3CF]"
                role="alert"
              >
                {formError}
              </p>
            )}

            {notice && (
              <div
                className="flex flex-wrap items-center justify-between gap-2 break-words rounded-[10px] bg-[#EAF8EE] px-3 py-2 text-[11px] leading-relaxed text-[#1E7A3C] ring-1 ring-inset ring-[#CDEED6]"
                role="status"
              >
                <span className="min-w-0 break-words">{notice}</span>
                {createdJobId && (
                  <button
                    type="button"
                    onClick={() => focusJob(createdJobId)}
                    className="shrink-0 font-medium underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
                  >
                    查看任务
                  </button>
                )}
              </div>
            )}

            {submitBlocked && (
              <p
                data-testid="brief-submit-hint"
                className="rounded-[10px] bg-[#FBF1E4] px-3 py-2 text-[11px] leading-relaxed text-[#8A4B00] ring-1 ring-inset ring-[#F0D9BC]"
                role="status"
              >
                需先确认 Brief：润色并确认后才可提交生成，未确认不会触发 GPU。
              </p>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 pt-0.5">
              <p className="min-w-0 text-[11px] leading-relaxed text-apple-subtext">
                浏览器同源写 <span className="num">/api/uploads/*</span> 与{' '}
                <span className="num">/api/studio/*</span>，不携带 studio token。
              </p>
              <button
                type="submit"
                data-testid="brief-submit"
                disabled={submitting || submitBlocked}
                className={`${primaryButton} shrink-0`}
              >
                {submitting
                  ? readyUpload && !path.trim()
                    ? '上传到 studio / 入队…'
                    : '提交中…'
                  : '创建任务'}
              </button>
            </div>
          </div>
        </form>

        <section className="card min-w-0 p-5" aria-labelledby="studio-queue-summary-title" data-testid="studio-queue-summary">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 id="studio-queue-summary-title" className="text-section">
                任务队列
              </h2>
              <p className="mt-1 text-[11px] text-apple-subtext">
                {jobs.status === 'ready' ? `${jobsData.length} 个 · studio 为准` : '读取中'} · 每 4 秒更新
              </p>
            </div>
            <span className="num text-[11px] text-apple-subtext">{formatClock(jobs.updatedAt)}</span>
          </div>

          {jobs.error && (
            <p className="mt-3 break-words rounded-[8px] bg-[#FFF4E5] px-2.5 py-1.5 text-[11px] leading-relaxed text-[#8A4B00]" role="status">
              刷新失败：{jobs.error}
            </p>
          )}

          {focusMissingId && (
            <p className="mt-3 break-words rounded-[8px] bg-[#FFF4E5] px-2.5 py-1.5 text-[11px] leading-relaxed text-[#8A4B00]" role="status">
              未找到任务 <span className="num break-all">{focusMissingId}</span>。
            </p>
          )}

          <div className="mt-4 rounded-[10px] bg-apple-bg/60 px-3 py-2.5">
            {jobs.status === 'error' && !jobs.data ? (
              <p className="text-[11px] leading-relaxed text-apple-subtext">
                studio 不可用，打开队列可重试。
              </p>
            ) : jobsData.length > 0 ? (
              <>
                <p className="text-[10px] text-apple-subtext">最近任务</p>
                <p className="num mt-0.5 break-all text-[12px] font-medium">{jobsData[0].id}</p>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <StudioStatusChip status={jobsData[0].status} />
                  <span className="num text-[11px] text-apple-subtext">
                    {jobsData[0].type}/{jobsData[0].rail}
                  </span>
                </div>
              </>
            ) : (
              <p className="text-[11px] leading-relaxed text-apple-subtext">
                {jobs.status === 'ready' ? '还没有创作任务。' : '读取任务中…'}
              </p>
            )}
          </div>

          <button
            type="button"
            onClick={() => setQueueOpen(true)}
            className={`${quietButton} mt-3 h-9 px-3 text-[12px]`}
            data-testid="studio-queue-open"
            aria-haspopup="dialog"
            aria-expanded={queueOpen}
          >
            打开任务队列
          </button>
          <p className="mt-2 text-[10px] leading-relaxed text-apple-subtext">
            抽屉可开合，支持 Esc；深链 <span className="num">/studio?job=</span> 会自动打开并定位。
          </p>
        </section>

        {queueOpen && (
          <div className="fixed inset-0 z-50" data-testid="studio-queue-overlay">
            <div className="absolute inset-0 bg-black/30" onClick={closeQueue} aria-hidden="true" />
            <aside
              className="absolute inset-y-0 right-0 flex w-full max-w-[560px] flex-col bg-white shadow-2xl"
              role="dialog"
              aria-modal="true"
              aria-labelledby="studio-jobs-title"
              data-testid="studio-queue-drawer"
            >
              <section className="flex min-h-0 flex-1 flex-col overflow-y-auto" aria-labelledby="studio-jobs-title">
          <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 border-b border-black/[0.06] bg-white px-4 py-3">
            <div className="flex items-baseline gap-2">
              <h2 id="studio-jobs-title" className="text-section">
                任务队列
              </h2>
              <span className="num text-[11px] text-apple-subtext">
                {jobs.status === 'ready' ? `${jobsData.length} 个 · studio 为准` : '读取中'}
              </span>
            </div>
            <div className="flex items-center gap-2 text-[11px] text-apple-subtext">
              <span>每 4 秒更新</span>
              <span className="num">· {formatClock(jobs.updatedAt)}</span>
              <button
                type="button"
                onClick={() => jobs.refresh()}
                aria-label="立即刷新任务列表"
                className="grid h-7 w-7 place-items-center rounded-full text-apple-subtext transition-colors hover:bg-black/[0.04] hover:text-apple-text focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
              >
                <Refresh
                  className={`h-3.5 w-3.5 ${jobs.refreshing ? 'animate-spin motion-reduce:animate-none' : ''}`}
                />
              </button>
              <button
                ref={queueCloseRef}
                type="button"
                onClick={closeQueue}
                aria-label="关闭任务队列"
                className="grid h-7 w-7 place-items-center rounded-full text-apple-subtext transition-colors hover:bg-black/[0.04] hover:text-apple-text focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
                data-testid="studio-queue-close"
              >
                <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" aria-hidden="true">
                  <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          </div>

          {jobs.error && (
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-black/[0.06] bg-[#FFF4E5] px-4 py-2.5">
              <p className="break-words text-[11px] leading-relaxed text-[#8A4B00]">
                刷新失败：{jobs.error}
                {jobs.data ? '（显示上次读取的数据）' : ''}
              </p>
              <button
                type="button"
                onClick={() => (jobs.data ? jobs.refresh() : jobs.retry())}
                className="shrink-0 rounded text-[11px] font-medium text-[#8A4B00] underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
              >
                重试
              </button>
            </div>
          )}

          {focusMissingId && (
            <div
              className="break-words border-b border-black/[0.06] bg-[#FFF4E5] px-4 py-2.5 text-[11px] leading-relaxed text-[#8A4B00]"
              role="status"
            >
              未找到任务 <span className="num break-all">{focusMissingId}</span>。链接可能已失效，或该任务不在最近 50
              条内。
            </div>
          )}

          {jobs.status === 'loading' && !jobs.data && <LoadingRows />}

          {jobs.status === 'error' && !jobs.data && (
            <div className="px-6 py-14 text-center">
              <p className="text-sm font-medium">studio 不可用</p>
              <p className="mx-auto mt-1 max-w-[46ch] break-words text-xs leading-relaxed text-apple-subtext">
                任务列表读取失败：{jobs.error}
              </p>
              <button type="button" onClick={jobs.retry} className={`${quietButton} mt-4`}>
                重新读取
              </button>
            </div>
          )}

          {showEmpty && <EmptyQueue onCreate={focusSource} />}

          {jobsData.length > 0 && (
            <ul className="min-w-0">
              {jobsData.map((job) => (
                <JobRow
                  key={`${job.id}-${job.status}`}
                  job={job}
                  briefs={briefs}
                  highlighted={job.id === createdJobId || job.id === focusJobId}
                  defaultExpanded={job.id === focusJobId}
                  focusSignal={job.id === focusJobId ? focusNonce : undefined}
                  onRefresh={() => jobs.refresh()}
                />
              ))}
            </ul>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-black/[0.06] px-4 py-2.5 text-[11px] text-apple-subtext">
            <span>
              数据源 <span className="num">/api/studio/jobs?limit=50</span>
            </span>
            <span className="flex items-center gap-1.5">
              <Plus className="h-3 w-3" aria-hidden="true" />
              新任务出现在这里后自动进入轮询
            </span>
          </div>
              </section>
            </aside>
          </div>
        )}
      </div>

      <ImageWorkbench jobOptions={jobsData} onUseKeyframe={setKeyframeAsset} />
    </div>
  )
}
