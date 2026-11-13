import { useRef, useState } from 'react'
import { HttpError, isAbortError, patchJson, postJson } from '../api'
import type {
  StudioBrief,
  StudioBriefConfirmResponse,
  StudioBriefPolishResponse,
  StudioPolished,
  StudioShot
} from '../types'
import { SelectMenu } from './SelectMenu'
import { AsyncStatusLine } from './ui'
import { ASPECTS, Field, inputClass, primaryButton, quietButton } from './studio-ui'

/*
 * Brief 工作台（#87 §2 UI 契约）：想法 → 润色（真调本地模型）→ 追问 → 前后对比 →
 * 可编辑保存 → 确认门禁。所有数据来自真实 API，不做本地假润色。
 */

const POLISH_MAX_SHOTS = 12

type EditableShot = {
  duration: string
  prompt: string
  camera: string
}

type EditablePolished = {
  logline: string
  script: string
  style: string
  shots: EditableShot[]
}

type Failure = { title: string; detail: string | null }

type Fields = {
  idea: string
  audience: string
  duration: string
  aspect: string
  tone: string
}

type Busy = 'polish' | 'save' | 'confirm' | null

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 服务端 polished 已过 schema，这里只做展示层归一化；坏数据按空处理。 */
function toEditable(polished: StudioPolished | null): EditablePolished | null {
  if (!isRecord(polished)) return null
  const shots = Array.isArray(polished.shots) ? polished.shots : []
  return {
    logline: typeof polished.logline === 'string' ? polished.logline : '',
    script: typeof polished.script === 'string' ? polished.script : '',
    style: typeof polished.style === 'string' ? polished.style : '',
    shots: shots.map((shot: StudioShot) => ({
      duration: typeof shot?.duration_s === 'number' ? String(shot.duration_s) : '',
      prompt: typeof shot?.prompt === 'string' ? shot.prompt : '',
      camera: typeof shot?.camera === 'string' ? shot.camera : ''
    }))
  }
}

function toPayload(editable: EditablePolished): StudioPolished {
  const shots = editable.shots.map((shot, index) => {
    const out: StudioShot = {
      no: index + 1,
      duration_s: Number(shot.duration),
      prompt: shot.prompt.trim()
    }
    const camera = shot.camera.trim()
    if (camera) out.camera = camera
    return out
  })
  const out: StudioPolished = {
    logline: editable.logline.trim(),
    script: editable.script.trim(),
    shots
  }
  const style = editable.style.trim()
  if (style) out.style = style
  return out
}

/** 与 `server/studio.ts validatePolished` 同口径的前置校验，错误信息带 path。 */
function validatePolished(editable: EditablePolished): Failure | null {
  if (!editable.logline.trim() || editable.logline.length > 300) {
    return { title: 'logline 需为 1..300 字符', detail: 'path：logline' }
  }
  if (!editable.script.trim() || editable.script.length > 4000) {
    return { title: 'script 需为 1..4000 字符', detail: 'path：script' }
  }
  if (editable.shots.length < 1 || editable.shots.length > POLISH_MAX_SHOTS) {
    return { title: `shots 需为 1..${POLISH_MAX_SHOTS} 条`, detail: 'path：shots' }
  }
  for (let i = 0; i < editable.shots.length; i += 1) {
    const shot = editable.shots[i]
    const at = `shots[${i}]`
    const duration = Number(shot.duration)
    if (!shot.duration.trim() || !Number.isFinite(duration) || duration <= 0 || duration > 600) {
      return { title: '镜头时长需为 (0,600] 的数字', detail: `path：${at}.duration_s` }
    }
    if (!shot.prompt.trim() || shot.prompt.length > 500) {
      return { title: '镜头描述需为 1..500 字符', detail: `path：${at}.prompt` }
    }
    if (shot.camera.length > 80) {
      return { title: '运镜说明需 ≤80 字符', detail: `path：${at}.camera` }
    }
  }
  if (editable.style.length > 120) {
    return { title: 'style 需 ≤120 字符', detail: 'path：style' }
  }
  return null
}

function describeFailure(err: unknown): Failure {
  if (!(err instanceof HttpError)) {
    return { title: '请求失败', detail: err instanceof Error ? err.message : null }
  }
  const body = isRecord(err.payload) ? err.payload : null
  const code = typeof body?.error === 'string' ? body.error : ''
  const reason = typeof body?.reason === 'string' ? body.reason : ''
  const path = typeof body?.path === 'string' ? body.path : ''
  if (code === 'polish_unavailable') {
    return { title: '本地模型不可用', detail: reason ? `原因：${reason}` : null }
  }
  if (code === 'brief_schema_invalid') {
    const where = path ? `path：${path}` : null
    return {
      title: 'Brief 结构不合法（brief_schema_invalid）',
      detail: [where, reason || null].filter(Boolean).join(' · ') || null
    }
  }
  if (code === 'brief_not_ready') {
    const labels: Record<string, string> = {
      questions_pending: '还有追问未补齐',
      'polished missing': '还没有润色结果',
      polished_invalid: '润色结果结构不合法'
    }
    return {
      title: 'Brief 尚未就绪（brief_not_ready）',
      detail: [labels[reason] ?? reason ?? null, path ? `path：${path}` : null]
        .filter(Boolean)
        .join(' · ') || null
    }
  }
  if (code === 'brief_not_confirmed') {
    return { title: 'Brief 尚未确认（brief_not_confirmed）', detail: '需先确认 Brief 才能提交生成。' }
  }
  return {
    title: `请求失败（HTTP ${err.status}${code ? ` · ${code}` : ''}）`,
    detail: reason || null
  }
}

function parseDurationAnswer(answer: string): number | null {
  const match = answer.match(/(\d+(?:\.\d+)?)/)
  if (!match) return null
  let seconds = Number(match[1])
  if (/分钟|分/.test(answer)) seconds *= 60
  if (!Number.isFinite(seconds)) return null
  return Math.min(600, Math.max(1, Math.round(seconds)))
}

function parseAspectAnswer(answer: string): string | null {
  if (/9\s*:\s*16|竖屏|竖版|竖向|竖/.test(answer)) return '9:16'
  if (/16\s*:\s*9|横屏|横版|横向|横/.test(answer)) return '16:9'
  if (/1\s*:\s*1|方形|正方/.test(answer)) return '1:1'
  if (/4\s*:\s*5/.test(answer)) return '4:5'
  return null
}

/**
 * 追问回答并入已知参数（#87 §2.1「补齐后再次润色」）：受众/时长/画幅/调性按关键词
 * 落到结构化字段，其余并入 idea，供下一轮 polish 使用。
 */
function mergeAnswers(fields: Fields, questions: string[], answers: Record<number, string>): Fields {
  const next = { ...fields }
  const leftovers: string[] = []
  questions.forEach((question, index) => {
    const answer = (answers[index] ?? '').trim()
    if (!answer) return
    if (/受众|人群|观众|用户|目标人/.test(question)) {
      next.audience = answer
      return
    }
    if (/时长|秒|分钟|长度|多长/.test(question)) {
      const seconds = parseDurationAnswer(answer)
      if (seconds != null) {
        next.duration = String(seconds)
        return
      }
    } else if (/画幅|比例|竖屏|横屏|尺寸|方形/.test(question)) {
      const aspect = parseAspectAnswer(answer)
      if (aspect != null) {
        next.aspect = aspect
        return
      }
    } else if (/调性|风格|语气|氛围|情绪|基调/.test(question)) {
      next.tone = answer.slice(0, 200)
      return
    }
    leftovers.push(`${question} ${answer}`)
  })
  if (leftovers.length > 0) {
    next.idea = `${next.idea.trim()}\n补充：${leftovers.join('；')}`.slice(0, 2000)
  }
  return next
}

function gateLabel(brief: StudioBrief | null, polished: EditablePolished | null): string {
  if (brief?.status === 'confirmed') return '已确认 · 可提交生成'
  if (!polished) return '草稿 · 尚未润色'
  if ((brief?.questions_pending?.length ?? 0) > 0) return '草稿 · 待补齐追问'
  return '草稿 · 待确认'
}

export function BriefWorkbench({
  brief,
  onBriefChange
}: {
  /** null = 新建 Brief（首次润色时才创建 draft）。 */
  brief: StudioBrief | null
  onBriefChange: (next: StudioBrief | null) => void
}) {
  const [current, setCurrent] = useState<StudioBrief | null>(brief)
  const [idea, setIdea] = useState(brief?.idea ?? '')
  const [audience, setAudience] = useState(brief?.audience ?? '')
  const [duration, setDuration] = useState(brief?.duration_s != null ? String(brief.duration_s) : '')
  const [aspect, setAspect] = useState(brief?.aspect ?? '')
  const [tone, setTone] = useState(brief?.tone ?? '')
  const [questions, setQuestions] = useState<string[]>(brief?.questions_pending ?? [])
  const [answers, setAnswers] = useState<Record<number, string>>({})
  const [polished, setPolished] = useState<EditablePolished | null>(toEditable(brief?.polished ?? null))
  const [llm, setLlm] = useState<{ model: string; elapsed_ms: number } | null>(null)
  const [busy, setBusy] = useState<Busy>(null)
  const [polishStartedAt, setPolishStartedAt] = useState<number | null>(null)
  const [polishStage, setPolishStage] = useState(0)
  const polishAbortRef = useRef<AbortController | null>(null)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const confirmed = current?.status === 'confirmed'
  const gate = gateLabel(current, polished)

  function applyBrief(next: StudioBrief) {
    setCurrent(next)
    onBriefChange(next)
  }

  function fieldsPayload(fields: Fields) {
    return {
      idea: fields.idea,
      audience: fields.audience || null,
      duration_s: fields.duration ? Number(fields.duration) : null,
      aspect: fields.aspect || null,
      tone: fields.tone || null
    }
  }

  async function runPolish() {
    setFailure(null)
    setNote(null)
    const merged = mergeAnswers({ idea, audience, duration, aspect, tone }, questions, answers)
    // 用并入追问回答后的字段校验（服务端同口径，避免无谓请求）。
    const fields = (() => {
      if (!merged.idea.trim()) return null
      if (merged.idea.length > 2000) return null
      let durationValue = ''
      if (merged.duration.trim()) {
        const seconds = Number(merged.duration)
        if (!Number.isFinite(seconds) || seconds < 1 || seconds > 600) return null
        durationValue = String(seconds)
      }
      return {
        idea: merged.idea.trim(),
        audience: merged.audience.trim(),
        duration: durationValue,
        aspect: merged.aspect,
        tone: merged.tone.trim()
      }
    })()
    if (!fields) {
      setFailure({ title: '请检查想法与时长', detail: '想法 1..2000 字，时长 1–600 秒。' })
      return
    }
    setIdea(fields.idea)
    setAudience(fields.audience)
    setDuration(fields.duration)
    setAspect(fields.aspect)
    setTone(fields.tone)

    const controller = new AbortController()
    polishAbortRef.current = controller
    setPolishStartedAt(Date.now())
    setPolishStage(0)
    setBusy('polish')
    try {
      let base = current
      if (!base) {
        base = await postJson<StudioBrief>('/api/studio/briefs', fieldsPayload(fields), controller.signal)
        applyBrief(base)
      } else {
        base = await patchJson<StudioBrief>(
          `/api/studio/briefs/${encodeURIComponent(base.id)}`,
          fieldsPayload(fields),
          controller.signal
        )
        applyBrief(base)
      }
      setPolishStage(1)
      const result = await postJson<StudioBriefPolishResponse>(
        `/api/studio/briefs/${encodeURIComponent(base.id)}/polish`,
        {},
        controller.signal
      )
      setPolishStage(2)
      setIdea(result.brief.idea)
      setAudience(result.brief.audience ?? '')
      setDuration(result.brief.duration_s != null ? String(result.brief.duration_s) : '')
      setAspect(result.brief.aspect ?? '')
      setTone(result.brief.tone ?? '')
      setPolished(toEditable(result.brief.polished))
      setQuestions(result.questions ?? result.brief.questions_pending ?? [])
      setAnswers({})
      setLlm(result.llm ?? null)
      applyBrief(result.brief)
      setNote(
        result.questions.length > 0
          ? `润色完成 · v${result.brief.version}，还有 ${result.questions.length} 条追问待补齐`
          : `润色完成 · v${result.brief.version}${result.llm ? ` · ${result.llm.model}` : ''}`
      )
    } catch (err) {
      if (isAbortError(err)) {
        setNote('已取消润色')
      } else {
        setFailure(describeFailure(err))
      }
    } finally {
      polishAbortRef.current = null
      setPolishStartedAt(null)
      setBusy(null)
    }
  }

  function cancelPolish() {
    polishAbortRef.current?.abort()
  }

  async function runSave() {
    if (!current || !polished) return
    setFailure(null)
    setNote(null)
    const invalid = validatePolished(polished)
    if (invalid) {
      setFailure(invalid)
      return
    }
    setBusy('save')
    try {
      const next = await patchJson<StudioBrief>(`/api/studio/briefs/${encodeURIComponent(current.id)}`, {
        polished: toPayload(polished)
      })
      setPolished(toEditable(next.polished))
      applyBrief(next)
      setNote(`润色结果已保存 · v${next.version}`)
    } catch (err) {
      setFailure(describeFailure(err))
    } finally {
      setBusy(null)
    }
  }

  async function runConfirm() {
    if (!current || !polished || questions.length > 0) return
    setFailure(null)
    setNote(null)
    setBusy('confirm')
    try {
      const result = await postJson<StudioBriefConfirmResponse>(
        `/api/studio/briefs/${encodeURIComponent(current.id)}/confirm`,
        { ack: true }
      )
      applyBrief(result.brief)
      setNote(`已确认 Brief · 入队门禁${result.job_gate === 'open' ? '已开启' : '未开启'}`)
    } catch (err) {
      setFailure(describeFailure(err))
    } finally {
      setBusy(null)
    }
  }

  function updateShot(index: number, patch: Partial<EditableShot>) {
    setPolished((prev) =>
      prev
        ? { ...prev, shots: prev.shots.map((shot, i) => (i === index ? { ...shot, ...patch } : shot)) }
        : prev
    )
  }

  function removeShot(index: number) {
    setPolished((prev) =>
      prev ? { ...prev, shots: prev.shots.filter((_, i) => i !== index) } : prev
    )
  }

  function addShot() {
    setPolished((prev) =>
      prev && prev.shots.length < POLISH_MAX_SHOTS
        ? { ...prev, shots: [...prev.shots, { duration: '', prompt: '', camera: '' }] }
        : prev
    )
  }

  const shotTotal = polished
    ? polished.shots.reduce((sum, shot) => {
        const value = Number(shot.duration)
        return Number.isFinite(value) ? sum + value : sum
      }, 0)
    : 0
  const confirmHint = confirmed
    ? '已确认'
    : !polished
      ? '需先润色'
      : questions.length > 0
        ? '先补齐追问并再次润色'
        : null

  return (
    <div className="mt-2 space-y-3 rounded-[12px] bg-apple-bg/70 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-black/[0.06] pb-2">
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <span className="font-semibold text-apple-text">Brief 工作台</span>
          <span aria-hidden="true" className="text-apple-subtext/60">·</span>
          <span
            data-testid="brief-gate-state"
            className={`inline-flex items-center gap-1.5 font-medium ${
              confirmed
                ? 'text-[#1E7A3C]'
                : polished
                  ? 'text-[#8A4B00]'
                  : 'text-apple-subtextAlt'
            }`}
          >
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 rounded-full ${
                confirmed ? 'bg-apple-statusDone' : polished ? 'bg-[#C77700]' : 'bg-apple-statusPending'
              }`}
            />
            {gate}
          </span>
        </div>
        {current && (
          <span className="num text-[10px] text-apple-subtext">
            {current.id} · v{current.version}
          </span>
        )}
      </div>

      <Field
        id="studio-idea"
        label="想法（中文）"
        hint="一句话说清这条片子要表达什么；润色会调用本地模型，最长 120 秒。"
      >
        <textarea
          id="studio-idea"
          value={idea}
          onChange={(event) => setIdea(event.target.value)}
          placeholder="如：拍一条 30 秒的成都街角咖啡店探店短视频，清晨自然光，突出手冲与拉花"
          maxLength={2000}
          disabled={busy !== null}
          className={`${inputClass} h-auto min-h-[76px] resize-y py-2 leading-relaxed`}
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field id="studio-audience" label="受众" optional>
          <input
            id="studio-audience"
            type="text"
            value={audience}
            onChange={(event) => setAudience(event.target.value)}
            placeholder="如：25-35 岁咖啡爱好者"
            maxLength={200}
            disabled={busy !== null}
            className={inputClass}
          />
        </Field>
        <Field id="studio-duration" label="时长" optional>
          <div className="relative">
            <input
              id="studio-duration"
              type="number"
              min={1}
              max={600}
              value={duration}
              onChange={(event) => setDuration(event.target.value)}
              placeholder="30"
              disabled={busy !== null}
              className={`${inputClass} num pr-8`}
            />
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-apple-subtext">
              秒
            </span>
          </div>
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field id="studio-aspect" label="画幅" optional>
          <SelectMenu
            id="studio-aspect"
            value={aspect}
            onChange={setAspect}
            disabled={busy !== null}
            ariaLabel="画幅比例"
            size="lg"
            options={ASPECTS.map((option) => ({
              value: option.value,
              label: option.label
            }))}
          />
        </Field>
        <Field id="studio-tone" label="调性" optional>
          <input
            id="studio-tone"
            type="text"
            value={tone}
            onChange={(event) => setTone(event.target.value)}
            placeholder="如：温暖治愈"
            maxLength={200}
            disabled={busy !== null}
            className={inputClass}
          />
        </Field>
      </div>

      {busy === 'polish' && (
        <AsyncStatusLine
          testId="brief-polish-status"
          label="本地模型正在润色 Brief"
          startedAt={polishStartedAt}
          stages={['提交想法', '模型润色', '整理分镜']}
          stage={polishStage}
          detail="最长 120 秒"
          onCancel={cancelPolish}
        />
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="brief-polish"
          onClick={() => void runPolish()}
          disabled={busy !== null}
          aria-busy={busy === 'polish'}
          className={`${primaryButton} h-9 px-3.5 text-[12px]`}
        >
          {busy === 'polish' ? '润色中…' : polished ? '再次润色' : '润色'}
        </button>
        <button
          type="button"
          data-testid="brief-confirm"
          onClick={() => void runConfirm()}
          disabled={busy !== null || !polished || questions.length > 0 || confirmed}
          className={`${quietButton} h-9 px-3.5 text-[12px]`}
        >
          {busy === 'confirm' ? '确认中…' : '确认 Brief'}
        </button>
        {confirmHint && (
          <span className="text-[11px] leading-relaxed text-apple-subtext">{confirmHint}</span>
        )}
        {llm && (
          <span className="num ml-auto text-[10px] text-apple-subtext">
            模型 {llm.model} · {(llm.elapsed_ms / 1000).toFixed(1)}s
          </span>
        )}
      </div>

      {failure && (
        <div
          role="alert"
          className="break-words rounded-[10px] bg-[#FCEDEB] px-3 py-2 text-[11px] leading-relaxed text-[#B3261E] ring-1 ring-inset ring-[#F3D3CF]"
        >
          <p className="font-medium">{failure.title}</p>
          {failure.detail && <p className="mt-0.5 break-words">{failure.detail}</p>}
          <button
            type="button"
            data-testid="brief-retry"
            onClick={() => void runPolish()}
            disabled={busy !== null}
            className="mt-1 font-medium underline underline-offset-2 disabled:opacity-50"
          >
            重试润色
          </button>
        </div>
      )}
      {note && (
        <p
          role="status"
          className="break-words rounded-[10px] bg-[#EAF8EE] px-3 py-2 text-[11px] leading-relaxed text-[#1E7A3C] ring-1 ring-inset ring-[#CDEED6]"
        >
          {note}
        </p>
      )}

      {questions.length > 0 && (
        <section
          data-testid="brief-questions"
          className="rounded-[10px] border border-[#F0D9BC] bg-[#FBF1E4]/60 p-3"
        >
          <h4 className="text-[12px] font-medium text-[#8A4B00]">
            Agent 追问（{questions.length}）
          </h4>
          <p className="mt-0.5 text-[11px] leading-relaxed text-[#8A4B00]/80">
            回答后点「再次润色」；受众 / 时长 / 画幅 / 调性按关键词并入对应参数，其余并入想法。
          </p>
          <ul className="mt-2 space-y-2">
            {questions.map((question, index) => (
              <li key={`${index}-${question}`}>
                <label
                  htmlFor={`brief-answer-${index}`}
                  className="break-words text-[11px] font-medium text-apple-text"
                >
                  {question}
                </label>
                <input
                  id={`brief-answer-${index}`}
                  type="text"
                  value={answers[index] ?? ''}
                  onChange={(event) =>
                    setAnswers((prev) => ({ ...prev, [index]: event.target.value }))
                  }
                  placeholder="用中文回答，留空则跳过"
                  maxLength={200}
                  disabled={busy !== null}
                  className={`${inputClass} mt-1 h-9`}
                />
              </li>
            ))}
          </ul>
        </section>
      )}

      {polished && (
        <div data-testid="brief-diff" className="space-y-3">
          <section className="rounded-[10px] border border-black/[0.06] bg-white p-3">
            <h4 className="text-[11px] font-semibold tracking-[0.02em] text-apple-subtext">
              润色前
            </h4>
            <p
              data-testid="brief-idea-before"
              className="mt-1 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-apple-text"
            >
              {current?.idea ?? idea}
            </p>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-apple-subtext">
              <span>受众 {current?.audience ?? '未提供'}</span>
              <span>时长 {current?.duration_s != null ? `${current.duration_s}s` : '未提供'}</span>
              <span>画幅 {current?.aspect ?? '未提供'}</span>
              <span>调性 {current?.tone ?? '未提供'}</span>
            </div>
          </section>

          <section className="rounded-[10px] border border-black/[0.06] bg-white p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h4 className="text-[11px] font-semibold tracking-[0.02em] text-apple-subtext">
                润色后（可编辑，保存走 PATCH）
              </h4>
              <span className="num text-[10px] text-apple-subtext">
                共 {polished.shots.length} 镜 · 合计 {shotTotal.toFixed(1)}s
              </span>
            </div>
            <div className="mt-2 space-y-3">
              <Field id="studio-logline" label="Logline">
                <textarea
                  id="studio-logline"
                  data-testid="brief-logline"
                  value={polished.logline}
                  onChange={(event) =>
                    setPolished((prev) => (prev ? { ...prev, logline: event.target.value } : prev))
                  }
                  maxLength={300}
                  disabled={busy !== null}
                  className={`${inputClass} h-auto min-h-[52px] resize-y py-2 leading-relaxed`}
                />
              </Field>
              <Field id="studio-script" label="分场脚本">
                <textarea
                  id="studio-script"
                  data-testid="brief-script"
                  value={polished.script}
                  onChange={(event) =>
                    setPolished((prev) => (prev ? { ...prev, script: event.target.value } : prev))
                  }
                  maxLength={4000}
                  disabled={busy !== null}
                  className={`${inputClass} h-auto min-h-[96px] resize-y py-2 leading-relaxed`}
                />
              </Field>
              <div>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[13px] font-medium text-apple-text">镜头列表</span>
                  <button
                    type="button"
                    onClick={addShot}
                    disabled={busy !== null || polished.shots.length >= POLISH_MAX_SHOTS}
                    className="rounded text-[11px] font-medium text-apple-blueInk underline underline-offset-2 disabled:opacity-55 focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/40"
                  >
                    ＋ 添加镜头
                  </button>
                </div>
                <ul className="mt-1.5 space-y-2">
                  {polished.shots.map((shot, index) => (
                    <li
                      key={index}
                      className="rounded-[10px] border border-black/[0.06] bg-apple-bg/60 p-2.5"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="num text-[11px] font-medium text-apple-subtext">
                          #{index + 1}
                        </span>
                        <button
                          type="button"
                          onClick={() => removeShot(index)}
                          disabled={busy !== null || polished.shots.length <= 1}
                          className="rounded text-[11px] text-apple-subtext underline underline-offset-2 hover:text-[#B3261E] disabled:opacity-55 focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/40"
                        >
                          删除
                        </button>
                      </div>
                      <div className="mt-1.5 grid grid-cols-[minmax(0,1fr)_88px] gap-2">
                        <input
                          type="text"
                          value={shot.camera}
                          onChange={(event) => updateShot(index, { camera: event.target.value })}
                          placeholder="运镜（可选，≤80 字）"
                          maxLength={80}
                          disabled={busy !== null}
                          aria-label={`镜头 ${index + 1} 运镜`}
                          className={`${inputClass} h-9 text-[12px]`}
                        />
                        <div className="relative">
                          <input
                            type="number"
                            step="0.1"
                            min={0.1}
                            max={600}
                            value={shot.duration}
                            onChange={(event) => updateShot(index, { duration: event.target.value })}
                            disabled={busy !== null}
                            aria-label={`镜头 ${index + 1} 时长（秒）`}
                            className={`${inputClass} num h-9 pr-6 text-[12px]`}
                          />
                          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-apple-subtext">
                            s
                          </span>
                        </div>
                      </div>
                      <textarea
                        value={shot.prompt}
                        onChange={(event) => updateShot(index, { prompt: event.target.value })}
                        placeholder="画面与动作描述（1..500 字）"
                        maxLength={500}
                        disabled={busy !== null}
                        aria-label={`镜头 ${index + 1} 画面描述`}
                        className={`${inputClass} mt-2 h-auto min-h-[52px] resize-y py-2 text-[12px] leading-relaxed`}
                      />
                    </li>
                  ))}
                </ul>
              </div>
              <Field id="studio-style" label="风格" optional>
                <input
                  id="studio-style"
                  type="text"
                  value={polished.style}
                  onChange={(event) =>
                    setPolished((prev) => (prev ? { ...prev, style: event.target.value } : prev))
                  }
                  maxLength={120}
                  disabled={busy !== null}
                  className={inputClass}
                />
              </Field>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="min-w-0 text-[11px] leading-relaxed text-apple-subtext">
                  保存会写回 Brief（PATCH /api/studio/briefs/:id），不触发 GPU。
                </p>
                <button
                  type="button"
                  data-testid="brief-save"
                  onClick={() => void runSave()}
                  disabled={busy !== null}
                  className={`${quietButton} h-9 shrink-0 px-3.5 text-[12px]`}
                >
                  {busy === 'save' ? '保存中…' : '保存润色结果'}
                </button>
              </div>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
