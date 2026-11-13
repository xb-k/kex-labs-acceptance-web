/**
 * #108 风险处置（risk decisions）。
 *
 * 报表风险清单来自 `/api/reports/weekly`（blocked 任务 + overdue 偏差），每行
 * 需要一个人工处置入口。处置动作先落 `<WEB_DATA_ROOT>/decisions/risk-approvals.jsonl`
 * （追加写、按 task 倒序读），同一次提交再在任务关联的 Gitea issue 下发一条评论，
 * 让开发在 issue 里看到「谁在什么时候把风险定成了什么」。
 *
 * 契约细节：
 *  - 动作只有四个中文值（见 `RISK_ACTIONS`），直接落库，不再做二次映射；
 *  - `暂停等开发` / `改期` 必须写备注；备注上限 500 字，操作者 1..40 字；
 *  - 评论失败不落库（调用方拿到 502），避免「库里有、开发不知道」。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const RISK_ACTIONS = ['同意了继续', '暂停等开发', '改期', '接受风险（已知）'] as const
export type RiskAction = (typeof RISK_ACTIONS)[number]

/** 这两个动作必须说明原因，否则开发无法执行。 */
const NOTE_REQUIRED: readonly RiskAction[] = ['暂停等开发', '改期']

export const ACTOR_MAX = 40
export const NOTE_MAX = 500
export const TASK_ID_MAX = 80

export type RiskDecision = {
  id: string
  ts: string
  task_id: string
  action: RiskAction
  actor: string
  note: string
  issue_number: number | null
  comment_id: string | null
  comment_url: string | null
}

export type RiskDecisionInput = {
  task_id: string
  action: RiskAction
  actor: string
  note: string
}

export type RiskTask = {
  id: string
  title?: string
  issue_number?: number | null
}

export type RiskComment = { id: string; url: string | null }

export class RiskDecisionError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'RiskDecisionError'
    this.status = status
  }
}

export function riskDecisionFile(dataRoot: string): string {
  return path.join(dataRoot, 'decisions', 'risk-approvals.jsonl')
}

function isRiskAction(value: unknown): value is RiskAction {
  return typeof value === 'string' && (RISK_ACTIONS as readonly string[]).includes(value)
}

/** 校验 POST body；返回规范化后的输入或可读 400 文案。 */
export function validateRiskDecision(
  body: unknown
): { ok: true; value: RiskDecisionInput } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'body: 必须是 JSON 对象' }
  }
  const raw = body as Record<string, unknown>
  if (typeof raw.task_id !== 'string' || !raw.task_id.trim()) {
    return { ok: false, error: 'task_id: 必填' }
  }
  const task_id = raw.task_id.trim()
  if (task_id.length > TASK_ID_MAX) return { ok: false, error: `task_id: 长度需 1..${TASK_ID_MAX}` }
  if (!isRiskAction(raw.action)) {
    return { ok: false, error: `action: 只能是 ${RISK_ACTIONS.join(' / ')}` }
  }
  if (typeof raw.actor !== 'string' || !raw.actor.trim()) {
    return { ok: false, error: 'actor: 必填（1~40 字）' }
  }
  const actor = raw.actor.trim()
  if (actor.length > ACTOR_MAX) return { ok: false, error: `actor: 长度需 1..${ACTOR_MAX}` }
  if (raw.note !== undefined && raw.note !== null && typeof raw.note !== 'string') {
    return { ok: false, error: 'note: 必须是字符串' }
  }
  const note = typeof raw.note === 'string' ? raw.note.trim() : ''
  if (note.length > NOTE_MAX) return { ok: false, error: `note: 长度不能超过 ${NOTE_MAX}` }
  if (NOTE_REQUIRED.includes(raw.action) && !note) {
    return { ok: false, error: `note: 「${raw.action}」必须填写备注` }
  }
  return { ok: true, value: { task_id, action: raw.action, actor, note } }
}

function parseLine(line: string): RiskDecision | null {
  try {
    const raw = JSON.parse(line) as Record<string, unknown>
    if (!raw || typeof raw !== 'object') return null
    if (typeof raw.id !== 'string' || typeof raw.task_id !== 'string') return null
    if (!isRiskAction(raw.action)) return null
    if (typeof raw.ts !== 'string' || Number.isNaN(Date.parse(raw.ts))) return null
    return {
      id: raw.id,
      ts: raw.ts,
      task_id: raw.task_id,
      action: raw.action,
      actor: typeof raw.actor === 'string' ? raw.actor : '',
      note: typeof raw.note === 'string' ? raw.note : '',
      issue_number: typeof raw.issue_number === 'number' ? raw.issue_number : null,
      comment_id: typeof raw.comment_id === 'string' ? raw.comment_id : null,
      comment_url: typeof raw.comment_url === 'string' ? raw.comment_url : null
    }
  } catch {
    return null
  }
}

/** 读取全部处置记录（坏行跳过，不让单个坏行阻塞报表）。 */
export function readRiskDecisions(dataRoot: string): RiskDecision[] {
  const file = riskDecisionFile(dataRoot)
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const out: RiskDecision[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const item = parseLine(line)
    if (item) out.push(item)
  }
  return out
}

function byNewest(a: RiskDecision, b: RiskDecision): number {
  const at = Date.parse(a.ts)
  const bt = Date.parse(b.ts)
  if (at !== bt) return bt - at
  return b.id.localeCompare(a.id)
}

/** `GET /api/risk-decisions?task=`：倒序；task 为空时返回全部。 */
export function listRiskDecisions(dataRoot: string, taskId?: string | null): RiskDecision[] {
  const wanted = taskId?.trim()
  return readRiskDecisions(dataRoot)
    .filter((item) => !wanted || item.task_id === wanted)
    .sort(byNewest)
}

/** 单行 O_APPEND，避免并发提交互相覆盖。 */
export function appendRiskDecision(dataRoot: string, decision: RiskDecision): void {
  const file = riskDecisionFile(dataRoot)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, `${JSON.stringify(decision)}\n`, 'utf8')
}

export function formatRiskCommentTime(iso: string): string {
  const date = new Date(iso)
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(date)
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}（+08:00）`
}

/** AC3 评论正文：标题 + 任务 id/标题 + 操作者 + 时间 + 备注。 */
export function buildRiskComment(
  input: RiskDecisionInput,
  task: RiskTask,
  at: string
): string {
  const title = task.title?.trim() || task.id
  const lines = [
    `### 风险处置 · ${input.action}`,
    '',
    `- 任务：${task.id} ${title}`,
    `- 操作者：${input.actor}`,
    `- 时间：${formatRiskCommentTime(at)}`
  ]
  if (input.note) lines.push(`- 备注：${input.note}`)
  return lines.join('\n')
}

export type AddRiskComment = (issueNumber: number, body: string) => Promise<RiskComment>

/**
 * 提交一条处置：定位任务 → 通知 Gitea → 落库。
 * 任务不存在 404、无 issue 409、评论失败 502（此时不写 jsonl）。
 */
export async function createRiskDecision(options: {
  dataRoot: string
  input: RiskDecisionInput
  task: RiskTask | null
  addComment: AddRiskComment
  now?: () => Date
}): Promise<RiskDecision> {
  const { dataRoot, input, task, addComment } = options
  if (!task) throw new RiskDecisionError(404, `task 不存在：${input.task_id}`)
  if (typeof task.issue_number !== 'number' || !Number.isInteger(task.issue_number)) {
    throw new RiskDecisionError(409, '该任务未关联 Gitea issue')
  }
  const now = options.now?.() ?? new Date()
  const at = now.toISOString()
  const commentBody = buildRiskComment(input, task, at)
  let comment: RiskComment
  try {
    comment = await addComment(task.issue_number, commentBody)
  } catch (err) {
    if (err instanceof RiskDecisionError) throw err
    const reason = err instanceof Error ? err.message : String(err)
    throw new RiskDecisionError(502, `通知开发失败：${reason}`)
  }
  const decision: RiskDecision = {
    id: `rd-${now.getTime()}-${crypto.randomBytes(3).toString('hex')}`,
    ts: at,
    task_id: input.task_id,
    action: input.action,
    actor: input.actor,
    note: input.note,
    issue_number: task.issue_number,
    comment_id: comment.id || null,
    comment_url: comment.url || null
  }
  appendRiskDecision(dataRoot, decision)
  return decision
}
