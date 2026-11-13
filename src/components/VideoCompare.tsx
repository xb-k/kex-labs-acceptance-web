import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from 'react'
import type { Job } from '../types'
import { formatClock } from '../format'
import { Pause, Play, Split, VolumeOff, VolumeOn } from './icons'

type Props = {
  job: Job
}

type Failed = { orig: boolean; out: boolean; cmpOrig: boolean; cmpOut: boolean }

const initialFailed: Failed = { orig: false, out: false, cmpOrig: false, cmpOut: false }

export function VideoCompare({ job }: Props) {
  const duration = job.durationS ?? 0
  const start = job.sourceStart ?? 0
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [muted, setMuted] = useState(true)
  const [split, setSplit] = useState(50)
  const [failed, setFailed] = useState<Failed>(initialFailed)
  const [error, setError] = useState<string | null>(null)

  const origRef = useRef<HTMLVideoElement>(null)
  const outRef = useRef<HTMLVideoElement>(null)
  const cmpOrigRef = useRef<HTMLVideoElement>(null)
  const cmpOutRef = useRef<HTMLVideoElement>(null)
  const durationRef = useRef(duration)
  const startRef = useRef(start)
  const seekingRef = useRef(false)
  durationRef.current = duration
  startRef.current = start

  const allRefs = useCallback(
    () => [
      { el: origRef.current, offset: startRef.current },
      { el: outRef.current, offset: 0 },
      { el: cmpOrigRef.current, offset: startRef.current },
      { el: cmpOutRef.current, offset: 0 }
    ],
    []
  )

  const seekAll = useCallback(
    (t: number) => {
      const clamped = Math.max(0, Math.min(t, durationRef.current))
      seekingRef.current = true
      allRefs().forEach(({ el, offset }) => {
        if (!el) return
        const target = Math.min(offset + clamped, Math.max(0, el.duration - 0.02))
        if (Number.isFinite(target)) {
          if (el.readyState >= 1) {
            el.currentTime = target
          } else {
            el.dataset.pendingSeek = String(target)
          }
        }
      })
      setTime(clamped)
      window.setTimeout(() => {
        seekingRef.current = false
      }, 80)
    },
    [allRefs]
  )

  const pauseAll = useCallback(() => {
    allRefs().forEach(({ el }) => el?.pause())
    setPlaying(false)
  }, [allRefs])

  const playAll = useCallback(() => {
    const out = outRef.current
    if (!out) return
    if (out.ended || out.currentTime >= durationRef.current - 0.05) seekAll(0)
    const results = allRefs().map(({ el }) => el?.play())
    void Promise.allSettled(results)
      .then((settled) => {
        const rejected = settled.find((s) => s.status === 'rejected')
        if (rejected) {
          setError('浏览器拒绝播放，请点击播放按钮重试')
          setPlaying(false)
          return
        }
        setError(null)
        setPlaying(true)
      })
      .catch(() => setPlaying(false))
  }, [allRefs, seekAll])

  const toggle = useCallback(() => {
    if (playing) pauseAll()
    else playAll()
  }, [pauseAll, playAll, playing])

  useEffect(() => {
    if (!playing) return
    let raf = 0
    const tick = () => {
      const out = outRef.current
      if (!out) {
        raf = requestAnimationFrame(tick)
        return
      }
      const t = Math.min(out.currentTime, durationRef.current)
      setTime(t)
      if (!seekingRef.current) {
        allRefs().forEach(({ el, offset }) => {
          if (!el || el === out) return
          const target = offset + t
          if (Number.isFinite(target) && Math.abs(el.currentTime - target) > 0.18) {
            el.currentTime = Math.min(target, Math.max(0, el.duration - 0.02))
          }
        })
      }
      if (out.ended || (durationRef.current > 0 && t >= durationRef.current - 0.02)) {
        pauseAll()
        return
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, pauseAll, allRefs])

  useEffect(() => {
    return () => {
      allRefs().forEach(({ el }) => el?.pause())
    }
  }, [allRefs])

  useEffect(() => {
    allRefs().forEach(({ el }) => {
      if (el) el.muted = muted
    })
  }, [muted, allRefs])

  /** 元数据到达后落到该元素时间轴的首帧，否则分割对比拿不到画面（Chrome 只解码首帧时是黑的）。 */
  const onLoaded = (offset: number) => (event: SyntheticEvent<HTMLVideoElement>) => {
    const el = event.currentTarget
    const pending = el.dataset.pendingSeek
    if (pending) {
      el.currentTime = Number(pending)
      delete el.dataset.pendingSeek
    } else if (el.currentTime === 0 && Number.isFinite(el.duration) && el.duration > 0) {
      el.currentTime = Math.min(offset + 0.05, Math.max(0, el.duration - 0.05))
    }
    el.muted = muted
  }

  const onError = (key: keyof Failed) => () => {
    setFailed((f) => ({ ...f, [key]: true }))
  }

  const onEnded = () => pauseAll()

  const originalSrc = job.media.original
  const outputSrc = job.media.output

  if (!originalSrc || !outputSrc) {
    return (
      <div className="card p-6 text-sm text-apple-subtext">
        无数据：{!originalSrc ? '原始视频 IMG_3189.MOV 缺失' : '优化片缺失'}。
      </div>
    )
  }

  const durationLabel = `${formatClock(duration)}`

  return (
    <div className="space-y-4">
      <div className="card p-4 sm:p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold tracking-tight">原片 vs 优化片</h2>
            <p className="mt-0.5 text-xs text-apple-subtext">
              两个播放器共用一条时间轴：播放、暂停、拖动都会同步。
            </p>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-[#F0F6FF] px-2.5 py-1 text-xs font-medium text-apple-blueInk ring-1 ring-inset ring-[#D6E6FB]">
            <span className="h-1.5 w-1.5 rounded-full bg-apple-blue" aria-hidden="true" />
            同步播放
          </span>
        </div>

        <div
          tabIndex={0}
          role="group"
          aria-label="对比播放器，按空格播放或暂停"
          onKeyDown={(event) => {
            if (event.code === 'Space') {
              event.preventDefault()
              toggle()
            }
            if (event.code === 'ArrowRight') {
              event.preventDefault()
              seekAll(time + 1)
            }
            if (event.code === 'ArrowLeft') {
              event.preventDefault()
              seekAll(time - 1)
            }
          }}
          className="grid gap-3 rounded-xl p-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50 sm:grid-cols-2"
        >
          <figure className="rounded-xl bg-[#0B0B0C] p-2">
            <figcaption className="mb-2 flex items-baseline justify-between px-1 text-xs text-white/70">
              <span className="font-medium text-white">原片</span>
              <span className="num">{job.fps ? '30fps · 源' : '源'}</span>
            </figcaption>
            <div className="relative mx-auto w-full max-w-[300px]">
              <video
                ref={origRef}
                src={originalSrc}
                muted
                playsInline
                preload="metadata"
                onLoadedMetadata={onLoaded(start)}
                onError={onError('orig')}
                onEnded={onEnded}
                onClick={toggle}
                className="aspect-[9/16] w-full cursor-pointer rounded-lg object-cover"
              />
              {failed.orig && <VideoError />}
            </div>
          </figure>

          <figure className="rounded-xl bg-[#0B0B0C] p-2">
            <figcaption className="mb-2 flex items-baseline justify-between px-1 text-xs text-white/70">
              <span className="font-medium text-white">优化片</span>
              <span className="num">{job.fps ? `${job.fps}fps · 输出` : '输出'}</span>
            </figcaption>
            <div className="relative mx-auto w-full max-w-[300px]">
              <video
                ref={outRef}
                src={outputSrc}
                muted
                playsInline
                preload="metadata"
                onLoadedMetadata={onLoaded(0)}
                onError={onError('out')}
                onEnded={onEnded}
                onClick={toggle}
                className="aspect-[9/16] w-full cursor-pointer rounded-lg object-cover"
              />
              {failed.out && <VideoError />}
            </div>
          </figure>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-apple-line bg-[#FAFAFC] px-3 py-2.5">
          <button
            type="button"
            onClick={toggle}
            aria-label={playing ? '暂停对比视频' : '播放对比视频'}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-apple-blue text-white transition-colors hover:bg-[#0062C4] focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue focus-visible:ring-offset-2"
          >
            {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          </button>
          <span className="num text-xs text-apple-subtext">
            {formatClock(time)} / {durationLabel}
          </span>
          <input
            type="range"
            min={0}
            max={Math.max(duration, 0.1)}
            step={0.01}
            value={Math.min(time, duration)}
            onChange={(event) => seekAll(Number(event.target.value))}
            aria-label="播放进度"
            className="h-1.5 min-w-[120px] flex-1 cursor-pointer accent-[#0071E3]"
          />
          <button
            type="button"
            onClick={() => setMuted((m) => !m)}
            aria-label={muted ? '取消静音' : '静音'}
            aria-pressed={!muted}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-apple-subtext transition-colors hover:bg-black/5 hover:text-apple-text focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
          >
            {muted ? <VolumeOff className="h-4 w-4" /> : <VolumeOn className="h-4 w-4" />}
          </button>
        </div>

        {error && (
          <p role="alert" className="mt-2 text-xs text-[#B3261E]">
            {error}
          </p>
        )}
        {start > 0 && (
          <p className="mt-2 text-xs text-apple-subtext">
            S0 优化片取自原片 {start.toFixed(1)}–{(start + duration).toFixed(1)}s；时间轴已对齐片段起点。
          </p>
        )}
      </div>

      <div className="card p-4 sm:p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight">
              <Split className="h-4 w-4 text-apple-subtext" />
              拖动对比
            </h2>
            <p className="mt-0.5 text-xs text-apple-subtext">同一时间轴，左侧原片、右侧优化片；拖动分割线或按方向键。</p>
          </div>
          <span className="num text-xs text-apple-subtext">{Math.round(split)}% / {100 - Math.round(split)}%</span>
        </div>

        <div className="relative mx-auto aspect-[9/16] w-full max-w-[360px] select-none overflow-hidden rounded-xl bg-black">
          <video
            ref={cmpOrigRef}
            src={originalSrc}
            muted
            playsInline
            preload="metadata"
            onLoadedMetadata={onLoaded(start)}
            onError={onError('cmpOrig')}
            className="absolute inset-0 h-full w-full object-cover"
          />
          <video
            ref={cmpOutRef}
            src={outputSrc}
            muted
            playsInline
            preload="metadata"
            onLoadedMetadata={onLoaded(0)}
            onError={onError('cmpOut')}
            className="absolute inset-0 h-full w-full object-cover"
            style={{ clipPath: `inset(0 0 0 ${split}%)` }}
          />
          <div className="pointer-events-none absolute left-2 top-2 rounded-md bg-black/55 px-2 py-0.5 text-xs font-medium text-white">
            原片
          </div>
          <div className="pointer-events-none absolute right-2 top-2 rounded-md bg-black/55 px-2 py-0.5 text-xs font-medium text-white">
            优化片
          </div>
          <input
            type="range"
            min={0}
            max={100}
            step={0.5}
            value={split}
            onChange={(event) => setSplit(Number(event.target.value))}
            aria-label="对比分割线位置：左侧原片，右侧优化片"
            className="split-range"
          />
          <div className="split-handle" style={{ left: `${split}%` }} aria-hidden="true" />
          {(failed.cmpOrig || failed.cmpOut) && <VideoError />}
        </div>
      </div>
    </div>
  )
}

function VideoError() {
  return (
    <div className="absolute inset-0 grid place-items-center rounded-lg bg-black/70 p-4 text-center text-xs leading-relaxed text-white">
      视频无法加载。
      <br />
      请检查 /media 接口是否返回 206 Range。
    </div>
  )
}
