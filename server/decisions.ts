/**
 * #122/#127 Production tracker decisions（采纳 / 驳回）。
 *
 * 制片总台每条 Agent 处置只能落到 `WEB_DATA_ROOT/decisions/<job>.jsonl`：
 * `KEX_REPO_ROOT/decisions` 在 NAS 上是只读挂载，不能写。读取侧
 *（`insights.readDecisions`）把两处合并，因此这里只负责追加自己的可写副本。
 *
 * 契约：
 *  - action 只有 `adopt` / `reject`；job 必须是安全文件名（无 `..`）；
 *  - `at` 由服务端生成，不信任客户端时钟；
 *  - 单行 `O_APPEND` 追加，不重写既有行（历史决策不可变）。
 */
import fs from 'node:fs'
import path from 'node:path'

export const DECISION_ACTIONS = ['adopt', 'reject'] as const
export type DecisionAction = (typeof DECISION_ACTIONS)[number]

export const ACTOR_MAX = 40
export const NOTE_MAX = 500
export const STAGE_MAX = 40
export const TOOL_MAX = 120
const JOB_MAX = 128

const JOB_ID_RE = /^[A-Za-z0-9._-]+$/

export type DecisionInput = {
  job: string
  action: DecisionAction
  actor: string
  note: string
  stage: string | null
  tool: string | null
}

export type ProductionDecision = DecisionInput & { at: string }

export class DecisionError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'DecisionError'
    this.status = status
  }
}

export function decisionFile(dataRoot: string, job: string): string {
  return path.join(dataRoot, 'decisions', `${job}.jsonl`)
}

function isSafeJob(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > JOB_MAX) return false
  if (!JOB_ID_RE.test(value)) return false
  return value !== '.' && value !== '..' && !value.includes('..')
}

function isAction(value: unknown): value is DecisionAction {
  return typeof value === 'string' && (DECISION_ACTIONS as readonly string[]).includes(value)
}

function optionalString(
  raw: Record<string, unknown>,
  key: string,
  max: number
): { ok: true; value: string | null } | { ok: false; error: string } {
  const value = raw[key]
  if (value === undefined || value === null) return { ok: true, value: null }
  if (typeof value !== 'string') return { ok: false, error: `${key}: 必须是字符串` }
  const trimmed = value.trim()
  if (!trimmed) return { ok: true, value: null }
  if (trimmed.length > max) return { ok: false, error: `${key}: 长度不能超过 ${max}` }
  return { ok: true, value: trimmed }
}

/** 校验 POST body；返回规范化后的输入或可读 400 文案。 */
export function validateDecision(
  body: unknown
): { ok: true; value: DecisionInput } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'body: 必须是 JSON 对象' }
  }
  const raw = body as Record<string, unknown>
  if (!isSafeJob(raw.job)) {
    return { ok: false, error: 'job: 必填且只能是 [A-Za-z0-9._-]（不含 ..）' }
  }
  if (!isAction(raw.action)) {
    return { ok: false, error: `action: 只能是 ${DECISION_ACTIONS.join(' / ')}` }
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
  const stage = optionalString(raw, 'stage', STAGE_MAX)
  if (!stage.ok) return stage
  const tool = optionalString(raw, 'tool', TOOL_MAX)
  if (!tool.ok) return tool
  return {
    ok: true,
    value: { job: raw.job, action: raw.action, actor, note, stage: stage.value, tool: tool.value }
  }
}

/** 单行 O_APPEND，避免并发提交互相覆盖。 */
export function appendDecision(
  dataRoot: string,
  input: DecisionInput,
  now: () => Date = () => new Date()
): ProductionDecision {
  const decision: ProductionDecision = { ...input, at: now().toISOString() }
  const file = decisionFile(dataRoot, input.job)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, `${JSON.stringify(decision)}\n`, 'utf8')
  return decision
}

function readRequestBody(req: import('node:http').IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      data += chunk
      if (data.length > 64 * 1024) reject(new Error('body too large'))
    })
    req.on('end', () => {
      if (!data.trim()) {
        reject(new Error('empty body'))
        return
      }
      try {
        resolve(JSON.parse(data))
      } catch {
        reject(new Error('invalid JSON'))
      }
    })
    req.on('error', reject)
  })
}

export type DecisionsDeps = {
  dataRoot: string
  env: NodeJS.ProcessEnv
  authorize: (
    req: import('node:http').IncomingMessage,
    env: NodeJS.ProcessEnv
  ) => { ok: true } | { ok: false; status: number; error: string }
  sendJson: (res: import('node:http').ServerResponse, status: number, body: unknown) => void
}

/**
 * `POST /api/decisions`：同源/token 守卫 → 校验 → 追加 jsonl。
 * 返回 true 表示请求已被本路由处理。
 */
export async function handleDecisionsRoute(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  _url: URL,
  pathname: string,
  deps: DecisionsDeps
): Promise<boolean> {
  if (pathname !== '/api/decisions') return false

  if (req.method !== 'POST') {
    res.statusCode = 405
    res.setHeader('Allow', 'POST')
    res.end()
    return true
  }

  const auth = deps.authorize(req, deps.env)
  if (!auth.ok) {
    deps.sendJson(res, auth.status, { error: auth.error })
    return true
  }

  let body: unknown
  try {
    body = await readRequestBody(req)
  } catch (err) {
    deps.sendJson(res, 400, { error: err instanceof Error ? err.message : 'bad body' })
    return true
  }
  const validated = validateDecision(body)
  if (!validated.ok) {
    deps.sendJson(res, 400, { error: validated.error })
    return true
  }

  try {
    const decision = appendDecision(deps.dataRoot, validated.value)
    deps.sendJson(res, 201, { decision })
  } catch (err) {
    console.error('[decisions] unexpected:', err instanceof Error ? err.message : String(err))
    deps.sendJson(res, 500, { error: 'internal error' })
  }
  return true
}
