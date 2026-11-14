/**
 * #138 姿态参考库：Studio A 轨下方的参考素材区块。
 *
 * - 列表 / 搜索 / license、shot 筛选走 `GET /api/pose-library`；
 * - 「添加」弹窗先做前端预校验（https、必填、license 白名单），服务端错误原样展示；
 * - 删除二次确认，鉴权失败单独给中文提示；
 * - 纯展示组件（PoseLibraryGrid / PoseLibraryCard / 空态）用 props 驱动，便于 SSR 单测。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ButtonHTMLAttributes, FormEvent, ReactNode } from 'react'
import { useJson } from '../../api'
import { useModalA11y, type ToastMessage } from '../../hooks'
import {
  EMPTY_POSE_DRAFT,
  EMPTY_POSE_FILTERS,
  POSE_LICENSES,
  POSE_LABEL_MAX,
  POSE_SHOT_OPTIONS,
  buildPoseLibraryQuery,
  createPoseEntry,
  formatPoseError,
  formatPoseDate,
  formatPoseSyncStatus,
  getPoseSyncStatus,
  poseShotLabel,
  removePoseEntry,
  runPoseSync,
  validatePoseDraft,
  type PoseDraft,
  type PoseDraftErrors,
  type PoseFilters,
  type PoseLibraryItem,
  type PoseLibraryList,
  type PoseShot,
  type PoseSyncResult
} from '../../pose-library'
import { Close, Copy, ExternalLink, Film, Plus, Refresh, Trash } from '../icons'
import { SelectMenu, type SelectMenuOption } from '../SelectMenu'
import { Field, inputClass, primaryButton, quietButton } from '../studio-ui'
import { AsyncStatusLine } from '../ui'

// 全站统一用 SelectMenu（原生 <select> 在窄容器里会被裁切、与其余下拉不一致）。
const LICENSE_FILTER_OPTIONS: SelectMenuOption[] = [
  { value: '', label: '全部协议' },
  ...POSE_LICENSES.map((license) => ({ value: license, label: license }))
]

const SHOT_FILTER_OPTIONS: SelectMenuOption[] = [
  { value: '', label: '全部镜头' },
  ...POSE_SHOT_OPTIONS.map((opt) => ({ value: opt.value, label: opt.label }))
]

const LICENSE_OPTIONS: SelectMenuOption[] = POSE_LICENSES.map((license) => ({
  value: license,
  label: license
}))

/** 卡片上展示的 URL 去掉 scheme，省宽度；完整地址放 title。 */
const shortenUrl = (url: string) => url.replace(/^https?:\/\//i, '')

type Notify = (message: string, tone?: ToastMessage['tone']) => void

function Chip({ active, children, ...rest }: { active?: boolean; children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      type="button"
      aria-pressed={active}
      className={`inline-flex h-7 items-center rounded-full px-2.5 text-[11px] font-medium transition-colors ${
        active
          ? 'bg-apple-blue text-white'
          : 'border border-black/[0.1] bg-white text-apple-subtext hover:bg-black/[0.03] hover:text-apple-text'
      }`}
    >
      {children}
    </button>
  )
}

// ---------------------------------------------------------------------------
// 纯展示：卡片 / 网格 / 空态（SSR 可渲染）
// ---------------------------------------------------------------------------

export function PoseLibraryCard({
  item,
  deleting,
  onDelete,
  onCopy
}: {
  item: PoseLibraryItem
  deleting?: boolean
  onDelete?: (item: PoseLibraryItem) => void
  onCopy?: (item: PoseLibraryItem) => void
}) {
  const verified = item.license_verified
  // 预览地址失效时退回「无预览图」占位，避免卡片顶部出现破图。
  const [brokenPreview, setBrokenPreview] = useState<string | null>(null)
  const showPreview = Boolean(item.preview_url) && brokenPreview !== item.preview_url
  return (
    <article
      className="flex min-w-0 flex-col overflow-hidden rounded-[14px] border border-black/[0.07] bg-white"
      data-testid="pose-card"
      data-pose-id={item.id}
    >
      <div className="relative aspect-[4/3] w-full overflow-hidden bg-[#F2F2F5]">
        {showPreview ? (
          <img
            src={item.preview_url ?? undefined}
            alt={`${item.label_zh} 预览`}
            loading="lazy"
            onError={() => setBrokenPreview(item.preview_url)}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-apple-subtext">
            <Film className="h-6 w-6" />
            <span className="text-[11px]">无预览图</span>
          </div>
        )}
        <span
          className={`absolute right-2 top-2 inline-flex h-5 items-center rounded-full px-2 text-[10.5px] font-medium ${
            verified ? 'bg-[#E9F7EF] text-apple-greenInk' : 'bg-[#FBF1E4] text-[#8A4B00]'
          }`}
          data-testid="pose-license-badge"
          data-verified={verified ? 'true' : 'false'}
          title={verified ? '授权证据已核' : '授权未核'}
        >
          {verified ? '已核' : '未核'}
        </span>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-2 p-3.5">
        <div className="flex min-w-0 items-start justify-between gap-2">
          <h3 className="min-w-0 break-words text-[14px] font-semibold leading-snug text-apple-text">
            {item.label_zh}
          </h3>
          <span className="num max-w-[50%] shrink-0 truncate rounded-full bg-black/[0.04] px-2 py-0.5 text-[10.5px] text-apple-subtext">
            {item.license}
          </span>
        </div>

        {item.suitable_shots.length > 0 && (
          <div className="flex flex-wrap gap-1" data-testid="pose-shots">
            {item.suitable_shots.map((shot) => (
              <span
                key={shot}
                className="inline-flex h-5 items-center rounded-full bg-[#F0F6FF] px-2 text-[10.5px] font-medium text-apple-blueInk"
              >
                {poseShotLabel(shot)}
              </span>
            ))}
          </div>
        )}

        {item.tags.length > 0 && (
          <p className="min-w-0 break-words text-[11px] leading-relaxed text-apple-subtext">
            #{item.tags.join(' #')}
          </p>
        )}

        <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-1">
          <a
            href={item.source_url}
            target="_blank"
            rel="noreferrer noopener"
            title={item.source_url}
            className="inline-flex min-w-0 max-w-full items-center gap-1 text-[11px] font-medium text-apple-blueInk underline underline-offset-2"
            data-testid="pose-source-link"
          >
            <ExternalLink className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 break-all" data-testid="pose-source-url">
              {shortenUrl(item.source_url)}
            </span>
          </a>
          <div className="flex shrink-0 items-center gap-1.5">
            <span className="num hidden text-[10.5px] text-apple-subtext sm:inline">
              {formatPoseDate(item.created_at)}
            </span>
            <button
              type="button"
              onClick={() => onCopy?.(item)}
              aria-label={`复制引用 ID ${item.id}`}
              title={item.id}
              data-testid="pose-copy-id"
              className="inline-flex h-7 items-center gap-1 rounded-lg border border-black/[0.1] px-2 text-[11px] font-medium text-apple-subtext transition-colors hover:bg-black/[0.04] hover:text-apple-text"
            >
              <Copy className="h-3.5 w-3.5" />
              复制 ID
            </button>
            <button
              type="button"
              onClick={() => onDelete?.(item)}
              disabled={deleting}
              aria-label={`删除 ${item.label_zh}`}
              data-testid="pose-delete"
              className="inline-flex h-7 items-center gap-1 rounded-lg border border-black/[0.1] px-2 text-[11px] font-medium text-apple-subtext transition-colors hover:bg-[#FDEDEC] hover:text-[#B42318] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Trash className="h-3.5 w-3.5" />
              删除
            </button>
          </div>
        </div>
      </div>
    </article>
  )
}

export function PoseLibraryGrid({
  items,
  deletingId,
  onDelete,
  onCopy
}: {
  items: PoseLibraryItem[]
  deletingId?: string | null
  onDelete?: (item: PoseLibraryItem) => void
  onCopy?: (item: PoseLibraryItem) => void
}) {
  return (
    <div
      className="grid min-w-0 grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3"
      data-testid="pose-grid"
    >
      {items.map((item) => (
        <PoseLibraryCard
          key={item.id}
          item={item}
          deleting={deletingId === item.id}
          onDelete={onDelete}
          onCopy={onCopy}
        />
      ))}
    </div>
  )
}

export function PoseLibraryEmpty({
  filtered,
  onClear,
  onAdd
}: {
  filtered: boolean
  onClear?: () => void
  onAdd?: () => void
}) {
  return (
    <div
      className="rounded-[14px] border border-dashed border-black/[0.12] bg-white/60 px-5 py-8 text-center"
      data-testid="pose-empty"
    >
      <p className="text-[13.5px] font-medium text-apple-text">
        {filtered ? '没有匹配的条目' : '尚未收录，添加时需提供 license 证据'}
      </p>
      <p className="mt-1.5 text-[11.5px] leading-relaxed text-apple-subtext">
        {filtered
          ? '换一个关键词或清除筛选条件。'
          : '入库前置：license 与授权证据链接（https），来源不明或证据缺失不能入库。'}
      </p>
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        {filtered && onClear && (
          <button type="button" onClick={onClear} className={`${quietButton} h-8 px-3 text-xs`}>
            清除筛选
          </button>
        )}
        {!filtered && onAdd && (
          <button type="button" onClick={onAdd} className={`${primaryButton} h-8 px-3 text-xs`}>
            添加参考
          </button>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 添加弹窗
// ---------------------------------------------------------------------------

export function PoseAddDialog({
  open,
  onClose,
  onCreated,
  onNotify
}: {
  open: boolean
  onClose: () => void
  onCreated: (item: PoseLibraryItem) => void
  onNotify?: Notify
}) {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const labelRef = useRef<HTMLInputElement | null>(null)
  const [draft, setDraft] = useState<PoseDraft>(EMPTY_POSE_DRAFT)
  const [errors, setErrors] = useState<PoseDraftErrors>({})
  const [serverError, setServerError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [startedAt, setStartedAt] = useState<number | null>(null)

  useModalA11y(open, panelRef, onClose, labelRef)

  useEffect(() => {
    if (!open) return
    setDraft(EMPTY_POSE_DRAFT)
    setErrors({})
    setServerError(null)
    setSubmitting(false)
    setStartedAt(null)
  }, [open])

  const setField = useCallback(<K extends keyof PoseDraft>(key: K, value: PoseDraft[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }))
    setErrors((prev) => ({ ...prev, [key]: undefined }))
  }, [])

  const toggleShot = (shot: PoseShot) => {
    setDraft((prev) => ({
      ...prev,
      suitable_shots: prev.suitable_shots.includes(shot)
        ? prev.suitable_shots.filter((s) => s !== shot)
        : [...prev.suitable_shots, shot]
    }))
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (submitting) return
    const checked = validatePoseDraft(draft)
    if (!checked.ok) {
      setErrors(checked.errors)
      setServerError(null)
      return
    }
    setErrors({})
    setServerError(null)
    setSubmitting(true)
    setStartedAt(Date.now())
    try {
      const item = await createPoseEntry(checked.payload)
      onNotify?.(`已收录「${item.label_zh}」`)
      onCreated(item)
    } catch (err) {
      setServerError(formatPoseError(err))
    } finally {
      setSubmitting(false)
      setStartedAt(null)
    }
  }

  if (!open) return null

  return (
    <div
      className="dialog-overlay fixed inset-0 z-[60] flex items-end justify-center bg-apple-text/25 p-0 sm:items-center sm:p-4"
      role="presentation"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pose-add-title"
        data-testid="pose-add-dialog"
        onClick={(event) => event.stopPropagation()}
        className="dialog-panel flex max-h-[92vh] w-full max-w-[560px] flex-col overflow-hidden rounded-t-[18px] bg-white shadow-lift sm:rounded-[18px]"
      >
        <div className="flex items-start justify-between gap-3 border-b border-black/[0.06] px-5 py-4">
          <div>
            <h2 id="pose-add-title" className="text-[17px] font-semibold tracking-[-0.01em]">
              添加姿态参考
            </h2>
            <p className="mt-1 text-[11.5px] leading-relaxed text-apple-subtext">
              必须同时填写 license 与授权证据链接（https）；未核授权不能入库。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭添加姿态参考"
            className="shrink-0 rounded-lg p-1.5 text-apple-subtext transition-colors hover:bg-black/[0.05] hover:text-apple-text"
          >
            <Close className="h-4 w-4" />
          </button>
        </div>

        <form id="pose-add-form" onSubmit={submit} className="min-h-0 flex-1 space-y-3.5 overflow-y-auto px-5 py-4">
          <Field id="pose-add-label" label="中文标签" hint={`必填，含汉字，≤${POSE_LABEL_MAX} 字`}>
            <input
              id="pose-add-label"
              ref={labelRef}
              value={draft.label_zh}
              onChange={(e) => setField('label_zh', e.target.value)}
              maxLength={POSE_LABEL_MAX}
              className={inputClass}
              placeholder="如：单人侧身站立"
              disabled={submitting}
            />
            {errors.label_zh && <p className="mt-1 text-[11px] text-[#B42318]">{errors.label_zh}</p>}
          </Field>

          <Field id="pose-add-source" label="来源链接" hint="必填，https://">
            <input
              id="pose-add-source"
              value={draft.source_url}
              onChange={(e) => setField('source_url', e.target.value)}
              className={inputClass}
              placeholder="https://posemaniacs.com/"
              disabled={submitting}
              inputMode="url"
            />
            {errors.source_url && <p className="mt-1 text-[11px] text-[#B42318]">{errors.source_url}</p>}
          </Field>

          <div>
            <label htmlFor="pose-add-license" className="text-[13px] font-medium text-apple-text">
              License
            </label>
            <div className="mt-1.5">
              <SelectMenu
                id="pose-add-license"
                testId="pose-add-license"
                value={draft.license}
                options={LICENSE_OPTIONS}
                onChange={(next) => setField('license', next as PoseDraft['license'])}
                placeholder="选择协议"
                ariaLabel="License"
                disabled={submitting}
                size="md"
              />
            </div>
            {errors.license && <p className="mt-1 text-[11px] text-[#B42318]">{errors.license}</p>}
          </div>

          <Field id="pose-add-evidence" label="授权证据链接" hint="必填，https://（来源站的 license/terms 页）">
            <input
              id="pose-add-evidence"
              value={draft.license_evidence_url}
              onChange={(e) => setField('license_evidence_url', e.target.value)}
              className={inputClass}
              placeholder="https://posemaniacs.com/terms"
              disabled={submitting}
              inputMode="url"
            />
            {errors.license_evidence_url && (
              <p className="mt-1 text-[11px] text-[#B42318]">{errors.license_evidence_url}</p>
            )}
          </Field>

          <Field id="pose-add-preview" label="预览图" optional hint="https:// 或以 / 开头的站内路径；留空显示占位">
            <input
              id="pose-add-preview"
              value={draft.preview_url}
              onChange={(e) => setField('preview_url', e.target.value)}
              className={inputClass}
              placeholder="https://…/preview.jpg"
              disabled={submitting}
              inputMode="url"
            />
            {errors.preview_url && <p className="mt-1 text-[11px] text-[#B42318]">{errors.preview_url}</p>}
          </Field>

          <div>
            <span className="text-[13px] font-medium text-apple-text">适用镜头</span>
            <div className="mt-1.5 flex flex-wrap gap-1.5" role="group" aria-label="适用镜头">
              {POSE_SHOT_OPTIONS.map((opt) => (
                <Chip
                  key={opt.value}
                  active={draft.suitable_shots.includes(opt.value)}
                  onClick={() => toggleShot(opt.value)}
                  disabled={submitting}
                >
                  {opt.label}
                </Chip>
              ))}
            </div>
          </div>

          <Field id="pose-add-tags" label="标签" optional hint="逗号分隔，最多 10 个">
            <input
              id="pose-add-tags"
              value={draft.tags}
              onChange={(e) => setField('tags', e.target.value)}
              className={inputClass}
              placeholder="站立, 侧面, 全身"
              disabled={submitting}
            />
            {errors.tags && <p className="mt-1 text-[11px] text-[#B42318]">{errors.tags}</p>}
          </Field>

          {(submitting || serverError) && (
            <AsyncStatusLine
              testId="pose-add-status"
              label={submitting ? '正在添加姿态参考' : '添加失败'}
              startedAt={startedAt}
              active={submitting}
              error={serverError}
            />
          )}
        </form>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-black/[0.06] px-5 py-3.5">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className={`${quietButton} h-8 px-3 text-xs`}
          >
            取消
          </button>
          <button
            type="submit"
            form="pose-add-form"
            disabled={submitting}
            data-testid="pose-add-submit"
            className={`${primaryButton} h-8 px-3.5 text-xs`}
          >
            {submitting ? '提交中…' : '添加'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 删除确认
// ---------------------------------------------------------------------------

export function PoseDeleteDialog({
  entry,
  onClose,
  onDeleted,
  onNotify
}: {
  entry: PoseLibraryItem | null
  onClose: () => void
  onDeleted: (item: PoseLibraryItem) => void
  onNotify?: Notify
}) {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const confirmRef = useRef<HTMLButtonElement | null>(null)
  const [pending, setPending] = useState(false)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  useModalA11y(entry !== null, panelRef, onClose, confirmRef)

  useEffect(() => {
    if (entry) {
      setPending(false)
      setError(null)
      setStartedAt(null)
    }
  }, [entry])

  if (!entry) return null

  const confirm = async () => {
    if (pending) return
    setPending(true)
    setStartedAt(Date.now())
    setError(null)
    try {
      await removePoseEntry(entry.id)
      onNotify?.(`已删除「${entry.label_zh}」`)
      onDeleted(entry)
    } catch (err) {
      setError(formatPoseError(err))
      onNotify?.(`删除失败：${formatPoseError(err)}`, 'err')
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
        aria-labelledby="pose-delete-title"
        data-testid="pose-delete-dialog"
        onClick={(event) => event.stopPropagation()}
        className="dialog-panel w-full max-w-[420px] rounded-[18px] bg-white p-5 shadow-lift"
      >
        <h2 id="pose-delete-title" className="text-[16px] font-semibold tracking-[-0.01em]">
          删除参考条目
        </h2>
        <p className="mt-1.5 break-words text-[12.5px] leading-relaxed text-apple-subtext">
          确认从姿态参考库移除「{entry.label_zh}」？该操作不可撤销。
        </p>
        {(pending || error) && (
          <AsyncStatusLine
            testId="pose-delete-status"
            label={pending ? '正在删除' : '删除失败'}
            startedAt={startedAt}
            active={pending}
            error={error}
            className="mt-3"
          />
        )}
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          <button type="button" onClick={onClose} disabled={pending} className={`${quietButton} h-8 px-3 text-xs`}>
            取消
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={() => void confirm()}
            disabled={pending}
            data-testid="pose-delete-confirm"
            className="h-8 rounded-full bg-[#D92D20] px-3.5 text-xs font-medium text-white transition-colors hover:bg-[#B42318] disabled:cursor-not-allowed disabled:opacity-55"
          >
            {pending ? '删除中…' : '删除'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// GitHub 同步状态行
// ---------------------------------------------------------------------------

/**
 * 面板顶部状态行：上次同步时间 / 导入 / 跳过 / 错误数 + 「从 GitHub 同步」。
 * 纯 props 组件，便于 SSR 断言（不触网）。
 */
export function PoseSyncBar({
  status,
  busy,
  error,
  onSync
}: {
  status: PoseSyncResult | null
  busy: boolean
  error: string | null
  onSync: () => void
}) {
  return (
    <div
      data-testid="pose-sync-bar"
      className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-[12px] bg-black/[0.03] px-3 py-2"
    >
      <div className="min-w-0">
        <p className="num text-[11px] text-apple-subtext" data-testid="pose-sync-status">
          {formatPoseSyncStatus(status)}
        </p>
        {status?.rate_limit.limited && (
          <p className="mt-0.5 text-[11px] text-[#B42318]" data-testid="pose-sync-rate-limited">
            GitHub 已限速（{status.rate_limit.auth === 'token' ? 'token' : '匿名'}），可稍后重试
          </p>
        )}
        {error && (
          <p className="mt-0.5 text-[11px] text-[#B42318]" data-testid="pose-sync-error">
            {error}
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={onSync}
        disabled={busy}
        data-testid="pose-sync-button"
        className={`${quietButton} h-8 shrink-0 gap-1.5 px-3 text-xs`}
      >
        <Refresh className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} />
        {busy ? '同步中…' : '从 GitHub 同步'}
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 面板
// ---------------------------------------------------------------------------

export function PoseLibraryPanel({ onNotify }: { onNotify?: Notify }) {
  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState<PoseFilters>(EMPTY_POSE_FILTERS)
  const [addOpen, setAddOpen] = useState(false)
  const [confirmEntry, setConfirmEntry] = useState<PoseLibraryItem | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [loadingSince, setLoadingSince] = useState<number | null>(null)
  const [syncStatus, setSyncStatus] = useState<PoseSyncResult | null>(null)
  const [syncBusy, setSyncBusy] = useState(false)
  const [syncError, setSyncError] = useState<string | null>(null)

  // 搜索防抖 300ms；license / shot 立即生效。
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setFilters((prev) => (prev.q === search.trim() ? prev : { ...prev, q: search.trim() }))
    }, 300)
    return () => window.clearTimeout(timer)
  }, [search])

  const url = useMemo(
    () => buildPoseLibraryQuery({ q: filters.q, license: filters.license, shot: filters.shot }),
    [filters]
  )
  const listing = useJson<PoseLibraryList>(url)

  useEffect(() => {
    setLoadingSince(Date.now())
  }, [url])

  const items = listing.data?.items ?? []
  const total = listing.data?.total ?? 0
  const filtered = Boolean(filters.q || filters.license || filters.shot)

  const clearFilters = useCallback(() => {
    setSearch('')
    setFilters(EMPTY_POSE_FILTERS)
  }, [])

  const copyId = useCallback(
    async (item: PoseLibraryItem) => {
      try {
        await navigator.clipboard.writeText(item.id)
        onNotify?.(`已复制引用 ID：${item.id}`)
      } catch {
        onNotify?.(`复制失败，引用 ID：${item.id}`, 'err')
      }
    },
    [onNotify]
  )

  const openDelete = useCallback((item: PoseLibraryItem) => {
    setDeletingId(item.id)
    setConfirmEntry(item)
  }, [])

  // 上次同步状态：失败不阻塞列表展示。
  useEffect(() => {
    let cancelled = false
    getPoseSyncStatus()
      .then((status) => {
        if (!cancelled) setSyncStatus(status)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  const syncFromGithub = async () => {
    if (syncBusy) return
    setSyncBusy(true)
    setSyncError(null)
    try {
      const result = await runPoseSync()
      setSyncStatus(result)
      listing.refresh()
      onNotify?.(`已从 GitHub 导入 ${result.imported} 条，跳过 ${result.skipped} 条`)
      if (result.rate_limit.limited) {
        onNotify?.('GitHub 已限速，本次结果可能不完整', 'err')
      }
    } catch (err) {
      const message = formatPoseError(err)
      setSyncError(message)
      onNotify?.(`GitHub 同步失败：${message}`, 'err')
    } finally {
      setSyncBusy(false)
    }
  }

  return (
    <section className="card p-5" aria-labelledby="pose-library-title" data-testid="pose-library">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="pose-library-title" className="text-section">
            姿态参考库
          </h2>
          <p className="mt-1 text-[11px] leading-relaxed text-apple-subtext">
            A 轨参考素材：先核 license 再入库，引用时复制条目 ID。
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="num text-[11px] text-apple-subtext" data-testid="pose-total">
            {listing.status === 'ready' ? `共 ${total} 条` : ''}
          </span>
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            data-testid="pose-add-open"
            className={`${primaryButton} h-8 gap-1.5 px-3 text-xs`}
          >
            <Plus className="h-3.5 w-3.5" />
            添加参考
          </button>
        </div>
      </div>

      <PoseSyncBar
        status={syncStatus}
        busy={syncBusy}
        error={syncError}
        onSync={() => void syncFromGithub()}
      />

      <div className="mt-3.5 flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="搜索中文标签 / 标签"
          aria-label="搜索姿态参考"
          data-testid="pose-search"
          className={`${inputClass} h-9 min-w-0 flex-1 basis-[180px] sm:max-w-[260px]`}
        />
        <SelectMenu
          value={filters.license}
          options={LICENSE_FILTER_OPTIONS}
          onChange={(next) =>
            setFilters((prev) => ({ ...prev, license: next as PoseFilters['license'] }))
          }
          ariaLabel="按 license 筛选"
          testId="pose-filter-license"
          size="sm"
          className="min-w-[132px] shrink-0 basis-[132px]"
        />
        <SelectMenu
          value={filters.shot}
          options={SHOT_FILTER_OPTIONS}
          onChange={(next) => setFilters((prev) => ({ ...prev, shot: next as PoseFilters['shot'] }))}
          ariaLabel="按适用镜头筛选"
          testId="pose-filter-shot"
          size="sm"
          className="min-w-[132px] shrink-0 basis-[132px]"
        />
        {filtered && (
          <button
            type="button"
            onClick={clearFilters}
            data-testid="pose-clear-filters"
            className="inline-flex h-8 items-center gap-1 rounded-full px-2.5 text-[11px] font-medium text-apple-subtext transition-colors hover:bg-black/[0.04] hover:text-apple-text"
          >
            <Refresh className="h-3.5 w-3.5" />
            清除筛选
          </button>
        )}
      </div>

      <div className="mt-4">
        {listing.status === 'loading' && (
          <AsyncStatusLine
            testId="pose-loading"
            label="正在加载姿态参考库"
            startedAt={loadingSince}
          />
        )}

        {listing.status === 'error' && (
          <AsyncStatusLine
            testId="pose-error"
            label="姿态参考库加载失败"
            startedAt={loadingSince}
            active={false}
            error={formatPoseError(listing.error)}
            onRetry={listing.retry}
          />
        )}

        {listing.status === 'ready' && items.length === 0 && (
          <PoseLibraryEmpty filtered={filtered} onClear={clearFilters} onAdd={() => setAddOpen(true)} />
        )}

        {listing.status === 'ready' && items.length > 0 && (
          <PoseLibraryGrid
            items={items}
            deletingId={deletingId}
            onDelete={openDelete}
            onCopy={(item) => void copyId(item)}
          />
        )}
      </div>

      <PoseAddDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={() => {
          setAddOpen(false)
          listing.refresh()
        }}
        onNotify={onNotify}
      />

      <PoseDeleteDialog
        entry={confirmEntry}
        onClose={() => {
          setConfirmEntry(null)
          setDeletingId(null)
        }}
        onDeleted={() => {
          setConfirmEntry(null)
          setDeletingId(null)
          listing.refresh()
        }}
        onNotify={onNotify}
      />
    </section>
  )
}
