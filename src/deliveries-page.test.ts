import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  allVisibleSelected,
  batchDeleteCopy,
  batchDeleteSummary,
  DeliveriesPage,
  DeliveryCard,
  deliveryDeleteCopy,
  deliveryImageSrc,
  deliveryIsImage,
  failedSelection,
  pruneSelection,
  runBatchDelete,
  toggleSelectAllVisible,
  toggleSelection
} from './pages/DeliveriesPage'
import { HttpError } from './api'
import { RouterProvider } from './router'
import type { Delivery, DeliveryTrashResponse } from './types'

const IMAGE_URL = '/api/media/jobs/web-20261114031033-923549/image-01.png'

/** #159 交付行 fixture；image 行 mp4 为空、图片地址同时进 poster/coverUrl。 */
function delivery(overrides: Partial<Delivery> = {}): Delivery {
  return {
    jobId: 'web-20261114031033-923549',
    title: 'b-1 · image · a',
    durationS: null,
    width: null,
    height: null,
    mp4: '',
    image: IMAGE_URL,
    poster: IMAGE_URL,
    coverUrl: IMAGE_URL,
    report: null,
    score: null,
    gate: '已发布',
    createdAt: '2026-11-14T03:10:33.000Z',
    bytes: 4096,
    repair: null,
    ...overrides
  }
}

const noop = (_item: Delivery, _result: DeliveryTrashResponse) => {}

function renderCard(item: Delivery, selected = false): string {
  // SSR 无浏览器全局：RouterProvider 初始化只读 window.location（effect 不执行）。
  ;(globalThis as any).window ??= { location: { pathname: '/deliveries', search: '' } }
  return renderToStaticMarkup(
    createElement(
      RouterProvider,
      null,
      createElement(DeliveryCard, { item, onDeleted: noop, selected })
    )
  )
}

test('#159 image 交付行渲染图片卡片：图片地址、无时长、无播放、下载图片', () => {
  const html = renderCard(delivery({ kind: 'image' }))
  assert.match(html, /data-testid="delivery-card"/)
  assert.match(html, /data-kind="image"/)
  assert.match(html, /data-testid="delivery-kind-image"/)
  assert.match(html, /data-testid="delivery-preview"/)
  assert.match(html, new RegExp(`src="${IMAGE_URL}"`))
  assert.doesNotMatch(html, /data-testid="delivery-duration"/)
  assert.doesNotMatch(html, /data-testid="delivery-play"/)
  assert.doesNotMatch(html, />播放</)
  assert.match(html, /data-testid="download-image"/)
  assert.match(html, />下载图片</)
  assert.doesNotMatch(html, /data-testid="download-mp4"/)
})

test('#159 旧交付行（无 kind）按 video 渲染，保留时长与播放按钮', () => {
  const html = renderCard(
    delivery({
      kind: undefined,
      image: null,
      poster: '/media/artifact?path=poster.jpg',
      coverUrl: null,
      mp4: '/media/out/web-20261114031033-923549',
      durationS: 12,
      width: 1080,
      height: 1920
    })
  )
  assert.match(html, /data-kind="video"/)
  assert.match(html, /data-testid="delivery-duration"/)
  assert.match(html, /data-testid="delivery-play"/)
  assert.match(html, />播放</)
  assert.match(html, /data-testid="download-mp4"/)
  assert.doesNotMatch(html, /data-testid="delivery-kind-image"/)
})

test('#159 image 行判定与地址：旧数据默认 video、无图返回 null', () => {
  assert.equal(deliveryIsImage(delivery({ kind: 'image' })), true)
  assert.equal(deliveryIsImage(delivery({ kind: undefined })), false)
  assert.equal(deliveryImageSrc(delivery({ kind: 'image' })), IMAGE_URL)
  assert.equal(deliveryImageSrc(delivery({ kind: 'video', image: null })), null)
})

test('#159 删除确认：NAS 图片为物理删除文案，旧交付仍为回收站文案', () => {
  const image = deliveryDeleteCopy(delivery({ kind: 'image' }))
  assert.equal(image.confirm, '永久删除')
  assert.match(image.body, /永久删除 NAS 文件，不可恢复/)
  assert.match(image.title, /永久删除/)

  const legacy = deliveryDeleteCopy(delivery({ kind: undefined }))
  assert.equal(legacy.confirm, '移入回收站')
  assert.match(legacy.body, /移到 NAS 回收站/)
  assert.doesNotMatch(legacy.body, /永久删除 NAS 文件/)
})

test('#159 勾选/全选/计数：单项切换、全选当前筛选、再次全选即清空', () => {
  const empty: ReadonlySet<string> = new Set()
  const one = toggleSelection(empty, 'job-a')
  assert.equal(one.size, 1)
  assert.equal(allVisibleSelected(one, ['job-a', 'job-b']), false)

  const all = toggleSelectAllVisible(one, ['job-a', 'job-b'])
  assert.deepEqual([...all].sort(), ['job-a', 'job-b'])
  assert.equal(allVisibleSelected(all, ['job-a', 'job-b']), true)
  assert.equal(allVisibleSelected(all, []), false)

  const cleared = toggleSelectAllVisible(all, ['job-a', 'job-b'])
  assert.equal(cleared.size, 0)
  assert.deepEqual([...toggleSelection(one, 'job-a')], [])
  assert.equal(toggleSelection(empty, 'job-a').has('job-a'), true)
})

test('#159 选择跨筛选/刷新：保留仍存在项，清理已消失项', () => {
  const kept = pruneSelection(new Set(['job-a', 'job-b', 'job-gone']), [
    { jobId: 'job-a' },
    { jobId: 'job-b' }
  ])
  assert.deepEqual([...kept].sort(), ['job-a', 'job-b'])

  const unchanged = new Set(['job-a'])
  assert.equal(pruneSelection(unchanged, [{ jobId: 'job-a' }]), unchanged)
  assert.equal(pruneSelection(unchanged, []).size, 0)
})

test('#159 批量确认：jobId 最多展开 10 条、其余折叠计数、总大小缺失按 0', () => {
  const items = Array.from({ length: 12 }, (_, index) =>
    delivery({ jobId: `job-${index}`, bytes: index === 0 ? null : 100 })
  )
  const summary = batchDeleteSummary(items)
  assert.equal(summary.jobIds.length, 12)
  assert.equal(summary.shown.length, 10)
  assert.equal(summary.extra, 2)
  assert.equal(summary.totalBytes, 1100)

  const copy = batchDeleteCopy(12)
  assert.match(copy.title, /永久删除 12 项 NAS 文件/)
  assert.match(copy.body, /永久删除 NAS 文件，不可恢复/)
})

test('#159 批量删除串行执行：部分失败保留失败项并给中文原因', async () => {
  const calls: string[] = []
  const remove = async (jobId: string): Promise<DeliveryTrashResponse> => {
    calls.push(jobId)
    if (jobId === 'job-b') throw new HttpError(503, 'NAS 只读')
    return { ok: true, jobId, movedTo: `.trash/deliveries/${jobId}`, bytes: 10, files: [] }
  }
  const results = await runBatchDelete(['job-a', 'job-b', 'job-c'], remove)
  assert.deepEqual(calls, ['job-a', 'job-b', 'job-c'])
  assert.equal(results.length, 3)
  assert.equal(results.filter((result) => result.ok).length, 2)
  assert.deepEqual([...failedSelection(results)], ['job-b'])

  const failure = results.find((result) => !result.ok)
  assert.ok(failure && !failure.ok)
  assert.match(failure.message, /功能未就绪（503）/)
  assert.doesNotMatch(failure.message, /English-only/)
})

test('#159 SSR：选中卡片渲染 checkbox（aria-label），交付页可服务端渲染', () => {
  const card = renderCard(delivery({ kind: 'image' }), true)
  assert.match(card, /data-testid="delivery-select-web-20261114031033-923549"/)
  assert.match(card, /aria-label="选择交付 b-1 · image · a"/)
  assert.match(card, /checked=""/)

  ;(globalThis as any).window ??= { location: { pathname: '/deliveries', search: '' } }
  const page = renderToStaticMarkup(
    createElement(RouterProvider, null, createElement(DeliveriesPage))
  )
  assert.match(page, /交付与资产/)
  assert.match(page, /正在读取交付/)
})
