/**
 * #103 `/flow` 的 job 深链与默认 job（纯函数，便于单测）。
 *
 * 行为契约：
 * - `?job=<id>` 决定首屏请求；空白值视为未指定，走 `/api/flow` 默认（最近一次 state）。
 * - 未显式选择时仍用默认 feed 返回的 `job` 渲染解释层（不是空页面）。
 * - 下拉切换 / 「回到最新 job」把选择写回 URL，刷新与分享后仍停在同一个 job。
 */

/** 读 `?job=`；缺失、空串、全空白都视为未指定。 */
export function parseJobParam(search: string): string | null {
  const id = new URLSearchParams(search).get('job')
  return id && id.trim() ? id.trim() : null
}

/** 把选择写回 search（null/空白 = 删除参数），返回 `?a=1` 形式（无参数时为空串）。 */
export function jobSearch(search: string, id: string | null): string {
  const params = new URLSearchParams(search)
  if (id && id.trim()) params.set('job', id.trim())
  else params.delete('job')
  const query = params.toString()
  return query ? `?${query}` : ''
}

/** 首页数据源：显式选择才带 job 参数；否则读默认 feed。 */
export function flowRequestUrl(selected: string | null): string {
  return selected ? `/api/flow?job=${encodeURIComponent(selected)}` : '/api/flow'
}

type FlowJobRef = { id?: string | null } | null | undefined
type FlowJobFeed = { job?: FlowJobRef; jobs?: FlowJobRef[] | null } | null | undefined

/**
 * 当前应展示/查询的 job id：显式选择优先；未选择时用默认 feed 的 job，
 * 再退回 jobs 列表第一项。返回 null 表示确实没有可展示的 job。
 */
export function resolveFlowJobId(selected: string | null, data: FlowJobFeed): string | null {
  if (selected) return selected
  return data?.job?.id ?? data?.jobs?.[0]?.id ?? null
}
