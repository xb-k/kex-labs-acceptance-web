/**
 * #138 姿态参考库 UI 契约测试：
 * - 查询 URL / 前端预校验 / 标签解析（纯函数）；
 * - 列表、空态、筛选空态、加载态用 react-dom/server（沿用 agent-library.test.ts 做法，不引 DOM）；
 * - 添加成功 / 400 license_unverified / 409 duplicate / 删除 / 鉴权失败用 fetch mock，不触网。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { HttpError } from './api'
import {
  EMPTY_POSE_DRAFT,
  buildPoseLibraryQuery,
  buildPoseVideoPayload,
  createPoseEntry,
  formatPoseError,
  formatPoseSyncStatus,
  getPoseSyncStatus,
  listPoseEntries,
  materializePoseEntry,
  parsePoseTags,
  poseUsageFromMaterialize,
  removePoseEntry,
  runPoseSync,
  validatePoseDraft,
  type PoseLibraryItem,
  type PosePayload,
  type PoseSyncResult,
  type PoseUsage
} from './pose-library'
import {
  PoseAddDialog,
  PoseLibraryEmpty,
  PoseLibraryGrid,
  PoseLibraryPanel,
  PoseSyncBar
} from './components/studio/PoseLibraryPanel'

const ITEM: PoseLibraryItem = {
  id: 'pose_00000000-0000-4000-8000-000000000001',
  label_zh: '单人侧身站立',
  preview_url: null,
  source_url: 'https://posemaniacs.com/pose/standing',
  license: 'CC-BY-4.0',
  license_evidence_url: 'https://posemaniacs.com/terms',
  license_verified: true,
  suitable_shots: ['full_body', 'wide'],
  tags: ['站立', '侧面'],
  created_at: '2026-11-14T00:00:00.000Z'
}

const VALID_DRAFT = {
  ...EMPTY_POSE_DRAFT,
  label_zh: '单人侧身站立',
  source_url: 'https://posemaniacs.com/pose/standing',
  license: 'CC-BY-4.0' as const,
  license_evidence_url: 'https://posemaniacs.com/terms',
  suitable_shots: ['full_body' as const],
  tags: '站立，侧面, 站立'
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

type FetchCall = { url: string; method: string; body: unknown }

function stubFetch(reply: (call: FetchCall) => Response): FetchCall[] {
  const calls: FetchCall[] = []
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const call: FetchCall = {
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined
    }
    calls.push(call)
    return reply(call)
  }) as typeof fetch
  return calls
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

test('#138 查询 URL：空筛选只带分页，筛选值做 URL 编码', () => {
  assert.equal(
    buildPoseLibraryQuery({ q: '', license: '', shot: '' }),
    '/api/pose-library?limit=24&offset=0'
  )
  const url = buildPoseLibraryQuery({ q: ' 站立 ', license: 'CC-BY-4.0', shot: 'full_body' })
  assert.match(url, /^\/api\/pose-library\?/)
  const params = new URL(url, 'https://x.test').searchParams
  assert.equal(params.get('q'), '站立')
  assert.equal(params.get('license'), 'CC-BY-4.0')
  assert.equal(params.get('shot'), 'full_body')
  assert.equal(params.get('limit'), '24')
  assert.equal(params.get('offset'), '0')
})

test('#138 标签：中英文逗号都切分、去重，超过 10 个报 tooMany', () => {
  assert.deepEqual(parsePoseTags('站立，侧面,站立, ,全身').tags, ['站立', '侧面', '全身'])
  const many = Array.from({ length: 11 }, (_, i) => `t${i}`).join(',')
  assert.equal(parsePoseTags(many).tooMany, true)
})

test('#138 预校验：合法输入产出服务端 payload（license_verified 由服务端派生）', () => {
  const result = validatePoseDraft(VALID_DRAFT)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.payload, {
    label_zh: '单人侧身站立',
    source_url: 'https://posemaniacs.com/pose/standing',
    license: 'CC-BY-4.0',
    license_evidence_url: 'https://posemaniacs.com/terms',
    preview_url: null,
    suitable_shots: ['full_body'],
    tags: ['站立', '侧面']
  })
  assert.equal('license_verified' in result.payload, false)
})

test('#138 预校验：http、非中文标签、缺 license / 证据、非法预览图、标签超限都拦下', () => {
  const http = validatePoseDraft({ ...VALID_DRAFT, source_url: 'http://posemaniacs.com/' })
  assert.equal(http.ok, false)
  if (!http.ok) assert.match(http.errors.source_url ?? '', /https/)

  const ascii = validatePoseDraft({ ...VALID_DRAFT, label_zh: 'standing pose' })
  assert.equal(ascii.ok, false)
  if (!ascii.ok) assert.match(ascii.errors.label_zh ?? '', /汉字/)

  const noLicense = validatePoseDraft({ ...VALID_DRAFT, license: '' })
  assert.equal(noLicense.ok, false)
  if (!noLicense.ok) assert.match(noLicense.errors.license ?? '', /license/)

  const noEvidence = validatePoseDraft({ ...VALID_DRAFT, license_evidence_url: '' })
  assert.equal(noEvidence.ok, false)
  if (!noEvidence.ok) assert.match(noEvidence.errors.license_evidence_url ?? '', /授权证据/)

  const protocolRelative = validatePoseDraft({ ...VALID_DRAFT, preview_url: '//cdn.example.com/p.jpg' })
  assert.equal(protocolRelative.ok, false)
  if (!protocolRelative.ok) assert.match(protocolRelative.errors.preview_url ?? '', /预览图/)

  const tagsTooMany = validatePoseDraft({
    ...VALID_DRAFT,
    tags: Array.from({ length: 11 }, (_, i) => `t${i}`).join(',')
  })
  assert.equal(tagsTooMany.ok, false)
  if (!tagsTooMany.ok) assert.match(tagsTooMany.errors.tags ?? '', /最多 10 个/)
})

test('#138 服务端错误：原样保留状态码与 error code，并附中文提示', () => {
  assert.equal(
    formatPoseError(new HttpError(400, 'license_unverified', { error: 'license_unverified' })),
    '400 license_unverified（license 与授权证据链接必须齐全）'
  )
  assert.equal(
    formatPoseError(new HttpError(409, 'duplicate_source_url', { error: 'duplicate_source_url' })),
    '409 duplicate_source_url（该来源已在库中，换个来源或先删除旧条目）'
  )
  assert.equal(
    formatPoseError(new HttpError(401, 'invalid X-Web-Token', { error: 'invalid X-Web-Token' })),
    '401 invalid X-Web-Token（鉴权失败：X-Web-Token 不正确）'
  )
  assert.equal(formatPoseError(new HttpError(418, 'teapot', null)), '418 teapot')
  assert.equal(formatPoseError(new Error('网络中断')), '网络中断')
})

// ---------------------------------------------------------------------------
// SSR：列表 / 空态 / 加载态
// ---------------------------------------------------------------------------

const html = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element)

test('#138 SSR 列表：中文标签 / license 徽标 / 适用镜头 / 来源新窗 / 复制 ID / 删除', () => {
  const markup = html(createElement(PoseLibraryGrid, { items: [ITEM] }))
  assert.match(markup, /data-testid="pose-grid"/)
  assert.match(markup, /单人侧身站立/)
  assert.match(markup, /data-testid="pose-license-badge"[^>]*data-verified="true"[^>]*>已核/)
  assert.match(markup, /CC-BY-4.0/)
  assert.match(markup, /data-testid="pose-shots"[\s\S]*全身[\s\S]*远景/)
  assert.match(markup, /data-testid="pose-source-link"/)
  assert.match(markup, /href="https:\/\/posemaniacs\.com\/pose\/standing"/)
  assert.match(markup, /target="_blank"/)
  assert.match(markup, /rel="noreferrer noopener"/)
  assert.match(markup, /data-testid="pose-copy-id"/)
  assert.match(markup, /aria-label="复制引用 ID pose_00000000/)
  assert.match(markup, /data-testid="pose-delete"/)
  assert.match(markup, /无预览图/)
})

test('#138 SSR 未核条目显示「未核」徽标', () => {
  const markup = html(
    createElement(PoseLibraryGrid, { items: [{ ...ITEM, license_verified: false }] })
  )
  assert.match(markup, /data-testid="pose-license-badge"[^>]*data-verified="false"[^>]*>未核/)
})

test('#138 SSR 空态：尚未收录，添加时需提供 license 证据', () => {
  const markup = html(createElement(PoseLibraryEmpty, { filtered: false }))
  assert.match(markup, /data-testid="pose-empty"/)
  assert.match(markup, /尚未收录，添加时需提供 license 证据/)
  assert.match(markup, /license 与授权证据链接（https）/)
})

test('#138 SSR 筛选空态：没有匹配的条目 + 清除筛选', () => {
  const markup = html(createElement(PoseLibraryEmpty, { filtered: true }))
  assert.match(markup, /没有匹配的条目/)
  assert.match(markup, /清除筛选/)
  assert.doesNotMatch(markup, /尚未收录/)
})

test('#138 SSR 面板：标题、添加入口、筛选控件与加载状态可渲染（无 window 依赖）', () => {
  const markup = html(createElement(PoseLibraryPanel, {}))
  assert.match(markup, /data-testid="pose-library"/)
  assert.match(markup, /姿态参考库/)
  assert.match(markup, /data-testid="pose-add-open"/)
  assert.match(markup, /data-testid="pose-search"/)
  assert.match(markup, /data-testid="pose-filter-license"/)
  assert.match(markup, /data-testid="pose-filter-shot"/)
  assert.match(markup, /data-testid="pose-loading"/)
  assert.match(markup, /正在加载姿态参考库/)
})

// ---------------------------------------------------------------------------
// 调用语义（fetch mock）
// ---------------------------------------------------------------------------

test('#138 添加成功：POST /api/pose-library 提交 payload 并返回条目', async () => {
  const original = globalThis.fetch
  const calls = stubFetch(() => jsonResponse({ item: ITEM }, 201))
  try {
    const payload: PosePayload = {
      label_zh: ITEM.label_zh,
      source_url: ITEM.source_url,
      license: ITEM.license,
      license_evidence_url: ITEM.license_evidence_url,
      preview_url: null,
      suitable_shots: ['full_body', 'wide'],
      tags: ['站立', '侧面']
    }
    const item = await createPoseEntry(payload)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, '/api/pose-library')
    assert.equal(calls[0].method, 'POST')
    assert.deepEqual(calls[0].body, payload)
    assert.equal(item.id, ITEM.id)
  } finally {
    globalThis.fetch = original
  }
})

test('#138 添加 400：license_unverified 原样抛给弹窗', async () => {
  const original = globalThis.fetch
  stubFetch(() => jsonResponse({ error: 'license_unverified' }, 400))
  try {
    const checked = validatePoseDraft(VALID_DRAFT)
    assert.equal(checked.ok, true)
    if (!checked.ok) return
    await assert.rejects(
      () => createPoseEntry(checked.payload),
      (err: unknown) => {
        assert.ok(err instanceof HttpError)
        assert.equal(err.status, 400)
        assert.equal(err.message, 'license_unverified')
        assert.equal(formatPoseError(err), '400 license_unverified（license 与授权证据链接必须齐全）')
        return true
      }
    )
  } finally {
    globalThis.fetch = original
  }
})

test('#138 添加 409：重复 source_url 原样展示', async () => {
  const original = globalThis.fetch
  stubFetch(() => jsonResponse({ error: 'duplicate_source_url' }, 409))
  try {
    const checked = validatePoseDraft(VALID_DRAFT)
    assert.equal(checked.ok, true)
    if (!checked.ok) return
    await assert.rejects(
      () => createPoseEntry(checked.payload),
      (err: unknown) => {
        assert.ok(err instanceof HttpError)
        assert.equal(err.status, 409)
        assert.equal(formatPoseError(err), '409 duplicate_source_url（该来源已在库中，换个来源或先删除旧条目）')
        return true
      }
    )
  } finally {
    globalThis.fetch = original
  }
})

test('#138 列表：GET 走筛选 URL（含 q / license / shot）', async () => {
  const original = globalThis.fetch
  const calls = stubFetch(() => jsonResponse({ items: [ITEM], total: 1 }))
  try {
    const res = await listPoseEntries({ q: '站立', license: 'CC-BY-4.0', shot: 'full_body' })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'GET')
    const params = new URL(calls[0].url, 'https://x.test').searchParams
    assert.equal(params.get('q'), '站立')
    assert.equal(params.get('license'), 'CC-BY-4.0')
    assert.equal(params.get('shot'), 'full_body')
    assert.equal(res.total, 1)
  } finally {
    globalThis.fetch = original
  }
})

test('#138 删除：DELETE /api/pose-library/:id；401 鉴权失败可区分', async () => {
  const original = globalThis.fetch
  const calls = stubFetch(() => jsonResponse({ ok: true, item: ITEM }))
  try {
    await removePoseEntry(ITEM.id)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, `/api/pose-library/${ITEM.id}`)
    assert.equal(calls[0].method, 'DELETE')
  } finally {
    globalThis.fetch = original
  }

  const authCalls = stubFetch(() => jsonResponse({ error: 'invalid X-Web-Token' }, 401))
  try {
    await assert.rejects(
      () => removePoseEntry(ITEM.id),
      (err: unknown) => {
        assert.ok(err instanceof HttpError)
        assert.equal(err.status, 401)
        assert.equal(formatPoseError(err), '401 invalid X-Web-Token（鉴权失败：X-Web-Token 不正确）')
        return true
      }
    )
    assert.equal(authCalls.length, 1)
  } finally {
    globalThis.fetch = original
  }
})

// ---------------------------------------------------------------------------
// #138 回归：下拉统一 / 窄栏溢出（SSR 类名契约）
// ---------------------------------------------------------------------------

test('#138 筛选下拉统一用 SelectMenu：没有原生 select，保留 aria/testId/size', () => {
  const markup = html(createElement(PoseLibraryPanel, {}))
  assert.doesNotMatch(markup, /<select[\s>]/)
  for (const [testId, label] of [
    ['pose-filter-license', '按 license 筛选'],
    ['pose-filter-shot', '按适用镜头筛选']
  ] as const) {
    const trigger = markup.match(new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`))?.[0]
    assert.ok(trigger, `${testId} 触发器应渲染为 SelectMenu 的 button`)
    assert.match(trigger, /role="combobox"/)
    assert.match(trigger, /aria-haspopup="listbox"/)
    assert.match(trigger, /aria-expanded="false"/)
    assert.match(trigger, new RegExp(`aria-label="${label}"`))
    assert.match(trigger, /data-select-size="sm"/)
    const box = markup.match(new RegExp(`<div[^>]*min-w-\\[132px\\][^>]*>(?=[\\s\\S]*data-testid="${testId}")`))?.[0]
    assert.ok(box, `${testId} 外层需限制最小宽度`)
  }
})

test('#138 添加弹窗 License 用 SelectMenu（md + 占位「选择协议」），错误行保留', () => {
  const markup = html(
    createElement(PoseAddDialog, { open: true, onClose: () => {}, onCreated: () => {} })
  )
  assert.doesNotMatch(markup, /<select[\s>]/)
  const trigger = markup.match(/<button[^>]*data-testid="pose-add-license"[^>]*>/)?.[0]
  assert.ok(trigger)
  assert.match(trigger, /id="pose-add-license"/)
  assert.match(trigger, /role="combobox"/)
  assert.match(trigger, /data-select-size="md"/)
  assert.match(markup, /选择协议/)
})

test('#138 卡片窄栏不溢出：min-w-0/overflow-hidden/break-all/break-words', () => {
  const long = {
    ...ITEM,
    preview_url: 'https://cdn.example.com/previews/' + 'x'.repeat(120) + '.jpg',
    source_url: 'https://example.com/' + 'very-long-path-segment/'.repeat(8),
    tags: ['标签'.repeat(30), 'a'.repeat(80)]
  } as PoseLibraryItem
  const markup = html(createElement(PoseLibraryGrid, { items: [long] }))
  assert.match(markup, /<article class="[^"]*min-w-0[^"]*overflow-hidden[^"]*" data-testid="pose-card"/)
  assert.match(markup, /<span class="[^"]*break-all[^"]*" data-testid="pose-source-url"/)
  assert.match(markup, /class="num max-w-\[50%\] shrink-0 truncate[^"]*">CC-BY-4\.0</)
  assert.match(markup, /<div class="[^"]*flex-wrap[^"]*" data-testid="pose-shots"/)
  assert.match(markup, /<p class="[^"]*break-words[^"]*">#/)
  assert.match(markup, /loading="lazy"/)
})

test('#138 grid 断点：默认两列、lg 三列、2xl 四列、紧凑间距', () => {
  const markup = html(createElement(PoseLibraryGrid, { items: [ITEM] }))
  assert.match(markup, /class="grid min-w-0 grid-cols-2 gap-2.5 lg:grid-cols-3 2xl:grid-cols-4" data-testid="pose-grid"/)
  assert.doesNotMatch(markup, /(^|[\s"])sm:grid-cols-2|(^|[\s"])xl:grid-cols-3/)
})

test('#138 卡片预览区固定高度：h-28/sm:h-32、图片 object-cover、占位同高', () => {
  const withPreview = html(
    createElement(PoseLibraryGrid, {
      items: [{ ...ITEM, preview_url: 'https://cdn.example.com/previews/pose.jpg' }]
    })
  )
  assert.match(
    withPreview,
    /<div class="relative h-28 w-full overflow-hidden bg-\[#F2F2F5\] sm:h-32" data-testid="pose-preview"/
  )
  assert.doesNotMatch(withPreview, /aspect-\[4\/3\]/)
  assert.match(withPreview, /class="h-full w-full object-cover"/)

  const withoutPreview = html(createElement(PoseLibraryGrid, { items: [{ ...ITEM, preview_url: null }] }))
  assert.match(withoutPreview, /data-testid="pose-preview"/)
  assert.match(withoutPreview, /<div class="flex h-full w-full flex-col items-center justify-center[^"]*">/)
  assert.match(withoutPreview, /无预览图/)
})

test('#138 用作参考图按钮：无预览图禁用，有预览图可点', () => {
  const withoutPreview = html(
    createElement(PoseLibraryGrid, { items: [{ ...ITEM, preview_url: null }], onUse: () => {} })
  )
  assert.match(withoutPreview, /disabled=""[^>]*data-testid="pose-use"/)
  assert.match(withoutPreview, /title="无预览图"/)

  const withPreview = html(
    createElement(PoseLibraryGrid, {
      items: [{ ...ITEM, preview_url: 'https://cdn.example.com/previews/pose.jpg' }],
      onUse: () => {}
    })
  )
  assert.match(withPreview, /data-testid="pose-use"/)
  assert.doesNotMatch(withPreview, /disabled=""[^>]*data-testid="pose-use"|data-testid="pose-use"[^>]*disabled=""/)
  assert.match(withPreview, /aria-label="用作参考图 单人侧身站立"/)
})

// ---------------------------------------------------------------------------
// #138 增强：从 GitHub 同步（状态行 / 按钮 / API 契约）
// ---------------------------------------------------------------------------

const SYNC_RESULT: PoseSyncResult = {
  at: '2026-11-14T02:30:00.000Z',
  imported: 12,
  skipped: 3,
  errors: [{ at: '2026-11-14T02:30:00.000Z', stage: 'tree', error: 'http_404', repo: 'a/b' }],
  repos: [
    { repo: 'acme/awesome-poses', stars: 1200, license: 'MIT', imported: 12, skipped: 0, reason: null }
  ],
  rate_limit: { limited: false, status: null, remaining: 42, auth: 'anonymous' },
  skip_reasons: { duplicate_source_url: 3 }
}

test('#138 同步状态文案：未同步 / 上次时间 + 导入 + 跳过 + 错误数', () => {
  assert.equal(formatPoseSyncStatus(null), '尚未同步')
  const text = formatPoseSyncStatus(SYNC_RESULT)
  assert.match(text, /^上次同步 2026-11-14 \d{2}:\d{2}/)
  assert.match(text, /导入 12/)
  assert.match(text, /跳过 3/)
  assert.match(text, /错误 1/)
})

test('#138 SSR 同步状态行：状态 + 「从 GitHub 同步」按钮；busy 时禁用并显示「同步中…」', () => {
  const idle = html(createElement(PoseSyncBar, { status: SYNC_RESULT, busy: false, error: null, onSync: () => {} }))
  assert.match(idle, /data-testid="pose-sync-bar"/)
  assert.match(idle, /data-testid="pose-sync-status"[^>]*>上次同步 2026-11-14/)
  assert.match(idle, /data-testid="pose-sync-status"[^>]*>[^<]*导入 12/)
  assert.match(idle, /data-testid="pose-sync-button"/)
  assert.match(idle, />从 GitHub 同步</)
  assert.doesNotMatch(idle, /data-testid="pose-sync-button"[^>]*disabled=""/)

  const busy = html(createElement(PoseSyncBar, { status: null, busy: true, error: '同步失败：429', onSync: () => {} }))
  assert.match(busy, /data-testid="pose-sync-status"[^>]*>尚未同步/)
  assert.match(busy, /data-testid="pose-sync-button"[^>]*disabled/)
  assert.match(busy, />同步中…</)
  assert.match(busy, /data-testid="pose-sync-error"[^>]*>同步失败：429/)
})

test('#138 SSR 面板顶部包含同步状态行与按钮', () => {
  const markup = html(createElement(PoseLibraryPanel, {}))
  assert.match(markup, /data-testid="pose-sync-bar"/)
  assert.match(markup, /data-testid="pose-sync-status"[^>]*>尚未同步/)
  assert.match(markup, /data-testid="pose-sync-button"/)
  assert.match(markup, />从 GitHub 同步</)
})

test('#138 同步 API：GET sync-status / POST 同步（force 透传）', async () => {
  const original = globalThis.fetch
  const calls = stubFetch(() => jsonResponse(SYNC_RESULT))
  try {
    const status = await getPoseSyncStatus()
    assert.equal(status.imported, 12)
    assert.equal(calls[0].url, '/api/pose-library/sync-status')
    assert.equal(calls[0].method, 'GET')

    await runPoseSync()
    assert.equal(calls[1].url, '/api/pose-library/sync')
    assert.equal(calls[1].method, 'POST')
    assert.deepEqual(calls[1].body, {})

    await runPoseSync(true)
    assert.deepEqual(calls[2].body, { force: true })
  } finally {
    globalThis.fetch = original
  }

  const authCalls = stubFetch(() => jsonResponse({ error: 'github_rate_limited' }, 429))
  try {
    await assert.rejects(
      () => runPoseSync(true),
      (err: unknown) => {
        assert.ok(err instanceof HttpError)
        assert.equal(err.status, 429)
        assert.equal(
          formatPoseError(err),
          '429 github_rate_limited（GitHub 已限速，可配置 GITHUB_TOKEN 后重试）'
        )
        return true
      }
    )
    assert.equal(authCalls.length, 1)
  } finally {
    globalThis.fetch = original
  }
})

test('#138 materialize 成功：POST 端点并映射为参考图三件套', async () => {
  const original = globalThis.fetch
  const result = {
    upload_id: 'up_pose_00000000',
    filename: 'pose-standing.png',
    size: 2048,
    sha256: 'a'.repeat(64),
    studio_path: '/kex-repo/uploads/pose-standing.png'
  }
  const calls = stubFetch(() => jsonResponse(result))
  try {
    const materialized = await materializePoseEntry(ITEM.id)
    assert.equal(calls[0].url, `/api/pose-library/${ITEM.id}/materialize`)
    assert.equal(calls[0].method, 'POST')
    assert.deepEqual(poseUsageFromMaterialize(ITEM, materialized), {
      uploadId: result.upload_id,
      filename: result.filename,
      label: ITEM.label_zh
    })
  } finally {
    globalThis.fetch = original
  }
})

test('#138 materialize 失败：错误码透出中文提示', async () => {
  const original = globalThis.fetch
  stubFetch(() => jsonResponse({ error: 'preview_missing' }, 409))
  try {
    await assert.rejects(
      () => materializePoseEntry(ITEM.id),
      (err: unknown) => {
        assert.ok(err instanceof HttpError)
        assert.equal(err.status, 409)
        assert.equal(
          formatPoseError(err),
          '409 preview_missing（该条目没有预览图，不能用作参考图）'
        )
        return true
      }
    )
  } finally {
    globalThis.fetch = original
  }
})

// ---------------------------------------------------------------------------
// #165 姿态参考 → A 轨 keyframe-only 视频
// ---------------------------------------------------------------------------

const VIDEO_POSE: PoseUsage = {
  uploadId: 'up_pose_00000000',
  filename: 'pose-standing.png',
  label: '单人侧身站立'
}

test('#165 姿态视频请求体：A 轨 keyframe_only + upload_id，不带 input', () => {
  const payload = buildPoseVideoPayload(VIDEO_POSE)
  assert.deepEqual(payload, {
    type: 'aigc',
    rail: 'A',
    mode: 'keyframe_only',
    keyframe_asset: { upload_id: VIDEO_POSE.uploadId },
    prompt: '参考姿态「单人侧身站立」生成一个连贯镜头，保持人物动作与构图'
  })
  assert.deepEqual(Object.keys(payload).sort(), [
    'keyframe_asset',
    'mode',
    'prompt',
    'rail',
    'type'
  ])
  assert.equal('input' in payload, false)
})

test('#165 用作视频首帧按钮：有预览图可点，无预览图禁用，空态不渲染', () => {
  const withPreview = html(
    createElement(PoseLibraryGrid, {
      items: [{ ...ITEM, preview_url: 'https://cdn.example.com/previews/pose.jpg' }],
      onUseVideo: () => {}
    })
  )
  assert.match(withPreview, /data-testid="pose-use-video"/)
  assert.match(withPreview, /aria-label="用作视频首帧 单人侧身站立"/)
  assert.doesNotMatch(
    withPreview,
    /disabled=""[^>]*data-testid="pose-use-video"|data-testid="pose-use-video"[^>]*disabled=""/
  )

  const withoutPreview = html(
    createElement(PoseLibraryGrid, {
      items: [{ ...ITEM, preview_url: null }],
      onUseVideo: () => {}
    })
  )
  assert.match(withoutPreview, /disabled=""[^>]*data-testid="pose-use-video"/)

  const empty = html(createElement(PoseLibraryEmpty, { filtered: false }))
  assert.match(empty, /data-testid="pose-empty"/)
  assert.doesNotMatch(empty, /pose-use-video/)
})
