import { useCallback, useEffect, useRef, useState } from 'react'
import { getJson, postJson } from '../../api'
import { formatDuration, formatSizeBytes } from '../../format'
import type {
  ExtractedFrame,
  FrameAnalysisResult,
  LookProfileId,
  OptimizeParams,
  OptimizeSampleItem,
  OptimizeSession
} from '../../types'
import {
  Check,
  Clapper,
  Play,
  Refresh,
  Shield,
  Sliders,
  Sparkles,
  Upload
} from '../icons'

const VIDEO_EXTS = ['.mp4', '.mov', '.mkv', '.webm', '.m4v']
const MAX_LOCAL_OPTIMIZE_BYTES = 250 * 1024 * 1024

const PROFILE_OPTIONS: Array<{
  id: LookProfileId
  label: string
  tagline: string
  defaults: Omit<OptimizeParams, 'profile'>
}> = [
  {
    id: 'natural_clarity',
    label: '中性纪实通透',
    tagline: '保留真实肤色与白平衡，重点去噪并增强边缘细节',
    defaults: {
      denoise: 35,
      sharpen: 45,
      contrast: 8,
      brightness: 2,
      saturation: 8,
      warmth: 0,
      upscale_1080p: true,
      smooth_30fps: false
    }
  },
  {
    id: 'teal_orange',
    label: '电影青橙商业',
    tagline: '暗部微青、高光通透立体，适合品牌广告与人物特写',
    defaults: {
      denoise: 30,
      sharpen: 50,
      contrast: 15,
      brightness: 1,
      saturation: 14,
      warmth: -8,
      upscale_1080p: true,
      smooth_30fps: false
    }
  },
  {
    id: 'warm_film',
    label: '温暖胶片肤色',
    tagline: '柔和暖金中调与高光滚降，适合美食、咖啡与 Vlog',
    defaults: {
      denoise: 40,
      sharpen: 30,
      contrast: 6,
      brightness: 4,
      saturation: 10,
      warmth: 16,
      upscale_1080p: true,
      smooth_30fps: false
    }
  },
  {
    id: 'landscape_vivid',
    label: '风景建筑高锐',
    tagline: '增强反差与微观纹理锐度，强化通透度与 30fps 规整',
    defaults: {
      denoise: 25,
      sharpen: 65,
      contrast: 14,
      brightness: 0,
      saturation: 20,
      warmth: 4,
      upscale_1080p: true,
      smooth_30fps: true
    }
  }
]

const DEFAULT_PARAMS: OptimizeParams = {
  profile: 'natural_clarity',
  ...PROFILE_OPTIONS[0].defaults
}

function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot).toLowerCase() : ''
}

function uploadVideoToOptimizeSession(
  file: File,
  onProgress: (pct: number) => void
): Promise<OptimizeSession> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/optimize/session')
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream')
    xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name))
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable && ev.total > 0) {
        onProgress(Math.round((ev.loaded / ev.total) * 100))
      }
    }
    xhr.onload = () => {
      try {
        const parsed = JSON.parse(xhr.responseText || '{}') as OptimizeSession & {
          error?: string
          message?: string
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(parsed)
        } else {
          reject(new Error(parsed.message || parsed.error || `HTTP ${xhr.status}`))
        }
      } catch {
        reject(new Error(`HTTP ${xhr.status}`))
      }
    }
    xhr.onerror = () => reject(new Error('视频上传失败，请检查网络或重新选择文件。'))
    xhr.send(file)
  })
}

export function VideoOptimizeWorkbench({
  onNotify
}: {
  onNotify?: (message: string, tone?: 'ok' | 'info') => void
}) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const sourceVideoRef = useRef<HTMLVideoElement>(null)
  const enhancedVideoRef = useRef<HTMLVideoElement>(null)

  const [samples, setSamples] = useState<OptimizeSampleItem[]>([])
  const [dragging, setDragging] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadPct, setUploadPct] = useState(0)
  const [uploadError, setUploadError] = useState<string | null>(null)

  const [session, setSession] = useState<OptimizeSession | null>(null)
  const [selectedFrameIndex, setSelectedFrameIndex] = useState<number>(1)

  const [analyzing, setAnalyzing] = useState(false)
  const [analyzeError, setAnalyzeError] = useState<string | null>(null)
  const [analysis, setAnalysis] = useState<FrameAnalysisResult | null>(null)
  const [aiElapsedMs, setAiElapsedMs] = useState<number | null>(null)

  const [params, setParams] = useState<OptimizeParams>(DEFAULT_PARAMS)
  const [rendering, setRendering] = useState(false)
  const [renderError, setRenderError] = useState<string | null>(null)
  const [splitPct, setSplitPct] = useState(50)

  useEffect(() => {
    let alive = true
    getJson<{ items: OptimizeSampleItem[] }>('/api/optimize/samples')
      .then((res) => {
        if (alive && Array.isArray(res.items)) {
          setSamples(res.items)
        }
      })
      .catch(() => {
        /* samples optional */
      })
    return () => {
      alive = false
    }
  }, [])

  const applyNewSession = useCallback((next: OptimizeSession) => {
    setSession(next)
    setParams(next.params)
    setAnalysis(next.ai_analysis ?? null)
    setSelectedFrameIndex(next.frames[0]?.index ?? 1)
    setAnalyzeError(null)
    setRenderError(null)
  }, [])

  const handleFilePicked = useCallback(
    async (picked: File | null | undefined) => {
      if (!picked) return
      const ext = fileExtension(picked.name)
      if (!VIDEO_EXTS.includes(ext)) {
        setUploadError(`暂不支持 ${ext || '未知'} 格式，请选择 .mp4 / .mov / .mkv / .webm 视频文件。`)
        return
      }
      if (picked.size <= 0) {
        setUploadError('所选视频文件为空，请选择有效视频。')
        return
      }
      if (picked.size > MAX_LOCAL_OPTIMIZE_BYTES) {
        setUploadError(`视频超过 250 MB 限制（当前 ${formatSizeBytes(picked.size)}）。`)
        return
      }
      setUploadError(null)
      setUploading(true)
      setUploadPct(0)
      try {
        const created = await uploadVideoToOptimizeSession(picked, setUploadPct)
        applyNewSession(created)
        onNotify?.(`已载入「${created.filename}」并拆出 ${created.frames.length} 帧关键画面`, 'ok')
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : '视频上传或拆帧失败')
      } finally {
        setUploading(false)
      }
    },
    [applyNewSession, onNotify]
  )

  const handleLoadSample = useCallback(
    async (sampleKey: string) => {
      setUploadError(null)
      setUploading(true)
      setUploadPct(100)
      try {
        const created = await postJson<OptimizeSession>(
          `/api/optimize/session?sample=${encodeURIComponent(sampleKey)}`,
          {}
        )
        applyNewSession(created)
        onNotify?.(`已载入示例视频并提取 ${created.frames.length} 帧关键画面`, 'ok')
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : '载入示例视频失败')
      } finally {
        setUploading(false)
      }
    },
    [applyNewSession, onNotify]
  )

  const handleAnalyzeFrames = useCallback(async () => {
    if (!session) return
    setAnalyzing(true)
    setAnalyzeError(null)
    try {
      const res = await postJson<{
        model: string
        elapsed_ms: number
        analysis: FrameAnalysisResult
      }>('/api/gemini/analyze-frames', { sessionId: session.id })
      setAnalysis(res.analysis)
      setAiElapsedMs(res.elapsed_ms)
      setSession((prev) => (prev ? { ...prev, ai_analysis: res.analysis } : prev))
      onNotify?.(`AI 画面拆解完成（耗时 ${(res.elapsed_ms / 1000).toFixed(1)}s）`, 'ok')
    } catch (err) {
      setAnalyzeError(err instanceof Error ? err.message : 'AI 画面分析失败')
    } finally {
      setAnalyzing(false)
    }
  }, [session, onNotify])

  const handleApplyAiParams = useCallback(() => {
    if (!analysis?.recommended_params) return
    setParams(analysis.recommended_params)
    onNotify?.('已应用 AI 推荐美化与调色参数', 'info')
  }, [analysis, onNotify])

  const handleSelectProfile = useCallback((id: LookProfileId) => {
    const preset = PROFILE_OPTIONS.find((p) => p.id === id)
    if (!preset) return
    setParams({ profile: preset.id, ...preset.defaults })
  }, [])

  const handleBeautifyRender = useCallback(async () => {
    if (!session) return
    setRendering(true)
    setRenderError(null)
    try {
      const updated = await postJson<OptimizeSession>(
        `/api/optimize/${encodeURIComponent(session.id)}/beautify`,
        { params, ai_analysis: analysis }
      )
      setSession(updated)
      onNotify?.(
        `美化渲染完成（耗时 ${updated.elapsed_ms ? (updated.elapsed_ms / 1000).toFixed(1) : '—'}s）`,
        'ok'
      )
    } catch (err) {
      setRenderError(err instanceof Error ? err.message : 'FFmpeg 美化渲染失败')
    } finally {
      setRendering(false)
    }
  }, [session, params, analysis, onNotify])

  const handleSyncPlayBoth = useCallback(() => {
    const srcEl = sourceVideoRef.current
    const outEl = enhancedVideoRef.current
    if (!srcEl || !outEl) return
    srcEl.currentTime = 0
    outEl.currentTime = 0
    void srcEl.play()
    void outEl.play()
  }, [])

  const activeFrame: ExtractedFrame | null =
    session?.frames.find((f) => f.index === selectedFrameIndex) ?? session?.frames[0] ?? null
  const activeShotAi =
    analysis?.shots.find((s) => s.frame_index === activeFrame?.index) ?? null

  return (
    <div className="space-y-6">
      {/* Step 1: Video Upload & Real FFprobe Media Specs */}
      <section className="card p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-[17px] font-semibold tracking-[-0.015em] text-apple-text">
              1. 上传待优化视频 / 载入实拍样片
            </h2>
            <p className="mt-1 text-[13px] text-apple-subtext">
              上传视频后自动执行 ffprobe 规格检测，并按镜头节拍抽取关键帧供 AI 拆画面与美化分析。
            </p>
          </div>
          {session && (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex h-9 items-center gap-1.5 rounded-[10px] border border-black/[0.1] bg-white px-3.5 text-xs font-medium text-apple-text transition-colors hover:bg-[#F5F5F7]"
            >
              <Upload className="h-3.5 w-3.5" />
              更换视频文件
            </button>
          )}
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept={VIDEO_EXTS.join(',')}
          className="sr-only"
          onChange={(e) => {
            void handleFilePicked(e.target.files?.[0])
            e.target.value = ''
          }}
        />

        {!session ? (
          <div className="mt-4 grid gap-4 lg:grid-cols-12">
            <label
              onDragOver={(e) => {
                e.preventDefault()
                setDragging(true)
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault()
                setDragging(false)
                void handleFilePicked(e.dataTransfer.files?.[0])
              }}
              onClick={() => fileInputRef.current?.click()}
              className={`lg:col-span-7 flex cursor-pointer flex-col items-center justify-center rounded-[14px] border border-dashed p-8 text-center transition-colors ${
                dragging
                  ? 'border-apple-blue bg-[#F0F6FF]'
                  : 'border-black/[0.15] bg-[#FAFAFC] hover:border-black/[0.28] hover:bg-white'
              }`}
            >
              <Upload className="h-7 w-7 text-apple-blue" />
              <p className="mt-3 text-[14px] font-semibold text-apple-text">
                {uploading ? `正在上传并自动拆帧… ${uploadPct}%` : '点击或拖拽视频文件到此处'}
              </p>
              <p className="mt-1 text-xs text-apple-subtext">
                支持 MP4 / MOV / MKV / WEBM，单文件最大 250 MB · 上传即自动拆解镜头画面
              </p>
              {uploading && (
                <div className="mt-4 h-1.5 w-60 overflow-hidden rounded-full bg-black/[0.08]">
                  <div
                    className="h-full rounded-full bg-apple-blue transition-all duration-200"
                    style={{ width: `${uploadPct}%` }}
                  />
                </div>
              )}
            </label>

            <div className="lg:col-span-5 flex flex-col justify-between rounded-[14px] bg-[#FAFAFC] p-4 border border-black/[0.06]">
              <div>
                <div className="text-xs font-semibold text-apple-text">立即体验 · 实拍样片</div>
                <p className="mt-1 text-xs text-apple-subtext">
                  没有现成素材时，可直接载入工作台内置的实拍视频测试 AI 拆画面与美化对比。
                </p>
                <div className="mt-3 space-y-2">
                  {samples.length > 0 ? (
                    samples.map((s) => (
                      <button
                        key={s.key}
                        type="button"
                        disabled={uploading}
                        onClick={() => void handleLoadSample(s.key)}
                        className="flex w-full items-center justify-between gap-3 rounded-[10px] border border-black/[0.08] bg-white px-3 py-2.5 text-left transition-colors hover:border-apple-blue/40 hover:bg-[#F5F9FF] disabled:opacity-50"
                      >
                        <div className="min-w-0">
                          <div className="truncate text-xs font-semibold text-apple-text">{s.label}</div>
                          <div className="mt-0.5 truncate text-[11px] text-apple-subtext">{s.description}</div>
                        </div>
                        <span className="num shrink-0 text-[11px] font-medium text-apple-blueInk">
                          载入 →
                        </span>
                      </button>
                    ))
                  ) : (
                    <div className="rounded-lg border border-black/[0.06] bg-white px-3 py-2.5 text-xs text-apple-subtext">
                      请从左侧拖拽或选择本地视频文件上传。
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-4 border-t border-black/[0.06] pt-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 text-xs text-apple-subtext">
                <span className="font-semibold text-apple-text">{session.filename}</span>
                <span aria-hidden="true">·</span>
                <span className="num">
                  {session.probe.width}×{session.probe.height}
                </span>
                <span aria-hidden="true">·</span>
                <span className="num">{session.probe.fps} fps</span>
                <span aria-hidden="true">·</span>
                <span className="num">{formatDuration(session.probe.duration_s)}</span>
                <span aria-hidden="true">·</span>
                <span className="font-mono">{session.probe.codec}</span>
                <span aria-hidden="true">·</span>
                <span className="num">{formatSizeBytes(session.probe.size_bytes)}</span>
                {session.probe.bit_rate && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="num">{(session.probe.bit_rate / 1_000_000).toFixed(2)} Mbps</span>
                  </>
                )}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {samples.length > 0 && (
                <button
                  type="button"
                  disabled={uploading}
                  onClick={() => void handleLoadSample(samples[0].key)}
                  className="text-xs font-medium text-apple-subtext hover:text-apple-text"
                >
                  重置为示例视频
                </button>
              )}
            </div>
          </div>
        )}

        {uploadError && (
          <div className="mt-3 rounded-[10px] bg-[#FCEDEB] px-3.5 py-2.5 text-xs text-[#B3261E]" role="alert">
            {uploadError}
          </div>
        )}
      </section>

      {/* Step 2 & Step 3: Extracted Frames Gallery + Gemini Vision AI Diagnosis + Beautify Controls */}
      {session && (
        <section className="card p-5 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-[17px] font-semibold tracking-[-0.015em] text-apple-text">
                2. AI 画面拆解与瑕疵诊断
              </h2>
              <p className="mt-1 text-[13px] text-apple-subtext">
                已从原片抽取 {session.frames.length} 组关键帧画面，可点击帧图查看并由 AI 自动诊断景别、光线瑕疵与最佳美化配方。
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {analysis && (
                <button
                  type="button"
                  onClick={handleApplyAiParams}
                  className="inline-flex h-9 items-center gap-1.5 rounded-[10px] border border-apple-blue/40 bg-[#F0F6FF] px-3.5 text-xs font-medium text-apple-blueInk transition-colors hover:bg-[#E1EEFF]"
                >
                  <Check className="h-3.5 w-3.5" />
                  一键应用 AI 推荐参数
                </button>
              )}
              <button
                type="button"
                disabled={analyzing}
                onClick={() => void handleAnalyzeFrames()}
                className="inline-flex h-9 items-center gap-1.5 rounded-[10px] bg-apple-text px-4 text-xs font-medium text-white transition-colors hover:bg-black/85 disabled:opacity-60"
              >
                <Sparkles className={`h-3.5 w-3.5 ${analyzing ? 'animate-spin' : ''}`} />
                {analyzing ? 'AI 正在拆解画面…' : analysis ? '重新 AI 拆画诊断' : 'AI 拆解画面与诊断'}
              </button>
            </div>
          </div>

          {analyzeError && (
            <div className="mt-3 rounded-[10px] bg-[#FCEDEB] px-3.5 py-2.5 text-xs text-[#B3261E]" role="alert">
              {analyzeError}
            </div>
          )}

          {/* Extracted Frame Strip */}
          <div className="mt-4 grid gap-3 grid-cols-2 sm:grid-cols-4 lg:grid-cols-6">
            {session.frames.map((frame) => {
              const selected = frame.index === activeFrame?.index
              const shotAi = analysis?.shots.find((s) => s.frame_index === frame.index)
              return (
                <button
                  key={frame.filename}
                  type="button"
                  onClick={() => setSelectedFrameIndex(frame.index)}
                  className={`group overflow-hidden rounded-[11px] border text-left transition-all ${
                    selected
                      ? 'border-apple-blue ring-2 ring-apple-blue/25 bg-[#F7FAFF]'
                      : 'border-black/[0.08] bg-white hover:border-black/[0.18]'
                  }`}
                >
                  <div className="relative aspect-video w-full overflow-hidden bg-[#121316]">
                    <img
                      src={frame.after_url || frame.url}
                      alt={`关键帧 ${frame.index} (${frame.timecode})`}
                      className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
                    />
                  </div>
                  <div className="px-2.5 py-2">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="num font-semibold text-apple-text">镜头 #{frame.index}</span>
                      <span className="num text-apple-subtext">{frame.timecode}</span>
                    </div>
                    <p className="mt-1 truncate text-[11px] text-apple-subtext">
                      {shotAi ? shotAi.shot_type : '点击查看 / AI 识别'}
                    </p>
                  </div>
                </button>
              )
            })}
          </div>

          {/* Active Frame Inspector + AI Scene Diagnostics */}
          <div className="mt-5 grid gap-5 border-t border-black/[0.06] pt-5 lg:grid-cols-12">
            {/* Before/After Interactive Slider on Selected Keyframe */}
            <div className="lg:col-span-6">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-apple-text">
                  关键帧 #{activeFrame?.index} 画面检视（{activeFrame?.timecode}）
                </span>
                <span className="text-apple-subtext">
                  {activeFrame?.after_url ? '左右拖动滑杆对比美化前后' : '完成美化渲染后解锁逐帧对比'}
                </span>
              </div>

              {activeFrame && (
                <div className="relative mt-2.5 aspect-[16/10] w-full overflow-hidden rounded-[12px] bg-[#101114] border border-black/[0.08]">
                  <img
                    src={activeFrame.url}
                    alt="美化前原帧"
                    className="h-full w-full object-contain"
                  />
                  {activeFrame.after_url && (
                    <>
                      <img
                        src={activeFrame.after_url}
                        alt="美化后帧"
                        className="absolute inset-0 h-full w-full object-contain"
                        style={{ clipPath: `inset(0 0 0 ${splitPct}%)` }}
                      />
                      <input
                        type="range"
                        min={0}
                        max={100}
                        value={splitPct}
                        aria-label="对比原帧与美化帧"
                        onChange={(e) => setSplitPct(Number(e.target.value))}
                        className="split-range"
                      />
                      <div className="split-handle" style={{ left: `${splitPct}%` }} />
                      <div className="pointer-events-none absolute left-3 top-3 rounded bg-black/65 px-2 py-0.5 text-[11px] font-medium text-white">
                        原片
                      </div>
                      <div className="pointer-events-none absolute right-3 top-3 rounded bg-apple-blue/85 px-2 py-0.5 text-[11px] font-medium text-white">
                        AI 美化后
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* AI Diagnosis Report & Current Shot Breakdown */}
            <div className="lg:col-span-6 flex flex-col justify-between gap-4">
              {analysis ? (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-xs font-semibold text-apple-text">AI 全片画质与调色诊断</span>
                    {aiElapsedMs != null && (
                      <span className="num text-[11px] text-apple-subtext">
                        gemini-4-hydrogen · {(aiElapsedMs / 1000).toFixed(1)}s
                      </span>
                    )}
                  </div>
                  <p className="text-[13px] leading-relaxed text-apple-text">
                    {analysis.overall_assessment}
                  </p>
                  <div className="border-t border-black/[0.06] pt-2.5 text-xs text-apple-subtext">
                    推荐风格：<strong className="text-apple-text">{PROFILE_OPTIONS.find((p) => p.id === analysis.recommended_profile)?.label ?? analysis.recommended_profile}</strong>
                    <span className="mx-1.5">·</span>
                    <span>{analysis.recommended_profile_reason}</span>
                  </div>

                  {activeShotAi && (
                    <div className="rounded-[11px] bg-[#FAFAFC] p-3.5 text-xs space-y-1.5 border border-black/[0.05]">
                      <div className="flex items-center justify-between font-semibold text-apple-text">
                        <span>本帧镜头拆解 · {activeShotAi.shot_type}</span>
                        <span className="num text-apple-subtext">{activeShotAi.timecode}</span>
                      </div>
                      <div className="text-apple-text">
                        <span className="text-apple-subtext">画面主体：</span>
                        {activeShotAi.subject}
                      </div>
                      <div className="text-apple-text">
                        <span className="text-apple-subtext">光影色彩：</span>
                        {activeShotAi.lighting_color}
                      </div>
                      <div className="text-[#9A5500]">
                        <span className="text-apple-subtext">瑕疵诊断：</span>
                        {activeShotAi.flaw_diagnosis}
                      </div>
                      <div className="text-apple-blueInk font-medium">
                        <span className="text-apple-subtext font-normal">美化建议：</span>
                        {activeShotAi.enhance_action}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex h-full flex-col justify-center rounded-[12px] border border-dashed border-black/[0.12] bg-[#FAFAFC] p-6 text-center">
                  <Sparkles className="mx-auto h-6 w-6 text-apple-subtext" />
                  <p className="mt-2.5 text-sm font-medium text-apple-text">等待 AI 拆解画面</p>
                  <p className="mt-1 text-xs leading-relaxed text-apple-subtext">
                    点击右上角「AI 拆解画面与诊断」，系统将结合多张关键帧识别景别、主体动作、暗部噪点与偏色问题，并生成一键可用的 FFmpeg 美化参数。
                  </p>
                </div>
              )}
            </div>
          </div>
        </section>
      )}

      {/* Step 3: Beautification Controls & Render CTA */}
      {session && (
        <section className="card p-5 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-[17px] font-semibold tracking-[-0.015em] text-apple-text">
                3. 画质增强与 LUT 调色参数台
              </h2>
              <p className="mt-1 text-[13px] text-apple-subtext">
                选择商业成片风格或微调降噪、锐化、色温与超分参数，调用本地 FFmpeg 渲染可直接交付的高清 MP4。
              </p>
            </div>
            <button
              type="button"
              disabled={rendering}
              onClick={() => void handleBeautifyRender()}
              className="inline-flex h-10 items-center gap-2 rounded-[11px] bg-apple-blue px-5 text-xs font-semibold text-white shadow-soft transition-colors hover:bg-[#0062C4] disabled:opacity-60"
            >
              {rendering ? (
                <>
                  <Refresh className="h-3.5 w-3.5 animate-spin" />
                  正在执行 FFmpeg 美化渲染…
                </>
              ) : (
                <>
                  <Sliders className="h-3.5 w-3.5" />
                  {session.enhanced_url ? '按新参数重新美化渲染' : '开始 AI 美化与画质增强'}
                </>
              )}
            </button>
          </div>

          {renderError && (
            <div className="mt-3 rounded-[10px] bg-[#FCEDEB] px-3.5 py-2.5 text-xs text-[#B3261E]" role="alert">
              {renderError}
            </div>
          )}

          {/* Look Profile Segmented Picker */}
          <div className="mt-4 grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
            {PROFILE_OPTIONS.map((opt) => {
              const active = params.profile === opt.id
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => handleSelectProfile(opt.id)}
                  className={`rounded-[11px] border p-3 text-left transition-colors ${
                    active
                      ? 'border-apple-blue bg-[#F0F6FF]'
                      : 'border-black/[0.08] bg-white hover:bg-[#FAFAFB]'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className={`text-xs font-semibold ${active ? 'text-apple-blueInk' : 'text-apple-text'}`}>
                      {opt.label}
                    </span>
                    {active && <Check className="h-3.5 w-3.5 text-apple-blueInk" />}
                  </div>
                  <p className="mt-1 text-[11px] leading-relaxed text-apple-subtext">{opt.tagline}</p>
                </button>
              )
            })}
          </div>

          {/* Interactive Tuning Sliders */}
          <div className="mt-5 grid gap-x-6 gap-y-4 border-t border-black/[0.06] pt-4 sm:grid-cols-2 lg:grid-cols-3">
            {[
              { key: 'denoise', label: '空间降噪 (hqdn3d)', min: 0, max: 100, unit: '%' },
              { key: 'sharpen', label: '纹理锐化 (unsharp)', min: 0, max: 100, unit: '%' },
              { key: 'contrast', label: '画面反差 (Contrast)', min: -30, max: 40, unit: '' },
              { key: 'brightness', label: '曝光提亮 (Brightness)', min: -20, max: 25, unit: '' },
              { key: 'saturation', label: '色彩饱和度 (Saturation)', min: -30, max: 50, unit: '' },
              { key: 'warmth', label: '色温暖冷偏移 (Warmth)', min: -30, max: 30, unit: '' }
            ].map((ctl) => {
              const val = params[ctl.key as keyof OptimizeParams] as number
              return (
                <label key={ctl.key} className="block">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-apple-text">{ctl.label}</span>
                    <span className="num font-semibold text-apple-blueInk">
                      {val > 0 && ctl.min < 0 ? `+${val}` : val}
                      {ctl.unit}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={ctl.min}
                    max={ctl.max}
                    value={val}
                    onChange={(e) =>
                      setParams((prev) => ({ ...prev, [ctl.key]: Number(e.target.value) }))
                    }
                    className="mt-2 h-1.5 w-full cursor-pointer accent-apple-blue"
                  />
                </label>
              )
            })}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-6 border-t border-black/[0.06] pt-3.5 text-xs">
            <label className="inline-flex cursor-pointer items-center gap-2 text-apple-text">
              <input
                type="checkbox"
                checked={params.upscale_1080p}
                onChange={(e) => setParams((prev) => ({ ...prev, upscale_1080p: e.target.checked }))}
                className="h-4 w-4 rounded accent-apple-blue"
              />
              <span>1080p Lanczos 高清超分（若原片短边低于 1080px）</span>
            </label>
            <label className="inline-flex cursor-pointer items-center gap-2 text-apple-text">
              <input
                type="checkbox"
                checked={params.smooth_30fps}
                onChange={(e) => setParams((prev) => ({ ...prev, smooth_30fps: e.target.checked }))}
                className="h-4 w-4 rounded accent-apple-blue"
              />
              <span>强制 30fps 帧率规整（消除 VFR 掉帧抖动）</span>
            </label>
          </div>
        </section>
      )}

      {/* Step 4: Dual Video Comparison & Final MP4 Download */}
      {session && session.enhanced_url && (
        <section className="card p-5 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-[17px] font-semibold tracking-[-0.015em] text-apple-text">
                4. 成片交付与原片双屏对比
              </h2>
              <p className="mt-1 text-[13px] text-apple-subtext">
                {session.filter_summary ?? '已完成画质美化渲染'}
                {session.elapsed_ms ? ` · 渲染耗时 ${(session.elapsed_ms / 1000).toFixed(1)}s` : ''}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleSyncPlayBoth}
                className="inline-flex h-9 items-center gap-1.5 rounded-[10px] border border-black/[0.1] bg-white px-3.5 text-xs font-medium text-apple-text transition-colors hover:bg-[#F5F5F7]"
              >
                <Play className="h-3.5 w-3.5" />
                同步重头播放对比
              </button>
              <a
                href={`${session.enhanced_url}${session.enhanced_url.includes('?') ? '&' : '?'}download=1`}
                download
                className="inline-flex h-9 items-center gap-1.5 rounded-[10px] bg-[#1E7A3C] px-4 text-xs font-semibold text-white transition-colors hover:bg-[#176130]"
              >
                <Clapper className="h-3.5 w-3.5" />
                下载美化成片 MP4
              </a>
            </div>
          </div>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div>
              <div className="mb-1.5 flex items-center justify-between text-xs text-apple-subtext">
                <span className="font-medium text-apple-text">原始输入素材</span>
                <span className="num">
                  {session.probe.width}×{session.probe.height} · {session.probe.fps}fps ·{' '}
                  {formatSizeBytes(session.probe.size_bytes)}
                </span>
              </div>
              <video
                ref={sourceVideoRef}
                src={session.source_url}
                controls
                playsInline
                preload="metadata"
                className="aspect-[16/10] w-full rounded-[12px] bg-black"
              />
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between text-xs text-apple-subtext">
                <span className="font-semibold text-[#1E7A3C]">AI 美化成片（可下载交付）</span>
                <span className="num text-apple-text">
                  {session.enhanced_probe
                    ? `${session.enhanced_probe.width}×${session.enhanced_probe.height} · ${session.enhanced_probe.fps}fps · ${formatSizeBytes(session.enhanced_probe.size_bytes)}`
                    : '已就绪'}
                </span>
              </div>
              <video
                ref={enhancedVideoRef}
                src={session.enhanced_url}
                controls
                playsInline
                preload="metadata"
                className="aspect-[16/10] w-full rounded-[12px] bg-black"
              />
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-4 border-t border-black/[0.06] pt-3 text-xs text-apple-subtext">
            <span className="inline-flex items-center gap-1.5 text-[#1E7A3C] font-medium">
              <Shield className="h-3.5 w-3.5" />
              H.264 yuv420p + faststart 网页封装校验通过
            </span>
            {session.enhanced_probe?.bit_rate && (
              <span className="num">
                输出码率 {(session.enhanced_probe.bit_rate / 1_000_000).toFixed(2)} Mbps
              </span>
            )}
          </div>
        </section>
      )}
    </div>
  )
}
