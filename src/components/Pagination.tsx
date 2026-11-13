export const DEFAULT_PAGE_SIZE = 10

const PAGE_SIZES = [10, 20, 50] as const

type Props = {
  page: number
  pageSize: number
  total: number
  onPageChange: (page: number) => void
  onPageSizeChange: (pageSize: number) => void
}

const buttonBase =
  'inline-flex h-11 items-center justify-center rounded-full text-[13px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50 disabled:cursor-not-allowed disabled:opacity-40'

const outlineButton = `${buttonBase} border border-black/[0.1] text-apple-text hover:bg-black/[0.03]`

/** 最多 7 个页码槽位；超出时两端补省略号。 */
function pageSlots(current: number, totalPages: number): Array<number | 'gap-left' | 'gap-right'> {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, index) => index + 1)
  }
  if (current <= 4) {
    return [1, 2, 3, 4, 5, 'gap-right', totalPages]
  }
  if (current >= totalPages - 3) {
    return [1, 'gap-left', totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages]
  }
  return [1, 'gap-left', current - 1, current, current + 1, 'gap-right', totalPages]
}

export function Pagination({ page, pageSize, total, onPageChange, onPageSizeChange }: Props) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const slots = pageSlots(page, totalPages)

  return (
    <nav
      aria-label="issue 分页"
      className="mt-5 flex flex-col gap-3 border-t border-apple-line pt-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between"
    >
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="每页条数">
        <span className="text-[11px] text-apple-subtext">每页</span>
        {PAGE_SIZES.map((size) => {
          const active = size === pageSize
          return (
            <button
              key={size}
              type="button"
              aria-pressed={active}
              onClick={() => onPageSizeChange(size)}
              className={`${buttonBase} min-w-[48px] px-3 ${
                active
                  ? 'bg-apple-blue text-white hover:bg-[#0062C4]'
                  : 'border border-black/[0.1] text-apple-text hover:bg-black/[0.03]'
              }`}
            >
              {size}
            </button>
          )
        })}
        <span className="text-[11px] text-apple-subtext">条</span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          data-testid="pagination-prev"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          className={`${outlineButton} min-w-[44px] px-3`}
        >
          上一页
        </button>

        {slots.map((slot) =>
          typeof slot === 'number' ? (
            <button
              key={slot}
              type="button"
              aria-current={slot === page ? 'page' : undefined}
              aria-label={`第 ${slot} 页`}
              onClick={() => onPageChange(slot)}
              className={`${buttonBase} min-w-[36px] px-2 ${
                slot === page
                  ? 'bg-apple-blue text-white hover:bg-[#0062C4]'
                  : 'border border-black/[0.1] text-apple-text hover:bg-black/[0.03]'
              }`}
            >
              {slot}
            </button>
          ) : (
            <span
              key={slot}
              aria-hidden="true"
              className="inline-flex h-11 w-6 items-center justify-center text-xs text-apple-subtextAlt"
            >
              …
            </span>
          )
        )}

        <button
          type="button"
          data-testid="pagination-next"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
          className={`${outlineButton} min-w-[44px] px-3`}
        >
          下一页
        </button>
      </div>
    </nav>
  )
}
