/**
 * #137 提示词模板（prompt preset）版本化后端。
 *
 * 数据落在 `WEB_DATA_ROOT/prompt-presets/index.json`：
 *   { presets: [{ id, name, current_version, created_at, updated_at,
 *                 versions: [{ version, prompt, params, note, created_at }] }] }
 *
 * 契约：
 *  - `name` 去空白后唯一（大小写不敏感），重复入库 409 `duplicate_name`；≤60 字；
 *  - `prompt` 非空且 ≤8000 字；`params` 必须是 JSON 对象（缺省 `{}`）；`note` 为字符串；
 *  - `POST` 建 v1；`PUT` 追加 version+1 并推进 `current_version`；
 *    每个 preset 最多 50 个版本，再追加 409 `version_limit`；
 *  - 索引写入走「临时文件 + rename」，同进程 read-modify-write 串行化；
 *  - 生成侧引用校验：preset 不存在 → 400 `preset_not_found`，
 *    版本不存在 → 400 `preset_version_not_found`，绝不静默回退到 current。
 */
import crypto from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'

export const NAME_MAX = 60
export const PROMPT_MAX = 8000
export const VERSIONS_MAX = 50

export type PromptVersion = {
  version: number
  prompt: string
  params: Record<string, unknown>
  note: string
  created_at: string
}

export type PromptPreset = {
  id: string
  name: string
  current_version: number
  created_at: string
  updated_at: string
  versions: PromptVersion[]
}

/** 列表项 / 写入响应用：只带 current 版本摘要，不返回全部历史。 */
export type PromptPresetSummary = {
  id: string
  name: string
  current_version: number
  versions_count: number
  created_at: string
  updated_at: string
  current: PromptVersion
}

export type PresetInput = {
  name: string
  prompt: string
  params: Record<string, unknown>
  note: string
}

export type AppendVersionInput = {
  prompt: string
  params: Record<string, unknown>
  note: string
  /** PUT 可选改名；不给则保持原名。 */
  name?: string
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: 400; error: string }

export function promptPresetsDir(dataRoot: string): string {
  return path.join(dataRoot, 'prompt-presets')
}

export function promptPresetsFile(dataRoot: string): string {
  return path.join(promptPresetsDir(dataRoot), 'index.json')
}

/** 去重键：去首尾空白 + 小写，避免「Hero」与「hero 」并存。 */
export function presetNameKey(raw: string): string {
  return raw.trim().toLowerCase()
}

function charCount(value: string): number {
  return [...value].length
}

function parseParams(
  raw: unknown
): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (raw === undefined) return { ok: true, value: {} }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false }
  return { ok: true, value: raw as Record<string, unknown> }
}

function parsePrompt(raw: unknown): { ok: true; value: string } | { ok: false } {
  if (typeof raw !== 'string') return { ok: false }
  if (!raw.trim() || charCount(raw) > PROMPT_MAX) return { ok: false }
  return { ok: true, value: raw }
}

function parseNote(raw: unknown): { ok: true; value: string } | { ok: false } {
  if (raw === undefined) return { ok: true, value: '' }
  if (typeof raw !== 'string') return { ok: false }
  return { ok: true, value: raw }
}

export function validateCreateInput(body: unknown): ValidationResult<PresetInput> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, error: 'invalid_body' }
  }
  const input = body as Record<string, unknown>

  if (typeof input.name !== 'string') {
    return { ok: false, status: 400, error: 'name_invalid' }
  }
  const name = input.name.trim()
  if (!name || charCount(name) > NAME_MAX) {
    return { ok: false, status: 400, error: 'name_invalid' }
  }

  const prompt = parsePrompt(input.prompt)
  if (!prompt.ok) return { ok: false, status: 400, error: 'prompt_invalid' }

  const params = parseParams(input.params)
  if (!params.ok) return { ok: false, status: 400, error: 'params_invalid' }

  const note = parseNote(input.note)
  if (!note.ok) return { ok: false, status: 400, error: 'note_invalid' }

  return {
    ok: true,
    value: { name, prompt: prompt.value, params: params.value, note: note.value }
  }
}

export function validateVersionInput(body: unknown): ValidationResult<AppendVersionInput> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, error: 'invalid_body' }
  }
  const input = body as Record<string, unknown>

  const prompt = parsePrompt(input.prompt)
  if (!prompt.ok) return { ok: false, status: 400, error: 'prompt_invalid' }

  const params = parseParams(input.params)
  if (!params.ok) return { ok: false, status: 400, error: 'params_invalid' }

  const note = parseNote(input.note)
  if (!note.ok) return { ok: false, status: 400, error: 'note_invalid' }

  let name: string | undefined
  if (input.name !== undefined) {
    if (typeof input.name !== 'string') {
      return { ok: false, status: 400, error: 'name_invalid' }
    }
    const trimmed = input.name.trim()
    if (!trimmed || charCount(trimmed) > NAME_MAX) {
      return { ok: false, status: 400, error: 'name_invalid' }
    }
    name = trimmed
  }

  return {
    ok: true,
    value: {
      prompt: prompt.value,
      params: params.value,
      note: note.value,
      ...(name === undefined ? {} : { name })
    }
  }
}

function normalizeVersion(raw: any): PromptVersion | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (typeof raw.version !== 'number' || !Number.isInteger(raw.version) || raw.version < 1) {
    return null
  }
  if (typeof raw.prompt !== 'string') return null
  const params =
    raw.params && typeof raw.params === 'object' && !Array.isArray(raw.params)
      ? (raw.params as Record<string, unknown>)
      : {}
  return {
    version: raw.version,
    prompt: raw.prompt,
    params,
    note: typeof raw.note === 'string' ? raw.note : '',
    created_at: typeof raw.created_at === 'string' ? raw.created_at : ''
  }
}

function normalizePreset(raw: any): PromptPreset | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (typeof raw.id !== 'string' || !raw.id || typeof raw.name !== 'string') return null
  if (!Array.isArray(raw.versions)) return null
  const versions = raw.versions
    .map(normalizeVersion)
    .filter((entry: PromptVersion | null): entry is PromptVersion => Boolean(entry))
  if (!versions.length) return null
  versions.sort((a: PromptVersion, b: PromptVersion) => a.version - b.version)
  const current =
    versions.find((entry: PromptVersion) => entry.version === raw.current_version) ??
    versions[versions.length - 1]
  return {
    id: raw.id,
    name: raw.name,
    current_version: current.version,
    created_at: typeof raw.created_at === 'string' ? raw.created_at : current.created_at,
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : current.created_at,
    versions
  }
}

export function readPromptPresets(
  dataRoot: string,
  readJson: (file: string) => any | null
): PromptPreset[] {
  const raw = readJson(promptPresetsFile(dataRoot))
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { presets?: unknown }).presets)
      ? (raw as { presets: unknown[] }).presets
      : []
  return list
    .map(normalizePreset)
    .filter((preset: PromptPreset | null): preset is PromptPreset => Boolean(preset))
}

export function summarizePreset(preset: PromptPreset): PromptPresetSummary {
  const current =
    preset.versions.find((entry) => entry.version === preset.current_version) ??
    preset.versions[preset.versions.length - 1]
  return {
    id: preset.id,
    name: preset.name,
    current_version: current.version,
    versions_count: preset.versions.length,
    created_at: preset.created_at,
    updated_at: preset.updated_at,
    current: { ...current, params: { ...current.params } }
  }
}

export function selectVersion(
  preset: PromptPreset,
  version?: number | null
): PromptVersion | null {
  const target = version ?? preset.current_version
  return preset.versions.find((entry) => entry.version === target) ?? null
}

// 同进程内串行化 read-modify-write，避免并发 POST / PUT 互相覆盖。
const writeQueues = new Map<string, Promise<unknown>>()

function withPresetLock<T>(file: string, fn: () => T | Promise<T>): Promise<T> {
  const previous = writeQueues.get(file) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(fn)
  writeQueues.set(file, next)
  return next.finally(() => {
    if (writeQueues.get(file) === next) writeQueues.delete(file)
  })
}

export type CreatePresetResult =
  | { ok: true; preset: PromptPreset; version: PromptVersion }
  | { ok: false; status: 409; error: 'duplicate_name' }

export async function createPreset(opts: {
  dataRoot: string
  input: PresetInput
  readJson: (file: string) => any | null
  atomicWriteJson: (file: string, value: unknown) => void
  now?: () => Date
}): Promise<CreatePresetResult> {
  const file = promptPresetsFile(opts.dataRoot)
  const key = presetNameKey(opts.input.name)
  return withPresetLock(file, () => {
    const presets = readPromptPresets(opts.dataRoot, opts.readJson)
    if (presets.some((preset) => presetNameKey(preset.name) === key)) {
      return { ok: false, status: 409, error: 'duplicate_name' } as const
    }
    const stamp = (opts.now?.() ?? new Date()).toISOString()
    const version: PromptVersion = {
      version: 1,
      prompt: opts.input.prompt,
      params: opts.input.params,
      note: opts.input.note,
      created_at: stamp
    }
    const preset: PromptPreset = {
      id: `preset_${crypto.randomUUID()}`,
      name: opts.input.name,
      current_version: 1,
      created_at: stamp,
      updated_at: stamp,
      versions: [version]
    }
    opts.atomicWriteJson(file, { presets: [...presets, preset] })
    return { ok: true, preset, version } as const
  })
}

export type AppendVersionResult =
  | { ok: true; preset: PromptPreset; version: PromptVersion }
  | {
      ok: false
      status: 404 | 409
      error: 'preset_not_found' | 'duplicate_name' | 'version_limit'
    }

export async function appendPresetVersion(opts: {
  dataRoot: string
  id: string
  input: AppendVersionInput
  readJson: (file: string) => any | null
  atomicWriteJson: (file: string, value: unknown) => void
  now?: () => Date
}): Promise<AppendVersionResult> {
  const file = promptPresetsFile(opts.dataRoot)
  return withPresetLock(file, () => {
    const presets = readPromptPresets(opts.dataRoot, opts.readJson)
    const index = presets.findIndex((preset) => preset.id === opts.id)
    if (index < 0) {
      return { ok: false, status: 404, error: 'preset_not_found' } as const
    }
    const preset = presets[index]

    if (opts.input.name !== undefined) {
      const key = presetNameKey(opts.input.name)
      if (presets.some((entry, i) => i !== index && presetNameKey(entry.name) === key)) {
        return { ok: false, status: 409, error: 'duplicate_name' } as const
      }
    }

    if (preset.versions.length >= VERSIONS_MAX) {
      return { ok: false, status: 409, error: 'version_limit' } as const
    }

    const stamp = (opts.now?.() ?? new Date()).toISOString()
    const nextVersion = Math.max(...preset.versions.map((entry) => entry.version)) + 1
    const version: PromptVersion = {
      version: nextVersion,
      prompt: opts.input.prompt,
      params: opts.input.params,
      note: opts.input.note,
      created_at: stamp
    }
    const updated: PromptPreset = {
      ...preset,
      name: opts.input.name ?? preset.name,
      current_version: nextVersion,
      updated_at: stamp,
      versions: [...preset.versions, version]
    }
    const nextPresets = presets.slice()
    nextPresets[index] = updated
    opts.atomicWriteJson(file, { presets: nextPresets })
    return { ok: true, preset: updated, version } as const
  })
}

export async function deletePreset(opts: {
  dataRoot: string
  id: string
  readJson: (file: string) => any | null
  atomicWriteJson: (file: string, value: unknown) => void
}): Promise<PromptPresetSummary | null> {
  const file = promptPresetsFile(opts.dataRoot)
  return withPresetLock(file, () => {
    const presets = readPromptPresets(opts.dataRoot, opts.readJson)
    const index = presets.findIndex((preset) => preset.id === opts.id)
    if (index < 0) return null
    const [removed] = presets.splice(index, 1)
    opts.atomicWriteJson(file, { presets })
    return summarizePreset(removed)
  })
}

export type PresetReferenceCheck =
  | { ok: true; preset: PromptPreset; version: PromptVersion; is_current: boolean }
  | { ok: false; status: 400; error: 'preset_not_found' | 'preset_version_not_found' }

/**
 * 生成侧引用校验。`version` 缺省时校验 current，但显式给了不存在的版本
 * 必须报 `preset_version_not_found`，不允许静默回退。
 */
export function validatePresetReference(opts: {
  dataRoot: string
  id: string
  version?: number | null
  readJson: (file: string) => any | null
}): PresetReferenceCheck {
  const preset = readPromptPresets(opts.dataRoot, opts.readJson).find(
    (entry) => entry.id === opts.id
  )
  if (!preset) return { ok: false, status: 400, error: 'preset_not_found' }
  const version = selectVersion(preset, opts.version)
  if (!version) return { ok: false, status: 400, error: 'preset_version_not_found' }
  return {
    ok: true,
    preset,
    version,
    is_current: version.version === preset.current_version
  }
}

export type PromptPresetsDeps = {
  dataRoot: string
  readJson: (file: string) => any | null
  atomicWriteJson: (file: string, value: unknown) => void
  readBody: (req: IncomingMessage) => Promise<unknown>
  authorize: (req: IncomingMessage) => { ok: true } | { ok: false; status: number; error: string }
  sendJson: (res: ServerResponse, status: number, body: unknown) => void
  now?: () => Date
}

const ID_PATH = /^\/api\/prompt-presets\/([^/]+)$/
const VALIDATE_PATH = /^\/api\/prompt-presets\/([^/]+)\/validate$/

function methodNotAllowed(res: ServerResponse, allow: string): void {
  res.statusCode = 405
  res.setHeader('Allow', allow)
  res.end()
}

function parseVersionValue(
  raw: unknown
): { ok: true; value: number | null } | { ok: false } {
  if (raw === undefined || raw === null) return { ok: true, value: null }
  if (typeof raw === 'number') {
    return Number.isSafeInteger(raw) && raw >= 1
      ? { ok: true, value: raw }
      : { ok: false }
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) return { ok: true, value: null }
    if (!/^\d+$/.test(trimmed)) return { ok: false }
    const parsed = Number(trimmed)
    return Number.isSafeInteger(parsed) && parsed >= 1
      ? { ok: true, value: parsed }
      : { ok: false }
  }
  return { ok: false }
}

function parseBodyVersion(body: unknown): { ok: true; value: number | null } | { ok: false } {
  if (body === undefined || body === null || body === '') return { ok: true, value: null }
  if (typeof body !== 'object' || Array.isArray(body)) return { ok: false }
  return parseVersionValue((body as Record<string, unknown>).version)
}

export async function handlePromptPresetsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  pathname: string,
  deps: PromptPresetsDeps
): Promise<boolean> {
  if (pathname === '/api/prompt-presets') {
    if (req.method === 'GET' || req.method === 'HEAD') {
      const items = readPromptPresets(deps.dataRoot, deps.readJson)
        .map(summarizePreset)
        .sort(
          (a, b) =>
            b.updated_at.localeCompare(a.updated_at) ||
            b.created_at.localeCompare(a.created_at) ||
            a.id.localeCompare(b.id)
        )
      deps.sendJson(res, 200, { items, total: items.length })
      return true
    }

    if (req.method === 'POST') {
      const auth = deps.authorize(req)
      if (!auth.ok) {
        deps.sendJson(res, auth.status, { error: auth.error })
        return true
      }
      let body: unknown
      try {
        body = await deps.readBody(req)
      } catch (err) {
        deps.sendJson(res, 400, { error: err instanceof Error ? err.message : 'invalid body' })
        return true
      }
      const validated = validateCreateInput(body)
      if (!validated.ok) {
        deps.sendJson(res, validated.status, { error: validated.error })
        return true
      }
      const created = await createPreset({
        dataRoot: deps.dataRoot,
        input: validated.value,
        readJson: deps.readJson,
        atomicWriteJson: deps.atomicWriteJson,
        now: deps.now
      })
      if (!created.ok) {
        deps.sendJson(res, created.status, { error: created.error })
        return true
      }
      deps.sendJson(res, 201, {
        item: summarizePreset(created.preset),
        version: created.version
      })
      return true
    }

    methodNotAllowed(res, 'GET, HEAD, POST')
    return true
  }

  const validateMatch = VALIDATE_PATH.exec(pathname)
  if (validateMatch) {
    if (req.method !== 'POST') {
      methodNotAllowed(res, 'POST')
      return true
    }
    let body: unknown = undefined
    try {
      body = await deps.readBody(req)
    } catch (err) {
      // validate 的 body 可省略；只有真正的坏 JSON 才 400。
      if (!(err instanceof Error) || !/empty body/i.test(err.message)) {
        deps.sendJson(res, 400, { error: 'invalid_body' })
        return true
      }
    }
    const parsed = parseBodyVersion(body)
    if (!parsed.ok) {
      deps.sendJson(res, 400, { error: 'invalid_version' })
      return true
    }
    const checked = validatePresetReference({
      dataRoot: deps.dataRoot,
      id: validateMatch[1],
      version: parsed.value,
      readJson: deps.readJson
    })
    if (!checked.ok) {
      deps.sendJson(res, checked.status, { error: checked.error })
      return true
    }
    deps.sendJson(res, 200, {
      ok: true,
      item: summarizePreset(checked.preset),
      version: checked.version,
      is_current: checked.is_current
    })
    return true
  }

  const match = ID_PATH.exec(pathname)
  if (!match) return false
  const id = match[1]

  if (req.method === 'GET' || req.method === 'HEAD') {
    const preset = readPromptPresets(deps.dataRoot, deps.readJson).find(
      (entry) => entry.id === id
    )
    if (!preset) {
      deps.sendJson(res, 404, { error: 'preset_not_found' })
      return true
    }
    const parsed = parseVersionValue(url.searchParams.get('version'))
    if (!parsed.ok) {
      deps.sendJson(res, 400, { error: 'invalid_version' })
      return true
    }
    const version = selectVersion(preset, parsed.value)
    if (!version) {
      deps.sendJson(res, 404, { error: 'preset_version_not_found' })
      return true
    }
    deps.sendJson(res, 200, {
      item: summarizePreset(preset),
      version,
      is_current: version.version === preset.current_version
    })
    return true
  }

  if (req.method === 'PUT') {
    const auth = deps.authorize(req)
    if (!auth.ok) {
      deps.sendJson(res, auth.status, { error: auth.error })
      return true
    }
    let body: unknown
    try {
      body = await deps.readBody(req)
    } catch (err) {
      deps.sendJson(res, 400, { error: err instanceof Error ? err.message : 'invalid body' })
      return true
    }
    const validated = validateVersionInput(body)
    if (!validated.ok) {
      deps.sendJson(res, validated.status, { error: validated.error })
      return true
    }
    const appended = await appendPresetVersion({
      dataRoot: deps.dataRoot,
      id,
      input: validated.value,
      readJson: deps.readJson,
      atomicWriteJson: deps.atomicWriteJson,
      now: deps.now
    })
    if (!appended.ok) {
      deps.sendJson(res, appended.status, { error: appended.error })
      return true
    }
    deps.sendJson(res, 200, {
      item: summarizePreset(appended.preset),
      version: appended.version
    })
    return true
  }

  if (req.method === 'DELETE') {
    const auth = deps.authorize(req)
    if (!auth.ok) {
      deps.sendJson(res, auth.status, { error: auth.error })
      return true
    }
    const removed = await deletePreset({
      dataRoot: deps.dataRoot,
      id,
      readJson: deps.readJson,
      atomicWriteJson: deps.atomicWriteJson
    })
    if (!removed) {
      deps.sendJson(res, 404, { error: 'preset_not_found' })
      return true
    }
    deps.sendJson(res, 200, { ok: true, item: removed })
    return true
  }

  methodNotAllowed(res, 'GET, HEAD, PUT, DELETE')
  return true
}
