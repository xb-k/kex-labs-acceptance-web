import { useEffect, useRef, useState, type ReactNode } from 'react'

/**
 * 视口内才挂载：小屏/长列表首屏不渲染视口外的卡片与视频。
 * `once` 默认 true —— 挂载后保持，避免滚动回来反复卸载造成闪烁。
 */
export function useInView<T extends Element>(options: { rootMargin?: string; once?: boolean } = {}) {
  const { rootMargin = '200px 0px', once = true } = options
  const ref = useRef<T | null>(null)
  const [inView, setInView] = useState(false)

  useEffect(() => {
    const element = ref.current
    if (!element) return
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setInView(true)
            if (once) observer.disconnect()
          } else if (!once) {
            setInView(false)
          }
        }
      },
      { rootMargin, threshold: 0.01 }
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [rootMargin, once])

  return { ref, inView }
}

export function LazySection({
  children,
  minHeight = 96,
  className = '',
  rootMargin = '220px 0px'
}: {
  children: ReactNode
  minHeight?: number | string
  className?: string
  rootMargin?: string
}) {
  const { ref, inView } = useInView<HTMLDivElement>({ rootMargin })
  return (
    <div ref={ref} className={className} style={inView ? undefined : { minHeight }}>
      {inView ? (
        children
      ) : (
        <div className="skeleton w-full rounded-panel" style={{ height: minHeight }} aria-hidden="true" />
      )}
    </div>
  )
}

export function LoadMore({
  remaining,
  onClick,
  unit = '条',
  variant = 'card',
  className = ''
}: {
  remaining: number
  onClick: () => void
  unit?: string
  variant?: 'card' | 'plain'
  className?: string
}) {
  if (remaining <= 0) return null
  const base =
    variant === 'plain'
      ? 'border-t border-black/[0.05] bg-transparent text-apple-blue hover:bg-apple-bg/50'
      : 'rounded-panel border border-black/[0.06] bg-white/80 text-apple-text shadow-soft hover:bg-white'
  return (
    <button
      type="button"
      onClick={onClick}
      className={`press flex w-full items-center justify-center gap-1.5 px-3 py-2 text-[12px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-apple-blue/50 ${base} ${className}`}
    >
      加载更多（剩余 {remaining} {unit}）
      <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3 w-3 opacity-60">
        <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    </button>
  )
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden="true" className={`skeleton rounded-panel ${className}`} />
}

export function LazyVideo({
  src,
  poster,
  ariaLabel,
  fit = 'contain'
}: {
  src: string
  poster?: string | null
  ariaLabel: string
  fit?: 'contain' | 'cover'
}) {
  const { ref, inView } = useInView<HTMLDivElement>({ rootMargin: '240px 0px' })
  const objectFit = fit === 'cover' ? 'object-cover' : 'object-contain'
  return (
    <div ref={ref} className="h-full w-full bg-[#0B0B0C]">
      {inView ? (
        <video
          src={src}
          poster={poster ?? undefined}
          preload="metadata"
          muted
          playsInline
          controls
          aria-label={ariaLabel}
          className={`h-full w-full ${objectFit}`}
        />
      ) : poster ? (
        <img src={poster} alt="" loading="lazy" decoding="async" className={`h-full w-full ${objectFit}`} />
      ) : (
        <div className="skeleton h-full w-full" aria-hidden="true" />
      )}
    </div>
  )
}
