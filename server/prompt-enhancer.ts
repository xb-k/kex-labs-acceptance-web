/**
 * #160 一句话 → 写实增强（规则 + 模板 v1，不调用 LLM）。
 *
 * 契约：`POST /api/prompts/enhance`
 *   body `{ prompt, scene?, ratio?, negative? }`
 *   → `{ prompt, negative, scene, clauses, source: 'rules', version: 'v1' }`
 *
 * - 空 prompt / 超过 500 字 → 400 `prompt_invalid`；
 * - 显式 scene 未命中场景包 → 400 `scene_invalid`；未给则按关键词识别，
 *   无匹配回退到 `general`；
 * - 原句作为主体保留在最前，只追加镜头/光线/材质/色温/颗粒子句（≤8 条、去重）；
 * - negative = 全局默认 negative 与用户输入合并去重。
 *
 * 场景包是唯一数据源 `server/prompt-scenes.json`，这里只做解析与合并。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import scenesData from './prompt-scenes.json'

export type ScenePack = {
  aliases: string[]
  keywords: string[]
  clauses: string[]
}

export type PromptScenes = {
  version: string
  source: 'rules'
  fallback: string
  negative: string
  scenes: Record<string, ScenePack>
}

export const PROMPT_MAX = 500
export const CLAUSES_MAX = 8
export const SCENES = scenesData as PromptScenes
export const GLOBAL_NEGATIVE = SCENES.negative

export type EnhancePromptInput = {
  prompt: string
  scene?: string
  ratio?: string
  /** 前端用户输入的 negative；与全局默认合并去重。 */
  negative?: string
}

export type EnhancePromptResult = {
  prompt: string
  negative: string
  scene: string
  clauses: string[]
  source: 'rules'
  version: 'v1'
}

export type EnhanceValidation =
  | { ok: true; value: EnhancePromptInput }
  | { ok: false; status: 400; error: 'invalid_body' | 'prompt_invalid' | 'scene_invalid' }

function charCount(value: string): number {
  return [...value].length
}

function normalizeForCompare(value: string): string {
  return value.replace(/\s+/g, '').toLowerCase()
}

/** 显式 scene 解析：场景名（中文）或 JSON 里的 aliases 都接受，大小写不敏感。 */
export function resolveScene(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (Object.hasOwn(SCENES.scenes, trimmed)) return trimmed
  const key = trimmed.toLowerCase()
  for (const [scene, pack] of Object.entries(SCENES.scenes)) {
    if (scene.toLowerCase() === key) return scene
    if (pack.aliases.some((alias) => alias.toLowerCase() === key)) return scene
  }
  return null
}

/** 关键词命中数最高的场景；全 0 时回退 fallback（JSON 顺序决定并列时的优先级）。 */
export function detectScene(prompt: string): string {
  const text = prompt.toLowerCase()
  let best: string = SCENES.fallback
  let bestHits = 0
  for (const [scene, pack] of Object.entries(SCENES.scenes)) {
    if (scene === SCENES.fallback) continue
    let hits = 0
    for (const keyword of pack.keywords) {
      if (text.includes(keyword.toLowerCase())) hits += 1
    }
    if (hits > bestHits) {
      best = scene
      bestHits = hits
    }
  }
  return best
}

/** 全局默认 negative + 用户输入：按逗号/顿号/分号/换行切分，忽略大小写去重。 */
export function mergeNegative(defaultNegative: string, userNegative = ''): string {
  const merged: string[] = []
  const seen = new Set<string>()
  for (const part of `${defaultNegative}\n${userNegative}`.split(/[，,、;；\n]+/)) {
    const value = part.trim()
    if (!value) continue
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(value)
  }
  return merged.join(', ')
}

function appendClauses(original: string, pack: ScenePack): { prompt: string; clauses: string[] } {
  const base = original.trim().replace(/[，,、;；。.\s]+$/, '')
  const baseKey = normalizeForCompare(base)
  const seen = new Set<string>()
  const clauses: string[] = []
  for (const raw of pack.clauses) {
    const clause = raw.trim()
    if (!clause) continue
    const key = normalizeForCompare(clause)
    if (seen.has(key) || baseKey.includes(key)) continue
    seen.add(key)
    clauses.push(clause)
    if (clauses.length >= CLAUSES_MAX) break
  }
  return {
    prompt: clauses.length > 0 ? `${base}，${clauses.join('，')}` : base,
    clauses
  }
}

/** 规则增强：确定性纯函数，同输入同输出。 */
export function enhancePrompt(input: EnhancePromptInput): EnhancePromptResult {
  const original = input.prompt.trim()
  const explicit = input.scene ? resolveScene(input.scene) : null
  const scene = explicit ?? detectScene(original)
  const pack = SCENES.scenes[scene] ?? SCENES.scenes[SCENES.fallback]
  const appended = appendClauses(original, pack)
  return {
    prompt: appended.prompt,
    negative: mergeNegative(GLOBAL_NEGATIVE, input.negative ?? ''),
    scene,
    clauses: appended.clauses,
    source: 'rules',
    version: 'v1'
  }
}

export function validateEnhanceInput(body: unknown): EnhanceValidation {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, error: 'invalid_body' }
  }
  const input = body as Record<string, unknown>
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || charCount(input.prompt) > PROMPT_MAX) {
    return { ok: false, status: 400, error: 'prompt_invalid' }
  }
  if (input.scene !== undefined && typeof input.scene !== 'string') {
    return { ok: false, status: 400, error: 'scene_invalid' }
  }
  const rawScene = typeof input.scene === 'string' ? input.scene.trim() : ''
  const scene = rawScene ? resolveScene(rawScene) : null
  if (rawScene && !scene) return { ok: false, status: 400, error: 'scene_invalid' }
  if (input.negative !== undefined && typeof input.negative !== 'string') {
    return { ok: false, status: 400, error: 'invalid_body' }
  }
  if (input.ratio !== undefined && typeof input.ratio !== 'string') {
    return { ok: false, status: 400, error: 'invalid_body' }
  }
  return {
    ok: true,
    value: {
      prompt: input.prompt.trim(),
      ...(scene ? { scene } : {}),
      ...(typeof input.ratio === 'string' && input.ratio.trim() ? { ratio: input.ratio.trim() } : {}),
      ...(typeof input.negative === 'string' ? { negative: input.negative } : {})
    }
  }
}

export type PromptEnhancerDeps = {
  readBody: (req: IncomingMessage) => Promise<unknown>
  authorize: (req: IncomingMessage) => { ok: true } | { ok: false; status: number; error: string }
  sendJson: (res: ServerResponse, status: number, body: unknown) => void
}

/** 路由处理；返回 true 表示已消费请求。 */
export async function handlePromptEnhancerRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  deps: PromptEnhancerDeps
): Promise<boolean> {
  if (pathname !== '/api/prompts/enhance') return false
  if (req.method !== 'POST') {
    res.statusCode = 405
    res.setHeader('Allow', 'POST')
    res.end()
    return true
  }
  const auth = deps.authorize(req)
  if (!auth.ok) {
    deps.sendJson(res, auth.status, { error: auth.error })
    return true
  }
  let body: unknown
  try {
    body = await deps.readBody(req)
  } catch {
    deps.sendJson(res, 400, { error: 'invalid_body' })
    return true
  }
  const validated = validateEnhanceInput(body)
  if (!validated.ok) {
    deps.sendJson(res, validated.status, { error: validated.error })
    return true
  }
  deps.sendJson(res, 200, enhancePrompt(validated.value))
  return true
}
