/**
 * #133 UI 契约测试：状态卡 / 空态 / 清单渲染 / warnings 标记 / 前端调用语义。
 * - 纯函数与 SSR 渲染用 react-dom/server（沿用 cover-keyframe.test.ts 做法，不引 DOM 依赖）；
 * - fetch 用本地 mock，不触网。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AgentLibraryList, AgentSyncCard } from './components/agents/AgentSyncPanel'
import {
  EMPTY_SYNC_COUNTS,
  describeSyncCounts,
  describeSyncError,
  formatSyncStamp,
  getAgentSyncStatus,
  listAgentLibrary,
  startAgentLibrarySync,
  summarizeSync,
  warningLabel,
  type AgentLibraryPage,
  type AgentSyncStatus,
  type LibraryEntry
} from './agent-library'

function status(patch: Partial<AgentSyncStatus> = {}): AgentSyncStatus {
  return {
    last_run: '2026-11-14T04:00:00.000Z',
    running: false,
    started_at: '2026-11-14T04:00:00.000Z',
    finished_at: '2026-11-14T04:00:05.000Z',
    counts: { ...EMPTY_SYNC_COUNTS, files_imported: 12, files_skipped: 3, duplicates: 1 },
    errors: [],
    queries: ['agent skills'],
    auth: 'anonymous',
    ...patch
  }
}

const entry = (patch: Partial<LibraryEntry> = {}): LibraryEntry => ({
  repo: 'anthropics/skills',
  path: 'docs/skill.md',
  url: 'https://github.com/anthropics/skills/blob/main/docs/skill.md',
  stars: 12345,
  license: 'MIT',
  sha: 'a'.repeat(64),
  fetched_at: '2026-11-14T04:00:01.000Z',
  score: 0.82,
  warnings: [],
  tier: 'A',
  verified: true,
  ...patch
})

const renderSync = (props: Parameters<typeof AgentSyncCard>[0]) =>
  renderToStaticMarkup(createElement(AgentSyncCard, props))

const renderLibrary = (props: Parameters<typeof AgentLibraryList>[0]) =>
  renderToStaticMarkup(createElement(AgentLibraryList, props))

const libraryProps = (page: Partial<AgentLibraryPage>) => ({
  entries: page.items ?? [],
  total: page.total ?? (page.items?.length ?? 0),
  loading: false,
  loadingMore: false,
  error: null,
  generatedAt: page.generated_at ?? null,
  onLoadMore: () => {},
  onRetry: () => {}
})

// ---------------------------------------------------------------------------
// 状态派生
// ---------------------------------------------------------------------------

test('#133 状态卡四态：未同步 / 同步中 / 成功 / 失败', () => {
  assert.equal(summarizeSync(null).phase, 'unsynced')
  assert.equal(summarizeSync(status({ last_run: null })).phase, 'unsynced')
  assert.equal(summarizeSync(status({ running: true })).phase, 'running')
  assert.equal(summarizeSync(status()).phase, 'success')
  assert.equal(
    summarizeSync(
      status({
        counts: { ...EMPTY_SYNC_COUNTS },
        errors: [{ at: '2026-11-14T04:00:00.000Z', stage: 'search', query: 'agent skills', error: 'rate_limit' }]
      })
    ).phase,
    'failed'
  )
})

test('#133 有错误但仍有导入 → 部分失败，不冒充成功', () => {
  const partial = status({
    errors: [
      { at: '2026-11-14T04:00:00.000Z', stage: 'download', repo: 'acme/x', error: 'network_error' }
    ]
  })
  assert.equal(summarizeSync(partial).phase, 'partial')
  assert.equal(summarizeSync(partial).label, '部分失败')
})

test('#133 counts 文案：跳过 = skip + reject + duplicate', () => {
  const text = describeSyncCounts(
    { ...EMPTY_SYNC_COUNTS, files_imported: 4, files_skipped: 2, files_rejected: 1, duplicates: 3 },
    2
  )
  assert.equal(text.skipped, 6)
  assert.equal(text.errors, 2)
  assert.equal(text.text, '导入 4 · 跳过 6 · 错误 2')
  assert.equal(describeSyncCounts(null, 0).text, '导入 0 · 跳过 0 · 错误 0')
})

test('#133 时间戳：无值返回 null，非法值不伪造时间', () => {
  assert.equal(formatSyncStamp(null), null)
  assert.equal(formatSyncStamp('not-a-date'), null)
  assert.match(formatSyncStamp('2026-11-14T04:00:00.000Z') ?? '', /^\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
})

test('#133 错误原样透出（rate limit 不被改写）', () => {
  assert.equal(
    describeSyncError({ at: '', stage: 'search', query: 'agent skills', error: 'rate_limit' }),
    '搜索仓库（查询「agent skills」）：rate_limit'
  )
  assert.equal(
    describeSyncError({ at: '', stage: 'download', repo: 'acme/x', error: 'http_404' }),
    '下载文件（acme/x）：http_404'
  )
})

test('#133 warning code 有中文标签，未知 code 原样展示', () => {
  assert.equal(warningLabel('prompt_injection_ignore_previous'), '提示注入：忽略先前指令')
  assert.equal(warningLabel('brand_new_rule'), 'brand_new_rule')
})

// ---------------------------------------------------------------------------
// SSR：状态卡
// ---------------------------------------------------------------------------

test('#133 状态卡渲染状态、counts 与「立即同步」，不含运行入口', () => {
  const html = renderSync({ status: status(), starting: false, startedAt: null, error: null, onStart: () => {} })
  assert.match(html, /Agent \/ Skill 库同步/)
  assert.match(html, /data-testid="agent-sync-phase"[^>]*>.*成功/s)
  assert.match(html, /导入 12 · 跳过 4 · 错误 0/)
  assert.match(html, /data-testid="agent-sync-start"/)
  assert.match(html, /立即同步/)
  assert.match(html, /不执行任何远端内容/)
  assert.doesNotMatch(html, />运行</)
})

test('#133 未同步状态显示「尚未同步」而不是伪造上次时间', () => {
  const html = renderSync({
    status: status({ last_run: null }),
    starting: false,
    startedAt: null,
    error: null,
    onStart: () => {}
  })
  assert.match(html, /尚未同步/)
})

test('#133 同步中显示等待动效与已用时长', () => {
  const now = Date.now()
  const html = renderSync({
    status: status({ running: true, last_run: null }),
    starting: false,
    startedAt: now,
    error: null,
    onStart: () => {}
  })
  assert.match(html, /data-testid="agent-sync-status"/)
  assert.match(html, /正在同步 GitHub 清单/)
  assert.match(html, /已用 /)
  assert.match(html, /同步中/)
})

test('#133 失败错误原样出现在状态卡', () => {
  const html = renderSync({
    status: status({
      counts: { ...EMPTY_SYNC_COUNTS },
      errors: [{ at: '2026-11-14T04:00:00.000Z', stage: 'search', query: 'agent skills', error: 'rate_limit' }]
    }),
    starting: false,
    startedAt: null,
    error: null,
    onStart: () => {}
  })
  assert.match(html, /data-testid="agent-sync-errors"/)
  assert.match(html, /rate_limit/)
  assert.match(html, />失败</)
})

test('#133 启动失败（未拿到 202）显示 alert，不显示为成功', () => {
  const html = renderSync({
    status: status({ last_run: null }),
    starting: false,
    startedAt: null,
    error: '403：same-origin browser request or X-Web-Token required',
    onStart: () => {}
  })
  assert.match(html, /data-testid="agent-sync-error"/)
  assert.match(html, /403/)
  assert.match(html, /尚未同步/)
})

// ---------------------------------------------------------------------------
// SSR：清单
// ---------------------------------------------------------------------------

test('#133 清单空态提示先点「立即同步」', () => {
  const html = renderLibrary(libraryProps({ items: [], total: 0, generated_at: null }))
  assert.match(html, /尚未同步/)
  assert.match(html, /立即同步/)
})

test('#133 清单渲染 repo 链接 / 路径 / stars / license / score', () => {
  const html = renderLibrary(libraryProps({ items: [entry()], total: 1 }))
  assert.match(html, /href="https:\/\/github.com\/anthropics\/skills\/blob\/main\/docs\/skill.md"/)
  assert.match(html, /anthropics\/skills/)
  assert.match(html, /docs\/skill.md/)
  assert.match(html, /12,345/)
  assert.match(html, /MIT/)
  assert.match(html, /0\.82/)
  assert.match(html, /官方/)
})

test('#133 warnings 以中文标记展示，未知 code 原样显示', () => {
  const html = renderLibrary(
    libraryProps({
      items: [entry({ warnings: ['prompt_injection_ignore_previous', 'brand_new_rule'] })],
      total: 1
    })
  )
  assert.match(html, /提示注入：忽略先前指令/)
  assert.match(html, /brand_new_rule/)
  assert.doesNotMatch(html, /无标记/)
})

test('#133 无 warnings 显示「无标记」而不是留空', () => {
  const html = renderLibrary(libraryProps({ items: [entry()], total: 1 }))
  assert.match(html, /无标记/)
})

test('#133 还有更多条目时出现「加载更多」并显示进度', () => {
  const html = renderLibrary(libraryProps({ items: [entry()], total: 41 }))
  assert.match(html, /data-testid="agent-library-more"/)
  assert.match(html, /已显示 1 \/ 41 条/)
})

test('#133 清单读取失败显示原因与重试', () => {
  const html = renderLibrary({
    ...libraryProps({ items: [], total: 0 }),
    error: 'HTTP 500'
  })
  assert.match(html, /清单读取失败：HTTP 500/)
  assert.match(html, /重试/)
})

// ---------------------------------------------------------------------------
// 前端调用语义（mock fetch）
// ---------------------------------------------------------------------------

function mockFetch(handler: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    return handler(url, init)
  }) as typeof fetch
  return {
    calls,
    restore: () => {
      globalThis.fetch = original
    }
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

test('#133 立即同步：202 返回 started=true，409 视为已在跑而不是失败', async () => {
  const ok = mockFetch(() => json({ started: true }, 202))
  try {
    assert.deepEqual(await startAgentLibrarySync(), { started: true })
    assert.equal(ok.calls[0]?.init?.method, 'POST')
  } finally {
    ok.restore()
  }

  const busy = mockFetch(() => json({ started: false, error: 'sync_running' }, 409))
  try {
    assert.deepEqual(await startAgentLibrarySync(), { started: false })
  } finally {
    busy.restore()
  }

  const denied = mockFetch(() => json({ error: 'same-origin browser request or X-Web-Token required' }, 403))
  try {
    await assert.rejects(startAgentLibrarySync(), /403|same-origin/)
  } finally {
    denied.restore()
  }
})

test('#133 状态与清单走真实查询串，offset 透传给后端', async () => {
  const page: AgentLibraryPage = { total: 1, limit: 20, offset: 20, generated_at: null, items: [entry()] }
  const mocked = mockFetch((url) => (url.startsWith('/api/agents/sync') ? json(status()) : json(page)))
  try {
    const st = await getAgentSyncStatus()
    assert.equal(st.counts.files_imported, 12)
    const got = await listAgentLibrary({ limit: 20, offset: 20 })
    assert.equal(got.items.length, 1)
    const url = mocked.calls[1]?.url ?? ''
    assert.match(url, /^\/api\/agents\/library\?/)
    assert.match(url, /limit=20/)
    assert.match(url, /offset=20/)
  } finally {
    mocked.restore()
  }
})
