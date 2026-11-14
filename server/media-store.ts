/**
 * NAS media store (issue #160).
 *
 * Files published by studio `publish-to-nas` live under
 * `<WEB_DATA_ROOT>/media/jobs/<job_id>/<name>`; job metadata lives under
 * `<WEB_DATA_ROOT>/studio/jobs/<id>.json`.
 *
 * Every path is validated twice: lexical (`insideRoot`) and realpath
 * (symlinks must stay inside the media root). Only the published media
 * allowlist is visible; hidden/temp files are ignored.
 */
import fs from 'node:fs'
import path from 'node:path'

const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.mkv'])
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp'])
const AUDIO_EXT = new Set(['.wav', '.m4a'])

const TEMP_NAME_RE = /(^\.|\.(tmp|part|download|crdownload)$)/i

export type MediaKind = 'video' | 'image' | 'audio'

export type MediaItem = {
  job_id: string
  name: string
  /** Path relative to the data root (POSIX separators). */
  path: string
  url: string
  size: number
  bytes: number
  mtime: string
  kind: MediaKind
}

/** Request provenance copied into `media-delete.jsonl` (#168). */
export type MediaDeleteAuditContext = {
  request_id: string
  ip: string
  ua: string | null
  route: string
  method: string
}

export type MediaStoreOptions = {
  dataRoot?: string
  readJson?: (file: string) => any | null
  /** Optional request context; direct library callers (tests) may omit it. */
  audit?: MediaDeleteAuditContext
}

export type MediaResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string }

function defaultDataRoot(): string {
  return process.env.WEB_DATA_ROOT
    ? path.resolve(process.env.WEB_DATA_ROOT)
    : path.resolve(process.cwd(), '..')
}

function rootFor(opts: MediaStoreOptions): string {
  return opts.dataRoot ? path.resolve(opts.dataRoot) : defaultDataRoot()
}

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep)
}

function safeSegment(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 255 &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('..') &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    !path.isAbsolute(value)
  )
}

export function mediaKind(name: string): MediaKind | null {
  const ext = path.extname(name).toLowerCase()
  if (VIDEO_EXT.has(ext)) return 'video'
  if (IMAGE_EXT.has(ext)) return 'image'
  if (AUDIO_EXT.has(ext)) return 'audio'
  return null
}

export function mediaJobsDir(opts: MediaStoreOptions = {}): string {
  return path.join(rootFor(opts), 'media', 'jobs')
}

function statFile(file: string): fs.Stats | null {
  try {
    const stat = fs.statSync(file)
    return stat.isFile() ? stat : null
  } catch {
    return null
  }
}

function realRoot(dir: string): string {
  try {
    return fs.realpathSync(dir)
  } catch {
    return path.resolve(dir)
  }
}

function toItem(jobId: string, name: string, stat: fs.Stats): MediaItem {
  const kind = mediaKind(name) as MediaKind
  const rel = path.posix.join('media', 'jobs', jobId, name)
  return {
    job_id: jobId,
    name,
    path: rel,
    url: `/api/media/jobs/${encodeURIComponent(jobId)}/${encodeURIComponent(name)}`,
    size: stat.size,
    bytes: stat.size,
    mtime: stat.mtime.toISOString(),
    kind
  }
}

/** All published media files, newest mtime first. Hidden/temp/unlisted files are skipped. */
export function listMediaJobs(opts: MediaStoreOptions = {}): MediaItem[] {
  const jobsRoot = mediaJobsDir(opts)
  let jobEntries: fs.Dirent[]
  try {
    jobEntries = fs.readdirSync(jobsRoot, { withFileTypes: true })
  } catch {
    return []
  }

  const items: MediaItem[] = []
  for (const jobEntry of jobEntries) {
    if (!jobEntry.isDirectory()) continue
    if (!safeSegment(jobEntry.name)) continue
    if (jobEntry.name.startsWith('.')) continue
    const jobDir = path.join(jobsRoot, jobEntry.name)
    let fileEntries: fs.Dirent[]
    try {
      fileEntries = fs.readdirSync(jobDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const fileEntry of fileEntries) {
      if (!fileEntry.isFile()) continue
      const name = fileEntry.name
      if (TEMP_NAME_RE.test(name)) continue
      if (!mediaKind(name)) continue
      const stat = statFile(path.join(jobDir, name))
      if (!stat) continue
      items.push(toItem(jobEntry.name, name, stat))
    }
  }

  return items.sort(
    (a, b) =>
      Date.parse(b.mtime) - Date.parse(a.mtime) ||
      a.job_id.localeCompare(b.job_id) ||
      a.name.localeCompare(b.name)
  )
}

/** Safe resolution of one published file; 400 on traversal/symlink escape, 404 when absent. */
export function resolveMedia(
  job: unknown,
  name: unknown,
  opts: MediaStoreOptions = {}
): MediaResult<{ job_id: string; name: string; file: string; stat: fs.Stats }> {
  if (!safeSegment(job)) return { ok: false, status: 400, error: 'invalid media job id' }
  if (!safeSegment(name)) return { ok: false, status: 400, error: 'invalid media file name' }
  if (!mediaKind(name)) return { ok: false, status: 400, error: 'media type not allowed' }

  const jobsRoot = mediaJobsDir(opts)
  const target = path.resolve(jobsRoot, job, name)
  if (!isInside(path.resolve(jobsRoot), target)) {
    return { ok: false, status: 400, error: 'path outside media root' }
  }

  let realTarget: string
  try {
    realTarget = fs.realpathSync(target)
  } catch {
    return { ok: false, status: 404, error: 'media not found' }
  }
  const realJobsRoot = realRoot(jobsRoot)
  if (!isInside(realJobsRoot, realTarget)) {
    return { ok: false, status: 400, error: 'path outside media root' }
  }
  const stat = statFile(realTarget)
  if (!stat) return { ok: false, status: 404, error: 'media not found' }
  return { ok: true, value: { job_id: job, name, file: realTarget, stat } }
}

function auditDelete(
  root: string,
  entry: { job: string; name: string; size: number },
  audit?: MediaDeleteAuditContext
): void {
  try {
    fs.appendFileSync(
      path.join(root, 'media-delete.jsonl'),
      `${JSON.stringify({ ...entry, ...(audit ?? {}), at: new Date().toISOString() })}\n`,
      'utf8'
    )
  } catch {
    /* audit is diagnostic, not a gate */
  }
}

export type DeleteMediaResult = {
  job_id: string
  name: string
  path: string
  bytes: number
  jobDirRemoved: boolean
}

/** Physically unlinks one published file, removes the job dir when empty, appends audit. */
export function deleteMedia(
  job: unknown,
  name: unknown,
  opts: MediaStoreOptions = {}
): MediaResult<DeleteMediaResult> {
  const resolved = resolveMedia(job, name, opts)
  if (!resolved.ok) return resolved
  const { value } = resolved
  const root = rootFor(opts)
  const rel = path.posix.join('media', 'jobs', value.job_id, value.name)
  try {
    fs.unlinkSync(value.file)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, status: 404, error: 'media not found' }
    }
    throw err
  }
  let jobDirRemoved = false
  try {
    fs.rmdirSync(path.dirname(value.file))
    jobDirRemoved = true
  } catch {
    /* non-empty or already gone */
  }
  auditDelete(root, { job: value.job_id, name: value.name, size: value.stat.size }, opts.audit)
  return {
    ok: true,
    value: {
      job_id: value.job_id,
      name: value.name,
      path: rel,
      bytes: value.stat.size,
      jobDirRemoved
    }
  }
}

export function mediaJobExists(job: unknown, opts: MediaStoreOptions = {}): boolean {
  if (!safeSegment(job)) return false
  return listMediaJobs(opts).some((item) => item.job_id === job)
}

export type DeleteMediaJobResult = {
  job_id: string
  deleted: number
  bytes: number
  files: string[]
}

/** Physical delete of every published file of one job (used by `DELETE /api/deliveries/:id`). */
export function deleteMediaJob(
  job: unknown,
  opts: MediaStoreOptions = {}
): MediaResult<DeleteMediaJobResult> {
  if (!safeSegment(job)) return { ok: false, status: 400, error: 'invalid media job id' }
  const files = listMediaJobs(opts).filter((item) => item.job_id === job)
  if (files.length === 0) return { ok: false, status: 404, error: 'media job not found' }

  let bytes = 0
  const names: string[] = []
  for (const item of files) {
    const result = deleteMedia(job, item.name, opts)
    if (!result.ok) {
      if (result.status === 404) continue
      return result
    }
    bytes += result.value.bytes
    names.push(result.value.name)
  }
  return {
    ok: true,
    value: { job_id: job, deleted: names.length, bytes, files: names }
  }
}

function defaultReadJson(file: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** `<WEB_DATA_ROOT>/studio/jobs/<id>.json`, read through the caller's `readJson` when provided. */
export function jobMeta(id: unknown, opts: MediaStoreOptions = {}): any | null {
  if (!safeSegment(id)) return null
  const read = opts.readJson ?? defaultReadJson
  return read(path.join(rootFor(opts), 'studio', 'jobs', `${id}.json`))
}
