/**
 * #137 提示词模板 UI 契约测试：
 * - 列表 / 保存 v1 / 追加新版本 / 载入指定版本 / 删除 / validate 用 fetch mock 断言
 *   method、URL、body，不触网；
 * - 引用失效、版本选项、错误文案用纯函数断言；
 * - 列表、引用徽标、加载态用 react-dom/server 渲染（沿用 pose-library.test.ts 做法）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { HttpError } from './api'
import {
  appendPromptPresetVersion,
  createPromptPreset,
  deletePromptPreset,
  formatPromptPresetError,
  listPromptPresets,
  loadPromptPresetVersion,
  promptPresetReferenceIssue,
  promptPresetVersionOptions,
  validatePromptPresetReference,
  validatePresetName,
  validatePresetPrompt,
  type PromptPresetReference,
  type PromptPresetSummary
} from './prompt-presets'
import {
  PromptPresetList,
  PromptPresetReferenceBadge,
  PromptPresetsPanel
} from './components/studio/PromptPresetsPanel'

const PRESET: PromptPresetSummary = {
  id: 'preset_00000000-0000-4000-8000-000000000001',
  name: '清晨咖啡',
  current_version: 2,
  versions_count: 2,
  created_at: '2026-11-14T01:00:00.000Z',
  updated_at: '2026-11-14T02:00:00.000Z',
  current: {
    version: 2,
    prompt: '清晨自然光，突出手冲与拉花',
    params: {},
    note: '加强光',
    created_at: '2026-11-14T02:00:00.000Z'
  }
}

const REFERENCE: PromptPresetReference = {
  presetId: PRESET.id,
  name: PRESET.name,
  version: 1
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

type FetchCall = { url: string; method: string; body: unknown; contentType: string | null }

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

async function withFetch<T>(reply: (call: FetchCall) => Response, run: (calls: FetchCall[]) => Promise<T>) {
  const original = globalThis.fetch
  const calls = stubFetch(reply)
  try {
    return await run(calls)
  } finally {
    globalThis.fetch = original
  }
}

const html = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element)

// ---------------------------------------------------------------------------
// API 接线
// ---------------------------------------------------------------------------

test('#137 列表：GET /api/prompt-presets 返回 items/total', async () => {
  await withFetch(
    () => jsonResponse({ items: [PRESET], total: 1 }),
    async (calls) => {
      const result = await listPromptPresets()
      assert.equal(calls.length, 1)
      assert.equal(calls[0].url, '/api/prompt-presets')
      assert.equal(calls[0].method, 'GET')
      assert.equal(result.total, 1)
      assert.equal(result.items[0].name, '清晨咖啡')
    }
  )
})

test('#137 保存：POST /api/prompt-presets 提交 name / prompt / params / note', async () => {
  await withFetch(
    () => jsonResponse({ item: PRESET, version: PRESET.current }, 201),
    async (calls) => {
      const result = await createPromptPreset({
        name: '清晨咖啡',
        prompt: '清晨自然光，突出手冲与拉花'
      })
      assert.equal(calls.length, 1)
      assert.equal(calls[0].url, '/api/prompt-presets')
      assert.equal(calls[0].method, 'POST')
      assert.equal(calls[0].contentType, 'application/json')
      assert.deepEqual(calls[0].body, {
        name: '清晨咖啡',
        prompt: '清晨自然光，突出手冲与拉花',
        params: {},
        note: ''
      })
      assert.equal(result.item.current_version, 2)
    }
  )
})

test('#137 新版本：PUT /api/prompt-presets/:id，note 为空也提交空串', async () => {
  await withFetch(
    () => jsonResponse({ item: PRESET, version: PRESET.current }),
    async (calls) => {
      const result = await appendPromptPresetVersion(PRESET.id, {
        prompt: '新的提示词',
        note: '加强光'
      })
      assert.equal(calls.length, 1)
      assert.equal(calls[0].url, `/api/prompt-presets/${PRESET.id}`)
      assert.equal(calls[0].method, 'PUT')
      assert.deepEqual(calls[0].body, {
        prompt: '新的提示词',
        params: {},
        note: '加强光'
      })
      assert.equal(result.item.id, PRESET.id)
    }
  )
})

test('#137 载入版本：GET /api/prompt-presets/:id?version=N 返回指定版本', async () => {
  await withFetch(
    () => jsonResponse({ item: PRESET, version: PRESET.current, is_current: true }),
    async (calls) => {
      const result = await loadPromptPresetVersion(PRESET.id, 1)
      assert.equal(calls.length, 1)
      assert.equal(calls[0].url, `/api/prompt-presets/${PRESET.id}?version=1`)
      assert.equal(calls[0].method, 'GET')
      assert.equal(result.version.version, 2)
      assert.equal(result.is_current, true)
    }
  )
})

test('#137 删除：DELETE /api/prompt-presets/:id 无 body', async () => {
  await withFetch(
    () => jsonResponse({ ok: true, item: PRESET }),
    async (calls) => {
      const result = await deletePromptPreset(PRESET.id)
      assert.equal(calls.length, 1)
      assert.equal(calls[0].url, `/api/prompt-presets/${PRESET.id}`)
      assert.equal(calls[0].method, 'DELETE')
      assert.equal(calls[0].body, undefined)
      assert.equal(result.ok, true)
    }
  )
})

test('#137 生成前 validate：POST /:id/validate 带 version；失败原样抛服务端 error', async () => {
  await withFetch(
    (call) =>
      call.url.endsWith('/validate')
        ? jsonResponse({ error: 'preset_version_not_found' }, 400)
        : jsonResponse({ ok: true }),
    async (calls) => {
      await assert.rejects(
        validatePromptPresetReference(PRESET.id, 9),
        /preset_version_not_found/
      )
      assert.equal(calls[0].url, `/api/prompt-presets/${PRESET.id}/validate`)
      assert.equal(calls[0].method, 'POST')
      assert.deepEqual(calls[0].body, { version: 9 })
    }
  )
})

// ---------------------------------------------------------------------------
// 纯函数：引用失效 / 版本选项 / 校验 / 错误文案
// ---------------------------------------------------------------------------

test('#137 引用失效：模板被删或版本越界明确返回原因，合法引用返回 null', () => {
  assert.equal(promptPresetReferenceIssue(null, [PRESET]), null)
  assert.equal(promptPresetReferenceIssue(REFERENCE, [PRESET]), null)
  assert.equal(promptPresetReferenceIssue(REFERENCE, []), '模板已被删除')
  assert.equal(
    promptPresetReferenceIssue({ ...REFERENCE, version: 3 }, [PRESET]),
    '版本 v3 不存在（当前共 2 版）'
  )
  assert.equal(
    promptPresetReferenceIssue({ ...REFERENCE, version: 0 }, [PRESET]),
    '版本 v0 不存在（当前共 2 版）'
  )
})

test('#137 版本选项：按 versions_count 生成 v1..vN，上限 50', () => {
  assert.deepEqual(promptPresetVersionOptions({ versions_count: 3 }), [1, 2, 3])
  assert.equal(promptPresetVersionOptions({ versions_count: 999 }).length, 50)
})

test('#137 前端预校验：模板名 1..60 字、提示词非空且 ≤8000 字', () => {
  assert.match(validatePresetName('  ') ?? '', /不能为空/)
  assert.match(validatePresetName('a'.repeat(61)) ?? '', /最多 60 字/)
  assert.equal(validatePresetName('清晨咖啡'), null)
  assert.match(validatePresetPrompt('  ') ?? '', /为空/)
  assert.match(validatePresetPrompt('x'.repeat(8001)) ?? '', /最多 8000 字/)
  assert.equal(validatePresetPrompt('短提示词'), null)
})

test('#137 服务端错误原样保留状态码与 error code，并附中文提示', () => {
  assert.equal(
    formatPromptPresetError(new HttpError(409, 'duplicate_name', { error: 'duplicate_name' })),
    '409 duplicate_name（模板名已存在（大小写与空白归一后比较））'
  )
  assert.equal(
    formatPromptPresetError(
      new HttpError(400, 'preset_version_not_found', { error: 'preset_version_not_found' })
    ),
    '400 preset_version_not_found（指定版本不存在）'
  )
  assert.equal(
    formatPromptPresetError(new HttpError(409, 'version_limit', { error: 'version_limit' })),
    '409 version_limit（每个模板最多 50 个版本）'
  )
  assert.equal(formatPromptPresetError(new HttpError(418, 'teapot', null)), '418 teapot')
  assert.equal(formatPromptPresetError(new Error('网络中断')), '网络中断')
})

// ---------------------------------------------------------------------------
// SSR
// ---------------------------------------------------------------------------

test('#137 SSR 列表：名称 / 当前版本 / 更新时间 / v1..vN 下拉 / 载入 / 存为新版本 / 删除', () => {
  const markup = html(
    createElement(PromptPresetList, { items: [PRESET], reference: REFERENCE })
  )
  assert.match(markup, /data-testid="prompt-preset-list"/)
  assert.match(markup, /data-testid="prompt-preset-row"/)
  assert.match(markup, /清晨咖啡/)
  assert.match(markup, /v2 · 共 2 版 · 更新/)
  assert.match(markup, /<option value="1">v1<\/option>/)
  assert.match(markup, /<option value="2" selected="">v2（当前）<\/option>/)
  assert.match(markup, /data-testid="prompt-preset-load"/)
  assert.match(markup, /data-testid="prompt-preset-append"/)
  assert.match(markup, /data-testid="prompt-preset-delete"/)
  assert.match(markup, /data-testid="prompt-preset-row-reference"[^>]*>清晨咖啡@v1</)
})

test('#137 SSR 引用失效：明确显示「引用失效」与原因，并保留解除引用按钮', () => {
  const markup = html(
    createElement(PromptPresetReferenceBadge, {
      reference: REFERENCE,
      issue: '模板已被删除',
      onClear: () => {}
    })
  )
  assert.match(markup, /data-testid="prompt-preset-reference"/)
  assert.match(markup, /清晨咖啡@v1/)
  assert.match(markup, /data-testid="prompt-preset-reference-invalid"[^>]*>引用失效 · 模板已被删除/)
  assert.match(markup, /data-testid="prompt-preset-reference-clear"/)
})

test('#137 SSR 面板：标题 / 模板名输入 / 保存按钮 / 加载状态', () => {
  const markup = html(
    createElement(PromptPresetsPanel, {
      prompt: '当前提示词',
      reference: null,
      onReferenceChange: () => {},
      onApplyPrompt: () => {}
    })
  )
  assert.match(markup, /data-testid="prompt-presets"/)
  assert.match(markup, /提示词模板/)
  assert.match(markup, /data-testid="prompt-preset-name"/)
  assert.match(markup, /data-testid="prompt-preset-save"/)
  assert.match(markup, /保存当前提示词为模板/)
  assert.match(markup, /data-testid="prompt-preset-loading"/)
  // 面板嵌在 A 轨制片 <form> 内：自带 <form> 会触发浏览器原生提交、整页刷新（线上回归）。
  assert.doesNotMatch(markup, /<form/)
})
