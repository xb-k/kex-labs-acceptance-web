import assert from 'node:assert/strict'
import test from 'node:test'
import { enrichAndFilterJobs } from './components/production/JobPicker'
import type { Delivery, FlowJobSummary } from './types'

const MOCK_JOBS: FlowJobSummary[] = [
  { id: '20261112_coffee_ad_001', updated_at: '2026-11-12T08:00:00Z', size: 1200 },
  { id: '20261113_vlog_cafe_002', updated_at: '2026-11-13T10:30:00Z', size: 2400 },
  { id: '20261113_tea_brand_003', updated_at: '2026-11-13T11:45:00Z', size: 3100 }
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
  assert.equal(all[2].status, 'delivered')
  assert.equal(all[2].title, '手冲咖啡品牌广告')

  const onlyDelivered = enrichAndFilterJobs(MOCK_JOBS, MOCK_DELIVERIES, '', 'delivered')
  assert.equal(onlyDelivered.length, 1)
  assert.equal(onlyDelivered[0].id, '20261112_coffee_ad_001')

  const onlyRendering = enrichAndFilterJobs(MOCK_JOBS, MOCK_DELIVERIES, '', 'rendering')
  assert.equal(onlyRendering.length, 2)

  const searched = enrichAndFilterJobs(MOCK_JOBS, MOCK_DELIVERIES, 'vlog', 'all')
  assert.equal(searched.length, 1)
  assert.equal(searched[0].id, '20261113_vlog_cafe_002')
})
