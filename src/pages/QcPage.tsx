import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { QcResponse, QcRow } from '../types'
import { useJson } from '../api'
import { useCopyToClipboard, useToast } from '../hooks'
import { Link } from '../router'
import { ArrowLeft, Refresh } from '../components/icons'
import { LapvarChart } from '../components/LapvarChart'
import { QcRuleList } from '../components/QcRuleList'
import { ToastHost, ToolButton } from '../components/ui'
import { overallVerdict } from '../qc-explain'
import type { VerdictKind } from '../qc-explain'

const num = (v: string | number | undefined): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

export function QcPage({ id }: { id: string }) {
  const { status, data, error, refreshing, retry, refresh } = useJson<QcResponse>(
    `/api/qc/${encodeURIComponent(id)}`
  )

  if (status === 'loading') {
    return (
      <div aria-busy="true" aria-label="正在加载 QC 数据">
        <TopLink id={id} />
        <div className="card mt-4 h-[460px] animate-pulse" />
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div>
        <TopLink id={id} />
        <div className="card mt-4 p-6" role="alert">
          <h1 className="text-base font-semibold">QC 数据读取失败</h1>
          <p className="mt-2 text-sm text-apple-subtext">{error}</p>
          <button
            type="button"
            onClick={retry}
            className="mt-4 rounded-lg bg-apple-text px-3 py-1.5 text-xs font-medium text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
          >
            重试
          </button>
        </div>
      </div>
    )
  }

  return <QcContent data={data} refreshing={refreshing} onRefresh={refresh} />
}

function QcContent({
  data,
  refreshing,
  onRefresh
}: {
  data: QcResponse
  refreshing: boolean
  onRefresh: () => void
}) {
  const [onlySoftSampled, setOnlySoftSampled] = useState(false)
  const { toast, showToast, clearToast } = useToast(2200)
  const { copy } = useCopyToClipboard(1500)

  const stats = useMemo(() => {
    const orig = data.rows.map((r) => num(r.lapvar_orig)).filter((n): n is number => n != null)
    const out = data.rows.map((r) => num(r.lapvar_out)).filter((n): n is number => n != null)
    const ratio = data.rows.map((r) => num(r.lap_ratio)).filter((n): n is number => n != null)
    const time = data.rows.map((r) => num(r.t_src)).filter((n): n is number => n != null)
    const summarize = (arr: number[]) =>
      arr.length
        ? {
            mean: arr.reduce((a, b) => a + b, 0) / arr.length,
            min: Math.min(...arr),
            max: Math.max(...arr)
          }
        : null
    return {
      orig: summarize(orig),
      out: summarize(out),
      ratio: summarize(ratio),
      tMin: time.length ? Math.min(...time) : null,
      tMax: time.length ? Math.max(...time) : null
    }
  }, [data.rows])

  const sampled = useMemo(() => {
    const rows = data.rows
    if (rows.length === 0) return []
    const step = Math.max(1, Math.ceil(rows.length / 20))
    const base = rows.filter((_, i) => i % step === 0)
    if (!onlySoftSampled) return base
    return base.filter((row) => {
      const r = num(row.lap_ratio)
      return r != null && r < 1
    })
  }, [data.rows, onlySoftSampled])

  const lowRatio = useMemo(() => {
    return data.rows
      .map((r) => ({ row: r, ratio: num(r.lap_ratio) }))
      .filter((x): x is { row: QcRow; ratio: number } => x.ratio != null)
      .sort((a, b) => a.ratio - b.ratio)
      .slice(0, 10)
  }, [data.rows])

  const handleCopyTimestamp = async (sec: string) => {
    const ok = await copy(sec)
    showToast(ok ? `已复制时间点 ${sec}s，可前往对比播放器定位` : `时间点 ${sec}s`, ok ? 'ok' : 'info')
  }

  return (
    <div>
      <TopLink id={data.jobId} />

      <header className="mt-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="num text-xs font-semibold text-apple-blueInk">
            {data.jobId.toUpperCase()} · QC
          </span>
          <span className="num text-xs text-apple-subtext">{data.taskId}</span>
        </div>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
          <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.02em] sm:text-[32px]">
            清晰度 QC 曲线
          </h1>
          <div className="flex flex-wrap items-center gap-2">
            <ToolButton onClick={onRefresh} disabled={refreshing}>
              <Refresh className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
              {refreshing ? '刷新中' : '刷新'}
            </ToolButton>
            <Link
              to={`/job/${data.jobId}#video-compare`}
              className="press inline-flex h-9 items-center rounded-lg border border-black/[0.08] bg-white px-3.5 text-xs font-medium text-apple-text transition-colors hover:bg-apple-bg focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
            >
              回到对比播放器
            </Link>
          </div>
        </div>
        <p className="num mt-1.5 max-w-[78ch] break-all text-xs leading-relaxed text-apple-subtext">
          数据源 {data.source} · 共 {data.rows.length} 行采样 · lapvar 为拉普拉斯边缘清晰度方差
        </p>

        <nav aria-label="QC 页面跳转" className="mt-3 flex flex-wrap items-center gap-2 border-b border-black/[0.06] pb-2">
          <a
            href="#qc-verdict-title"
            className="rounded-lg px-2.5 py-1 text-xs font-medium text-apple-subtext transition-colors hover:bg-black/[0.04] hover:text-apple-text"
          >
            总体结论
          </a>
          <a
            href="#qc-audit-title"
            className="rounded-lg px-2.5 py-1 text-xs font-medium text-apple-subtext transition-colors hover:bg-black/[0.04] hover:text-apple-text"
          >
            审计与曲线
          </a>
          <a
            href="#qc-detail-rules-title"
            className="rounded-lg px-2.5 py-1 text-xs font-medium text-apple-subtext transition-colors hover:bg-black/[0.04] hover:text-apple-text"
          >
            门禁规则
          </a>
          <a
            href="#qc-frames-tables"
            className="rounded-lg px-2.5 py-1 text-xs font-medium text-apple-subtext transition-colors hover:bg-black/[0.04] hover:text-apple-text"
          >
            帧数据表
          </a>
        </nav>
      </header>

      <VerdictBanner rules={data.rules} />

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
        <section className="card p-4 sm:p-5">
          <LapvarChart rows={data.rows} thresholds={data.thresholds} />
        </section>
        <AuditCard rows={data.rows} />
      </div>

      <section className="card mt-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-semibold tracking-tight">阈值说明</h2>
          <p className="num text-xs text-apple-subtext">
            {stats.tMin != null && stats.tMax != null ? `${stats.tMin.toFixed(3)}s – ${stats.tMax.toFixed(3)}s` : '时间范围无数据'}
          </p>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-[#4A4A4F]">{data.unitNote}</p>
        <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-apple-subtext">
          {data.thresholds.map((t) => (
            <li key={t.label}>
              <span className="text-apple-text">{t.label}</span>：<span className="num">{t.value}</span>
              <span className="ml-1">（{t.note}）</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="card mt-4 p-4 sm:p-5" aria-labelledby="qc-detail-rules-title">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="qc-detail-rules-title" className="scroll-mt-16 text-base font-semibold tracking-tight">
            门禁规则清单
          </h2>
          <p className="num text-xs text-apple-subtext" data-testid="qc-rules-count">
            {data.rules.length} 条
          </p>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-[#4A4A4F]">
          每条规则先给判定，再给白话解释和建议动作；阈值 / 实际值 / 判定原样保留，页面不重算。
        </p>
        <QcRuleList rules={data.rules} source={data.rulesSource} explain />
      </section>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <StatsCard title="lapvar_orig（原片）" stats={stats.orig} />
        <StatsCard title="lapvar_out（输出）" stats={stats.out} />
      </div>

      <div id="qc-frames-tables" className="mt-4 grid scroll-mt-16 gap-4 lg:grid-cols-2">
        <TableCard
          title="抽样数据"
          note="按行等距抽样，仅用于快速核对；完整 297 行见 metrics.csv。"
          rows={sampled}
          onCopyTime={handleCopyTimestamp}
          headerExtra={
            <button
              type="button"
              aria-pressed={onlySoftSampled}
              onClick={() => setOnlySoftSampled((v) => !v)}
              className={`shrink-0 rounded-lg border px-2.5 py-1 text-[11px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50 ${
                onlySoftSampled
                  ? 'border-apple-text bg-apple-text text-white'
                  : 'border-apple-line bg-white text-apple-text hover:bg-[#FAFAFB]'
              }`}
            >
              仅看 ratio &lt; 1.0
            </button>
          }
        />
        <TableCard
          title="比值最低的 10 帧"
          note="lap_ratio = lapvar_out / lapvar_orig；按真实比值升序。点击 t_src 复制时间点（秒），回 job 详情播放器定位。"
          rows={lowRatio.map((x) => x.row)}
          onCopyTime={handleCopyTimestamp}
        />
      </div>

      <p className="mt-4 text-xs leading-relaxed text-apple-subtext">
        比值与曲线均为 CSV 原始值；本页不做平滑、不插值、不补缺失帧。
      </p>

      <GlossaryCard />
      <ToastHost toast={toast} onClose={clearToast} />
    </div>
  )
}

const VERDICT_STYLE: Record<VerdictKind, { wrap: string; title: string; dot: string }> = {
  pass: { wrap: 'border-[#CDEED6] bg-[#F2F9F4]', title: 'text-[#1E7A3C]', dot: 'bg-[#30A14E]' },
  attention: { wrap: 'border-[#F3DEBE] bg-[#FFF8EC]', title: 'text-[#8A4B00]', dot: 'bg-[#C77700]' },
  fail: { wrap: 'border-[#F3D3CF] bg-[#FDF2F1]', title: 'text-[#B3261E]', dot: 'bg-[#FF3B30]' },
  insufficient: { wrap: 'border-[#E5E5EA] bg-[#F7F7F8]', title: 'text-[#4A4A4F]', dot: 'bg-[#8E8E93]' }
}

/** 首屏结论（AC1）：只读 rules，计数与逐行判定同源。 */
function VerdictBanner({ rules }: { rules: QcResponse['rules'] }) {
  const verdict = overallVerdict(rules)
  const tone = VERDICT_STYLE[verdict.kind]
  const counts = [
    ['通过', verdict.counts.pass, 'pass'],
    ['未通过', verdict.counts.fail, 'fail'],
    ['无数据', verdict.counts.unavailable, 'unavailable']
  ] as const

  return (
    <section
      className={`mt-4 rounded-card border p-4 sm:p-5 ${tone.wrap}`}
      aria-labelledby="qc-verdict-title"
      data-testid="qc-verdict"
      data-verdict-kind={verdict.kind}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[11px] font-medium tracking-[0.08em] text-apple-subtext">结论</p>
          <h2
            id="qc-verdict-title"
            className={`mt-1 flex scroll-mt-16 items-center gap-2 text-[20px] font-semibold leading-tight tracking-tight ${tone.title}`}
          >
            <span aria-hidden="true" className={`h-2 w-2 rounded-full ${tone.dot}`} />
            {verdict.label}
          </h2>
          <p className="mt-1.5 max-w-[72ch] text-[13px] leading-6 text-[#3A3A3F]">{verdict.plain}</p>
        </div>
        <dl className="flex flex-wrap gap-2" data-testid="qc-verdict-counts">
          {counts.map(([label, value, key]) => (
            <div
              key={key}
              data-count={key}
              className="flex min-w-[74px] flex-col rounded-xl border border-black/[0.06] bg-white/80 px-3 py-2"
            >
              <dt className="text-[10px] text-apple-subtext">{label}</dt>
              <dd className="num mt-0.5 text-lg font-semibold leading-none">{value}</dd>
            </div>
          ))}
        </dl>
      </div>
      <p className="mt-3 text-[11px] leading-4 text-apple-subtext">
        结论与计数只来自后端返回的 {verdict.counts.total} 条门禁规则；本页不重算阈值，也不自行改判定。
      </p>
    </section>
  )
}



const GLOSSARY: { term: string; alias?: string; plain: string }[] = [
  { term: 'lapvar', alias: '拉普拉斯方差', plain: '逐帧统计画面边缘细节的数值；越高通常越清晰，越低越软。' },
  { term: 'SSIM', alias: '结构相似度', plain: '0–1 之间，越接近 1 表示输出片与原片结构越一致。' },
  { term: 'lap_ratio', alias: '清晰度比值', plain: '输出清晰度 ÷ 原片清晰度；小于 1 表示输出比原片更软。' },
  { term: 't_src', alias: '原片时间点', plain: '单位是秒，用来在播放器里定位某一帧。' },
  { term: 'frame', alias: '帧序号', plain: '60fps 下 1 秒约 60 帧；用于和逐帧数据对照。' },
  { term: 'ΔE2000', alias: '色彩偏差', plain: '数值越小越接近目标颜色，越大说明偏色越明显。' },
  { term: 'LU', alias: '响度单位', plain: 'Loudness Unit，用来衡量声音的动态范围。' },
  { term: 'BGM', alias: '背景音乐', plain: '成片里铺在画面下方的音乐。' },
  { term: '自相关峰', alias: '循环相似度', plain: '把音频和自己错开一段时间比较；峰值越高，越像在重复同一段。' },
  { term: 'op / unit', alias: '比较符 / 单位', plain: '阈值怎么写（>、<= 等）和用什么单位，只按后端返回值展示。' },
  { term: '门禁规则', alias: '通过条件', plain: '后端 policy 给出的交付条件；本页只展示判定，不改阈值。' }
]

/** 术语表（AC5）：只覆盖本页实际出现的词。 */
function GlossaryCard() {
  return (
    <details className="card mt-4 p-4 sm:p-5" data-testid="qc-glossary">
      <summary className="cursor-pointer select-none rounded text-[15px] font-semibold tracking-tight focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/40">
        术语表：这一页出现的词
        <span className="ml-2 text-[11px] font-normal text-apple-subtext">中文优先，英文作副标 · 点开查看</span>
      </summary>
      <dl className="mt-4 grid gap-x-8 gap-y-3 sm:grid-cols-2">
        {GLOSSARY.map((item) => (
          <div key={item.term}>
            <dt className="text-xs font-semibold text-apple-text">
              {item.term}
              {item.alias && <span className="ml-1.5 font-normal text-apple-subtext">{item.alias}</span>}
            </dt>
            <dd className="mt-0.5 text-[11px] leading-5 text-apple-subtext">{item.plain}</dd>
          </div>
        ))}
      </dl>
    </details>
  )
}

function AuditStatus({ tone, children }: { tone: 'green' | 'orange' | 'red'; children: string }) {
  const styles = {
    green: 'text-[#1E7A3C]',
    orange: 'text-[#B25E00]',
    red: 'text-[#B3261E]'
  } as const
  return <span className={`text-[10.5px] font-medium ${styles[tone]}`}>{children}</span>
}

function AuditRow({
  label,
  value,
  tone,
  badge,
  note
}: {
  label: string
  value: string
  tone: 'green' | 'orange' | 'red'
  badge: string
  note: string
}) {
  return (
    <li className="flex items-start justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <p className="text-[12px] font-medium leading-5">{label}</p>
        <p className="mt-0.5 text-[10px] leading-4 text-apple-subtext">{note}</p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5">
        <span className="num text-[13px] font-semibold leading-5">{value}</span>
        <AuditStatus tone={tone}>{badge}</AuditStatus>
      </div>
    </li>
  )
}

function AuditCard({ rows }: { rows: QcRow[] }) {
  const ssimValues = rows.map((row) => num(row.ssim)).filter((value): value is number => value != null)
  const ratioValues = rows.map((row) => num(row.lap_ratio)).filter((value): value is number => value != null)
  const ssimMean = ssimValues.length ? ssimValues.reduce((sum, value) => sum + value, 0) / ssimValues.length : null
  const ratioMean = ratioValues.length ? ratioValues.reduce((sum, value) => sum + value, 0) / ratioValues.length : null
  const softFrames = ratioValues.filter((v) => v < 1).length

  return (
    <section className="card p-4 sm:p-5" aria-labelledby="qc-audit-title">
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="qc-audit-title" className="scroll-mt-16 text-base font-semibold tracking-tight">
          审计结果
        </h2>
        <span className="text-[10px] text-apple-subtext">metrics.csv 实测</span>
      </div>
      <ul className="mt-3 divide-y divide-apple-line">
        <AuditRow
          label="SSIM 关键帧相似度"
          value={ssimMean == null ? '—' : ssimMean.toFixed(4)}
          tone={ssimMean == null ? 'orange' : 'green'}
          badge={ssimMean == null ? '无数据' : '实测均值'}
          note={`按行实测 · n=${ssimValues.length}`}
        />
        <AuditRow
          label="清晰度比值均值 (lap_ratio)"
          value={ratioMean == null ? '—' : ratioMean.toFixed(3)}
          tone={ratioMean == null ? 'orange' : ratioMean >= 1 ? 'green' : 'orange'}
          badge={ratioMean == null ? '无数据' : ratioMean >= 1 ? '清晰度提升' : '略低于原片'}
          note={`输出 ÷ 原片 · n=${ratioValues.length}`}
        />
        <AuditRow
          label="偏软帧统计 (ratio < 1.0)"
          value={ratioValues.length > 0 ? `${softFrames} / ${ratioValues.length}` : '—'}
          tone={softFrames === 0 ? 'green' : softFrames < ratioValues.length * 0.25 ? 'orange' : 'red'}
          badge={softFrames === 0 ? '全部达标' : `${((softFrames / Math.max(1, ratioValues.length)) * 100).toFixed(0)}% 帧偏软`}
          note="来自逐帧实测比值"
        />
      </ul>
      <p className="mt-3 text-[10px] leading-4 text-apple-subtext">全部数字均来自真实采样计算；缺失字段显示 —。</p>
    </section>
  )
}

function StatsCard({
  title,
  stats
}: {
  title: string
  stats: { mean: number; min: number; max: number } | null
}) {
  return (
    <section className="card p-4 sm:p-5">
      <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
      {stats ? (
        <dl className="mt-3 grid grid-cols-3 gap-3 text-center">
          {[
            ['均值', stats.mean],
            ['最小', stats.min],
            ['最大', stats.max]
          ].map(([label, value]) => (
            <div key={label as string} className="rounded-xl bg-[#FAFAFC] px-2 py-3">
              <dt className="text-xs text-apple-subtext">{label}</dt>
              <dd className="num mt-1 text-lg font-semibold tracking-tight">{(value as number).toFixed(1)}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="mt-3 text-sm text-apple-subtext">无数据</p>
      )}
    </section>
  )
}

function TableCard({
  title,
  note,
  rows,
  headerExtra,
  onCopyTime
}: {
  title: string
  note: string
  rows: QcRow[]
  headerExtra?: ReactNode
  onCopyTime: (sec: string) => void
}) {
  return (
    <section className="card overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-2 p-4 pb-3 sm:px-5">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
          <p className="mt-0.5 text-xs leading-relaxed text-apple-subtext">{note}</p>
        </div>
        {headerExtra}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[420px] text-left text-xs">
          <thead>
            <tr className="border-y border-apple-line bg-[#FAFAFC] text-xs text-apple-subtext">
              <th scope="col" className="px-4 py-2 font-medium sm:px-5">t_src</th>
              <th scope="col" className="px-2 py-2 font-medium">frame</th>
              <th scope="col" className="px-2 py-2 text-right font-medium">orig</th>
              <th scope="col" className="px-2 py-2 text-right font-medium">out</th>
              <th scope="col" className="px-2 py-2 text-right font-medium">ratio</th>
              <th scope="col" className="px-4 py-2 text-right font-medium sm:px-5">ssim</th>
            </tr>
          </thead>
          <tbody className="num tabular-nums divide-y divide-apple-line">
            {rows.map((r, i) => {
              const tSrc = num(r.t_src)
              const tLabel = tSrc?.toFixed(3) ?? null
              const ratioVal = num(r.lap_ratio)
              return (
                <tr key={`${r.frame}-${i}`} className="h-[54px] align-middle hover:bg-[#FAFAFC]">
                  <td className="px-4 py-2 sm:px-5">
                    {tLabel ? (
                      <button
                        type="button"
                        onClick={() => onCopyTime(tLabel)}
                        title="点击复制时间点"
                        className="num rounded px-1.5 py-0.5 text-apple-blue hover:bg-[#EEF5FF] focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
                      >
                        {tLabel}
                      </button>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-2 py-2">{num(r.frame) ?? '—'}</td>
                  <td className="px-2 py-2 text-right">{num(r.lapvar_orig)?.toFixed(1) ?? '—'}</td>
                  <td className="px-2 py-2 text-right">{num(r.lapvar_out)?.toFixed(1) ?? '—'}</td>
                  <td
                    className={`px-2 py-2 text-right ${
                      ratioVal != null && ratioVal < 1 ? 'font-medium text-apple-amber' : ''
                    }`}
                  >
                    {ratioVal?.toFixed(3) ?? '—'}
                  </td>
                  <td className="px-4 py-2 text-right sm:px-5">{num(r.ssim)?.toFixed(4) ?? '—'}</td>
                </tr>
              )
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-5 py-6 text-center text-apple-subtext">
                  无数据
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function TopLink({ id }: { id: string }) {
  return (
    <Link
      to={`/job/${id}`}
      className="inline-flex items-center gap-1.5 rounded-lg py-1 text-xs font-medium text-apple-subtext transition-colors hover:text-apple-text focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
    >
      <ArrowLeft className="h-3.5 w-3.5" />
      返回 {id.toUpperCase()} 详情
    </Link>
  )
}
