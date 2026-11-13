import { useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react'
import { importAgent } from '../../agents'
import { useModalA11y } from '../../hooks'
import type { AgentMeta, AgentType } from '../../types'
import { Close, TriangleAlert } from '../icons'
import { SelectMenu } from '../SelectMenu'
import {
  TYPES,
  TYPE_HINT,
  TYPE_LABEL,
  dangerButton,
  describeError,
  inputClass,
  primaryButton,
  secondaryButton
} from './agents-utils'

function ModalFrame({
  titleId,
  title,
  description,
  onClose,
  initialFocusRef,
  children,
  width = 'sm:max-w-[560px]'
}: {
  titleId: string
  title: string
  description?: ReactNode
  onClose: () => void
  initialFocusRef?: RefObject<HTMLElement | null>
  children: ReactNode
  width?: string
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  useModalA11y(true, panelRef, onClose, initialFocusRef)

  return (
    <div
      className="dialog-overlay fixed inset-0 z-[60] flex items-end justify-center bg-apple-text/25 p-0 backdrop-blur-[2px] sm:items-center sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`dialog-panel flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-[20px] border border-black/[0.08] bg-white shadow-lift focus:outline-none sm:max-h-[90dvh] sm:rounded-card ${width}`}
      >
        <div className="flex items-start justify-between gap-3 border-b border-black/[0.06] px-5 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-[17px] font-semibold tracking-[-0.01em]">
              {title}
            </h2>
            {description && <p className="mt-1 text-xs leading-relaxed text-apple-subtext">{description}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="-mr-1 grid h-9 w-9 shrink-0 place-items-center rounded-full text-apple-subtext transition-colors hover:bg-black/[0.04] focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
          >
            <Close className="h-[18px] w-[18px]" />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function ImportDialog({
  onClose,
  onImported
}: {
  onClose: () => void
  onImported: (meta: AgentMeta) => void
}) {
  const [type, setType] = useState<AgentType>('skill')
  const [url, setUrl] = useState('')
  const [license, setLicense] = useState('')
  const [repo, setRepo] = useState('')
  const [commit, setCommit] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const urlRef = useRef<HTMLInputElement>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!url.trim()) {
      setError('URL 不能为空。')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await importAgent({
        type,
        url: url.trim(),
        license: license.trim() || undefined,
        repo: repo.trim() || undefined,
        commit: commit.trim() || undefined
      })
      onImported(result.meta)
    } catch (err) {
      setError(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <ModalFrame
      titleId="agent-import-title"
      title="导入定义"
      description="仅允许 GitHub raw / gist / jsDelivr 的文本 URL；无 license 或含疑似密钥会被拒绝。"
      onClose={busy ? () => undefined : onClose}
      initialFocusRef={urlRef}
    >
      <form onSubmit={(event) => void submit(event)} className="flex min-h-0 flex-1 flex-col" data-testid="import-dialog">
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <div>
            <label htmlFor="import-type" className="text-[13px] font-medium text-apple-text">
              类型
            </label>
            <div className="mt-1.5">
              <SelectMenu
                id="import-type"
                value={type}
                onChange={(val) => setType(val as AgentType)}
                ariaLabel="导入定义类型"
                testId="import-type"
                size="lg"
                options={TYPES.map((item) => ({
                  value: item,
                  label: `${TYPE_LABEL[item]} · ${TYPE_HINT[item]}`
                }))}
              />
            </div>
          </div>

          <div>
            <label htmlFor="import-url" className="text-[13px] font-medium text-apple-text">
              URL
            </label>
            <input
              ref={urlRef}
              id="import-url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://raw.githubusercontent.com/…/SKILL.md"
              data-testid="import-url"
              className={`${inputClass} mt-1.5`}
            />
            <p className="mt-1 text-[11px] leading-relaxed text-apple-subtext">
              允许：raw.githubusercontent.com、gist.githubusercontent.com、cdn.jsdelivr.net/gh。
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="import-license" className="text-[13px] font-medium text-apple-text">
                license
              </label>
              <input
                id="import-license"
                value={license}
                onChange={(event) => setLicense(event.target.value)}
                placeholder="MIT / Apache-2.0"
                data-testid="import-license"
                className={`${inputClass} mt-1.5`}
              />
            </div>
            <div>
              <label htmlFor="import-repo" className="text-[13px] font-medium text-apple-text">
                repo
              </label>
              <input
                id="import-repo"
                value={repo}
                onChange={(event) => setRepo(event.target.value)}
                placeholder="owner/name（可留空）"
                data-testid="import-repo"
                className={`${inputClass} mt-1.5`}
              />
            </div>
          </div>

          <div>
            <label htmlFor="import-commit" className="text-[13px] font-medium text-apple-text">
              commit
            </label>
            <input
              id="import-commit"
              value={commit}
              onChange={(event) => setCommit(event.target.value)}
              placeholder="可选，留空则从 URL 解析"
              data-testid="import-commit"
              className={`${inputClass} mt-1.5`}
            />
          </div>

          {error && (
            <p
              role="alert"
              data-testid="import-error"
              className="flex items-start gap-1.5 rounded-[10px] border border-[#F3D3CF] bg-[#FCEDEB] px-2.5 py-2 text-[12px] leading-relaxed text-[#B3261E]"
            >
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {error}
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-black/[0.06] px-5 py-3">
          <button type="button" onClick={onClose} disabled={busy} className={secondaryButton}>
            取消
          </button>
          <button type="submit" disabled={busy || !url.trim()} data-testid="import-submit" className={primaryButton}>
            {busy ? '导入中…' : '导入'}
          </button>
        </div>
      </form>
    </ModalFrame>
  )
}

export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  busy,
  tone,
  onCancel,
  onConfirm
}: {
  title: string
  description: ReactNode
  confirmLabel: string
  busy: boolean
  tone: 'danger' | 'primary'
  onCancel: () => void
  onConfirm: () => void
}) {
  const cancelRef = useRef<HTMLButtonElement>(null)

  return (
    <ModalFrame
      titleId="agent-confirm-title"
      title={title}
      onClose={busy ? () => undefined : onCancel}
      initialFocusRef={cancelRef}
      width="sm:max-w-[420px]"
    >
      <div className="px-5 py-4 text-[13px] leading-relaxed text-apple-subtext" data-testid="confirm-dialog">
        {description}
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-black/[0.06] px-5 py-3">
        <button
          ref={cancelRef}
          type="button"
          onClick={onCancel}
          disabled={busy}
          data-testid="confirm-cancel"
          className={secondaryButton}
        >
          取消
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          data-testid="confirm-ok"
          className={tone === 'danger' ? dangerButton : primaryButton}
        >
          {busy ? '处理中…' : confirmLabel}
        </button>
      </div>
    </ModalFrame>
  )
}
