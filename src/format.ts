export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return '无数据'
  const mb = bytes / 1024 / 1024
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`
}

export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00.0'
  const m = Math.floor(seconds / 60)
  const s = seconds - m * 60
  return `${m}:${s.toFixed(1).padStart(4, '0')}`
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '无数据'
  return `${seconds.toFixed(1)}s`
}

export function formatResolution(w: number | null, h: number | null): string {
  if (!w || !h) return '无数据'
  return `${w}×${h}`
}

export function formatFrames(frames: number | null, fps: number | null): string {
  if (frames == null || fps == null || !fps) return '无数据'
  return `${frames} 帧 @${fps}fps = ${(frames / fps).toFixed(2)}s`
}
