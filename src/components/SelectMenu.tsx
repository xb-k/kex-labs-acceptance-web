import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from './icons'

export type SelectMenuOption = {
  value: string
  label: string
  hint?: string
  disabled?: boolean
}

export type SelectMenuSize = 'sm' | 'md' | 'lg'

type MenuPlacement = {
  top?: number
  bottom?: number
  left?: number
  right?: number
  minWidth: number
  openUp: boolean
}

const TRIGGER_SIZE_CLASSES: Record<SelectMenuSize, string> = {
  sm: 'h-8 px-2.5 text-xs',
  md: 'h-9 px-3 text-[12.5px]',
  lg: 'h-10 px-3 text-[13px]'
}

export function SelectMenu({
  id,
  value,
  options,
  onChange,
  placeholder = '请选择…',
  disabled = false,
  ariaLabel,
  testId,
  size = 'md',
  numeric = false,
  className = '',
  menuClassName = '',
  align = 'left'
}: {
  id?: string
  value: string
  options: SelectMenuOption[]
  onChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
  ariaLabel?: string
  testId?: string
  size?: SelectMenuSize
  numeric?: boolean
  className?: string
  menuClassName?: string
  align?: 'left' | 'right'
}) {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState<number>(-1)
  const [placement, setPlacement] = useState<MenuPlacement>({ minWidth: 160, openUp: false })
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listboxRef = useRef<HTMLUListElement>(null)
  const listboxId = useId()

  const selectedIndex = useMemo(
    () => options.findIndex((opt) => opt.value === value),
    [options, value]
  )
  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : null

  const updatePlacement = useCallback(() => {
    if (!triggerRef.current || typeof window === 'undefined') return
    const rect = triggerRef.current.getBoundingClientRect()
    const spaceBelow = window.innerHeight - rect.bottom
    const openUp = spaceBelow < 252 && rect.top > spaceBelow
    const minWidth = Math.max(120, Math.round(rect.width))

    if (align === 'right') {
      const right = Math.max(8, window.innerWidth - rect.right)
      setPlacement({
        ...(openUp ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }),
        right,
        minWidth,
        openUp
      })
    } else {
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - minWidth - 8))
      setPlacement({
        ...(openUp ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }),
        left,
        minWidth,
        openUp
      })
    }
  }, [align])

  useEffect(() => {
    if (!open) return
    updatePlacement()
    const initialIdx = selectedIndex >= 0 ? selectedIndex : options.findIndex((o) => !o.disabled)
    setActiveIndex(initialIdx)

    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (
        containerRef.current?.contains(target) ||
        listboxRef.current?.contains(target)
      ) {
        return
      }
      setOpen(false)
    }

    const findFirstEnabled = () => options.findIndex((o) => !o.disabled)
    const findLastEnabled = () => {
      for (let i = options.length - 1; i >= 0; i -= 1) {
        if (!options[i]?.disabled) return i
      }
      return -1
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setOpen(false)
        triggerRef.current?.focus()
      } else if (e.key === 'Home') {
        e.preventDefault()
        setActiveIndex(findFirstEnabled())
      } else if (e.key === 'End') {
        e.preventDefault()
        setActiveIndex(findLastEnabled())
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIndex((prev) => {
          for (let step = 1; step <= options.length; step += 1) {
            const next = (Math.max(prev, -1) + step) % options.length
            if (!options[next]?.disabled) return next
          }
          return prev
        })
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIndex((prev) => {
          for (let step = 1; step <= options.length; step += 1) {
            const next = ((prev < 0 ? 0 : prev) - step + options.length) % options.length
            if (!options[next]?.disabled) return next
          }
          return prev
        })
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        const picked = options[activeIndex]
        if (picked && !picked.disabled) {
          onChange(picked.value)
          setOpen(false)
          triggerRef.current?.focus()
        }
      } else if (e.key === 'Tab') {
        setOpen(false)
      }
    }

    const onReposition = () => updatePlacement()

    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('scroll', onReposition, true)
    window.addEventListener('resize', onReposition)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', onReposition, true)
      window.removeEventListener('resize', onReposition)
    }
  }, [open, options, selectedIndex, activeIndex, onChange, updatePlacement])

  useEffect(() => {
    if (!open || activeIndex < 0 || !listboxRef.current) return
    const items = listboxRef.current.querySelectorAll<HTMLElement>('[role="option"]')
    const activeEl = items[activeIndex]
    if (activeEl && typeof activeEl.scrollIntoView === 'function') {
      activeEl.scrollIntoView({ block: 'nearest' })
    }
  }, [open, activeIndex])

  const menuList = open ? (
    <ul
      ref={listboxRef}
      id={listboxId}
      role="listbox"
      aria-label={ariaLabel}
      style={{
        position: 'fixed',
        top: placement.top,
        bottom: placement.bottom,
        left: placement.left,
        right: placement.right,
        minWidth: placement.minWidth
      }}
      className={`popover-surface z-[90] max-h-[264px] w-max max-w-[min(92vw,380px)] overflow-y-auto rounded-[12px] border border-black/[0.08] bg-white p-1 shadow-[0_14px_34px_rgba(0,0,0,0.14)] ${
        placement.openUp ? 'origin-bottom' : 'origin-top'
      } ${menuClassName}`}
    >
      {options.length === 0 ? (
        <li className="px-3 py-2 text-xs text-apple-subtext">暂无可选项</li>
      ) : (
        options.map((opt, idx) => {
          const isSelected = opt.value === value
          const isHighlighted = idx === activeIndex
          return (
            <li key={opt.value} role="option" aria-selected={isSelected}>
              <button
                type="button"
                disabled={opt.disabled}
                onMouseEnter={() => setActiveIndex(idx)}
                onClick={() => {
                  if (opt.disabled) return
                  onChange(opt.value)
                  setOpen(false)
                  triggerRef.current?.focus()
                }}
                className={`flex w-full items-center justify-between gap-2.5 rounded-[8px] px-2.5 py-1.5 text-left text-[12.5px] transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
                  numeric ? 'num' : ''
                } ${
                  isSelected
                    ? 'bg-[#EAF2FF] font-medium text-apple-blueInk'
                    : isHighlighted
                      ? 'bg-[#F5F5F7] text-apple-text'
                      : 'text-apple-text hover:bg-[#F5F5F7]'
                }`}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="grid h-3.5 w-3.5 shrink-0 place-items-center">
                    {isSelected && <Check className="h-3.5 w-3.5 text-apple-blueInk" />}
                  </span>
                  <span className="truncate">{opt.label}</span>
                </span>
                {opt.hint && (
                  <span className="shrink-0 text-[10.5px] text-apple-subtext">{opt.hint}</span>
                )}
              </button>
            </li>
          )
        })
      )}
    </ul>
  ) : null

  return (
    <div ref={containerRef} className={`relative w-full min-w-0 ${className}`}>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        data-testid={testId}
        data-select-size={size}
        disabled={disabled}
        onClick={() => !disabled && setOpen((prev) => !prev)}
        className={`flex w-full min-w-0 items-center justify-between gap-2 rounded-[10px] border bg-white text-left text-apple-text shadow-[0_1px_1px_rgba(0,0,0,0.02)] transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/25 disabled:cursor-not-allowed disabled:bg-[#FAFAFC] disabled:text-apple-subtext ${
          open
            ? 'border-apple-blue ring-2 ring-apple-blue/15'
            : 'border-black/[0.1] hover:border-black/[0.2]'
        } ${TRIGGER_SIZE_CLASSES[size]} ${numeric ? 'num' : ''}`}
      >
        <span className={`min-w-0 flex-1 truncate font-medium ${!selectedOption ? 'text-apple-subtext' : ''}`}>
          {selectedOption ? selectedOption.label : placeholder}
        </span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-apple-subtext transition-transform duration-150 ${open ? 'rotate-180 text-apple-blueInk' : ''}`}
        />
      </button>

      {menuList && (typeof document !== 'undefined' ? createPortal(menuList, document.body) : menuList)}
    </div>
  )
}
