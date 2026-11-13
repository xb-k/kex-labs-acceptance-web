import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { deleteJson, getJson, HttpError, postJson, useLiveJson } from '../api'
import type {
  StudioAssetRef,
  StudioGalleryItem,
  StudioImageMode,
  StudioJob,
  StudioJobSummary,
  StudioKeyframeRef
} from '../types'
import { Field, inputClass, primaryButton, quietButton } from './studio-ui'
import { StudioStatusChip } from './StudioStatusChip'
import { ToastHost } from './ui'
import { Trash } from './icons'
import { useInfiniteScrollBatch, useToast } from '../hooks'
import {
  DEFAULT_EDIT_DENOISE,
  DEFAULT_IMAGE_SIZE,
  DEFAULT_SEED,
  DEFAULT_STEPS,
  IMAGE_SIZES,
  T2I_DENOISE,
  buildImageJobPayload,
  buildJobDeletePlan,
  canDeleteJob,
  formatJobDuration,
  galleryMeta,
  galleryPrimaryImage,
  galleryStatusLabel,
  imageActionState,
  referencePanelState,
  validateCoverTarget,
  validateImageForm
} from '../image-workbench'
import { uploadFileInChunks } from '../upload-client'

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp']

type GalleryResponse = { items: StudioGalleryItem[]; count: number; source: 'studio' }

type SelectedImage = { item: StudioGalleryItem; image: { name: string; url: string } }

type CoverResponse = {
  job: string
  cover_asset: StudioAssetRef | null
  cover_url: string | null
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : '请求失败'
}

/** 从 HttpError 里取出后端 `{error, reason}`，4xx 时把 reason 一并展示。 */
function requestErrorText(err: unknown): string {
  if (err instanceof HttpError) {
    const payload =
      err.payload !== null && typeof err.payload === 'object'
        ? (err.payload as { error?: unknown; reason?: unknown })
        : null
    const code = typeof payload?.error === 'string' ? payload.error : `HTTP ${err.status}`
    const reason = typeof payload?.reason === 'string' && payload.reason ? payload.reason : null
    return reason ? `${code}（reason: ${reason}）` : `${err.message === code ? '' : `${err.message} · `}${code}`
  }
  return errorText(err)
}

/** 提交后的 4s 轮询：状态以 studio 为准，终态即停，不伪造成功。 */
function ImageJobTracker({ jobId }: { jobId: string }) {
  const [job, setJob] = useState<StudioJob | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [settled, setSettled] = useState(false)

  useEffect(() => {
    let alive = true
    let timer: number | null = null
    setJob(null)
    setError(null)
    setSettled(false)

    const stop = () => {
      if (timer !== null) {
        window.clearInterval(timer)
        timer = null
      }
    }

    const load = async () => {
      try {
        const next = await getJson<StudioJob>(`/api/studio/jobs/${encodeURIComponent(jobId)}`)
        if (!alive) return
        setJob(next)
        setError(null)
        if (next.status === 'succeeded' || next.status === 'failed' || next.status === 'canceled') {
          setSettled(true)
          stop()
        }
      } catch (err) {
        if (!alive) return
        setError(errorText(err))
      }
    }

    void load()
    timer = window.setInterval(() => void load(), 4000)
    return () => {
      alive = false
      stop()
    }
  }, [jobId])

  return (
    <div
      className="rounded-[12px] border border-black/[0.06] bg-apple-bg/50 px-3 py-2.5"
      aria-live="polite"
      data-testid="image-job-tracker"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="num break-all text-[12px] font-medium">{jobId}</span>
        {job ? <StudioStatusChip status={job.status} /> : <span className="text-[11px] text-apple-subtext">读取中…</span>}
        {settled && <span className="text-[11px] text-apple-subtext">已停止轮询</span>}
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-apple-subtext">
        阶段：<span className="num">{job?.stage ?? '等待 studio'}</span>
        {' · '}每 4 秒刷新，状态与失败原因以 studio 为准。
      </p>
      {job?.error && (
        <p
          className="mt-1.5 break-words rounded-[8px] bg-[#FCEDEB] px-2.5 py-1.5 text-[11px] leading-relaxed text-[#B3261E] ring-1 ring-inset ring-[#F3D3CF]"
          role="alert"
        >
          {job.error}
        </p>
      )}
      {error && (
        <p className="mt-1.5 break-words text-[11px] leading-relaxed text-[#B3261E]" role="alert">
          轮询失败：{error}
        </p>
      )}
    </div>
  )
}

function GalleryCard({
  item,
  selected,
  deleting,
  onSelect,
  onPreview,
  onDelete
}: {
  item: StudioGalleryItem
  selected: boolean
  deleting: boolean
  onSelect: (image: SelectedImage) => void
  onPreview: (image: SelectedImage) => void
  onDelete: (item: StudioGalleryItem) => void
}) {
  const primary = galleryPrimaryImage(item)
  return (
    <li
      className={`overflow-hidden rounded-[12px] border bg-white transition-colors ${
        selected ? 'border-apple-blue ring-2 ring-apple-blue/25' : 'border-black/[0.08]'
      }`}
      data-testid="image-gallery-item"
      data-job-id={item.id}
    >
      <button
        type="button"
        className="group block w-full bg-apple-bg/60 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/45"
        onClick={() => primary && onPreview({ item, image: primary })}
        disabled={!primary}
        aria-label={primary ? `查看大图：${item.id} / ${primary.name}` : `${item.id} 暂无产物`}
        title={primary ? '点击查看大图（Esc 关闭）' : undefined}
        data-testid="image-open"
      >
        {primary ? (
          <img
            src={primary.url}
            alt={item.prompt ? `生成图：${item.prompt}` : `生成图 ${item.id}`}
            loading="lazy"
            decoding="async"
            className="aspect-[16/9] w-full object-cover"
          />
        ) : (
          <span className="flex aspect-[16/9] w-full items-center justify-center text-[11px] text-apple-subtext">
            {item.status === 'failed' ? '生成失败，无产物' : '暂无产物'}
          </span>
        )}
      </button>
      <div className="space-y-1.5 px-3 py-2.5">
        <div className="flex flex-wrap items-center justify-between gap-1.5">
          <StudioStatusChip status={item.status} />
          <span className="num text-[10px] text-apple-subtext" data-testid="image-duration">
            {formatJobDuration(item.duration_ms)}
          </span>
        </div>
        <p className="line-clamp-2 break-words text-[12px] leading-relaxed" title={item.prompt ?? ''}>
          {item.prompt ?? '（无 prompt 记录）'}
        </p>
        <p className="num break-all text-[10px] text-apple-subtext">{galleryMeta(item)}</p>
        {item.status === 'failed' && item.error && (
          <p
            className="line-clamp-3 break-words rounded-[8px] bg-[#FCEDEB] px-2 py-1 text-[10px] leading-relaxed text-[#B3261E]"
            title={item.error}
          >
            {item.error}
          </p>
        )}
        {item.cover_url && (
          <p className="text-[10px] text-[#1E7A3C]">已设为封面 · cover_asset 可回读</p>
        )}
        {canDeleteJob(item.status) && (
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => onDelete(item)}
              disabled={deleting}
              aria-label={`删除任务 ${item.id}（${galleryStatusLabel(item.status)}）`}
              title="删除任务（失败 / 已取消）"
              data-testid="image-delete"
              className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-black/[0.08] bg-white text-apple-subtext transition-colors hover:border-[#E7B4AE] hover:text-[#B3261E] focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/45 disabled:cursor-not-allowed disabled:opacity-55"
            >
              {deleting ? (
                <span
                  aria-hidden="true"
                  className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-black/15 border-t-[#B3261E]"
                />
              ) : (
                <Trash className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
        )}
        {primary && (
          <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
            <button
              type="button"
              onClick={() => onSelect({ item, image: primary })}
              aria-pressed={selected}
              className={`rounded-lg border px-2.5 py-1 text-[10px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/45 ${
                selected
                  ? 'border-apple-blue bg-[#F0F6FF] text-apple-blueInk'
                  : 'border-black/[0.1] bg-white text-apple-text hover:border-black/[0.24]'
              }`}
              data-testid="image-select"
            >
              {selected ? '已选中' : '选中'}
            </button>
            <button
              type="button"
              onClick={() => onPreview({ item, image: primary })}
              className="text-[10px] font-medium text-apple-blueInk underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/45"
              data-testid="image-preview"
            >
              查看大图
            </button>
          </div>
        )}
      </div>
    </li>
  )
}

export function ImageWorkbench({
  jobOptions,
  onUseKeyframe
}: {
  jobOptions: StudioJobSummary[]
  onUseKeyframe: (ref: StudioKeyframeRef) => void
}) {
  const [mode, setMode] = useState<StudioImageMode>('t2i')
  const [prompt, setPrompt] = useState('')
  const [negative, setNegative] = useState('')
  const [size, setSize] = useState(DEFAULT_IMAGE_SIZE)
  const [seed, setSeed] = useState(DEFAULT_SEED)
  const [steps, setSteps] = useState(DEFAULT_STEPS)
  const [denoise, setDenoise] = useState(T2I_DENOISE)
  const [sourceUploadId, setSourceUploadId] = useState<string | null>(null)
  const [sourceName, setSourceName] = useState<string | null>(null)
  const [sourceImage, setSourceImage] = useState('')
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [activeJobId, setActiveJobId] = useState<string | null>(null)
  const [galleryJob, setGalleryJob] = useState('')
  const [selected, setSelected] = useState<SelectedImage | null>(null)
  const [lightbox, setLightbox] = useState<SelectedImage | null>(null)
  const [coverTarget, setCoverTarget] = useState('')
  const [coverBusy, setCoverBusy] = useState(false)
  const [coverError, setCoverError] = useState<string | null>(null)
  const [coverResult, setCoverResult] = useState<CoverResponse | null>(null)
  const [keyframeNote, setKeyframeNote] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<StudioGalleryItem | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [removedIds, setRemovedIds] = useState<ReadonlySet<string>>(() => new Set())
  const { toast, showToast, clearToast } = useToast(4000)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const galleryUrl = useMemo(() => {
    const filter = galleryJob.trim()
    return `/api/studio/gallery?limit=50${filter ? `&job=${encodeURIComponent(filter)}` : ''}`
  }, [galleryJob])
  const gallery = useLiveJson<GalleryResponse>(galleryUrl, 4000)
  // 删除成功后立即从列表移除；后端下一轮刷新返回的旧快照也被 removedIds 过滤。
  const items = (gallery.data?.items ?? []).filter((item) => !removedIds.has(item.id))
  const galleryBatch = useInfiniteScrollBatch(items.length, 9, 9, galleryJob)
  const pagedItems = items.slice(0, galleryBatch.visibleCount)

  const jobChoices = useMemo(
    () => jobOptions.filter((job) => job.type === 'aigc').slice(0, 50),
    [jobOptions]
  )

  useEffect(() => {
    if (!lightbox) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setLightbox(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lightbox])

  useEffect(() => {
    if (!pendingDelete) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && deletingId === null) {
        setPendingDelete(null)
        setDeleteError(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pendingDelete, deletingId])

  function switchMode(next: StudioImageMode) {
    setMode(next)
    setDenoise(next === 't2i' ? T2I_DENOISE : DEFAULT_EDIT_DENOISE)
    setFormError(null)
  }

  async function handleReferencePick(file: File | null) {
    if (!file) return
    const dot = file.name.lastIndexOf('.')
    const ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : ''
    if (!IMAGE_EXTS.includes(ext)) {
      setUploadError(`仅支持 png / jpg / jpeg / webp，收到${ext ? ` ${ext}` : '未知类型'}。`)
      return
    }
    if (file.size <= 0) {
      setUploadError('文件为空（0 字节）。')
      return
    }
    setUploading(true)
    setUploadError(null)
    setSourceUploadId(null)
    setSourceName(file.name)
    setUploadProgress(0)
    try {
      const result = await uploadFileInChunks(file, setUploadProgress)
      setSourceUploadId(result.uploadId)
    } catch (err) {
      setUploadError(requestErrorText(err))
    } finally {
      setUploading(false)
    }
  }

  function clearReference() {
    setSourceUploadId(null)
    setSourceName(null)
    setUploadProgress(0)
    setUploadError(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  /** 上传完成后的一键切换：显式改到 Edit，并清掉可能冲突的绝对路径。 */
  function switchToEditWithReference() {
    setSourceImage('')
    switchMode('edit')
    setNotice('已切换到「参考图改写」，提交时会使用已上传的参考图。')
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFormError(null)
    setNotice(null)
    if (uploading) {
      setFormError('参考图仍在上传，请等待完成。')
      return
    }
    const checked = validateImageForm({
      mode,
      prompt,
      negative,
      size,
      seed,
      steps,
      denoise,
      sourceUploadId,
      sourceImage
    })
    if (!checked.ok) {
      setFormError(checked.error)
      return
    }
    setSubmitting(true)
    try {
      const job = await postJson<StudioJob>('/api/studio/jobs', buildImageJobPayload(checked.image))
      setActiveJobId(job.id)
      setNotice(`已提交图片任务 ${job.id}。状态每 4 秒刷新，产物见下方 gallery。`)
      gallery.refresh()
    } catch (err) {
      setFormError(requestErrorText(err))
    } finally {
      setSubmitting(false)
    }
  }

  /** 点卡片只选中，不弹大图；大图由卡片 / 已选行的「查看大图」显式打开，避免全屏遮罩挡住封面/关键帧面板。 */
  const handleSelect = useCallback((image: SelectedImage) => {
    setSelected(image)
    setCoverError(null)
    setCoverResult(null)
    setKeyframeNote(null)
  }, [])
  const handlePreview = useCallback((image: SelectedImage) => setLightbox(image), [])

  /** #140 删除入口只对 failed / canceled 渲染；点开后先弹二次确认。 */
  function requestDelete(item: StudioGalleryItem) {
    if (deletingId !== null) return
    setPendingDelete(item)
    setDeleteError(null)
  }

  async function confirmDelete() {
    const plan = pendingDelete ? buildJobDeletePlan(pendingDelete) : null
    if (!plan || !pendingDelete) return
    const id = pendingDelete.id
    setDeletingId(id)
    setDeleteError(null)
    try {
      await deleteJson<{ deleted: boolean; id: string }>(plan.url)
      setRemovedIds((prev) => new Set([...prev, id]))
      if (selected?.item.id === id) setSelected(null)
      if (lightbox?.item.id === id) setLightbox(null)
      setPendingDelete(null)
      showToast(`已删除任务 ${id}`)
      gallery.refresh()
    } catch (err) {
      // 失败保留确认框，直接展示后端 error / reason，不吞错。
      setDeleteError(requestErrorText(err))
    } finally {
      setDeletingId(null)
    }
  }

  async function handleSetCover() {
    if (!selected) {
      setCoverError('请先在 gallery 里点选一张图。')
      return
    }
    const checked = validateCoverTarget(coverTarget, selected.item.id, selected.image.name)
    if (!checked.ok) {
      setCoverError(checked.error)
      return
    }
    setCoverBusy(true)
    setCoverError(null)
    setCoverResult(null)
    try {
      const result = await postJson<CoverResponse>(
        `/api/studio/jobs/${encodeURIComponent(checked.target)}/cover`,
        checked.body
      )
      setCoverResult(result)
      gallery.refresh()
    } catch (err) {
      setCoverError(requestErrorText(err))
    } finally {
      setCoverBusy(false)
    }
  }

  function handleUseKeyframe() {
    if (!selected) {
      setKeyframeNote('请先在 gallery 里点选一张图。')
      return
    }
    onUseKeyframe({ source_job: selected.item.id, name: selected.image.name })
    setKeyframeNote(`已选择 ${selected.item.id}/${selected.image.name} 作为下一个 A 轨任务的关键帧（v1 仅注入 shot 1）。`)
  }

  const sizeDisabled = uploading || submitting
  const actionState = imageActionState({ hasSelection: selected !== null, coverBusy })
  const referenceState = referencePanelState({ mode, uploadId: sourceUploadId, uploading })
  const deletePlan = pendingDelete ? buildJobDeletePlan(pendingDelete) : null

  return (
    <section id="studio-image" className="card min-w-0 scroll-mt-6" aria-labelledby="studio-image-title">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-black/[0.06] px-4 py-3">
        <div>
          <h2 id="studio-image-title" className="text-section">
            图片工作台
          </h2>
          <p className="mt-1 max-w-[72ch] text-[11px] leading-relaxed text-apple-subtext">
            Qwen-Image 文生图 / 参考图改写。任务异步执行，每 4 秒轮询；产物可设为封面，或注入下一个 A 轨任务的关键帧（v1 仅 shot 1）。
          </p>
        </div>
        <span className="num rounded-md bg-apple-bg px-2.5 py-1 text-[11px] text-apple-subtext">type=image</span>
      </div>

      <div className="grid gap-5 p-4 lg:grid-cols-[minmax(300px,360px)_minmax(0,1fr)] lg:items-start">
        <form onSubmit={handleSubmit} className="space-y-3.5" aria-describedby="image-form-hint">
          <fieldset>
            <legend className="text-[13px] font-medium text-apple-text">模式</legend>
            <div className="mt-1.5 grid grid-cols-2 gap-1 rounded-[10px] bg-apple-bg p-1" role="group">
              {(
                [
                  { value: 't2i', label: '文生图 T2I' },
                  { value: 'edit', label: '参考图改写 Edit' }
                ] as Array<{ value: StudioImageMode; label: string }>
              ).map((option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={mode === option.value}
                  onClick={() => switchMode(option.value)}
                  className={`h-8 rounded-[8px] text-[12px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/45 ${
                    mode === option.value ? 'bg-white text-apple-text shadow-nav' : 'text-apple-subtext'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </fieldset>

          <Field id="image-prompt" label="Prompt" hint="描述画面主体、风格与镜头；必填。">
            <textarea
              id="image-prompt"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={4}
              placeholder="例：雪山日出，长焦压缩，金色逆光，写实电影感"
              className={`${inputClass} h-auto min-h-[88px] py-2 leading-relaxed`}
            />
          </Field>

          <Field id="image-negative" label="Negative" optional hint="不希望出现的元素。">
            <input
              id="image-negative"
              type="text"
              value={negative}
              onChange={(event) => setNegative(event.target.value)}
              placeholder="例：低清、畸变、水印"
              className={inputClass}
            />
          </Field>

          <fieldset>
            <legend className="text-[13px] font-medium text-apple-text">尺寸</legend>
            <div className="mt-1.5 grid grid-cols-3 gap-1.5">
              {IMAGE_SIZES.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={size === option.value}
                  onClick={() => setSize(option.value)}
                  disabled={sizeDisabled}
                  className={`rounded-[10px] border px-2 py-1.5 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/45 disabled:opacity-60 ${
                    size === option.value
                      ? 'border-apple-blue bg-[#F0F6FF]'
                      : 'border-black/[0.1] bg-white hover:border-black/[0.22]'
                  }`}
                >
                  <span className="block text-[12px] font-medium">{option.label}</span>
                  <span className="num block text-[10px] text-apple-subtext">{option.hint}</span>
                </button>
              ))}
            </div>
          </fieldset>

          <div className="grid grid-cols-3 gap-2">
            <Field id="image-seed" label="Seed">
              <input
                id="image-seed"
                type="number"
                min={0}
                max={4294967295}
                step={1}
                value={seed}
                onChange={(event) => setSeed(event.target.value)}
                className={`${inputClass} num`}
              />
            </Field>
            <Field id="image-steps" label="Steps">
              <input
                id="image-steps"
                type="number"
                min={1}
                max={100}
                step={1}
                value={steps}
                onChange={(event) => setSteps(event.target.value)}
                className={`${inputClass} num`}
              />
            </Field>
            <Field
              id="image-denoise"
              label="Denoise"
              hint={mode === 't2i' ? 'T2I 固定 1.0' : '重绘强度 (0,1]'}
            >
              <input
                id="image-denoise"
                type="number"
                min={0.01}
                max={1}
                step={0.05}
                value={mode === 't2i' ? T2I_DENOISE : denoise}
                onChange={(event) => setDenoise(event.target.value)}
                disabled={mode === 't2i' || sizeDisabled}
                className={`${inputClass} num disabled:bg-apple-bg disabled:text-apple-subtext`}
              />
            </Field>
          </div>

          <div
            className="space-y-2 rounded-[12px] border border-black/[0.06] bg-apple-bg/40 p-3"
            data-testid="image-reference-panel"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-1">
              <p className="text-[13px] font-medium">参考图</p>
              <span className="text-[10px] text-apple-subtext">png / jpg / jpeg / webp · 4 MiB 分块</span>
            </div>
            <p className="text-[11px] leading-relaxed text-apple-subtext" data-testid="image-reference-note">
              {referenceState.note}
            </p>
            <input
              ref={fileInputRef}
              id="image-reference"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(event) => void handleReferencePick(event.target.files?.[0] ?? null)}
              disabled={uploading || submitting}
              data-testid="image-reference-upload"
              className="block w-full text-[11px] text-apple-subtext file:mr-2 file:rounded-full file:border-0 file:bg-white file:px-3 file:py-1.5 file:text-[11px] file:font-medium file:text-apple-text"
            />
            <p className="text-[11px] leading-relaxed text-apple-subtext">
              4 MiB 分块上传到 NAS，提交时由服务端转发为 <span className="num">source_upload_id</span>。
            </p>
            {uploading && (
              <div aria-live="polite">
                <div className="h-1.5 overflow-hidden rounded-full bg-black/[0.08]">
                  <div className="h-full rounded-full bg-apple-blue" style={{ width: `${uploadProgress}%` }} />
                </div>
                <p className="num mt-1 text-[11px] text-apple-subtext">{uploadProgress}% 上传中…</p>
              </div>
            )}
            {!uploading && sourceUploadId && (
              <p
                className="num break-all rounded-[8px] bg-[#EAF8EE] px-2 py-1.5 text-[11px] text-[#1E7A3C]"
                data-testid="image-reference-ready"
              >
                {sourceName} · upload_id {sourceUploadId}
              </p>
            )}
            {referenceState.showSwitchToEdit && (
              <div
                className="flex flex-wrap items-center justify-between gap-2 rounded-[8px] bg-[#EAF2FD] px-2.5 py-2 text-apple-blueInk ring-1 ring-inset ring-[#CFE2FA]"
                data-testid="image-reference-switch-hint"
              >
                <p className="min-w-0 text-[11px] leading-relaxed">当前是文生图，参考图不会参与生成。</p>
                <button
                  type="button"
                  onClick={switchToEditWithReference}
                  className={`${primaryButton} h-8 shrink-0 px-3 text-[12px]`}
                  data-testid="image-reference-switch-edit"
                >
                  改用参考图改写
                </button>
              </div>
            )}
            {uploadError && (
              <p
                className="break-words rounded-[8px] bg-[#FCEDEB] px-2.5 py-1.5 text-[11px] leading-relaxed text-[#B3261E]"
                role="alert"
                data-testid="image-reference-error"
              >
                {uploadError}
              </p>
            )}
            {(sourceUploadId || sourceName) && !uploading && (
              <button
                type="button"
                onClick={clearReference}
                className={`${quietButton} h-8 px-3 text-[12px]`}
                data-testid="image-reference-clear"
              >
                清除参考图
              </button>
            )}
            <details className="group rounded-[10px] border border-black/[0.06] bg-white px-2.5 py-1.5">
              <summary className="cursor-pointer select-none text-[12px] font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/45">
                高级：studio 上已存在的绝对路径
              </summary>
              <div className="pt-2">
                <label htmlFor="image-source" className="sr-only">
                  studio 绝对路径
                </label>
                <input
                  id="image-source"
                  type="text"
                  value={sourceImage}
                  onChange={(event) => setSourceImage(event.target.value)}
                  placeholder="/abs/path/on/studio.png"
                  spellCheck={false}
                  className={`${inputClass} num`}
                />
                <p className="mt-1 text-[10px] leading-relaxed text-apple-subtext">
                  仅 Edit 模式使用；与上传二选一。
                </p>
              </div>
            </details>
          </div>

          {formError && (
            <p
              className="break-words rounded-[10px] bg-[#FCEDEB] px-3 py-2 text-[11px] leading-relaxed text-[#B3261E] ring-1 ring-inset ring-[#F3D3CF]"
              role="alert"
            >
              {formError}
            </p>
          )}
          {notice && (
            <p
              className="break-words rounded-[10px] bg-[#EAF8EE] px-3 py-2 text-[11px] leading-relaxed text-[#1E7A3C] ring-1 ring-inset ring-[#CDEED6]"
              role="status"
            >
              {notice}
            </p>
          )}

          <button type="submit" data-testid="image-submit" disabled={submitting || uploading} className={primaryButton}>
            {submitting ? '提交中…' : uploading ? '参考图上传中…' : '提交图片任务'}
          </button>
          <p id="image-form-hint" className="text-[11px] leading-relaxed text-apple-subtext">
            同源写 <span className="num">/api/studio/jobs</span>；生成失败时展示 studio 返回的 reason，不伪造成功。
          </p>

          {activeJobId && <ImageJobTracker jobId={activeJobId} />}
        </form>

        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h3 className="text-section">Gallery</h3>
              <p className="mt-0.5 text-[11px] text-apple-subtext">
                最近图片任务（gallery 每 4 秒刷新）。点缩略图 / Enter 查看大图；「选中」标记封面 / 关键帧目标。
              </p>
            </div>
            <div className="flex items-end gap-2">
              <div>
                <label htmlFor="gallery-job-filter" className="text-[11px] text-apple-subtext">
                  按 job 过滤
                </label>
                <input
                  id="gallery-job-filter"
                  type="text"
                  value={galleryJob}
                  onChange={(event) => setGalleryJob(event.target.value)}
                  placeholder="job id（可空）"
                  spellCheck={false}
                  className={`${inputClass} num mt-0.5 h-8 w-[180px] text-[12px]`}
                />
              </div>
              <button
                type="button"
                onClick={() => gallery.refresh()}
                className={`${quietButton} h-8 px-3 text-[12px]`}
              >
                刷新
              </button>
            </div>
          </div>

          {gallery.status === 'loading' && !gallery.data && (
            <p className="rounded-[12px] bg-apple-bg/60 px-4 py-10 text-center text-[12px] text-apple-subtext" aria-busy="true">
              读取 gallery…
            </p>
          )}

          {gallery.status === 'error' && !gallery.data && (
            <div className="rounded-[12px] bg-[#FCEDEB] px-4 py-8 text-center" role="alert">
              <p className="text-[12px] font-medium text-[#B3261E]">gallery 读取失败</p>
              <p className="mx-auto mt-1 max-w-[46ch] break-words text-[11px] text-[#B3261E]">{gallery.error}</p>
              <button type="button" onClick={() => gallery.retry()} className={`${quietButton} mt-3 h-8 px-3 text-[12px]`}>
                重试
              </button>
            </div>
          )}

          {gallery.data && gallery.error && (
            <p className="break-words rounded-[8px] bg-[#FBF1E4] px-3 py-1.5 text-[11px] text-[#8A4B00]" role="status">
              刷新失败（保留上次数据）：{gallery.error}
            </p>
          )}

          {gallery.data && items.length === 0 && (
            <div className="rounded-[12px] border border-dashed border-black/[0.12] px-4 py-10 text-center">
              <p className="text-[12px] font-medium">还没有图片任务</p>
              <p className="mt-1 text-[11px] leading-relaxed text-apple-subtext">
                {galleryJob.trim()
                  ? `没有匹配 job「${galleryJob.trim()}」的图片任务，清空过滤后再试。`
                  : '提交第一个 T2I / Edit 任务后，产物会出现在这里。'}
              </p>
            </div>
          )}

          {items.length > 0 && (
            <div
              className="max-h-[min(60vh,520px)] space-y-2.5 overflow-y-auto overscroll-contain pr-1.5"
              data-testid="image-gallery-scroll"
            >
              <ul className="grid gap-2.5 sm:grid-cols-2 2xl:grid-cols-3" aria-label="图片任务 gallery">
                {pagedItems.map((item) => (
                  <GalleryCard
                    key={item.id}
                    item={item}
                    selected={selected?.item.id === item.id && selected.image.name === galleryPrimaryImage(item)?.name}
                    deleting={deletingId === item.id}
                    onSelect={handleSelect}
                    onPreview={handlePreview}
                    onDelete={requestDelete}
                  />
                ))}
              </ul>
              <div
                ref={galleryBatch.sentinelRef}
                data-testid="image-gallery-lazy-sentinel"
                className="flex flex-wrap items-center justify-between gap-2 border-t border-black/[0.06] pt-2 text-[11px] text-apple-subtext"
              >
                <span className="num">
                  已加载 {pagedItems.length} / {items.length} 张产物
                  {galleryBatch.hasMore ? ' · 向下滚动自动懒加载' : ' · 已全部加载'}
                </span>
                {galleryBatch.hasMore && (
                  <button
                    type="button"
                    onClick={galleryBatch.loadMore}
                    className="rounded-lg border border-black/[0.08] bg-white px-2.5 py-1 text-[11px] font-medium text-apple-text hover:bg-black/[0.03]"
                  >
                    加载更多
                  </button>
                )}
              </div>
            </div>
          )}

          <div className="rounded-[12px] border border-black/[0.06] bg-apple-bg/40 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-[13px] font-medium">素材回流</h3>
              <span className="text-[10px] text-apple-subtext">选中图 → 封面 / 关键帧</span>
            </div>
            {selected ? (
              <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
                <p className="num min-w-0 break-all text-[11px]" data-testid="image-selected">
                  已选：{selected.item.id} / {selected.image.name}
                </p>
                <button
                  type="button"
                  onClick={() => handlePreview(selected)}
                  className="shrink-0 text-[10px] font-medium text-apple-blueInk underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/45"
                  data-testid="image-preview-selected"
                >
                  查看大图
                </button>
              </div>
            ) : (
              <p className="mt-1.5 text-[11px] text-apple-subtext">上方 gallery 点选一张图后，可设为封面或关键帧。</p>
            )}

            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <div className="space-y-2 rounded-[10px] bg-white p-2.5 ring-1 ring-inset ring-black/[0.06]">
                <p className="text-[12px] font-medium">设为封面</p>
                <label htmlFor="cover-target" className="block text-[10px] text-apple-subtext">
                  目标 job id（可输入或从最近任务选）
                </label>
                <input
                  id="cover-target"
                  type="text"
                  list="studio-job-options"
                  value={coverTarget}
                  onChange={(event) => setCoverTarget(event.target.value)}
                  placeholder="job id"
                  spellCheck={false}
                  className={`${inputClass} num h-8 text-[12px]`}
                  data-testid="image-cover-target"
                />
                <datalist id="studio-job-options">
                  {jobChoices.map((job) => (
                    <option key={job.id} value={job.id}>
                      {`${job.type}/${job.rail} · ${job.status}`}
                    </option>
                  ))}
                </datalist>
                <button
                  type="button"
                  onClick={() => void handleSetCover()}
                  disabled={actionState.coverDisabled}
                  className={`${quietButton} h-8 px-3 text-[12px] disabled:opacity-55`}
                  data-testid="image-set-cover"
                >
                  {coverBusy ? '写入中…' : '设为封面'}
                </button>
                {coverError && (
                  <p
                    className="break-words rounded-[8px] bg-[#FCEDEB] px-2 py-1.5 text-[10px] leading-relaxed text-[#B3261E]"
                    role="alert"
                    data-testid="image-cover-error"
                  >
                    {coverError}
                  </p>
                )}
                {coverResult && (
                  <div
                    className="rounded-[8px] bg-[#EAF8EE] px-2 py-1.5 text-[10px] leading-relaxed text-[#1E7A3C]"
                    data-testid="image-cover-result"
                  >
                    <p className="num break-all">
                      cover 已写入 {coverResult.job}
                      {coverResult.cover_asset
                        ? ` · ${coverResult.cover_asset.source_job}/${coverResult.cover_asset.name}`
                        : ' · cover_asset=null'}
                    </p>
                    {coverResult.cover_url && (
                      <img
                        src={coverResult.cover_url}
                        alt="封面回读"
                        className="mt-1.5 max-h-28 w-full rounded-[6px] object-cover"
                      />
                    )}
                  </div>
                )}
              </div>

              <div className="space-y-2 rounded-[10px] bg-white p-2.5 ring-1 ring-inset ring-black/[0.06]">
                <p className="text-[12px] font-medium">设为关键帧</p>
                <p className="text-[10px] leading-relaxed text-apple-subtext">
                  v1 仅 shot 1：提交 A 轨任务时透传 <span className="num">keyframe_asset</span>，编排器 C 阶段优先使用注入图。
                </p>
                <button
                  type="button"
                  onClick={handleUseKeyframe}
                  disabled={actionState.keyframeDisabled}
                  className={`${quietButton} h-8 px-3 text-[12px] disabled:opacity-55`}
                  data-testid="image-use-keyframe"
                >
                  选为下一个 A 轨关键帧
                </button>
                {keyframeNote && (
                  <p
                    className="break-words rounded-[8px] bg-[#EAF2FD] px-2 py-1.5 text-[10px] leading-relaxed text-apple-blueInk"
                    role="status"
                    data-testid="image-keyframe-note"
                  >
                    {keyframeNote}
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {lightbox && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="图片大图"
          data-testid="image-lightbox"
          onClick={() => setLightbox(null)}
        >
          <div className="max-h-full w-full max-w-[1100px] overflow-auto rounded-[12px] bg-white p-3" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="line-clamp-2 break-words text-[12px] leading-relaxed">{lightbox.item.prompt ?? '（无 prompt）'}</p>
                <p className="num mt-0.5 break-all text-[10px] text-apple-subtext">
                  {lightbox.item.id} / {lightbox.image.name} · {galleryStatusLabel(lightbox.item.status)} ·{' '}
                  {formatJobDuration(lightbox.item.duration_ms)}
                </p>
              </div>
              <button
                type="button"
                autoFocus
                onClick={() => setLightbox(null)}
                className={`${quietButton} h-8 shrink-0 px-3 text-[12px]`}
                data-testid="image-lightbox-close"
              >
                关闭 <span className="ml-1 text-[10px] font-normal text-apple-subtext">Esc</span>
              </button>
            </div>
            <img src={lightbox.image.url} alt={lightbox.item.prompt ?? lightbox.image.name} className="mt-2 max-h-[70vh] w-full object-contain" />
          </div>
        </div>
      )}

      {pendingDelete && deletePlan && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-apple-text/30 p-4 backdrop-blur-[2px]"
          role="presentation"
          onClick={() => {
            if (deletingId === null) {
              setPendingDelete(null)
              setDeleteError(null)
            }
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="image-delete-title"
            data-testid="image-delete-dialog"
            className="w-full max-w-[420px] rounded-[16px] border border-black/[0.08] bg-white p-5 shadow-lift"
            onClick={(event) => event.stopPropagation()}
          >
            <h3 id="image-delete-title" className="text-[14px] font-semibold text-apple-text">
              删除任务
            </h3>
            <p className="mt-2 break-words text-[12px] leading-relaxed text-apple-subtext">{deletePlan.description}</p>
            {deleteError && (
              <p
                role="alert"
                data-testid="image-delete-error"
                className="mt-3 break-words rounded-lg bg-[#FCEDEB] px-3 py-2 text-[11px] leading-relaxed text-[#B3261E] ring-1 ring-inset ring-[#F3D3CF]"
              >
                {deleteError}
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                autoFocus
                type="button"
                onClick={() => {
                  setPendingDelete(null)
                  setDeleteError(null)
                }}
                disabled={deletingId !== null}
                data-testid="image-delete-cancel"
                className={`${quietButton} h-9 px-3.5 text-[12px]`}
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void confirmDelete()}
                disabled={deletingId !== null}
                data-testid="image-delete-confirm"
                className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-[#B3261E] px-3.5 text-[12px] font-medium text-white transition-colors hover:bg-[#951F18] focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/45 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {deletingId !== null ? (
                  <>
                    <span
                      aria-hidden="true"
                      className="h-3 w-3 animate-spin rounded-full border-2 border-white/35 border-t-white"
                    />
                    删除中…
                  </>
                ) : (
                  '删除'
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      <ToastHost toast={toast} onClose={clearToast} testId="image-toast" />
    </section>
  )
}
