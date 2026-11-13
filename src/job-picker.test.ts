import assert from 'node:assert/strict'
import test from 'node:test'
import {
  enrichAndFilterJobs,
  JOB_STATUS_LABEL,
  jobStatusHint,
  resolveJobDisplayStatus
} from './components/production/JobPicker'
import type { Delivery, FlowJobSummary } from './types'

const MOCK_JOBS: FlowJobSummary[] = [
  {
    id: '20261112_coffee_ad_001',
    updated_at: '2026-11-12T08:00:00Z',
    size: 1200,
    status: 'succeeded',
    status_source: 'state',
    stale: false
  },
  {
    id: '20261113_vlog_cafe_002',
    updated_at: '2026-11-13T10:30:00Z',
    size: 2400,
    status: 'running',
    status_source: 'state',
    stale: false
  },
  {
    id: '20261113_tea_brand_003',
    updated_at: '2026-11-13T11:45:00Z',
    size: 3100,
    status: 'queued',
    status_source: 'intake',
    stale: true
  }
]

const MOCK_DELIVERIES: Delivery[] = [
  {
    jobId: '20261112_coffee_ad_001',
    title: '手冲咖啡品牌广告',
    createdAt: '2026-11-12T08:10:00Z',
    durationS: 15.2,
    width: 1920,
    height: 1080,
    mp4: '/api/deliveries/20261112_coffee_ad_001/video',
    poster: null,
    coverUrl: null,
    report: null,
    score: 0.94,
    gate: 'PASS'
  }
]

test('enrichAndFilterJobs sorts newest first and filters cleanly across status and search query', () => {
  const all = enrichAndFilterJobs(MOCK_JOBS, MOCK_DELIVERIES, '', 'all')
  assert.equal(all.length, 3)
  assert.equal(all[0].id, '20261113_tea_brand_003')
  assert.equal(all[2].id, '20261112_coffee_ad_001')
  assert.equal(all[2].status, 'succeeded')
  assert.equal(all[2].title, '手冲咖啡品牌广告')

  const onlyDone = enrichAndFilterJobs(MOCK_JOBS, MOCK_DELIVERIES, '', 'done')
  assert.equal(onlyDone.length, 1)
  assert.equal(onlyDone[0].id, '20261112_coffee_ad_001')

  // 停滞的 queued 不计入「活跃」，单独归属「需关注」，不显示为渲染中
  const onlyActive = enrichAndFilterJobs(MOCK_JOBS, MOCK_DELIVERIES, '', 'active')
  assert.equal(onlyActive.length, 1)
  assert.equal(onlyActive[0].id, '20261113_vlog_cafe_002')

  const onlyAttention = enrichAndFilterJobs(MOCK_JOBS, MOCK_DELIVERIES, '', 'attention')
  assert.equal(onlyAttention.length, 1)
  assert.equal(onlyAttention[0].id, '20261113_tea_brand_003')
  assert.equal(onlyAttention[0].status, 'stale')
  assert.equal(onlyAttention[0].statusLabel, '状态停滞')

  const searched = enrichAndFilterJobs(MOCK_JOBS, MOCK_DELIVERIES, 'vlog', 'all')
  assert.equal(searched.length, 1)
  assert.equal(searched[0].id, '20261113_vlog_cafe_002')
})

test('无 delivery 的 job 不会被推断为渲染中，delivery 也不会改变运行状态', () => {
  const noDeliveryRunning = enrichAndFilterJobs(
    [
      {
        id: 'job_running',
        updated_at: '2026-11-13T10:00:00Z',
        size: 1,
        status: 'running',
        status_source: 'state',
        stale: false
      }
    ],
    [],
    '',
    'all'
  )
  assert.equal(noDeliveryRunning[0].status, 'running')

  const withDeliveryUnknown = enrichAndFilterJobs(
    [
      {
        id: 'job_unknown',
        updated_at: '2026-11-13T10:00:00Z',
        size: 1,
        status: 'unknown',
        status_source: 'unknown',
        stale: false
      }
    ],
    MOCK_DELIVERIES,
    '',
    'all'
  )
  assert.equal(withDeliveryUnknown[0].status, 'unknown')
  assert.equal(withDeliveryUnknown[0].statusLabel, '状态未知')
})

test('resolveJobDisplayStatus only marks running/queued as stale', () => {
  assert.equal(resolveJobDisplayStatus({ status: 'running', stale: true }), 'stale')
  assert.equal(resolveJobDisplayStatus({ status: 'queued', stale: true }), 'stale')
  assert.equal(resolveJobDisplayStatus({ status: 'running', stale: false }), 'running')
  assert.equal(resolveJobDisplayStatus({ status: 'succeeded', stale: true }), 'succeeded')
  assert.equal(resolveJobDisplayStatus({ status: 'unknown', stale: false }), 'unknown')
})

test('status labels and source hints never claim an unknown job is rendering', () => {
  assert.equal(JOB_STATUS_LABEL.stale, '状态停滞')
  assert.equal(JOB_STATUS_LABEL.unknown, '状态未知')
  assert.equal(JOB_STATUS_LABEL.running, '渲染中')

  const unknownHint = jobStatusHint({
    status: 'unknown',
    stale: false,
    status_source: 'unknown',
    updated_at: '2026-11-13T10:00:00Z'
  })
  assert.ok(unknownHint.includes('无状态来源'))
  assert.ok(unknownHint.includes('不推断为渲染中'))

  const staleHint = jobStatusHint({
    status: 'queued',
    stale: true,
    status_source: 'intake',
    updated_at: '2026-11-13T10:00:00Z'
  })
  assert.ok(staleHint.includes('intake 队列'))
  assert.ok(staleHint.includes('状态停滞'))

  const stateHint = jobStatusHint({
    status: 'running',
    stale: false,
    status_source: 'state',
    updated_at: '2026-11-13T10:00:00Z'
  })
  assert.ok(stateHint.includes('状态文件'))
})
