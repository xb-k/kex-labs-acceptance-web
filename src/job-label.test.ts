import assert from 'node:assert/strict'
import test from 'node:test'
import { jobBasename, jobIdShort, jobLabelWithId, jobReadable, matchesJobQuery } from './job-label'

test('#102 图片生成：类型 + 轨别 + 素材 basename + 时间 + 状态', () => {
  const label = jobReadable({
    id: 'web-20261113093155-3ef5f3',
    type: 'image',
    rail: 'B',
    uploadName: '/Users/kexinbao/素材/IMG_3189.MOV',
    created_at: '2026-11-13T12:03:00',
    status: 'succeeded'
  })
  assert.equal(label, '图片生成 · B 轨 · IMG_3189.MOV · 11-13 12:03 · 完成')
})

test('#102 B 轨优化：类型已含轨别时不重复追加', () => {
  assert.equal(
    jobReadable({
      id: 'web-20261113033839-abc123',
      type: 'optimize',
      rail: 'B',
      source: 'source.MOV',
      status: 'running'
    }),
    'B 轨优化 · source.MOV · 进行中'
  )
})

test('#102 A 轨生成：A 轨不重复且失败状态可读', () => {
  assert.equal(
    jobReadable({ id: 'web-a', type: 'aigc', rail: 'A', input: 'clip-01.mp4', status: 'failed' }),
    'A 轨生成 · clip-01.mp4 · 失败'
  )
})

test('#102 其它类型 + B 轨：用标题兜底，保留可读信息', () => {
  assert.equal(
    jobReadable({
      id: 's0',
      track: 'B',
      title: '工具链最小验证（T-VID-068 → 接力 T-VID-084）',
      status: 'done'
    }),
    '任务 · B 轨 · 工具链最小验证（T-VID-068 → 接力 T-VID-084） · 完成'
  )
})

test('#102 缺字段：只输出「任务」，不出现 undefined / null', () => {
  const label = jobReadable({ id: 's1' })
  assert.equal(label, '任务')
  assert.equal(/undefined|null|NaN/.test(label), false)
})

test('#102 绝对路径清理：只留 basename，不回显目录', () => {
  assert.equal(jobBasename('/Users/kexinbao/clips/IMG_3189.MOV'), 'IMG_3189.MOV')
  const label = jobReadable({ id: 'x', type: 'image', input: '/volume1/小甜豆/a/成片.MOV' })
  assert.equal(label, '图片生成 · 成片.MOV')
  assert.equal(label.includes('/volume1'), false)
})

test('#102 upload_id 不是文件名时不当作素材名', () => {
  const label = jobReadable({ id: 'x', type: 'image', upload_id: 'up-mweax6a5-c325c8' })
  assert.equal(label, '图片生成')
  assert.equal(label.includes('up-'), false)
})

test('#102 标题只是 id 回显时不做兜底（studio fallback）', () => {
  const id = 'web-20261113093155-3ef5f3'
  const label = jobReadable({ id, track: 'B', title: `创作工坊任务 · ${id}` })
  assert.equal(label, '任务 · B 轨')
  assert.equal(label.includes(id), false)
})

test('#102 时间格式固定为 MM-DD HH:mm，非法时间省略', () => {
  assert.equal(jobReadable({ id: 'x', created_at: '2026-11-03T09:05:00' }), '任务 · 11-03 09:05')
  assert.equal(jobReadable({ id: 'x', created_at: 'not-a-date' }), '任务')
})

test('#102 jobIdShort 保留可读缩略，短 id 原样', () => {
  assert.equal(jobIdShort('web-20261113093155-3ef5f3'), '…3ef5f3')
  assert.equal(jobIdShort('s0'), 's0')
  assert.equal(jobIdShort(null), '')
})

test('#102 jobLabelWithId = 主标签 + 缩略 id', () => {
  assert.equal(
    jobLabelWithId({ id: 'web-20261113093155-3ef5f3', type: 'image', status: 'succeeded' }),
    '图片生成 · 完成 · …3ef5f3'
  )
})

test('#102 筛选同时匹配 id 与可读标签', () => {
  const job = { id: 'web-20261113093155-3ef5f3', type: 'image', rail: 'B', status: 'succeeded' }
  assert.equal(matchesJobQuery(job, '3ef5f3'), true)
  assert.equal(matchesJobQuery(job, '图片生成'), true)
  assert.equal(matchesJobQuery(job, 'B 轨'), true)
  assert.equal(matchesJobQuery(job, 'b 轨'), true)
  assert.equal(matchesJobQuery(job, 'optimize'), false)
  assert.equal(matchesJobQuery(job, '   '), true)
})

test('#102 筛选覆盖页面实际显示的状态/判据/分辨率文字', () => {
  const job = {
    id: 's0',
    track: 'B',
    title: '工具链最小验证（T-VID-068 → 接力 T-VID-084）',
    status: 'succeeded',
    verdict: 'CONDITIONAL',
    statusLabel: 'PASS（有条件）',
    statusNote: 'B3 阈值未取得',
    width: 1080,
    height: 1920,
    fps: 60,
    frames: 120,
    passed: 6,
    judged: 7,
    stage: 'image'
  }
  assert.equal(matchesJobQuery(job, '有条件'), true)
  assert.equal(matchesJobQuery(job, '1080×1920'), true)
  assert.equal(matchesJobQuery(job, '1080x1920'), true)
  assert.equal(matchesJobQuery(job, '6/7'), true)
  assert.equal(matchesJobQuery(job, '阶段 image'), false)
  assert.equal(matchesJobQuery(job, 'image'), true)
  assert.equal(matchesJobQuery(job, 'B3 阈值未取得'), true)
})

test('#102 筛选用截断前的完整 title（40 字之后仍可命中）', () => {
  const tail = '尾部关键词XYZ'
  const title = '很长的任务标题'.repeat(6) + tail
  const job = { id: 's9', track: 'B', title, status: 'done' }
  assert.equal(jobReadable(job).includes(tail), false)
  assert.equal(matchesJobQuery(job, tail), true)
})
