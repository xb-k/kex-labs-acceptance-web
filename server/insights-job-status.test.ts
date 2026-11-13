import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  listJobs,
  normalizeJobStatus,
  resolveFlowJobStatus,
  staleAfterMs
} from './insights'

const NOW = Date.parse('2026-11-13T12:00:00Z')

function makeRoot(files: Record<string, unknown>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'insights-job-status-'))
  fs.mkdirSync(path.join(root, 'state'))
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, 'state', `${name}.json`), JSON.stringify(body))
  }
  return root
}

function touch(root: string, id: string, iso: string): void {
  const abs = path.join(root, 'state', `${id}.json`)
  const t = new Date(iso)
  fs.utimesSync(abs, t, t)
}

test('state.status wins and is reported with its source + updated_at', () => {
  const root = makeRoot({
    a: { status: 'running', updated_at: '2026-11-13T11:59:00Z' },
    b: { status: 'failed', updated_at: '2026-11-13T11:58:00Z' }
  })
  touch(root, 'a', '2026-11-13T11:59:00Z')
  touch(root, 'b', '2026-11-13T11:58:00Z')
  const [a, b] = listJobs(root, new Map([['b', 'succeeded']]), { nowMs: NOW })
  assert.equal(a.id, 'a')
  assert.equal(a.status, 'running')
  assert.equal(a.status_source, 'state')
  assert.equal(a.updated_at, '2026-11-13T11:59:00.000Z')
  assert.equal(a.stale, false)
  // 状态文件 status 优先，intake 不覆盖
  assert.equal(b.status, 'failed')
  assert.equal(b.status_source, 'state')
})

test('intake is only a fallback when the state file has no status', () => {
  const root = makeRoot({ only_intake: { updated_at: '2026-11-13T11:58:00Z' } })
  touch(root, 'only_intake', '2026-11-13T11:58:00Z')
  const [job] = listJobs(root, new Map([['only_intake', 'succeeded']]), { nowMs: NOW })
  assert.equal(job.status, 'succeeded')
  assert.equal(job.status_source, 'intake')
  assert.equal(job.updated_at, '2026-11-13T11:58:00.000Z')
  assert.equal(job.stale, false)
})

test('no state status and no intake record yields unknown, never running', () => {
  const root = makeRoot({ nothing: {} })
  touch(root, 'nothing', '2026-11-13T11:57:00Z')
  const [job] = listJobs(root, new Map(), { nowMs: NOW })
  assert.equal(job.status, 'unknown')
  assert.equal(job.status_source, 'unknown')
  assert.equal(job.updated_at, '2026-11-13T11:57:00.000Z')
  assert.equal(job.stale, false)
})

test('running past the stale threshold is stale but keeps its status/source', () => {
  const root = makeRoot({ slow_running: { status: 'running', updated_at: '2026-11-13T11:00:00Z' } })
  touch(root, 'slow_running', '2026-11-13T11:00:00Z')
  const [job] = listJobs(root, new Map(), { nowMs: NOW })
  assert.equal(job.status, 'running')
  assert.equal(job.status_source, 'state')
  assert.equal(job.stale, true)
})

test('queued past the stale threshold is stale', () => {
  const root = makeRoot({ waiting: { status: 'queued', updated_at: '2026-11-13T10:00:00Z' } })
  touch(root, 'waiting', '2026-11-13T10:00:00Z')
  const [job] = listJobs(root, new Map(), { nowMs: NOW })
  assert.equal(job.status, 'queued')
  assert.equal(job.stale, true)
})

test('finished jobs never go stale, even when old', () => {
  const root = makeRoot({ old_done: { status: 'succeeded', updated_at: '2026-11-01T00:00:00Z' } })
  touch(root, 'old_done', '2026-11-01T00:00:00Z')
  const [job] = listJobs(root, new Map(), { nowMs: NOW })
  assert.equal(job.status, 'succeeded')
  assert.equal(job.stale, false)
})

test('an invalid updated_at falls back to file mtime and is not stale when fresh', () => {
  const root = makeRoot({ bad_time: { status: 'running', updated_at: 'not-a-date' } })
  touch(root, 'bad_time', '2026-11-13T11:59:00Z')
  const [job] = listJobs(root, new Map(), { nowMs: NOW })
  assert.equal(job.status, 'running')
  assert.equal(job.updated_at, '2026-11-13T11:59:00.000Z')
  assert.equal(job.stale, false)
})

test('WEB_STALE_AFTER_MS overrides the 30 minute default; bad values keep the default', () => {
  const previous = process.env.WEB_STALE_AFTER_MS
  try {
    const root = makeRoot({ fifteen: { status: 'running', updated_at: '2026-11-13T11:45:00Z' } })
    touch(root, 'fifteen', '2026-11-13T11:45:00Z')

    delete process.env.WEB_STALE_AFTER_MS
    assert.equal(staleAfterMs(), 30 * 60 * 1000)
    assert.equal(listJobs(root, new Map(), { nowMs: NOW })[0].stale, false)

    process.env.WEB_STALE_AFTER_MS = String(10 * 60 * 1000)
    assert.equal(staleAfterMs(), 10 * 60 * 1000)
    assert.equal(listJobs(root, new Map(), { nowMs: NOW })[0].stale, true)

    process.env.WEB_STALE_AFTER_MS = 'not-a-number'
    assert.equal(staleAfterMs(), 30 * 60 * 1000)
    assert.equal(listJobs(root, new Map(), { nowMs: NOW })[0].stale, false)
  } finally {
    if (previous === undefined) delete process.env.WEB_STALE_AFTER_MS
    else process.env.WEB_STALE_AFTER_MS = previous
  }
})

test('status vocabulary normalises aliases and rejects unknown strings', () => {
  assert.equal(normalizeJobStatus('PENDING'), 'queued')
  assert.equal(normalizeJobStatus('processing'), 'running')
  assert.equal(normalizeJobStatus('success'), 'succeeded')
  assert.equal(normalizeJobStatus('cancelled'), 'canceled')
  assert.equal(normalizeJobStatus('weird'), null)
  assert.equal(normalizeJobStatus(42), null)
})

test('resolveFlowJobStatus reports epoch for missing times and stale when active', () => {
  const resolved = resolveFlowJobStatus({ stateStatus: 'running', nowMs: NOW, staleMs: 60_000 })
  assert.equal(resolved.updated_at, new Date(0).toISOString())
  assert.equal(resolved.stale, true)
})
