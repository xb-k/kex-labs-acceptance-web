import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  DeliveryCard,
  deliveryDeleteCopy,
  deliveryImageSrc,
  deliveryIsImage
} from './pages/DeliveriesPage'
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

function renderCard(item: Delivery): string {
  // SSR 无浏览器全局：RouterProvider 初始化只读 window.location（effect 不执行）。
  ;(globalThis as any).window ??= { location: { pathname: '/deliveries', search: '' } }
  return renderToStaticMarkup(
    createElement(RouterProvider, null, createElement(DeliveryCard, { item, onDeleted: noop }))
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
