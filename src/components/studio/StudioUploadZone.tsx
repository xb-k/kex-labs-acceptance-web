import type { RefObject } from 'react'
import { ChevronRight, Upload } from '../icons'
import { inputClass, quietButton } from '../studio-ui'
import { formatSizeBytes } from '../../format'
import { useCopyToClipboard } from '../../hooks'

export type UploadSession = {
  uploadId: string
  filename: string
  size: number
  chunkSize: number
  received: number
  status: 'uploading' | 'failed' | 'ready'
  error: string | null
  sha256: string | null
}

type StudioUploadZoneProps = {
  file: File | null
  session: UploadSession | null
  dragging: boolean
  uploadSpeedBps: number | null
  path: string
  sourceRef: RefObject<HTMLInputElement>
  fileInputRef: RefObject<HTMLInputElement>
  dropzoneRef: RefObject<HTMLLabelElement>
  onDraggingChange: (next: boolean) => void
  onPickFile: (candidate: File | null | undefined) => void
  onPathChange: (next: string) => void
  onCancelUpload: () => void
  onResumeUpload: () => void
  onRejectDrop: (message: string) => void
}

export function StudioUploadZone({
  file,
  session,
  dragging,
  uploadSpeedBps,
  path,
  sourceRef,
  fileInputRef,
  dropzoneRef,
  onDraggingChange,
  onPickFile,
  onPathChange,
  onCancelUpload,
  onResumeUpload,
  onRejectDrop
}: StudioUploadZoneProps) {
  const { status: shaCopyStatus, copy: copySha } = useCopyToClipboard(1800)

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
    <>
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
              onPickFile(event.target.files?.[0])
              event.target.value = ''
            }}
          />
          <label
            ref={dropzoneRef}
            htmlFor="studio-file"
            onDragEnter={(event) => {
              event.preventDefault()
              if (!uploading) onDraggingChange(true)
            }}
            onDragOver={(event) => {
              event.preventDefault()
              if (!uploading) onDraggingChange(true)
            }}
            onDragLeave={() => onDraggingChange(false)}
            onDrop={(event) => {
              event.preventDefault()
              onDraggingChange(false)
              if (uploading) {
                onRejectDrop('当前素材仍在上传，请等待完成或取消后再更换文件。')
                return
              }
              onPickFile(event.dataTransfer.files?.[0])
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
            4 MiB 分块上传，写入 NAS；创建任务时由 Web 服务端转发到 studio，失败或中断可从已完成分块续传。
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
                  {formatSizeBytes(file.size)}
                  {uploading && uploadSpeedBps != null && uploadSpeedBps > 0 && (
                    <span className="ml-2 text-apple-blueInk">
                      · {(uploadSpeedBps / 1024 / 1024).toFixed(1)} MB/s
                    </span>
                  )}
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
                已传 {formatSizeBytes(session.received)} / {formatSizeBytes(file.size)}
              </span>
            </div>

            {uploading && (
              <div className="mt-2 flex items-center justify-end">
                <button
                  type="button"
                  onClick={onCancelUpload}
                  data-testid="studio-upload-cancel"
                  className={`${quietButton} h-7 px-2.5 text-[11px]`}
                >
                  取消上传
                </button>
              </div>
            )}

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
                onClick={onResumeUpload}
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
              <div className="mt-1 flex items-center justify-between gap-2">
                <p
                  className="num min-w-0 truncate text-[10px] text-apple-subtext"
                  title={session.sha256}
                >
                  sha256 {session.sha256}
                </p>
                <button
                  type="button"
                  onClick={() => void copySha(session.sha256 ?? '')}
                  className="shrink-0 rounded-full border border-black/[0.08] bg-apple-bg/70 px-2 py-0.5 text-[10px] font-medium text-apple-text transition-colors hover:bg-apple-bg focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
                >
                  {shaCopyStatus === 'copied' ? '已复制' : '复制'}
                </button>
              </div>
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
            onChange={(event) => onPathChange(event.target.value)}
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
    </>
  )
}
