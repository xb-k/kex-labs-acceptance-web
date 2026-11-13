/**
 * Manual-verification overlay for Gitea issues / acceptance task cards (issue #77).
 *
 * Gitea issues are never deleted. The UI hides `source/acceptance` task cards by
 * default and keeps their tri-state review (`pending | pass | fail`) in a small
 * JSON file next to the other runtime state. This module is pure data + file IO;
 * HTTP auth stays in `api.ts` (`requireShareWriteToken`, same policy as shares).
 */
import fs from 'node:fs'
import path from 'node:path'

export type ManualVerifyState = 'pending' | 'pass' | 'fail'
export type ManualVerifyEntry = {
  state: 'pass' | 'fail'
  note: string | null
  updated_at: string
}
export type ManualVerifyStore = { version: 1; items: Record<string, ManualVerifyEntry> }
export type ManualVerifyView = {
  key: string
  state: ManualVerifyState
  note: string | null
  updated_at: string | null
}

export const MANUAL_VERIFY_STATES: readonly ManualVerifyState[] = ['pending', 'pass', 'fail']
const MAX_KEY_LENGTH = 80

export function normalizeVerifyKey(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const key = value.trim()
  if (!key || key.length > MAX_KEY_LENGTH) return null
  if (/[\u0000-\u001f\u007f]/.test(key)) return null
  return key
}

export function normalizeVerifyState(value: unknown): ManualVerifyState | null {
  if (typeof value !== 'string') return null
  const state = value.trim().toLowerCase()
  return (MANUAL_VERIFY_STATES as readonly string[]).includes(state)
    ? (state as ManualVerifyState)
    : null
}

/** Missing/corrupt file = empty store (never throws). */
export function readManualVerify(file: string): ManualVerifyStore {
  let raw: unknown = null
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return { version: 1, items: {} }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { version: 1, items: {} }
  const items = (raw as { items?: unknown }).items
  if (!items || typeof items !== 'object' || Array.isArray(items)) return { version: 1, items: {} }
  const out: Record<string, ManualVerifyEntry> = {}
  for (const [key, entry] of Object.entries(items as Record<string, unknown>)) {
    if (!normalizeVerifyKey(key) || !entry || typeof entry !== 'object') continue
    const state = (entry as { state?: unknown }).state
    if (state !== 'pass' && state !== 'fail') continue
    const note = (entry as { note?: unknown }).note
    const at = (entry as { updated_at?: unknown }).updated_at
    out[key] = {
      state,
      note: typeof note === 'string' && note.trim() ? note.trim() : null,
      updated_at: typeof at === 'string' && at ? at : new Date(0).toISOString()
    }
  }
  return { version: 1, items: out }
}

/** Atomic write (tmp + rename), same discipline as `atomicWriteJson` in api.ts. */
export function writeManualVerify(file: string, store: ManualVerifyStore): void {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, file)
}

export function manualVerifyForKey(store: ManualVerifyStore, key: string): ManualVerifyView {
  const entry = store.items[key]
  if (!entry) return { key, state: 'pending', note: null, updated_at: null }
  return { key, state: entry.state, note: entry.note, updated_at: entry.updated_at }
}

export function setManualVerify(
  file: string,
  key: string,
  state: ManualVerifyState,
  note: string | null
): ManualVerifyView {
  const store = readManualVerify(file)
  if (state === 'pending') {
    if (store.items[key]) {
      delete store.items[key]
      writeManualVerify(file, store)
    }
    return { key, state: 'pending', note: null, updated_at: null }
  }
  const entry: ManualVerifyEntry = {
    state,
    note: state === 'pass' ? null : note,
    updated_at: new Date().toISOString()
  }
  store.items[key] = entry
  writeManualVerify(file, store)
  return { key, state: entry.state, note: entry.note, updated_at: entry.updated_at }
}

/** fail → pending → pass: failing tasks/issues sort first. */
export function verifyRank(state: ManualVerifyState): number {
  if (state === 'fail') return 0
  if (state === 'pass') return 2
  return 1
}

/** Stable key shared by the issue list and the task board for the same issue. */
export function verifyKeyForIssue(number: number): string {
  return `issue:${number}`
}

export type Counts = { open: number; closed: number; total: number }

export function countByState(items: readonly { status?: string | null }[]): Counts {
  const open = items.filter((item) => item.status === 'open').length
  const closed = items.filter((item) => item.status === 'closed').length
  return { open, closed, total: items.length }
}

const TASK_TITLE_RE = /^\[T-[A-Z]+-\d+[a-z]?\]/
const TASK_META_RE = /^<!--\s*acceptance:task\s+\{.*\}\s*-->$/
const TASK_NOTE_RE = /^>\s*由 acceptance 看板自动维护/

export type IssueLike = {
  number?: number
  title: string
  description?: string | null
  body?: string | null
  labels?: { name: string }[]
}

/** A `source/acceptance` card (label) or an issue with the `[T-…]` title prefix. */
export function isAcceptanceTaskCard(item: IssueLike): boolean {
  const labels = Array.isArray(item.labels) ? item.labels.map((label) => label?.name) : []
  if (labels.includes('source/acceptance')) return true
  return TASK_TITLE_RE.test(item.title ?? '')
}

/**
 * What this issue changed, read from its own body: the auto-generated meta line,
 * the board note and markdown separators are stripped, nothing is invented.
 */
export function taskBodySummary(body: string | null | undefined): string | null {
  if (typeof body !== 'string' || !body.trim()) return null
  const lines = body
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) =>
        line &&
        !TASK_META_RE.test(line) &&
        !TASK_NOTE_RE.test(line) &&
        !/^---+$/.test(line)
    )
    .map((line) => line.replace(/^#+\s*/, ''))
  const text = lines.join(' ').replace(/\s+/g, ' ').trim()
  if (!text) return null
  return text.length > 240 ? `${text.slice(0, 240)}…` : text
}

export function classifyIssueCounts(items: readonly (IssueLike & { status?: string | null })[]) {
  const tasks = items.filter((item) => isAcceptanceTaskCard(item))
  const real = items.filter((item) => !isAcceptanceTaskCard(item))
  return { real: countByState(real), task_cards: countByState(tasks) }
}

const SELF_CHECK_RE = /自检|冒烟|smoke|self[- ]?check|占位|placeholder|待补/i

export type AuditTaskCard = {
  number: number | null
  title: string
  state: 'open' | 'closed'
  body_bytes: number
  has_description: boolean
  reasons: string[]
}

export type TaskCardAudit = {
  generated_at: string
  source: 'gitea'
  total: number
  counts: { real: Counts; task_cards: Counts }
  task_cards: {
    total: number
    open: number
    closed: number
    hidden_by_default: true
    low_value: AuditTaskCard[]
  }
  decision: string
  rollback: string
}

/**
 * Read-only cleanup audit: which task cards are hidden by default and which of
 * them carry no explanation. Never deletes or edits a Gitea issue.
 */
export function auditTaskCards(
  items: readonly (IssueLike & { status: string | null; body?: string | null })[]
): TaskCardAudit {
  const cards = items.filter((item) => isAcceptanceTaskCard(item))
  const counts = classifyIssueCounts(items as readonly (IssueLike & { status?: string | null })[])
  const lowValue: AuditTaskCard[] = []
  for (const card of cards) {
    const body = typeof card.body === 'string' ? card.body : card.description ?? ''
    const summary = taskBodySummary(body)
    const reasons: string[] = []
    if (!summary) reasons.push('no_description')
    if (SELF_CHECK_RE.test(card.title)) reasons.push('self_check')
    if (!summary && /^\[T-/.test(card.title) && !SELF_CHECK_RE.test(card.title)) {
      reasons.push('title_only')
    }
    if (reasons.length === 0) continue
    lowValue.push({
      number: card.number ?? null,
      title: card.title,
      state: card.status === 'closed' ? 'closed' : 'open',
      body_bytes: Buffer.byteLength(body, 'utf8'),
      has_description: Boolean(summary),
      reasons
    })
  }
  lowValue.sort((a, b) => (a.number ?? 0) - (b.number ?? 0))
  return {
    generated_at: new Date().toISOString(),
    source: 'gitea',
    total: items.length,
    counts,
    task_cards: {
      total: counts.task_cards.total,
      open: counts.task_cards.open,
      closed: counts.task_cards.closed,
      hidden_by_default: true,
      low_value: lowValue
    },
    decision:
      'Task cards (source/acceptance) are hidden from the default /issues list; https://... Gitea issues are NOT deleted and remain reachable via /issues?kind=tasks and the task board.',
    rollback:
      'Set /issues to 「显示任务卡」 (kind=all) or call GET /api/issues?state=all&kind=all; no Gitea data was modified.'
  }
}
