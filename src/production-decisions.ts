/**
 * #162：L3 Orchestrator 决策流水解析与展示文案。
 *
 * decisions/<job>.jsonl 的每一行可能是对象，也可能是 JSON 字符串；字段命名在不同
 * 版本里并不统一（ts/at、args/params）。这里只做「如实映射」：认识的字段转成展示
 * 结构，认不出的保持原值 / 留给原始数据折叠区，不猜测、不编造。
 */

export type DecisionTone = 'success' | 'warn' | 'fail' | 'neutral'

export type ParsedDecision = {
  timestamp: string | null
  role: string | null
  action: string | null
  tool: string | null
  status: string | null
  duration: number | null
  params: Record<string, unknown> | null
  result: unknown
}

const CJK = /[\u3400-\u9fff]/

/** 角色 → 中文名；只收录已知角色，未知角色保留原文。 */
const ROLE_LABELS: Record<string, string> = {
  director: '导演',
  orchestrator: '编排器',
  llm: '大模型',
  scriptwriter: '编剧',
  storyboard_artist: '分镜师',
  cinematographer: '摄影',
  editor: '剪辑',
  qc: '质检',
  reviewer: '质检',
  assembler: '组装',
  human: '人工',
  default_policy: '默认策略'
}

/** 动作 → 可接在角色后的中文动词短语；未知动作保留原文。 */
const ACTION_LABELS: Record<string, string> = {
  choose_storyboard: '选择分镜方案',
  select_storyboard: '选择分镜方案',
  pick_storyboard: '选择分镜方案',
  generate_storyboard: '生成分镜',
  write_script: '编写脚本',
  generate_keyframes: '生成关键帧',
  render_clips: '渲染视频片段',
  render: '渲染视频片段',
  interpolate: '执行插帧',
  upscale: '执行超分增强',
  assemble: '组装成片',
  quality_check: '执行质量检查',
  qc: '执行质量检查',
  review: '执行质量检查',
  retry: '重试',
  skip: '跳过当前环节',
  skip_stage: '跳过当前环节',
  ask_human: '请求人工确认',
  run_tool: '调用工具',
  call_tool: '调用工具',
  use_tool: '调用工具',
  decide: '做出决策',
  stop: '停止流水线',
  continue: '继续下一步'
}

const SUCCESS_STATUS = new Set([
  'ok',
  'success',
  'succeeded',
  'done',
  'complete',
  'completed',
  'pass',
  'passed',
  'adopted',
  'approved',
  'allowed'
])

const WARN_STATUS = new Set(['warn', 'warning', 'retry', 'retrying', 'skipped', 'skip', 'pending', 'running', 'partial'])

const FAIL_STATUS = new Set([
  'fail',
  'failed',
  'error',
  'errored',
  'abort',
  'aborted',
  'cancel',
  'canceled',
  'cancelled',
  'timeout',
  'timed_out',
  'rejected',
  'denied'
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function toTimestamp(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value
    const date = new Date(ms)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }
  return null
}

function toDuration(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function toolName(value: unknown): string | null {
  const direct = firstString(value)
  if (direct) return direct
  if (isRecord(value)) return firstString(value.name, value.tool, value.id)
  return null
}

function emptyDecision(action: string | null): ParsedDecision {
  return {
    timestamp: null,
    role: null,
    action,
    tool: null,
    status: null,
    duration: null,
    params: null,
    result: null
  }
}

function fromRecord(record: Record<string, unknown>): ParsedDecision {
  return {
    timestamp: toTimestamp(record.ts ?? record.timestamp ?? record.at ?? record.time),
    role: firstString(record.role, record.agent, record.agent_role),
    action: firstString(record.action, record.summary, record.message, record.msg),
    tool: toolName(record.tool) ?? toolName(record.tool_name),
    status: firstString(record.status),
    duration: toDuration(record.duration_ms),
    params: isRecord(record.params) ? record.params : isRecord(record.args) ? record.args : null,
    result: record.result ?? null
  }
}

/** 兼容对象 / JSON 字符串 / 纯文本字符串；无法识别时返回 null（原文仍可在折叠区查看）。 */
export function parseDecision(raw: unknown): ParsedDecision | null {
  if (raw == null) return null
  if (typeof raw === 'string') {
    const text = raw.trim()
    if (!text) return null
    try {
      const parsed: unknown = JSON.parse(text)
      if (isRecord(parsed)) return fromRecord(parsed)
      if (typeof parsed === 'string') return emptyDecision(parsed.trim() || null)
      return null
    } catch {
      return emptyDecision(text)
    }
  }
  if (isRecord(raw)) return fromRecord(raw)
  return null
}

function roleLabel(role: string | null): string | null {
  if (!role) return null
  return ROLE_LABELS[role.toLowerCase()] ?? null
}

/**
 * 生成中文动作句。字段不足时返回空串，由页面显式显示「未记录动作」，
 * 不把 raw JSON 当摘要，也不替未知动作编造中文。
 */
export function decisionSummary(dec: ParsedDecision | null): string {
  if (!dec) return ''
  const action = dec.action
  const role = roleLabel(dec.role)
  if (action) {
    if (CJK.test(action)) return action
    const mapped = ACTION_LABELS[action.toLowerCase()]
    if (mapped) {
      if (mapped === '调用工具' && dec.tool) return `调用工具 ${dec.tool}`
      return role ? `${role}${mapped}` : mapped
    }
    return action
  }
  if (dec.tool) return `调用工具 ${dec.tool}`
  return ''
}

/** 状态 → 语义色；未知 / 空状态一律 neutral。 */
export function decisionTone(status: string | null | undefined): DecisionTone {
  const normalized = typeof status === 'string' ? status.trim().toLowerCase() : ''
  if (!normalized) return 'neutral'
  if (SUCCESS_STATUS.has(normalized)) return 'success'
  if (FAIL_STATUS.has(normalized)) return 'fail'
  if (WARN_STATUS.has(normalized)) return 'warn'
  return 'neutral'
}

function clip(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, Math.max(0, max - 1))}…`
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return String(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value) ?? '（无法序列化）'
  } catch {
    return '（无法序列化）'
  }
}

export type DecisionParamChips = { labels: string[]; extra: number }

/** 参数 chips：最多 limit 个，剩余数量用 extra 表示；超长值截断。 */
export function decisionParamChips(dec: ParsedDecision | null, limit = 4): DecisionParamChips {
  if (!dec?.params) return { labels: [], extra: 0 }
  const entries = Object.entries(dec.params)
  const labels = entries
    .slice(0, Math.max(0, limit))
    .map(([key, value]) => `${clip(key, 24)}=${clip(stringifyValue(value), 48)}`)
  return { labels, extra: Math.max(0, entries.length - labels.length) }
}

/** 结果摘要：对象不直接 JSON.stringify，避免 raw JSON 挤进正文。 */
export function decisionResultSummary(dec: ParsedDecision | null): string {
  const result = dec?.result
  if (result == null) return ''
  if (typeof result === 'string') {
    const text = result.trim()
    return text ? clip(text, 120) : ''
  }
  if (typeof result === 'number' || typeof result === 'boolean') return String(result)
  if (Array.isArray(result)) return `数组结果（${result.length} 项）`
  if (isRecord(result)) {
    const keys = Object.keys(result)
    if (keys.length === 0) return '空对象结果'
    const shown = keys.slice(0, 6).join('、')
    return keys.length > 6 ? `对象结果：${shown} 等 ${keys.length} 个字段` : `对象结果：${shown}`
  }
  return clip(String(result), 120)
}

/** `<pre>` 原始数据文本；对象 pretty-print，字符串保持原文。 */
export function decisionRawText(raw: unknown): string {
  if (typeof raw === 'string') return raw
  try {
    return JSON.stringify(raw, null, 2) ?? String(raw)
  } catch {
    return '（无法展示原始数据）'
  }
}
