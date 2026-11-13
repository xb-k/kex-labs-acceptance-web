import type { SnapshotRule } from '../types'
import { explainRule } from '../qc-explain'

const VERDICT_LABEL: Record<'pass' | 'fail', string> = { pass: '通过', fail: '未通过' }

/** 契约 §4：阈值只做 op / threshold / unit 的拼接展示，不在前端重算或改值。 */
export function thresholdText(rule: SnapshotRule): string {
  if (rule.threshold === null || !rule.op) return '—'
  return `${rule.op} ${rule.threshold}${rule.unit ? ` ${rule.unit}` : ''}`
}

function verdictLabel(rule: SnapshotRule): string {
  if (rule.actual === null) return '无数据'
  if (rule.verdict === null) return '—'
  return VERDICT_LABEL[rule.verdict]
}

function VerdictTag({ rule }: { rule: SnapshotRule }) {
  const tone =
    rule.actual === null || rule.verdict === null
      ? 'bg-[#F2F2F4] text-[#5F5F66] ring-[#E5E5EA]'
      : rule.verdict === 'pass'
        ? 'bg-[#EAF8EE] text-[#1E7A3C] ring-[#CDEED6]'
        : 'bg-[#FCEDEB] text-[#B3261E] ring-[#F3D3CF]'
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ring-inset ${tone}`}>
      {verdictLabel(rule)}
    </span>
  )
}

function ProfessionalName({ rule }: { rule: SnapshotRule }) {
  return (
    <>
      <span className="font-medium text-apple-text">{rule.name}</span>
      <span className="num ml-1.5 break-all text-[10px] text-apple-subtext">{rule.id}</span>
    </>
  )
}

/** 带解释层的规则清单（#106）：专业字段不动，另加「白话 / 建议动作」；390 转纵向卡片。 */
function ExplainedRules({ rules, source }: { rules: SnapshotRule[]; source?: string | null }) {
  return (
    <>
      <div className="mt-3 hidden overflow-x-auto md:block" data-testid="qc-rules-table">
        <table className="w-full min-w-[1040px] text-left text-xs">
          <thead className="text-[11px] text-apple-subtext">
            <tr className="border-b border-black/[0.06]">
              <th className="py-2 pr-3 font-medium">规则（专业名 / id）</th>
              <th className="py-2 pr-3 font-medium">阈值（op / unit）</th>
              <th className="py-2 pr-3 text-right font-medium">实际值</th>
              <th className="py-2 pr-3 text-right font-medium">判定</th>
              <th className="py-2 pr-3 font-medium">白话解释</th>
              <th className="py-2 font-medium">建议动作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-black/[0.05]">
            {rules.map((rule) => {
              const explanation = explainRule(rule.id)
              return (
                <tr
                  key={rule.id}
                  data-testid={`qc-rule-${rule.id}`}
                  data-rule-id={rule.id}
                  data-threshold={thresholdText(rule)}
                  data-actual={rule.actual ?? ''}
                  data-verdict={rule.verdict ?? 'unavailable'}
                  data-plain={explanation.plain}
                  data-action={explanation.action}
                  className="align-top"
                >
                  <td className="max-w-[240px] py-2.5 pr-3">
                    <ProfessionalName rule={rule} />
                  </td>
                  <td className="num max-w-[180px] py-2.5 pr-3 break-words">{thresholdText(rule)}</td>
                  <td className="num py-2.5 pr-3 text-right">{rule.actual === null ? '无数据' : String(rule.actual)}</td>
                  <td className="py-2.5 pr-3 text-right">
                    <VerdictTag rule={rule} />
                  </td>
                  <td className="max-w-[300px] py-2.5 pr-3 leading-5">
                    <p className="text-[#3A3A3F]">{explanation.plain}</p>
                    <p className="mt-0.5 text-[11px] leading-4 text-apple-subtext">{explanation.why}</p>
                  </td>
                  <td className="max-w-[240px] py-2.5 leading-5 text-[#3A3A3F]">{explanation.action}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <ul className="mt-3 space-y-3 md:hidden" data-testid="qc-rules-cards">
        {rules.map((rule) => {
          const explanation = explainRule(rule.id)
          return (
            <li
              key={rule.id}
              data-testid={`qc-rule-card-${rule.id}`}
              data-rule-id={rule.id}
              data-threshold={thresholdText(rule)}
              data-actual={rule.actual ?? ''}
              data-verdict={rule.verdict ?? 'unavailable'}
              data-plain={explanation.plain}
              data-action={explanation.action}
              className="rounded-panel border border-black/[0.06] bg-[#FBFBFD] p-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <ProfessionalName rule={rule} />
                </div>
                <VerdictTag rule={rule} />
              </div>
              <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
                <div>
                  <dt className="text-apple-subtext">阈值</dt>
                  <dd className="num mt-0.5 break-words">{thresholdText(rule)}</dd>
                </div>
                <div className="text-right">
                  <dt className="text-apple-subtext">实际值</dt>
                  <dd className="num mt-0.5">{rule.actual === null ? '无数据' : String(rule.actual)}</dd>
                </div>
              </dl>
              <p className="mt-2 text-xs leading-5 text-[#3A3A3F]">{explanation.plain}</p>
              <p className="mt-0.5 text-[11px] leading-4 text-apple-subtext">{explanation.why}</p>
              <p className="mt-2 rounded-lg bg-white px-2.5 py-1.5 text-[11px] leading-4 text-[#3A3A3F] ring-1 ring-inset ring-black/[0.05]">
                <span className="font-medium">怎么做：</span>
                {explanation.action}
              </p>
            </li>
          )
        })}
      </ul>

      {source && <p className="num mt-2 break-all text-[11px] text-apple-subtext">规则源 {source}</p>}
    </>
  )
}

/** `/qc` 规则清单：数据只来自 `/api/qc/summary` / `/api/qc/:id` 的 rules，actual 缺失显「无数据」。 */
export function QcRuleList({
  rules,
  source,
  explain = false
}: {
  rules: SnapshotRule[]
  source?: string | null
  explain?: boolean
}) {
  if (!rules.length) {
    return <p className="mt-3 text-xs text-apple-subtext">规则清单不可用。</p>
  }
  if (explain) return <ExplainedRules rules={rules} source={source} />
  return (
    <div className="mt-3 overflow-x-auto" data-testid="qc-rules-table">
      <table className="w-full min-w-[520px] text-left text-xs">
        <thead className="text-[11px] text-apple-subtext">
          <tr className="border-b border-black/[0.06]">
            <th className="py-2 pr-3 font-medium">名称</th>
            <th className="py-2 pr-3 font-medium">阈值（op / unit）</th>
            <th className="py-2 pr-3 text-right font-medium">实际值</th>
            <th className="py-2 text-right font-medium">判定</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-black/[0.05]">
          {rules.map((rule) => {
            const threshold = thresholdText(rule)
            const missing = rule.actual === null
            return (
              <tr
                key={rule.id}
                data-testid={`qc-rule-${rule.id}`}
                data-rule-id={rule.id}
                data-threshold={threshold}
                data-actual={rule.actual ?? ''}
                data-verdict={rule.verdict ?? 'unavailable'}
              >
                <td className="py-2 pr-3">
                  <span className="font-medium text-apple-text">{rule.name}</span>
                  <span className="num ml-1.5 break-all text-[10px] text-apple-subtext">{rule.id}</span>
                </td>
                <td className="num py-2 pr-3 break-words">{threshold}</td>
                <td className="num py-2 pr-3 text-right">{missing ? '无数据' : String(rule.actual)}</td>
                <td className="py-2 text-right">
                  {missing ? '无数据' : rule.verdict === null ? '—' : VERDICT_LABEL[rule.verdict]}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {source && <p className="num mt-2 break-all text-[11px] text-apple-subtext">规则源 {source}</p>}
    </div>
  )
}
