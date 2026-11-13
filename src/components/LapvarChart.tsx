import { useMemo, useState, type PointerEvent } from 'react'
import type { QcRow } from '../types'

type Point = {
  t: number
  frame: number
  orig: number
  out: number
  ratio: number | null
  ssim: number | null
}

const W = 960
const H = 400
const M = { l: 56, r: 22, t: 20, b: 46 }
const PLOT_W = W - M.l - M.r
const PLOT_H = H - M.t - M.b
const Y_MIN = 4
const Y_MAX = 4200
const LOG_MIN = Math.log10(Y_MIN)
const LOG_MAX = Math.log10(Y_MAX)
const Y_TICKS = [5, 16.3, 100, 1000, 3000]

/** 警戒线：spec 要求 lapvar < 5.0 橙红高亮；其余阈值保持次要虚线。 */
const WARN_VALUE = 5

const num = (v: string | number | undefined): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/**
 * Catmull-Rom → 三次贝塞尔，得到 Apple Health 风格的平滑折线。
 * 控制点按像素坐标计算，并把 y 夹在绘图区内，避免过冲画进坐标轴。
 */
function smoothPath(points: Point[], xOf: (t: number) => number, yOf: (v: number) => number, key: 'orig' | 'out') {
  if (points.length === 0) return ''
  const px = points.map((p) => xOf(p.t))
  const py = points.map((p) => yOf(p[key]))
  const clampY = (value: number) => Math.min(M.t + PLOT_H, Math.max(M.t, value))

  let d = `M${px[0].toFixed(2)},${py[0].toFixed(2)}`
  for (let i = 0; i < points.length - 1; i += 1) {
    const x0 = px[i - 1] ?? px[i]
    const y0 = clampY(py[i - 1] ?? py[i])
    const x1 = px[i]
    const y1 = py[i]
    const x2 = px[i + 1]
    const y2 = py[i + 1]
    const x3 = px[i + 2] ?? x2
    const y3 = clampY(py[i + 2] ?? py[i + 1])

    const c1x = x1 + (x2 - x0) / 6
    const c1y = clampY(y1 + (y2 - y0) / 6)
    const c2x = x2 - (x3 - x1) / 6
    const c2y = clampY(y2 - (y3 - y1) / 6)
    d += ` C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${x2.toFixed(2)},${y2.toFixed(2)}`
  }
  return d
}

export function LapvarChart({
  rows,
  thresholds
}: {
  rows: QcRow[]
  thresholds: { label: string; value: number; note: string }[]
}) {
  const [hover, setHover] = useState<number | null>(null)

  const points = useMemo<Point[]>(() => {
    return rows
      .map((r) => {
        const t = num(r.t_src)
        const orig = num(r.lapvar_orig)
        const out = num(r.lapvar_out)
        if (t == null || orig == null || out == null) return null
        return {
          t,
          frame: num(r.frame) ?? 0,
          orig,
          out,
          ratio: num(r.lap_ratio),
          ssim: num(r.ssim)
        }
      })
      .filter((p): p is Point => p !== null)
  }, [rows])

  const xMaxRaw = points.length ? points[points.length - 1].t : 1
  const xMax = Math.max(1, Math.ceil(xMaxRaw * 10) / 10)

  const x = (t: number) => M.l + (Math.min(t, xMax) / xMax) * PLOT_W
  const y = (v: number) => {
    const clamped = Math.min(Math.max(v, Y_MIN), Y_MAX)
    return M.t + ((LOG_MAX - Math.log10(clamped)) / (LOG_MAX - LOG_MIN)) * PLOT_H
  }

  const origPath = smoothPath(points, x, y, 'orig')
  const outPath = smoothPath(points, x, y, 'out')
  const areaPath = points.length
    ? `${outPath} L${x(points[points.length - 1].t).toFixed(2)},${M.t + PLOT_H} L${x(points[0].t).toFixed(2)},${
        M.t + PLOT_H
      } Z`
    : ''

  const xTicks = Array.from({ length: Math.floor(xMax) + 1 }, (_, i) => i)
  const active = hover != null ? points[hover] : null

  const handleMove = (event: PointerEvent<SVGSVGElement>) => {
    if (points.length === 0) return
    const rect = event.currentTarget.getBoundingClientRect()
    const viewX = ((event.clientX - rect.left) / rect.width) * W
    const t = ((viewX - M.l) / PLOT_W) * xMax
    let best = 0
    let bestDelta = Infinity
    points.forEach((p, i) => {
      const d = Math.abs(p.t - t)
      if (d < bestDelta) {
        bestDelta = d
        best = i
      }
    })
    setHover(best)
  }

  if (points.length === 0) {
    return (
      <div className="rounded-2xl bg-[#FAFAFC] px-5 py-12 text-center">
        <p className="text-sm font-medium text-apple-text">暂无 QC 曲线数据</p>
        <p className="mx-auto mt-1.5 max-w-[46ch] text-xs leading-relaxed text-apple-subtext">
          metrics.csv 里没有同时含 t_src / lapvar_orig / lapvar_out 的行；不补点、不插值。
        </p>
      </div>
    )
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-xs" data-testid="qc-chart-legend">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="inline-flex items-center gap-1.5 text-apple-subtext">
            <span className="h-0.5 w-5 rounded bg-[#30A14E]" aria-hidden="true" />
            当前 lapvar_out（输出）
          </span>
          <span className="inline-flex items-center gap-1.5 text-apple-subtext">
            <span className="h-0.5 w-5 rounded bg-[#B9B9BE]" aria-hidden="true" />
            原片 lapvar_orig
          </span>
          <span className="inline-flex items-center gap-1.5 text-apple-subtext">
            <span className="h-0 w-5 border-t-2 border-dashed border-[#FF6B3D]" aria-hidden="true" />
            警戒线 lapvar &lt; 5.0
          </span>
          {thresholds
            .filter((threshold) => Math.abs(threshold.value - WARN_VALUE) >= 1e-6)
            .map((threshold) => (
              <span key={`${threshold.label}-${threshold.value}`} className="inline-flex items-center gap-1.5 text-apple-subtext">
                <span className="h-0 w-5 border-t border-dashed border-[#B9B9BE]" aria-hidden="true" />
                {threshold.label} {threshold.value}
              </span>
            ))}
        </div>
        <p className="num text-apple-subtext">
          {active
            ? `t=${active.t.toFixed(3)}s · frame ${active.frame} · 原 ${active.orig.toFixed(1)} · 出 ${active.out.toFixed(1)} · 比值 ${
                active.ratio == null ? '—' : active.ratio.toFixed(3)
              } · SSIM ${active.ssim == null ? '—' : active.ssim.toFixed(4)}`
            : '悬停查看逐帧数值'}
        </p>
      </div>
      <p className="mt-1.5 text-[11px] leading-5 text-apple-subtext">
        纵轴是清晰度指标 lapvar：数值越高，画面细节越多、越清晰；跌到橙红警戒线以下说明这一帧偏软。灰色虚线是后端给的其它参考阈值。
      </p>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="mt-2 h-auto w-full select-none"
        role="img"
        aria-label={`lapvar 曲线，原片与输出各 ${points.length} 帧，时间 0 到 ${xMax} 秒，纵轴对数；橙红虚线为 5.0 警戒线`}
        onPointerMove={handleMove}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id="lapvar-out-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#30A14E" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#30A14E" stopOpacity="0" />
          </linearGradient>
        </defs>

        <rect x={M.l} y={M.t} width={PLOT_W} height={PLOT_H} fill="#FBFBFD" rx="10" />

        {Y_TICKS.map((tick) => (
          <g key={tick}>
            <line x1={M.l} x2={M.l + PLOT_W} y1={y(tick)} y2={y(tick)} stroke="#ECECF0" strokeWidth="1" />
            <text x={M.l - 8} y={y(tick) + 4} textAnchor="end" fontSize="11" fill="#86868B" fontFamily="ui-monospace, Menlo, monospace">
              {tick}
            </text>
          </g>
        ))}

        {xTicks.map((tick) => (
          <text
            key={tick}
            x={x(tick)}
            y={M.t + PLOT_H + 18}
            textAnchor="middle"
            fontSize="11"
            fill="#86868B"
            fontFamily="ui-monospace, Menlo, monospace"
          >
            {tick}
          </text>
        ))}

        {thresholds.map((t) => {
          const isWarn = Math.abs(t.value - WARN_VALUE) < 1e-6
          return (
            <g key={`${t.label}-${t.value}`}>
              <line
                x1={M.l}
                x2={M.l + PLOT_W}
                y1={y(t.value)}
                y2={y(t.value)}
                stroke={isWarn ? '#FF6B3D' : '#D9D9DE'}
                strokeWidth={isWarn ? 1.6 : 1}
                strokeDasharray={isWarn ? '7 5' : '3 5'}
              />
              <text
                x={M.l + PLOT_W - 4}
                y={y(t.value) - 5}
                textAnchor="end"
                fontSize="10"
                fill={isWarn ? '#E2551F' : '#86868B'}
                fontFamily="ui-monospace, Menlo, monospace"
              >
                {isWarn ? `警戒 ${t.value}` : `${t.value}`}
              </text>
            </g>
          )
        })}

        <path d={areaPath} fill="url(#lapvar-out-fill)" />
        <path
          className="chart-line"
          pathLength={1}
          d={origPath}
          fill="none"
          stroke="#B9B9BE"
          strokeWidth="1.3"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <path
          className="chart-line"
          pathLength={1}
          d={outPath}
          fill="none"
          stroke="#30A14E"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {active && (
          <g>
            <line
              x1={x(active.t)}
              x2={x(active.t)}
              y1={M.t}
              y2={M.t + PLOT_H}
              stroke="#1D1D1F"
              strokeWidth="1"
              strokeOpacity="0.28"
            />
            <circle cx={x(active.t)} cy={y(active.orig)} r="4" fill="#B9B9BE" stroke="#fff" strokeWidth="1.5" />
            <circle cx={x(active.t)} cy={y(active.out)} r="4" fill="#30A14E" stroke="#fff" strokeWidth="1.5" />
          </g>
        )}

        <text x={M.l} y={H - 10} fontSize="11" fill="#86868B">
          时间 t_src（秒）
        </text>
        <text x={M.l} y={M.t - 6} fontSize="11" fill="#86868B">
          lapvar（对数轴，越高越清晰）
        </text>
      </svg>

      <p className="mt-1 text-[11px] leading-4 text-apple-subtext">
        衰减推演（红虚线）无对应字段，本图不绘制推演点；曲线仅连接真实采样行。
      </p>
    </div>
  )
}
