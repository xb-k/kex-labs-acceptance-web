/**
 * #136 等待动效基础设施：
 * - useElapsed 时钟推进用 node:test fake timers（Date）+ SSR 首帧；
 * - AsyncStatusLine 用 react-dom/server 渲染（沿用 cover-keyframe.test.ts 做法，不引入 DOM 依赖）；
 * - postJson 透传 AbortSignal，取消必须真的 reject（不是只隐藏 UI）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { elapsedMilliseconds, formatElapsed, useElapsed } from './hooks'
import { AsyncStatusLine } from './components/ui'
import { isAbortError, postJson } from './api'
import { importAgent } from './agents'
import { IMAGE_WAIT_STAGES, imageWaitStage } from './image-workbench'

function ElapsedProbe({ startedAt }: { startedAt: number }) {
  return createElement('span', { 'data-testid': 'elapsed-probe' }, formatElapsed(useElapsed(startedAt)))
}

test('useElapsed：fake timers 下毫秒推进，格式化为 12.3s', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const startedAt = Date.now()
  assert.equal(elapsedMilliseconds(startedAt), 0)
  assert.equal(formatElapsed(0), '0.0s')

  t.mock.timers.tick(12_300)
  assert.equal(elapsedMilliseconds(startedAt), 12_300)
  assert.equal(formatElapsed(elapsedMilliseconds(startedAt)), '12.3s')
})

test('useElapsed：startedAt 为空返回 0，未来时间不出现负数', () => {
  assert.equal(elapsedMilliseconds(null), 0)
  assert.equal(elapsedMilliseconds(undefined), 0)
  assert.equal(elapsedMilliseconds(2_000, 1_000), 0)
  assert.equal(formatElapsed(Number.NaN), '0.0s')
})

test('useElapsed：首帧按 startedAt 计算（SSR）', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const html = renderToStaticMarkup(createElement(ElapsedProbe, { startedAt: 987_700 }))
  assert.match(html, /12\.3s/)
})

test('AsyncStatusLine：渲染文案 + 已用时长 + 阶段，动画可被 reduced-motion 关闭', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const html = renderToStaticMarkup(
    createElement(AsyncStatusLine, {
      testId: 'status',
      label: '正在生成剧本',
      startedAt: 987_700,
      stages: ['提交请求', '模型生成', '解析分场数据'],
      stage: 1,
      detail: '最长 60 秒',
      onCancel: () => {}
    })
  )
  assert.match(html, /正在生成剧本/)
  assert.match(html, /第 2\/3 步：模型生成/)
  assert.match(html, /已用 12\.3s/)
  assert.match(html, /data-testid="async-cancel"/)
  assert.match(html, /animate-pulse/)
  assert.match(html, /motion-reduce:animate-none/)
  assert.match(html, /aria-busy="true"/)

  const staticHtml = renderToStaticMarkup(
    createElement(AsyncStatusLine, {
      label: '正在生成剧本',
      startedAt: 987_700,
      stages: ['提交请求', '模型生成', '解析分场数据'],
      stage: 1,
      reducedMotion: true
    })
  )
  assert.doesNotMatch(staticHtml, /animate-pulse/)
  assert.match(staticHtml, /已用 12\.3s/)
  assert.match(staticHtml, /模型生成/)
  assert.match(staticHtml, /data-reduced-motion="true"/)
})

test('AsyncStatusLine：错误态显示后端文案 + 重试，不吞 llm_unavailable', () => {
  const html = renderToStaticMarkup(
    createElement(AsyncStatusLine, {
      label: '本地模型正在润色',
      startedAt: null,
      error: '本地模型不可用（llm_unavailable）',
      onRetry: () => {},
      onCancel: () => {}
    })
  )
  assert.match(html, /role="alert"/)
  assert.match(html, /llm_unavailable/)
  assert.match(html, /data-testid="async-retry"/)
  assert.match(html, /aria-busy="false"/)
  assert.doesNotMatch(html, /data-testid="async-cancel"/)
})

test('#136 图片等待失败态：渲染后端 error，不显示取消', () => {
  const failed = imageWaitStage('failed')
  const html = renderToStaticMarkup(
    createElement(AsyncStatusLine, {
      testId: 'image-wait-status',
      label: failed.label,
      startedAt: null,
      stages: IMAGE_WAIT_STAGES,
      stage: failed.stage,
      active: false,
      error: 'intake 返回 500',
      onCancel: () => {}
    })
  )
  assert.match(html, /图片生成失败/)
  assert.match(html, /第 3\/4 步：模型生成/)
  assert.match(html, /intake 返回 500/)
  assert.match(html, /role="alert"/)
  assert.doesNotMatch(html, /data-testid="async-cancel"/)
})

test('postJson：透传 AbortSignal，取消真的 reject（AbortError）', async () => {
  const originalFetch = globalThis.fetch
  let received: AbortSignal | undefined
  globalThis.fetch = ((_url: string, init?: RequestInit) => {
    received = init?.signal ?? undefined
    return new Promise((_resolve, reject) => {
      received?.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      })
    })
  }) as unknown as typeof fetch

  try {
    const controller = new AbortController()
    const pending = postJson('/api/gemini/script', { prompt: '测试' }, controller.signal)
    assert.equal(received, controller.signal)
    controller.abort()
    await assert.rejects(pending, (err) => isAbortError(err))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('AsyncStatusLine：终态用一次性 elapsedMs，停止呼吸动画并保留已用时长', () => {
  const html = renderToStaticMarkup(
    createElement(AsyncStatusLine, {
      testId: 'image-wait-status',
      label: '图片生成完成',
      startedAt: null,
      elapsedMs: 7_800,
      stages: ['提交请求', '排队等待', '模型生成', '完成'],
      stage: 3,
      active: false
    })
  )
  assert.match(html, /图片生成完成/)
  assert.match(html, /第 4\/4 步：完成/)
  assert.match(html, /已用 7\.8s/)
  assert.match(html, /aria-busy="false"/)
  assert.doesNotMatch(html, /animate-pulse/)
})

test('ImportDialog 等待行：busy 时显示阶段与可取消入口', () => {
  const html = renderToStaticMarkup(
    createElement(AsyncStatusLine, {
      testId: 'agent-import-status',
      label: '正在导入定义',
      startedAt: 1_000_000,
      stages: ['下载定义', '校验 license / 密钥', '写入新版本'],
      stage: 0,
      detail: '可在下方取消，取消会中断在途请求',
      onCancel: () => {}
    })
  )
  assert.match(html, /正在导入定义/)
  assert.match(html, /下载定义/)
  assert.match(html, /data-testid="async-cancel"/)
  assert.match(html, /取消/)
})

test('importAgent：取消导入时透传 AbortSignal，请求真的中断（AbortError）', async () => {
  const originalFetch = globalThis.fetch
  let received: AbortSignal | undefined
  globalThis.fetch = ((_url: string, init?: RequestInit) => {
    received = init?.signal ?? undefined
    return new Promise((_resolve, reject) => {
      received?.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      })
    })
  }) as unknown as typeof fetch

  try {
    const controller = new AbortController()
    const pending = importAgent(
      { type: 'skill', url: 'https://raw.githubusercontent.com/x/y/main/SKILL.md' },
      controller.signal
    )
    assert.equal(received, controller.signal)
    controller.abort()
    await assert.rejects(pending, (err) => isAbortError(err))
  } finally {
    globalThis.fetch = originalFetch
  }
})
