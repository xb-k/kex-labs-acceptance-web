type IconProps = {
  className?: string
}

const base = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true
}

export function ArrowLeft({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M19 12H5M11 18l-6-6 6-6" />
    </svg>
  )
}

export function ChevronRight({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M9 6l6 6-6 6" />
    </svg>
  )
}

export function Play({ className }: IconProps) {
  return (
    <svg {...base} className={className} fill="currentColor" stroke="none">
      <path d="M8 5.5v13l10-6.5-10-6.5z" />
    </svg>
  )
}

export function Pause({ className }: IconProps) {
  return (
    <svg {...base} className={className} fill="currentColor" stroke="none">
      <rect x="7" y="5" width="3.5" height="14" rx="1" />
      <rect x="13.5" y="5" width="3.5" height="14" rx="1" />
    </svg>
  )
}

export function Check({ className }: IconProps) {
  return (
    <svg {...base} className={className} strokeWidth={2.2}>
      <path d="M5 12.5l4.5 4.5L19 7" />
    </svg>
  )
}

export function Cross({ className }: IconProps) {
  return (
    <svg {...base} className={className} strokeWidth={2.2}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  )
}

export function Minus({ className }: IconProps) {
  return (
    <svg {...base} className={className} strokeWidth={2.2}>
      <path d="M5 12h14" />
    </svg>
  )
}

export function VolumeOn({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M4 9v6h4l5 4V5L8 9H4z" />
      <path d="M16.5 8.5a5 5 0 010 7M19 6a8.5 8.5 0 010 12" />
    </svg>
  )
}

export function VolumeOff({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M4 9v6h4l5 4V5L8 9H4z" />
      <path d="M16 9l5 6M21 9l-5 6" />
    </svg>
  )
}

export function Server({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <rect x="3" y="4" width="18" height="7" rx="2" />
      <rect x="3" y="13" width="18" height="7" rx="2" />
      <path d="M7 7.5h.01M7 16.5h.01" />
    </svg>
  )
}

export function Film({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4" />
    </svg>
  )
}

export function Split({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M12 3v18" />
      <path d="M8 7l-4 5 4 5M16 7l4 5-4 5" />
    </svg>
  )
}

export function Chart({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M4 4v16h16" />
      <path d="M7 15l3.5-4.5 3 3L20 7" />
    </svg>
  )
}

export function Grid({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <rect x="3" y="3" width="7.5" height="7.5" rx="1.8" />
      <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.8" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.8" />
      <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.8" />
    </svg>
  )
}

export function Flow({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <rect x="3" y="4" width="6" height="5" rx="1.5" />
      <rect x="15" y="4" width="6" height="5" rx="1.5" />
      <rect x="9" y="15" width="6" height="5" rx="1.5" />
      <path d="M6 9v3h12V9M12 12v3" />
    </svg>
  )
}

export function Sliders({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
      <circle cx="16" cy="7" r="2.2" />
      <circle cx="10" cy="17" r="2.2" />
    </svg>
  )
}

export function Calendar({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <rect x="3" y="5" width="18" height="16" rx="2.5" />
      <path d="M8 3v4M16 3v4M3 10h18" />
    </svg>
  )
}

export function Shield({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M12 21s7-3.5 7-9V5.5L12 3 5 5.5V12c0 5.5 7 9 7 9z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  )
}

export function Folder({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M3 7a2 2 0 012-2h4l2 2.5h8a2 2 0 012 2V18a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
    </svg>
  )
}

export function Upload({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M12 15.5V4M7.5 8.5 12 4l4.5 4.5" />
      <path d="M4.5 15.5v3A2.5 2.5 0 007 21h10a2.5 2.5 0 002.5-2.5v-3" />
    </svg>
  )
}

export function Cpu({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <rect x="5" y="5" width="14" height="14" rx="2" />
      <rect x="9" y="9" width="6" height="6" rx="1" />
      <path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" />
    </svg>
  )
}

export function Menu({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  )
}

/** 回收站（#107 软删）。 */
export function Trash({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M4 7h16M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7" />
      <path d="M6.5 7l.8 11.2A1.8 1.8 0 0 0 9.1 20h5.8a1.8 1.8 0 0 0 1.8-1.8L17.5 7" />
      <path d="M10.5 11v5M13.5 11v5" />
    </svg>
  )
}

export function Close({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  )
}

export function Refresh({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M20 11a8 8 0 10-2.3 5.7" />
      <path d="M20 4v7h-7" />
    </svg>
  )
}

export function Alert({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M12 3.5L2.8 20h18.4L12 3.5z" />
      <path d="M12 9.5v5M12 17.5h.01" />
    </svg>
  )
}

export function TriangleAlert({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M12 3.5L2.8 20h18.4L12 3.5z" fill="currentColor" stroke="none" opacity="0.12" />
      <path d="M12 3.5L2.8 20h18.4L12 3.5z" />
      <path d="M12 9.5v5M12 17.5h.01" />
    </svg>
  )
}

export function Clock({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  )
}

export function ChevronDown({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  )
}

export function Plus({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

/** 外链：方框 + 右上箭头（打开新窗口的语义）。 */
export function ExternalLink({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M14 4h6v6" />
      <path d="M20 4l-8.5 8.5" />
      <path d="M18 14v5a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 014 19V8a1.5 1.5 0 011.5-1.5h5" />
    </svg>
  )
}

/** 收件箱 / issue 语义：托盘 + 下箭头。 */
/** 更多操作：水平三点（菜单触发）。 */
export function More({ className }: IconProps) {
  return (
    <svg {...base} fill="currentColor" stroke="none" className={className}>
      <circle cx="5" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="19" cy="12" r="1.6" />
    </svg>
  )
}

/** 分享：托盘 + 上箭头。 */
export function Share({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M12 4v10" />
      <path d="M8.5 7.5 12 4l3.5 3.5" />
      <path d="M6 12.5V19a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 18 19v-6.5" />
    </svg>
  )
}

export function Inbox({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M4 13.5V19a2 2 0 002 2h12a2 2 0 002-2v-5.5" />
      <path d="M4.5 13.5h4l1.2 2h4.6l1.2-2h4" />
      <path d="M12 3v8M9 8l3 3 3-3" />
    </svg>
  )
}

/** 创作工坊：场记板（新建任务 / 创作语义）。 */
export function Clapper({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M4 10.5h16V19a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19v-8.5z" />
      <path d="M4 10.5 5.2 6.2a1.5 1.5 0 0 1 1.85-1.05l12.2 3.27" />
      <path d="M8.4 8.7 9.4 5.3M12.6 9.8l1-3.4M16.8 10.9l1-3.4" />
    </svg>
  )
}

/** Agent 库：机器人头 + 天线（定义/角色语义）。 */
export function Bot({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <rect x="4.5" y="8" width="15" height="10.5" rx="3" />
      <path d="M12 4.5V8M12 4.5h.01" />
      <circle cx="9.25" cy="12.75" r="1.1" />
      <circle cx="14.75" cy="12.75" r="1.1" />
      <path d="M9.5 15.75h5" />
      <path d="M2.75 12v3M21.25 12v3" />
    </svg>
  )
}

export function Sparkles({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M12 3l1.7 4.8L18.5 9.5l-4.8 1.7L12 16l-1.7-4.8L5.5 9.5l4.8-1.7L12 3z" />
      <path d="M19 15l.8 2.2 2.2.8-2.2.8L19 21l-.8-2.2-2.2-.8 2.2-.8L19 15z" />
    </svg>
  )
}

export function Download({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M12 4v11.5M7.5 11l4.5 4.5 4.5-4.5" />
      <path d="M4.5 16.5v2A2 2 0 006.5 20.5h11a2 2 0 002-2v-2" />
    </svg>
  )
}

export function Copy({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
    </svg>
  )
}

export function FileText({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M14 3.5H7a2 2 0 00-2 2v13a2 2 0 002 2h10a2 2 0 002-2V8.5L14 3.5z" />
      <path d="M14 3.5v5h5M8.5 13h7M8.5 16.5h5" />
    </svg>
  )
}

export function Search({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </svg>
  )
}
