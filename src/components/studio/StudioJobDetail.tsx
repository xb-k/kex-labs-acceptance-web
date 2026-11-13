import type { ReactNode } from 'react'
import { formatSizeBytes, formatStamp } from '../../format'
import { formatJobDuration } from '../../image-workbench'
import type { StudioAsset, StudioBrief, StudioJob, StudioJobSummary } from '../../types'

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

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="min-w-0">
      <h4 className="text-[11px] font-semibold tracking-[0.02em] text-apple-subtext">{title}</h4>
      <div className="mt-1.5 text-[12px] leading-relaxed text-apple-text">{children}</div>
    </section>
  )
}

export function StudioJobDetail({
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
              <dd className="num">{formatStamp(detail.created_at, true)}</dd>
              <dt className="text-apple-subtext">更新</dt>
              <dd className="num">{formatStamp(detail.updated_at, true)}</dd>
              <dt className="text-apple-subtext">耗时</dt>
              <dd className="num" data-testid="studio-job-duration">
                {formatJobDuration(job.duration_ms)}
              </dd>
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
                  {formatSizeBytes(sourceAsset.size_bytes)}
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
                    <span className="num shrink-0 text-apple-subtext">{formatStamp(event.ts, true)}</span>
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
                  {otherAssets.map((asset) => {
                    // #151: proxy-served artifacts show the file name + size + a
                    // download link instead of the raw studio path.
                    const proxied = asset.uri.startsWith('/api/studio/jobs/')
                    const fileName = proxied
                      ? decodeURIComponent(asset.uri.split('/').pop() ?? '')
                      : asset.uri.replace(/^studio:\/\//, '')
                    return (
                      <li key={asset.id} className="flex flex-wrap items-baseline gap-2">
                        <span className="shrink-0 rounded-full bg-white px-2 py-0.5 text-[10px] text-apple-subtext ring-1 ring-inset ring-black/[0.06]">
                          {KIND_LABEL[asset.kind] ?? asset.kind}
                        </span>
                        <span
                          className="num min-w-0 flex-1 break-all text-[11px]"
                          title={fileName}
                          data-testid={`studio-asset-${asset.id}`}
                        >
                          {fileName}
                        </span>
                        <span className="num shrink-0 text-[11px] text-apple-subtext">
                          {asset.size_bytes > 0 ? formatSizeBytes(asset.size_bytes) : '大小未知'}
                        </span>
                        {proxied && (
                          <a
                            href={asset.uri}
                            download={fileName}
                            className="shrink-0 text-[11px] font-medium text-apple-blueInk underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
                          >
                            下载
                          </a>
                        )}
                      </li>
                    )
                  })}
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
