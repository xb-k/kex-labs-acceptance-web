import { useEffect, useMemo, useState } from 'react'
import { exportAgentUrl, setAgentSkills } from '../../agents'
import { formatFullStamp } from '../../format'
import { useCopyToClipboard } from '../../hooks'
import type { AgentBindableSkill, AgentDetail, AgentMeta } from '../../types'
import { TriangleAlert } from '../icons'
import { SelectMenu } from '../SelectMenu'
import {
  TYPE_LABEL,
  describeError,
  diffLineClass,
  inputClass,
  namespaceLabel,
  primaryButton,
  secondaryButton,
  shortSha,
  validateJsonContent
} from './agents-utils'

export function AgentDetailPanel({
  detail,
  editing,
  draft,
  message,
  saving,
  actionError,
  diff,
  diffing,
  diffError,
  diffFrom,
  diffTo,
  onDraftChange,
  onMessageChange,
  onStartEdit,
  onCancelEdit,
  onSave,
  onAskRollback,
  onAskToggle,
  onDiffFromChange,
  onDiffToChange,
  onRunDiff,
  bindableSkills,
  onSkillsSaved,
  notify
}: {
  detail: AgentDetail
  editing: boolean
  draft: string
  message: string
  saving: boolean
  actionError: string | null
  diff: string | null
  diffing: boolean
  diffError: string | null
  diffFrom: number
  diffTo: number
  onDraftChange: (value: string) => void
  onMessageChange: (value: string) => void
  onStartEdit: () => void
  onCancelEdit: () => void
  onSave: () => void
  onAskRollback: (meta: AgentMeta, version: number) => void
  onAskToggle: (meta: AgentMeta) => void
  onDiffFromChange: (value: number) => void
  onDiffToChange: (value: number) => void
  onRunDiff: () => void
  bindableSkills: AgentBindableSkill[]
  onSkillsSaved: () => void
  notify: (text: string) => void
}) {
  const { meta, content } = detail
  const versions = [...meta.versions].sort((a, b) => b.version - a.version)
  const activeVersion = meta.versions.find((version) => version.version === meta.active_version)
  const exportExt = meta.type === 'profile' ? 'json' : 'md'
  const activeSha = activeVersion?.sha256 ?? meta.source.sha256

  const { status: shaCopyStatus, copy: copySha } = useCopyToClipboard(1500)
  const { status: contentCopyStatus, copy: copyContent } = useCopyToClipboard(1500)

  const [skillIds, setSkillIds] = useState<string[]>([])
  const [skillsDirty, setSkillsDirty] = useState(false)
  const [skillsSaving, setSkillsSaving] = useState(false)
  const [skillsError, setSkillsError] = useState<string | null>(null)

  useEffect(() => {
    setSkillIds(Array.isArray(meta.skills) ? meta.skills : [])
    setSkillsDirty(false)
    setSkillsError(null)
  }, [meta.id, meta.skills])

  const profileJsonStatus = useMemo(() => {
    if (meta.type !== 'profile') return null
    return validateJsonContent(editing ? draft : content)
  }, [meta.type, editing, draft, content])

  function toggleSkill(id: string, checked: boolean) {
    setSkillIds((prev) => (checked ? [...new Set([...prev, id])] : prev.filter((value) => value !== id)))
    setSkillsDirty(true)
  }

  async function submitSkills() {
    setSkillsSaving(true)
    setSkillsError(null)
    try {
      await setAgentSkills(meta.id, skillIds)
      setSkillsDirty(false)
      notify('技能已更新')
      onSkillsSaved()
    } catch (err) {
      setSkillsError(describeError(err))
    } finally {
      setSkillsSaving(false)
    }
  }

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="inline-flex items-center rounded-md bg-[#EAF2FF] px-1.5 py-0.5 text-[10px] font-medium text-apple-blueInk ring-1 ring-inset ring-[#D8E6FE]">
              {TYPE_LABEL[meta.type]}
            </span>
            <span className="inline-flex items-center rounded-md bg-black/[0.04] px-1.5 py-0.5 text-[10px] text-apple-subtextAlt ring-1 ring-inset ring-black/[0.07]">
              {namespaceLabel[meta.namespace] ?? meta.namespace}
            </span>
            <span
              className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset ${
                meta.active
                  ? 'bg-[#EAF8EE] text-[#1E7A3C] ring-[#D5EFDC]'
                  : 'bg-black/[0.04] text-apple-subtextAlt ring-black/[0.07]'
              }`}
            >
              <span className={`h-1 w-1 rounded-full ${meta.active ? 'bg-[#30A14E]' : 'bg-[#8E8E93]'}`} />
              {meta.active ? '启用' : '停用'}
            </span>
            {profileJsonStatus && (
              <span
                className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset ${
                  profileJsonStatus.ok
                    ? 'bg-[#EAF8EE] text-[#1E7A3C] ring-[#D5EFDC]'
                    : 'bg-[#FCEDEB] text-[#B3261E] ring-[#F3D3CF]'
                }`}
              >
                {profileJsonStatus.ok ? 'JSON 有效' : 'JSON 语法无效'}
              </span>
            )}
          </div>
          <h2 className="mt-2 break-words text-[20px] font-semibold leading-tight tracking-[-0.015em]">
            {meta.name}
          </h2>
          <p className="num mt-0.5 break-all text-[11px] text-apple-subtext">{meta.id}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onStartEdit}
            disabled={editing}
            data-testid="agent-edit"
            className={secondaryButton}
          >
            编辑
          </button>
          <button
            type="button"
            onClick={() => onAskToggle(meta)}
            data-testid="agent-toggle"
            className={secondaryButton}
          >
            {meta.active ? '停用' : '启用'}
          </button>
          <a
            href={exportAgentUrl(meta.type, meta.id)}
            download={`${meta.id}.${exportExt}`}
            data-testid="agent-export"
            className={secondaryButton}
          >
            导出
          </a>
        </div>
      </div>

      {meta.description && (
        <p className="mt-2 max-w-[80ch] text-[12px] leading-relaxed text-apple-subtext">{meta.description}</p>
      )}

      {actionError && (
        <p
          role="alert"
          className="mt-3 flex items-start gap-1.5 rounded-[10px] border border-[#F3D3CF] bg-[#FCEDEB] px-2.5 py-2 text-[12px] leading-relaxed text-[#B3261E]"
        >
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {actionError}
        </p>
      )}

      <dl className="mt-4 grid min-w-0 grid-cols-1 gap-x-4 gap-y-1.5 rounded-[12px] border border-black/[0.06] bg-[#FAFAFC] p-3 text-[11px] leading-5 sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="text-apple-subtext">repo</dt>
          <dd className="break-all font-medium text-apple-text">{meta.source.repo ?? '本地镜像'}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-apple-subtext">license</dt>
          <dd className="font-medium text-apple-text">{meta.source.license ?? '未声明'}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-apple-subtext">commit</dt>
          <dd className="num break-all text-apple-text">{meta.source.commit ?? '—'}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-apple-subtext">更新</dt>
          <dd className="num text-apple-text">{formatFullStamp(meta.updated_at)}</dd>
        </div>
        <div className="min-w-0 sm:col-span-2">
          <dt className="text-apple-subtext">来源 URL</dt>
          <dd className="break-all text-apple-text">{meta.source.url ?? '—'}</dd>
        </div>
        <div className="min-w-0 sm:col-span-2">
          <dt className="text-apple-subtext">active sha256</dt>
          <dd className="flex flex-wrap items-center justify-between gap-2">
            <span className="num min-w-0 break-all text-apple-text">{activeSha}</span>
            <button
              type="button"
              onClick={() => void copySha(activeSha)}
              className="shrink-0 rounded-full border border-black/[0.08] bg-white px-2 py-0.5 text-[10px] font-medium text-apple-text transition-colors hover:bg-apple-bg"
            >
              {shaCopyStatus === 'copied' ? '已复制' : '复制 sha256'}
            </button>
          </dd>
        </div>
      </dl>

      {meta.type === 'agent' && (
        <section className="mt-4" data-testid="agent-skills" aria-labelledby="agent-skills-title">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 id="agent-skills-title" className="text-[13px] font-semibold text-apple-text">
              项目技能 <span className="num font-normal text-apple-subtext">{skillIds.length}</span>
            </h3>
            <span className="text-[10px] text-apple-subtext">仅同项目（{meta.project ?? '未分组'}）</span>
          </div>
          {bindableSkills.length === 0 ? (
            <p className="mt-2 rounded-[10px] border border-dashed border-black/[0.12] px-3 py-2 text-[11px] text-apple-subtext">
              本项目暂无技能
            </p>
          ) : (
            <ul className="mt-2 grid min-w-0 gap-1.5 sm:grid-cols-2">
              {bindableSkills.map((skill) => {
                const checked = skillIds.includes(skill.id)
                return (
                  <li key={skill.id} className="min-w-0">
                    <label className="flex min-w-0 cursor-pointer items-start gap-2 rounded-[10px] border border-black/[0.07] bg-white px-2.5 py-2 transition-colors hover:bg-[#FAFAFC]">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={skillsSaving}
                        onChange={(event) => toggleSkill(skill.id, event.target.checked)}
                        data-testid={`skill-bind-${skill.id}`}
                        className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded border-black/20 accent-apple-blue focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/40 disabled:opacity-50"
                      />
                      <span className="min-w-0">
                        <span className="block truncate text-[12px] font-medium text-apple-text">{skill.name}</span>
                        <span className="num block truncate text-[10px] text-apple-subtext">{skill.id}</span>
                        {skill.description && (
                          <span className="mt-0.5 line-clamp-2 block text-[10px] leading-relaxed text-apple-subtext">
                            {skill.description}
                          </span>
                        )}
                      </span>
                    </label>
                  </li>
                )
              })}
            </ul>
          )}
          {skillsError && (
            <p role="alert" className="mt-2 text-[11px] leading-relaxed text-[#B3261E]">
              {skillsError}
            </p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void submitSkills()}
              disabled={skillsSaving || !skillsDirty}
              data-testid="agent-skills-save"
              className={secondaryButton}
            >
              {skillsSaving ? '保存中…' : '保存技能'}
            </button>
            <span className="text-[10px] text-apple-subtext">只保存技能 id，不内联内容。</span>
          </div>
        </section>
      )}

      <div className="mt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[13px] font-semibold text-apple-text">
            Active 内容 <span className="num font-normal text-apple-subtext">v{meta.active_version}</span>
          </h3>
          {!editing && (
            <div className="flex items-center gap-2">
              {activeVersion && <span className="num text-[10px] text-apple-subtext">{shortSha(activeVersion.sha256)}</span>}
              <button
                type="button"
                onClick={() => void copyContent(content)}
                className="rounded-full border border-black/[0.08] bg-white px-2.5 py-0.5 text-[10px] font-medium text-apple-text transition-colors hover:bg-apple-bg"
              >
                {contentCopyStatus === 'copied' ? '已复制' : '复制正文'}
              </button>
            </div>
          )}
        </div>

        {editing ? (
          <div className="mt-2 space-y-2">
            <label htmlFor="agent-editor" className="sr-only">
              编辑内容
            </label>
            <textarea
              id="agent-editor"
              value={draft}
              onChange={(event) => onDraftChange(event.target.value)}
              spellCheck={false}
              data-testid="agent-editor"
              className="num min-h-[260px] w-full resize-y rounded-[12px] border border-black/[0.1] bg-white p-3 text-[11px] leading-relaxed text-apple-text focus:border-apple-blue focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/25"
            />
            {profileJsonStatus && !profileJsonStatus.ok && (
              <p role="alert" className="text-[11px] text-[#B3261E]">
                JSON 解析错误：{profileJsonStatus.message}（修复后才能保存 Profile）
              </p>
            )}
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <label htmlFor="agent-message" className="sr-only">
                版本说明
              </label>
              <input
                id="agent-message"
                value={message}
                onChange={(event) => onMessageChange(event.target.value)}
                placeholder="版本说明（可选，默认 edit）"
                data-testid="agent-message"
                className={`${inputClass} h-9 flex-1 text-[12px]`}
              />
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={onCancelEdit}
                  disabled={saving}
                  data-testid="agent-cancel"
                  className={secondaryButton}
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={onSave}
                  disabled={saving || Boolean(profileJsonStatus && !profileJsonStatus.ok)}
                  data-testid="agent-save"
                  className={primaryButton}
                >
                  {saving ? '保存中…' : '保存新版本'}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <pre
            data-testid="agent-content"
            className="num mt-2 max-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded-[12px] border border-black/[0.07] bg-white p-3 text-[11px] leading-relaxed text-[#3A3A3E]"
          >
            {content}
          </pre>
        )}
      </div>

      <div className="mt-5 grid min-w-0 gap-4 xl:grid-cols-2">
        <section className="min-w-0">
          <h3 className="text-[13px] font-semibold text-apple-text">
            版本 <span className="num font-normal text-apple-subtext">{meta.versions.length}</span>
          </h3>
          <ul className="mt-2 max-h-[280px] space-y-1.5 overflow-y-auto pr-1">
            {versions.map((version) => {
              const isActive = version.version === meta.active_version
              return (
                <li
                  key={version.version}
                  data-testid={`agent-version-${version.version}`}
                  className={`flex items-center justify-between gap-2 rounded-[10px] border px-2.5 py-2 ${
                    isActive ? 'border-[#D8E6FE] bg-[#F7FAFF]' : 'border-black/[0.06] bg-white'
                  }`}
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="num text-[12px] font-medium text-apple-text">v{version.version}</span>
                      {isActive && (
                        <span className="rounded bg-[#EAF2FF] px-1 py-0.5 text-[9px] font-medium text-apple-blueInk">
                          active
                        </span>
                      )}
                    </div>
                    <p className="truncate text-[10px] text-apple-subtext">{version.message || '（无说明）'}</p>
                    <p className="num text-[10px] text-apple-subtext/80">
                      {formatFullStamp(version.created_at)} · {shortSha(version.sha256)}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => onAskRollback(meta, version.version)}
                    disabled={isActive}
                    data-testid={`agent-rollback-${version.version}`}
                    className="inline-flex h-7 shrink-0 items-center rounded-full border border-black/[0.1] bg-white px-2.5 text-[11px] font-medium text-apple-text transition-colors hover:bg-[#FAFAFC] focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/40 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    回滚
                  </button>
                </li>
              )
            })}
          </ul>
        </section>

        <section className="min-w-0">
          <h3 className="text-[13px] font-semibold text-apple-text">版本对比</h3>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <div className="w-[96px]">
              <SelectMenu
                id="agent-diff-from"
                value={String(diffFrom)}
                onChange={(val) => onDiffFromChange(Number(val))}
                ariaLabel="对比起始版本"
                testId="agent-diff-from"
                size="md"
                numeric
                options={meta.versions.map((version) => ({
                  value: String(version.version),
                  label: `v${version.version}`
                }))}
              />
            </div>
            <span className="text-[11px] text-apple-subtext">↔</span>
            <div className="w-[96px]">
              <SelectMenu
                id="agent-diff-to"
                value={String(diffTo)}
                onChange={(val) => onDiffToChange(Number(val))}
                ariaLabel="对比目标版本"
                testId="agent-diff-to"
                size="md"
                numeric
                options={meta.versions.map((version) => ({
                  value: String(version.version),
                  label: `v${version.version}`
                }))}
              />
            </div>
            <button
              type="button"
              onClick={onRunDiff}
              disabled={diffing || meta.versions.length < 2}
              data-testid="agent-diff-run"
              className={secondaryButton}
            >
              {diffing ? '对比中…' : '对比'}
            </button>
          </div>
          {meta.versions.length < 2 && (
            <p className="mt-2 text-[11px] leading-relaxed text-apple-subtext">
              仅一个版本，暂无可对比版本；编辑保存后可对比 v1 ↔ v2。
            </p>
          )}
          {diffError && (
            <p role="alert" className="mt-2 text-[11px] leading-relaxed text-[#B3261E]">
              {diffError}
            </p>
          )}
          {diff !== null && (
            <pre
              data-testid="agent-diff"
              className="num mt-2 max-h-[300px] overflow-auto rounded-[12px] border border-black/[0.07] bg-[#FAFAFC] p-2.5 text-[10px] leading-relaxed"
            >
              {diff.length === 0 ? (
                <span className="text-apple-subtext">两个版本内容一致。</span>
              ) : (
                diff.split('\n').map((line, index) => (
                  <span key={index} className={`block whitespace-pre-wrap break-all ${diffLineClass(line)}`}>
                    {line || ' '}
                  </span>
                ))
              )}
            </pre>
          )}
        </section>
      </div>
    </div>
  )
}
