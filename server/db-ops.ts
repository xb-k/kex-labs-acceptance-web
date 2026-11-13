/**
 * DB write helpers shared by the full sync (`sync.ts`) and the task write path
 * (`PATCH /api/tasks/:id` in `api.ts`).
 *
 * Everything here is idempotent: repeated runs upsert, never duplicate.
 */
import crypto from 'node:crypto'
import { sql } from './db'

// postgres.Sql and postgres.TransactionSql share this surface; keep it loose.
type Db = any

const sha256 = (text: string) => crypto.createHash('sha256').update(text).digest('hex')

export async function writeSnapshot(
  db: Db,
  kind: string,
  payload: unknown,
  sourcePath: string | null
): Promise<boolean> {
  const raw = JSON.stringify(payload)
  const digest = sha256(raw)
  const rows = await db`
    insert into acceptance.snapshots (kind, payload, sha256, source_path)
    values (${kind}, ${db.json(payload as never)}, ${digest}, ${sourcePath})
    on conflict (kind, sha256) do nothing
    returning id
  `
  return rows.length > 0
}

/** Merge tasks.json milestones with project-status milestones (status wins on detail). */
export async function upsertTasksAndMilestones(
  db: Db,
  plan: any,
  status: any
): Promise<{ tasks: number; milestones: number }> {
  const tasks: any[] = Array.isArray(plan?.tasks) ? plan.tasks : []
  for (const t of tasks) {
    await db`
      insert into acceptance.tasks
        (id, title, owner, rail, status, start_ts, end_ts, progress, depends_on, blocked_by, evidence, estimated, updated_at)
      values (
        ${t.id}, ${t.title ?? null}, ${t.owner ?? null}, ${t.rail ?? null}, ${t.status ?? null},
        ${t.start ?? null}, ${t.end ?? null}, ${t.progress ?? null},
        ${t.depends_on ?? []}, ${t.blocked_by ?? null}, ${t.evidence ?? null},
        ${t.estimated ?? null}, now()
      )
      on conflict (id) do update set
        title = excluded.title, owner = excluded.owner, rail = excluded.rail,
        status = excluded.status, start_ts = excluded.start_ts, end_ts = excluded.end_ts,
        progress = excluded.progress, depends_on = excluded.depends_on,
        blocked_by = excluded.blocked_by, evidence = excluded.evidence,
        estimated = excluded.estimated, updated_at = now()
    `
  }

  const planMilestones: any[] = Array.isArray(plan?.milestones) ? plan.milestones : []
  const statusMilestones: any[] = Array.isArray(status?.milestones) ? status.milestones : []
  const byId = new Map<string, { plan?: any; status?: any }>()
  for (const m of planMilestones) byId.set(String(m.id), { plan: m })
  for (const m of statusMilestones) {
    const id = String(m.id)
    const cur = byId.get(id) ?? {}
    cur.status = m
    byId.set(id, cur)
  }
  for (const [id, pair] of byId) {
    const pm = pair.plan ?? {}
    const sm = pair.status ?? {}
    const payload = pair.status ?? pair.plan ?? null
    await db`
      insert into acceptance.milestones (id, name, at_ts, state, detail, payload, updated_at)
      values (
        ${id}, ${sm.name ?? pm.name ?? pm.label ?? null}, ${pm.at ?? sm.at ?? null},
        ${sm.state ?? pm.state ?? null}, ${sm.detail ?? pm.detail ?? null},
        ${payload ? db.json(payload as never) : null}, now()
      )
      on conflict (id) do update set
        name = excluded.name, at_ts = excluded.at_ts, state = excluded.state,
        detail = excluded.detail, payload = excluded.payload, updated_at = now()
    `
  }

  return { tasks: tasks.length, milestones: byId.size }
}

export async function insertEvent(
  db: Db,
  event: { type: string; actor: string; entity: string; payload?: unknown }
): Promise<void> {
  await db`
    insert into acceptance.events (type, actor, entity, payload)
    values (${event.type}, ${event.actor}, ${event.entity}, ${event.payload ? db.json(event.payload) : null})
  `
}

export function dbUsable(): boolean {
  return sql !== null
}
