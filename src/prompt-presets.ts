/**
 * #137 提示词模板（prompt preset）前端契约与纯函数。
 *
 * 服务端契约（server/prompt-presets.ts）：
 *  - GET    `/api/prompt-presets` → `{ items, total }`（只带 current 版本摘要）
 *  - GET    `/api/prompt-presets/:id?version=` → `{ item, version, is_current }`
 *  - POST   `/api/prompt-presets` → 201 `{ item, version }`（建 v1）
 *  - PUT    `/api/prompt-presets/:id` → `{ item, version }`（追加 version+1）
 *  - DELETE `/api/prompt-presets/:id` → `{ ok, item }`
 *  - POST   `/api/prompt-presets/:id/validate` → 400 `preset_not_found` /
 *           `preset_version_not_found`，绝不静默回退 current
 *
 * 这里只放类型、API 封装、引用状态纯函数与错误文案；渲染在
 * `components/studio/PromptPresetsPanel.tsx`，便于用 react-dom/server 做 SSR 断言。
 */
import { deleteJson, getJson, HttpError, postJson, putJson } from './api'

export const PRESET_NAME_MAX = 60
export const PRESET_PROMPT_MAX = 8000
export const PRESET_VERSIONS_MAX = 50

export type PromptPresetVersion = {
  version: number
  prompt: string
  params: Record<string, unknown>
  note: string
  created_at: string
}

export type PromptPresetSummary = {
  id: string
  name: string
  current_version: number
  versions_count: number
  created_at: string
  updated_at: string
  current: PromptPresetVersion
}

export type PromptPresetList = {
  items: PromptPresetSummary[]
  total: number
}

export type PromptPresetDetail = {
  item: PromptPresetSummary
  version: PromptPresetVersion
  is_current: boolean
}

export type PromptPresetReference = {
  presetId: string
  name: string
  version: number
}

export type PromptPresetCreateInput = {
  name: string
  prompt: string
  params?: Record<string, unknown>
  note?: string
}

export type PromptPresetVersionInput = {
  prompt: string
  params?: Record<string, unknown>
  note?: string
}

const PRESET_ERROR_HINTS: Record<string, string> = {
  duplicate_name: '模板名已存在（大小写与空白归一后比较）',
  version_limit: '每个模板最多 50 个版本',
  preset_not_found: '模板不存在或已被删除',
  preset_version_not_found: '指定版本不存在',
  name_invalid: '模板名需为 1..60 字',
  prompt_invalid: '提示词需为 1..8000 字',
  params_invalid: 'params 必须是 JSON 对象',
  note_invalid: 'note 必须是字符串',
  invalid_version: '版本号必须是正整数',
  invalid_body: '请求体格式不合法',
  'invalid X-Web-Token': '鉴权失败：X-Web-Token 不正确',
  'same-origin browser request or X-Web-Token required':
    '鉴权失败：需同源访问或配置 X-Web-Token',
  'write disabled: WEB_WRITE_TOKEN is not set': '写接口未启用：服务端未配置 WEB_WRITE_TOKEN'
}

/** 服务端错误原样展示（状态码 + error code），附中文提示；非 HTTP 错误透传 message。 */
export function formatPromptPresetError(err: unknown): string {
  if (err instanceof HttpError) {
    const raw = err.message || `HTTP ${err.status}`
    const hint = PRESET_ERROR_HINTS[raw]
    return hint ? `${err.status} ${raw}（${hint}）` : `${err.status} ${raw}`
  }
  return err instanceof Error && err.message ? err.message : '请求失败'
}

export function validatePresetName(raw: string): string | null {
  const name = raw.trim()
  if (!name) return '模板名不能为空'
  if ([...name].length > PRESET_NAME_MAX) return `模板名最多 ${PRESET_NAME_MAX} 字`
  return null
}

export function validatePresetPrompt(raw: string): string | null {
  const prompt = raw.trim()
  if (!prompt) return '当前提示词为空，无法保存'
  if ([...raw].length > PRESET_PROMPT_MAX) return `提示词最多 ${PRESET_PROMPT_MAX} 字`
  return null
}

export function promptPresetReferenceLabel(reference: PromptPresetReference): string {
  return `${reference.name}@v${reference.version}`
}

/** 版本从 1 连续递增（服务端保证），因此按 versions_count 生成 v1..vN。 */
export function promptPresetVersionOptions(
  preset: Pick<PromptPresetSummary, 'versions_count'>
): number[] {
  const count = Math.max(0, Math.min(preset.versions_count, PRESET_VERSIONS_MAX))
  return Array.from({ length: count }, (_, index) => index + 1)
}

/**
 * 只在前端已有模板列表时判断引用是否失效：模板被删 / 版本号超出历史范围。
 * 生成前仍以 `validatePromptPresetReference` 的服务端结果为准。
 */
export function promptPresetReferenceIssue(
  reference: PromptPresetReference | null,
  items: PromptPresetSummary[]
): string | null {
  if (!reference) return null
  const preset = items.find((item) => item.id === reference.presetId)
  if (!preset) return '模板已被删除'
  if (
    !Number.isInteger(reference.version) ||
    reference.version < 1 ||
    reference.version > preset.versions_count
  ) {
    return `版本 v${reference.version} 不存在（当前共 ${preset.versions_count} 版）`
  }
  return null
}

export function formatPromptPresetDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`
}

export function listPromptPresets(signal?: AbortSignal): Promise<PromptPresetList> {
  return getJson<PromptPresetList>('/api/prompt-presets', signal)
}

export function createPromptPreset(
  input: PromptPresetCreateInput
): Promise<{ item: PromptPresetSummary; version: PromptPresetVersion }> {
  return postJson<{ item: PromptPresetSummary; version: PromptPresetVersion }>(
    '/api/prompt-presets',
    {
      name: input.name,
      prompt: input.prompt,
      params: input.params ?? {},
      note: input.note ?? ''
    }
  )
}

export function appendPromptPresetVersion(
  id: string,
  input: PromptPresetVersionInput
): Promise<{ item: PromptPresetSummary; version: PromptPresetVersion }> {
  return putJson<{ item: PromptPresetSummary; version: PromptPresetVersion }>(
    `/api/prompt-presets/${encodeURIComponent(id)}`,
    {
      prompt: input.prompt,
      params: input.params ?? {},
      note: input.note ?? ''
    }
  )
}

export function loadPromptPresetVersion(
  id: string,
  version: number,
  signal?: AbortSignal
): Promise<PromptPresetDetail> {
  const query = version ? `?version=${encodeURIComponent(String(version))}` : ''
  return getJson<PromptPresetDetail>(
    `/api/prompt-presets/${encodeURIComponent(id)}${query}`,
    signal
  )
}

export function deletePromptPreset(
  id: string
): Promise<{ ok: boolean; item: PromptPresetSummary }> {
  return deleteJson<{ ok: boolean; item: PromptPresetSummary }>(
    `/api/prompt-presets/${encodeURIComponent(id)}`
  )
}

export function validatePromptPresetReference(
  id: string,
  version?: number | null,
  signal?: AbortSignal
): Promise<PromptPresetDetail & { ok: true }> {
  return postJson<PromptPresetDetail & { ok: true }>(
    `/api/prompt-presets/${encodeURIComponent(id)}/validate`,
    version == null ? {} : { version },
    signal
  )
}
