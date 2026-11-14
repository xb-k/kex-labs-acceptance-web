/**
 * Deleted-job tombstones (#163).
 *
 * `<WEB_DATA_ROOT>/tombstones.json` is a JSON array of
 * `{ job_id, deleted_at, files, source }`. Every listing/resolving path must
 * filter through `isTombstoned`, so a deleted delivery / media job disappears
 * from the whole UI even when the studio source is kept for manual recovery.
 *
 * Writes are atomic (temp file + rename) and idempotent: repeating the same
 * delete merges the file list instead of adding a second entry. A corrupt
 * `tombstones.json` degrades to an empty list with a warning — it must never
 * break startup or hide every job.
 */
import fs from 'node:fs'
import path from 'node:path'

export type TombstoneSource = 'delivery' | 'media' | 'job'

export interface Tombstone {
  job_id: string
  deleted_at: string
  files: string[]
  source: TombstoneSource
}

export interface TombstoneOptions {
  dataRoot?: string
  /** Injectable clock for deterministic tests. */
  now?: () => string
  /** Corrupt files / failed writes are reported here instead of throwing. */
  warn?: (message: string) => void
}

const SOURCES = new Set<TombstoneSource>(['delivery', 'media', 'job'])
const JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

function rootFor(opts: TombstoneOptions): string {
  if (opts.dataRoot) return path.resolve(opts.dataRoot)
  return process.env.WEB_DATA_ROOT
    ? path.resolve(process.env.WEB_DATA_ROOT)
    : path.resolve(process.cwd(), '..')
}

export function tombstonePath(dataRoot?: string): string {
  return path.join(dataRoot ? path.resolve(dataRoot) : rootFor({}), 'tombstones.json')
}

function warn(opts: TombstoneOptions, message: string): void {
  const sink = opts.warn ?? ((msg: string) => console.warn(`[tombstones] ${msg}`))
  sink(message)
}

function safeJobId(value: unknown): value is string {
  return typeof value === 'string' && JOB_ID_RE.test(value) && !value.includes('..')
}

function cleanFiles(files: unknown): string[] {
  if (!Array.isArray(files)) return []
  const out: string[] = []
  for (const file of files) {
    if (typeof file !== 'string' || file.length === 0) continue
    if (!out.includes(file)) out.push(file)
  }
  return out
}

function normalizeEntry(raw: unknown): Tombstone | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  if (!safeJobId(value.job_id)) return null
  const source = value.source
  if (typeof source !== 'string' || !SOURCES.has(source as TombstoneSource)) return null
  return {
    job_id: value.job_id,
    deleted_at:
      typeof value.deleted_at === 'string' && value.deleted_at ? value.deleted_at : new Date(0).toISOString(),
    files: cleanFiles(value.files),
    source: source as TombstoneSource
  }
}

/** All valid tombstones; corrupt file / entries degrade to `[]` + warning. */
export function readTombstones(opts: TombstoneOptions = {}): Tombstone[] {
  const file = tombstonePath(opts.dataRoot ?? rootFor(opts))
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    warn(opts, `${file} is not valid JSON; treating it as empty`)
    return []
  }
  if (!Array.isArray(parsed)) {
    warn(opts, `${file} is not an array; treating it as empty`)
    return []
  }
  const out: Tombstone[] = []
  for (const raw of parsed) {
    const entry = normalizeEntry(raw)
    if (entry) out.push(entry)
    else warn(opts, `${file} contains an invalid entry; skipped`)
  }
  return out
}

function writeTombstones(list: Tombstone[], opts: TombstoneOptions): boolean {
  const file = tombstonePath(opts.dataRoot ?? rootFor(opts))
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, `${JSON.stringify(list, null, 2)}\n`, 'utf8')
    fs.renameSync(tmp, file)
    return true
  } catch (err) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* tmp never created */
    }
    warn(opts, `failed to write ${file}: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

export function isTombstoned(job: unknown, opts: TombstoneOptions = {}): boolean {
  if (!safeJobId(job)) return false
  return readTombstones(opts).some((entry) => entry.job_id === job)
}

/**
 * Record (or merge) one tombstone. `deleted_at`/`source` of the first deletion
 * win; repeating the call only unions the file list.
 */
export function tombstone(
  job: unknown,
  source: TombstoneSource,
  files: string[] = [],
  opts: TombstoneOptions = {}
): Tombstone | null {
  if (!safeJobId(job)) return null
  if (!SOURCES.has(source)) return null
  const list = readTombstones(opts)
  const existing = list.find((entry) => entry.job_id === job)
  const incoming = cleanFiles(files)
  if (existing) {
    const merged = cleanFiles([...existing.files, ...incoming])
    if (merged.length === existing.files.length) return existing
    const updated = { ...existing, files: merged }
    writeTombstones(
      list.map((entry) => (entry === existing ? updated : entry)),
      opts
    )
    return updated
  }
  const entry: Tombstone = {
    job_id: job,
    deleted_at: (opts.now ?? (() => new Date().toISOString()))(),
    files: incoming,
    source
  }
  writeTombstones([...list, entry], opts)
  return entry
}

/** Diagnostic line appended to `media-delete.jsonl` next to the per-file rows. */
export function appendTombstoneAudit(
  dataRoot: string,
  entry: { job: string; source: TombstoneSource; files: string[] }
): void {
  try {
    fs.mkdirSync(dataRoot, { recursive: true })
    fs.appendFileSync(
      path.join(dataRoot, 'media-delete.jsonl'),
      `${JSON.stringify({
        job: entry.job,
        source: entry.source,
        files: entry.files,
        fileCount: entry.files.length,
        action: 'tombstone',
        at: new Date().toISOString()
      })}\n`,
      'utf8'
    )
  } catch {
    /* audit is diagnostic, not a gate */
  }
}
