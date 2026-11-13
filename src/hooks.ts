import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { HttpError } from './api'

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * 统一弹窗/抽屉的无障碍行为：
 * - 打开时锁定 body 滚动并聚焦初始元素
 * - Capture 阶段拦截 Escape（防止外层弹窗/抽屉一并关闭）
 * - Tab / Shift+Tab 焦点锁定在面板内部
 * - 关闭后恢复先前的焦点
 */
export function useModalA11y(
  open: boolean,
  panelRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  initialFocusRef?: RefObject<HTMLElement | null>,
  restoreFocusRef?: RefObject<HTMLElement | null>
) {
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!open) return
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const previousFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null

    const focusTimer = window.setTimeout(() => {
      if (initialFocusRef?.current) {
        initialFocusRef.current.focus()
        return
      }
      const first = panelRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)
      if (first) first.focus()
      else panelRef.current?.focus()
    }, 10)

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab' || !panelRef.current) return
      const focusables = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement
      )
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (event.shiftKey) {
        if (document.activeElement === first || !panelRef.current.contains(document.activeElement)) {
          event.preventDefault()
          last.focus()
        }
      } else if (document.activeElement === last || !panelRef.current.contains(document.activeElement)) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.clearTimeout(focusTimer)
      document.removeEventListener('keydown', onKeyDown, true)
      document.body.style.overflow = prevOverflow
      const restoreTarget = restoreFocusRef?.current ?? previousFocused
      if (restoreTarget && document.contains(restoreTarget)) {
        window.setTimeout(() => restoreTarget.focus(), 0)
      }
    }
  }, [open, panelRef, initialFocusRef, restoreFocusRef])
}

/** 页面可见性感知轮询：后台标签页自动暂停，切回前台先触发一次再恢复间隔。 */
export function useVisibilityPoll(
  callback: () => void,
  intervalMs: number,
  immediateOnVisible = true
) {
  const cbRef = useRef(callback)
  cbRef.current = callback

  useEffect(() => {
    if (intervalMs <= 0) return
    let timer: number | null = null
    const start = () => {
      if (timer === null) timer = window.setInterval(() => cbRef.current(), intervalMs)
    }
    const stop = () => {
      if (timer !== null) {
        window.clearInterval(timer)
        timer = null
      }
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        if (immediateOnVisible) cbRef.current()
        start()
      } else {
        stop()
      }
    }
    if (document.visibilityState === 'visible') start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [intervalMs, immediateOnVisible])
}

export type ToastMessage = {
  text: string
  tone: 'ok' | 'err' | 'info'
}

export function useToast(durationMs = 4000) {
  const [toast, setToast] = useState<ToastMessage | null>(null)
  const timerRef = useRef<number | null>(null)

  const clearToast = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    setToast(null)
  }, [])

  const showToast = useCallback(
    (text: string, tone: ToastMessage['tone'] = 'ok') => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      setToast({ text, tone })
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        setToast(null)
      }, durationMs)
    },
    [durationMs]
  )

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    },
    []
  )

  return { toast, showToast, clearToast }
}

export type CopyStatus = 'idle' | 'copied' | 'manual'

export function useCopyToClipboard(resetMs = 2000) {
  const [status, setStatus] = useState<CopyStatus>('idle')
  const timerRef = useRef<number | null>(null)

  const copy = useCallback(
    async (text: string, fallbackEl?: HTMLElement | null) => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      let ok = false
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(text)
          ok = true
        } catch {
          ok = false
        }
      }
      if (!ok && fallbackEl) {
        try {
          const range = document.createRange()
          range.selectNodeContents(fallbackEl)
          const sel = window.getSelection()
          sel?.removeAllRanges()
          sel?.addRange(range)
        } catch {
          /* selection fallback ignored */
        }
      }
      setStatus(ok ? 'copied' : 'manual')
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        setStatus('idle')
      }, resetMs)
      return ok
    },
    [resetMs]
  )

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    },
    []
  )

  return { status, copy }
}

export function useDebouncedValue<T>(value: T, delayMs = 200): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs)
    return () => window.clearTimeout(timer)
  }, [value, delayMs])
  return debounced
}

export function formatHttpError(err: unknown, fallback = '操作失败'): string {
  if (err instanceof HttpError) {
    if (err.status === 401) return '写入校验失败（401）：令牌无效或未配置'
    if (err.status === 403) return '跨源请求被拒绝（403）：请从本站页面操作'
    if (err.status === 503) return '功能未就绪（503）：服务或令牌未配置'
    if (err.payload && typeof err.payload === 'object') {
      const rec = err.payload as Record<string, unknown>
      const reason = typeof rec.reason === 'string' && rec.reason ? rec.reason : null
      const path = typeof rec.path === 'string' && rec.path ? rec.path : null
      const msg = typeof rec.error === 'string' && rec.error ? rec.error : err.message
      const extras = [path, reason].filter(Boolean).join(' · ')
      return extras ? `${msg}（${extras}）` : msg
    }
    return `请求失败（${err.status}）：${err.message}`
  }
  return err instanceof Error && err.message ? err.message : fallback
}

/**
 * 专业视频网站式「下拉懒加载」Hook：
 * 首屏只渲染 initialCount 条，底部哨兵进入视口（提前 260px）自动加载下一批 stepSize 条。
 * 当筛选条件 / 关键词变化（resetKey 变化）时自动重置回首屏批次。
 */
export function useInfiniteScrollBatch(
  totalCount: number,
  initialCount = 12,
  stepSize = 12,
  resetKey = ''
) {
  const [visibleCount, setVisibleCount] = useState(initialCount)
  const sentinelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setVisibleCount(initialCount)
  }, [resetKey, initialCount])

  const loadMore = useCallback(() => {
    setVisibleCount((prev) => Math.min(totalCount, prev + stepSize))
  }, [totalCount, stepSize])

  const hasMore = visibleCount < totalCount

  useEffect(() => {
    const el = sentinelRef.current
    if (!el || !hasMore || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisibleCount((prev) => Math.min(totalCount, prev + stepSize))
        }
      },
      { rootMargin: '260px 0px' }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [hasMore, totalCount, stepSize])

  return {
    visibleCount: Math.min(totalCount, visibleCount),
    hasMore,
    loadMore,
    sentinelRef
  }
}
