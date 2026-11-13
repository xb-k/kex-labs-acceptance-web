import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { getJson, postJson } from './api'
import { useRouter } from './router'
import { NewIssueDialog } from './components/NewIssueDialog'
import type {
  CreateIssueInput,
  CreateIssueResponse,
  IssueClassification,
  IssueCounts,
  IssueItem,
  IssuesResponse
} from './types'

export type IssueFilter = 'open' | 'all' | 'closed'
export type IssueKind = 'real' | 'tasks' | 'all'

type IssuesState =
  | { status: 'loading'; data: null; error: null }
  | { status: 'ready'; data: IssuesResponse; error: null }
  | { status: 'error'; data: null; error: string }

type IssuesContextValue = IssuesState & {
  retry: () => void
  refresh: () => void
  create: (input: CreateIssueInput) => Promise<IssueItem>
  openDialog: () => void
  closeDialog: () => void
  dialogOpen: boolean
  highlightId: string | null
  filter: IssueFilter
  setFilter: (next: IssueFilter) => void
  /** issue #77：默认 real；打开「显示任务卡」后为 all。 */
  kind: IssueKind
  showTaskCards: boolean
  setShowTaskCards: (next: boolean) => void
  counts: IssueCounts | null
  classification: IssueClassification | null
  webUrl: string | null
  repo: string | null
  lastCreated: { number: number; at: number } | null
  announcement: string
}

const IssuesContext = createContext<IssuesContextValue | null>(null)

const HIGHLIGHT_MS = 3000
const TOAST_MS = 4000

/** `available:false` 的 200 响应映射成可读错误，绝不回退本地数据。 */
function unavailableText(reason?: string): string {
  const value = reason ?? ''
  if (value.includes('not configured')) return 'Gitea 未配置：服务端缺少 GITEA_URL 或访问凭据。'
  if (value.includes('auth failed')) return 'Gitea 认证失败：服务端凭据无效。'
  if (value.includes('unavailable')) return 'Gitea 不可达：检查内网地址、SSH 隧道与 Gitea 服务。'
  if (value.includes('upstream error')) return 'Gitea 返回异常：接口上游错误。'
  return value || 'Gitea 不可用'
}

export function IssuesProvider({ children }: { children: ReactNode }) {
  const { navigate } = useRouter()
  const [state, setState] = useState<IssuesState>({ status: 'loading', data: null, error: null })
  const [nonce, setNonce] = useState(0)
  const [filter, setFilterState] = useState<IssueFilter>('open')
  const [showTaskCards, setShowTaskCardsState] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [highlightId, setHighlightId] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const [lastCreated, setLastCreated] = useState<{ number: number; at: number } | null>(null)
  const triggerRef = useRef<HTMLElement | null>(null)
  const highlightTimer = useRef<number | null>(null)
  const toastTimer = useRef<number | null>(null)
  const previousFilter = useRef<IssueFilter>(filter)
  const previousKind = useRef<boolean>(showTaskCards)
  const kind: IssueKind = showTaskCards ? 'all' : 'real'

  useEffect(() => {
    // 切档位时列表内容会变，先回到加载态，避免旧档位的行挂在新档位下。
    if (previousFilter.current !== filter || previousKind.current !== showTaskCards) {
      previousFilter.current = filter
      previousKind.current = showTaskCards
      setState({ status: 'loading', data: null, error: null })
    }
    const ac = new AbortController()
    // issue #77：任务卡默认隐藏；kind=all 时真实 issue + 任务卡依次返回。
    getJson<IssuesResponse>(`/api/issues?state=${filter}&kind=${kind}&limit=200&page=1`, ac.signal)
      .then((data) => {
        if (data.available === false) {
          setState({ status: 'error', data: null, error: unavailableText(data.reason) })
          return
        }
        setState({ status: 'ready', data, error: null })
      })
      .catch((err: unknown) => {
        if (ac.signal.aborted) return
        setState({ status: 'error', data: null, error: err instanceof Error ? err.message : '请求失败' })
      })
    return () => ac.abort()
  }, [nonce, filter, showTaskCards, kind])

  useEffect(
    () => () => {
      if (highlightTimer.current) window.clearTimeout(highlightTimer.current)
      if (toastTimer.current) window.clearTimeout(toastTimer.current)
    },
    []
  )

  /** 保留旧数据静默刷新：卡片与列表不会闪回加载态。 */
  const refresh = useCallback(() => setNonce((n) => n + 1), [])

  const retry = useCallback(() => {
    setState({ status: 'loading', data: null, error: null })
    setNonce((n) => n + 1)
  }, [])

  const setFilter = useCallback((next: IssueFilter) => setFilterState(next), [])
  const setShowTaskCards = useCallback((next: boolean) => setShowTaskCardsState(next), [])

  const create = useCallback(async (input: CreateIssueInput) => {
    const payload = await postJson<CreateIssueResponse>('/api/issues', input)
    return payload.item
  }, [])

  const openDialog = useCallback(() => {
    triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setDialogOpen(true)
  }, [])

  const restoreFocus = useCallback(() => {
    const trigger = triggerRef.current
    window.setTimeout(() => trigger?.focus(), 0)
  }, [])

  const closeDialog = useCallback(() => {
    setDialogOpen(false)
    restoreFocus()
  }, [restoreFocus])

  const onCreated = useCallback(
    (item: IssueItem) => {
      setDialogOpen(false)
      setAnnouncement(`已创建 #${item.number}`)
      setLastCreated({ number: item.number, at: Date.now() })
      setHighlightId(item.id)
      if (highlightTimer.current) window.clearTimeout(highlightTimer.current)
      highlightTimer.current = window.setTimeout(() => setHighlightId(null), HIGHLIGHT_MS)
      if (toastTimer.current) window.clearTimeout(toastTimer.current)
      toastTimer.current = window.setTimeout(() => setLastCreated(null), TOAST_MS)
      // 新建的 issue 一定是 open；切回 open 档位才能看到并高亮它。
      setFilterState('open')
      refresh()
      navigate('/issues')
      restoreFocus()
    },
    [navigate, refresh, restoreFocus]
  )

  const counts = state.status === 'ready' ? state.data.meta.counts ?? null : null
  const classification = state.status === 'ready' ? state.data.classification ?? null : null
  const webUrl = state.status === 'ready' ? state.data.meta.web_url ?? null : null
  const repo = state.status === 'ready' ? state.data.meta.repo ?? null : null

  const value = useMemo<IssuesContextValue>(
    () => ({
      ...state,
      retry,
      refresh,
      create,
      openDialog,
      closeDialog,
      dialogOpen,
      highlightId,
      filter,
      setFilter,
      kind,
      showTaskCards,
      setShowTaskCards,
      counts,
      classification,
      webUrl,
      repo,
      lastCreated,
      announcement
    }),
    [
      state,
      retry,
      refresh,
      create,
      openDialog,
      closeDialog,
      dialogOpen,
      highlightId,
      filter,
      setFilter,
      kind,
      showTaskCards,
      setShowTaskCards,
      counts,
      classification,
      webUrl,
      repo,
      lastCreated,
      announcement
    ]
  )

  return (
    <IssuesContext.Provider value={value}>
      {children}
      <NewIssueDialog
        open={dialogOpen}
        onClose={closeDialog}
        create={create}
        onCreated={onCreated}
        repo={repo}
      />
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
    </IssuesContext.Provider>
  )
}

export function useIssues(): IssuesContextValue {
  const value = useContext(IssuesContext)
  if (!value) throw new Error('useIssues must be used inside IssuesProvider')
  return value
}
