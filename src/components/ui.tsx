import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Link } from '../router'
import type { ToastMessage } from '../hooks'

type ErrorBoundaryProps = {
  resetKey?: string
  children: ReactNode
}

type ErrorBoundaryState = {
  error: Error | null
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error !== null) {
      this.setState({ error: null })
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('UI render error:', error, info)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="card p-6" role="alert">
        <p className="text-[11px] font-medium uppercase tracking-[0.06em] text-apple-red">页面渲染异常</p>
        <h2 className="mt-1 text-[17px] font-semibold text-apple-text">当前视图暂时无法渲染</h2>
        <p className="mt-2 break-words text-[13px] leading-relaxed text-apple-subtext">
          {this.state.error.message || '发生了未知渲染错误，可尝试重新渲染或返回总览页。'}
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="press rounded-full bg-apple-text px-3.5 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-black"
          >
            重新渲染
          </button>
          <Link
            to="/"
            onClick={() => this.setState({ error: null })}
            className="press rounded-full border border-black/[0.08] bg-white px-3.5 py-1.5 text-[12px] font-medium text-apple-text transition-colors hover:bg-apple-bg"
          >
            返回工作台总览
          </Link>
        </div>
      </div>
    )
  }
}

export type KpiTone = 'blue' | 'purple' | 'green' | 'orange' | 'gray' | 'red'

const ACCENT: Record<KpiTone, { bar: string; icon: string }> = {
  blue: { bar: 'bg-apple-accentBlue', icon: 'bg-[#EEF5FF] text-apple-blueInk' },
  purple: { bar: 'bg-apple-accentPurple', icon: 'bg-[#F5EEFF] text-[#8E44AD]' },
  green: { bar: 'bg-apple-green', icon: 'bg-[#E9F7EF] text-apple-green' },
  orange: { bar: 'bg-apple-amber', icon: 'bg-[#FEF5E7] text-apple-amber' },
  gray: { bar: 'bg-apple-subtext/40', icon: 'bg-[#F2F2F7] text-apple-subtext' },
  red: { bar: 'bg-apple-red', icon: 'bg-[#FDEDEC] text-apple-red' }
}

export function KpiCard({
  label,
  value,
  unit,
  note,
  icon,
  tone = 'blue',
  onClick,
  testId,
  dataKpi
}: {
  label: string
  value: string | number
  unit?: string
  note?: string
  icon?: ReactNode
  tone?: KpiTone
  onClick?: () => void
  testId?: string
  dataKpi?: string
}) {
  const palette = ACCENT[tone]
  const content = (
    <>
      <span className={`absolute inset-x-0 top-0 h-[3px] ${palette.bar}`} aria-hidden="true" />
      <div className="flex items-start justify-between gap-2">
        <span className="label">{label}</span>
        {icon && (
          <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-[8px] ${palette.icon}`}>
            {icon}
          </span>
        )}
      </div>
      <div className="mt-2.5 flex items-baseline gap-1.5">
        <span className="num text-[28px] font-semibold leading-none tracking-[-0.025em] text-apple-text">
          {value}
        </span>
        {unit && <span className="text-[12px] text-apple-subtext">{unit}</span>}
      </div>
      {note && <p className="mt-2 text-[12px] leading-5 text-apple-subtext">{note}</p>}
    </>
  )

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        data-testid={testId}
        data-kpi={dataKpi}
        className="card card-interactive relative flex h-full w-full flex-col overflow-hidden p-5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
      >
        {content}
      </button>
    )
  }

  return (
    <div
      data-testid={testId}
      data-kpi={dataKpi}
      className="card relative flex h-full flex-col overflow-hidden p-5"
    >
      {content}
    </div>
  )
}

export function ToolButton({
  children,
  onClick,
  disabled,
  active,
  title,
  testId,
  variant = 'default'
}: {
  children: ReactNode
  onClick?: () => void
  disabled?: boolean
  active?: boolean
  title?: string
  testId?: string
  variant?: 'default' | 'primary'
}) {
  const cls =
    variant === 'primary' || active
      ? 'border-apple-text bg-apple-text text-white hover:bg-black'
      : 'border-black/[0.08] bg-white text-apple-text hover:bg-apple-bg'

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      data-testid={testId}
      className={`press inline-flex h-9 items-center gap-1.5 rounded-lg border px-3.5 text-[12px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50 disabled:cursor-not-allowed disabled:opacity-50 ${cls}`}
    >
      {children}
    </button>
  )
}

export function ErrorCard({
  title = '读取失败',
  message,
  onRetry
}: {
  title?: string
  message: string
  onRetry?: () => void
}) {
  return (
    <div className="card p-5" role="alert">
      <p className="text-[14px] font-medium text-apple-red">{title}</p>
      <p className="mt-1 break-words text-[13px] leading-relaxed text-apple-subtext">{message}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="press mt-3 rounded-full bg-apple-text px-3.5 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-black"
        >
          重试
        </button>
      )}
    </div>
  )
}

export function EmptyCard({
  title,
  detail,
  action
}: {
  title: string
  detail?: string
  action?: ReactNode
}) {
  return (
    <div className="card p-8 text-center">
      <p className="text-[14px] font-medium text-apple-text">{title}</p>
      {detail && <p className="mt-1.5 text-[13px] text-apple-subtext">{detail}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  )
}

export function ToastHost({
  toast,
  onClose,
  testId
}: {
  toast: ToastMessage | null
  onClose?: () => void
  testId?: string
}) {
  if (!toast) return null
  const dot =
    toast.tone === 'err' ? 'bg-[#FF453A]' : toast.tone === 'info' ? 'bg-[#64D2FF]' : 'bg-[#30D158]'
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid={testId}
      className="glass-dark fixed bottom-5 left-1/2 z-[60] flex max-w-[92vw] -translate-x-1/2 items-center gap-2.5 rounded-full px-4 py-2 text-[12px] font-medium text-white shadow-lift"
    >
      <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
      <span className="truncate">{toast.text}</span>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭提示"
          className="ml-1 rounded-full px-1.5 py-0.5 text-[11px] text-white/70 transition-colors hover:bg-white/10 hover:text-white"
        >
          关闭
        </button>
      )}
    </div>
  )
}

export function FilterChipGroup<T extends string>({
  label,
  value,
  options,
  onChange
}: {
  label: string
  value: T
  options: Array<{ key: T; label: string; count?: number }>
  onChange: (next: T) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={label}>
      {options.map((opt) => {
        const active = value === opt.key
        return (
          <button
            key={opt.key}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(opt.key)}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50 ${
              active
                ? 'border-apple-text bg-apple-text text-white'
                : 'border-apple-line bg-white text-apple-text hover:bg-[#FAFAFB]'
            }`}
          >
            <span>{opt.label}</span>
            {opt.count !== undefined && (
              <span className={`num ${active ? 'text-white/80' : 'text-apple-subtext'}`}>{opt.count}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}
