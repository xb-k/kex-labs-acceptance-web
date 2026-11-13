/**
 * Optional Postgres client for the acceptance UI.
 *
 * The DB is only used when a connection is configured — either `DATABASE_URL`
 * or the five `PG*` variables (`PGHOST`/`PGPORT`/`PGDATABASE`/`PGUSER`/
 * `PGPASSWORD`, the shape used by `secrets/pg.env`). Otherwise every read
 * falls back to scanning files under `WEB_DATA_ROOT`.
 *
 * Never log the URL or password: they contain the secret.
 */
import postgres from 'postgres'

const env = (name: string) => process.env[name]?.trim() || undefined

const url = env('DATABASE_URL')

const host = env('PGHOST')
const port = env('PGPORT')
const database = env('PGDATABASE')
const user = env('PGUSER')
const password = env('PGPASSWORD')

const shared = {
  max: 4,
  idle_timeout: 10,
  connect_timeout: 10,
  connection: { search_path: 'acceptance' },
  onnotice: () => {}
}

/** `DATABASE_URL` wins; when absent, fall back to the discrete `PG*` vars. */
export const sql: postgres.Sql | null = url
  ? postgres(url, shared)
  : host && database && user && password
    ? postgres({
        ...shared,
        host,
        ...(port ? { port: Number(port) } : {}),
        database,
        user,
        password
      })
    : null

export function dbEnabled(): boolean {
  return sql !== null
}

export async function closeDb(): Promise<void> {
  if (!sql) return
  try {
    await sql.end({ timeout: 5 })
  } catch (err) {
    console.error('[db] close failed', err instanceof Error ? err.message : err)
  }
}
