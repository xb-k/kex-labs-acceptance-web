/**
 * #137 提示词模板面板：Studio 剧本区（Brief 工作台）内的版本化提示词。
 *
 * - 列表 / 保存 v1 / 追加新版本 / 载入指定版本 / 删除全部走真实 API；
 * - 载入与删除都要二次确认，载入会覆盖当前「想法」字段；
 * - 引用状态在本地列表上判定（模板删除 / 版本越界），生成前仍由
 *   `validatePromptPresetReference` 做服务端校验，失败原样展示、不回退；
 * - 纯展示子组件（Badge / List / Row）可用 react-dom/server 做 SSR 断言。
 */
import { useEffect, useRef, useState } from 'react'
import { useJson } from '../../api'
import { useModalA11y } from '../../hooks'
import {
  PRESET_NAME_MAX,
  PRESET_VERSIONS_MAX,
  appendPromptPresetVersion,
  createPromptPreset,
  deletePromptPreset,
  formatPromptPresetDate,
  formatPromptPresetError,
  loadPromptPresetVersion,
  promptPresetReferenceIssue,
  promptPresetReferenceLabel,
  promptPresetVersionOptions,
  validatePresetName,
  validatePresetPrompt,
  type PromptPresetList,
  type PromptPresetReference,
  type PromptPresetSummary
} from '../../prompt-presets'
import { Close, Plus, Refresh, Trash } from '../icons'
import { AsyncStatusLine } from '../ui'
import { inputClass, primaryButton, quietButton } from '../studio-ui'

type Notify = (message: string, tone?: 'ok' | 'err') => void

type LoadTarget = { preset: PromptPresetSummary; version: number }

// ---------------------------------------------------------------------------
// 纯展示：引用状态
// ---------------------------------------------------------------------------

export function PromptPresetReferenceBadge({
  reference,
  issue,
  onClear
}: {
  reference: PromptPresetReference | null
  issue?: string | null
  onClear?: () => void
}) {
  if (!reference) return null
  const invalid = Boolean(issue)
  return (
    <div
      data-testid="prompt-preset-reference"
      className={`mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-[10px] px-3 py-2 text-[11px] ring-1 ring-inset ${
        invalid
          ? 'bg-[#FBF1E4] text-[#8A4B00] ring-[#F0D9BC]'
          : 'bg-[#F0F6FF] text-apple-blueInk ring-[#CFE3FB]'
      }`}
      role="status"
    >
      <span className="font-medium">当前引用</span>
      <span className="num break-all font-semibold">{promptPresetReferenceLabel(reference)}</span>
      {invalid ? (
        <span data-testid="prompt-preset-reference-invalid" className="break-words">
          引用失效 · {issue}
        </span>
      ) : (
        <span className="text-apple-subtext">有效</span>
      )}
      {onClear && (
        <button
          type="button"
          onClick={onClear}
          data-testid="prompt-preset-reference-clear"
          className="ml-auto inline-flex h-6 items-center gap-1 rounded-full px-2 font-medium underline underline-offset-2 hover:bg-black/[0.04]"
        >
          <Close className="h-3 w-3" />
          解除引用
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 纯展示：列表
// ---------------------------------------------------------------------------

export function PromptPresetRow({
  item,
  reference,
  onLoad,
  onSaveVersion,
  onDelete
}: {
  item: PromptPresetSummary
  reference: PromptPresetReference | null
  onLoad?: (target: LoadTarget) => void
  onSaveVersion?: (preset: PromptPresetSummary) => void
  onDelete?: (preset: PromptPresetSummary) => void
}) {
  const versions = promptPresetVersionOptions(item)
  const [version, setVersion] = useState(item.current_version)
  const referenced = reference?.presetId === item.id
  const versionLimit = item.versions_count >= PRESET_VERSIONS_MAX

  useEffect(() => {
    setVersion(item.current_version)
  }, [item.current_version, item.id])

  return (
    <li
      data-testid="prompt-preset-row"
      className="min-w-0 rounded-[12px] border border-black/[0.07] bg-white p-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p
            className="truncate text-[12.5px] font-medium text-apple-text"
            title={item.name}
            data-testid="prompt-preset-name-label"
          >
            {item.name}
          </p>
          <p className="num mt-0.5 text-[10.5px] leading-relaxed text-apple-subtext">
            v{item.current_version} · 共 {item.versions_count} 版 · 更新{' '}
            {formatPromptPresetDate(item.updated_at)}
          </p>
        </div>
        {referenced && (
          <span
            data-testid="prompt-preset-row-reference"
            className="num shrink-0 rounded-full bg-[#F0F6FF] px-2 py-0.5 text-[10px] font-medium text-apple-blueInk ring-1 ring-inset ring-[#CFE3FB]"
          >
            {promptPresetReferenceLabel(reference)}
          </span>
        )}
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <select
          value={version}
          onChange={(event) => setVersion(Number(event.target.value))}
          aria-label={`选择「${item.name}」要载入的版本`}
          data-testid="prompt-preset-version"
          className={`${inputClass} h-8 w-auto min-w-[86px] max-w-full shrink-0 py-0 text-[11.5px]`}
        >
          {versions.map((value) => (
            <option key={value} value={value}>
              v{value}
              {value === item.current_version ? '（当前）' : ''}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => onLoad?.({ preset: item, version })}
          data-testid="prompt-preset-load"
          className={`${quietButton} h-8 gap-1 px-3 text-[11.5px]`}
        >
          载入
        </button>
        <button
          type="button"
          onClick={() => onSaveVersion?.(item)}
          disabled={versionLimit}
          title={versionLimit ? `每个模板最多 ${PRESET_VERSIONS_MAX} 个版本` : undefined}
          data-testid="prompt-preset-append"
          className={`${quietButton} h-8 gap-1 px-3 text-[11.5px]`}
        >
          <Plus className="h-3.5 w-3.5" />
          存为新版本
        </button>
        <button
          type="button"
          onClick={() => onDelete?.(item)}
          data-testid="prompt-preset-delete"
          className="inline-flex h-8 items-center gap-1 rounded-full border border-black/[0.1] px-3 text-[11.5px] font-medium text-apple-subtext transition-colors hover:bg-[#FDEDEC] hover:text-[#B42318] focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
        >
          <Trash className="h-3.5 w-3.5" />
          删除
        </button>
      </div>
    </li>
  )
}

export function PromptPresetList({
  items,
  reference,
  onLoad,
  onSaveVersion,
  onDelete
}: {
  items: PromptPresetSummary[]
  reference: PromptPresetReference | null
  onLoad?: (target: LoadTarget) => void
  onSaveVersion?: (preset: PromptPresetSummary) => void
  onDelete?: (preset: PromptPresetSummary) => void
}) {
  return (
    <ul className="min-w-0 space-y-2" data-testid="prompt-preset-list">
      {items.map((item) => (
        <PromptPresetRow
          key={item.id}
          item={item}
          reference={reference}
          onLoad={onLoad}
          onSaveVersion={onSaveVersion}
          onDelete={onDelete}
        />
      ))}
    </ul>
  )
}

// ---------------------------------------------------------------------------
// 载入版本确认
// ---------------------------------------------------------------------------

function LoadVersionDialog({
  target,
  prompt,
  onClose,
  onLoaded,
  onNotify
}: {
  target: LoadTarget | null
  prompt: string
  onClose: () => void
  onLoaded: (reference: PromptPresetReference, message: string, loadedPrompt: string) => void
  onNotify?: Notify
}) {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const confirmRef = useRef<HTMLButtonElement | null>(null)
  const [pending, setPending] = useState(false)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  useModalA11y(target !== null, panelRef, onClose, confirmRef)

  useEffect(() => {
    if (!target) return
    setPending(false)
    setError(null)
    setStartedAt(null)
  }, [target])

  if (!target) return null

  const confirm = async () => {
    if (pending) return
    setPending(true)
    setStartedAt(Date.now())
    setError(null)
    try {
      const detail = await loadPromptPresetVersion(target.preset.id, target.version)
      const reference: PromptPresetReference = {
        presetId: detail.item.id,
        name: detail.item.name,
        version: detail.version.version
      }
      const message = `已载入「${detail.item.name}」v${detail.version.version}`
      onLoaded(reference, message, detail.version.prompt)
      onNotify?.(message)
      onClose()
    } catch (err) {
      const message = formatPromptPresetError(err)
      setError(message)
      onNotify?.(`载入失败：${message}`, 'err')
    } finally {
      setPending(false)
      setStartedAt(null)
    }
  }

  const promptLength = [...prompt].length

  return (
    <div
      className="dialog-overlay fixed inset-0 z-[60] flex items-center justify-center bg-apple-text/25 p-4"
      role="presentation"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="prompt-preset-load-title"
        data-testid="prompt-preset-load-dialog"
        onClick={(event) => event.stopPropagation()}
        className="dialog-panel w-full max-w-[440px] rounded-[18px] bg-white p-5 shadow-lift"
      >
        <h2 id="prompt-preset-load-title" className="text-[16px] font-semibold tracking-[-0.01em]">
          载入模板版本
        </h2>
        <p className="mt-1.5 break-words text-[12.5px] leading-relaxed text-apple-subtext">
          将把「{target.preset.name}」v{target.version} 的提示词写入当前「想法」字段。
          {promptLength > 0 && `当前内容（${promptLength} 字）会被覆盖，且不会自动备份。`}
        </p>
        {(pending || error) && (
          <AsyncStatusLine
            testId="prompt-preset-load-status"
            label={pending ? '正在载入模板版本' : '载入失败'}
            startedAt={startedAt}
            active={pending}
            error={error}
            className="mt-3"
          />
        )}
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className={`${quietButton} h-8 px-3 text-xs`}
          >
            取消
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={() => void confirm()}
            disabled={pending}
            data-testid="prompt-preset-load-confirm"
            className={`${primaryButton} h-8 px-3.5 text-xs`}
          >
            {pending ? '载入中…' : '确认覆盖'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 存为新版本
// ---------------------------------------------------------------------------

function AppendVersionDialog({
  preset,
  prompt,
  onClose,
  onAppended,
  onNotify
}: {
  preset: PromptPresetSummary | null
  prompt: string
  onClose: () => void
  onAppended: (reference: PromptPresetReference, message: string) => void
  onNotify?: Notify
}) {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const noteRef = useRef<HTMLInputElement | null>(null)
  const [note, setNote] = useState('')
  const [pending, setPending] = useState(false)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  useModalA11y(preset !== null, panelRef, onClose, noteRef)

  useEffect(() => {
    if (!preset) return
    setNote('')
    setPending(false)
    setError(null)
    setStartedAt(null)
  }, [preset])

  if (!preset) return null

  const nextVersion = preset.versions_count + 1
  const confirm = async () => {
    if (pending) return
    const promptIssue = validatePresetPrompt(prompt)
    if (promptIssue) {
      setError(promptIssue)
      return
    }
    setPending(true)
    setStartedAt(Date.now())
    setError(null)
    try {
      const result = await appendPromptPresetVersion(preset.id, {
        prompt,
        params: {},
        note: note.trim()
      })
      const reference: PromptPresetReference = {
        presetId: result.item.id,
        name: result.item.name,
        version: result.version.version
      }
      const message = `已保存「${result.item.name}」v${result.version.version}`
      onAppended(reference, message)
      onNotify?.(message)
      onClose()
    } catch (err) {
      const message = formatPromptPresetError(err)
      setError(message)
      onNotify?.(`保存新版本失败：${message}`, 'err')
    } finally {
      setPending(false)
      setStartedAt(null)
    }
  }

  return (
    <div
      className="dialog-overlay fixed inset-0 z-[60] flex items-center justify-center bg-apple-text/25 p-4"
      role="presentation"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="prompt-preset-append-title"
        data-testid="prompt-preset-append-dialog"
        onClick={(event) => event.stopPropagation()}
        className="dialog-panel w-full max-w-[440px] rounded-[18px] bg-white p-5 shadow-lift"
      >
        <h2 id="prompt-preset-append-title" className="text-[16px] font-semibold tracking-[-0.01em]">
          存为新版本
        </h2>
        <p className="mt-1.5 break-words text-[12.5px] leading-relaxed text-apple-subtext">
          把当前提示词（{[...prompt].length} 字）追加到「{preset.name}」为 v{nextVersion}；
          旧版本保留，可随时回载。
        </p>
        <label
          htmlFor="prompt-preset-note"
          className="mt-3 block text-[11.5px] font-medium text-apple-text"
        >
          版本备注<span className="ml-1 text-[10.5px] font-normal text-apple-subtext">可选</span>
        </label>
        <input
          ref={noteRef}
          id="prompt-preset-note"
          type="text"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="如：加强清晨自然光"
          maxLength={200}
          disabled={pending}
          data-testid="prompt-preset-append-note"
          className={`${inputClass} mt-1 h-9`}
        />
        {(pending || error) && (
          <AsyncStatusLine
            testId="prompt-preset-append-status"
            label={pending ? '正在保存新版本' : '保存失败'}
            startedAt={startedAt}
            active={pending}
            error={error}
            className="mt-3"
          />
        )}
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className={`${quietButton} h-8 px-3 text-xs`}
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={pending}
            data-testid="prompt-preset-append-confirm"
            className={`${primaryButton} h-8 px-3.5 text-xs`}
          >
            {pending ? '保存中…' : '保存新版本'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 删除确认
// ---------------------------------------------------------------------------

function DeletePresetDialog({
  preset,
  reference,
  onClose,
  onDeleted,
  onNotify
}: {
  preset: PromptPresetSummary | null
  reference: PromptPresetReference | null
  onClose: () => void
  onDeleted: (preset: PromptPresetSummary, message: string) => void
  onNotify?: Notify
}) {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const confirmRef = useRef<HTMLButtonElement | null>(null)
  const [pending, setPending] = useState(false)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  useModalA11y(preset !== null, panelRef, onClose, confirmRef)

  useEffect(() => {
    if (!preset) return
    setPending(false)
    setError(null)
    setStartedAt(null)
  }, [preset])

  if (!preset) return null

  const confirm = async () => {
    if (pending) return
    setPending(true)
    setStartedAt(Date.now())
    setError(null)
    try {
      await deletePromptPreset(preset.id)
      const message =
        reference?.presetId === preset.id
          ? `已删除「${preset.name}」；当前引用标记为失效`
          : `已删除「${preset.name}」`
      onDeleted(preset, message)
      onNotify?.(message)
      onClose()
    } catch (err) {
      const message = formatPromptPresetError(err)
      setError(message)
      onNotify?.(`删除失败：${message}`, 'err')
    } finally {
      setPending(false)
      setStartedAt(null)
    }
  }

  return (
    <div
      className="dialog-overlay fixed inset-0 z-[60] flex items-center justify-center bg-apple-text/25 p-4"
      role="presentation"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="prompt-preset-delete-title"
        data-testid="prompt-preset-delete-dialog"
        onClick={(event) => event.stopPropagation()}
        className="dialog-panel w-full max-w-[420px] rounded-[18px] bg-white p-5 shadow-lift"
      >
        <h2 id="prompt-preset-delete-title" className="text-[16px] font-semibold tracking-[-0.01em]">
          删除提示词模板
        </h2>
        <p className="mt-1.5 break-words text-[12.5px] leading-relaxed text-apple-subtext">
          确认删除「{preset.name}」（共 {preset.versions_count} 个版本）？该操作不可撤销。
          {reference?.presetId === preset.id &&
            ' 当前提示词仍保留，但模板引用会标记为失效。'}
        </p>
        {(pending || error) && (
          <AsyncStatusLine
            testId="prompt-preset-delete-status"
            label={pending ? '正在删除模板' : '删除失败'}
            startedAt={startedAt}
            active={pending}
            error={error}
            className="mt-3"
          />
        )}
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className={`${quietButton} h-8 px-3 text-xs`}
          >
            取消
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={() => void confirm()}
            disabled={pending}
            data-testid="prompt-preset-delete-confirm"
            className="inline-flex h-8 items-center rounded-full bg-[#B42318] px-3.5 text-xs font-medium text-white transition-colors hover:bg-[#961D14] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#B42318]/40 disabled:cursor-not-allowed disabled:opacity-55"
          >
            {pending ? '删除中…' : '确认删除'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 主面板
// ---------------------------------------------------------------------------

export function PromptPresetsPanel({
  prompt,
  reference,
  onReferenceChange,
  onApplyPrompt,
  onNotify
}: {
  prompt: string
  reference: PromptPresetReference | null
  onReferenceChange: (next: PromptPresetReference | null) => void
  onApplyPrompt: (next: string) => void
  onNotify?: Notify
}) {
  const listing = useJson<PromptPresetList>('/api/prompt-presets')
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveStartedAt, setSaveStartedAt] = useState<number | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const [loadTarget, setLoadTarget] = useState<LoadTarget | null>(null)
  const [appendTarget, setAppendTarget] = useState<PromptPresetSummary | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<PromptPresetSummary | null>(null)

  const items = listing.data?.items ?? []
  const referenceIssue =
    listing.status === 'ready' ? promptPresetReferenceIssue(reference, items) : null
  const promptLength = [...prompt].length

  const saveTemplate = async () => {
    if (saving) return
    const nameIssue = validatePresetName(name)
    const promptIssue = validatePresetPrompt(prompt)
    if (nameIssue || promptIssue) {
      setSaveError(nameIssue ?? promptIssue)
      setFlash(null)
      return
    }
    setSaving(true)
    setSaveStartedAt(Date.now())
    setSaveError(null)
    setFlash(null)
    try {
      const result = await createPromptPreset({
        name: name.trim(),
        prompt,
        params: {},
        note: ''
      })
      const nextReference: PromptPresetReference = {
        presetId: result.item.id,
        name: result.item.name,
        version: result.version.version
      }
      setName('')
      onReferenceChange(nextReference)
      const message = `已保存模板「${result.item.name}」v${result.version.version}`
      setFlash(message)
      onNotify?.(message)
      listing.refresh()
    } catch (err) {
      const message = formatPromptPresetError(err)
      setSaveError(message)
      onNotify?.(`保存模板失败：${message}`, 'err')
    } finally {
      setSaving(false)
      setSaveStartedAt(null)
    }
  }

  const applyLoaded = (
    next: PromptPresetReference,
    message: string,
    loadedPrompt: string
  ) => {
    onApplyPrompt(loadedPrompt)
    onReferenceChange(next)
    setFlash(message)
    listing.refresh()
  }

  return (
    <section
      className="rounded-[12px] border border-black/[0.07] bg-white p-3.5 sm:p-4"
      aria-labelledby="prompt-presets-title"
      data-testid="prompt-presets"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 id="prompt-presets-title" className="text-[13px] font-semibold text-apple-text">
            提示词模板
          </h3>
          <p className="mt-1 max-w-[62ch] text-[11px] leading-relaxed text-apple-subtext">
            保存当前「想法」为模板；版本只追加不覆盖，载入前会二次确认。最多 {PRESET_VERSIONS_MAX}{' '}
            个版本。
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="num text-[10.5px] text-apple-subtext" data-testid="prompt-preset-total">
            {listing.status === 'ready' ? `共 ${listing.data?.total ?? 0} 个模板` : ''}
          </span>
          <button
            type="button"
            onClick={listing.refresh}
            aria-label="刷新提示词模板列表"
            data-testid="prompt-preset-refresh"
            className="inline-flex h-7 w-7 items-center justify-center rounded-full text-apple-subtext transition-colors hover:bg-black/[0.04] hover:text-apple-text focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
          >
            <Refresh className={`h-3.5 w-3.5 ${listing.refreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      <PromptPresetReferenceBadge
        reference={reference}
        issue={referenceIssue}
        onClear={() => {
          onReferenceChange(null)
          setFlash('已解除模板引用；当前提示词保留。')
        }}
      />

      {/* 不能嵌 <form>：本面板挂在 A 轨制片表单内部，浏览器原生提交会整页刷新。 */}
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          type="text"
          value={name}
          onChange={(event) => {
            setName(event.target.value)
            setSaveError(null)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void saveTemplate()
            }
          }}
          placeholder={`模板名（最多 ${PRESET_NAME_MAX} 字）`}
          aria-label="新模板名称"
          maxLength={PRESET_NAME_MAX}
          disabled={saving}
          data-testid="prompt-preset-name"
          className={`${inputClass} h-9 min-w-0 flex-1 text-[12px]`}
        />
        <button
          type="button"
          onClick={() => void saveTemplate()}
          disabled={saving}
          data-testid="prompt-preset-save"
          className={`${primaryButton} h-9 w-full shrink-0 gap-1.5 px-3.5 text-[12px] sm:w-auto`}
        >
          <Plus className="h-3.5 w-3.5" />
          {saving ? '保存中…' : '保存当前提示词为模板'}
        </button>
      </div>
      <p className="mt-1 text-[10.5px] leading-relaxed text-apple-subtext">
        当前提示词 {promptLength} 字；保存后自动引用新模板 v1。
      </p>

      {flash && (
        <p
          role="status"
          data-testid="prompt-preset-flash"
          className="mt-2 break-words rounded-[10px] bg-[#EAF8EE] px-3 py-2 text-[11px] leading-relaxed text-[#1E7A3C] ring-1 ring-inset ring-[#CDEED6]"
        >
          {flash}
        </p>
      )}

      {(saving || saveError) && (
        <AsyncStatusLine
          testId="prompt-preset-save-status"
          label={saving ? '正在保存模板' : '保存模板失败'}
          startedAt={saveStartedAt}
          active={saving}
          error={saveError}
          className="mt-2"
        />
      )}

      <div className="mt-3">
        {listing.status === 'loading' && (
          <AsyncStatusLine
            testId="prompt-preset-loading"
            label="正在加载提示词模板"
            startedAt={null}
          />
        )}

        {listing.status === 'error' && (
          <AsyncStatusLine
            testId="prompt-preset-error"
            label="提示词模板加载失败"
            startedAt={null}
            active={false}
            error={formatPromptPresetError(listing.error)}
            onRetry={listing.retry}
          />
        )}

        {listing.status === 'ready' && items.length === 0 && (
          <div
            data-testid="prompt-preset-empty"
            className="rounded-[12px] border border-dashed border-black/[0.12] bg-apple-bg/40 px-4 py-6 text-center"
          >
            <p className="text-[12.5px] font-medium text-apple-text">还没有提示词模板</p>
            <p className="mt-1 text-[11px] leading-relaxed text-apple-subtext">
              输入模板名并点「保存当前提示词为模板」，之后可追加版本或回载旧版本。
            </p>
          </div>
        )}

        {listing.status === 'ready' && items.length > 0 && (
          <PromptPresetList
            items={items}
            reference={reference}
            onLoad={setLoadTarget}
            onSaveVersion={setAppendTarget}
            onDelete={setDeleteTarget}
          />
        )}
      </div>

      <LoadVersionDialog
        target={loadTarget}
        prompt={prompt}
        onClose={() => setLoadTarget(null)}
        onLoaded={applyLoaded}
        onNotify={onNotify}
      />

      <AppendVersionDialog
        preset={appendTarget}
        prompt={prompt}
        onClose={() => setAppendTarget(null)}
        onAppended={(next, message) => {
          onReferenceChange(next)
          setFlash(message)
          listing.refresh()
        }}
        onNotify={onNotify}
      />

      <DeletePresetDialog
        preset={deleteTarget}
        reference={reference}
        onClose={() => setDeleteTarget(null)}
        onDeleted={(_preset, message) => {
          setFlash(message)
          listing.refresh()
        }}
        onNotify={onNotify}
      />
    </section>
  )
}
