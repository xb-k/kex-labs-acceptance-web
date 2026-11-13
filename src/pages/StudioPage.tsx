import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { getJson, HttpError, postJson, useJson, useLiveJson } from '../api'
import { BriefWorkbench } from '../components/BriefWorkbench'
import { ImageWorkbench } from '../components/ImageWorkbench'
import { SelectMenu } from '../components/SelectMenu'
import { Clapper, Sparkles } from '../components/icons'
import { ScriptEditorPanel } from '../components/production/ScriptEditorPanel'
import { Field, primaryButton, quietButton } from '../components/studio-ui'
import { StudioProbePanel, type ProbeState } from '../components/studio/StudioProbePanel'
import { StudioQueueDrawer } from '../components/studio/StudioQueueDrawer'
import { StudioUploadZone, type UploadSession } from '../components/studio/StudioUploadZone'
import { VideoOptimizeWorkbench } from '../components/studio/VideoOptimizeWorkbench'
import { ToastHost } from '../components/ui'
import { formatClockMs, formatSizeBytes } from '../format'
import { useToast } from '../hooks'
import { buildAigcJobPayload } from '../image-workbench'
import { buildOptimizeJobPayload, type UploadProbeResponse } from '../studio-probe'
import type {
  StudioBrief,
  StudioBriefsResponse,
  StudioJob,
  StudioJobsResponse,
  StudioKeyframeRef
} from '../types'
import { readSearchParam, updateSearchParams } from '../url'

const POLL_MS = 4000
const VIDEO_EXTS = ['.mp4', '.mov', '.mkv', '.webm']
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024

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

function readJobParam(): string | null {
  const id = readSearchParam('job')
  return id && id.trim() ? id : null
}

function putChunk(
  uploadId: string,
  index: number,
  chunk: Blob,
  onProgress: (loaded: number) => void,
  registerXhr: (xhr: XMLHttpRequest | null) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    registerXhr(xhr)
    xhr.open('PUT', `/api/uploads/${encodeURIComponent(uploadId)}/chunks/${index}`)
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded)
    }
    xhr.onload = () => {
      registerXhr(null)
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
    xhr.onerror = () => {
      registerXhr(null)
      reject(new Error('网络中断：分块上传失败，可点「继续上传」补齐。'))
    }
    xhr.onabort = () => {
      registerXhr(null)
      reject(new Error('上传已中断，可点「继续上传」补齐。'))
    }
    xhr.send(chunk)
  })
}

type StudioRailTab = 'a' | 'b'

function readRailParam(): StudioRailTab {
  const raw = readSearchParam('rail')
  return raw === 'b' ? 'b' : 'a'
}

export function StudioPage() {
  const jobs = useLiveJson<StudioJobsResponse>('/api/studio/jobs?limit=50', POLL_MS)
  const briefsState = useJson<StudioBriefsResponse>('/api/studio/briefs?limit=50')
  const briefs = briefsState.data?.items ?? []

  const [rail, setRail] = useState<StudioRailTab>(() =>
    readJobParam() ? 'a' : readRailParam()
  )
  const { toast, showToast, clearToast } = useToast(3400)

  const sourceRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dropzoneRef = useRef<HTMLLabelElement>(null)
  const activeXhrRef = useRef<XMLHttpRequest | null>(null)
  const uploadRunRef = useRef(0)
  const uploadStartRef = useRef<{ ts: number; bytes: number } | null>(null)
  const sessionRef = useRef<UploadSession | null>(null)

  const [path, setPath] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [session, setSession] = useState<UploadSession | null>(null)
  const [uploadSpeedBps, setUploadSpeedBps] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const [briefChoice, setBriefChoice] = useState('none')
  const [linkBrief, setLinkBrief] = useState<StudioBrief | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [keyframeAsset, setKeyframeAsset] = useState<StudioKeyframeRef | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [createdJobId, setCreatedJobId] = useState<string | null>(null)
  const [focusJobId, setFocusJobId] = useState<string | null>(() => readJobParam())
  const [focusNonce, setFocusNonce] = useState(0)
  const [queueOpen, setQueueOpen] = useState(() => Boolean(readJobParam()))
  const queueTriggerRef = useRef<HTMLButtonElement>(null)
  const queueCloseRef = useRef<HTMLButtonElement>(null)
  const scrolledRef = useRef<string>('')
  const probeRunRef = useRef(0)
  const [probe, setProbe] = useState<ProbeState>({ status: 'idle' })
  const [bError, setBError] = useState<string | null>(null)

  const selectRail = useCallback((next: StudioRailTab) => {
    setRail(next)
    updateSearchParams({ rail: next }, 'replace')
  }, [])

  const selectedBrief =
    briefChoice !== 'none' && briefChoice !== 'new'
      ? briefs.find((brief) => brief.id === briefChoice) ?? null
      : null

  useEffect(() => {
    if (briefChoice === 'none' || briefChoice === 'new') {
      setLinkBrief(null)
      return
    }
    setLinkBrief((prev) => (prev && prev.id === briefChoice ? prev : selectedBrief))
  }, [briefChoice, selectedBrief])

  useEffect(() => () => {
    activeXhrRef.current?.abort()
    uploadRunRef.current += 1
  }, [])

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
    if (patch.received != null && uploadStartRef.current) {
      const elapsedS = (Date.now() - uploadStartRef.current.ts) / 1000
      const deltaBytes = patch.received - uploadStartRef.current.bytes
      if (elapsedS >= 0.4 && deltaBytes > 0) {
        setUploadSpeedBps(deltaBytes / elapsedS)
      }
    }
  }, [])

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

  useEffect(() => {
    if (!readyUploadId || probedUploadId === readyUploadId) return
    void runProbe(readyUploadId)
  }, [readyUploadId, probedUploadId, runProbe])

  const runUpload = useCallback(
    async (
      target: File,
      resume?: { session: UploadSession; missing: number[]; received: number }
    ) => {
      const runId = ++uploadRunRef.current
      setFormError(null)
      setNotice(null)
      setUploadSpeedBps(null)
      uploadStartRef.current = { ts: Date.now(), bytes: resume?.received ?? 0 }
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
          await putChunk(
            active.uploadId,
            index,
            target.slice(start, end),
            (loaded) => {
              if (uploadRunRef.current !== runId) return
              patchSession({ received: Math.min(active.size, base + loaded) })
            },
            (xhr) => {
              activeXhrRef.current = xhr
            }
          )
          done += end - start
          patchSession({ received: Math.min(active.size, done) })
        }

        const completed = await postJson<UploadCompleteResponse>(
          `/api/uploads/${encodeURIComponent(active.uploadId)}/complete`,
          {}
        )
        if (uploadRunRef.current !== runId) return
        setUploadSpeedBps(null)
        patchSession({
          status: 'ready',
          received: completed.size,
          sha256: completed.sha256,
          error: null
        })
      } catch (err) {
        if (uploadRunRef.current !== runId) return
        setUploadSpeedBps(null)
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

  const cancelUpload = useCallback(() => {
    uploadRunRef.current += 1
    activeXhrRef.current?.abort()
    activeXhrRef.current = null
    setUploadSpeedBps(null)
    if (sessionRef.current) {
      patchSession({ status: 'failed', error: '上传已手动取消，可点「继续上传」补齐。' })
    }
  }, [patchSession])

  const pickFile = useCallback(
    (candidate: File | null | undefined) => {
      if (!candidate) return
      if (sessionRef.current?.status === 'uploading') {
        setFormError('当前素材仍在上传，请等待完成或取消后再更换文件。')
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
        setFormError(`文件过大（${formatSizeBytes(candidate.size)}）：上限 2 GiB。`)
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
    activeXhrRef.current?.abort()
    activeXhrRef.current = null
    probeRunRef.current += 1
    setUploadSpeedBps(null)
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
      updateSearchParams({ job: job.id })
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
      updateSearchParams({ job: job.id })
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
  const focusMissingId =
    focusJobId && jobs.status === 'ready' && !jobsData.some((job) => job.id === focusJobId)
      ? focusJobId
      : null

  const focusJob = useCallback((id: string) => {
    setFocusJobId(id)
    setFocusNonce((value) => value + 1)
    setCreatedJobId(id)
    setQueueOpen(true)
    updateSearchParams({ job: id })
  }, [])

  const closeQueue = useCallback(() => {
    setQueueOpen(false)
  }, [])

  useEffect(() => {
    const apply = () => {
      const id = readJobParam()
      setFocusJobId(id)
      setQueueOpen(Boolean(id))
      setFocusNonce((value) => value + 1)
      if (!id) setRail(readRailParam())
    }
    window.addEventListener('popstate', apply)
    return () => window.removeEventListener('popstate', apply)
  }, [])

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

  const readyUpload = session?.status === 'ready' ? session : null

  return (
    <div className="space-y-6">
      {/* Header & Dual-Rail Mode Switcher */}
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em] sm:text-[32px]">
            双轨创作工坊
          </h1>
          <p className="mt-1.5 max-w-[70ch] text-sm leading-relaxed text-apple-subtext">
            A 轨支持 AI 剧本编写与关键帧生图制片；B 轨支持上传实拍视频、AI 镜头拆画面与 FFmpeg 商业调色美化直出成片。
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <div
            role="tablist"
            aria-label="选择创作轨道"
            className="inline-flex rounded-[11px] border border-black/[0.08] bg-[#EFEFF2] p-1"
          >
            <button
              type="button"
              role="tab"
              aria-selected={rail === 'a'}
              onClick={() => selectRail('a')}
              className={`inline-flex items-center gap-1.5 rounded-[8px] px-3.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                rail === 'a'
                  ? 'bg-white text-apple-text shadow-soft'
                  : 'text-apple-subtext hover:text-apple-text'
              }`}
            >
              <Sparkles className="h-3.5 w-3.5 text-apple-blue" />
              A 轨 · 剧本生图生视频
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={rail === 'b'}
              onClick={() => selectRail('b')}
              className={`inline-flex items-center gap-1.5 rounded-[8px] px-3.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                rail === 'b'
                  ? 'bg-white text-apple-text shadow-soft'
                  : 'text-apple-subtext hover:text-apple-text'
              }`}
            >
              <Clapper className="h-3.5 w-3.5 text-[#1E7A3C]" />
              B 轨 · 视频 AI 拆画美化
            </button>
          </div>

          <button
            ref={queueTriggerRef}
            type="button"
            onClick={() => setQueueOpen(true)}
            className={`${quietButton} h-9 gap-1.5 px-3 text-xs whitespace-nowrap`}
            data-testid="studio-queue-trigger"
            aria-haspopup="dialog"
            aria-expanded={queueOpen}
          >
            渲染队列
            <span className="num text-[11px] text-apple-subtext">
              {jobs.status === 'ready' ? `(${jobsData.length})` : ''}
            </span>
          </button>
        </div>
      </header>

      {/* RAIL B: Deliverable Video Upload -> AI Frame Split -> Beautify & Compare */}
      {rail === 'b' && <VideoOptimizeWorkbench onNotify={(msg, tone) => showToast(msg, tone ?? 'ok')} />}

      {/* RAIL A: AI Script -> Brief Gate -> Keyframe Image -> I2V Job */}
      {rail === 'a' && (
        <div className="space-y-6">
          <ScriptEditorPanel
            activeBrief={briefs[0] ?? null}
            onBriefSynced={() => briefsState.refresh()}
            onNotify={(msg) => showToast(msg, 'ok')}
          />

          <div className="grid gap-5 xl:grid-cols-[minmax(340px,420px)_minmax(0,1fr)] xl:items-start">
            <form
              onSubmit={handleSubmit}
              className="card p-5"
              aria-labelledby="studio-create-title"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <h2 id="studio-create-title" className="text-section">
                    A 轨制片入队
                  </h2>
                  <p className="mt-1 text-[11px] leading-relaxed text-apple-subtext">
                    关联已确认 Brief 与可选首帧生图，创建 A 轨渲染任务；或直接上传参考素材探测转入 B 轨精修。
                  </p>
                </div>
                <span className="num text-[11px] text-apple-subtext">
                  {jobs.updatedAt ? `同步 ${formatClockMs(jobs.updatedAt)}` : '就绪'}
                </span>
              </div>

              <div className="mt-4 space-y-3.5">
                <StudioUploadZone
                  file={file}
                  session={session}
                  dragging={dragging}
                  uploadSpeedBps={uploadSpeedBps}
                  path={path}
                  sourceRef={sourceRef}
                  fileInputRef={fileInputRef}
                  dropzoneRef={dropzoneRef}
                  onDraggingChange={setDragging}
                  onPickFile={pickFile}
                  onPathChange={setPath}
                  onCancelUpload={cancelUpload}
                  onResumeUpload={() => void resumeUpload()}
                  onRejectDrop={setFormError}
                />

                <Field id="studio-brief" label="关联剧本 Brief" optional hint="同步上方 AI 剧本或从已有 Brief 选取。">
                  <SelectMenu
                    id="studio-brief"
                    value={briefChoice}
                    onChange={setBriefChoice}
                    ariaLabel="关联剧本 Brief"
                    testId="studio-brief-select"
                    size="lg"
                    options={[
                      { value: 'none', label: '不关联 Brief' },
                      ...briefs.map((brief) => ({
                        value: brief.id,
                        label: brief.idea.length > 28 ? `${brief.idea.slice(0, 28)}…` : brief.idea,
                        hint: brief.status === 'confirmed' ? '已确认' : '草稿'
                      })),
                      { value: 'new', label: '＋ 新建 Brief…' }
                    ]}
                  />
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
                    <p className="mt-2 text-[11px] leading-relaxed text-apple-subtext">Brief 读取中…</p>
                  ))}

                {readyUpload && !path.trim() && (
                  <StudioProbePanel
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
                      已选关键帧：<span className="num">{keyframeAsset.source_job}/{keyframeAsset.name}</span>（注入 shot 1）。
                    </span>
                    <button
                      type="button"
                      onClick={() => setKeyframeAsset(null)}
                      className="shrink-0 font-medium underline underline-offset-2"
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
                        className="shrink-0 font-medium underline underline-offset-2"
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

                <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                  <span className="text-[11px] text-apple-subtext">
                    {jobsData.length > 0 ? `队列最近任务：${jobsData[0].id}` : 'Studio 任务直通代理'}
                  </span>
                  <button
                    type="submit"
                    data-testid="brief-submit"
                    disabled={submitting || submitBlocked}
                    className={`${primaryButton} btn-sheen shrink-0`}
                  >
                    {submitting
                      ? readyUpload && !path.trim()
                        ? '上传入队…'
                        : '提交中…'
                      : '创建渲染任务'}
                  </button>
                </div>
              </div>
            </form>

            <ImageWorkbench jobOptions={jobsData} onUseKeyframe={setKeyframeAsset} />
          </div>
        </div>
      )}

      <StudioQueueDrawer
        open={queueOpen}
        onClose={closeQueue}
        triggerRef={queueTriggerRef}
        closeRef={queueCloseRef}
        jobsStatus={jobs.status}
        jobsData={jobsData}
        jobsUpdatedAt={jobs.updatedAt}
        jobsRefreshing={jobs.refreshing}
        jobsError={jobs.error}
        briefs={briefs}
        createdJobId={createdJobId}
        focusJobId={focusJobId}
        focusMissingId={focusMissingId}
        focusNonce={focusNonce}
        onRefresh={() => jobs.refresh()}
        onRetry={jobs.retry}
        onCreateFromEmpty={focusSource}
      />

      <ToastHost toast={toast} onClose={clearToast} />
    </div>
  )
}

