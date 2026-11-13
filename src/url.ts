/**
 * 外链可达性判断：内网/localhost 地址只在能进内网（LAN / Tailscale）时可达，
 * 公网用户点开只会超时，因此界面要降级成「地址 + 提示 + 复制」。
 */

const PRIVATE_SUFFIXES = ['.local', '.ts.net']

function isPrivateIPv4(host: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!match) return false
  const [a, b] = [Number(match[1]), Number(match[2])]
  // 127.0.0.0/8、10/8、172.16–31、192.168/16
  if (a === 127 || a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  // 100.64.0.0/10（RFC 6598 共享地址段）：Tailscale 设备 IP 就走这段（如 100.92.106.101），
  // 公网不可达，必须按内网处理，否则会把 Tailscale 地址渲染成可点外链。
  if (a === 100 && b >= 64 && b <= 127) return true
  return a === 192 && b === 168
}

/** hostname 是否属于内网（含 localhost / 回环 / 私有网段 / .local / Tailscale）。 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (!host) return false
  if (host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1') return true
  if (PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true
  return isPrivateIPv4(host)
}

/** URL 是否需要内网/Tailscale 才能访问；不可解析的 URL 按「不需要」处理。 */
export function needsIntranet(url: string): boolean {
  try {
    return isPrivateHost(new URL(url).hostname)
  } catch {
    return false
  }
}

export function readSearchParam(key: string): string | null {
  if (typeof window === 'undefined') return null
  return new URLSearchParams(window.location.search).get(key)
}

export function updateSearchParams(
  patch: Record<string, string | null | undefined>,
  mode: 'push' | 'replace' = 'replace'
): void {
  if (typeof window === 'undefined') return
  const next = new URLSearchParams(window.location.search)
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || v === '') next.delete(k)
    else next.set(k, v)
  }
  const qs = next.toString()
  const target = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`
  if (target === `${window.location.pathname}${window.location.search}${window.location.hash}`) return
  if (mode === 'push') window.history.pushState(null, '', target)
  else window.history.replaceState(null, '', target)
}
