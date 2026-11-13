/**
 * Files → Postgres sync. Idempotent: second run only bumps `sync_runs` and
 * refreshes mutable metadata (sizes/sha), never duplicates rows.
 *
 *   DATABASE_URL=postgres://… WEB_DATA_ROOT=/data node server/sync.mjs
 *
 * Reads the same files `server/api.ts` serves: `.opencode/state/tasks.json`,
 * `.opencode/state/project-status.json`, and `issue-19/b-track-s*` artefacts.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { sql } from './db'
import { upsertTasksAndMilestones, writeSnapshot } from './db-ops'
import { collectRepairs, DATA_ROOT, discover, parseCsv, PLAN_FILE, rel, STATUS_FILE } from './api'

type ArtifactKind =
  | 'video'
  | 'report'
  | 'summary'
  | 'metrics'
  | 'log'
  | 'repair_video'
  | 'repair_report'
  | 'repair_compare'

const sha256File = (file: string) =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

/** Minimal ISO-BMFF probe (no ffmpeg on the sync box): mvhd + tkhd. */
export function probeMp4(file: string): { durationS: number | null; width: number | null; height: number | null } | null {
  let fd: number
  try {
    fd = fs.openSync(file, 'r')
  } catch {
    return null
  }
  const size = fs.fstatSync(fd).size
  let durationS: number | null = null
  let width: number | null = null
  let height: number | null = null

  const readAt = (offset: number, length: number) => {
    const buf = Buffer.alloc(length)
    const n = fs.readSync(fd, buf, 0, length, offset)
    return n === length ? buf : null
  }

  const parseMoov = (start: number, end: number) => {
    let off = start
    while (off + 8 <= end) {
      const head = readAt(off, 16)
      if (!head) return
      let boxSize = head.readUInt32BE(0)
      const type = head.toString('latin1', 4, 8)
      let header = 8
      if (boxSize === 1) {
        const hi = head.readUInt32BE(8)
        const lo = head.readUInt32BE(12)
        boxSize = hi * 2 ** 32 + lo
        header = 16
      } else if (boxSize === 0) {
        boxSize = end - off
      }
      if (boxSize < header || off + boxSize > end) return
      const payload = off + header
      const payloadEnd = off + boxSize
      if (type === 'mvhd') {
        const body = readAt(payload, Math.min(payloadEnd - payload, 32))
        if (body) {
          const version = body[0]
          const timescale = version === 1 ? body.readUInt32BE(20) : body.readUInt32BE(12)
          const duration =
            version === 1 ? Number(body.readBigUInt64BE(24)) : body.readUInt32BE(16)
          if (timescale > 0) durationS = duration / timescale
        }
      } else if (type === 'trak') {
        // Find tkhd inside this trak.
        let inner = payload
        while (inner + 8 <= payloadEnd) {
          const ib = readAt(inner, 8)
          if (!ib) break
          let isize = ib.readUInt32BE(0)
          const itype = ib.toString('latin1', 4, 8)
          if (isize === 1) {
            const ext = readAt(inner + 8, 8)
            if (!ext) break
            isize = ext.readUInt32BE(0) * 2 ** 32 + ext.readUInt32BE(4)
          } else if (isize === 0) {
            isize = payloadEnd - inner
          }
          if (isize < 8) break
          if (itype === 'tkhd') {
            const body = readAt(inner + 8, Math.min(isize - 8, 96))
            if (body) {
              const version = body[0]
              const wOff = version === 1 ? 88 : 76
              const hOff = version === 1 ? 92 : 80
              if (body.length >= hOff + 4) {
                width = Math.round(body.readUInt32BE(wOff) / 65536)
                height = Math.round(body.readUInt32BE(hOff) / 65536)
              }
            }
            break
          }
          inner += isize
        }
      } else if (type === 'moov') {
        parseMoov(payload, payloadEnd)
      }
      off = payloadEnd
    }
  }

  try {
    let off = 0
    while (off + 8 <= size) {
      const head = readAt(off, 16)
      if (!head) break
      let boxSize = head.readUInt32BE(0)
      const type = head.toString('latin1', 4, 8)
      let header = 8
      if (boxSize === 1) {
        boxSize = head.readUInt32BE(8) * 2 ** 32 + head.readUInt32BE(12)
        header = 16
      } else if (boxSize === 0) {
        boxSize = size - off
      }
      if (boxSize < header) break
      if (type === 'moov') parseMoov(off + header, Math.min(off + boxSize, size))
      off += boxSize
    }
  } finally {
    fs.closeSync(fd)
  }

  return width || height || durationS ? { durationS, width, height } : null
}

function jobArtefacts(outDir: string, dir: string, summaryPath: string | null, metricsPath: string | null) {
  const found: { kind: ArtifactKind; file: string }[] = []
  const add = (kind: ArtifactKind, file: string) => {
    if (fs.existsSync(file) && fs.statSync(file).isFile()) found.push({ kind, file })
  }
  for (const f of fs.readdirSync(outDir).filter((f) => f.endsWith('.mp4'))) add('video', path.join(outDir, f))
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.mp4'))) add('video', path.join(dir, f))
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.log'))) add('log', path.join(dir, f))
  for (const f of fs.readdirSync(outDir).filter((f) => f.endsWith('.log'))) add('log', path.join(outDir, f))
  add('report', path.join(dir, 'report.md'))
  if (summaryPath) add('summary', summaryPath)
  if (metricsPath) add('metrics', metricsPath)
  const seen = new Set<string>()
  return found.filter((a) => {
    const key = rel(a.file)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export async function syncAll() {
  if (!sql) throw new Error('DATABASE_URL is not set — cannot sync')
  const started = Date.now()
  const [run] = await sql`insert into acceptance.sync_runs (started_at, source) values (now(), 'files') returning id`
  const stats: Record<string, unknown> = {}
  try {
    const plan = JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8'))
    const status = fs.existsSync(STATUS_FILE) ? JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8')) : {}
    const jobs = discover()

    await sql.begin(async (tx) => {
      const snapshots = {
        tasks_plan: await writeSnapshot(tx, 'tasks_plan', plan, rel(PLAN_FILE)),
        project_status: await writeSnapshot(tx, 'project_status', status, rel(STATUS_FILE))
      }
      const tm = await upsertTasksAndMilestones(tx, plan, status)
      let artifacts = 0
      let metrics = 0
      let criteria = 0

      for (const job of jobs) {
        const item = job.item
        const outDir = path.join(DATA_ROOT, 'issue-19', `b-track-${item.id}`, 'out')
        const dir = path.dirname(outDir)
        const vids = jobArtefacts(outDir, dir, null, null).filter((a) => a.kind === 'video')
        const largest = vids
          .map((a) => a.file)
          .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0]
        const probe = largest && item.width == null ? probeMp4(largest) : null
        const width = item.width ?? probe?.width ?? null
        const height = item.height ?? probe?.height ?? null
        const durationS = item.durationS ?? probe?.durationS ?? null

        await tx`
          insert into acceptance.jobs
            (id, track, task_id, title, status, status_label, passed, total, judged,
             duration_s, fps, width, height, frames, source_start, has_qc, summary, updated_at)
          values (
            ${item.id}, ${item.track}, ${item.taskId}, ${item.title}, ${item.status},
            ${item.statusLabel}, ${item.passed}, ${item.total}, ${item.judged},
            ${durationS}, ${item.fps}, ${width}, ${height}, ${item.frames},
            ${item.sourceStart}, ${item.hasQc}, ${tx.json(job.summary)}, now()
          )
          on conflict (id) do update set
            track = excluded.track, task_id = excluded.task_id, title = excluded.title,
            status = excluded.status, status_label = excluded.status_label,
            passed = excluded.passed, total = excluded.total, judged = excluded.judged,
            duration_s = excluded.duration_s, fps = excluded.fps, width = excluded.width,
            height = excluded.height, frames = excluded.frames, source_start = excluded.source_start,
            has_qc = excluded.has_qc, summary = excluded.summary, updated_at = now()
        `

        await tx`delete from acceptance.job_criteria where job_id = ${item.id}`
        for (const c of job.criteria) {
          await tx`
            insert into acceptance.job_criteria (job_id, key, name, value, threshold, pass, detail, source)
            values (${item.id}, ${c.key}, ${c.name}, ${c.value}, ${c.threshold},
                    ${c.pass}, ${c.explain}, ${c.source})
          `
          criteria++
        }

        const metricsPath = item.metricsPath ? path.join(DATA_ROOT, item.metricsPath) : null
        if (metricsPath && fs.existsSync(metricsPath)) {
          const { columns, rows } = parseCsv(fs.readFileSync(metricsPath, 'utf8'))
          await tx`delete from acceptance.job_metrics where job_id = ${item.id}`
          for (const column of columns) {
            const series = rows.map((r) => r[column] ?? null)
            const nums = series.filter((v): v is number => typeof v === 'number')
            const statsCol = nums.length
              ? {
                  n: nums.length,
                  min: Math.min(...nums),
                  max: Math.max(...nums),
                  mean: nums.reduce((a, b) => a + b, 0) / nums.length
                }
              : null
            await tx`
              insert into acceptance.job_metrics (job_id, metric, series, stats)
              values (${item.id}, ${column}, ${tx.json(series)}, ${statsCol ? tx.json(statsCol) : null})
            `
            metrics++
          }
          await tx`
            insert into acceptance.job_metrics (job_id, metric, series, stats)
            values (${item.id}, '__columns', ${tx.json(columns)}, null)
          `
        }

        const artefacts = jobArtefacts(
          outDir,
          dir,
          item.summaryPath ? path.join(DATA_ROOT, item.summaryPath) : null,
          metricsPath
        )
        for (const a of artefacts) {
          const stat = fs.statSync(a.file)
          await tx`
            insert into acceptance.artifacts (job_id, kind, path, size_bytes, sha256, mtime)
            values (${item.id}, ${a.kind}, ${rel(a.file)}, ${stat.size},
                    ${sha256File(a.file)}, ${stat.mtime.toISOString()})
            on conflict (job_id, kind, path) do update set
              size_bytes = excluded.size_bytes,
              sha256 = excluded.sha256,
              mtime = excluded.mtime
          `
          artifacts++
        }

        for (const repair of collectRepairs(item.id)) {
          const repairFiles: { kind: ArtifactKind; relPath: string }[] = []
          if (repair.output.path) repairFiles.push({ kind: 'repair_video', relPath: repair.output.path })
          if (repair.report) repairFiles.push({ kind: 'repair_report', relPath: repair.report.path })
          for (const c of repair.compare) repairFiles.push({ kind: 'repair_compare', relPath: c.path })
          for (const a of repairFiles) {
            const file = path.join(DATA_ROOT, a.relPath)
            if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue
            const stat = fs.statSync(file)
            await tx`
              insert into acceptance.artifacts (job_id, kind, path, size_bytes, sha256, mtime)
              values (${item.id}, ${a.kind}, ${rel(file)}, ${stat.size},
                      ${sha256File(file)}, ${stat.mtime.toISOString()})
              on conflict (job_id, kind, path) do update set
                size_bytes = excluded.size_bytes,
                sha256 = excluded.sha256,
                mtime = excluded.mtime
            `
            artifacts++
          }
        }
      }

      stats.snapshots = snapshots
      stats.tasks = tm.tasks
      stats.milestones = tm.milestones
      stats.jobs = jobs.length
      stats.criteria = criteria
      stats.metrics = metrics
      stats.artifacts = artifacts
    })

    stats.elapsedMs = Date.now() - started
    await sql`update acceptance.sync_runs set finished_at = now(), stats = ${sql.json(stats as never)}, ok = true where id = ${run.id}`
    return { ok: true, ...stats }
  } catch (err) {
    await sql`
      update acceptance.sync_runs
      set finished_at = now(), ok = false,
          stats = ${sql.json({ ...stats, error: err instanceof Error ? err.message : String(err) } as never)}
      where id = ${run.id}
    `
    throw err
  }
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (isMain) {
  syncAll()
    .then(async (result) => {
      console.log('[sync] ok', JSON.stringify(result))
      await sql?.end({ timeout: 5 })
      process.exit(0)
    })
    .catch(async (err) => {
      console.error('[sync] failed', err instanceof Error ? err.stack || err.message : err)
      await sql?.end({ timeout: 5 })
      process.exit(1)
    })
}

