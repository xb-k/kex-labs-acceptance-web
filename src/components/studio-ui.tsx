import type { ReactNode } from 'react'

/** Brief 画幅选项（StudioPage 表单与 Brief 工作台共用）。 */
export const ASPECTS = [
  { value: '', label: '不指定' },
  { value: '16:9', label: '16:9 横屏' },
  { value: '9:16', label: '9:16 竖屏' },
  { value: '1:1', label: '1:1 方形' },
  { value: '4:5', label: '4:5 竖版' }
]

/** Studio 表单的共享控件样式（#87 从 StudioPage 抽出，Brief 工作台复用同一套 token）。 */
export const inputClass =
  'h-10 w-full rounded-[10px] border border-black/[0.1] bg-white px-3 text-sm text-apple-text transition-colors placeholder:text-apple-subtext/70 focus:border-apple-blue focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/25'

export const primaryButton =
  'h-10 rounded-full bg-apple-blue px-4 text-[13px] font-medium text-white transition-colors hover:bg-[#0062C4] focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50 disabled:cursor-not-allowed disabled:opacity-55'

export const quietButton =
  'h-10 rounded-full border border-black/[0.1] px-4 text-[13px] font-medium text-apple-text transition-colors hover:bg-black/[0.03] focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50 disabled:cursor-not-allowed disabled:opacity-55'

export function Field({
  id,
  label,
  hint,
  optional,
  children
}: {
  id: string
  label: string
  hint?: string
  optional?: boolean
  children: ReactNode
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-[13px] font-medium text-apple-text">
          {label}
          {optional && <span className="ml-1 text-[11px] font-normal text-apple-subtext">可选</span>}
        </label>
      </div>
      <div className="mt-1.5">{children}</div>
      {hint && <p className="mt-1 text-[11px] leading-relaxed text-apple-subtext">{hint}</p>}
    </div>
  )
}
