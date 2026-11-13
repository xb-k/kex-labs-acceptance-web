import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type AnchorHTMLAttributes,
  type MouseEvent,
  type ReactNode
} from 'react'
import { movedPageFor } from './moved-pages'

type RouterValue = {
  path: string
  navigate: (to: string) => void
}

const TITLE_SUFFIX = ' · KexLabs'

/** 路由 → document.title；先匹配更具体的子路由。 */
const TITLE_RULES: Array<[RegExp, string]> = [
  [/^\/job\/[\w-]+\/qc$/, 'QC 质量门禁'],
  [/^\/job\/[\w-]+$/, '任务详情'],
  [/^\/(?:overview)?$/, '视频生产总台'],
  [/^\/studio$/, '双轨创作工坊'],
  [/^\/jobs$/, '任务中心'],
  [/^\/qc$/, 'QC 质量门禁'],
  [/^\/deliveries$/, '交付成片库'],
  [/^\/agents$/, 'Agent 与提示词库']
]

function normalizePath(path: string): string {
  return path !== '/' && path.endsWith('/') ? path.replace(/\/+$/, '') : path
}

function titleFor(path: string): string {
  const normalized = normalizePath(path)
  const moved = movedPageFor(normalized)
  if (moved) return `${moved.title}${TITLE_SUFFIX}`
  const hit = TITLE_RULES.find(([pattern]) => pattern.test(normalized))
  return `${hit ? hit[1] : '页面不存在'}${TITLE_SUFFIX}`
}

/** 拆出 pathname 与 query（path 只存 pathname，query 交给页面自己处理）。 */
function splitTarget(to: string): { pathname: string; search: string } {
  const raw = to.split('#')[0]
  const index = raw.indexOf('?')
  return index < 0
    ? { pathname: raw, search: '' }
    : { pathname: raw.slice(0, index), search: raw.slice(index) }
}

function scrollYOf(state: unknown): number {
  if (state && typeof state === 'object' && typeof (state as { scrollY?: unknown }).scrollY === 'number') {
    return (state as { scrollY: number }).scrollY
  }
  return 0
}

const RouterContext = createContext<RouterValue | null>(null)

export function RouterProvider({ children }: { children: ReactNode }) {
  const [path, setPath] = useState(() => window.location.pathname)
  // 本次路由切换后要恢复的滚动位置；null 表示无需处理。
  const pendingScroll = useRef<number | null>(null)
  // 首次加载不强制聚焦，只有真正跳转过才把焦点移到 main。
  const navigated = useRef(false)

  useEffect(() => {
    const onPop = (event: PopStateEvent) => {
      pendingScroll.current = scrollYOf(event.state)
      navigated.current = true
      setPath(window.location.pathname)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const navigate = useCallback((to: string) => {
    const { pathname, search } = splitTarget(to)
    if (`${pathname}${search}` === `${window.location.pathname}${window.location.search}`) return
    // 把当前滚动位置记进当前 history entry，新 entry 从顶部开始。
    window.history.replaceState({ ...(window.history.state ?? {}), scrollY: window.scrollY }, '')
    window.history.pushState({ scrollY: 0 }, '', to)
    pendingScroll.current = 0
    navigated.current = true
    setPath(pathname)
  }, [])

  useEffect(() => {
    document.title = titleFor(path)
  }, [path])

  useEffect(() => {
    if (!navigated.current) return
    const main = document.getElementById('main-content')
    main?.focus({ preventScroll: true })
  }, [path])

  useEffect(() => {
    const y = pendingScroll.current
    if (y == null) return
    pendingScroll.current = null
    // 等新路由内容完成一帧渲染后再恢复，避免被旧页面高度截断。
    const first = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => window.scrollTo({ top: y, behavior: 'auto' }))
    })
    return () => window.cancelAnimationFrame(first)
  }, [path])

  const value = useMemo(() => ({ path, navigate }), [path, navigate])
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>
}

export function useRouter(): RouterValue {
  const value = useContext(RouterContext)
  if (!value) throw new Error('useRouter must be used inside RouterProvider')
  return value
}

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }

export function Link({ to, children, onClick, ...rest }: LinkProps) {
  const { navigate } = useRouter()
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event)
    if (event.defaultPrevented) return
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
    event.preventDefault()
    navigate(to)
  }
  return (
    <a href={to} onClick={handleClick} {...rest}>
      {children}
    </a>
  )
}
