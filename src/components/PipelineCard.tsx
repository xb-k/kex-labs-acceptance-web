import type { DetailResponse } from '../types'
import { formatBytes, formatFrames } from '../format'

type Row = { label: string; value: string; note?: string; mono?: boolean }

export function PipelineCard({ detail }: { detail: DetailResponse }) {
  const { pipeline, sourceMeta } = detail
  const clip = pipeline.clip as
    | {
        codec?: string
        pix_fmt?: string
        colorspace?: string
        crf?: number
        bitrate_mbps?: number
        bytes?: number
        width?: number
        height?: number
        fps?: number
        frames?: number
        duration_s?: number
      }
    | null

  const rows: Row[] = []

  if (sourceMeta) {
    rows.push({
      label: '原始素材',
      value: `${sourceMeta.label} · ${sourceMeta.durationS ?? '—'}s · ${sourceMeta.frames ?? '—'} 帧 @${sourceMeta.fps ?? '—'}fps · ${sourceMeta.width ?? '—'}×${sourceMeta.height ?? '—'}`,
      note: `${sourceMeta.path} · ${formatBytes(sourceMeta.bytes)}`
    })
  }

  if (pipeline.source) {
    rows.push({ label: 's1 素材说明', value: pipeline.source })
  }

  if (pipeline.chain) {
    rows.push({ label: '增强链路', value: pipeline.chain })
  }

  if (pipeline.l1Mode) {
    rows.push({ label: 'L1 调色', value: pipeline.l1Mode })
  }

  if (clip) {
    rows.push({
      label: '输出编码',
      value: `${clip.codec ?? '—'} · ${clip.pix_fmt ?? '—'} · ${clip.colorspace ?? '—'} · CRF ${clip.crf ?? '—'}`,
      note: `${clip.bitrate_mbps ?? '—'} Mbps · ${formatBytes(clip.bytes)}`
    })
    rows.push({
      label: '帧率换算',
      value: formatFrames(clip.frames ?? null, clip.fps ?? null),
      note: sourceMeta
        ? `源 ${sourceMeta.frames} 帧 @${sourceMeta.fps}fps = ${(
            (sourceMeta.frames ?? 0) / (sourceMeta.fps || 1)
          ).toFixed(2)}s；输出 ${clip.frames} 帧 @${clip.fps}fps = ${(
            (clip.frames ?? 0) / (clip.fps || 1)
          ).toFixed(2)}s`
        : undefined
    })
    rows.push({
      label: '输出分辨率',
      value: `${clip.width ?? '—'}×${clip.height ?? '—'}`,
      note: '竖屏 9:16'
    })
  }

  return (
    <section className="card p-4 sm:p-5">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold tracking-tight">参数表</h2>
        <p className="text-xs text-apple-subtext">来自 summary.json / report.md / ffprobe 实读，未做推断。</p>
      </div>

      <dl className="divide-y divide-apple-line text-sm">
        {rows.map((r) => (
          <div key={r.label} className="grid gap-1 py-3 sm:grid-cols-[150px_1fr] sm:gap-4">
            <dt className="text-xs font-medium text-apple-subtext sm:pt-0.5">{r.label}</dt>
            <dd className="min-w-0">
              <p className={r.mono ? 'num break-words' : 'break-words'}>{r.value}</p>
              {r.note && <p className="num mt-1 text-xs leading-relaxed text-apple-subtext">{r.note}</p>}
            </dd>
          </div>
        ))}
      </dl>

      {pipeline.chainSteps && (
        <div className="mt-4 rounded-xl bg-[#FAFAFC] p-3">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-xs font-medium text-apple-subtext">流水线耗时（实测）</p>
            {pipeline.chainTotalS != null && (
              <p className="num text-xs text-apple-subtext">合计 {pipeline.chainTotalS}s</p>
            )}
          </div>
          <ul className="mt-2 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
            {Object.entries(pipeline.chainSteps).map(([step, seconds]) => (
              <li key={step} className="flex items-baseline justify-between gap-3 border-b border-dashed border-apple-line py-1 last:border-b-0">
                <span className="text-apple-subtext">{step}</span>
                <span className="num text-apple-text">{seconds}s</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!clip && !pipeline.chain && <p className="mt-3 text-sm text-apple-subtext">无数据：summary 中没有 clip / chain 字段。</p>}
    </section>
  )
}
