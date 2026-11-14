import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ImageJobTracker, ImageWorkbench } from './components/ImageWorkbench'
import {
  IMAGE_SIZES,
  KEYFRAME_ONLY_HINT,
  buildAigcJobPayload,
  buildImageJobPayload,
  buildPromptEnhanceRequest,
  buildJobDeletePlan,
  canCancelImageJob,
  canDeleteJob,
  formatJobDuration,
  galleryMeta,
  IMAGE_WAIT_STAGES,
  imageCancelHint,
  imageJobDurationMs,
  imageWaitStage,
  galleryPrimaryImage,
  galleryStatusLabel,
  hasAigcSource,
  imageActionState,
  initialPromptEnhanceState,
  promptEnhanceReducer,
  referencePanelState,
  resolveSubmitFields,
  validateCoverTarget,
  validateImageForm
} from './image-workbench'
import type { StudioGalleryItem, StudioJob, StudioJobStatus } from './types'

const BASE = {
  mode: 't2i' as const,
  prompt: '雪山日出',
  negative: '',
  size: '1536x864',
  seed: '42',
  steps: '20',
  denoise: '1'
}

test('尺寸：三档白名单全部可用，其余拒绝', () => {
  for (const size of IMAGE_SIZES) {
    const result = validateImageForm({ ...BASE, size: size.value })
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.image.width, size.width)
      assert.equal(result.image.height, size.height)
    }
  }
  const bad = validateImageForm({ ...BASE, size: '1920x1080' })
  assert.equal(bad.ok, false)
  if (!bad.ok) assert.equal(bad.field, 'size')
})

test('denoise：t2i 强制 1.0（忽略表单残留值），edit 校验 (0,1]', () => {
  const t2i = validateImageForm({ ...BASE, denoise: '0.3' })
  assert.equal(t2i.ok, true)
  if (t2i.ok) assert.equal(t2i.image.denoise, 1)

  const editOk = validateImageForm({
    ...BASE,
    mode: 'edit',
    denoise: '0.55',
    sourceUploadId: 'up-12345678'
  })
  assert.equal(editOk.ok, true)
  if (editOk.ok) assert.equal(editOk.image.denoise, 0.55)

  for (const value of ['0', '-0.1', '1.2', 'abc']) {
    const bad = validateImageForm({
      ...BASE,
      mode: 'edit',
      denoise: value,
      sourceUploadId: 'up-12345678'
    })
    assert.equal(bad.ok, false)
    if (!bad.ok) assert.equal(bad.field, 'denoise')
  }
})

test('prompt / seed / steps 校验', () => {
  assert.equal(validateImageForm({ ...BASE, prompt: '   ' }).ok, false)
  assert.equal(validateImageForm({ ...BASE, seed: '-1' }).ok, false)
  assert.equal(validateImageForm({ ...BASE, seed: '4294967296' }).ok, false)
  assert.equal(validateImageForm({ ...BASE, seed: '1.5' }).ok, false)
  assert.equal(validateImageForm({ ...BASE, steps: '0' }).ok, false)
  assert.equal(validateImageForm({ ...BASE, steps: '101' }).ok, false)
})

test('edit 必填参考图：上传 id 或绝对路径二选一', () => {
  const edit = { ...BASE, mode: 'edit' as const, denoise: '0.6' }

  const missing = validateImageForm(edit)
  assert.equal(missing.ok, false)
  if (!missing.ok) assert.equal(missing.field, 'source')

  const byUpload = validateImageForm({ ...edit, sourceUploadId: 'up-12345678' })
  assert.equal(byUpload.ok, true)
  if (byUpload.ok) {
    assert.equal(byUpload.image.source_upload_id, 'up-12345678')
    assert.equal(byUpload.image.source_image, undefined)
  }

  const byPath = validateImageForm({ ...edit, sourceImage: '/studio/ref.png' })
  assert.equal(byPath.ok, true)
  if (byPath.ok) assert.equal(byPath.image.source_image, '/studio/ref.png')

  const both = validateImageForm({
    ...edit,
    sourceUploadId: 'up-12345678',
    sourceImage: '/studio/ref.png'
  })
  assert.equal(both.ok, false)

  const relative = validateImageForm({ ...edit, sourceImage: 'ref.png' })
  assert.equal(relative.ok, false)
})

test('image 任务 payload：type=image + image 对象', () => {
  const checked = validateImageForm({ ...BASE, prompt: '  海报  ' })
  assert.equal(checked.ok, true)
  if (!checked.ok) return
  assert.deepEqual(buildImageJobPayload(checked.image), {
    type: 'image',
    image: {
      mode: 't2i',
      prompt: '海报',
      negative: '',
      width: 1536,
      height: 864,
      seed: 42,
      steps: 20,
      denoise: 1
    }
  })
})

test('A 轨 payload：选关键帧时透传，未选时不含该键', () => {
  const withKeyframe = buildAigcJobPayload({
    briefId: 'brief_1',
    uploadId: 'up-12345678',
    keyframe: { source_job: 'imgjob-1', name: 'image-01.png' }
  })
  assert.deepEqual(withKeyframe, {
    type: 'aigc',
    rail: 'A',
    brief_id: 'brief_1',
    upload_id: 'up-12345678',
    keyframe_asset: { source_job: 'imgjob-1', name: 'image-01.png' }
  })

  const plain = buildAigcJobPayload({ briefId: null, uploadId: 'up-12345678' })
  assert.equal('keyframe_asset' in plain, false)

  const absolute = buildAigcJobPayload({ briefId: null, input: '/studio/src.mp4', uploadId: 'ignored' })
  assert.equal(absolute.input, '/studio/src.mp4')
  assert.equal('upload_id' in absolute, false)
})

/* #150：无素材 + 关键帧 = 可提交；payload 不含 input/upload_id。 */
test('#150 A 轨仅关键帧：提交按钮可用，payload 不带 input', () => {
  const keyframe = { source_job: 'imgjob-1', name: 'image-01.png' }
  assert.equal(hasAigcSource({ input: '', uploadId: null, keyframe }), true)
  assert.equal(hasAigcSource({ input: '', uploadId: null }), false)
  assert.equal(hasAigcSource({ input: '/studio/src.mp4' }), true)
  assert.equal(hasAigcSource({ input: '', uploadId: 'up-12345678' }), true)

  const payload = buildAigcJobPayload({ briefId: null, keyframe })
  assert.deepEqual(payload, {
    type: 'aigc',
    rail: 'A',
    brief_id: null,
    keyframe_asset: { source_job: 'imgjob-1', name: 'image-01.png' }
  })
  assert.equal('input' in payload, false)
  assert.equal('upload_id' in payload, false)
  // 提示文案要同时说清「用关键帧生成」与「耗时量级」。
  assert.match(KEYFRAME_ONLY_HINT, /关键帧生成基础镜头/)
  assert.match(KEYFRAME_ONLY_HINT, /15–25 分钟/)
})

test('gallery 映射：主图 / 状态标签 / 元信息', () => {
  const item: StudioGalleryItem = {
    id: 'imgjob-1',
    status: 'succeeded',
    created_at: '2026-11-13T00:00:00.000Z',
    updated_at: '2026-11-13T00:00:10.000Z',
    error: null,
    stage: null,
    mode: 'edit',
    prompt: '海报',
    negative: '',
    width: 864,
    height: 1536,
    seed: 7,
    steps: 30,
    denoise: 0.6,
    elapsed_s: 12.34,
    duration_ms: 12340,
    images: [{ name: 'image-01.png', url: '/api/studio/jobs/imgjob-1/artifacts/image-01.png' }],
    cover_url: '/api/studio/jobs/imgjob-1/artifacts/image-01.png'
  }
  assert.deepEqual(galleryPrimaryImage(item), item.images[0])
  assert.equal(
    galleryPrimaryImage({ ...item, images: [] }),
    null
  )
  assert.equal(galleryStatusLabel('succeeded'), '已完成')
  assert.equal(galleryStatusLabel('failed'), '失败')
  assert.equal(galleryMeta(item), 'Edit · 864×1536 · 30 steps · seed 7')

  const failed = galleryMeta({ ...item, mode: null, width: null, height: null, steps: null, seed: null, elapsed_s: null })
  assert.equal(failed, '')
})

test('#139 耗时展示：<60s 一位小数，≥60s 用 m ss，null 显示「耗时未记录」', () => {
  assert.equal(formatJobDuration(12340), '耗时 12.3s')
  assert.equal(formatJobDuration(63000), '耗时 1m 03s')
  assert.equal(formatJobDuration(60000), '耗时 1m 00s')
  assert.equal(formatJobDuration(0), '耗时 0.0s')
  assert.equal(formatJobDuration(null), '耗时未记录')
  assert.equal(formatJobDuration(undefined), '耗时未记录')
})

test('#140 删除入口：仅 failed / canceled 可删', () => {
  assert.equal(canDeleteJob('failed'), true)
  assert.equal(canDeleteJob('canceled'), true)
  for (const status of ['queued', 'running', 'succeeded'] as const) {
    assert.equal(canDeleteJob(status), false)
    assert.equal(buildJobDeletePlan({ id: 'job-1', status }), null)
  }
})

test('#140 删除请求与确认文案：URL 编码 id，文案含 id 与状态', () => {
  const plan = buildJobDeletePlan({ id: 'web-20261113082701-b01b92', status: 'failed' })
  assert.ok(plan)
  assert.equal(plan.url, '/api/studio/jobs/web-20261113082701-b01b92')
  assert.match(plan.description, /web-20261113082701-b01b92/)
  assert.match(plan.description, /失败/)

  const canceled = buildJobDeletePlan({ id: 'job 1/2', status: 'canceled' })
  assert.ok(canceled)
  assert.equal(canceled.url, '/api/studio/jobs/job%201%2F2')
  assert.match(canceled.description, /已取消/)
})

test('#136 图片等待阶段：提交 → 排队 → 生成 → 完成，失败停在生成并带后端错误', () => {
  assert.deepEqual([...IMAGE_WAIT_STAGES], ['提交请求', '排队等待', '模型生成', '完成'])
  assert.deepEqual(imageWaitStage(null), { stage: 1, label: '已提交，等待 studio 返回状态' })
  assert.deepEqual(imageWaitStage('queued'), { stage: 1, label: '已入队，等待 GPU 排队' })
  assert.deepEqual(imageWaitStage('running'), { stage: 2, label: '模型正在生成图片' })
  assert.deepEqual(imageWaitStage('succeeded'), { stage: 3, label: '图片生成完成' })
  assert.deepEqual(imageWaitStage('failed'), { stage: 2, label: '图片生成失败' })
  assert.deepEqual(imageWaitStage('canceled'), { stage: 2, label: '图片任务已取消' })
})

test('#136 完成耗时：后端 duration_ms 优先，缺失回退本地墙钟，非法值不展示', () => {
  assert.equal(imageJobDurationMs(12340, 20000), 12340)
  assert.equal(imageJobDurationMs(null, 20000), 20000)
  assert.equal(imageJobDurationMs(undefined, 0), 0)
  assert.equal(imageJobDurationMs(null, null), undefined)
  assert.equal(imageJobDurationMs(Number.NaN, -1), undefined)
})

/** #149 SSR 渲染用：只需 status / error 的图片 job 假数据。 */
function imageJob(status: StudioJobStatus): StudioJob {
  return {
    id: 'web-149-test',
    type: 'image',
    rail: 'A',
    status,
    brief_id: null,
    created_at: '2026-11-14T00:00:00Z',
    updated_at: '2026-11-14T00:00:00Z',
    error: status === 'failed' ? '模型显存不足' : null,
    stage: null,
    duration_ms: 203994,
    plan_id: null,
    model: null,
    inputs: [],
    outputs: [],
    assets: [],
    qc: { status: 'pending', report_id: null },
    cost: { gpu_seconds: null, credits: null },
    created_by: 'web',
    events: [],
    progress: { stage: null, stages: {} }
  }
}

test('#149 取消入口：仅 queued 显示，running/终态不假取消', () => {
  assert.equal(canCancelImageJob('queued'), true)
  assert.equal(canCancelImageJob('running'), false)
  for (const status of ['succeeded', 'failed', 'canceled', null, undefined] as const) {
    assert.equal(canCancelImageJob(status), false)
  }
})

test('#149 running 态给出「生成中不可取消」说明，其他状态无提示', () => {
  assert.equal(imageCancelHint('running'), '生成中不可取消')
  for (const status of ['queued', 'succeeded', 'failed', 'canceled', null, undefined] as const) {
    assert.equal(imageCancelHint(status), null)
  }
})

test('#149 UI 渲染：queued 有取消按钮，running 无取消且有说明', () => {
  const queuedHtml = renderToStaticMarkup(
    createElement(ImageJobTracker, {
      jobId: 'web-149-test',
      startedAt: 1_000_000,
      initialJob: imageJob('queued')
    })
  )
  assert.match(queuedHtml, /data-testid="async-cancel"/)
  assert.match(queuedHtml, /已入队，等待 GPU 排队/)
  assert.doesNotMatch(queuedHtml, /data-testid="image-cancel-hint"/)

  const runningHtml = renderToStaticMarkup(
    createElement(ImageJobTracker, {
      jobId: 'web-149-test',
      startedAt: 1_000_000,
      initialJob: imageJob('running')
    })
  )
  assert.doesNotMatch(runningHtml, /data-testid="async-cancel"/)
  assert.match(runningHtml, /data-testid="image-cancel-hint"/)
  assert.match(runningHtml, /生成中不可取消/)

  for (const status of ['succeeded', 'failed', 'canceled'] as const) {
    const html = renderToStaticMarkup(
      createElement(ImageJobTracker, {
        jobId: 'web-149-test',
        startedAt: 1_000_000,
        initialJob: imageJob(status)
      })
    )
    assert.doesNotMatch(html, /data-testid="async-cancel"/)
    assert.doesNotMatch(html, /data-testid="image-cancel-hint"/)
  }
})

test('封面 / 关键帧按钮 enable 条件：先选中图片', () => {
  const none = imageActionState({ hasSelection: false, coverBusy: false })
  assert.equal(none.coverDisabled, true)
  assert.equal(none.keyframeDisabled, true)

  const selected = imageActionState({ hasSelection: true, coverBusy: false })
  assert.equal(selected.coverDisabled, false)
  assert.equal(selected.keyframeDisabled, false)

  const writing = imageActionState({ hasSelection: true, coverBusy: true })
  assert.equal(writing.coverDisabled, true)
  assert.equal(writing.keyframeDisabled, false)
})

test('封面目标校验：目标 job / 图片名', () => {
  const ok = validateCoverTarget('job-abc_1', 'imgjob-1', 'image-01.png')
  assert.equal(ok.ok, true)
  if (ok.ok) {
    assert.equal(ok.target, 'job-abc_1')
    assert.deepEqual(ok.body, { source_job: 'imgjob-1', name: 'image-01.png' })
  }

  assert.equal(validateCoverTarget('', 'imgjob-1', 'image-01.png').ok, false)
  assert.equal(validateCoverTarget('../etc', 'imgjob-1', 'image-01.png').ok, false)
  assert.equal(validateCoverTarget('job-1', 'imgjob-1', '../image.png').ok, false)
  assert.equal(validateCoverTarget('job-1', 'imgjob-1', 'image.gif').ok, false)
})

test('#112 参考图面板：T2I 也始终可上传', () => {
  const t2i = referencePanelState({ mode: 't2i', uploadId: null, uploading: false })
  assert.equal(t2i.canUpload, true)
  assert.equal(t2i.showReady, false)
  assert.equal(t2i.showSwitchToEdit, false)
  assert.match(t2i.note, /仅 Edit 模式参与生成/)
})

test('#112 上传后切换提示：T2I 给一键改用 Edit，Edit 不再提示', () => {
  const t2iUploaded = referencePanelState({ mode: 't2i', uploadId: 'up-123', uploading: false })
  assert.equal(t2iUploaded.showReady, true)
  assert.equal(t2iUploaded.showSwitchToEdit, true)
  assert.equal(t2iUploaded.canClear, true)
  assert.match(t2iUploaded.note, /参考图仅 Edit 模式参与生成/)

  const editUploaded = referencePanelState({ mode: 'edit', uploadId: 'up-123', uploading: false })
  assert.equal(editUploaded.showReady, true)
  assert.equal(editUploaded.showSwitchToEdit, false)
  assert.match(editUploaded.note, /source_upload_id/)
})

test('#112 清除参考图 / 上传中：状态归零且不可清除', () => {
  const cleared = referencePanelState({ mode: 'edit', uploadId: null, uploading: false })
  assert.equal(cleared.showReady, false)
  assert.equal(cleared.canClear, false)
  assert.match(cleared.note, /必须上传参考图/)

  const busy = referencePanelState({ mode: 'edit', uploadId: 'up-123', uploading: true })
  assert.equal(busy.canUpload, false)
  assert.equal(busy.canClear, false)
  assert.equal(busy.showReady, true)
})


// ---------------------------------------------------------------------------
// #160 一句话增强：SSR 开关 / 预览 / 编辑后提交 / 失败回退
// ---------------------------------------------------------------------------

test('#160 SSR：默认开启「一句话增强」，初始只有预览按钮，没有增强文本区', () => {
  const html = renderToStaticMarkup(
    createElement(ImageWorkbench, { jobOptions: [], onUseKeyframe: () => undefined })
  )
  assert.match(html, /data-testid="prompt-enhance-panel"/)
  assert.match(html, /一句话增强/)
  assert.match(html, /data-testid="prompt-enhance-toggle"[^>]*checked=""/)
  assert.match(html, /data-testid="prompt-enhance-preview"[^>]*>预览增强</)
  assert.doesNotMatch(html, /data-testid="prompt-enhance-text"/)
  assert.doesNotMatch(html, /data-testid="prompt-enhance-error"/)
})

test('#160 交互：开关 → 预览 → 编辑 → 提交用编辑后的增强文本', () => {
  let state = initialPromptEnhanceState
  state = promptEnhanceReducer(state, { type: 'toggle', enabled: true })
  state = promptEnhanceReducer(state, { type: 'preview_start' })
  assert.equal(state.loading, true)

  state = promptEnhanceReducer(state, {
    type: 'preview_success',
    preview: {
      prompt: '雪山日出，24mm 广角镜头，5600K 中性色温',
      negative: '3d render, cgi',
      scene: '自然',
      clauses: ['24mm 广角镜头', '5600K 中性色温']
    }
  })
  assert.equal(state.loading, false)
  assert.equal(state.preview?.scene, '自然')
  assert.equal(state.error, null)

  state = promptEnhanceReducer(state, {
    type: 'edit_prompt',
    value: '雪山日出，24mm 广角镜头（人工调整）'
  })
  state = promptEnhanceReducer(state, { type: 'edit_negative', value: '3d render, 水印' })
  assert.deepEqual(
    resolveSubmitFields({
      enabled: state.enabled,
      plainPrompt: '雪山日出',
      plainNegative: '低清',
      preview: state.preview
    }),
    { prompt: '雪山日出，24mm 广角镜头（人工调整）', negative: '3d render, 水印' }
  )
})

test('#160 交互：关闭开关 / 预览失败都回退原文，原始白话不丢', () => {
  const success = promptEnhanceReducer(initialPromptEnhanceState, {
    type: 'preview_success',
    preview: { prompt: '增强后', negative: 'negative', scene: '自然', clauses: ['增强后'] }
  })
  assert.deepEqual(
    resolveSubmitFields({
      enabled: false,
      plainPrompt: '原始白话',
      plainNegative: '低清',
      preview: success.preview
    }),
    { prompt: '原始白话', negative: '低清' }
  )

  const failed = promptEnhanceReducer(success, {
    type: 'preview_error',
    message: '增强失败：HTTP 500；可直接用原文提交。'
  })
  assert.equal(failed.preview, null)
  assert.match(failed.error ?? '', /可直接用原文提交/)
  assert.deepEqual(
    resolveSubmitFields({
      enabled: true,
      plainPrompt: '原始白话',
      plainNegative: '低清',
      preview: failed.preview
    }),
    { prompt: '原始白话', negative: '低清' }
  )

  const reset = promptEnhanceReducer(success, { type: 'reset' })
  assert.equal(reset.preview, null)
  assert.equal(reset.error, null)
})

test('#160 预览请求体：原始白话与 negative 去首尾空白，交给后端合并', () => {
  assert.deepEqual(buildPromptEnhanceRequest({ prompt: '  雪山日出  ', negative: ' 低清 ' }), {
    prompt: '雪山日出',
    negative: '低清'
  })
})
