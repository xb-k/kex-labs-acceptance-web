import { AgentsApiError } from '../../agents'
import type { AgentHost, AgentProject, AgentType } from '../../types'

export const TYPES: AgentType[] = ['skill', 'agent', 'profile']

export const TYPE_LABEL: Record<AgentType, string> = {
  skill: 'Skill',
  agent: 'Agent',
  profile: 'Profile'
}

export const TYPE_HINT: Record<AgentType, string> = {
  skill: '技能定义（SKILL.md）',
  agent: '角色 / 子 agent 定义',
  profile: '导演 / 调色 Profile（JSON）'
}

export const namespaceLabel: Record<string, string> = {
  seed: '种子',
  import: '导入',
  user: '用户'
}

export const PROJECT_GROUPS: AgentProject[] = ['kex-labs-video', 'agent-memory', 'lofa', '通用', '未分组']
export const HOST_GROUPS: AgentHost[] = ['macbook', 'studio', '未指定']

export type GroupMode = 'project' | 'host'

export const inputClass =
  'h-10 w-full rounded-[10px] border border-black/[0.1] bg-white px-3 text-sm text-apple-text transition-colors placeholder:text-apple-subtext/70 focus:border-apple-blue focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/25'

export const selectClass =
  'h-9 rounded-[10px] border border-black/[0.1] bg-white px-2.5 text-[12px] text-apple-text transition-colors focus:border-apple-blue focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/25'

export const secondaryButton =
  'inline-flex h-9 items-center justify-center gap-1.5 rounded-full border border-black/[0.1] bg-white px-3.5 text-[12px] font-medium text-apple-text transition-colors hover:bg-[#FAFAFC] focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/40 disabled:cursor-not-allowed disabled:opacity-45'

export const primaryButton =
  'inline-flex h-9 items-center justify-center gap-1.5 rounded-full bg-apple-blue px-4 text-[13px] font-medium text-white transition-colors hover:bg-[#0062C4] focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50 disabled:cursor-not-allowed disabled:opacity-45'

export const dangerButton =
  'inline-flex h-9 items-center justify-center gap-1.5 rounded-full bg-apple-red px-4 text-[13px] font-medium text-white transition-colors hover:bg-[#D92D24] focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-red/50 disabled:cursor-not-allowed disabled:opacity-45'

export function describeError(err: unknown): string {
  if (err instanceof AgentsApiError) {
    const reason = err.reason ? `：${err.reason}` : ''
    if (err.status === 401) {
      return `写入需要令牌（401）${reason}。请配置 WEB_WRITE_TOKEN，或从同源页面操作。`
    }
    if (err.status === 403) {
      return `写入被拒绝（403）${reason}。仅允许同源或带 X-Web-Token 的请求。`
    }
    switch (err.code) {
      case 'license_required':
        return `需要 license，已拒绝导入${reason}`
      case 'secret_detected':
        return `内容含疑似密钥，已拒绝${reason}`
      case 'url_not_allowed':
        return `URL 不在允许的 GitHub raw / jsDelivr 名单内${reason}`
      case 'already_exists':
        return `同 id 已存在，请改用「编辑」保存新版本${reason}`
      case 'content_too_large':
        return `文件过大（上限 256KB）${reason}`
      case 'invalid_id':
        return `id 不合法${reason}`
      case 'invalid_url':
        return `URL 不合法${reason}`
      case 'not_found':
        return `定义不存在${reason}`
      case 'version_not_found':
        return `版本不存在${reason}`
      case 'content_missing':
        return `active 版本内容缺失${reason}`
      case 'invalid_type':
        return `类型不合法${reason}`
      case 'invalid_body':
        return `请求内容不合法${reason}`
      case 'timeout':
        return `拉取超时（10 秒），请稍后重试${reason}`
      default:
        return `${err.code}（HTTP ${err.status}）${reason}`
    }
  }
  return err instanceof Error ? err.message : '请求失败'
}

export function shortSha(sha: string): string {
  return sha.length > 12 ? `${sha.slice(0, 12)}…` : sha
}

export function diffLineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'text-apple-subtext'
  if (line.startsWith('@@')) return 'text-apple-blueInk'
  if (line.startsWith('+')) return 'bg-[#EAF8EE] text-[#1E7A3C]'
  if (line.startsWith('-')) return 'bg-[#FCEDEB] text-[#B3261E]'
  return 'text-[#4A4A4F]'
}

export function validateJsonContent(raw: string): { ok: true } | { ok: false; message: string } {
  try {
    JSON.parse(raw)
    return { ok: true }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'JSON 语法无效' }
  }
}
