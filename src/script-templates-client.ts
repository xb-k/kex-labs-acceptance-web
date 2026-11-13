/**
 * #134 导演模板库写接口（浏览器端）。
 * GET 读取走 `useJson('/api/script-templates')`；这里只封装 PUT 保存与 DELETE 恢复默认，
 * 便于单测用 fetch stub 断言方法/URL/请求体，而不是把网络细节散在抽屉组件里。
 */
import { deleteJson, putJson } from './api'
import type { ScriptPromptTemplateInfo, VideoTemplateId } from './types'
import type { ScriptTemplateEditorPatch } from './components/production/script-editor-utils'

export type ScriptTemplateWriteResponse = {
  ok: boolean
  item: ScriptPromptTemplateInfo
  removed?: boolean
}

export function saveScriptTemplateOverride(
  id: VideoTemplateId,
  patch: ScriptTemplateEditorPatch
): Promise<ScriptTemplateWriteResponse> {
  return putJson<ScriptTemplateWriteResponse>(`/api/script-templates/${id}`, patch)
}

export function restoreScriptTemplateDefault(id: VideoTemplateId): Promise<ScriptTemplateWriteResponse> {
  return deleteJson<ScriptTemplateWriteResponse>(`/api/script-templates/${id}/override`)
}
