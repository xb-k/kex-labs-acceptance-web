import { useEffect, useMemo, useRef, useState } from 'react'
import { HttpError, isAbortError, patchJson, postJson, useJson } from '../../api'
import { formatClockMs } from '../../format'
import { Link } from '../../router'
import type {
  AgentsResponse,
  GeminiGeneratedScript,
  GeminiScriptResponse,
  HistoricalLookupResponse,
  ScriptPromptTemplateInfo,
  StudioBrief,
  TemplateSyncState,
  VideoTemplateId
} from '../../types'
import { SelectMenu } from '../SelectMenu'
import { ASPECTS } from '../studio-ui'
import { Copy, Download, ExternalLink, Refresh, Search, Shield, Sliders, Sparkles } from '../icons'
import { IssueMarkdown } from '../IssueMarkdown'
import { AsyncStatusLine } from '../ui'
import { ScriptTemplateEditorDrawer } from './ScriptTemplateEditorDrawer'
import {
  applyTemplateItemUpdate,
  buildExportMarkdown,
  buildExportPlainText,
  CANONICAL_DURATION_OPTIONS,
  mergePlatformProfiles,
  resolveHistoricalGroundingActive,
  resolveScriptTemplateLibrary,
  sanitizeExportFilename,
  scheduleWaitLabel,
  SCRIPT_PRESETS,
  STORY_ERA_OPTIONS,
  SYNC_INTERVAL_OPTIONS,
  templateSourceBadge,
  toBriefPolishedFromGenerated,
  type ScriptAspect
} from './script-editor-utils'

type RenderViewMode = 'scenes' | 'markdown' | 'edit'

type TemplatesResponse = {
  items: ScriptPromptTemplateInfo[]
  total: number
  categories?: string[]
  sync?: TemplateSyncState
}

/** #134 新契约：`{ items, total, warnings }`，items 带 source（default/override）。 */
type ScriptTemplateLibraryResponse = {
  items: ScriptPromptTemplateInfo[]
  total?: number
  warnings?: string[]
}

type SyncTemplatesResponse = {
  ok: boolean
  items: ScriptPromptTemplateInfo[]
  total: number
  updated_count?: number
  sync: TemplateSyncState
  synced_skills: string[]
}

const SCRIPT_ASPECT_OPTIONS = ASPECTS.filter((a) => a.value !== '') as Array<{
  value: ScriptAspect
  label: string
}>

const EPISODE_MODE_OPTIONS = [
  { value: 'single', label: '单集成片剧本 · 分场直出' },
  { value: 'novel_series', label: '故事 / 小说 · 长篇多章与历史考据' }
] as const

function downloadTextFile(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function ScriptEditorPanel({
  activeBrief,
  onProcessingChange,
  onBriefSynced,
  onNotify
}: {
  activeBrief?: StudioBrief | null
  onProcessingChange?: (running: boolean) => void
  onBriefSynced?: (next: StudioBrief) => void
  onNotify?: (message: string) => void
}) {
  const profilesRes = useJson<AgentsResponse>('/api/agents?type=profile')
  // #134 模板库以 `/api/script-templates` 为准；旧接口仍挂载，仅用于 Gitea 同步状态与失败回退。
  const templateLibraryRes = useJson<ScriptTemplateLibraryResponse>('/api/script-templates')
  const legacyTemplatesRes = useJson<TemplatesResponse>('/api/gemini/script-templates')

  const [remoteTemplatesOverride, setRemoteTemplatesOverride] = useState<ScriptPromptTemplateInfo[] | null>(null)
  /** 抽屉保存/恢复返回的最新单项；先即时回写列表，再静默刷新新接口。 */
  const [savedTemplateItem, setSavedTemplateItem] = useState<ScriptPromptTemplateInfo | null>(null)
  const [syncOverride, setSyncOverride] = useState<TemplateSyncState | null>(null)
  const [editingTemplate, setEditingTemplate] = useState(false)

  const directorProfiles = useMemo(
    () => mergePlatformProfiles(profilesRes.data?.items),
    [profilesRes.data?.items]
  )
  const libraryItems = useMemo(() => {
    const base = remoteTemplatesOverride ?? templateLibraryRes.data?.items
    return savedTemplateItem ? applyTemplateItemUpdate(base, savedTemplateItem) : base
  }, [remoteTemplatesOverride, templateLibraryRes.data?.items, savedTemplateItem])
  const promptTemplates = useMemo(
    () => resolveScriptTemplateLibrary(libraryItems, legacyTemplatesRes.data?.items),
    [libraryItems, legacyTemplatesRes.data?.items]
  )

  const syncState = syncOverride ?? legacyTemplatesRes.data?.sync ?? null
  const [syncingSource, setSyncingSource] = useState<'gitea' | 'github' | null>(null)
  const [updatingSchedule, setUpdatingSchedule] = useState(false)

  // Optional Gitea range constraint for advanced override (Agent discovers automatically by default)
  const [giteaRepo, setGiteaRepo] = useState('')
  const [giteaBranch, setGiteaBranch] = useState('')
  const [giteaFilePath, setGiteaFilePath] = useState('')

  const [prompt, setPrompt] = useState('')
  const [selectedCategory, setSelectedCategory] = useState<string>('all')
  const [selectedTemplateId, setSelectedTemplateId] = useState<VideoTemplateId>('marketing')
  const [customDirectives, setCustomDirectives] = useState<Record<string, string>>({})
  const [autoOptimizeOnSwitch, setAutoOptimizeOnSwitch] = useState(true)
  const [showLibraryManager, setShowLibraryManager] = useState(false)

  const [episodeMode, setEpisodeMode] = useState<'single' | 'novel_series'>('single')
  const [storyEra, setStoryEra] = useState<string>('')
  const [useHistoricalGrounding, setUseHistoricalGrounding] = useState(false)
  const [kbPreview, setKbPreview] = useState<HistoricalLookupResponse | null>(null)
  const [kbLoading, setKbLoading] = useState(false)
  const [kbError, setKbError] = useState<string | null>(null)
  const historicalGroundingActive = resolveHistoricalGroundingActive(useHistoricalGrounding, storyEra)

  const [selectedProfileId, setSelectedProfileId] = useState('ad_teal_orange')
  const [durationS, setDurationS] = useState('15')
  const [aspect, setAspect] = useState<ScriptAspect>('16:9')

  const [generating, setGenerating] = useState(false)
  const [activeModeLabel, setActiveModeLabel] = useState<string>('编写剧本')
  const [generateStartedAt, setGenerateStartedAt] = useState<number | null>(null)
  const [generateStage, setGenerateStage] = useState(0)
  const [syncStartedAt, setSyncStartedAt] = useState<number | null>(null)
  const [scheduleStartedAt, setScheduleStartedAt] = useState<number | null>(null)
  const [schedulePatch, setSchedulePatch] = useState<{
    autoSyncEnabled?: boolean
    intervalHours?: number
  } | null>(null)
  const [scheduleError, setScheduleError] = useState<string | null>(null)
  const scriptAbortRef = useRef<AbortController | null>(null)
  const scriptAbortReasonRef = useRef<'cancel' | 'timeout' | null>(null)
  const scriptTimeoutRef = useRef<number | null>(null)
  const [syncingBrief, setSyncingBrief] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [metaInfo, setMetaInfo] = useState<{ model: string; elapsedMs: number } | null>(null)
  const [generated, setGenerated] = useState<GeminiGeneratedScript | null>(null)
  const [editedMarkdown, setEditedMarkdown] = useState('')
  const [viewMode, setViewMode] = useState<RenderViewMode>('scenes')
  const [copied, setCopied] = useState(false)
  const [copiedShotNo, setCopiedShotNo] = useState<number | null>(null)
  const [templateFeedback, setTemplateFeedback] = useState<{
    key: number
    category: string
    label: string
    specs: string
    mode: 'applied' | 'optimizing' | 'rebuilt'
  } | null>(null)

  const copiedTimer = useRef<number | null>(null)
  const shotCopiedTimer = useRef<number | null>(null)

  const categoryOptions = useMemo(() => {
    const cats = Array.from(new Set(promptTemplates.map((t) => t.category)))
    return [
      { value: 'all', label: '全部行业类别' },
      ...cats.map((c) => ({ value: c, label: c }))
    ]
  }, [promptTemplates])

  const visibleTemplates = useMemo(() => {
    if (selectedCategory === 'all') return promptTemplates
    return promptTemplates.filter((t) => t.category === selectedCategory)
  }, [promptTemplates, selectedCategory])

  const activeTemplate = useMemo(
    () => promptTemplates.find((t) => t.id === selectedTemplateId) ?? promptTemplates[0],
    [promptTemplates, selectedTemplateId]
  )

  const activeDirectives = customDirectives[activeTemplate.id] ?? activeTemplate.systemDirectives
  const isDirectivesCustomized =
    customDirectives[activeTemplate.id] !== undefined &&
    customDirectives[activeTemplate.id].trim() !== activeTemplate.systemDirectives.trim()

  const activeProfile = useMemo(
    () => directorProfiles.find((p) => p.id === selectedProfileId) ?? directorProfiles[0],
    [directorProfiles, selectedProfileId]
  )

  useEffect(
    () => () => {
      scriptAbortRef.current?.abort()
      if (scriptTimeoutRef.current !== null) window.clearTimeout(scriptTimeoutRef.current)
    },
    []
  )

  useEffect(() => {
    return () => {
      if (copiedTimer.current) window.clearTimeout(copiedTimer.current)
      if (shotCopiedTimer.current) window.clearTimeout(shotCopiedTimer.current)
    }
  }, [])

  const fetchHistoricalKb = async (nextPrompt: string, nextEra: string) => {
    setKbLoading(true)
    setKbError(null)
    try {
      const res = await postJson<HistoricalLookupResponse>('/api/gemini/historical-kb/lookup', {
        prompt: nextPrompt.trim(),
        story_era: nextEra.trim()
      })
      setKbPreview(res)
    } catch (err) {
      setKbError(err instanceof Error ? err.message : '检索历史知识库失败')
    } finally {
      setKbLoading(false)
    }
  }

  useEffect(() => {
    if (!historicalGroundingActive) return
    const timer = window.setTimeout(() => {
      void fetchHistoricalKb(prompt, storyEra)
    }, 240)
    return () => window.clearTimeout(timer)
  }, [historicalGroundingActive, storyEra, prompt])

  const toggleHistoricalGrounding = () => {
    if (historicalGroundingActive) {
      setUseHistoricalGrounding(false)
      if (storyEra.trim()) setStoryEra('')
      setKbPreview(null)
      setKbError(null)
    } else {
      setUseHistoricalGrounding(true)
      void fetchHistoricalKb(prompt, storyEra)
    }
  }

  const runScriptRequest = async (
    mode: 'generate' | 'regenerate' | 'optimize',
    overrides?: {
      template?: ScriptPromptTemplateInfo
      directivesOverride?: string
      profileId?: string
      durationVal?: number
      aspectVal?: ScriptAspect
      episodeModeVal?: 'single' | 'novel_series'
      storyEraVal?: string
    }
  ) => {
    const cleanPrompt = prompt.trim()
    if (!cleanPrompt || generating) {
      if (!cleanPrompt) setErrorMsg('请先在左侧输入视频创意或故事大纲，或点击快速示例填入。')
      return
    }

    const targetTemplate = overrides?.template ?? activeTemplate
    const targetProfileId = overrides?.profileId ?? activeProfile.id
    const targetProfileObj =
      directorProfiles.find((p) => p.id === targetProfileId) ?? activeProfile
    const targetDuration = overrides?.durationVal ?? (Number(durationS) || targetTemplate.recommendedDurationS)
    const targetAspect = overrides?.aspectVal ?? aspect
    const targetDirectives =
      overrides?.directivesOverride ?? customDirectives[targetTemplate.id] ?? targetTemplate.systemDirectives
    const targetEpisodeMode = overrides?.episodeModeVal ?? episodeMode
    const targetStoryEra = overrides?.storyEraVal ?? storyEra
    const targetHistoricalGrounding = resolveHistoricalGroundingActive(useHistoricalGrounding, targetStoryEra)

    const controller = new AbortController()
    scriptAbortRef.current = controller
    scriptAbortReasonRef.current = null
    setGenerating(true)
    setGenerateStartedAt(Date.now())
    setGenerateStage(0)
    setActiveModeLabel(
      targetHistoricalGrounding
        ? '检索本地历史知识库'
        : mode === 'optimize'
          ? `按「${targetTemplate.category}」规范实时重构`
          : mode === 'regenerate'
            ? '重构分场视点'
            : targetEpisodeMode === 'novel_series'
              ? '小说分章创作'
              : '编写分场剧本'
    )
    setErrorMsg(null)
    onProcessingChange?.(true)

    try {
      if (targetHistoricalGrounding) {
        try {
          const kbRes = await postJson<HistoricalLookupResponse>('/api/gemini/historical-kb/lookup', {
            prompt: cleanPrompt,
            story_era: targetStoryEra.trim()
          })
          setKbPreview(kbRes)
          setKbError(null)
        } catch {
          // Server still injects local historical KB context deterministically
        }
      }

      setActiveModeLabel(
        mode === 'optimize'
          ? `按「${targetTemplate.category}」规范实时重构`
          : mode === 'regenerate'
            ? '重构分场视点'
            : targetHistoricalGrounding
              ? '注入本地历史知识库并编写剧本'
              : targetEpisodeMode === 'novel_series'
                ? '小说分章创作'
                : '编写分场剧本'
      )

      setGenerateStage(1)
      const timeoutId = window.setTimeout(() => {
        scriptAbortReasonRef.current = 'timeout'
        controller.abort()
      }, 60_000)
      scriptTimeoutRef.current = timeoutId

      const res = await postJson<GeminiScriptResponse>('/api/gemini/script', {
        prompt: cleanPrompt,
        template_id: targetTemplate.id,
        custom_directives: targetDirectives,
        profile: targetProfileObj.id,
        tone: targetProfileObj.tone,
        duration_s: targetDuration,
        aspect: targetAspect,
        episode_mode: targetEpisodeMode,
        story_era: targetStoryEra,
        use_historical_grounding: targetHistoricalGrounding,
        mode,
        previousTitle: generated?.title,
        previous_script:
          mode === 'optimize' && generated
            ? {
                title: generated.title,
                logline: generated.logline,
                scenes: generated.scenes.map((s) => ({
                  scene_no: s.scene_no,
                  duration_s: s.duration_s,
                  shot_type: s.shot_type,
                  visual: s.visual,
                  voiceover: s.voiceover
                }))
              }
            : undefined
      }, controller.signal)

      setGenerateStage(2)
      setGenerated(res.script)
      setEditedMarkdown(res.script.markdown)
      setMetaInfo({ model: res.model, elapsedMs: res.elapsed_ms })
      setGenerateStartedAt(null)
      if (viewMode === 'edit') setViewMode('scenes')
      if (mode === 'optimize') {
        setTemplateFeedback({
          key: Date.now(),
          category: targetTemplate.category,
          label: targetTemplate.label,
          specs: `${targetDuration}s · ${targetAspect} · 已按新规范完成剧本重构`,
          mode: 'rebuilt'
        })
      }
      onNotify?.(
        mode === 'optimize'
          ? `已按「${targetTemplate.category}」规范实时重构《${res.script.title}》`
          : mode === 'regenerate'
            ? `已重新生成视频脚本《${res.script.title}》`
            : `已调用 AI 生成「${targetTemplate.category}」剧本《${res.script.title}》`
      )
    } catch (err) {
      if (isAbortError(err)) {
        if (scriptAbortReasonRef.current === 'timeout') {
          const msg = '模型响应超时（60 秒），可点击「重试生成」。'
          setErrorMsg(msg)
          onNotify?.(msg)
        } else {
          setErrorMsg(null)
          onNotify?.('已取消剧本生成')
        }
      } else {
        let msg = err instanceof Error ? err.message : '调用 AI 生成剧本失败'
        if (err instanceof HttpError && err.payload && typeof err.payload === 'object') {
          const rec = err.payload as { message?: unknown; error?: unknown; detail?: unknown }
          if (typeof rec.message === 'string' && rec.message.trim()) {
            msg = rec.message
          } else if (typeof rec.error === 'string' && rec.error.trim()) {
            msg = rec.error === 'llm_unavailable' ? '本地模型不可用（llm_unavailable）' : rec.error
          }
          if (typeof rec.detail === 'string' && rec.detail.trim()) {
            msg = `${msg}（${rec.detail.trim()}）`
          }
        } else if (err instanceof Error && err.message) {
          msg = err.message
        }
        setErrorMsg(msg)
        onNotify?.(msg)
      }
    } finally {
      if (scriptTimeoutRef.current !== null) {
        window.clearTimeout(scriptTimeoutRef.current)
        scriptTimeoutRef.current = null
      }
      scriptAbortRef.current = null
      scriptAbortReasonRef.current = null
      setGenerateStartedAt(null)
      setGenerating(false)
      onProcessingChange?.(false)
    }
  }

  const cancelScriptRequest = () => {
    if (!scriptAbortRef.current) return
    scriptAbortReasonRef.current = 'cancel'
    scriptAbortRef.current.abort()
  }

  const handleSyncFromSource = async (
    source: 'gitea_discover' | 'gitea' | 'github',
    agentAutoDiscover = true
  ) => {
    if (syncingSource) return
    const isGitea = source === 'gitea' || source === 'gitea_discover'
    setSyncingSource(isGitea ? 'gitea' : 'github')
    setSyncStartedAt(Date.now())
    try {
      const res = await postJson<SyncTemplatesResponse>('/api/gemini/script-templates/sync', {
        source,
        agentAutoDiscover,
        ...(isGitea
          ? {
              ...(giteaRepo.trim() ? { giteaRepo: giteaRepo.trim() } : {}),
              ...(giteaBranch.trim() ? { giteaBranch: giteaBranch.trim() } : {}),
              ...(!agentAutoDiscover && giteaFilePath.trim() ? { giteaFilePath: giteaFilePath.trim() } : {})
            }
          : {})
      })
      setSyncOverride(res.sync)
      setRemoteTemplatesOverride(res.items)
      setSavedTemplateItem(null)
      legacyTemplatesRes.refresh()
      templateLibraryRes.refresh()
      onNotify?.(res.sync.lastResultMessage)

      if (isGitea && generated && prompt.trim() && !generating) {
        const refreshedTpl =
          res.items.find((t) => t.id === selectedTemplateId) ?? activeTemplate
        void runScriptRequest('optimize', {
          template: refreshedTpl,
          directivesOverride: refreshedTpl.systemDirectives
        })
      }
    } catch (err) {
      onNotify?.(err instanceof Error ? err.message : '提示词库拉取失败')
    } finally {
      setSyncingSource(null)
      setSyncStartedAt(null)
    }
  }

  const handleUpdateSchedule = async (patch: { autoSyncEnabled?: boolean; intervalHours?: number }) => {
    if (updatingSchedule) return
    setUpdatingSchedule(true)
    setSchedulePatch(patch)
    setScheduleStartedAt(Date.now())
    setScheduleError(null)
    try {
      const res = await patchJson<{ ok: boolean; sync: TemplateSyncState }>(
        '/api/gemini/script-templates/schedule',
        patch
      )
      setSyncOverride(res.sync)
      onNotify?.(
        res.sync.autoSyncEnabled
          ? `已开启定时自动巡检（每 ${res.sync.intervalHours} 小时）`
          : '已切换为手动触发同步'
      )
    } catch (err) {
      setScheduleError(err instanceof Error ? err.message : '更新同步策略失败')
    } finally {
      setUpdatingSchedule(false)
      setScheduleStartedAt(null)
    }
  }

  /** #134 抽屉保存/恢复成功：即时回写该项并静默刷新列表；selectedTemplateId 不动，选中保持。 */
  const handleTemplateSaved = (item: ScriptPromptTemplateInfo) => {
    setSavedTemplateItem(item)
    templateLibraryRes.refresh()
  }

  const handleSelectVideoTemplate = (tpl: ScriptPromptTemplateInfo) => {
    setSelectedTemplateId(tpl.id)
    setSelectedProfileId(tpl.recommendedProfile)
    setDurationS(String(tpl.recommendedDurationS))
    setAspect(tpl.recommendedAspect)
    const nextEpMode = tpl.id === 'historical_novel' ? 'novel_series' : episodeMode
    if (tpl.id === 'historical_novel') {
      setEpisodeMode('novel_series')
      setUseHistoricalGrounding(true)
    }
    setErrorMsg(null)

    const willAutoOptimize = Boolean(generated && autoOptimizeOnSwitch && prompt.trim() && !generating)
    setTemplateFeedback({
      key: Date.now(),
      category: tpl.category,
      label: tpl.label,
      specs: `推荐 ${tpl.recommendedDurationS}s · ${tpl.recommendedAspect} · 导演模板与指令已同步`,
      mode: willAutoOptimize ? 'optimizing' : 'applied'
    })

    if (willAutoOptimize) {
      void runScriptRequest('optimize', {
        template: tpl,
        profileId: tpl.recommendedProfile,
        durationVal: tpl.recommendedDurationS,
        aspectVal: tpl.recommendedAspect,
        episodeModeVal: nextEpMode
      })
    } else if (generated) {
      onNotify?.(`已切换并应用「${tpl.label}」，点击「实时重构」即可更新已生成剧本`)
    } else {
      onNotify?.(`已切换并生效「${tpl.category} · ${tpl.label}」规范`)
    }
  }

  const handleCategoryChange = (cat: string) => {
    setSelectedCategory(cat)
    if (cat === 'all') return
    const firstInCat = promptTemplates.find((t) => t.category === cat)
    if (firstInCat && firstInCat.id !== selectedTemplateId) {
      handleSelectVideoTemplate(firstInCat)
    }
  }

  const handleEpisodeModeChange = (nextVal: string) => {
    const nextMode: 'single' | 'novel_series' =
      nextVal === 'novel_series' ? 'novel_series' : 'single'
    setEpisodeMode(nextMode)
    if (nextMode === 'novel_series') {
      setUseHistoricalGrounding(true)
      const novelTpl = promptTemplates.find((t) => t.id === 'historical_novel')
      if (novelTpl && selectedTemplateId !== 'historical_novel') {
        setSelectedTemplateId(novelTpl.id)
        setSelectedProfileId(novelTpl.recommendedProfile)
        setDurationS(String(novelTpl.recommendedDurationS))
        setAspect(novelTpl.recommendedAspect)
      }
    }
  }

  const handleCopy = async () => {
    if (!generated) return
    const text = buildExportMarkdown(generated, editedMarkdown)
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      if (copiedTimer.current) window.clearTimeout(copiedTimer.current)
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1800)
      onNotify?.('已复制 Markdown 剧本文稿到剪贴板')
    } catch {
      onNotify?.('复制失败，请使用「导出文稿」下载文件')
    }
  }

  const handleCopyShotPrompt = async (sceneNo: number, videoPrompt: string) => {
    try {
      await navigator.clipboard.writeText(videoPrompt)
      setCopiedShotNo(sceneNo)
      if (shotCopiedTimer.current) window.clearTimeout(shotCopiedTimer.current)
      shotCopiedTimer.current = window.setTimeout(() => setCopiedShotNo(null), 1600)
      onNotify?.(`已复制第 ${String(sceneNo).padStart(2, '0')} 场 I2V 提示词`)
    } catch {
      onNotify?.('复制提示词失败')
    }
  }

  const handleExport = (ext: 'md' | 'txt') => {
    if (!generated) return
    const filename = sanitizeExportFilename(generated.title, ext)
    const content =
      ext === 'md'
        ? buildExportMarkdown(generated, editedMarkdown)
        : buildExportPlainText(generated, editedMarkdown)
    downloadTextFile(
      filename,
      content,
      ext === 'md' ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8'
    )
    onNotify?.(`已导出文稿：${filename}`)
  }

  const handleSyncToBrief = async () => {
    if (!generated || !activeBrief || syncingBrief) return
    setSyncingBrief(true)
    try {
      const updated = await patchJson<StudioBrief>(
        `/api/studio/briefs/${encodeURIComponent(activeBrief.id)}`,
        {
          idea: prompt.trim().slice(0, 1900) || activeBrief.idea,
          tone: activeProfile.tone.slice(0, 180) || activeBrief.tone,
          duration_s: Number(durationS) || activeBrief.duration_s || 20,
          polished: toBriefPolishedFromGenerated(generated, editedMarkdown)
        }
      )
      onBriefSynced?.(updated)
      onNotify?.(`已将 AI 剧本同步至当前任务 Brief（v${updated.version}）`)
    } catch (err) {
      onNotify?.(err instanceof Error ? err.message : '同步至当前 Brief 失败')
    } finally {
      setSyncingBrief(false)
    }
  }

  const totalSceneDuration = generated
    ? generated.scenes.reduce((acc, s) => acc + (Number(s.duration_s) || 0), 0)
    : 0

  return (
    <section
      id="script-editor"
      aria-label="剧本编辑器"
      data-testid="script-editor-module"
      className="card overflow-hidden p-0"
    >
      {/* Top Header Strip */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-black/[0.06] px-5 py-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Sparkles className="h-4 w-4 text-apple-blueInk" />
            <h2 className="text-[16px] font-semibold tracking-[-0.015em] text-apple-text">
              剧本编辑器
            </h2>
            <span className="text-[11px] font-medium text-apple-subtext">
              · {activeTemplate.githubStandard}
            </span>
            {generating && (
              <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-[#0066CC]">
                <span className="live-beacon h-2 w-2 rounded-full bg-apple-blue text-apple-blue" />
                正在{activeModeLabel}…
              </span>
            )}
            {!generating && metaInfo && (
              <span className="num text-[11px] text-apple-subtext">
                · {metaInfo.model} · {(metaInfo.elapsedMs / 1000).toFixed(2)}s
              </span>
            )}
          </div>
          <p className="mt-0.5 text-[12px] text-apple-subtext">
            切换 GitHub 导演提示词模板并支持「历史背景检索」自动注入本地史实知识库，一键产出分场与小说连载剧本。
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setShowLibraryManager((v) => !v)}
            data-testid="script-library-manager-toggle"
            className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors whitespace-nowrap ${
              showLibraryManager
                ? 'border-apple-blue bg-[#EAF2FF] text-apple-blueInk'
                : 'border-black/[0.1] bg-white text-apple-text hover:bg-[#FAFAFB]'
            }`}
          >
            <Sliders className="h-3.5 w-3.5" />
            提示词库配置
          </button>

          {generated && (
            <button
              type="button"
              onClick={() => void runScriptRequest('optimize')}
              disabled={generating || !prompt.trim()}
              data-testid="script-editor-optimize-btn"
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-[#BDD7FF] bg-[#EAF2FF] px-2.5 text-xs font-medium text-apple-blueInk transition-colors hover:bg-[#DCEBFF] disabled:opacity-50 whitespace-nowrap"
            >
              <Sparkles className="h-3.5 w-3.5" />
              实时重构
            </button>
          )}

          <button
            type="button"
            onClick={() => void runScriptRequest('regenerate')}
            disabled={generating || !prompt.trim()}
            data-testid="script-editor-regenerate-btn"
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-black/[0.1] bg-white px-2.5 text-xs font-medium text-apple-text transition-colors hover:bg-[#FAFAFB] disabled:opacity-50 whitespace-nowrap"
          >
            <Refresh className={`h-3.5 w-3.5 ${generating ? 'animate-spin' : ''}`} />
            重新生成
          </button>

          <button
            type="button"
            onClick={() => void handleCopy()}
            disabled={!generated || generating}
            data-testid="script-editor-copy-btn"
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-black/[0.1] bg-white px-2.5 text-xs font-medium text-apple-text transition-colors hover:bg-[#FAFAFB] disabled:opacity-50 whitespace-nowrap"
          >
            <Copy className="h-3.5 w-3.5" />
            {copied ? '已复制' : '复制'}
          </button>

          <button
            type="button"
            onClick={() => handleExport('md')}
            disabled={!generated || generating}
            data-testid="script-editor-export-md-btn"
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-apple-text px-3 text-xs font-medium text-white transition-colors hover:bg-black/85 disabled:opacity-50 whitespace-nowrap"
          >
            <Download className="h-3.5 w-3.5" />
            导出文稿
          </button>

          {activeBrief && (
            <button
              type="button"
              onClick={() => void handleSyncToBrief()}
              disabled={!generated || generating || syncingBrief}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-[#C6DCFF] bg-[#F4F8FF] px-2.5 text-xs font-medium text-apple-blueInk transition-colors hover:bg-[#EAF2FF] disabled:opacity-50 whitespace-nowrap"
            >
              {syncingBrief ? '同步中…' : '同步到 Brief →'}
            </button>
          )}
        </div>
      </div>

      {/* Streamlined Template Selector Bar (Flat, Hairline-Separated) */}
      <div
        data-testid="script-template-library"
        className="border-b border-black/[0.06] bg-[#FAFAFB] px-5 py-3"
      >
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <div className="w-[144px] shrink-0">
              <SelectMenu
                value={selectedCategory}
                onChange={handleCategoryChange}
                ariaLabel="按类别筛选提示词模板"
                testId="script-category-select"
                size="sm"
                options={categoryOptions}
              />
            </div>

            <div
              role="tablist"
              aria-label="按视频类型切换 GitHub 专业提示词模板"
              className="flex flex-wrap items-center gap-1.5"
            >
              {visibleTemplates.map((tpl) => {
                const active = tpl.id === activeTemplate.id
                return (
                  <button
                    key={tpl.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    disabled={generating}
                    data-testid={`script-template-tab-${tpl.id}`}
                    onClick={() => handleSelectVideoTemplate(tpl)}
                    className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[9px] border px-2.5 text-xs font-medium transition-colors whitespace-nowrap disabled:opacity-60 ${
                      active
                        ? 'border-apple-blue bg-white text-apple-blueInk shadow-[0_1px_2px_rgba(0,113,227,0.12)]'
                        : 'border-black/[0.07] bg-white/70 text-apple-subtext hover:border-black/[0.15] hover:bg-white hover:text-apple-text'
                    }`}
                  >
                    <span>{tpl.category}</span>
                    <span className="num text-[10.5px] opacity-75">{tpl.recommendedDurationS}s</span>
                    {templateSourceBadge(tpl.source) && (
                      <span
                        data-testid={`script-template-override-tab-${tpl.id}`}
                        title="该模板已保存本地覆盖"
                        className="rounded-full bg-[#FFF4E5] px-1 py-px text-[9.5px] font-medium text-[#8A4B00]"
                      >
                        {templateSourceBadge(tpl.source)}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>

            <button
              type="button"
              onClick={() => setEditingTemplate(true)}
              disabled={generating}
              data-testid="script-template-edit-btn"
              title="编辑当前导演模板，保存为本地覆盖（PUT /api/script-templates/:id）"
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[9px] border border-black/[0.1] bg-white px-2.5 text-xs font-medium text-apple-text transition-colors hover:bg-[#FAFAFB] disabled:cursor-not-allowed disabled:opacity-60 whitespace-nowrap"
            >
              <Sliders className="h-3.5 w-3.5" />
              编辑模板
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-3 text-[11.5px]">
            <label className="inline-flex cursor-pointer items-center gap-1.5 text-apple-text select-none whitespace-nowrap">
              <input
                type="checkbox"
                checked={autoOptimizeOnSwitch}
                onChange={(e) => setAutoOptimizeOnSwitch(e.target.checked)}
                data-testid="script-auto-optimize-checkbox"
                className="h-3.5 w-3.5 accent-apple-blue"
              />
              <span>切换即重构</span>
            </label>
            <Link
              to="/agents?tab=skill"
              className="text-[11.5px] font-medium text-apple-blueInk hover:underline whitespace-nowrap shrink-0"
            >
              Agent 库规范 →
            </Link>
          </div>
        </div>

        <div className="mt-2 flex flex-wrap items-baseline justify-between gap-2 text-[11.5px] text-apple-subtext">
          <p className="min-w-0 truncate">
            <span className="font-medium text-apple-text">{activeTemplate.label}：</span>
            {activeTemplate.summary} · {activeTemplate.structureBeats}
          </p>
          <div className="flex shrink-0 flex-wrap items-baseline gap-2">
            {activeTemplate.source === 'override' && (
              <span
                data-testid="script-template-override-badge"
                className="rounded-full bg-[#FFF4E5] px-1.5 py-px text-[10.5px] font-medium text-[#8A4B00]"
              >
                已自定义 · 本地覆盖
              </span>
            )}
            {isDirectivesCustomized && (
              <span className="font-mono text-[10.5px] font-medium text-[#9A5B00]">
                已微调导演指令
              </span>
            )}
          </div>
        </div>

        {templateFeedback && (
          <div
            key={templateFeedback.key}
            role="status"
            data-testid="script-template-feedback"
            className={`fx-feedback-pop mt-2 flex flex-wrap items-center justify-between gap-2 rounded-[9px] border px-3 py-1.5 text-[11.5px] ${
              templateFeedback.mode === 'rebuilt'
                ? 'border-[#BCE3C5] bg-[#F2FBF4] text-[#1E7A3C]'
                : 'border-[#C6DCFF] bg-[#F4F8FF] text-apple-blueInk'
            }`}
          >
            <div className="flex min-w-0 items-center gap-2">
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                  templateFeedback.mode === 'rebuilt'
                    ? 'bg-[#2AA151]'
                    : templateFeedback.mode === 'optimizing'
                      ? 'live-beacon bg-apple-blue text-apple-blue'
                      : 'bg-apple-blue'
                }`}
              />
              <span className="font-semibold">
                {templateFeedback.mode === 'optimizing'
                  ? `正按「${templateFeedback.category}」规范实时重构剧本…`
                  : templateFeedback.mode === 'rebuilt'
                    ? `已生效「${templateFeedback.category}」重构`
                    : `已即时生效「${templateFeedback.label}」`}
              </span>
              <span className="truncate text-[11px] opacity-85">· {templateFeedback.specs}</span>
            </div>

            {generated && templateFeedback.mode === 'applied' && !generating && (
              <button
                type="button"
                onClick={() => void runScriptRequest('optimize')}
                className="shrink-0 font-semibold underline underline-offset-2 hover:opacity-80 whitespace-nowrap"
              >
                立即按此重构 →
              </button>
            )}
          </div>
        )}

        {/* Collapsible Flat Configuration Drawer (Gitea / GitHub Sync + Custom Directives) */}
        {showLibraryManager && (
          <div
            data-testid="script-library-manager-panel"
            className="mt-3 space-y-3 border-t border-black/[0.06] pt-3 text-[11.5px]"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <span className="font-semibold text-apple-text">
                  {syncState?.giteaSource?.agentName ?? 'Prompt-Scout Agent'} · Gitea 自动发现与 GitHub 规范同步
                </span>
                {syncState?.giteaSource?.message && (
                  <p className="mt-0.5 text-[11px] text-apple-subtext">
                    {syncState.giteaSource.message}
                    {syncState.giteaSource.lastSyncedAt &&
                      ` · 最近巡检 ${formatClockMs(Date.parse(syncState.giteaSource.lastSyncedAt))}`}
                  </p>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <label className="inline-flex cursor-pointer items-center gap-1.5 text-apple-text select-none whitespace-nowrap">
                  <input
                    type="checkbox"
                    checked={syncState?.autoSyncEnabled ?? true}
                    disabled={updatingSchedule}
                    onChange={(e) => void handleUpdateSchedule({ autoSyncEnabled: e.target.checked })}
                    data-testid="script-auto-sync-toggle"
                    className="h-3.5 w-3.5 accent-apple-blue"
                  />
                  <span>定时巡检</span>
                </label>

                <div className="w-[118px]">
                  <SelectMenu
                    value={String(syncState?.intervalHours ?? 24)}
                    disabled={updatingSchedule || !(syncState?.autoSyncEnabled ?? true)}
                    onChange={(val) => void handleUpdateSchedule({ intervalHours: Number(val) })}
                    ariaLabel="定时同步频率"
                    testId="script-sync-interval-select"
                    align="right"
                    size="sm"
                    numeric
                    options={[...SYNC_INTERVAL_OPTIONS]}
                  />
                </div>

                <button
                  type="button"
                  onClick={() => void handleSyncFromSource('github')}
                  disabled={syncingSource !== null}
                  data-testid="script-manual-sync-btn"
                  className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg border border-black/[0.1] bg-white px-2.5 text-xs font-medium text-apple-text transition-colors hover:bg-black/[0.03] disabled:opacity-55 whitespace-nowrap"
                >
                  <Refresh className={`h-3 w-3 ${syncingSource === 'github' ? 'animate-spin' : ''}`} />
                  {syncingSource === 'github' ? '同步中…' : '同步 GitHub'}
                </button>

                <button
                  type="button"
                  onClick={() => void handleSyncFromSource('gitea_discover', true)}
                  disabled={syncingSource !== null}
                  data-testid="script-gitea-sync-btn"
                  className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-apple-blue px-2.5 text-xs font-medium text-white transition-colors hover:bg-[#0062C4] disabled:opacity-55 whitespace-nowrap"
                >
                  <Search className={`h-3.5 w-3.5 ${syncingSource === 'gitea' ? 'animate-pulse' : ''}`} />
                  {syncingSource === 'gitea'
                    ? 'Agent 巡检中…'
                    : generated
                      ? 'Agent 巡检 Gitea 并重构'
                      : 'Agent 巡检 Gitea'}
                </button>
              </div>
            </div>

            {(syncingSource !== null || updatingSchedule || scheduleError) && (
              <AsyncStatusLine
                testId="script-template-sync-status"
                label={
                  scheduleError
                    ? '保存定时同步策略失败'
                    : syncingSource !== null
                      ? `正在同步 ${syncingSource === 'gitea' ? 'Gitea 提示词库' : 'GitHub 提示词库'}`
                      : schedulePatch
                        ? scheduleWaitLabel(schedulePatch)
                        : '正在保存定时同步策略'
                }
                startedAt={syncingSource !== null ? syncStartedAt : scheduleStartedAt}
                detail={scheduleError ? undefined : '最长 30 秒'}
                error={scheduleError}
                onRetry={
                  scheduleError && schedulePatch
                    ? () => void handleUpdateSchedule(schedulePatch)
                    : undefined
                }
              />
            )}

            {syncState?.giteaSource?.discoveredLocations &&
              syncState.giteaSource.discoveredLocations.length > 0 && (
                <ul className="space-y-1 border-t border-black/[0.05] pt-2">
                  {syncState.giteaSource.discoveredLocations.map((loc) => (
                    <li
                      key={`${loc.repo}:${loc.branch}:${loc.filePath}`}
                      className="flex flex-wrap items-center justify-between gap-2 font-mono text-[10.5px]"
                    >
                      <span className="text-apple-text">
                        {loc.repo}@{loc.branch} → {loc.filePath}
                      </span>
                      <span className="flex items-center gap-2">
                        <span className="text-[#1E7A3C]">命中 {loc.matchedTemplates} 项</span>
                        {loc.htmlUrl && (
                          <a
                            href={loc.htmlUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="text-apple-blueInk hover:underline"
                          >
                            查看源码
                          </a>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}

            <details className="border-t border-black/[0.05] pt-2">
              <summary className="cursor-pointer select-none text-[11px] font-medium text-apple-subtext hover:text-apple-text">
                高级：限定 Gitea 巡检仓库路径或微调当前模板导演指令
              </summary>
              <div className="mt-2.5 space-y-2.5">
                <div className="grid gap-2 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,0.7fr)_minmax(0,1.3fr)_auto]">
                  <input
                    type="text"
                    value={giteaRepo}
                    onChange={(e) => setGiteaRepo(e.target.value)}
                    placeholder="限定仓库（可选，如 owner/repo）"
                    aria-label="限定 Gitea 仓库（可选）"
                    data-testid="script-gitea-repo-input"
                    className="h-8 rounded-lg border border-black/[0.09] bg-white px-2.5 text-[11.5px] text-apple-text focus:border-apple-blue focus:outline-none"
                  />
                  <input
                    type="text"
                    value={giteaBranch}
                    onChange={(e) => setGiteaBranch(e.target.value)}
                    placeholder="分支（自动）"
                    aria-label="Gitea 分支（可选）"
                    data-testid="script-gitea-branch-input"
                    className="h-8 rounded-lg border border-black/[0.09] bg-white px-2.5 text-[11.5px] text-apple-text focus:border-apple-blue focus:outline-none"
                  />
                  <input
                    type="text"
                    value={giteaFilePath}
                    onChange={(e) => setGiteaFilePath(e.target.value)}
                    placeholder="精准路径（留空则自动检索）"
                    aria-label="Gitea 定义文件路径（可选）"
                    data-testid="script-gitea-path-input"
                    className="h-8 rounded-lg border border-black/[0.09] bg-white px-2.5 font-mono text-[11.5px] text-apple-text focus:border-apple-blue focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => void handleSyncFromSource('gitea', false)}
                    disabled={syncingSource !== null || !giteaRepo.trim() || !giteaFilePath.trim()}
                    className="inline-flex h-8 items-center justify-center rounded-lg border border-black/[0.1] bg-white px-2.5 text-[11px] font-medium text-apple-text transition-colors hover:bg-black/[0.03] disabled:opacity-45 whitespace-nowrap"
                  >
                    按路径拉取
                  </button>
                </div>

                <div>
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="font-medium text-apple-text">
                      当前模板导演指令（{activeTemplate.category}）
                    </span>
                    {isDirectivesCustomized && (
                      <button
                        type="button"
                        onClick={() =>
                          setCustomDirectives((prev) => {
                            const next = { ...prev }
                            delete next[activeTemplate.id]
                            return next
                          })
                        }
                        className="text-[11px] font-medium text-apple-blueInk hover:underline"
                      >
                        恢复默认指令
                      </button>
                    )}
                  </div>
                  <textarea
                    rows={3}
                    value={activeDirectives}
                    onChange={(e) =>
                      setCustomDirectives((prev) => ({
                        ...prev,
                        [activeTemplate.id]: e.target.value
                      }))
                    }
                    aria-label="微调当前视频类型的 AI 导演提示词指令"
                    className="w-full rounded-lg border border-black/[0.09] bg-white p-2.5 font-mono text-[11.5px] leading-relaxed text-apple-text focus:border-apple-blue focus:outline-none"
                  />
                </div>
              </div>
            </details>
          </div>
        )}
      </div>

      {editingTemplate && (
        <ScriptTemplateEditorDrawer
          template={activeTemplate}
          onClose={() => setEditingTemplate(false)}
          onSaved={handleTemplateSaved}
          onNotify={onNotify}
        />
      )}

      {/* Main Two-Column Workspace (Hairline Divided, Zero Nested Cards) */}
      <div className="grid divide-y divide-black/[0.06] lg:grid-cols-12 lg:divide-x lg:divide-y-0">
        {/* Left: Input Prompt & Parameter Controls */}
        <div
          data-testid="script-editor-prompt-area"
          className="flex flex-col justify-between bg-white p-5 lg:col-span-5"
        >
          <div className="space-y-4">
            {/* Quick Idea Starters */}
            <div>
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-[12.5px] font-semibold text-apple-text">输入提示词与参数</span>
                <span className="text-[11px] text-apple-subtext">⌘ / Ctrl + Enter 生成</span>
              </div>

              <div className="flex flex-wrap gap-1.5">
                {SCRIPT_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => {
                      setPrompt(preset.prompt)
                      setSelectedCategory('all')
                      setSelectedTemplateId(preset.templateId)
                      setSelectedProfileId(preset.profileId)
                      setDurationS(String(preset.duration_s))
                      setAspect(preset.aspect)
                      setStoryEra(preset.storyEra ?? '')
                      setEpisodeMode(preset.episodeMode ?? 'single')
                      if (preset.templateId === 'historical_novel' || preset.storyEra) {
                        setUseHistoricalGrounding(true)
                      }
                      setErrorMsg(null)
                    }}
                    className="rounded-md border border-black/[0.08] bg-[#FAFAFB] px-2 py-1 text-[11px] font-medium text-apple-subtext transition-colors hover:border-apple-blue/40 hover:bg-white hover:text-apple-text"
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Prompt Textarea */}
            <label className="block">
              <div className="flex items-center justify-between text-[11.5px] font-medium text-apple-subtext">
                <span>视频创意或故事 / 小说大纲</span>
                <span className="num">{prompt.length} / 2000</span>
              </div>
              <textarea
                rows={4}
                maxLength={2000}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault()
                    void runScriptRequest(generated ? 'optimize' : 'generate')
                  }
                }}
                placeholder="输入商业广告、纪录片创意，或输入历史故事/小说大纲，配合下方「历史背景检索」开关注入本地历史知识库…"
                data-testid="script-editor-prompt-input"
                className="mt-1.5 w-full rounded-[10px] border border-black/[0.1] bg-white px-3 py-2.5 text-[12.5px] leading-relaxed text-apple-text placeholder:text-apple-subtext/65 focus:border-apple-blue focus:outline-none"
              />
            </label>

            {/* Prominent Historical Background Retrieval Switch */}
            <div
              data-testid="script-novel-history-box"
              className={`rounded-[12px] border p-3.5 transition-colors ${
                historicalGroundingActive
                  ? 'border-[#9CC3FF] bg-[#F4F8FF]'
                  : 'border-black/[0.09] bg-[#FAFAFB]'
              }`}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2.5">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={historicalGroundingActive}
                    aria-label="历史背景检索"
                    data-testid="script-historical-grounding-checkbox"
                    onClick={toggleHistoricalGrounding}
                    className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50 ${
                      historicalGroundingActive ? 'bg-apple-blue' : 'bg-black/[0.22]'
                    }`}
                  >
                    <span
                      className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.22)] transition-transform duration-200 ${
                        historicalGroundingActive ? 'translate-x-5' : 'translate-x-0.5'
                      }`}
                    />
                  </button>

                  <button
                    type="button"
                    onClick={toggleHistoricalGrounding}
                    className="min-w-0 text-left focus:outline-none"
                  >
                    <div className="flex items-center gap-1.5">
                      <Shield
                        className={`h-3.5 w-3.5 shrink-0 ${
                          historicalGroundingActive ? 'text-apple-blueInk' : 'text-apple-subtext'
                        }`}
                      />
                      <span className="text-[13px] font-semibold text-apple-text">
                        历史背景检索
                      </span>
                      <span
                        className={`text-[11px] font-medium ${
                          historicalGroundingActive ? 'text-apple-blueInk' : 'text-apple-subtext'
                        }`}
                      >
                        · {historicalGroundingActive ? '已开启' : '已关闭'}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11px] text-apple-subtext">
                      {historicalGroundingActive
                        ? '生成剧本时自动检索并注入本地历史知识库上下文（服饰、器物、制度与禁忌）'
                        : '跳过史实约束，适合纯现代商业片或架空题材'}
                    </p>
                  </button>
                </div>

                {historicalGroundingActive && (
                  <button
                    type="button"
                    onClick={() => void fetchHistoricalKb(prompt, storyEra)}
                    disabled={kbLoading}
                    className="shrink-0 text-[11px] font-medium text-apple-blueInk hover:underline disabled:opacity-50 whitespace-nowrap"
                  >
                    {kbLoading ? '检索中…' : '刷新检索'}
                  </button>
                )}
              </div>

              {historicalGroundingActive && (
                <div className="mt-2.5 border-t border-[#C6DCFF]/70 pt-2 text-[11px] leading-relaxed text-apple-subtext">
                  {kbLoading && !kbPreview ? (
                    <span>正在检索本地历史知识库与时代档案…</span>
                  ) : kbError ? (
                    <span className="text-[#B3261E]">{kbError}</span>
                  ) : kbPreview ? (
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2 text-[10.5px]">
                        <span className="font-semibold text-[#1E7A3C]">
                          {kbPreview.ai_verified
                            ? `已注入本地知识库 + 史实核验（${kbPreview.model ?? 'Gemini'}）`
                            : '已就绪 · 自动注入本地历史知识库'}
                        </span>
                        {kbPreview.era_labels.length > 0 && (
                          <span className="num text-apple-blueInk">
                            命中：{kbPreview.era_labels.join(' · ')}
                          </span>
                        )}
                      </div>
                      <p className="line-clamp-3 whitespace-pre-line text-apple-text/85">
                        {kbPreview.brief}
                      </p>
                    </div>
                  ) : (
                    <span>选择下方「历史时期」或在创意中提及朝代/地名，将自动匹配对应历史档案。</span>
                  )}
                </div>
              )}
            </div>

            {/* Unified Platform Dropdowns (100% SelectMenu · Symmetrical 2-Column Grid) */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <span className="mb-1 block text-[11.5px] font-medium text-apple-subtext">
                  创作模式
                </span>
                <SelectMenu
                  value={episodeMode}
                  onChange={handleEpisodeModeChange}
                  ariaLabel="创作模式"
                  testId="script-episode-mode-select"
                  size="md"
                  options={[...EPISODE_MODE_OPTIONS]}
                />
              </div>

              <div>
                <span className="mb-1 block text-[11.5px] font-medium text-apple-subtext">
                  历史时期锁定
                </span>
                <SelectMenu
                  value={storyEra}
                  onChange={setStoryEra}
                  ariaLabel="历史时期锁定"
                  testId="script-editor-era-select"
                  size="md"
                  options={STORY_ERA_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                />
              </div>

              <div className="sm:col-span-2">
                <div className="mb-1 flex items-center justify-between text-[11.5px] font-medium text-apple-subtext">
                  <span>导演风格模板（同步平台 Agent 库）</span>
                  <span className="num text-[11px]">共 {directorProfiles.length} 套</span>
                </div>
                <SelectMenu
                  value={activeProfile.id}
                  onChange={setSelectedProfileId}
                  ariaLabel="导演风格模板"
                  testId="script-editor-profile-select"
                  size="md"
                  options={directorProfiles.map((profile) => ({
                    value: profile.id,
                    label: profile.label,
                    hint: profile.source === 'custom' ? 'Agent 库' : undefined
                  }))}
                />
              </div>

              <div>
                <span className="mb-1 block text-[11.5px] font-medium text-apple-subtext">
                  目标时长
                </span>
                <SelectMenu
                  value={durationS}
                  onChange={setDurationS}
                  ariaLabel="目标时长"
                  testId="script-editor-duration-select"
                  size="md"
                  numeric
                  options={CANONICAL_DURATION_OPTIONS.map((opt) => ({
                    value: String(opt.value),
                    label: opt.label
                  }))}
                />
              </div>

              <div>
                <span className="mb-1 block text-[11.5px] font-medium text-apple-subtext">
                  画幅比例
                </span>
                <SelectMenu
                  value={aspect}
                  onChange={(val) => setAspect(val as ScriptAspect)}
                  ariaLabel="画幅比例"
                  testId="script-editor-aspect-select"
                  size="md"
                  options={SCRIPT_ASPECT_OPTIONS.map((opt) => ({
                    value: opt.value,
                    label: opt.label
                  }))}
                />
              </div>
            </div>
          </div>

          <div className="mt-5 flex items-center justify-between gap-2 border-t border-black/[0.06] pt-3.5">
            <button
              type="button"
              onClick={() => {
                setPrompt('')
                setErrorMsg(null)
              }}
              disabled={!prompt || generating}
              className="text-xs font-medium text-apple-subtext hover:text-apple-text disabled:opacity-40"
            >
              清空输入
            </button>

            <button
              type="button"
              onClick={() => void runScriptRequest('generate')}
              disabled={generating || !prompt.trim()}
              data-testid="script-editor-generate-btn"
              className="btn-sheen inline-flex h-9 shrink-0 items-center gap-1.5 rounded-[10px] bg-apple-blue px-4 text-xs font-medium text-white shadow-soft transition-colors hover:bg-[#0062C4] disabled:opacity-55 whitespace-nowrap"
            >
              <Sparkles className={`h-3.5 w-3.5 ${generating ? 'animate-pulse' : ''}`} />
              {generating ? `AI ${activeModeLabel}中…` : `按「${activeTemplate.category}」生成脚本`}
            </button>
          </div>
        </div>

        {/* Right: Rendered Script View (Flat, Scannable Hierarchy) */}
        <div
          data-testid="script-editor-render-area"
          className="flex flex-col bg-[#FCFCFD] p-5 lg:col-span-7"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-black/[0.06] pb-3">
            <div className="flex items-center gap-2">
              <span className="text-[12.5px] font-semibold text-apple-text">剧本内容渲染区域</span>
              {generated && (
                <span className="num text-[11px] text-apple-subtext">
                  {generated.chapters?.length ? `${generated.chapters.length} 章 · ` : ''}
                  {generated.scenes.length} 场 · {totalSceneDuration.toFixed(1)}s · {generated.aspect}
                </span>
              )}
            </div>

            <div className="inline-flex rounded-lg border border-black/[0.08] bg-[#F2F2F5] p-0.5 text-[11px]">
              {(
                [
                  { id: 'scenes', label: '分场与 I2V 视图' },
                  { id: 'markdown', label: '文稿排版' },
                  { id: 'edit', label: '微调正文' }
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setViewMode(tab.id)}
                  className={`rounded-md px-2.5 py-1 font-medium transition-colors whitespace-nowrap ${
                    viewMode === tab.id
                      ? 'bg-white text-apple-text shadow-sm'
                      : 'text-apple-subtext hover:text-apple-text'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          {errorMsg && (
            <div
              role="alert"
              className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#F5C2C7] bg-[#FFF5F5] px-3.5 py-2.5 text-[12px] text-[#B42318]"
            >
              <span>{errorMsg}</span>
              <button
                type="button"
                onClick={() => void runScriptRequest(generated ? 'optimize' : 'generate')}
                className="font-medium underline underline-offset-2 hover:text-[#7A1811]"
              >
                重试生成
              </button>
            </div>
          )}

          {generating ? (
            <div className="mt-4 space-y-3" aria-busy="true" aria-label="剧本生成中">
              <AsyncStatusLine
                testId="script-generate-status"
                label={`正在${activeModeLabel}`}
                startedAt={generateStartedAt}
                stages={['提交请求', '模型生成', '解析分场数据']}
                stage={generateStage}
                detail="最长 60 秒"
                onCancel={cancelScriptRequest}
              />
              <div className="h-5 w-48 animate-pulse rounded bg-black/[0.06]" />
              <div className="h-14 animate-pulse rounded-xl bg-black/[0.04]" />
              <div className="h-24 animate-pulse rounded-xl bg-black/[0.04]" />
              <div className="h-24 animate-pulse rounded-xl bg-black/[0.04]" />
            </div>
          ) : !generated ? (
            <div className="mt-4 flex flex-1 flex-col items-center justify-center rounded-xl border border-dashed border-black/[0.1] bg-white px-6 py-12 text-center">
              <Sparkles className="h-6 w-6 text-apple-blueInk/70" />
              <p className="mt-2.5 text-[13px] font-medium text-apple-text">
                等待 AI 按「{activeTemplate.label}」生成剧本
              </p>
              <p className="mt-1 max-w-md text-[12px] leading-relaxed text-apple-subtext">
                开启「历史背景检索」将在调用 AI 时自动注入本地历史知识库上下文，保证朝代服饰、器物与制度真实一致。
              </p>
            </div>
          ) : (
            <div className="fx-feedback-pop mt-3 flex-1 space-y-3.5">
              {/* Script Title + Logline (Hairline bottom divider, no extra card box) */}
              <div className="border-b border-black/[0.06] pb-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="text-[15px] font-semibold text-apple-text">{generated.title}</h3>
                  <span className="text-[11px] font-medium text-apple-blueInk">
                    {generated.template_label || activeTemplate.label}
                    {generated.story_era ? ` · ${generated.story_era}` : ''}
                  </span>
                </div>
                <p className="mt-1 text-[12.5px] leading-relaxed text-apple-text/90">
                  {generated.logline}
                </p>
                {generated.optimization_notes && (
                  <p className="mt-1.5 text-[11.5px] leading-relaxed text-[#0B4EA2]">
                    <span className="font-semibold">AI 导演说明：</span>
                    {generated.optimization_notes}
                  </p>
                )}
                <div className="mt-1.5 font-mono text-[11px] text-apple-subtext">
                  风格：{generated.style}
                  {generated.profile ? ` · 模板：${generated.profile}` : ''}
                </div>
              </div>

              {viewMode === 'scenes' && (
                <div className="max-h-[500px] space-y-3 overflow-y-auto pr-1">
                  {generated.historical_context && (
                    <div
                      data-testid="script-historical-context-card"
                      className="rounded-xl border border-[#CBEBD3] bg-[#F3FBF5] p-3 text-[12px]"
                    >
                      <div className="flex items-center gap-1.5 font-semibold text-[#1E7A3C]">
                        <Shield className="h-3.5 w-3.5" />
                        <span>历史知识库与史实考据上下文</span>
                      </div>
                      <p className="mt-1 whitespace-pre-line leading-relaxed text-apple-text/90">
                        {generated.historical_context}
                      </p>
                      {generated.historical_sources && generated.historical_sources.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
                          {generated.historical_sources.map((src) => (
                            <a
                              key={src.url}
                              href={src.url}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 text-[#0B57D0] hover:underline"
                            >
                              <ExternalLink className="h-3 w-3" />
                              {src.title}
                            </a>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {generated.chapters && generated.chapters.length > 0 && (
                    <div
                      data-testid="script-novel-chapters"
                      className="rounded-xl border border-black/[0.07] bg-white p-3"
                    >
                      <div className="flex items-center justify-between gap-2 border-b border-black/[0.06] pb-2">
                        <span className="text-[12px] font-semibold text-apple-text">
                          故事 / 小说多章叙事脉络
                        </span>
                        <span className="num text-[11px] text-apple-subtext">
                          共 {generated.chapters.length} 章
                        </span>
                      </div>
                      <div className="mt-2 grid gap-2.5 sm:grid-cols-2">
                        {generated.chapters.map((ch) => (
                          <div
                            key={ch.chapter_no}
                            className="border-b border-black/[0.05] pb-2 text-[11.5px] last:border-b-0"
                          >
                            <span className="font-semibold text-apple-blueInk">
                              第 {String(ch.chapter_no).padStart(2, '0')} 章 · {ch.title}
                            </span>
                            <p className="mt-0.5 text-[11px] text-apple-subtext">
                              时代锚点：{ch.era_anchor}
                            </p>
                            <p className="mt-1 text-apple-text">{ch.summary}</p>
                            <p className="mt-1 text-[11px] font-medium text-[#9A5B00]">
                              冲突：{ch.key_conflict}
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {generated.scenes.map((scene) => (
                    <div
                      key={scene.scene_no}
                      className="rounded-xl border border-black/[0.07] bg-white p-3.5 transition-colors hover:border-black/[0.14]"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-black/[0.05] pb-2">
                        <div className="flex items-center gap-2">
                          <span className="num rounded bg-[#EAF2FF] px-1.5 py-0.5 text-[11px] font-semibold text-apple-blueInk">
                            场次 {String(scene.scene_no).padStart(2, '0')}
                          </span>
                          <span className="num text-[11.5px] font-medium text-apple-text">
                            {scene.timecode}
                          </span>
                          <span className="num text-[11px] text-apple-subtext">
                            ({scene.duration_s}s)
                          </span>
                        </div>
                        <span className="text-[11px] text-apple-subtext">
                          {scene.shot_type} · {scene.camera}
                        </span>
                      </div>

                      <div className="mt-2.5 space-y-1.5 text-[12px] leading-relaxed">
                        <div>
                          <span className="font-medium text-apple-subtext">视觉锚点：</span>
                          <span className="text-[#0055B3]">{scene.continuity_anchor}</span>
                        </div>
                        <div>
                          <span className="font-medium text-apple-subtext">画面描写：</span>
                          <span className="text-apple-text">{scene.visual}</span>
                        </div>
                        <div className="rounded-lg bg-[#F6F7F9] px-2.5 py-2">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-mono text-[10.5px] font-semibold text-apple-subtext">
                              I2V Prompt
                            </span>
                            <button
                              type="button"
                              onClick={() => void handleCopyShotPrompt(scene.scene_no, scene.video_prompt)}
                              className="inline-flex items-center gap-1 text-[10.5px] font-medium text-apple-blueInk hover:underline"
                            >
                              <Copy className="h-3 w-3" />
                              {copiedShotNo === scene.scene_no ? '已复制' : '复制提示词'}
                            </button>
                          </div>
                          <p className="mt-0.5 font-mono text-[11px] leading-relaxed text-apple-text">
                            {scene.video_prompt}
                          </p>
                        </div>
                        <div>
                          <span className="font-medium text-apple-subtext">旁白台词：</span>
                          <span className="text-apple-text">{scene.voiceover}</span>
                        </div>
                        <div>
                          <span className="font-medium text-apple-subtext">音效配乐：</span>
                          <span className="text-apple-subtext">{scene.audio}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {viewMode === 'markdown' && (
                <div className="max-h-[500px] overflow-y-auto rounded-xl border border-black/[0.06] bg-white p-4">
                  <IssueMarkdown source={editedMarkdown || generated.markdown} />
                </div>
              )}

              {viewMode === 'edit' && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-[11px] text-apple-subtext">
                    <span>支持直接微调 Markdown 剧本文稿，修改后可立即导出或同步</span>
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => handleExport('txt')}
                        className="font-medium text-apple-subtext hover:text-apple-text"
                      >
                        导出 .txt
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditedMarkdown(generated.markdown)}
                        className="font-medium text-apple-blueInk hover:underline"
                      >
                        还原 AI 原始稿
                      </button>
                    </div>
                  </div>
                  <textarea
                    rows={16}
                    value={editedMarkdown}
                    onChange={(e) => setEditedMarkdown(e.target.value)}
                    aria-label="微调视频剧本文稿"
                    className="w-full rounded-xl border border-black/[0.1] bg-white p-3 font-mono text-[12px] leading-relaxed text-apple-text focus:border-apple-blue focus:outline-none"
                  />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
