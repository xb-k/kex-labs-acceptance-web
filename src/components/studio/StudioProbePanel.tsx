import { primaryButton } from '../studio-ui'
import { planRiskRows, planStepRows, probeFacts } from '../../studio-probe'
import type { UploadProbeResponse } from '../../studio-probe'

export type ProbeState =
  | { status: 'idle' }
  | { status: 'loading'; uploadId: string }
  | { status: 'ready'; uploadId: string; data: UploadProbeResponse }
  | { status: 'error'; uploadId: string; message: string; reason: string | null }

const RISK_STYLE: Record<'blocked' | 'warn' | 'info', string> = {
  blocked: 'bg-[#FCEDEB] text-[#B3261E] ring-[#F3D3CF]',
  warn: 'bg-[#FBF1E4] text-[#8A4B00] ring-[#F0D9BC]',
  info: 'bg-white text-apple-subtextAlt ring-black/[0.06]'
}

export function StudioProbePanel({
  probe,
  blocked,
  submitting,
  error,
  onRetry,
  onSubmit
}: {
  probe: ProbeState
  /** 关联 Brief 未确认（沿用 A 轨同一门禁）。 */
  blocked: boolean
  submitting: boolean
  error: string | null
  onRetry: () => void
  onSubmit: () => void
}) {
  const facts = probe.status === 'ready' ? probeFacts(probe.data) : []
  const steps = probe.status === 'ready' ? planStepRows(probe.data) : []
  const risks = probe.status === 'ready' ? planRiskRows(probe.data) : []

  return (
    <section
      className="min-w-0 rounded-[12px] border border-black/[0.06] bg-apple-bg/40 px-3.5 py-3"
      aria-labelledby="studio-b-track-title"
      data-testid="studio-probe-panel"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="studio-b-track-title" className="text-[13px] font-medium text-apple-text">
          B 轨增强 · 源片探针
        </h3>
        <div className="flex items-center gap-1.5">
          <span className="num rounded-full bg-white px-2 py-0.5 text-[10px] font-medium text-apple-subtextAlt ring-1 ring-inset ring-black/[0.06]">
            optimize
          </span>
          <span className="num rounded-full bg-white px-2 py-0.5 text-[10px] font-medium text-apple-subtextAlt ring-1 ring-inset ring-black/[0.06]">
            B 轨
          </span>
        </div>
      </div>

      {(probe.status === 'idle' || probe.status === 'loading') && (
        <p className="mt-2 text-[11px] leading-relaxed text-apple-subtext" aria-live="polite">
          正在探测源片：分辨率 / 时长 / 帧率 / 码率 / 音轨 / 镜头切分 / 优化计划…
        </p>
      )}

      {probe.status === 'error' && (
        <div className="mt-2 rounded-[10px] bg-[#FCEDEB] px-3 py-2 text-[11px] leading-relaxed text-[#B3261E] ring-1 ring-inset ring-[#F3D3CF]">
          <p className="break-words" role="alert">
            探针失败：{probe.message}
            {probe.reason ? `（reason: ${probe.reason}）` : ''}
          </p>
          <button
            type="button"
            onClick={onRetry}
            className="mt-1 rounded text-[11px] font-medium underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
          >
            重新探测
          </button>
        </div>
      )}

      {probe.status === 'ready' && (
        <div className="mt-2.5 space-y-2.5">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[11px] sm:grid-cols-3">
            {facts.map((fact) => (
              <div key={fact.label} className="min-w-0">
                <dt className="text-apple-subtext">{fact.label}</dt>
                <dd className="num mt-0.5 break-words">{fact.value}</dd>
              </div>
            ))}
          </dl>

          <div className="min-w-0">
            <p className="text-[11px] font-semibold text-apple-subtext">执行步骤</p>
            {steps.length > 0 ? (
              <ol className="mt-1 space-y-1.5">
                {steps.map((step, index) => (
                  <li key={step.key} className="flex min-w-0 gap-2 text-[12px] leading-relaxed">
                    <span className="num mt-0.5 shrink-0 rounded-full bg-white px-1.5 text-[10px] text-apple-subtext ring-1 ring-inset ring-black/[0.06]">
                      {index + 1}
                    </span>
                    <div className="min-w-0">
                      <p className="break-words font-medium text-apple-text">
                        {step.title}
                        {step.hint && (
                          <span className="ml-1.5 text-[10px] font-normal text-apple-subtext">
                            提示
                          </span>
                        )}
                      </p>
                      {step.detail && (
                        <p className="break-words text-[11px] text-apple-subtext">{step.detail}</p>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="mt-1 text-[11px] text-apple-subtext">计划未给出步骤。</p>
            )}
          </div>

          <div className="min-w-0">
            <p className="text-[11px] font-semibold text-apple-subtext">风险提示</p>
            {risks.length > 0 ? (
              <ul className="mt-1 space-y-1">
                {risks.map((risk, index) => (
                  <li
                    key={`${risk.level}-${index}`}
                    className={`break-words rounded-[8px] px-2.5 py-1.5 text-[11px] leading-relaxed ring-1 ring-inset ${RISK_STYLE[risk.level]}`}
                  >
                    {risk.text}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-[11px] text-[#1E7A3C]">未发现风险。</p>
            )}
          </div>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 text-[11px] leading-relaxed text-apple-subtext">
          {blocked
            ? '关联 Brief 未确认：确认后才能提交 B 轨（不会触发 GPU）。'
            : '确认后按上述计划提交 optimize 任务；任务进入 studio 队列。'}
        </p>
        <button
          type="button"
          data-testid="studio-b-submit"
          onClick={onSubmit}
          disabled={submitting || blocked || probe.status !== 'ready'}
          className={`${primaryButton} shrink-0`}
        >
          {submitting ? '提交中…' : '确认执行 B 轨'}
        </button>
      </div>

      {error && (
        <p
          role="alert"
          className="mt-2 break-words rounded-[10px] bg-[#FCEDEB] px-3 py-2 text-[11px] leading-relaxed text-[#B3261E] ring-1 ring-inset ring-[#F3D3CF]"
        >
          提交失败：{error}
        </p>
      )}
    </section>
  )
}
