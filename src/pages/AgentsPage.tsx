import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  AgentsApiError,
  diffAgent,
  exportAgentUrl,
  getAgent,
  importAgent,
  listAgents,
  rollbackAgent,
  saveAgent,
  seedAgents,
  setAgentSkills,
  toggleAgent
} from '../agents'
import type {
  AgentBindableSkill,
  AgentDetail,
  AgentHost,
  AgentItem,
  AgentMeta,
  AgentProject,
  AgentType,
  AgentsResponse
} from '../types'
import { Check, Close, Refresh, TriangleAlert } from '../components/icons'

const TYPES: AgentType[] = ['skill', 'agent', 'profile']

const TYPE_LABEL: Record<AgentType, string> = {
  skill: 'Skill',
  agent: 'Agent',
  profile: 'Profile'
}

const TYPE_HINT: Record<AgentType, string> = {
  skill: '技能定义（SKILL.md）',
  agent: '角色 / 子 agent 定义',
  profile: '导演 / 调色 Profile（JSON）'
}

const namespaceLabel: Record<string, string> = {
  seed: '种子',
  import: '导入',
  user: '用户'
}

/** #109 分组顺序固定，空组也显示计数，未分类项进「未分组 / 未指定」。 */
const PROJECT_GROUPS: AgentProject[] = ['kex-labs-video', 'agent-memory', 'lofa', '通用', '未分组']
const HOST_GROUPS: AgentHost[] = ['macbook', 'studio', '未指定']

type GroupMode = 'project' | 'host'

const inputClass =
  'h-10 w-full rounded-[10px] border border-black/[0.1] bg-white px-3 text-sm text-apple-text transition-colors placeholder:text-apple-subtext/70 focus:border-apple-blue focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/25'

const selectClass =
  'h-9 rounded-[10px] border border-black/[0.1] bg-white px-2.5 text-[12px] text-apple-text transition-colors focus:border-apple-blue focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/25'

const secondaryButton =
  'inline-flex h-9 items-center justify-center gap-1.5 rounded-full border border-black/[0.1] bg-white px-3.5 text-[12px] font-medium text-apple-text transition-colors hover:bg-[#FAFAFC] focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/40 disabled:cursor-not-allowed disabled:opacity-45'

const primaryButton =
  'inline-flex h-9 items-center justify-center gap-1.5 rounded-full bg-apple-blue px-4 text-[13px] font-medium text-white transition-colors hover:bg-[#0062C4] focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50 disabled:cursor-not-allowed disabled:opacity-45'

const dangerButton =
  'inline-flex h-9 items-center justify-center gap-1.5 rounded-full bg-apple-red px-4 text-[13px] font-medium text-white transition-colors hover:bg-[#D92D24] focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-red/50 disabled:cursor-not-allowed disabled:opacity-45'

function describeError(err: unknown): string {
  if (err instanceof AgentsApiError) {
    const reason = err.reason ? `：${err.reason}` : ''
    if (err.status === 401) {
      return `写入需要令牌（401）${reason}。请配置 WEB_WRITE_TOKEN，或从同源页面操作。`
    }
    if (err.status === 403) {
      return `写入被拒绝（403）${reason}。仅允许同源或带 X-Web-Token 的请求。`
    }
    switch (err.code) {
      case 'license_required':
        return `需要 license，已拒绝导入${reason}`
      case 'secret_detected':
        return `内容含疑似密钥，已拒绝${reason}`
      case 'url_not_allowed':
        return `URL 不在允许的 GitHub raw / jsDelivr 名单内${reason}`
      case 'already_exists':
        return `同 id 已存在，请改用「编辑」保存新版本${reason}`
      case 'content_too_large':
        return `文件过大（上限 256KB）${reason}`
      case 'invalid_id':
        return `id 不合法${reason}`
      case 'invalid_url':
        return `URL 不合法${reason}`
      case 'not_found':
        return `定义不存在${reason}`
      case 'version_not_found':
        return `版本不存在${reason}`
      case 'content_missing':
        return `active 版本内容缺失${reason}`
      case 'invalid_type':
        return `类型不合法${reason}`
      case 'invalid_body':
        return `请求内容不合法${reason}`
      case 'timeout':
        return `拉取超时（10 秒），请稍后重试${reason}`
      default:
        return `${err.code}（HTTP ${err.status}）${reason}`
    }
  }
  return err instanceof Error ? err.message : '请求失败'
}

function shortSha(sha: string): string {
  return sha.length > 12 ? `${sha.slice(0, 12)}…` : sha
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`
}

function initialQuery(): string {
  return new URLSearchParams(window.location.search).get('q') ?? ''
}

function diffLineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'text-apple-subtext'
  if (line.startsWith('@@')) return 'text-apple-blueInk'
  if (line.startsWith('+')) return 'bg-[#EAF8EE] text-[#1E7A3C]'
  if (line.startsWith('-')) return 'bg-[#FCEDEB] text-[#B3261E]'
  return 'text-[#4A4A4F]'
}

export function AgentsPage() {
  const [query, setQuery] = useState(initialQuery)
  const [debouncedQuery, setDebouncedQuery] = useState(initialQuery().trim())
  const [includeInactive, setIncludeInactive] = useState(false)
  const [tab, setTab] = useState<AgentType>('skill')
  const [groupMode, setGroupMode] = useState<GroupMode>('project')

  const [list, setList] = useState<AgentsResponse | null>(null)
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [listKey, setListKey] = useState(0)

  const [selected, setSelected] = useState<{ type: AgentType; id: string } | null>(null)
  const [detail, setDetail] = useState<AgentDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [detailKey, setDetailKey] = useState(0)

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)

  const [diffFrom, setDiffFrom] = useState(1)
  const [diffTo, setDiffTo] = useState(1)
  const [diff, setDiff] = useState<string | null>(null)
  const [diffing, setDiffing] = useState(false)
  const [diffError, setDiffError] = useState<string | null>(null)

  const [rolling, setRolling] = useState(false)
  const [toggling, setToggling] = useState(false)
  const [seeding, setSeeding] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [toolbarError, setToolbarError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<{
    title: string
    description: ReactNode
    confirmLabel: string
    tone: 'danger' | 'primary'
    run: () => Promise<void>
  } | null>(null)

  const toastTimer = useRef<number | null>(null)
  const pinnedSelection = useRef<{ type: AgentType; id: string } | null>(null)
  const notify = useCallback((text: string) => {
    setToast(text)
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 4000)
  }, [])

  useEffect(() => () => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 220)
    return () => window.clearTimeout(timer)
  }, [query])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (debouncedQuery) params.set('q', debouncedQuery)
    else params.delete('q')
    const suffix = params.toString()
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${suffix ? `?${suffix}` : ''}`
    )
  }, [debouncedQuery])

  useEffect(() => {
    let alive = true
    setListLoading(true)
    listAgents({ q: debouncedQuery, includeInactive })
      .then((data) => {
        if (!alive) return
        setList(data)
        setListError(null)
      })
      .catch((err: unknown) => {
        if (!alive) return
        setList(null)
        setListError(describeError(err))
      })
      .finally(() => {
        if (alive) setListLoading(false)
      })
    return () => {
      alive = false
    }
  }, [debouncedQuery, includeInactive, listKey])

  const tabItems = useMemo(
    () => (list?.items ?? []).filter((item) => item.type === tab),
    [list, tab]
  )

  const groupedItems = useMemo(() => {
    const keys: string[] = groupMode === 'project' ? PROJECT_GROUPS : HOST_GROUPS
    const buckets = new Map<string, AgentItem[]>(keys.map((key) => [key, []]))
    for (const item of tabItems) {
      const key =
        groupMode === 'project' ? (item.project ?? '未分组') : (item.host ?? '未指定')
      const bucket = buckets.get(key)
      if (bucket) bucket.push(item)
      else buckets.set(key, [item])
    }
    return [...buckets.entries()]
  }, [groupMode, tabItems])

  useEffect(() => {
    if (listLoading || !list) return
    const pinned = pinnedSelection.current
    if (pinned) {
      const found = list.items.find((item) => item.type === pinned.type && item.id === pinned.id)
      if (!found) return
      pinnedSelection.current = null
      setTab(pinned.type)
      setSelected(pinned)
      return
    }
    if (selected && tabItems.some((item) => item.id === selected.id)) return
    setSelected(tabItems[0] ? { type: tab, id: tabItems[0].id } : null)
  }, [list, listLoading, tab, tabItems, selected])

  useEffect(() => {
    if (!selected) {
      setDetail(null)
      setDetailError(null)
      return
    }
    let alive = true
    setDetailLoading(true)
    setDetailError(null)
    getAgent(selected.type, selected.id)
      .then((data) => {
        if (!alive) return
        setDetail(data)
        setEditing(false)
        setDraft(data.content)
        setMessage('')
        setDiff(null)
        setDiffError(null)
        setActionError(null)
      })
      .catch((err: unknown) => {
        if (!alive) return
        setDetail(null)
        setDetailError(describeError(err))
      })
      .finally(() => {
        if (alive) setDetailLoading(false)
      })
    return () => {
      alive = false
    }
  }, [selected, detailKey])

  useEffect(() => {
    if (!detail) return
    const versions = detail.meta.versions
    const active = detail.meta.active_version
    const previous = versions.reduce(
      (max, version) => (version.version < active && version.version > max ? version.version : max),
      0
    )
    setDiffFrom(previous || active)
    setDiffTo(active)
  }, [detail])

  const counts = list?.counts

  function refreshAll() {
    setListKey((key) => key + 1)
    setDetailKey((key) => key + 1)
  }

  function selectItem(item: AgentItem) {
    setSelected({ type: item.type, id: item.id })
  }

  function startEdit() {
    if (!detail) return
    setDraft(detail.content)
    setMessage('')
    setActionError(null)
    setEditing(true)
  }

  async function submitEdit() {
    if (!selected || !detail) return
    if (draft === detail.content) {
      setActionError('内容与当前 active 版本一致，无需保存。')
      return
    }
    setSaving(true)
    setActionError(null)
    try {
      const result = await saveAgent(selected.type, selected.id, draft, message.trim() || undefined)
      setEditing(false)
      notify(`已保存新版本 v${result.version}`)
      refreshAll()
    } catch (err) {
      setActionError(describeError(err))
    } finally {
      setSaving(false)
    }
  }

  async function runDiff() {
    if (!selected) return
    setDiffing(true)
    setDiffError(null)
    try {
      const result = await diffAgent(selected.type, selected.id, diffFrom, diffTo)
      setDiff(result.unified)
    } catch (err) {
      setDiff(null)
      setDiffError(describeError(err))
    } finally {
      setDiffing(false)
    }
  }

  async function performRollback(target: AgentMeta, version: number) {
    setRolling(true)
    setActionError(null)
    try {
      const result = await rollbackAgent(target.type, target.id, version)
      notify(`已回滚到 v${result.meta.active_version}`)
      refreshAll()
    } catch (err) {
      setActionError(describeError(err))
    } finally {
      setRolling(false)
    }
  }

  function askRollback(target: AgentMeta, version: number) {
    setConfirm({
      title: `回滚到 v${version}？`,
      description: (
        <>
          将 <span className="num">{target.id}</span> 的 active 指针改回 v{version}。版本不会被删除，之后仍可回滚到其他版本。
        </>
      ),
      confirmLabel: '回滚',
      tone: 'danger',
      run: async () => {
        await performRollback(target, version)
        setConfirm(null)
      }
    })
  }

  async function performToggle(
    target: { type: AgentType; id: string; name: string },
    active: boolean
  ) {
    setToggling(true)
    setActionError(null)
    try {
      await toggleAgent(target.type, target.id, active)
      notify(`${active ? '已启用' : '已停用'}「${target.name}」`)
      refreshAll()
    } catch (err) {
      setActionError(describeError(err))
    } finally {
      setToggling(false)
    }
  }

  function askToggle(target: AgentMeta) {
    if (!target.active) {
      void performToggle(target, true)
      return
    }
    setConfirm({
      title: `停用「${target.name}」？`,
      description: '停用后该定义默认从列表隐藏，可通过「包含停用」查看，也可随时重新启用。',
      confirmLabel: '停用',
      tone: 'danger',
      run: async () => {
        await performToggle(target, false)
        setConfirm(null)
      }
    })
  }

  async function runSeed() {
    setSeeding(true)
    setToolbarError(null)
    try {
      const result = await seedAgents()
      notify(`Seed 完成：新增 ${result.created_total}，跳过 ${result.skipped_total}`)
      refreshAll()
    } catch (err) {
      setToolbarError(describeError(err))
    } finally {
      setSeeding(false)
    }
  }

  function handleImported(meta: AgentMeta) {
    setImportOpen(false)
    pinnedSelection.current = { type: meta.type, id: meta.id }
    notify(`已导入 ${meta.type} / ${meta.id}`)
    refreshAll()
  }

  return (
    <div className="page-enter space-y-5" data-testid="agents-page">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em] sm:text-[32px]">
            Agent 库
          </h1>
          <p className="mt-2 max-w-[76ch] text-sm leading-relaxed text-apple-subtext">
            管理 Agent、技能与角色定义：浏览、导入、编辑新版本、对比、回滚、启停与导出。内容按纯文本展示，不执行、不渲染页面代码。
          </p>
        </div>
      </header>

      <div className="grid grid-cols-3 gap-2 sm:gap-3" data-testid="agents-counts">
        {TYPES.map((type) => {
          const active = tab === type
          return (
            <button
              key={type}
              type="button"
              onClick={() => setTab(type)}
              aria-pressed={active}
              data-testid={`agents-count-${type}`}
              className={`card press min-w-0 p-3 text-left transition-colors sm:p-4 ${
                active ? 'ring-1 ring-apple-blue/35' : 'hover:bg-[#FAFAFC]'
              }`}
            >
              <span className="block text-[11px] font-medium text-apple-subtext">{TYPE_LABEL[type]}</span>
              <span className="num mt-1 block text-[24px] font-semibold leading-none tracking-[-0.02em] text-apple-text sm:text-kpi">
                {counts ? counts[type] : '—'}
              </span>
              <span className="mt-1 block truncate text-[10px] text-apple-subtext/80">{TYPE_HINT[type]}</span>
            </button>
          )
        })}
      </div>

      <div className="card p-3 sm:p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="min-w-0 flex-1">
            <label htmlFor="agents-search" className="sr-only">
              搜索定义
            </label>
            <input
              id="agents-search"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索名称、id 或描述…"
              data-testid="agents-search"
              className={inputClass}
            />
          </div>

          <label className="inline-flex shrink-0 cursor-pointer items-center gap-2 text-[12px] text-apple-subtext">
            <input
              type="checkbox"
              role="switch"
              checked={includeInactive}
              onChange={(event) => setIncludeInactive(event.target.checked)}
              data-testid="agents-include-inactive"
              className="peer sr-only"
            />
            <span className="switch-track bg-black/[0.12] peer-checked:bg-apple-blue peer-focus-visible:ring-2 peer-focus-visible:ring-apple-blue/40">
              <span
                className={`switch-knob ${includeInactive ? 'translate-x-[18px]' : ''}`}
                aria-hidden="true"
              />
            </span>
            包含停用
          </label>

          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setImportOpen(true)}
              data-testid="agents-import-open"
              className={primaryButton}
            >
              导入
            </button>
            <button
              type="button"
              onClick={() => void runSeed()}
              disabled={seeding}
              data-testid="agents-seed"
              className={secondaryButton}
            >
              <Refresh className={`h-3.5 w-3.5 ${seeding ? 'animate-spin' : ''}`} />
              {seeding ? 'Seed 中…' : 'Seed'}
            </button>
          </div>
        </div>
        {toolbarError && (
          <p role="alert" className="mt-3 flex items-start gap-1.5 text-[12px] leading-relaxed text-[#B3261E]">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {toolbarError}
          </p>
        )}
      </div>

      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
        <section className="card min-w-0 overflow-hidden" aria-label="定义列表">
          <div className="border-b border-black/[0.06] p-2.5">
            <div role="tablist" aria-label="定义类型" className="flex rounded-[11px] bg-[#F0F0F2] p-1">
              {TYPES.map((type) => {
                const active = tab === type
                return (
                  <button
                    key={type}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setTab(type)}
                    data-testid={`agents-tab-${type}`}
                    className={`flex h-8 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-[9px] text-[12px] transition-all duration-200 ease-apple focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/40 ${
                      active
                        ? 'bg-white font-medium text-apple-text shadow-nav'
                        : 'text-apple-subtext hover:text-apple-text'
                    }`}
                  >
                    {TYPE_LABEL[type]}
                    <span className="num text-[10px] text-apple-subtext">{counts ? counts[type] : '—'}</span>
                  </button>
                )
              })}
            </div>
          </div>

          <div className="mt-2 flex items-center justify-between gap-2 px-0.5">
            <span className="text-[11px] text-apple-subtext">分组</span>
            <div
              role="group"
              aria-label="分组方式"
              data-testid="agents-group-mode"
              className="flex rounded-[9px] bg-[#F0F0F2] p-0.5"
            >
              {([
                ['project', '按项目'],
                ['host', '按主机']
              ] as Array<[GroupMode, string]>).map(([mode, label]) => {
                const active = groupMode === mode
                return (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setGroupMode(mode)}
                    data-testid={`agents-group-mode-${mode}`}
                    className={`flex h-7 items-center rounded-[7px] px-2.5 text-[11px] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/40 ${
                      active ? 'bg-white font-medium text-apple-text shadow-nav' : 'text-apple-subtext hover:text-apple-text'
                    }`}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="max-h-none space-y-2 overflow-y-auto p-2.5 lg:max-h-[calc(100dvh-310px)]">
            {listLoading && !list && (
              <div className="space-y-2" aria-label="加载中">
                {[0, 1, 2].map((index) => (
                  <div key={index} className="skeleton h-[96px] rounded-[14px]" />
                ))}
              </div>
            )}

            {listError && (
              <div role="alert" className="rounded-[14px] border border-[#F3D3CF] bg-[#FCEDEB] p-3 text-[12px] leading-relaxed text-[#B3261E]">
                <p className="flex items-start gap-1.5">
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  列表读取失败：{listError}
                </p>
                <button
                  type="button"
                  onClick={() => setListKey((key) => key + 1)}
                  className="mt-2 inline-flex h-7 items-center rounded-full bg-white px-2.5 text-[11px] font-medium text-apple-text ring-1 ring-black/[0.08] hover:bg-[#FAFAFC]"
                >
                  重试
                </button>
              </div>
            )}

            {!listLoading && !listError && tabItems.length === 0 && (
              <div className="rounded-[14px] border border-dashed border-black/[0.12] bg-[#FAFAFC] p-4 text-[12px] leading-relaxed text-apple-subtext">
                {debouncedQuery ? (
                  <p>
                    没有匹配「<span className="font-medium text-apple-text">{debouncedQuery}</span>」的
                    {TYPE_LABEL[tab]} 定义。
                  </p>
                ) : (
                  <>
                    <p className="font-medium text-apple-text">还没有 {TYPE_LABEL[tab]} 定义。</p>
                    <p className="mt-1">可点击「Seed」从镜像导入本地种子，或用「导入」从 GitHub raw 添加。</p>
                    <button
                      type="button"
                      onClick={() => void runSeed()}
                      disabled={seeding}
                      className={`${secondaryButton} mt-3`}
                    >
                      {seeding ? 'Seed 中…' : '导入种子定义（Seed）'}
                    </button>
                  </>
                )}
              </div>
            )}

            {!listLoading &&
              !listError &&
              tabItems.length > 0 &&
              groupedItems.map(([key, items]) => (
                <div key={key} className="space-y-2" data-testid={`agent-group-${key}`}>
                  <div className="sticky top-0 z-10 flex items-center justify-between rounded-[8px] bg-[#F5F5F7]/95 px-1.5 py-1 backdrop-blur">
                    <span className="text-[11px] font-medium text-apple-text">{key}</span>
                    <span className="num text-[10px] text-apple-subtext">{items.length}</span>
                  </div>
                  {items.map((item) => {
              const active = selected?.type === item.type && selected.id === item.id
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => selectItem(item)}
                  aria-current={active ? 'true' : undefined}
                  data-testid={`agent-card-${item.id}`}
                  className={`block w-full min-w-0 rounded-[14px] border p-3 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/40 ${
                    active
                      ? 'border-[#D8E6FE] bg-[#F7FAFF]'
                      : 'border-black/[0.07] bg-white hover:bg-[#FAFAFC]'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="min-w-0 truncate text-[13px] font-medium text-apple-text">{item.name}</span>
                    <span
                      className={`inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset ${
                        item.active
                          ? 'bg-[#EAF8EE] text-[#1E7A3C] ring-[#D5EFDC]'
                          : 'bg-black/[0.04] text-apple-subtextAlt ring-black/[0.07]'
                      }`}
                    >
                      <span className={`h-1 w-1 rounded-full ${item.active ? 'bg-[#30A14E]' : 'bg-[#8E8E93]'}`} />
                      {item.active ? '启用' : '停用'}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-apple-subtext">
                    {item.description || '（无描述）'}
                  </p>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-apple-subtext">
                    <span className="font-medium text-apple-text/80">
                      {item.host ?? '未指定'} · {item.project ?? '未分组'}
                    </span>
                    {item.type === 'agent' && (
                      <>
                        <span>·</span>
                        <span>{item.skills?.length ?? 0} 技能</span>
                      </>
                    )}
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-apple-subtext/90">
                    <span className="num">{item.id}</span>
                    <span>·</span>
                    <span>v{item.active_version}</span>
                    <span>·</span>
                    <span>{item.versions_count} 版</span>
                    <span>·</span>
                    <span>{namespaceLabel[item.namespace] ?? item.namespace}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-apple-subtext/80">
                    <span className="truncate">{item.source.repo ?? '本地'}</span>
                    <span>·</span>
                    <span>{item.source.license ?? '无 license'}</span>
                    {item.source.commit && (
                      <>
                        <span>·</span>
                        <span className="num">{shortSha(item.source.commit)}</span>
                      </>
                    )}
                  </div>
                </button>
              )
                  })}
                </div>
              ))}
          </div>
        </section>

        <section className="card min-w-0 p-4 sm:p-5" aria-label="定义详情" data-testid="agents-detail">
          {!selected && (
            <div className="grid min-h-[180px] place-items-center text-center text-[12px] text-apple-subtext">
              从左侧选择一个定义查看详情。
            </div>
          )}

          {selected && detailLoading && !detail && (
            <div className="space-y-3" aria-label="详情加载中">
              <div className="skeleton h-6 w-1/2 rounded" />
              <div className="skeleton h-4 w-2/3 rounded" />
              <div className="skeleton h-40 w-full rounded-[12px]" />
            </div>
          )}

          {selected && detailError && (
            <div role="alert" className="rounded-[14px] border border-[#F3D3CF] bg-[#FCEDEB] p-3 text-[12px] leading-relaxed text-[#B3261E]">
              <p className="flex items-start gap-1.5">
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                详情读取失败：{detailError}
              </p>
              <button
                type="button"
                onClick={() => setDetailKey((key) => key + 1)}
                className="mt-2 inline-flex h-7 items-center rounded-full bg-white px-2.5 text-[11px] font-medium text-apple-text ring-1 ring-black/[0.08] hover:bg-[#FAFAFC]"
              >
                重试
              </button>
            </div>
          )}

          {detail && selected && detail.meta.type === selected.type && detail.meta.id === selected.id && (
            <AgentDetailPanel
              detail={detail}
              editing={editing}
              draft={draft}
              message={message}
              saving={saving}
              actionError={actionError}
              diff={diff}
              diffing={diffing}
              diffError={diffError}
              diffFrom={diffFrom}
              diffTo={diffTo}
              onDraftChange={setDraft}
              onMessageChange={setMessage}
              onStartEdit={startEdit}
              onCancelEdit={() => {
                setEditing(false)
                setActionError(null)
              }}
              onSave={() => void submitEdit()}
              onAskRollback={askRollback}
              onAskToggle={askToggle}
              onDiffFromChange={setDiffFrom}
              onDiffToChange={setDiffTo}
              onRunDiff={() => void runDiff()}
              bindableSkills={detail.bindable_skills ?? []}
              onSkillsSaved={refreshAll}
              notify={notify}
            />
          )}
        </section>
      </div>

      {importOpen && <ImportDialog onClose={() => setImportOpen(false)} onImported={handleImported} />}

      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          description={confirm.description}
          confirmLabel={confirm.confirmLabel}
          busy={rolling || toggling}
          tone={confirm.tone}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void confirm.run()}
        />
      )}

      {toast && (
        <div
          role="status"
          aria-live="polite"
          data-testid="agents-toast"
          className="fixed bottom-5 left-1/2 z-[70] flex max-w-[calc(100vw-32px)] -translate-x-1/2 items-center gap-2 rounded-full bg-apple-text px-3.5 py-2 text-[13px] font-medium text-white shadow-lift"
        >
          <Check className="h-3.5 w-3.5 shrink-0 text-[#7EE2A8]" />
          <span className="min-w-0 truncate">{toast}</span>
        </div>
      )}
    </div>
  )
}

function AgentDetailPanel({
  detail,
  editing,
  draft,
  message,
  saving,
  actionError,
  diff,
  diffing,
  diffError,
  diffFrom,
  diffTo,
  onDraftChange,
  onMessageChange,
  onStartEdit,
  onCancelEdit,
  onSave,
  onAskRollback,
  onAskToggle,
  onDiffFromChange,
  onDiffToChange,
  onRunDiff,
  bindableSkills,
  onSkillsSaved,
  notify
}: {
  detail: AgentDetail
  editing: boolean
  draft: string
  message: string
  saving: boolean
  actionError: string | null
  diff: string | null
  diffing: boolean
  diffError: string | null
  diffFrom: number
  diffTo: number
  onDraftChange: (value: string) => void
  onMessageChange: (value: string) => void
  onStartEdit: () => void
  onCancelEdit: () => void
  onSave: () => void
  onAskRollback: (meta: AgentMeta, version: number) => void
  onAskToggle: (meta: AgentMeta) => void
  onDiffFromChange: (value: number) => void
  onDiffToChange: (value: number) => void
  onRunDiff: () => void
  bindableSkills: AgentBindableSkill[]
  onSkillsSaved: () => void
  notify: (text: string) => void
}) {
  const { meta, content } = detail
  const versions = [...meta.versions].sort((a, b) => b.version - a.version)
  const activeVersion = meta.versions.find((version) => version.version === meta.active_version)
  const exportExt = meta.type === 'profile' ? 'json' : 'md'

  // #109 技能绑定：本地草稿 + 显式保存；刷新详情后回到服务端状态。
  const [skillIds, setSkillIds] = useState<string[]>([])
  const [skillsDirty, setSkillsDirty] = useState(false)
  const [skillsSaving, setSkillsSaving] = useState(false)
  const [skillsError, setSkillsError] = useState<string | null>(null)

  useEffect(() => {
    setSkillIds(Array.isArray(meta.skills) ? meta.skills : [])
    setSkillsDirty(false)
    setSkillsError(null)
  }, [meta.id, meta.skills])

  function toggleSkill(id: string, checked: boolean) {
    setSkillIds((prev) => (checked ? [...new Set([...prev, id])] : prev.filter((value) => value !== id)))
    setSkillsDirty(true)
  }

  async function submitSkills() {
    setSkillsSaving(true)
    setSkillsError(null)
    try {
      await setAgentSkills(meta.id, skillIds)
      setSkillsDirty(false)
      notify('技能已更新')
      onSkillsSaved()
    } catch (err) {
      setSkillsError(describeError(err))
    } finally {
      setSkillsSaving(false)
    }
  }

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="inline-flex items-center rounded-md bg-[#EAF2FF] px-1.5 py-0.5 text-[10px] font-medium text-apple-blueInk ring-1 ring-inset ring-[#D8E6FE]">
              {TYPE_LABEL[meta.type]}
            </span>
            <span className="inline-flex items-center rounded-md bg-black/[0.04] px-1.5 py-0.5 text-[10px] text-apple-subtextAlt ring-1 ring-inset ring-black/[0.07]">
              {namespaceLabel[meta.namespace] ?? meta.namespace}
            </span>
            <span
              className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset ${
                meta.active
                  ? 'bg-[#EAF8EE] text-[#1E7A3C] ring-[#D5EFDC]'
                  : 'bg-black/[0.04] text-apple-subtextAlt ring-black/[0.07]'
              }`}
            >
              <span className={`h-1 w-1 rounded-full ${meta.active ? 'bg-[#30A14E]' : 'bg-[#8E8E93]'}`} />
              {meta.active ? '启用' : '停用'}
            </span>
          </div>
          <h2 className="mt-2 break-words text-[20px] font-semibold leading-tight tracking-[-0.015em]">
            {meta.name}
          </h2>
          <p className="num mt-0.5 break-all text-[11px] text-apple-subtext">{meta.id}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <button type="button" onClick={onStartEdit} disabled={editing} data-testid="agent-edit" className={secondaryButton}>
            编辑
          </button>
          <button
            type="button"
            onClick={() => onAskToggle(meta)}
            data-testid="agent-toggle"
            className={secondaryButton}
          >
            {meta.active ? '停用' : '启用'}
          </button>
          <a
            href={exportAgentUrl(meta.type, meta.id)}
            download={`${meta.id}.${exportExt}`}
            data-testid="agent-export"
            className={secondaryButton}
          >
            导出
          </a>
        </div>
      </div>

      {meta.description && (
        <p className="mt-2 max-w-[80ch] text-[12px] leading-relaxed text-apple-subtext">{meta.description}</p>
      )}

      {actionError && (
        <p role="alert" className="mt-3 flex items-start gap-1.5 rounded-[10px] border border-[#F3D3CF] bg-[#FCEDEB] px-2.5 py-2 text-[12px] leading-relaxed text-[#B3261E]">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {actionError}
        </p>
      )}

      <dl className="mt-4 grid min-w-0 grid-cols-1 gap-x-4 gap-y-1.5 rounded-[12px] border border-black/[0.06] bg-[#FAFAFC] p-3 text-[11px] leading-5 sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="text-apple-subtext">repo</dt>
          <dd className="break-all font-medium text-apple-text">{meta.source.repo ?? '本地镜像'}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-apple-subtext">license</dt>
          <dd className="font-medium text-apple-text">{meta.source.license ?? '未声明'}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-apple-subtext">commit</dt>
          <dd className="num break-all text-apple-text">{meta.source.commit ?? '—'}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-apple-subtext">更新</dt>
          <dd className="num text-apple-text">{formatTime(meta.updated_at)}</dd>
        </div>
        <div className="min-w-0 sm:col-span-2">
          <dt className="text-apple-subtext">来源 URL</dt>
          <dd className="break-all text-apple-text">{meta.source.url ?? '—'}</dd>
        </div>
        <div className="min-w-0 sm:col-span-2">
          <dt className="text-apple-subtext">active sha256</dt>
          <dd className="num break-all text-apple-text">{activeVersion?.sha256 ?? meta.source.sha256}</dd>
        </div>
      </dl>

      {meta.type === 'agent' && (
        <section className="mt-4" data-testid="agent-skills" aria-labelledby="agent-skills-title">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 id="agent-skills-title" className="text-[13px] font-semibold text-apple-text">
              项目技能 <span className="num font-normal text-apple-subtext">{skillIds.length}</span>
            </h3>
            <span className="text-[10px] text-apple-subtext">仅同项目（{meta.project ?? '未分组'}）</span>
          </div>
          {bindableSkills.length === 0 ? (
            <p className="mt-2 rounded-[10px] border border-dashed border-black/[0.12] px-3 py-2 text-[11px] text-apple-subtext">
              本项目暂无技能
            </p>
          ) : (
            <ul className="mt-2 grid min-w-0 gap-1.5 sm:grid-cols-2">
              {bindableSkills.map((skill) => {
                const checked = skillIds.includes(skill.id)
                return (
                  <li key={skill.id} className="min-w-0">
                    <label className="flex min-w-0 cursor-pointer items-start gap-2 rounded-[10px] border border-black/[0.07] bg-white px-2.5 py-2 transition-colors hover:bg-[#FAFAFC]">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={skillsSaving}
                        onChange={(event) => toggleSkill(skill.id, event.target.checked)}
                        data-testid={`skill-bind-${skill.id}`}
                        className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded border-black/20 accent-apple-blue focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/40 disabled:opacity-50"
                      />
                      <span className="min-w-0">
                        <span className="block truncate text-[12px] font-medium text-apple-text">{skill.name}</span>
                        <span className="num block truncate text-[10px] text-apple-subtext">{skill.id}</span>
                        {skill.description && (
                          <span className="mt-0.5 line-clamp-2 block text-[10px] leading-relaxed text-apple-subtext">
                            {skill.description}
                          </span>
                        )}
                      </span>
                    </label>
                  </li>
                )
              })}
            </ul>
          )}
          {skillsError && (
            <p role="alert" className="mt-2 text-[11px] leading-relaxed text-[#B3261E]">
              {skillsError}
            </p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void submitSkills()}
              disabled={skillsSaving || !skillsDirty}
              data-testid="agent-skills-save"
              className={secondaryButton}
            >
              {skillsSaving ? '保存中…' : '保存技能'}
            </button>
            <span className="text-[10px] text-apple-subtext">只保存技能 id，不内联内容。</span>
          </div>
        </section>
      )}

      <div className="mt-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-[13px] font-semibold text-apple-text">
            Active 内容 <span className="num font-normal text-apple-subtext">v{meta.active_version}</span>
          </h3>
          {!editing && activeVersion && (
            <span className="num text-[10px] text-apple-subtext">{shortSha(activeVersion.sha256)}</span>
          )}
        </div>

        {editing ? (
          <div className="mt-2 space-y-2">
            <label htmlFor="agent-editor" className="sr-only">
              编辑内容
            </label>
            <textarea
              id="agent-editor"
              value={draft}
              onChange={(event) => onDraftChange(event.target.value)}
              spellCheck={false}
              data-testid="agent-editor"
              className="num min-h-[260px] w-full resize-y rounded-[12px] border border-black/[0.1] bg-white p-3 text-[11px] leading-relaxed text-apple-text focus:border-apple-blue focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/25"
            />
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <label htmlFor="agent-message" className="sr-only">
                版本说明
              </label>
              <input
                id="agent-message"
                value={message}
                onChange={(event) => onMessageChange(event.target.value)}
                placeholder="版本说明（可选，默认 edit）"
                data-testid="agent-message"
                className={`${inputClass} h-9 flex-1 text-[12px]`}
              />
              <div className="flex shrink-0 items-center gap-2">
                <button type="button" onClick={onCancelEdit} disabled={saving} data-testid="agent-cancel" className={secondaryButton}>
                  取消
                </button>
                <button type="button" onClick={onSave} disabled={saving} data-testid="agent-save" className={primaryButton}>
                  {saving ? '保存中…' : '保存新版本'}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <pre
            data-testid="agent-content"
            className="num mt-2 max-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded-[12px] border border-black/[0.07] bg-white p-3 text-[11px] leading-relaxed text-[#3A3A3E]"
          >
            {content}
          </pre>
        )}
      </div>

      <div className="mt-5 grid min-w-0 gap-4 xl:grid-cols-2">
        <section className="min-w-0">
          <h3 className="text-[13px] font-semibold text-apple-text">
            版本 <span className="num font-normal text-apple-subtext">{meta.versions.length}</span>
          </h3>
          <ul className="mt-2 max-h-[280px] space-y-1.5 overflow-y-auto pr-1">
            {versions.map((version) => {
              const isActive = version.version === meta.active_version
              return (
                <li
                  key={version.version}
                  data-testid={`agent-version-${version.version}`}
                  className={`flex items-center justify-between gap-2 rounded-[10px] border px-2.5 py-2 ${
                    isActive ? 'border-[#D8E6FE] bg-[#F7FAFF]' : 'border-black/[0.06] bg-white'
                  }`}
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="num text-[12px] font-medium text-apple-text">v{version.version}</span>
                      {isActive && (
                        <span className="rounded bg-[#EAF2FF] px-1 py-0.5 text-[9px] font-medium text-apple-blueInk">active</span>
                      )}
                    </div>
                    <p className="truncate text-[10px] text-apple-subtext">{version.message || '（无说明）'}</p>
                    <p className="num text-[10px] text-apple-subtext/80">
                      {formatTime(version.created_at)} · {shortSha(version.sha256)}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => onAskRollback(meta, version.version)}
                    disabled={isActive}
                    data-testid={`agent-rollback-${version.version}`}
                    className="inline-flex h-7 shrink-0 items-center rounded-full border border-black/[0.1] bg-white px-2.5 text-[11px] font-medium text-apple-text transition-colors hover:bg-[#FAFAFC] focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/40 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    回滚
                  </button>
                </li>
              )
            })}
          </ul>
        </section>

        <section className="min-w-0">
          <h3 className="text-[13px] font-semibold text-apple-text">版本对比</h3>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor="agent-diff-from">
              对比起始版本
            </label>
            <select
              id="agent-diff-from"
              value={diffFrom}
              onChange={(event) => onDiffFromChange(Number(event.target.value))}
              data-testid="agent-diff-from"
              className={selectClass}
            >
              {meta.versions.map((version) => (
                <option key={version.version} value={version.version}>
                  v{version.version}
                </option>
              ))}
            </select>
            <span className="text-[11px] text-apple-subtext">↔</span>
            <label className="sr-only" htmlFor="agent-diff-to">
              对比目标版本
            </label>
            <select
              id="agent-diff-to"
              value={diffTo}
              onChange={(event) => onDiffToChange(Number(event.target.value))}
              data-testid="agent-diff-to"
              className={selectClass}
            >
              {meta.versions.map((version) => (
                <option key={version.version} value={version.version}>
                  v{version.version}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={onRunDiff}
              disabled={diffing || meta.versions.length < 2}
              data-testid="agent-diff-run"
              className={secondaryButton}
            >
              {diffing ? '对比中…' : '对比'}
            </button>
          </div>
          {meta.versions.length < 2 && (
            <p className="mt-2 text-[11px] leading-relaxed text-apple-subtext">
              仅一个版本，暂无可对比版本；编辑保存后可对比 v1 ↔ v2。
            </p>
          )}
          {diffError && (
            <p role="alert" className="mt-2 text-[11px] leading-relaxed text-[#B3261E]">
              {diffError}
            </p>
          )}
          {diff !== null && (
            <pre
              data-testid="agent-diff"
              className="num mt-2 max-h-[300px] overflow-auto rounded-[12px] border border-black/[0.07] bg-[#FAFAFC] p-2.5 text-[10px] leading-relaxed"
            >
              {diff.length === 0 ? (
                <span className="text-apple-subtext">两个版本内容一致。</span>
              ) : (
                diff.split('\n').map((line, index) => (
                  <span key={index} className={`block whitespace-pre-wrap break-all ${diffLineClass(line)}`}>
                    {line || ' '}
                  </span>
                ))
              )}
            </pre>
          )}
        </section>
      </div>
    </div>
  )
}

function ModalFrame({
  titleId,
  title,
  description,
  onClose,
  children,
  width = 'sm:max-w-[560px]'
}: {
  titleId: string
  title: string
  description?: ReactNode
  onClose: () => void
  children: ReactNode
  width?: string
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="dialog-overlay fixed inset-0 z-[60] flex items-end justify-center bg-apple-text/25 p-0 backdrop-blur-[2px] sm:items-center sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`dialog-panel flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-[20px] border border-black/[0.08] bg-white shadow-lift sm:max-h-[90dvh] sm:rounded-card ${width}`}
      >
        <div className="flex items-start justify-between gap-3 border-b border-black/[0.06] px-5 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-[17px] font-semibold tracking-[-0.01em]">
              {title}
            </h2>
            {description && <p className="mt-1 text-xs leading-relaxed text-apple-subtext">{description}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="-mr-1 grid h-9 w-9 shrink-0 place-items-center rounded-full text-apple-subtext transition-colors hover:bg-black/[0.04] focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
          >
            <Close className="h-[18px] w-[18px]" />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

function ImportDialog({
  onClose,
  onImported
}: {
  onClose: () => void
  onImported: (meta: AgentMeta) => void
}) {
  const [type, setType] = useState<AgentType>('skill')
  const [url, setUrl] = useState('')
  const [license, setLicense] = useState('')
  const [repo, setRepo] = useState('')
  const [commit, setCommit] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const urlRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    urlRef.current?.focus()
  }, [])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!url.trim()) {
      setError('URL 不能为空。')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await importAgent({
        type,
        url: url.trim(),
        license: license.trim() || undefined,
        repo: repo.trim() || undefined,
        commit: commit.trim() || undefined
      })
      onImported(result.meta)
    } catch (err) {
      setError(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <ModalFrame
      titleId="agent-import-title"
      title="导入定义"
      description="仅允许 GitHub raw / gist / jsDelivr 的文本 URL；无 license 或含疑似密钥会被拒绝。"
      onClose={busy ? () => undefined : onClose}
    >
      <form onSubmit={(event) => void submit(event)} className="flex min-h-0 flex-1 flex-col" data-testid="import-dialog">
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <div>
            <label htmlFor="import-type" className="text-[13px] font-medium text-apple-text">
              类型
            </label>
            <select
              id="import-type"
              value={type}
              onChange={(event) => setType(event.target.value as AgentType)}
              data-testid="import-type"
              className={`${inputClass} mt-1.5`}
            >
              {TYPES.map((item) => (
                <option key={item} value={item}>
                  {TYPE_LABEL[item]} · {TYPE_HINT[item]}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="import-url" className="text-[13px] font-medium text-apple-text">
              URL
            </label>
            <input
              ref={urlRef}
              id="import-url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://raw.githubusercontent.com/…/SKILL.md"
              data-testid="import-url"
              className={`${inputClass} mt-1.5`}
            />
            <p className="mt-1 text-[11px] leading-relaxed text-apple-subtext">
              允许：raw.githubusercontent.com、gist.githubusercontent.com、cdn.jsdelivr.net/gh。
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="import-license" className="text-[13px] font-medium text-apple-text">
                license
              </label>
              <input
                id="import-license"
                value={license}
                onChange={(event) => setLicense(event.target.value)}
                placeholder="MIT / Apache-2.0"
                data-testid="import-license"
                className={`${inputClass} mt-1.5`}
              />
            </div>
            <div>
              <label htmlFor="import-repo" className="text-[13px] font-medium text-apple-text">
                repo
              </label>
              <input
                id="import-repo"
                value={repo}
                onChange={(event) => setRepo(event.target.value)}
                placeholder="owner/name（可留空）"
                data-testid="import-repo"
                className={`${inputClass} mt-1.5`}
              />
            </div>
          </div>

          <div>
            <label htmlFor="import-commit" className="text-[13px] font-medium text-apple-text">
              commit
            </label>
            <input
              id="import-commit"
              value={commit}
              onChange={(event) => setCommit(event.target.value)}
              placeholder="可选，留空则从 URL 解析"
              data-testid="import-commit"
              className={`${inputClass} mt-1.5`}
            />
          </div>

          {error && (
            <p role="alert" data-testid="import-error" className="flex items-start gap-1.5 rounded-[10px] border border-[#F3D3CF] bg-[#FCEDEB] px-2.5 py-2 text-[12px] leading-relaxed text-[#B3261E]">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {error}
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-black/[0.06] px-5 py-3">
          <button type="button" onClick={onClose} disabled={busy} className={secondaryButton}>
            取消
          </button>
          <button type="submit" disabled={busy || !url.trim()} data-testid="import-submit" className={primaryButton}>
            {busy ? '导入中…' : '导入'}
          </button>
        </div>
      </form>
    </ModalFrame>
  )
}

function ConfirmDialog({
  title,
  description,
  confirmLabel,
  busy,
  tone,
  onCancel,
  onConfirm
}: {
  title: string
  description: ReactNode
  confirmLabel: string
  busy: boolean
  tone: 'danger' | 'primary'
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <ModalFrame
      titleId="agent-confirm-title"
      title={title}
      onClose={busy ? () => undefined : onCancel}
      width="sm:max-w-[420px]"
    >
      <div className="px-5 py-4 text-[13px] leading-relaxed text-apple-subtext" data-testid="confirm-dialog">
        {description}
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-black/[0.06] px-5 py-3">
        <button type="button" onClick={onCancel} disabled={busy} data-testid="confirm-cancel" className={secondaryButton}>
          取消
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          data-testid="confirm-ok"
          className={tone === 'danger' ? dangerButton : primaryButton}
        >
          {busy ? '处理中…' : confirmLabel}
        </button>
      </div>
    </ModalFrame>
  )
}
