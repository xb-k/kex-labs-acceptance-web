/**
 * #153: job duration projection — real sources first, terminal create→updated
 * wall time as the last resort. Never invent a duration for running/queued.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveJobDurationMs } from './studio'

test('#153 duration_ms wins over any timestamp fallback', () => {
  const ms = resolveJobDurationMs({
    state: 'succeeded',
    duration_ms: 203_500,
    created_at: '2026-11-14T04:02:37+08:00',
    updated_at: '2026-11-14T04:06:01+08:00'
  })
  assert.equal(ms, 203_500)
})

test('#153 elapsed_ms is the second source', () => {
  const ms = resolveJobDurationMs({
    state: 'succeeded',
    elapsed_ms: 12_000.4,
    created_at: '2026-11-14T04:02:37+08:00',
    updated_at: '2026-11-14T04:06:01+08:00'
  })
  assert.equal(ms, 12_000)
})

test('#153 started/finished is the third source', () => {
  const ms = resolveJobDurationMs({
    state: 'succeeded',
    started_at: '2026-11-14T04:02:40+08:00',
    finished_at: '2026-11-14T04:05:00+08:00',
    created_at: '2026-11-14T04:02:37+08:00',
    updated_at: '2026-11-14T04:06:01+08:00'
  })
  assert.equal(ms, 140_000)
})

test('#153 succeeded falls back to updated_at - created_at (204s)', () => {
  const ms = resolveJobDurationMs({
    state: 'succeeded',
    created_at: '2026-11-14T04:02:37+08:00',
    updated_at: '2026-11-14T04:06:01+08:00'
  })
  assert.equal(ms, 204_000)
})

test('#153 detail without created_at uses the web meta creation stamp', () => {
  // Real intake `/intake/jobs/:id` omits created_at; the web meta still has it.
  const ms = resolveJobDurationMs(
    { state: 'succeeded', updated_at: '2026-11-14T04:06:01+0800' },
    '2026-11-13T20:02:37.006Z'
  )
  assert.equal(ms, 203_994)
})

test('#153 failed/canceled also use the terminal fallback', () => {
  assert.equal(
    resolveJobDurationMs({
      state: 'failed',
      created_at: '2026-11-14T04:00:00+08:00',
      updated_at: '2026-11-14T04:00:30+08:00'
    }),
    30_000
  )
  assert.equal(
    resolveJobDurationMs({
      state: 'canceled',
      created_at: '2026-11-14T04:00:00+08:00',
      updated_at: '2026-11-14T04:00:05+08:00'
    }),
    5_000
  )
})

test('#153 running/queued never fall back to created/updated', () => {
  const timestamps = {
    created_at: '2026-11-14T04:02:37+08:00',
    updated_at: '2026-11-14T04:06:01+08:00'
  }
  assert.equal(resolveJobDurationMs({ state: 'running', ...timestamps }), null)
  assert.equal(resolveJobDurationMs({ state: 'queued', ...timestamps }), null)
  assert.equal(
    resolveJobDurationMs(
      { state: 'running', updated_at: timestamps.updated_at },
      timestamps.created_at
    ),
    null
  )
})

test('#153 invalid or negative timestamps stay null', () => {
  assert.equal(
    resolveJobDurationMs({
      state: 'succeeded',
      created_at: 'not-a-date',
      updated_at: '2026-11-14T04:06:01+08:00'
    }),
    null
  )
  assert.equal(
    resolveJobDurationMs({
      state: 'succeeded',
      created_at: '2026-11-14T04:06:01+08:00',
      updated_at: '2026-11-14T04:02:37+08:00'
    }),
    null
  )
  assert.equal(
    resolveJobDurationMs({ state: 'succeeded', duration_ms: -1, elapsed_ms: -2 }),
    null
  )
})
