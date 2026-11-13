import { useEffect, useState } from 'react'

export type LogoVariant = 'aperture' | 'rail' | 'slate'

export const LOGO_OPTIONS: Array<{
  id: LogoVariant
  code: string
  name: string
  subtitle: string
  rationale: string
}> = [
  {
    id: 'aperture',
    code: '方向 A',
    name: 'Aperture-K · 取景框光路',
    subtitle: '推荐方案 · 光学精密感',
    rationale: '圆角取景画框内嵌入斜切胶片光路构成的 K，中心 16:9 裁切角暗喻实拍拆帧重构与导演视窗。'
  },
  {
    id: 'rail',
    code: '方向 B',
    name: 'Phase-Rail · 六阶光轨',
    subtitle: '流水线工程感',
    rationale: '六道递进光栅斜切组成 K 字形，直接对应 Phase A→F 六阶段独占串行流水线与断点续跑节奏。'
  },
  {
    id: 'slate',
    code: '方向 C',
    name: 'Node-Slate · 节点场记板',
    subtitle: '多智能体编排感',
    rationale: '电影场记板斜纹结合三枚拓扑协同节点，直观传达「多角色 Agent 协同制片」与「视频工作坊」。'
  }
]

const STORAGE_KEY = 'kex.logo.variant'
const EVENT_NAME = 'kex-logo-change'

export function readStoredLogoVariant(): LogoVariant {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === 'aperture' || raw === 'rail' || raw === 'slate') return raw
  } catch {
    // ignore storage errors
  }
  return 'slate'
}

export function setStoredLogoVariant(variant: LogoVariant) {
  try {
    window.localStorage.setItem(STORAGE_KEY, variant)
  } catch {
    // ignore storage errors
  }
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: variant }))
}

export function useLogoVariant(): [LogoVariant, (next: LogoVariant) => void] {
  const [variant, setVariant] = useState<LogoVariant>(() =>
    typeof window === 'undefined' ? 'slate' : readStoredLogoVariant()
  )

  useEffect(() => {
    const onChange = (event: Event) => {
      const detail = (event as CustomEvent<LogoVariant>).detail
      if (detail === 'aperture' || detail === 'rail' || detail === 'slate') {
        setVariant(detail)
      }
    }
    window.addEventListener(EVENT_NAME, onChange)
    return () => window.removeEventListener(EVENT_NAME, onChange)
  }, [])

  const update = (next: LogoVariant) => {
    setVariant(next)
    setStoredLogoVariant(next)
  }

  return [variant, update]
}

export function LogoMark({
  variant = 'aperture',
  size = 28,
  dark = false
}: {
  variant?: LogoVariant
  size?: number
  dark?: boolean
}) {
  const bg = dark ? '#18181B' : '#1D1D1F'
  const stroke = '#FFFFFF'
  const accent = '#0A84FF'

  if (variant === 'rail') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
        className="shrink-0"
      >
        <rect width="32" height="32" rx="8" fill={bg} />
        {/* 6-phase vertical/angled K rails */}
        <rect x="7" y="7" width="2.6" height="18" rx="1.3" fill={stroke} />
        <rect x="11.5" y="14.7" width="3.5" height="2.6" rx="1.3" fill={accent} />
        <path d="M15 14.5L22.5 7.5" stroke={stroke} strokeWidth="2.4" strokeLinecap="round" />
        <path d="M15 17.5L22.5 24.5" stroke={stroke} strokeWidth="2.4" strokeLinecap="round" />
        <circle cx="24" cy="8" r="1.6" fill={accent} />
        <circle cx="24" cy="24" r="1.6" fill="rgba(255,255,255,0.55)" />
        <path d="M7 27.5H25" stroke="rgba(255,255,255,0.22)" strokeWidth="1.2" strokeLinecap="round" strokeDasharray="2 2.2" />
      </svg>
    )
  }

  if (variant === 'slate') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
        className="shrink-0"
      >
        <rect width="32" height="32" rx="8" fill={bg} />
        {/* Clapper top bar */}
        <path d="M6.5 10.5H25.5" stroke="rgba(255,255,255,0.28)" strokeWidth="1.2" />
        <path d="M9.5 6.5L12 10.5M15.5 6.5L18 10.5M21.5 6.5L24 10.5" stroke="rgba(255,255,255,0.75)" strokeWidth="1.5" strokeLinecap="round" />
        {/* Topology K inside slate */}
        <path d="M10 14V24.5M10 19.2L19.5 14M13.5 17.3L21 24.5" stroke={stroke} strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="10" cy="14" r="1.8" fill={stroke} />
        <circle cx="20.5" cy="14" r="2" fill={accent} />
        <circle cx="21.5" cy="24.2" r="1.8" fill={stroke} />
      </svg>
    )
  }

  // Default: Aperture-K (direction A)
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className="shrink-0"
    >
      <rect width="32" height="32" rx="8" fill={bg} />
      {/* Precision viewfinder corners */}
      <path
        d="M6.5 10.5V7.5C6.5 6.95 6.95 6.5 7.5 6.5H10.5M21.5 6.5H24.5C25.05 6.5 25.5 6.95 25.5 7.5V10.5M25.5 21.5V24.5C25.5 25.05 25.05 25.5 24.5 25.5H21.5M10.5 25.5H7.5C6.95 25.5 6.5 25.05 6.5 24.5V21.5"
        stroke="rgba(255,255,255,0.34)"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      {/* Optical K beam */}
      <path d="M11 9.5V22.5" stroke={stroke} strokeWidth="2.4" strokeLinecap="round" />
      <path d="M21 9.5L12.5 16L21 22.5" stroke={stroke} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="21.2" cy="9.5" r="2" fill={accent} />
    </svg>
  )
}

export function BrandLockup({
  variant,
  subtitle = 'AI 视频制片台',
  compact = false
}: {
  variant?: LogoVariant
  subtitle?: string
  compact?: boolean
}) {
  const [stored] = useLogoVariant()
  const active = variant ?? stored
  return (
    <span className="flex items-center gap-2.5 whitespace-nowrap shrink-0">
      <LogoMark variant={active} size={compact ? 26 : 30} />
      <span className="leading-tight">
        <span className="block text-[14.5px] font-semibold tracking-[-0.025em] text-apple-text">
          Kex Labs
        </span>
        {subtitle && <span className="block text-[11px] text-apple-subtext">{subtitle}</span>}
      </span>
    </span>
  )
}
