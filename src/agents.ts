import type {
  AgentDetail,
  AgentDiffResponse,
  AgentImportInput,
  AgentMeta,
  AgentPutResponse,
  AgentSeedResponse,
  AgentType,
  AgentsResponse
} from './types'

/**
 * Agent / Skill 库 API client（Gitea #88b）。
 *
 * 后端所有错误统一返回 `{ error, reason }`；这里保留状态码、错误码与原因，
 * 页面据此显示具体中文文案（401/403 也不静默）。
 */
export class AgentsApiError extends Error {
  status: number
  code: string
  reason: string

  constructor(status: number, code: string, reason: string) {
    super(reason || code)
    this.name = 'AgentsApiError'
    this.status = status
    this.code = code
    this.reason = reason
  }
}

async function readError(res: Response): Promise<AgentsApiError> {
  let code = `HTTP ${res.status}`
  let reason = ''
  try {
    const body = (await res.json()) as { error?: unknown; reason?: unknown }
    if (typeof body.error === 'string' && body.error) code = body.error
    if (typeof body.reason === 'string') reason = body.reason
  } catch {
    /* body was not json */
  }
  return new AgentsApiError(res.status, code, reason)
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) throw await readError(res)
  return (await res.json()) as T
}

function sendJson<T>(
  url: string,
  method: 'POST' | 'PUT',
  body: unknown,
  signal?: AbortSignal
): Promise<T> {
  return request<T>(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {})
  })
}

function itemUrl(type: AgentType, id: string, action?: string): string {
  const base = `/api/agents/${type}/${encodeURIComponent(id)}`
  return action ? `${base}/${action}` : base
}

export function listAgents(params: { q?: string; includeInactive?: boolean } = {}): Promise<AgentsResponse> {
  const search = new URLSearchParams()
  const q = params.q?.trim()
  if (q) search.set('q', q)
  if (params.includeInactive) search.set('include_inactive', '1')
  const suffix = search.toString()
  return request<AgentsResponse>(`/api/agents${suffix ? `?${suffix}` : ''}`)
}

export function getAgent(type: AgentType, id: string): Promise<AgentDetail> {
  return request<AgentDetail>(itemUrl(type, id))
}

export function seedAgents(signal?: AbortSignal): Promise<AgentSeedResponse> {
  return sendJson<AgentSeedResponse>('/api/agents/seed', 'POST', {}, signal)
}

/** #136 导入可取消：signal 由 ImportDialog 持有，取消时真的中断在途请求。 */
export function importAgent(
  input: AgentImportInput,
  signal?: AbortSignal
): Promise<{ meta: AgentMeta }> {
  return sendJson<{ meta: AgentMeta }>('/api/agents/import', 'POST', input, signal)
}

export function saveAgent(
  type: AgentType,
  id: string,
  content: string,
  message?: string
): Promise<AgentPutResponse> {
  return sendJson<AgentPutResponse>(itemUrl(type, id), 'PUT', { content, message })
}

export function rollbackAgent(type: AgentType, id: string, version: number): Promise<{ meta: AgentMeta }> {
  return sendJson<{ meta: AgentMeta }>(itemUrl(type, id, 'rollback'), 'POST', { version })
}

export function toggleAgent(type: AgentType, id: string, active: boolean): Promise<{ meta: AgentMeta }> {
  return sendJson<{ meta: AgentMeta }>(itemUrl(type, id, 'toggle'), 'POST', { active })
}

/** #109 绑定同项目技能：只提交 id，内容留在服务端。 */
export function setAgentSkills(id: string, skills: string[]): Promise<{ meta: AgentMeta }> {
  return sendJson<{ meta: AgentMeta }>(itemUrl('agent', id, 'skills'), 'POST', { skills })
}

export function diffAgent(
  type: AgentType,
  id: string,
  from: number,
  to: number
): Promise<AgentDiffResponse> {
  return request<AgentDiffResponse>(`${itemUrl(type, id, 'diff')}?from=${from}&to=${to}`)
}

/** 导出是 GET 附件下载，交给浏览器 <a download> 处理。 */
export function exportAgentUrl(type: AgentType, id: string): string {
  return itemUrl(type, id, 'export')
}
