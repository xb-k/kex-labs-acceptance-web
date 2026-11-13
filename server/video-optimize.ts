import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { promisify } from 'node:util'
import { serveFile } from './media'

const execFileAsync = promisify(execFile)

export type LookProfileId =
  | 'natural_clarity'
  | 'teal_orange'
  | 'warm_film'
  | 'landscape_vivid'

export interface OptimizeParams {
  profile: LookProfileId
  denoise: number
  sharpen: number
  contrast: number
  brightness: number
  saturation: number
  warmth: number
  upscale_1080p: boolean
  smooth_30fps: boolean
}

export interface VideoMediaProbe {
  width: number
  height: number
  fps: number
  duration_s: number
  codec: string
  pix_fmt: string
  bit_rate: number | null
  size_bytes: number
  has_audio: boolean
}

export interface ExtractedFrame {
  index: number
  filename: string
  timestamp_s: number
  timecode: string
  url: string
  after_filename?: string | null
  after_url?: string | null
}

export interface OptimizeSampleItem {
  key: string
  label: string
  filename: string
  size_bytes: number
  description: string
}

export interface OptimizeSession {
  id: string
  filename: string
  created_at: string
  updated_at: string
  source_url: string
  enhanced_url: string | null
  probe: VideoMediaProbe
  enhanced_probe: VideoMediaProbe | null
  frames: ExtractedFrame[]
  params: OptimizeParams
  elapsed_ms: number | null
  filter_summary: string | null
  ai_analysis: unknown | null
}

export interface VideoOptimizeContext {
  dataRoot: string
  sendJson: (res: ServerResponse, status: number, body: unknown) => void
  readJson: (file: string) => any
  atomicWriteJson: (file: string, value: unknown) => void
  readBody: (req: IncomingMessage) => Promise<any>
  /** Injected by api.ts so session writes reuse `authorizeTaskWrite`. */
  authorizeWrite?: (req: IncomingMessage) => { ok: true } | { ok: false; status: number; error: string }
}

export const LOOK_PROFILES: Record<
  LookProfileId,
  { label: string; summary: string; defaultParams: Omit<OptimizeParams, 'profile'> }
> = {
  natural_clarity: {
    label: '中性纪实通透',
    summary: '保留真实肤色与白平衡，重点去除暗部噪点并提升边缘锐度',
    defaultParams: {
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
  teal_orange: {
    label: '电影青橙商业',
    summary: '高光微暖通透、阴影压入电影青灰，强化商业片层次对比',
    defaultParams: {
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
  warm_film: {
    label: '温暖胶片肤色',
    summary: '柔和高光滚降与暖金中调，适合咖啡、美食、人像生活叙事',
    defaultParams: {
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
  landscape_vivid: {
    label: '风景建筑高锐',
    summary: '高动态清晰度与低过曝反差增强，凸显天空与建筑纹理',
    defaultParams: {
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
}

const SESSION_ID_RE = /^opt-[a-z0-9]{6,24}$/
const FRAME_NAME_RE = /^(?:frame|after_frame)_\d{2}\.jpg$/
const ALLOWED_VIDEO_EXTS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.m4v'])
const MAX_UPLOAD_SIZE_BYTES = 250 * 1024 * 1024

export function isValidSessionId(id: string): boolean {
  return SESSION_ID_RE.test(id)
}

export function isValidFrameName(name: string): boolean {
  return FRAME_NAME_RE.test(name)
}

function clamp(val: unknown, min: number, max: number, fallback: number): number {
  const n = Number(val)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.round(n)))
}

export function sanitizeOptimizeParams(raw: unknown): OptimizeParams {
  const rec = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const profileRaw = typeof rec.profile === 'string' ? rec.profile.trim() : 'natural_clarity'
  const profile: LookProfileId =
    profileRaw === 'natural_clarity' ||
    profileRaw === 'teal_orange' ||
    profileRaw === 'warm_film' ||
    profileRaw === 'landscape_vivid'
      ? profileRaw
      : 'natural_clarity'
  const defaults = LOOK_PROFILES[profile].defaultParams
  return {
    profile,
    denoise: clamp(rec.denoise, 0, 100, defaults.denoise),
    sharpen: clamp(rec.sharpen, 0, 100, defaults.sharpen),
    contrast: clamp(rec.contrast, -30, 40, defaults.contrast),
    brightness: clamp(rec.brightness, -20, 25, defaults.brightness),
    saturation: clamp(rec.saturation, -30, 50, defaults.saturation),
    warmth: clamp(rec.warmth, -30, 30, defaults.warmth),
    upscale_1080p: typeof rec.upscale_1080p === 'boolean' ? rec.upscale_1080p : defaults.upscale_1080p,
    smooth_30fps: typeof rec.smooth_30fps === 'boolean' ? rec.smooth_30fps : defaults.smooth_30fps
  }
}

export function formatTimecode(seconds: number): string {
  const safe = Math.max(0, seconds)
  const mins = Math.floor(safe / 60)
  const secs = (safe % 60).toFixed(1).padStart(4, '0')
  return `${String(mins).padStart(2, '0')}:${secs}`
}

export function buildFfmpegVideoFilter(
  params: OptimizeParams,
  probe: Pick<VideoMediaProbe, 'width' | 'height' | 'fps'>
): { vf: string; summary: string } {
  const steps: string[] = []
  const labels: string[] = []

  // 1. Optional resolution normalize/upscale to 1080p short edge while preserving orientation
  const shortEdge = Math.min(probe.width || 720, probe.height || 1280)
  if (params.upscale_1080p && shortEdge < 1080) {
    if (probe.width >= probe.height) {
      steps.push('scale=-2:1080:flags=lanczos')
    } else {
      steps.push('scale=1080:-2:flags=lanczos')
    }
    labels.push('1080p Lanczos 超分')
  }

  // 2. Spatial-temporal denoise (hqdn3d)
  if (params.denoise > 0) {
    const luma = (params.denoise / 100) * 5.0
    const chroma = luma * 0.75
    steps.push(`hqdn3d=${luma.toFixed(2)}:${chroma.toFixed(2)}:${(luma * 1.1).toFixed(2)}:${(chroma * 1.1).toFixed(2)}`)
    labels.push(`降噪 ${params.denoise}%`)
  }

  // 3. Look profile color balance + warmth
  let rs = 0
  let gs = 0
  let bs = 0
  let rm = 0
  let gm = 0
  let bm = 0
  let rh = 0
  let gh = 0
  let bh = 0

  if (params.profile === 'teal_orange') {
    rs -= 0.06
    bs += 0.08
    rh += 0.05
    gh += 0.01
    bh -= 0.04
    labels.push('青橙 Look')
  } else if (params.profile === 'warm_film') {
    rm += 0.05
    gm += 0.02
    bm -= 0.04
    rh += 0.04
    bh -= 0.03
    labels.push('胶片暖调 Look')
  } else if (params.profile === 'landscape_vivid') {
    bs += 0.03
    bh += 0.03
    labels.push('高锐风景 Look')
  } else {
    labels.push('中性通透 Look')
  }

  if (params.warmth !== 0) {
    const w = (params.warmth / 30) * 0.09
    rm += w
    bm -= w
    labels.push(`色温 ${params.warmth > 0 ? `+${params.warmth}` : params.warmth}`)
  }

  if ([rs, gs, bs, rm, gm, bm, rh, gh, bh].some((v) => Math.abs(v) > 0.001)) {
    const c = (n: number) => Math.max(-0.5, Math.min(0.5, n)).toFixed(3)
    steps.push(`colorbalance=rs=${c(rs)}:gs=${c(gs)}:bs=${c(bs)}:rm=${c(rm)}:gm=${c(gm)}:bm=${c(bm)}:rh=${c(rh)}:gh=${c(gh)}:bh=${c(bh)}`)
  }

  // 4. EQ (contrast / brightness / saturation)
  const contrastVal = Math.max(0.7, Math.min(1.5, 1 + params.contrast / 100)).toFixed(3)
  const brightnessVal = Math.max(-0.25, Math.min(0.25, params.brightness / 100)).toFixed(3)
  const satVal = Math.max(0.5, Math.min(1.7, 1 + params.saturation / 100)).toFixed(3)
  steps.push(`eq=contrast=${contrastVal}:brightness=${brightnessVal}:saturation=${satVal}`)

  // 5. Adaptive unsharp detail recovery
  if (params.sharpen > 0) {
    const amount = ((params.sharpen / 100) * 1.4).toFixed(2)
    steps.push(`unsharp=5:5:${amount}:5:5:0.00`)
    labels.push(`细节锐化 ${params.sharpen}%`)
  }

  // 6. Optional target 30fps normalize when source differs cleanly
  if (params.smooth_30fps && Math.abs((probe.fps || 30) - 30) > 0.5) {
    steps.push('fps=30')
    labels.push('30fps 帧率规整')
  }

  return {
    vf: steps.join(','),
    summary: labels.join(' · ')
  }
}

function sessionsRoot(ctx: VideoOptimizeContext): string {
  return path.join(ctx.dataRoot, 'optimize-sessions')
}

function sessionDir(ctx: VideoOptimizeContext, sessionId: string): string {
  return path.join(sessionsRoot(ctx), sessionId)
}

function sessionJsonPath(ctx: VideoOptimizeContext, sessionId: string): string {
  return path.join(sessionDir(ctx, sessionId), 'session.json')
}

function safeExtFromFilename(name: string): string {
  const ext = path.extname(path.basename(name)).toLowerCase()
  return ALLOWED_VIDEO_EXTS.has(ext) ? ext : '.mp4'
}

function findSourceVideoPath(dir: string): string | null {
  for (const ext of ALLOWED_VIDEO_EXTS) {
    const candidate = path.join(dir, `source${ext}`)
    try {
      const stat = fs.statSync(candidate)
      if (stat.isFile() && stat.size > 0) return candidate
    } catch {
      /* continue */
    }
  }
  return null
}

/**
 * Samples are whatever real clips exist under `issue-19/<case>/out/`. No
 * hard-coded demo entries or marketing copy: the label/description are derived
 * from the file itself, and a data root without samples returns an empty list.
 */
function discoverSampleCandidates(dataRoot: string): Array<{ key: string; label: string; description: string; absPath: string; size_bytes: number }> {
  const out: Array<{ key: string; label: string; description: string; absPath: string; size_bytes: number }> = []
  const casesDir = path.join(dataRoot, 'issue-19')
  let cases: fs.Dirent[]
  try {
    cases = fs.readdirSync(casesDir, { withFileTypes: true })
  } catch {
    return out
  }

  const usedKeys = new Set<string>()
  for (const entry of cases) {
    if (!entry.isDirectory()) continue
    const outDir = path.join(casesDir, entry.name, 'out')
    let filenames: string[]
    try {
      filenames = fs.readdirSync(outDir)
    } catch {
      continue
    }
    for (const filename of filenames) {
      if (!ALLOWED_VIDEO_EXTS.has(path.extname(filename).toLowerCase())) continue
      const absPath = path.join(outDir, filename)
      try {
        const stat = fs.statSync(absPath)
        if (!stat.isFile() || stat.size <= 4096) continue
        const stem = path.basename(filename, path.extname(filename))
        let key = stem
        if (usedKeys.has(key)) key = `${entry.name}__${stem}`
        usedKeys.add(key)
        out.push({
          key,
          label: filename,
          description: `磁盘真实样片 · ${(stat.size / 1024 / 1024).toFixed(2)} MB`,
          absPath,
          size_bytes: stat.size
        })
      } catch {
        /* ignore unreadable sample */
      }
    }
  }
  return out.sort((a, b) => a.absPath.localeCompare(b.absPath))
}

function parseRFrameRate(raw: unknown): number {
  if (typeof raw !== 'string' || !raw.trim()) return 30
  const parts = raw.split('/')
  if (parts.length === 2) {
    const a = Number(parts[0])
    const b = Number(parts[1])
    if (Number.isFinite(a) && Number.isFinite(b) && b > 0) {
      return Number((a / b).toFixed(2))
    }
  }
  const single = Number(raw)
  return Number.isFinite(single) && single > 0 ? Number(single.toFixed(2)) : 30
}

export async function probeVideoFile(filePath: string): Promise<VideoMediaProbe> {
  const stat = fs.statSync(filePath)
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration,bit_rate,size:stream=codec_type,codec_name,width,height,pix_fmt,r_frame_rate',
    '-of',
    'json',
    filePath
  ])

  const parsed = JSON.parse(stdout || '{}') as {
    streams?: Array<Record<string, unknown>>
    format?: Record<string, unknown>
  }
  const streams = Array.isArray(parsed.streams) ? parsed.streams : []
  const videoStream = streams.find((s) => s.codec_type === 'video')
  if (!videoStream) {
    throw new Error('文件中未检测到有效视频流，请上传包含画面的 MP4/MOV/MKV/WEBM 视频。')
  }
  const hasAudio = streams.some((s) => s.codec_type === 'audio')
  const durationRaw = Number(parsed.format?.duration ?? 0)
  const bitRateRaw = Number(parsed.format?.bit_rate ?? 0)

  return {
    width: Number(videoStream.width) || 0,
    height: Number(videoStream.height) || 0,
    fps: parseRFrameRate(videoStream.r_frame_rate),
    duration_s: Number.isFinite(durationRaw) && durationRaw > 0 ? Number(durationRaw.toFixed(2)) : 0,
    codec: typeof videoStream.codec_name === 'string' ? videoStream.codec_name : 'unknown',
    pix_fmt: typeof videoStream.pix_fmt === 'string' ? videoStream.pix_fmt : 'unknown',
    bit_rate: Number.isFinite(bitRateRaw) && bitRateRaw > 0 ? Math.round(bitRateRaw) : null,
    size_bytes: stat.size,
    has_audio: hasAudio
  }
}

export async function extractKeyframesFromVideo(
  videoPath: string,
  outDir: string,
  prefix: 'frame' | 'after_frame',
  durationS: number,
  sessionId: string
): Promise<Array<{ index: number; filename: string; timestamp_s: number; timecode: string; url: string }>> {
  fs.mkdirSync(outDir, { recursive: true })
  const count = durationS >= 10 ? 6 : 4
  const safeDuration = Math.max(0.4, durationS || 4)
  const frames: Array<{ index: number; filename: string; timestamp_s: number; timecode: string; url: string }> = []

  for (let i = 0; i < count; i += 1) {
    const ratio = (i + 0.5) / count
    const ts = Number(Math.min(Math.max(0.05, safeDuration * ratio), Math.max(0.05, safeDuration - 0.05)).toFixed(2))
    const filename = `${prefix}_${String(i + 1).padStart(2, '0')}.jpg`
    const outPath = path.join(outDir, filename)
    await execFileAsync('ffmpeg', [
      '-y',
      '-ss',
      String(ts),
      '-i',
      videoPath,
      '-frames:v',
      '1',
      '-vf',
      "scale='min(720,iw)':-2",
      '-q:v',
      '3',
      outPath
    ])
    if (fs.existsSync(outPath)) {
      frames.push({
        index: i + 1,
        filename,
        timestamp_s: ts,
        timecode: formatTimecode(ts),
        url: `/api/optimize/${encodeURIComponent(sessionId)}/frames/${encodeURIComponent(filename)}`
      })
    }
  }

  return frames
}

async function receiveStreamToFile(req: IncomingMessage, destPath: string): Promise<void> {
  fs.mkdirSync(path.dirname(destPath), { recursive: true })
  await new Promise<void>((resolve, reject) => {
    let total = 0
    const out = fs.createWriteStream(destPath)
    let settled = false
    const fail = (err: Error) => {
      if (settled) return
      settled = true
      out.destroy()
      try {
        fs.unlinkSync(destPath)
      } catch {
        /* ignore */
      }
      reject(err)
    }

    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > MAX_UPLOAD_SIZE_BYTES) {
        fail(new Error('视频文件超过 250MB 限制'))
        req.destroy()
      }
    })
    req.on('error', (err) => fail(err))
    out.on('error', (err) => fail(err))
    out.on('finish', () => {
      if (settled) return
      if (total === 0) {
        fail(new Error('上传的视频文件为空'))
        return
      }
      settled = true
      resolve()
    })
    req.pipe(out)
  })
}

export async function handleVideoOptimizeRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  pathname: string,
  ctx: VideoOptimizeContext
): Promise<boolean> {
  if (pathname !== '/api/optimize' && !pathname.startsWith('/api/optimize/')) return false
  const method = req.method ?? 'GET'

  // GET /api/optimize/samples
  if (pathname === '/api/optimize/samples') {
    if (method !== 'GET' && method !== 'HEAD') {
      ctx.sendJson(res, 405, { error: 'method not allowed' })
      return true
    }
    const samples: OptimizeSampleItem[] = discoverSampleCandidates(ctx.dataRoot).map((s) => ({
      key: s.key,
      label: s.label,
      filename: path.basename(s.absPath),
      size_bytes: s.size_bytes,
      description: s.description
    }))
    ctx.sendJson(res, 200, { items: samples })
    return true
  }

  // POST /api/optimize/session
  if (pathname === '/api/optimize/session') {
    if (method !== 'POST') {
      ctx.sendJson(res, 405, { error: 'method not allowed' })
      return true
    }
    const auth = ctx.authorizeWrite?.(req)
    if (!auth) {
      ctx.sendJson(res, 403, { error: 'session write authorization is not wired' })
      return true
    }
    if (!auth.ok) {
      ctx.sendJson(res, auth.status, { error: auth.error })
      return true
    }

    const sessionId = `opt-${crypto.randomBytes(6).toString('hex')}`
    const dir = sessionDir(ctx, sessionId)
    fs.mkdirSync(dir, { recursive: true })

    try {
      const sampleKey = url.searchParams.get('sample')?.trim() ?? ''
      let originalFilename = 'uploaded_video.mp4'
      let sourcePath = ''

      if (sampleKey) {
        const found = discoverSampleCandidates(ctx.dataRoot).find((s) => s.key === sampleKey)
        if (!found) {
          fs.rmSync(dir, { recursive: true, force: true })
          ctx.sendJson(res, 404, { error: '找不到指定的示例视频' })
          return true
        }
        originalFilename = path.basename(found.absPath)
        const ext = safeExtFromFilename(originalFilename)
        sourcePath = path.join(dir, `source${ext}`)
        fs.copyFileSync(found.absPath, sourcePath)
      } else {
        const rawHeaderName = String(req.headers['x-filename'] ?? 'video.mp4')
        try {
          originalFilename = path.basename(decodeURIComponent(rawHeaderName)) || 'video.mp4'
        } catch {
          originalFilename = path.basename(rawHeaderName) || 'video.mp4'
        }
        const ext = safeExtFromFilename(originalFilename)
        sourcePath = path.join(dir, `source${ext}`)
        await receiveStreamToFile(req, sourcePath)
      }

      const probe = await probeVideoFile(sourcePath)
      const framesDir = path.join(dir, 'frames')
      const frames = await extractKeyframesFromVideo(sourcePath, framesDir, 'frame', probe.duration_s, sessionId)
      if (frames.length === 0) {
        throw new Error('无法从该视频提取关键帧画面，请检查文件编码格式。')
      }

      const now = new Date().toISOString()
      const session: OptimizeSession = {
        id: sessionId,
        filename: originalFilename,
        created_at: now,
        updated_at: now,
        source_url: `/api/optimize/${encodeURIComponent(sessionId)}/video/source`,
        enhanced_url: null,
        probe,
        enhanced_probe: null,
        frames,
        params: sanitizeOptimizeParams({ profile: 'natural_clarity' }),
        elapsed_ms: null,
        filter_summary: null,
        ai_analysis: null
      }
      ctx.atomicWriteJson(sessionJsonPath(ctx, sessionId), session)
      ctx.sendJson(res, 201, session)
    } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true })
      ctx.sendJson(res, 400, {
        error: 'video_ingest_failed',
        message: err instanceof Error ? err.message : '视频上传或解析失败'
      })
    }
    return true
  }

  // GET /api/optimize/:id/frames/:filename
  const frameMatch = pathname.match(/^\/api\/optimize\/([^/]+)\/frames\/([^/]+)$/)
  if (frameMatch) {
    const [, sessionId, filename] = frameMatch
    if (!isValidSessionId(sessionId) || !isValidFrameName(filename)) {
      ctx.sendJson(res, 404, { error: 'frame not found' })
      return true
    }
    const filePath = path.join(sessionDir(ctx, sessionId), 'frames', filename)
    if (!fs.existsSync(filePath)) {
      ctx.sendJson(res, 404, { error: 'frame not found' })
      return true
    }
    serveFile(req, res, filePath)
    return true
  }

  // GET /api/optimize/:id/video/:kind
  const videoMatch = pathname.match(/^\/api\/optimize\/([^/]+)\/video\/(source|enhanced)$/)
  if (videoMatch) {
    const [, sessionId, kind] = videoMatch
    if (!isValidSessionId(sessionId)) {
      ctx.sendJson(res, 404, { error: 'session not found' })
      return true
    }
    const dir = sessionDir(ctx, sessionId)
    const filePath =
      kind === 'enhanced' ? path.join(dir, 'enhanced.mp4') : findSourceVideoPath(dir)
    if (!filePath || !fs.existsSync(filePath)) {
      ctx.sendJson(res, 404, { error: 'video not found' })
      return true
    }
    const session = ctx.readJson(sessionJsonPath(ctx, sessionId)) as OptimizeSession | null
    if (url.searchParams.get('download') === '1') {
      const base = path.parse(session?.filename || 'video').name.replace(/[^\w.-]+/g, '_')
      const downloadName = kind === 'enhanced' ? `${base}_kex_enhanced.mp4` : `${base}_source${path.extname(filePath)}`
      res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`)
    }
    serveFile(req, res, filePath)
    return true
  }

  // POST /api/optimize/:id/beautify
  const beautifyMatch = pathname.match(/^\/api\/optimize\/([^/]+)\/beautify$/)
  if (beautifyMatch) {
    if (method !== 'POST') {
      ctx.sendJson(res, 405, { error: 'method not allowed' })
      return true
    }
    const sessionId = beautifyMatch[1]
    if (!isValidSessionId(sessionId)) {
      ctx.sendJson(res, 404, { error: 'session not found' })
      return true
    }
    const sessionFile = sessionJsonPath(ctx, sessionId)
    const current = ctx.readJson(sessionFile) as OptimizeSession | null
    const dir = sessionDir(ctx, sessionId)
    const sourcePath = findSourceVideoPath(dir)
    if (!current || !sourcePath) {
      ctx.sendJson(res, 404, { error: '视频会话不存在或原片已清理' })
      return true
    }

    let body: unknown = {}
    try {
      body = await ctx.readBody(req)
    } catch {
      ctx.sendJson(res, 400, { error: 'invalid JSON body' })
      return true
    }

    const bodyRec =
      body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
    const params = sanitizeOptimizeParams(bodyRec.params ?? bodyRec)
    const { vf, summary } = buildFfmpegVideoFilter(params, current.probe)

    const outPath = path.join(dir, 'enhanced.mp4')
    const started = Date.now()
    try {
      const args = [
        '-y',
        '-i',
        sourcePath,
        '-vf',
        vf,
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '19',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        ...(current.probe.has_audio ? ['-c:a', 'aac', '-b:a', '128k'] : ['-an']),
        outPath
      ]
      await execFileAsync('ffmpeg', args, { timeout: 120_000 })

      const enhancedProbe = await probeVideoFile(outPath)
      const afterFrames = await extractKeyframesFromVideo(
        outPath,
        path.join(dir, 'frames'),
        'after_frame',
        enhancedProbe.duration_s || current.probe.duration_s,
        sessionId
      )

      const mergedFrames: ExtractedFrame[] = current.frames.map((frame, i) => {
        const after = afterFrames[i]
        return {
          ...frame,
          after_filename: after?.filename ?? null,
          after_url: after?.url ?? null
        }
      })

      const next: OptimizeSession = {
        ...current,
        updated_at: new Date().toISOString(),
        enhanced_url: `/api/optimize/${encodeURIComponent(sessionId)}/video/enhanced?v=${Date.now()}`,
        enhanced_probe: enhancedProbe,
        frames: mergedFrames,
        params,
        elapsed_ms: Date.now() - started,
        filter_summary: summary,
        ai_analysis: bodyRec.ai_analysis !== undefined ? bodyRec.ai_analysis : current.ai_analysis
      }
      ctx.atomicWriteJson(sessionFile, next)
      ctx.sendJson(res, 200, next)
    } catch (err) {
      ctx.sendJson(res, 500, {
        error: 'ffmpeg_render_failed',
        message: err instanceof Error ? err.message : '视频美化渲染失败'
      })
    }
    return true
  }

  // GET /api/optimize/:id
  const detailMatch = pathname.match(/^\/api\/optimize\/([^/]+)$/)
  if (detailMatch) {
    if (method !== 'GET' && method !== 'HEAD') {
      ctx.sendJson(res, 405, { error: 'method not allowed' })
      return true
    }
    const sessionId = detailMatch[1]
    if (!isValidSessionId(sessionId)) {
      ctx.sendJson(res, 404, { error: 'session not found' })
      return true
    }
    const session = ctx.readJson(sessionJsonPath(ctx, sessionId))
    if (!session) {
      ctx.sendJson(res, 404, { error: 'session not found' })
      return true
    }
    ctx.sendJson(res, 200, session)
    return true
  }

  ctx.sendJson(res, 404, { error: 'not found' })
  return true
}
