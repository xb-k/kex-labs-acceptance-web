import { useMemo, useState } from 'react'
import { Check, Refresh, Split } from '../icons'
import {
  AGENT_ROLES,
  formatDurationMs,
  groupShotActionsByRole,
  type AgentRoleId,
  type ShotRoleAction,
  type ShotStoryboardItem
} from './production-data'

type MonitorStage = 'original' | 'redrawn' | 'i2v' | 'graded'

export function ShotAgentMatrix({
  shots,
  selectedShotId,
  onSelectShot,
  roleFilter,
  onRoleFilter,
  jobId = null,
  onDecision,
  decisionBusyKey = null
}: {
  shots: ShotStoryboardItem[]
  selectedShotId: number
  onSelectShot: (shotId: number) => void
  roleFilter: AgentRoleId
  onRoleFilter: (role: AgentRoleId) => void
  jobId?: string | null
  onDecision?: (action: ShotRoleAction, decision: 'adopt' | 'reject') => void | Promise<void>
  decisionBusyKey?: string | null
}) {
  const [monitorStage, setMonitorStage] = useState<MonitorStage>('redrawn')
  const [compareSplit, setCompareSplit] = useState(false)
  const [splitPct, setSplitPct] = useState(52)

  const currentShot = useMemo(
    () => shots.find((s) => s.shotId === selectedShotId) ?? shots[0] ?? null,
    [shots, selectedShotId]
  )

  const visibleGroups = useMemo(
    () => (currentShot ? groupShotActionsByRole(currentShot, roleFilter) : []),
    [currentShot, roleFilter]
  )

  if (!currentShot) {
    return (
      <section className="card p-6 text-sm text-apple-subtext">
        当前任务暂无分镜数据，请先在流程阶段 A 完成镜头切分。
      </section>
    )
  }

  const origUrl = currentShot.media.originalFrame
  const redrawnUrl = currentShot.media.redrawnFrame
  const i2vUrl = currentShot.media.i2vClip
  const gradedUrl = currentShot.media.gradedClip
  const canCompareFrames = Boolean(origUrl && redrawnUrl)

  const activeMediaUrl =
    monitorStage === 'original'
      ? origUrl ?? redrawnUrl ?? gradedUrl ?? i2vUrl
      : monitorStage === 'redrawn'
        ? redrawnUrl ?? origUrl ?? gradedUrl ?? i2vUrl
        : monitorStage === 'i2v'
          ? i2vUrl ?? gradedUrl
          : gradedUrl ?? i2vUrl

  // 产物按真实扩展名决定播放器：单镜成片可能只有 F 阶段 mp4 落在「重绘」默认页。
  const isVideoMode = Boolean(activeMediaUrl && /\.(mp4|webm|mov)(\?|$)/i.test(activeMediaUrl))

  return (
    <section aria-label="分镜与多角色 Agent 协同处理台" className="card p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h2 className="text-[16px] font-semibold tracking-[-0.015em] text-apple-text">
            分镜时间线 × 不同角色 Agent 对本视频的处理明细
          </h2>
          <p className="mt-0.5 text-[12px] text-apple-subtext">
            选定镜头查看不同阶段画面演进，并追踪摄影 / 导演 / 编剧 / 后期 / 调色 / 音频每一步做了什么决策
          </p>
        </div>
        <span className="num text-[11px] text-apple-subtext">
          共 {shots.length} 镜 · 6 角色协同轨迹
        </span>
      </div>

      {/* Shot timeline bar */}
      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {shots.map((shot) => {
          const active = shot.shotId === currentShot.shotId
          return (
            <button
              key={shot.shotId}
              type="button"
              onClick={() => onSelectShot(shot.shotId)}
              className={`rounded-[12px] border p-3 text-left transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50 ${
                active
                  ? 'border-apple-blue bg-[#F5F9FF] shadow-soft'
                  : 'border-black/[0.07] bg-[#FAFAFB] hover:border-black/[0.16] hover:bg-white'
              }`}
            >
              <div className="flex items-center justify-between gap-2 text-[11px]">
                <span className="num font-semibold text-apple-text">{shot.label}</span>
                <span className="num text-apple-subtext">
                  {shot.startS === null || shot.endS === null
                    ? '区间未记录'
                    : `${shot.startS.toFixed(1)}s–${shot.endS.toFixed(1)}s`}{' '}
                  ({shot.durationS === null ? '时长未记录' : `${shot.durationS.toFixed(1)}s`})
                </span>
              </div>
              <div className="mt-1 truncate text-[12.5px] font-medium text-apple-text" title={shot.sceneSummary}>
                {shot.sceneSummary}
              </div>
              <div className="mt-1 text-[11px] text-apple-subtext">
                {shot.pacingTag} ·{' '}
                {(() => {
                  const participating = new Set(shot.actions.map((action) => action.role)).size
                  if (participating === 6) return '6 角色已记录'
                  if (participating === 0) return '角色动作未记录'
                  return `${participating} 角色参与 · ${6 - participating} 未参与`
                })()}
              </div>
            </button>
          )
        })}
      </div>

      {/* Two-column workspace: Left dark cinema monitor, Right Agent Role trace */}
      <div className="mt-5 grid gap-5 lg:grid-cols-12 lg:items-start">
        {/* Left: Per-Shot Visual Stage Monitor */}
        <div className="lg:col-span-5 lg:sticky lg:top-6">
          <div className="overflow-hidden rounded-[16px] border border-black/[0.12] bg-[#0D0E12] text-white">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 px-3.5 py-2.5">
              <div className="text-[12px] font-medium text-white/90">
                <span className="num font-semibold">{currentShot.label}</span>
                <span className="mx-1.5 text-white/35">·</span>
                <span className="text-white/70">{currentShot.sceneSummary}</span>
              </div>
              {canCompareFrames && (
                <button
                  type="button"
                  onClick={() => setCompareSplit((v) => !v)}
                  className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors whitespace-nowrap ${
                    compareSplit
                      ? 'bg-apple-blue text-white'
                      : 'bg-white/10 text-white/80 hover:bg-white/15'
                  }`}
                >
                  <Split className="h-3 w-3" />
                  {compareSplit ? '退出拉杆对比' : '原帧 vs 重绘对比'}
                </button>
              )}
            </div>

            {/* Viewport */}
            <div className="relative aspect-[16/10] w-full bg-black">
              {compareSplit && canCompareFrames && origUrl && redrawnUrl ? (
                <div className="relative h-full w-full select-none overflow-hidden">
                  <img
                    src={redrawnUrl}
                    alt={`${currentShot.label} 重绘帧`}
                    referrerPolicy="no-referrer"
                    className="h-full w-full object-cover"
                  />
                  <div
                    className="absolute inset-0 overflow-hidden"
                    style={{ clipPath: `inset(0 ${100 - splitPct}% 0 0)` }}
                  >
                    <img
                      src={origUrl}
                      alt={`${currentShot.label} 原片抽帧`}
                      referrerPolicy="no-referrer"
                      className="h-full w-full object-cover"
                    />
                  </div>
                  <input
                    type="range"
                    min={5}
                    max={95}
                    value={splitPct}
                    onChange={(e) => setSplitPct(Number(e.target.value))}
                    aria-label="原片与重绘帧对比滑块"
                    className="split-range"
                  />
                  <div className="split-handle" style={{ left: `${splitPct}%` }} />
                  <span className="pointer-events-none absolute left-2.5 top-2.5 rounded bg-black/70 px-2 py-0.5 text-[10.5px] text-white/90">
                    原片抽帧 (A)
                  </span>
                  <span className="pointer-events-none absolute right-2.5 top-2.5 rounded bg-black/70 px-2 py-0.5 text-[10.5px] text-white/90">
                    SDXL 重绘 (C)
                  </span>
                </div>
              ) : isVideoMode && activeMediaUrl ? (
                <video
                  key={activeMediaUrl}
                  src={activeMediaUrl}
                  controls
                  loop
                  muted
                  playsInline
                  className="h-full w-full object-contain"
                />
              ) : activeMediaUrl ? (
                <img
                  src={activeMediaUrl}
                  alt={`${currentShot.label} ${monitorStage}`}
                  referrerPolicy="no-referrer"
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="grid h-full place-items-center px-6 text-center text-[12px] text-white/55">
                  该阶段产物正在等待上游模型队列完成生成
                </div>
              )}
            </div>

            {/* Stage Switcher inside monitor footer */}
            <div className="border-t border-white/10 p-2.5">
              <div className="grid grid-cols-4 gap-1 rounded-lg bg-white/[0.06] p-1">
                {(
                  [
                    { id: 'original', label: 'A 原帧', ready: Boolean(origUrl) },
                    { id: 'redrawn', label: 'C 重绘', ready: Boolean(redrawnUrl) },
                    { id: 'i2v', label: 'D I2V', ready: Boolean(i2vUrl) },
                    { id: 'graded', label: 'E/F 调色', ready: Boolean(gradedUrl) }
                  ] as const
                ).map((tab) => {
                  const active = !compareSplit && monitorStage === tab.id
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => {
                        setCompareSplit(false)
                        setMonitorStage(tab.id)
                      }}
                      className={`rounded-md px-2 py-1.5 text-[11px] font-medium transition-colors whitespace-nowrap ${
                        active
                          ? 'bg-white text-[#121316]'
                          : tab.ready
                            ? 'text-white/80 hover:bg-white/10'
                            : 'text-white/35 hover:bg-white/5'
                      }`}
                    >
                      {tab.label}
                    </button>
                  )
                })}
              </div>
              <p className="mt-2 px-1 text-[11px] text-white/60">
                提示：可点按上方「原帧 vs 重绘对比」拖动分割线直接看角色修改前后的构图与材质差异。
              </p>
            </div>
          </div>
        </div>

        {/* Right: Multi-Role Agent Actions for Selected Shot */}
        <div className="lg:col-span-7">
          {/* Role Filter Segmented Bar */}
          <div className="flex flex-wrap items-center gap-1 rounded-[12px] bg-[#F0F0F3] p-1">
            <button
              type="button"
              onClick={() => onRoleFilter('all')}
              className={`rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                roleFilter === 'all' ? 'bg-white text-apple-text shadow-soft' : 'text-apple-subtext hover:text-apple-text'
              }`}
            >
              全部角色 ({currentShot.actions.length})
            </button>
            {AGENT_ROLES.map((r) => {
              const active = roleFilter === r.id
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => onRoleFilter(r.id)}
                  className={`rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                    active ? 'bg-white text-apple-text shadow-soft' : 'text-apple-subtext hover:text-apple-text'
                  }`}
                >
                  {r.name}
                </button>
              )
            })}
          </div>

          <div className="mt-3 space-y-3">
            {visibleGroups.map(({ role, actions }) => (
              <div key={role.id} className="space-y-3">
                {actions.length === 0 ? (
                  <article
                    key={`empty-${role.id}`}
                    className="rounded-[14px] border border-dashed border-black/[0.10] bg-[#FAFAFB] p-4"
                  >
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span
                        className={`rounded-md border px-2 py-0.5 text-[11px] font-semibold ${role.accentBg} ${role.accentText} ${role.accentBorder}`}
                      >
                        {role.name} Agent
                      </span>
                      <span className="font-medium text-apple-subtext">未参与本镜</span>
                    </div>
                    <p className="mt-2 text-[12px] leading-relaxed text-apple-subtext">
                      该镜头未记录到 {role.name} 角色的工具动作（state 无对应阶段产物）。
                    </p>
                  </article>
                ) : (
                  actions.map((act) => (
                <article
                  key={act.id}
                  className="rounded-[14px] border border-black/[0.07] bg-white p-4 transition-colors hover:border-black/[0.14]"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span
                        className={`rounded-md border px-2 py-0.5 text-[11px] font-semibold ${role.accentBg} ${role.accentText} ${role.accentBorder}`}
                      >
                        {role.name} Agent
                      </span>
                      <span className="font-mono text-[11px] text-apple-subtext">{act.tool}</span>
                      <span aria-hidden="true" className="text-apple-subtext/40">·</span>
                      <span className="num text-[11px] text-apple-subtext">{act.timestamp}</span>
                      {act.status !== undefined && (
                        <>
                          <span aria-hidden="true" className="text-apple-subtext/40">·</span>
                          <span className="text-[11px] text-apple-subtext">状态 {act.status ?? '未记录'}</span>
                          <span aria-hidden="true" className="text-apple-subtext/40">·</span>
                          <span className="num text-[11px] text-apple-subtext">
                            耗时 {formatDurationMs(act.durationMs)}
                          </span>
                        </>
                      )}
                    </div>

                    <div className="flex items-center gap-1.5">
                      {(['adopt', 'reject'] as const).map((decision) => {
                        const busy = decisionBusyKey === `${act.id}:${decision}`
                        const disabled = !jobId || !onDecision || decisionBusyKey !== null
                        const label =
                          decision === 'adopt'
                            ? busy
                              ? '采纳中…'
                              : '采纳'
                            : busy
                              ? '驳回中…'
                              : '驳回重跑'
                        return (
                          <button
                            key={decision}
                            type="button"
                            disabled={disabled}
                            onClick={() => void onDecision?.(act, decision)}
                            title={
                              !jobId
                                ? '未选择任务，无法写入处置状态'
                                : decision === 'adopt'
                                  ? '写入采纳决策并刷新审计日志'
                                  : '写入驳回决策，等待后续重跑'
                            }
                            className={`inline-flex items-center gap-1 rounded-md border border-black/[0.08] bg-white px-2 py-1 text-[11px] font-medium text-apple-subtext whitespace-nowrap ${
                              disabled ? 'cursor-not-allowed opacity-60' : 'hover:bg-black/[0.04]'
                            }`}
                          >
                            {decision === 'adopt' ? (
                              <Check className="h-3 w-3" />
                            ) : (
                              <Refresh className="h-3 w-3" />
                            )}
                            {label}
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  <h3 className="mt-2.5 text-[14px] font-semibold text-apple-text">{act.actionTitle}</h3>

                  <dl className="mt-2.5 space-y-1.5 text-[12.5px] leading-relaxed">
                    <div className="flex flex-col sm:flex-row sm:gap-2">
                      <dt className="w-20 shrink-0 text-apple-subtext">读入依据</dt>
                      <dd className="text-apple-text">{act.inputFact}</dd>
                    </div>
                    <div className="flex flex-col sm:flex-row sm:gap-2">
                      <dt className="w-20 shrink-0 text-apple-subtext">判断与改写</dt>
                      <dd className="text-apple-text">{act.decisionReason}</dd>
                    </div>
                    <div className="flex flex-col sm:flex-row sm:gap-2">
                      <dt className="w-20 shrink-0 text-apple-subtext">产出交付</dt>
                      <dd className="font-medium text-apple-text">{act.outputSummary}</dd>
                    </div>
                    {act.artifact && (
                      <div className="flex flex-col sm:flex-row sm:gap-2">
                        <dt className="w-20 shrink-0 text-apple-subtext">产物文件</dt>
                        <dd className="break-all font-mono text-[11.5px] text-apple-text">{act.artifact}</dd>
                      </div>
                    )}
                  </dl>

                  {/* Optional Prompt Diff */}
                  {act.diffBefore && act.diffAfter && (
                    <div className="mt-3 rounded-[10px] border border-black/[0.06] bg-[#FAFAFB] p-3 font-mono text-[11px] leading-5">
                      <div className="text-[#B3261E]">- {act.diffBefore}</div>
                      <div className="mt-1 text-[#1E7A3C]">+ {act.diffAfter}</div>
                    </div>
                  )}

                  {/* Optional I2V candidate screening */}
                  {act.candidates && (
                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      {act.candidates.map((cand) => (
                        <div
                          key={cand.name}
                          className={`rounded-[10px] border p-2.5 text-[11.5px] ${
                            cand.picked
                              ? 'border-[#B7DFC4] bg-[#F2F9F4]'
                              : 'border-black/[0.06] bg-[#FAFAFB] text-apple-subtext'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2 font-mono font-semibold">
                            <span className={cand.picked ? 'text-[#1E7A3C]' : 'text-apple-subtext'}>
                              {cand.picked ? '✓ 选中 · ' : '× 淘汰 · '}
                              {cand.name}
                            </span>
                            <span className="num">{cand.score}</span>
                          </div>
                          <div className="mt-1 leading-4">{cand.note}</div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Optional Color / Human-likeness Metrics */}
                  {act.metrics && (
                    <div className="mt-3 flex flex-wrap gap-3 border-t border-black/[0.05] pt-2.5 text-[11.5px]">
                      {act.metrics.map((m) => (
                        <div key={m.label} className="flex items-center gap-1.5">
                          <span className="text-apple-subtext">{m.label}:</span>
                          <span className={`num font-semibold ${m.pass ? 'text-[#1E7A3C]' : 'text-[#B3261E]'}`}>
                            {m.value}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </article>
                  ))
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
