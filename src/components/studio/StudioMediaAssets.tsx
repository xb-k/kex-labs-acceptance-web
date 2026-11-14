import { useState } from 'react'
import { deleteJson } from '../../api'
import { formatSizeBytes } from '../../format'
import { formatHttpError } from '../../hooks'
import {
  MEDIA_DELETE_CONFIRM,
  mediaDeleteUrl,
  mediaDownloadUrl,
  mediaForJob,
  type MediaJobItem
} from '../../media-jobs'

/** 队列抽屉一次性拉取的 NAS 媒体状态，逐行按 job 过滤后传入详情。 */
export type MediaJobsState = {
  items: MediaJobItem[]
  loading: boolean
  error: string | null
  onRefresh: () => void
}

const KIND_LABEL: Record<MediaJobItem['kind'], string> = {
  video: '视频',
  image: '图像',
  audio: '音频'
}

/**
 * #160: NAS 已发布媒体列表（纯展示）。删除必须二次确认，确认文案明确「永久、
 * 不可恢复」；删除动作由容器实现并传 `onDelete`。
 */
export function StudioMediaAssetList({
  items,
  busyName = null,
  error = null,
  note = null,
  onDelete
}: {
  items: MediaJobItem[]
  busyName?: string | null
  error?: string | null
  note?: string | null
  onDelete: (item: MediaJobItem) => void | Promise<void>
}) {
  const [confirming, setConfirming] = useState<string | null>(null)

  return (
    <div data-testid="studio-nas-media">
      <ul className="space-y-2">
        {items.map((item) => (
          <li
            key={`${item.job_id}/${item.name}`}
            data-testid={`studio-nas-media-${item.name}`}
            data-media-kind={item.kind}
            className="rounded-[10px] border border-black/[0.08] bg-white p-2.5"
          >
            {item.kind === 'video' ? (
              <video
                src={item.url}
                controls
                muted
                playsInline
                preload="metadata"
                className="max-h-40 w-full rounded-[8px] bg-black object-contain"
              />
            ) : item.kind === 'image' ? (
              <img
                src={item.url}
                alt={item.name}
                loading="lazy"
                className="max-h-40 w-full rounded-[8px] object-cover"
              />
            ) : null}
            <div className="mt-2 flex flex-wrap items-baseline gap-2">
              <span className="shrink-0 rounded-full bg-[#EAF2FD] px-2 py-0.5 text-[10px] font-medium text-apple-blueInk ring-1 ring-inset ring-[#CFE2FA]">
                NAS
              </span>
              <span className="shrink-0 rounded-full bg-white px-2 py-0.5 text-[10px] text-apple-subtext ring-1 ring-inset ring-black/[0.06]">
                {KIND_LABEL[item.kind]}
              </span>
              <span className="num min-w-0 flex-1 break-all text-[11px]" title={item.name}>
                {item.name}
              </span>
              <span className="num shrink-0 text-[11px] text-apple-subtext">
                {item.bytes > 0 ? formatSizeBytes(item.bytes) : '大小未知'}
              </span>
              <a
                href={mediaDownloadUrl(item)}
                download={item.name}
                className="shrink-0 text-[11px] font-medium text-apple-blueInk underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
              >
                下载
              </a>
              <button
                type="button"
                data-testid={`studio-nas-delete-${item.name}`}
                onClick={() => setConfirming(item.name)}
                disabled={busyName === item.name}
                className="shrink-0 text-[11px] font-medium text-[#B3261E] underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#B3261E]/40 disabled:opacity-60"
              >
                删除
              </button>
            </div>

            {confirming === item.name && (
              <div
                role="alertdialog"
                aria-label="确认永久删除 NAS 文件"
                data-testid={`studio-nas-confirm-${item.name}`}
                className="mt-2 rounded-[8px] bg-[#FCEDEB] p-2.5 ring-1 ring-inset ring-[#F3D3CF]"
              >
                <p className="break-words text-[11px] leading-relaxed text-[#B3261E]">
                  {MEDIA_DELETE_CONFIRM}
                </p>
                <div className="mt-1.5 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setConfirming(null)}
                    disabled={busyName === item.name}
                    className="rounded-md bg-white px-2 py-1 text-[11px] font-medium text-apple-text ring-1 ring-inset ring-black/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50 disabled:opacity-60"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    data-testid={`studio-nas-confirm-delete-${item.name}`}
                    onClick={() => {
                      setConfirming(null)
                      void onDelete(item)
                    }}
                    disabled={busyName === item.name}
                    className="rounded-md bg-[#B3261E] px-2 py-1 text-[11px] font-medium text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[#B3261E]/50 disabled:opacity-60"
                  >
                    {busyName === item.name ? '删除中…' : '永久删除'}
                  </button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
      {error && (
        <p
          role="alert"
          data-testid="studio-nas-error"
          className="mt-2 break-words rounded-[8px] bg-[#FCEDEB] px-3 py-2 text-[11px] leading-relaxed text-[#B3261E] ring-1 ring-inset ring-[#F3D3CF]"
        >
          {error}
        </p>
      )}
      {note && (
        <p
          data-testid="studio-nas-note"
          className="mt-2 break-words rounded-[8px] bg-[#EAF8EE] px-3 py-2 text-[11px] leading-relaxed text-[#1E7A3C] ring-1 ring-inset ring-[#CDEED6]"
        >
          {note}
        </p>
      )}
    </div>
  )
}

/**
 * 详情资产区里的 NAS 面板：拉取结果由父级统一提供（抽屉只请求一次），这里只按
 * 当前 job 过滤、执行物理删除并刷新。没有 NAS 资产（进行中）时不渲染，避免假 URL。
 */
export function StudioMediaAssets({
  jobId,
  media
}: {
  jobId: string
  media: MediaJobsState
}) {
  const [busyName, setBusyName] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const items = mediaForJob(media.items, jobId)

  const onDelete = async (item: MediaJobItem) => {
    if (busyName) return
    setBusyName(item.name)
    setActionError(null)
    setNote(null)
    try {
      await deleteJson<{ ok?: boolean }>(mediaDeleteUrl(item))
      setNote(`已永久删除 ${item.name}`)
      media.onRefresh()
    } catch (err) {
      setActionError(formatHttpError(err, '永久删除失败，请稍后重试。'))
    } finally {
      setBusyName(null)
    }
  }

  if (media.loading && items.length === 0) {
    return <p className="text-[11px] text-apple-subtext">读取 NAS 媒体…</p>
  }
  if (media.error && items.length === 0) {
    return (
      <p data-testid="studio-nas-load-error" className="break-words text-[11px] text-apple-subtext">
        NAS 媒体读取失败：{media.error}
      </p>
    )
  }
  if (items.length === 0) return null

  return <StudioMediaAssetList items={items} busyName={busyName} error={actionError} note={note} onDelete={onDelete} />
}
