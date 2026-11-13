/**
 * #97a contract tests (I1–I6). Run against real local data:
 *   KEX_REPO_ROOT=/tmp/kex-fixture WEB_DATA_ROOT=$PWD/.. \
 *   node --test /tmp/obs097/snapshot.test.mjs
 * The runner bundles this file with esbuild (see evidence `tests.txt`).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildSnapshot,
  bTrackProjection,
  bTrackStatusFromVerdict,
  isSafeJobId,
  judgeRule,
  policyRules,
  readDecisionLog,
  studioVerdictFromQc,
  unavailableSnapshot
} from './snapshot'
import { discover } from './api'
import { contractData } from './insights'
import { studioProjection, studioStatus } from './studio'

test('I1 b-track snapshot has explicit sources and no fabricated values', async () => {
  const snap = await buildSnapshot({ source: 'b-track', jobId: 's1' })
  assert.equal(snap.contract, 'job_snapshot/1')
  assert.equal(snap.available, true)
  assert.equal(snap.source, 'b-track')
  assert.equal(snap.job_id, 's1')
  assert.equal(snap.status, 'failed')
  assert.equal(snap.verdict, 'FAIL')
  assert.equal(snap.stage, null)
  assert.equal(snap.stages_state, 'unavailable')
  assert.equal(typeof snap.decisions_truncated, 'boolean')
  assert.ok(snap.status_source && snap.status_source.includes('summary'))
  assert.ok(Array.isArray(snap.qc.rules) && snap.qc.rules.length === 7)
  for (const rule of snap.qc.rules) {
    assert.equal(typeof rule.id, 'string')
    assert.ok(rule.source.length > 0)
    assert.ok(rule.actual === null || Number.isFinite(rule.actual))
    assert.ok(rule.verdict === null || rule.verdict === 'pass' || rule.verdict === 'fail')
  }
  const json = JSON.stringify(snap)
  assert.ok(!json.includes('暂无'))
  assert.ok(!json.includes('undefined'))
  assert.ok(!json.includes('NaN'))
})

test('I2 b-track list/snapshot projection is identical', async () => {
  const jobs = discover()
  assert.ok(jobs.length > 0, 'fixture must expose at least one b-track job')
  for (const { item } of jobs) {
    const snap = await buildSnapshot({ source: 'b-track', jobId: item.id })
    assert.equal(item.verdict, snap.verdict, `${item.id} verdict`)
    assert.equal(item.stage, snap.stage, `${item.id} stage`)
    assert.equal(snap.status, bTrackStatusFromVerdict(item.verdict), `${item.id} status`)
  }
})

test('I2 b-track PASS summary yields PASS/succeeded in both list and snapshot', () => {
  const projection = bTrackProjection('PASS', 'CONDITIONAL')
  assert.deepEqual(projection, { status: 'succeeded', verdict: 'PASS', stage: null })
  assert.deepEqual(bTrackProjection('FAIL', 'PASS'), {
    status: 'failed',
    verdict: 'FAIL',
    stage: null
  })
  assert.deepEqual(bTrackProjection(undefined, 'CONDITIONAL'), {
    status: 'succeeded',
    verdict: 'CONDITIONAL',
    stage: null
  })
})

test('I2 studio list/snapshot share studioProjection', () => {
  const detail = {
    state: 'succeeded',
    stage: 'C',
    error: null,
    state_stages: { A: { status: 'done' } }
  }
  const projected = studioProjection(detail)
  assert.deepEqual(projected, { status: 'succeeded', stage: 'C', verdict: 'PASS' })
  const failed = studioProjection({ state: 'failed', error: 'quality gate failed', stage: 'D' })
  assert.deepEqual(failed, { status: 'failed', stage: 'D', verdict: 'FAIL' })
})

test('I3 four unavailable reasons all return the explicit null shape', () => {
  const reasons = [
    'source_unreachable',
    'kex_repo_not_configured',
    'job_not_found',
    'state_unreadable'
  ] as const
  for (const reason of reasons) {
    const snap = unavailableSnapshot('studio', 'job_x', reason)
    assert.equal(snap.available, false)
    assert.equal(snap.reason, reason)
    assert.equal(snap.status, null)
    assert.equal(snap.verdict, null)
    assert.equal(snap.stage, null)
    assert.deepEqual(snap.stages, [])
    assert.deepEqual(snap.artifacts, [])
    assert.deepEqual(snap.qc.rules, [])
    assert.deepEqual(snap.decisions, [])
    assert.equal(snap.decisions_state, 'unavailable')
    assert.equal(snap.decisions_truncated, false)
  }
  // Real HTTP path for job_not_found is asserted in curl.txt.
  return buildSnapshot({ source: 'b-track', jobId: 'does-not-exist' }).then((snap) => {
    assert.equal(snap.available, false)
    assert.equal(snap.reason, 'job_not_found')
  })
})

test('I4 qc rules equal /api/contract policy thresholds and policy sha is stable', async () => {
  const root = process.env.KEX_REPO_ROOT
  assert.ok(root, 'KEX_REPO_ROOT must point at a real kex repo fixture')
  const policyFile = path.join(root, 'policy', 'quality_thresholds.json')
  const before = crypto.createHash('sha256').update(fs.readFileSync(policyFile)).digest('hex')
  const { rules } = policyRules(root)
  const contract = await contractData()
  assert.equal(contract.body.available, true)
  assert.equal(rules.length, 7)
  assert.deepEqual(
    rules.map((rule) => ({
      key: rule.id,
      label: rule.name,
      op: rule.op,
      value: rule.threshold,
      unit: rule.unit
    })),
    contract.body.thresholds.items.map((item: any) => ({
      key: item.key,
      label: item.label,
      op: item.op,
      value: item.value,
      unit: item.unit
    }))
  )
  const after = crypto.createHash('sha256').update(fs.readFileSync(policyFile)).digest('hex')
  assert.equal(before, after)
})

test('I5 decisions: missing -> not_recorded, >20 lines -> last 20 + truncated', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'obs097-dec-'))
  fs.mkdirSync(path.join(root, 'decisions'))
  const missing = readDecisionLog(root, 's1')
  assert.equal(missing.state, 'not_recorded')
  assert.deepEqual(missing.items, [])

  const lines = Array.from({ length: 25 }, (_, i) =>
    JSON.stringify({ at: `2026-11-12T10:${String(i).padStart(2, '0')}:00Z`, kind: 'gate', summary: `d${i}` })
  )
  fs.writeFileSync(path.join(root, 'decisions', 's1.jsonl'), lines.join('\n') + '\n')
  const found = readDecisionLog(root, 's1')
  assert.equal(found.state, 'ok')
  assert.equal(found.items.length, 20)
  assert.equal(found.truncated, true)
  assert.equal(found.items[19].summary, 'd24')
  assert.equal(found.items[0].summary, 'd5')

  assert.deepEqual(readDecisionLog(null, 's1'), { state: 'unavailable', items: [], truncated: false })
  fs.rmSync(root, { recursive: true, force: true })
})

test('I6 job ids: traversal and separators are rejected before FS access', () => {
  for (const bad of ['', '.', '..', '../etc/passwd', 'a/b', 's1/../../x', 'job id', 'x\\y']) {
    assert.equal(isSafeJobId(bad), false, bad)
  }
  for (const good of ['s1', 'job_2026-11-12', 'A.b-c_1']) {
    assert.equal(isSafeJobId(good), true, good)
  }
})

test('status mappings cover every contract enum', () => {
  assert.equal(bTrackStatusFromVerdict('PASS'), 'succeeded')
  assert.equal(bTrackStatusFromVerdict('CONDITIONAL'), 'succeeded')
  assert.equal(bTrackStatusFromVerdict('FAIL'), 'failed')
  assert.equal(bTrackStatusFromVerdict('UNKNOWN'), 'unknown')
  assert.equal(bTrackStatusFromVerdict(null), 'unknown')
  assert.equal(bTrackStatusFromVerdict('garbage'), 'unknown')

  assert.equal(studioStatus(undefined), 'queued')
  assert.equal(studioStatus('running'), 'running')
  assert.equal(studioStatus('succeeded'), 'succeeded')
  assert.equal(studioStatus('failed'), 'failed')
  assert.equal(studioStatus('rejected'), 'failed')
  assert.equal(studioStatus('canceled'), 'canceled')

  assert.equal(studioVerdictFromQc('pass'), 'PASS')
  assert.equal(studioVerdictFromQc('fail'), 'FAIL')
  assert.equal(studioVerdictFromQc('pending'), 'UNKNOWN')

  assert.equal(judgeRule('<=', 15, 23.8), 'fail')
  assert.equal(judgeRule('>=', 0.8, 0.9), 'pass')
  assert.equal(judgeRule('>=', 0.8, null), null)
})
