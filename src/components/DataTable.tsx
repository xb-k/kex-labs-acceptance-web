import type { ReactNode } from 'react'

export type Column<T> = {
  key: string
  label: string
  /** 桌面表格里的额外 class（对齐 / 宽度 / 等宽） */
  className?: string
  cell: (row: T) => ReactNode
}

/**
 * 只读数据表：桌面渲染真表格，窄屏（<768）转成「标签 / 值」卡片列表，
 * 避免横向溢出。只做展示，不带排序与交互。
 *
 * 密度/行态可选注入（默认保持旧样式，不影响其它页面）：
 * - rowAlign / rowHeightClass：桌面行垂直对齐与最小行高
 * - rowClassName：按行注入 class（如异常行浅红底）
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  empty,
  rowAlign = 'top',
  rowHeightClass = '',
  rowClassName
}: {
  columns: Column<T>[]
  rows: T[]
  rowKey: (row: T, index: number) => string
  empty: ReactNode
  rowAlign?: 'top' | 'middle'
  rowHeightClass?: string
  rowClassName?: (row: T) => string
}) {
  if (rows.length === 0) {
    return <p className="text-xs leading-relaxed text-apple-subtext">{empty}</p>
  }

  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full border-collapse text-left text-[11px] leading-5">
          <thead>
            <tr>
              {columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className={`whitespace-nowrap border-b border-apple-line/80 pb-1.5 pr-3 font-medium text-apple-subtext last:pr-0 ${column.className ?? ''}`}
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-apple-line/60">
            {rows.map((row, index) => (
              <tr
                key={rowKey(row, index)}
                className={`${rowAlign === 'middle' ? 'align-middle' : 'align-top'} ${rowHeightClass} ${rowClassName?.(row) ?? ''}`}
              >
                {columns.map((column) => (
                  <td key={column.key} className={`py-1.5 pr-3 last:pr-0 ${column.className ?? ''}`}>
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="space-y-2 md:hidden">
        {rows.map((row, index) => (
          <li key={rowKey(row, index)} className="rounded-lg border border-black/[0.06] bg-apple-bg/70 px-2.5 py-2">
            <dl className="space-y-1 text-[11px] leading-5">
              {columns.map((column) => (
                <div key={column.key} className="flex items-start justify-between gap-3">
                  <dt className="shrink-0 text-apple-subtext">{column.label}</dt>
                  <dd className="min-w-0 break-words text-right">{column.cell(row)}</dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
    </>
  )
}
