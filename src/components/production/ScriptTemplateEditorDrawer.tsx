import { useMemo, useRef, useState } from 'react'
import { useModalA11y } from '../../hooks'
import type { ScriptPromptTemplateInfo } from '../../types'
import { restoreScriptTemplateDefault, saveScriptTemplateOverride } from '../../script-templates-client'
import { ASPECTS } from '../studio-ui'
import { Close, Refresh } from '../icons'
import { SelectMenu } from '../SelectMenu'
import { AsyncStatusLine } from '../ui'
import {
  CANONICAL_DIRECTOR_PROFILES,
  CANONICAL_DURATION_OPTIONS,
  diffScriptTemplateDraft,
  templateDraftFromTemplate,
  validateScriptTemplateDraft,
  type ScriptAspect,
  type ScriptTemplateDraft
} from './script-editor-utils'

type PendingAction = 'save' | 'restore'

const ASPECT_OPTIONS = ASPECTS.filter((a) => a.value !== '').map((a) => ({
  value: a.value,
  label: a.label
}))

const fieldLabelClass = 'mb-1 block text-[11.5px] font-medium text-apple-subtext'
const textareaClass =
  'w-full rounded-[10px] border border-black/[0.1] bg-white px-2.5 py-2 text-[12px] leading-relaxed text-apple-text transition-colors focus:border-apple-blue focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/25'
const inputClass =
  'h-9 w-full rounded-[10px] border border-black/[0.1] bg-white px-2.5 text-xs text-apple-text transition-colors focus:border-apple-blue focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/25'

/**
 * #134「编辑模板」抽屉：编辑 7 个可写字段，保存 PUT、恢复默认 DELETE。
 * 保存/恢复有 loading + 成功/失败提示（AsyncStatusLine），成功后把合并结果回传给面板。
 */
export function ScriptTemplateEditorDrawer({
  template,
  onClose,
  onSaved,
  onNotify
}: {
  template: ScriptPromptTemplateInfo
  onClose: () => void
  onSaved: (item: ScriptPromptTemplateInfo) => void
  onNotify?: (message: string) => void
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  useModalA11y(true, panelRef, onClose, closeRef)

  const baseDraft = useMemo(() => templateDraftFromTemplate(template), [template])
  const [draft, setDraft] = useState<ScriptTemplateDraft>(baseDraft)
  const [pending, setPending] = useState<PendingAction | null>(null)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const patch = useMemo(() => diffScriptTemplateDraft(draft, baseDraft), [draft, baseDraft])
  const patchCount = Object.keys(patch).length
  const validationError = validateScriptTemplateDraft(draft)
  const busy = pending !== null

  const setField = <K extends keyof ScriptTemplateDraft>(key: K, value: ScriptTemplateDraft[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }))
    setDone(null)
    setError(null)
  }

  const applyItem = (item: ScriptPromptTemplateInfo) => {
    setDraft(templateDraftFromTemplate(item))
    onSaved(item)
  }

  const runSave = async () => {
    if (busy) return
    const invalid = validateScriptTemplateDraft(draft)
    if (invalid) {
      setError(invalid)
      setDone(null)
      return
    }
    if (patchCount === 0) {
      setDone('没有需要保存的改动')
      return
    }
    setPending('save')
    setStartedAt(Date.now())
    setError(null)
    setDone(null)
    try {
      const res = await saveScriptTemplateOverride(template.id, patch)
      applyItem(res.item)
      const message = '模板已保存，重新生成将使用新内容'
      setDone(message)
      onNotify?.(`「${res.item.label}」${message}`)
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : '模板保存失败'
      setError(message)
      onNotify?.(`模板保存失败：${message}`)
    } finally {
      setPending(null)
      setStartedAt(null)
    }
  }

  const runRestore = async () => {
    if (busy) return
    setPending('restore')
    setStartedAt(Date.now())
    setError(null)
    setDone(null)
    try {
      const res = await restoreScriptTemplateDefault(template.id)
      applyItem(res.item)
      const message = '已恢复默认模板'
      setDone(message)
      onNotify?.(`「${res.item.label}」${message}`)
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : '恢复默认失败'
      setError(message)
      onNotify?.(`恢复默认失败：${message}`)
    } finally {
      setPending(null)
      setStartedAt(null)
    }
  }

  const statusLabel =
    pending === 'save'
      ? `正在保存模板「${template.label}」`
      : pending === 'restore'
        ? `正在恢复「${template.label}」的默认模板`
        : error
          ? '模板操作失败'
          : (done ?? '')

  return (
    <div className="dialog-overlay fixed inset-0 z-[60] flex items-end justify-center bg-apple-text/25 p-0 backdrop-blur-[2px] sm:items-center sm:p-6">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="script-template-editor-title"
        tabIndex={-1}
        data-testid="script-template-editor-drawer"
        className="dialog-panel flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-[20px] border border-black/[0.08] bg-white shadow-lift focus:outline-none sm:max-h-[90dvh] sm:max-w-[720px] sm:rounded-card"
      >
        <div className="flex items-start justify-between gap-3 border-b border-black/[0.06] px-5 py-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2
                id="script-template-editor-title"
                className="text-[17px] font-semibold tracking-[-0.01em]"
              >
                编辑模板 · {template.category}
              </h2>
              <span
                className={`inline-flex h-5 items-center rounded-full px-2 text-[10.5px] font-medium ${
                  template.source === 'override'
                    ? 'bg-[#FFF4E5] text-[#8A4B00]'
                    : 'bg-black/[0.04] text-apple-subtext'
                }`}
                data-testid="script-template-editor-source"
              >
                {template.source === 'override' ? '已自定义' : '内置默认'}
              </span>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-apple-subtext">
              保存后立即写入模板库，不重启服务；重新生成剧本会使用新模板内容。恢复默认只删除本地覆盖。
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="关闭模板编辑"
            className="shrink-0 rounded-lg p-1.5 text-apple-subtext transition-colors hover:bg-black/[0.05] hover:text-apple-text"
          >
            <Close className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3.5 overflow-y-auto px-5 py-4">
          <div>
            <label className={fieldLabelClass} htmlFor="script-template-label">
              模板名称（label）
            </label>
            <input
              id="script-template-label"
              value={draft.label}
              onChange={(e) => setField('label', e.target.value)}
              disabled={busy}
              maxLength={80}
              className={inputClass}
            />
          </div>

          <div>
            <label className={fieldLabelClass} htmlFor="script-template-summary">
              模板摘要（summary）
            </label>
            <textarea
              id="script-template-summary"
              rows={3}
              value={draft.summary}
              onChange={(e) => setField('summary', e.target.value)}
              disabled={busy}
              maxLength={400}
              className={textareaClass}
            />
          </div>

          <div>
            <label className={fieldLabelClass} htmlFor="script-template-beats">
              戏剧节拍结构（structureBeats）
            </label>
            <textarea
              id="script-template-beats"
              rows={3}
              value={draft.structureBeats}
              onChange={(e) => setField('structureBeats', e.target.value)}
              disabled={busy}
              maxLength={400}
              className={textareaClass}
            />
          </div>

          <div>
            <label className={fieldLabelClass} htmlFor="script-template-optical">
              光学镜头与节奏（opticalSpec）
            </label>
            <textarea
              id="script-template-optical"
              rows={3}
              value={draft.opticalSpec}
              onChange={(e) => setField('opticalSpec', e.target.value)}
              disabled={busy}
              maxLength={400}
              className={textareaClass}
            />
          </div>

          <div>
            <label className={fieldLabelClass} htmlFor="script-template-directives">
              导演指令（systemDirectives）
            </label>
            <textarea
              id="script-template-directives"
              rows={7}
              value={draft.systemDirectives}
              onChange={(e) => setField('systemDirectives', e.target.value)}
              disabled={busy}
              maxLength={4000}
              className={`${textareaClass} font-mono text-[11.5px]`}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <span className={fieldLabelClass}>推荐导演 Profile</span>
              <SelectMenu
                value={draft.recommendedProfile}
                onChange={(value) =>
                  setField('recommendedProfile', value as ScriptTemplateDraft['recommendedProfile'])
                }
                disabled={busy}
                ariaLabel="推荐导演 Profile"
                testId="script-template-profile-select"
                options={CANONICAL_DIRECTOR_PROFILES.map((p) => ({ value: p.id, label: p.label }))}
              />
            </div>
            <div>
              <span className={fieldLabelClass}>推荐时长</span>
              <SelectMenu
                value={draft.recommendedDurationS}
                onChange={(value) => setField('recommendedDurationS', value)}
                disabled={busy}
                ariaLabel="推荐时长"
                testId="script-template-duration-select"
                options={CANONICAL_DURATION_OPTIONS.map((d) => ({
                  value: String(d.value),
                  label: d.label
                }))}
              />
            </div>
            <div>
              <span className={fieldLabelClass}>推荐画幅</span>
              <SelectMenu
                value={draft.recommendedAspect}
                onChange={(value) => setField('recommendedAspect', value as ScriptAspect)}
                disabled={busy}
                ariaLabel="推荐画幅"
                testId="script-template-aspect-select"
                options={ASPECT_OPTIONS}
              />
            </div>
          </div>

          {(pending || error || done) && (
            <AsyncStatusLine
              testId="script-template-editor-status"
              label={statusLabel}
              startedAt={startedAt}
              active={pending !== null}
              error={error}
              onRetry={error ? (pending === 'restore' ? undefined : runSave) : undefined}
            />
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-black/[0.06] px-5 py-3.5">
          <button
            type="button"
            onClick={() => void runRestore()}
            disabled={busy || template.source !== 'override'}
            data-testid="script-template-restore-btn"
            title={
              template.source === 'override' ? '删除本地覆盖，恢复内置默认模板' : '当前已是内置默认模板'
            }
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-black/[0.1] px-2.5 text-xs font-medium text-apple-subtext transition-colors hover:bg-black/[0.04] hover:text-apple-text disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Refresh className="h-3.5 w-3.5" />
            恢复默认
          </button>

          <div className="flex items-center gap-2">
            <span className="text-[11px] text-apple-subtext">
              {validationError ? validationError : patchCount > 0 ? `待保存改动 ${patchCount} 项` : '没有改动'}
            </span>
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="inline-flex h-8 items-center rounded-lg border border-black/[0.1] px-3 text-xs font-medium text-apple-subtext transition-colors hover:bg-black/[0.04] hover:text-apple-text disabled:opacity-50"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => void runSave()}
              disabled={busy || patchCount === 0 || Boolean(validationError)}
              data-testid="script-template-save-btn"
              className="inline-flex h-8 items-center rounded-lg bg-apple-blue px-3 text-xs font-medium text-white transition-colors hover:bg-[#0062C4] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {pending === 'save' ? '保存中…' : '保存模板'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
