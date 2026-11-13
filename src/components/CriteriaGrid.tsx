import type { Criterion } from '../types'
import { ResultMark } from './StatusChip'

export function CriteriaGrid({ criteria, failedNote }: { criteria: Criterion[]; failedNote?: string }) {
  if (criteria.length === 0) {
    return <div className="card p-6 text-sm text-apple-subtext">无数据：summary 中没有任何判据字段。</div>
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold tracking-tight">优化点（判据逐项）</h2>
        <p className="text-xs text-apple-subtext">数值取自 summary 的均值 / 最差段；阈值来自 issue-19 deliverable gate。</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {criteria.map((c) => (
          <article
            key={c.key}
            className={`card flex flex-col p-4 sm:p-5 ${
              c.pass === false ? 'ring-1 ring-inset ring-[#F3D3CF]' : ''
            }`}
          >
            <div className="flex items-start justify-between gap-2">
              <h3 className="text-sm font-medium leading-snug text-apple-text">{c.name}</h3>
              <ResultMark pass={c.pass} />
            </div>
            <p className="num mt-3 text-2xl font-semibold leading-none tracking-tight text-apple-text">{c.value}</p>
            <p className="mt-1.5 text-xs text-apple-subtext">阈值 {c.threshold}</p>
            <p className="mt-3 flex-1 text-xs leading-relaxed text-[#4A4A4F]">{c.explain}</p>
            <p className="mt-3 border-t border-apple-line pt-2 text-xs leading-relaxed text-apple-subtext">
              来源：{c.source}
            </p>
          </article>
        ))}
      </div>
      {failedNote && <p className="mt-3 text-xs leading-relaxed text-[#B3261E]">{failedNote}</p>}
    </div>
  )
}
