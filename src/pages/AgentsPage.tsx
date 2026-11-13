import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  diffAgent,
  getAgent,
  listAgents,
  rollbackAgent,
  saveAgent,
  seedAgents,
  toggleAgent
} from '../agents'
import { AgentDetailPanel } from '../components/agents/AgentDetailPanel'
import { ConfirmDialog, ImportDialog } from '../components/agents/AgentDialogs'
import {
  HOST_GROUPS,
  PROJECT_GROUPS,
  TYPES,
  TYPE_HINT,
  TYPE_LABEL,
  describeError,
  inputClass,
  namespaceLabel,
  primaryButton,
  secondaryButton,
  shortSha,
  validateJsonContent,
  type GroupMode
} from '../components/agents/agents-utils'
import { Refresh, TriangleAlert } from '../components/icons'
import { ToastHost } from '../components/ui'
import { useDebouncedValue, useToast } from '../hooks'
import type { AgentDetail, AgentItem, AgentMeta, AgentType, AgentsResponse } from '../types'
import { readSearchParam, updateSearchParams } from '../url'

function readInitialTab(): AgentType {
  const raw = readSearchParam('tab')
  return raw === 'skill' || raw === 'agent' || raw === 'profile' ? raw : 'skill'
}

function readInitialGroupMode(): GroupMode {
  return readSearchParam('group') === 'host' ? 'host' : 'project'
}

function readInitialSelected(): { type: AgentType; id: string } | null {
  const id = readSearchParam('id')?.trim()
  if (!id) return null
  return { type: readInitialTab(), id }
}

export function AgentsPage() {
  const [query, setQuery] = useState(() => readSearchParam('q') ?? '')
  const debouncedQuery = useDebouncedValue(query.trim(), 220)
  const [includeInactive, setIncludeInactive] = useState(false)
  const [tab, setTab] = useState<AgentType>(readInitialTab)
  const [groupMode, setGroupMode] = useState<GroupMode>(readInitialGroupMode)

  const [list, setList] = useState<AgentsResponse | null>(null)
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [listKey, setListKey] = useState(0)

  const [selected, setSelected] = useState<{ type: AgentType; id: string } | null>(readInitialSelected)
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
  const [syncingGithub, setSyncingGithub] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [toolbarError, setToolbarError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<{
    title: string
    description: ReactNode
    confirmLabel: string
    tone: 'danger' | 'primary'
    run: () => Promise<void>
  } | null>(null)

  const { toast, showToast, clearToast } = useToast(4000)
  const notify = useCallback((text: string) => showToast(text, 'ok'), [showToast])
  const pinnedSelection = useRef<{ type: AgentType; id: string } | null>(null)
  const autoSeedChecked = useRef(false)
  const detailSectionRef = useRef<HTMLElement>(null)

  // 同步筛选与选中态到 URL search params
  useEffect(() => {
    updateSearchParams({
      q: debouncedQuery || null,
      tab: tab === 'skill' ? null : tab,
      group: groupMode === 'project' ? null : groupMode,
      id: selected?.id || null
    })
  }, [debouncedQuery, tab, groupMode, selected])

  // 支持浏览器前进/后退
  useEffect(() => {
    const onPopState = () => {
      setQuery(readSearchParam('q') ?? '')
      setTab(readInitialTab())
      setGroupMode(readInitialGroupMode())
      const nextId = readSearchParam('id')?.trim()
      if (nextId) {
        pinnedSelection.current = { type: readInitialTab(), id: nextId }
      }
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

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

  // Ensure all platform pipeline agents & GitHub script skills are populated into the library on first visit
  useEffect(() => {
    if (autoSeedChecked.current || listLoading || !list || debouncedQuery || includeInactive) return
    autoSeedChecked.current = true
    const ids = new Set(list.items.map((item) => item.id))
    const requiredIds = [
      'seed-video-scriptwriter',
      'seed-storyboard-director',
      'seed-keyframe-artist',
      'seed-i2v-generator',
      'seed-video-enhancer',
      'seed-qc-audio-supervisor',
      'seed-github-director-skills',
      'seed-github-visual-skills',
      'seed-github-storyboard-studio',
      'seed-script-historical-grounding'
    ]
    if (requiredIds.every((id) => ids.has(id))) return
    seedAgents()
      .then((res) => {
        if (res.created_total > 0) {
          setListKey((key) => key + 1)
          setDetailKey((key) => key + 1)
        }
      })
      .catch(() => {
        /* ignore background auto-seed errors; user can still trigger Seed manually */
      })
  }, [list, listLoading, debouncedQuery, includeInactive])

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
      if (!found) {
        pinnedSelection.current = null
      } else {
        pinnedSelection.current = null
        setTab(pinned.type)
        setSelected(pinned)
        return
      }
    }
    if (selected && tabItems.some((item) => item.id === selected.id && item.type === tab)) return
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
    if (typeof window !== 'undefined' && window.innerWidth < 1024) {
      window.requestAnimationFrame(() => {
        detailSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      })
    }
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
    if (detail.meta.type === 'profile') {
      const check = validateJsonContent(draft)
      if (!check.ok) {
        setActionError(`Profile JSON 格式无效：${check.message}`)
        return
      }
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

  async function syncGithubSkills() {
    setSyncingGithub(true)
    setToolbarError(null)
    try {
      const res = await fetch('/api/gemini/script-templates/sync', { method: 'POST' })
      const body = (await res.json()) as {
        error?: string
        sync?: { lastResultMessage?: string }
        synced_skills?: Array<{ id: string; version: number }>
      }
      if (!res.ok) {
        throw new Error(body.error || `HTTP ${res.status}`)
      }
      const skillCount = body.synced_skills?.length ?? 0
      notify(body.sync?.lastResultMessage ?? `GitHub 模板同步完成（入库 ${skillCount} 项）`)
      setTab('skill')
      refreshAll()
    } catch (err) {
      setToolbarError(describeError(err))
    } finally {
      setSyncingGithub(false)
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
              onClick={() => void syncGithubSkills()}
              disabled={syncingGithub}
              data-testid="agents-sync-github"
              className={secondaryButton}
              title="从 GitHub 上游仓库拉取最新导演提示词模板并同步至技能库"
            >
              <Refresh className={`h-3.5 w-3.5 ${syncingGithub ? 'animate-spin' : ''}`} />
              {syncingGithub ? '同步 GitHub 中…' : '同步 GitHub 模板'}
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

          <div className="mt-2 flex items-center justify-between gap-2 px-2.5">
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
                  className="mt-2 inline-flex h-7 items-center rounded-lg bg-white px-2.5 text-[11px] font-medium text-apple-text ring-1 ring-black/[0.08] hover:bg-[#FAFAFC]"
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

        <section
          ref={detailSectionRef}
          id="agents-detail"
          className="card min-w-0 p-4 sm:p-5"
          aria-label="定义详情"
          data-testid="agents-detail"
        >
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
                className="mt-2 inline-flex h-7 items-center rounded-lg bg-white px-2.5 text-[11px] font-medium text-apple-text ring-1 ring-black/[0.08] hover:bg-[#FAFAFC]"
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

      <ToastHost toast={toast} onClose={clearToast} testId="agents-toast" />
    </div>
  )
}
