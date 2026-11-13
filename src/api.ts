import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  HealthResponse,
  ManualVerifyList,
  ManualVerifyState,
  ManualVerifyView,
  ResourceUsage,
  SystemResponse,
  SystemSnapshot
} from './types'

export async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal })
  if (!res.ok) {
    let message = `HTTP ${res.status}`
    try {
      const body = (await res.json()) as { error?: string }
      if (body.error) message = body.error
    } catch {
      /* body was not json */
    }
    throw new Error(message)
  }
  return (await res.json()) as T
}

type State<T> =
  | { status: 'loading'; data: null; error: null; refreshing: boolean; updatedAt: number | null }
  | { status: 'ready'; data: T; error: null; refreshing: boolean; updatedAt: number | null }
  | { status: 'error'; data: null; error: string; refreshing: boolean; updatedAt: number | null }

export function useJson<T>(url: string | null) {
  const [state, setState] = useState<State<T>>({
    status: 'loading',
    data: null,
    error: null,
    refreshing: false,
    updatedAt: null
  })
  const [nonce, setNonce] = useState(0)
  const silentRef = useRef(false)
  const prevUrlRef = useRef<string | null>(url)

  const retry = useCallback(() => {
    silentRef.current = false
    setState({ status: 'loading', data: null, error: null, refreshing: false, updatedAt: null })
    setNonce((n) => n + 1)
  }, [])

  /** 静默刷新：保留旧数据，卡片不闪回骨架，同时提供 refreshing 状态给按钮旋转反馈。 */
  const refresh = useCallback(() => {
    silentRef.current = true
    setState((prev) => ({ ...prev, refreshing: true }))
    setNonce((n) => n + 1)
  }, [])

  useEffect(() => {
    if (prevUrlRef.current !== url) {
      prevUrlRef.current = url
      silentRef.current = false
      setState({ status: 'loading', data: null, error: null, refreshing: false, updatedAt: null })
    }
    if (!url) return

    const ac = new AbortController()
    const isSilent = silentRef.current
    silentRef.current = false

    getJson<T>(url, ac.signal)
      .then((data) => {
        if (ac.signal.aborted) return
        setState({ status: 'ready', data, error: null, refreshing: false, updatedAt: Date.now() })
      })
      .catch((err: unknown) => {
        if (ac.signal.aborted) return
        const message = err instanceof Error ? err.message : '请求失败'
        setState((prev) => {
          if (isSilent && prev.status === 'ready') {
            return { ...prev, refreshing: false }
          }
          return { status: 'error', data: null, error: message, refreshing: false, updatedAt: null }
        })
      })
    return () => ac.abort()
  }, [url, nonce])

  return { ...state, retry, refresh }
}

type LiveState<T> = {
  /** 首次加载中（没有旧数据） */
  status: 'loading' | 'ready' | 'error'
  data: T | null
  /** 后台刷新失败时不清空旧数据，错误挂在 data 旁边 */
  error: string | null
  refreshing: boolean
  /** 最近一次成功读取的本地时间戳 */
  updatedAt: number | null
}

/**
 * 带轮询的读取：刷新时保留旧数据（不闪骨架），只在 `document.visibilityState === 'visible'`
 * 时轮询；隐藏即暂停，重新可见先补一次再恢复。卸载时 abort。
 */
export function useLiveJson<T>(url: string | null, pollMs = 5000) {
  const [state, setState] = useState<LiveState<T>>({
    status: 'loading',
    data: null,
    error: null,
    refreshing: false,
    updatedAt: null
  })
  const inFlight = useRef<AbortController | null>(null)

  const load = useCallback(async () => {
    if (!url) {
      inFlight.current?.abort()
      setState({ status: 'loading', data: null, error: null, refreshing: false, updatedAt: null })
      return
    }
    inFlight.current?.abort()
    const ac = new AbortController()
    inFlight.current = ac
    setState((prev) => ({ ...prev, refreshing: true }))
    try {
      const data = await getJson<T>(url, ac.signal)
      if (ac.signal.aborted) return
      setState({ status: 'ready', data, error: null, refreshing: false, updatedAt: Date.now() })
    } catch (err) {
      if (ac.signal.aborted) return
      const message = err instanceof Error ? err.message : '请求失败'
      setState((prev) =>
        prev.data
          ? { ...prev, status: 'ready', error: message, refreshing: false }
          : { status: 'error', data: null, error: message, refreshing: false, updatedAt: null }
      )
    }
  }, [url])

  useEffect(() => {
    load()
    return () => inFlight.current?.abort()
  }, [load])

  useEffect(() => {
    if (!url || pollMs <= 0) return
    let timer: number | null = null
    const start = () => {
      if (timer === null) timer = window.setInterval(() => load(), pollMs)
    }
    const stop = () => {
      if (timer !== null) {
        window.clearInterval(timer)
        timer = null
      }
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        load()
        start()
      } else {
        stop()
      }
    }
    if (document.visibilityState === 'visible') start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [url, load, pollMs])

  return { ...state, refresh: load, retry: load }
}

type SystemState =
  | { status: 'loading'; data: null; error: null; refreshing: boolean }
  | { status: 'ready'; data: SystemSnapshot; error: null; refreshing: boolean }
  | { status: 'error'; data: null; error: string; refreshing: boolean }

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function usage(value: unknown): ResourceUsage | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const total = numOrNull(raw.total)
  const free = numOrNull(raw.free)
  const used = numOrNull(raw.used) ?? (total != null && free != null ? total - free : null)
  if (total == null && free == null && used == null) return null
  return { total, free, used }
}

/**
 * 把 `/api/system` 的扁平/嵌套两种形态归一化成一个快照。
 * 扁平字段优先：online / latencyMs / vram.free / queue，其次兼容 studio.*。
 */
export function normalizeSystem(raw: SystemResponse | null | undefined, fallback = false): SystemSnapshot {
  const root = (raw?.data && typeof raw.data === 'object' ? raw.data : raw) ?? {}
  const studio = root.studio ?? {}
  const online = Boolean(studio.online ?? root.online)
  const latencyMs = numOrNull(studio.latencyMs) ?? numOrNull(root.latencyMs)
  const vram = usage(root.vram)
  const ram = usage(root.ram)
  const queue =
    root.queue && typeof root.queue === 'object'
      ? { running: numOrNull(root.queue.running) ?? 0, pending: numOrNull(root.queue.pending) ?? 0 }
      : null
  return {
    online,
    latencyMs,
    vram,
    ram,
    queue,
    error: studio.error ?? root.error ?? null,
    configuredUrl: typeof root.configuredUrl === 'string' && root.configuredUrl ? root.configuredUrl : null,
    checkedAt: root.checkedAt ?? null,
    fallback
  }
}

/**
 * 算力/队列状态：优先 `/api/system`；接口未就绪时回退 `/api/health`
 * （回退时 vram/ram/queue 明确为 null，界面显示「无数据」，不编造数字）。
 * 带 AbortController、页面可见性感知与手动 refresh()。
 */
export function useSystem(pollMs = 30000) {
  const [state, setState] = useState<SystemState>({ status: 'loading', data: null, error: null, refreshing: false })
  const inFlight = useRef<AbortController | null>(null)

  const load = useCallback(async () => {
    inFlight.current?.abort()
    const ac = new AbortController()
    inFlight.current = ac
    setState((prev) => ({ ...prev, refreshing: true }))
    try {
      const data = await getJson<SystemResponse>('/api/system', ac.signal)
      if (!ac.signal.aborted) {
        setState({ status: 'ready', data: normalizeSystem(data), error: null, refreshing: false })
      }
    } catch {
      if (ac.signal.aborted) return
      try {
        const health = await getJson<HealthResponse>('/api/health', ac.signal)
        if (ac.signal.aborted) return
        setState({
          status: 'ready',
          error: null,
          refreshing: false,
          data: normalizeSystem(
            {
              online: health.comfyui.ok,
              latencyMs: health.comfyui.latencyMs,
              error: health.comfyui.error,
              configuredUrl: health.comfyui.configuredUrl,
              checkedAt: health.checkedAt,
              vram: null,
              ram: null,
              queue: null
            },
            true
          )
        })
      } catch (err) {
        if (ac.signal.aborted) return
        setState((prev) =>
          prev.status === 'ready'
            ? { ...prev, refreshing: false }
            : {
                status: 'error',
                data: null,
                error: err instanceof Error ? err.message : '请求失败',
                refreshing: false
              }
        )
      }
    }
  }, [])

  useEffect(() => {
    load()
    return () => inFlight.current?.abort()
  }, [load])

  useEffect(() => {
    if (pollMs <= 0) return
    let timer: number | null = null
    const start = () => {
      if (timer === null) timer = window.setInterval(() => load(), pollMs)
    }
    const stop = () => {
      if (timer !== null) {
        window.clearInterval(timer)
        timer = null
      }
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        load()
        start()
      } else {
        stop()
      }
    }
    if (document.visibilityState === 'visible') start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [load, pollMs])

  return { ...state, refresh: load }
}

export class HttpError extends Error {
  status: number
  /** 后端原始错误体（如 `{error:"brief_schema_invalid",path,reason}`）；非 JSON 时为 null。 */
  payload: unknown

  constructor(status: number, message: string, payload: unknown = null) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.payload = payload
  }
}

/** issue #77：读取人工验证状态（不传 key 时返回整份 store + 计数）。 */
export function getManualVerify(key?: string): Promise<ManualVerifyView | ManualVerifyList> {
  const url = key ? `/api/manual-verify?key=${encodeURIComponent(key)}` : '/api/manual-verify'
  return getJson<ManualVerifyView | ManualVerifyList>(url)
}

/** issue #77：写入人工验证状态；401/403 由调用方按 HttpError 显示。 */
export function setManualVerify(
  key: string,
  state: ManualVerifyState,
  note: string | null
): Promise<ManualVerifyView> {
  return postJson<ManualVerifyView>('/api/manual-verify', { key, state, note })
}

/** 写 JSON；错误消息优先取后端的 `{ error }`，并保留状态码与原始 body 供调用方细分。 */
async function requestJson<T>(
  method: 'POST' | 'PATCH' | 'DELETE',
  url: string,
  body?: unknown
): Promise<T> {
  const res = await fetch(url, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  })
  if (!res.ok) {
    let message = `HTTP ${res.status}`
    let payload: unknown = null
    try {
      payload = await res.json()
      if (
        payload !== null &&
        typeof payload === 'object' &&
        typeof (payload as { error?: unknown }).error === 'string'
      ) {
        message = (payload as { error: string }).error
      }
    } catch {
      /* body was not json */
    }
    throw new HttpError(res.status, message, payload)
  }
  return (await res.json()) as T
}

/** POST JSON；错误消息优先取后端的 `{ error }`，并保留状态码供调用方区分 401/403。 */
export function postJson<T>(url: string, body: unknown): Promise<T> {
  return requestJson<T>('POST', url, body)
}

/** PATCH JSON；错误处理与 postJson 一致（#87 Brief 润色结果保存）。 */
export function patchJson<T>(url: string, body: unknown): Promise<T> {
  return requestJson<T>('PATCH', url, body)
}

/** DELETE（#107 交付软删）；错误处理与 postJson 一致，供调用方区分 401/403/404。 */
export function deleteJson<T>(url: string): Promise<T> {
  return requestJson<T>('DELETE', url)
}
