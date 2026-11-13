/**
 * #134 模板编辑件接线：
 * - PUT 保存 / DELETE 恢复的 method、URL、body 用 fetch mock 断言（不触网）；
 * - 抽屉用 react-dom/server 渲染（沿用 agent-library.test.ts 做法，不引 DOM 依赖），
 *   覆盖标题、override 标记与保存/恢复按钮。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ScriptTemplateEditorDrawer } from './components/production/ScriptTemplateEditorDrawer'
import { getScriptPromptTemplate } from './components/production/script-editor-utils'
import { restoreScriptTemplateDefault, saveScriptTemplateOverride } from './script-templates-client'
import type { ScriptPromptTemplateInfo } from './types'

const MARKETING: ScriptPromptTemplateInfo = {
  ...getScriptPromptTemplate('marketing'),
  source: 'override'
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

type FetchCall = { url: string; method: string; body: unknown; contentType: string | null }

/** 与 agent-library.test.ts 一致：临时替换 globalThis.fetch，用例结束复原。 */
function stubFetch(reply: (call: FetchCall) => Response): FetchCall[] {
  const calls: FetchCall[] = []
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    const call: FetchCall = {
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      contentType: headers['Content-Type'] ?? null
    }
    calls.push(call)
    return reply(call)
  }) as typeof fetch
  return calls
}

test('#134 保存调用走 PUT /api/script-templates/:id 并提交改动字段', async () => {
  const original = globalThis.fetch
  const calls = stubFetch(() => jsonResponse({ ok: true, item: { ...MARKETING, label: '新营销模板' } }))
  try {
    const res = await saveScriptTemplateOverride('marketing', { label: '新营销模板' })

    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, '/api/script-templates/marketing')
    assert.equal(calls[0].method, 'PUT')
    assert.equal(calls[0].contentType, 'application/json')
    assert.deepEqual(calls[0].body, { label: '新营销模板' })
    assert.equal(res.ok, true)
    assert.equal(res.item.label, '新营销模板')
  } finally {
    globalThis.fetch = original
  }
})

test('#134 恢复调用走 DELETE /api/script-templates/:id/override 且无 body', async () => {
  const original = globalThis.fetch
  const calls = stubFetch(() =>
    jsonResponse({ ok: true, item: { ...MARKETING, source: 'default' }, removed: true })
  )
  try {
    const res = await restoreScriptTemplateDefault('marketing')

    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, '/api/script-templates/marketing/override')
    assert.equal(calls[0].method, 'DELETE')
    assert.equal(calls[0].body, undefined)
    assert.equal(res.removed, true)
    assert.equal(res.item.source, 'default')
  } finally {
    globalThis.fetch = original
  }
})

test('#134 保存失败时抛出后端 error 文案（供抽屉显示失败提示）', async () => {
  const original = globalThis.fetch
  stubFetch(() => jsonResponse({ error: 'label: 超过 80 字上限' }, 400))
  try {
    await assert.rejects(
      saveScriptTemplateOverride('marketing', { label: 'x' }),
      /label: 超过 80 字上限/
    )
  } finally {
    globalThis.fetch = original
  }
})

test('#134 抽屉打开后渲染标题、override 标记与保存/恢复按钮，且默认非 override 时禁用恢复', () => {
  const overrideHtml = renderToStaticMarkup(
    createElement(ScriptTemplateEditorDrawer, {
      template: MARKETING,
      onClose: () => {},
      onSaved: () => {}
    })
  )
  assert.match(overrideHtml, /data-testid="script-template-editor-drawer"/)
  assert.match(overrideHtml, /编辑模板 · 营销/)
  assert.match(overrideHtml, /data-testid="script-template-editor-source"[^>]*>已自定义/)
  assert.match(overrideHtml, /data-testid="script-template-save-btn"/)
  assert.match(overrideHtml, /data-testid="script-template-restore-btn"/)
  // override 时恢复按钮可用（无 disabled 布尔属性）。
  assert.doesNotMatch(overrideHtml, /<button type="button" disabled="" data-testid="script-template-restore-btn"/)

  const defaultHtml = renderToStaticMarkup(
    createElement(ScriptTemplateEditorDrawer, {
      template: { ...MARKETING, source: 'default' },
      onClose: () => {},
      onSaved: () => {}
    })
  )
  assert.match(defaultHtml, /内置默认/)
  assert.match(defaultHtml, /<button type="button" disabled="" data-testid="script-template-restore-btn"/)
})
